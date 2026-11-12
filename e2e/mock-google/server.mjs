/**
 * A mock of Google's OpenID Provider for the end-to-end suite, over https, at
 * Google's own host names (the network aliases of compose.yml), answering as
 * Google does:
 *
 * - accounts.google.com: the discovery document, Google's own as
 *   openid-configuration.json holds it, and the authorization endpoint;
 * - oauth2.googleapis.com: the token endpoint;
 * - www.googleapis.com: the key set;
 * - openidconnect.googleapis.com: userinfo.
 *
 * Each endpoint answers only on the host the discovery document names for it.
 * It checks what Google checks: the client and its registered redirect URI,
 * `response_type=code`, the `openid` scope, a PKCE challenge with S256 (the
 * only method QAuth sends), the code (good once, for the redirect URI it was
 * issued for), the PKCE verifier, and the client secret in the token
 * request's body (`client_secret_post`, the method this client is registered
 * with: HTTP Basic is refused). Its ID tokens are RS256 JWTs signed with
 * node:crypto, with `azp`, `at_hash` and the request's `nonce`. Its
 * authorization response carries `iss`, as Google's discovery document says
 * (`authorization_response_iss_parameter_supported`), and the members Google
 * adds (`scope`, `authuser`, `prompt`, and `hd` for a Workspace account).
 *
 * The suite, on the host, reaches it at https://localhost:8443: the
 * authorization page, as the browser, and a control API under `/_control/`,
 * which answers on that name only. Through it the suite sets who signs in
 * next and their claims, makes the next authorization answer
 * `access_denied`, changes the discovery document, and reads back every call
 * answered, how each token request authenticated, and every access token
 * issued.
 *
 * No dependencies: it runs on the plain node image.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const PORT = Number(process.env.PORT ?? '443');
const CLIENT_ID = process.env.MOCK_GOOGLE_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.MOCK_GOOGLE_CLIENT_SECRET ?? '';
const REDIRECT_URI = process.env.MOCK_GOOGLE_REDIRECT_URI ?? '';
if (CLIENT_ID === '' || CLIENT_SECRET === '' || REDIRECT_URI === '') {
  throw new Error(
    'MOCK_GOOGLE_CLIENT_ID, MOCK_GOOGLE_CLIENT_SECRET and MOCK_GOOGLE_REDIRECT_URI are required'
  );
}

/** Google's discovery document, as https://accounts.google.com serves it. */
const DOCUMENT = JSON.parse(
  readFileSync(new URL('./openid-configuration.json', import.meta.url), 'utf8')
);
const ISSUER = DOCUMENT.issuer;
const ISSUER_HOST = new URL(ISSUER).host;

/** An endpoint the document names, as `METHOD host/path`. */
function route(method, url) {
  const parsed = new URL(url);
  return `${method} ${parsed.host}${parsed.pathname}`;
}
const DISCOVERY = route('GET', `${ISSUER}/.well-known/openid-configuration`);
const AUTHORIZE = route('GET', DOCUMENT.authorization_endpoint);
const TOKEN = route('POST', DOCUMENT.token_endpoint);
const JWKS = route('GET', DOCUMENT.jwks_uri);
const USERINFO = route('GET', DOCUMENT.userinfo_endpoint);
const AUTHORIZE_PATH = new URL(DOCUMENT.authorization_endpoint).pathname;

/** The scopes Google says it granted for `openid email profile`. */
const GRANTED_SCOPE =
  'email profile openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile';

/** Google's signing key: RS256. */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' });
const KID = createHash('sha256').update(publicJwk.n).digest('hex').slice(0, 40);

/** Who signs in at the authorization page next. The suite replaces them. */
let person = {
  sub: '100000000000000000001',
  claims: { email: 'first@example.com', email_verified: true, name: 'First Person' },
};
/** Whether the next authorization answers `access_denied`, as when the person cancels. */
let declineNext = false;
/** Members set over the discovery document; a `null` member removes one. */
let documentChanges = {};

/** Issued codes: the request they answer, and the person as they were then. */
const codes = new Map();
/** Issued access tokens and the person each belongs to. */
const people = new Map();
/** Every access token issued, in order. */
const tokens = [];
/** Every call answered, without its credentials: method, host and path. */
const calls = [];
/** How each token request authenticated its client, in order. */
const tokenRequests = [];

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function same(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(response, status, body, headers = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

const NO_STORE = {
  'cache-control': 'no-cache, no-store, max-age=0, must-revalidate',
  pragma: 'no-cache',
};

async function bodyOf(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** An RS256 JWT of `claims`, under Google's key. */
function idToken(claims) {
  const header = base64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  const input = `${header}.${payload}`;
  return `${input}.${base64url(sign('sha256', Buffer.from(input, 'ascii'), privateKey))}`;
}

/** The `at_hash` of an access token (OpenID Connect Core 1.0 §3.1.3.6). */
function atHash(accessToken) {
  const digest = createHash('sha256').update(accessToken, 'ascii').digest();
  return base64url(digest.subarray(0, digest.length / 2));
}

function discovery(response) {
  const document = { ...DOCUMENT, ...documentChanges };
  for (const [name, value] of Object.entries(document)) {
    if (value === null) delete document[name];
  }
  json(response, 200, document, { 'cache-control': 'public, max-age=3600' });
}

function authorize(url, response) {
  const query = url.searchParams;
  const redirectUri = query.get('redirect_uri');
  // Google shows its own error page, and sends nothing back, for a client or
  // redirect URI it does not know.
  if (query.get('client_id') !== CLIENT_ID) {
    return json(response, 401, {
      error: 'invalid_client',
      error_description: 'The OAuth client was not found.',
    });
  }
  if (redirectUri !== REDIRECT_URI) {
    return json(response, 400, { error: 'redirect_uri_mismatch' });
  }
  const back = new URL(redirectUri);
  const state = query.get('state');
  const answer = (members) => {
    if (state !== null) back.searchParams.set('state', state);
    if (DOCUMENT.authorization_response_iss_parameter_supported === true) {
      back.searchParams.set('iss', ISSUER);
    }
    for (const [name, value] of Object.entries(members)) back.searchParams.set(name, value);
    response.writeHead(302, { location: back.href });
    response.end();
  };
  if (declineNext) {
    declineNext = false;
    return answer({ error: 'access_denied' });
  }
  if (query.get('response_type') !== 'code') return answer({ error: 'unsupported_response_type' });
  if (!(query.get('scope') ?? '').split(' ').includes('openid')) {
    return answer({ error: 'invalid_scope' });
  }
  const challenge = query.get('code_challenge');
  if (query.get('code_challenge_method') !== 'S256' || challenge === null || challenge === '') {
    return answer({ error: 'invalid_request' });
  }
  const code = `4/0A${randomBytes(40).toString('base64url')}`;
  const signedIn = structuredClone(person);
  codes.set(code, { redirectUri, challenge, nonce: query.get('nonce'), person: signedIn });
  const hd = signedIn.claims.hd;
  answer({
    code,
    scope: GRANTED_SCOPE,
    authuser: '0',
    ...(typeof hd === 'string' ? { hd } : {}),
    prompt: 'consent',
  });
}

function token(request, form, response) {
  const basic = request.headers.authorization !== undefined;
  tokenRequests.push({
    clientAuthentication: basic
      ? 'client_secret_basic'
      : form.has('client_secret')
        ? 'client_secret_post'
        : 'none',
    grantType: form.get('grant_type'),
  });
  // The client is registered with its secret in the body.
  if (
    basic ||
    !same(form.get('client_id') ?? '', CLIENT_ID) ||
    !same(form.get('client_secret') ?? '', CLIENT_SECRET)
  ) {
    return json(
      response,
      401,
      { error: 'invalid_client', error_description: 'Unauthorized' },
      NO_STORE
    );
  }
  if (form.get('grant_type') !== 'authorization_code') {
    return json(response, 400, { error: 'unsupported_grant_type' }, NO_STORE);
  }
  const code = form.get('code') ?? '';
  const issued = codes.get(code);
  codes.delete(code);
  if (issued === undefined) {
    return json(
      response,
      400,
      { error: 'invalid_grant', error_description: 'Bad Request' },
      NO_STORE
    );
  }
  if (form.get('redirect_uri') !== issued.redirectUri) {
    return json(
      response,
      400,
      { error: 'redirect_uri_mismatch', error_description: 'Bad Request' },
      NO_STORE
    );
  }
  const verifier = form.get('code_verifier') ?? '';
  const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  if (!same(computed, issued.challenge)) {
    return json(
      response,
      400,
      { error: 'invalid_grant', error_description: 'Bad Request' },
      NO_STORE
    );
  }
  const accessToken = `ya29.${randomBytes(96).toString('base64url')}`;
  tokens.push(accessToken);
  people.set(accessToken, issued.person);
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: ISSUER,
    azp: CLIENT_ID,
    aud: CLIENT_ID,
    sub: issued.person.sub,
    ...issued.person.claims,
    at_hash: atHash(accessToken),
    ...(issued.nonce === null ? {} : { nonce: issued.nonce }),
    iat: now,
    exp: now + 3600,
  };
  return json(
    response,
    200,
    {
      access_token: accessToken,
      expires_in: 3599,
      scope: GRANTED_SCOPE,
      token_type: 'Bearer',
      id_token: idToken(claims),
    },
    NO_STORE
  );
}

function jwks(response) {
  json(
    response,
    200,
    { keys: [{ use: 'sig', kty: 'RSA', alg: 'RS256', kid: KID, e: publicJwk.e, n: publicJwk.n }] },
    { 'cache-control': 'public, max-age=21600, must-revalidate, no-transform' }
  );
}

function userinfo(request, response) {
  const header = request.headers.authorization ?? '';
  const signedIn = header.startsWith('Bearer ')
    ? people.get(header.slice('Bearer '.length))
    : undefined;
  if (signedIn === undefined) {
    return json(
      response,
      401,
      { error: 'invalid_request' },
      { 'www-authenticate': 'Bearer realm="https://accounts.google.com/"' }
    );
  }
  return json(response, 200, { sub: signedIn.sub, ...signedIn.claims });
}

async function control(request, url, response) {
  const call = `${request.method} ${url.pathname}`;
  if (call === 'PUT /_control/person') {
    const next = JSON.parse(await bodyOf(request));
    if (typeof next?.sub !== 'string' || typeof next?.claims !== 'object') {
      return json(response, 400, { error: 'a person is { sub, claims }' });
    }
    person = next;
    return json(response, 200, person);
  }
  if (call === 'PUT /_control/decline-next') {
    declineNext = true;
    return json(response, 200, { declineNext });
  }
  if (call === 'PUT /_control/discovery') {
    documentChanges = JSON.parse(await bodyOf(request));
    return json(response, 200, documentChanges);
  }
  if (call === 'GET /_control/calls') return json(response, 200, { calls });
  if (call === 'GET /_control/tokens') return json(response, 200, { tokens });
  if (call === 'GET /_control/token-requests') return json(response, 200, { tokenRequests });
  return json(response, 404, { error: 'not_found' });
}

const tls = {
  key: readFileSync(process.env.TLS_KEY ?? '/certs/mock.key'),
  cert: readFileSync(process.env.TLS_CERT ?? '/certs/mock.crt'),
};

createServer(tls, (request, response) => {
  // The host the request names; Google's own names come without a port.
  const authority = (request.headers.host ?? '').toLowerCase().replace(/:443$/, '');
  const url = new URL(request.url ?? '/', `https://${ISSUER_HOST}`);
  const fromSuite = authority.replace(/:\d+$/, '') === 'localhost';
  if (fromSuite && url.pathname.startsWith('/_control/')) {
    control(request, url, response).catch(() => json(response, 400, { error: 'bad control call' }));
    return;
  }
  calls.push({ method: request.method, host: authority, path: url.pathname });
  // The suite, as the browser, reaches the authorization page as localhost.
  const host = fromSuite && url.pathname === AUTHORIZE_PATH ? ISSUER_HOST : authority;
  const at = `${request.method} ${host}${url.pathname}`;
  if (at === DISCOVERY) return discovery(response);
  if (at === AUTHORIZE) return authorize(url, response);
  if (at === JWKS) return jwks(response);
  if (at === USERINFO) return userinfo(request, response);
  if (at === TOKEN) {
    const type = (request.headers['content-type'] ?? '').split(';', 1)[0].trim();
    if (type !== 'application/x-www-form-urlencoded') {
      return json(response, 400, { error: 'invalid_request' }, NO_STORE);
    }
    bodyOf(request)
      .then((text) => token(request, new URLSearchParams(text), response))
      .catch(() => json(response, 400, { error: 'invalid_request' }, NO_STORE));
    return;
  }
  return json(response, 404, { error: 'not_found' });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`mock Google listening on ${String(PORT)}`);
});
