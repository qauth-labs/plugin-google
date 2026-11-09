/**
 * The plugin end to end, where an operator runs it: QAuth's server image with
 * the plugin installed on top (e2e/Dockerfile), against a mock Google at
 * Google's own host names. The server builds the sign-in method from the
 * preset on its own OpenID Connect client. The suite configures the plugin
 * through the admin API, as an operator does, and signs in through the
 * server's own pages, as a browser does.
 *
 * These are qauth-labs/qauth#1069's full-flow cases, which ran the server's
 * client in-process there, and the acceptance criteria of
 * qauth-labs/qauth#1074. Run it through e2e/run.sh.
 */
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { GOOGLE_ORIGINS } from '../src/index.js';
import {
  Admin,
  browse,
  changeDiscovery,
  compose,
  CookieJar,
  databaseDump,
  declineNext,
  formsOf,
  issuedTokens,
  linkWithClass,
  literal,
  logLinesOf,
  logsOf,
  MOCK,
  mockCalls,
  mockClient,
  type MockPerson,
  restart,
  SERVER,
  setPerson,
  sql,
  tokenRequests,
} from './harness.js';

const PACKAGE = '@qauth-labs/plugin-google';
/** Where the test application wants the code; nothing listens there. */
const REDIRECT_URI = 'http://127.0.0.1:9/plugin-google-e2e/callback';
/** The callback this provider alone uses, on the realm's origin. */
const CALLBACK = 'http://localhost:3000/upstream/google/callback';
/** Google's authorization endpoint, as its discovery document names it. */
const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const ISSUER = 'https://accounts.google.com';
/** The hosts of the preset's origins: the only hosts the server may call. */
const GOOGLE_HOSTS = GOOGLE_ORIGINS.map((origin) => new URL(origin).hostname);

const SIGN_IN_FAILED = 'urn:qauth:event:user.sign_in_failed:v1-rc.0';
const REGISTERED = 'urn:qauth:event:user.registered:v1-rc.0';

let admin: Admin;
let clientId: string;
let realmId: string;

function isRedirect(response: Response): boolean {
  return response.status === 302 || response.status === 303;
}

/** Configure the plugin for the realm and enable it, through the admin API. */
async function configure(): Promise<void> {
  const { clientId: googleClientId, clientSecret } = mockClient();
  const current = await admin.call('GET', '/plugins/google');
  expect(current.status).toBe(200);
  const sealed = await admin.call('POST', '/plugins/google/secrets/seal', {
    path: 'clientSecret',
    value: clientSecret,
  });
  expect(sealed.status, JSON.stringify(sealed.body)).toBe(200);
  const body = {
    version: current.body['version'],
    config: { clientId: googleClientId },
    secrets: { clientSecret: { sealed: sealed.body['sealed'] } },
  };
  const configured = await admin.call('POST', '/plugins/google/config', body, {
    'qauth-approval': await admin.approved('plugins.update', body),
  });
  expect(configured.status, JSON.stringify(configured.body)).toBe(200);
  if (configured.body['enabled'] !== true) {
    const enableBody = { version: configured.body['version'] };
    const enabled = await admin.call('POST', '/plugins/google/enable', enableBody, {
      'qauth-approval': await admin.approved('plugins.enable', enableBody),
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body['enabled']).toBe(true);
  }
}

/** An application's authorization request that sends the browser to Google. */
function authorizeUrl(verifier: string): URL {
  const authorize = new URL('/oauth/authorize', SERVER);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: 'openid email',
    state: randomBytes(16).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    qauth_upstream: 'google',
  }).toString();
  return authorize;
}

/** A sign-in started at the server and sent on to Google. */
interface StartedSignIn {
  readonly jar: CookieJar;
  /** The application's PKCE verifier. */
  readonly verifier: string;
  /** The server's waiting page, which sends the browser to Google. */
  readonly waitingPage: string;
  /** Google's authorization page, as the server sent the browser there. */
  readonly providerUrl: URL;
}

/** An application asks the server to sign someone in through Google. */
async function startSignIn(): Promise<StartedSignIn> {
  const jar = new CookieJar();
  const verifier = randomBytes(32).toString('base64url');
  const toStart = await browse(jar, authorizeUrl(verifier));
  expect(isRedirect(toStart)).toBe(true);
  const startUrl = toStart.headers.get('location') ?? '';
  expect(startUrl).toMatch(/^\/ui\/upstream\/google\/start\?/);
  const start = await browse(jar, startUrl);
  const waitingPage = await start.text();
  expect(start.status, waitingPage).toBe(200);
  const href = linkWithClass(waitingPage, 'alt-action');
  expect(href).toBeDefined();
  return { jar, verifier, waitingPage, providerUrl: new URL(href ?? '') };
}

/**
 * The person signs in at the mock's authorization page; the URL Google sends
 * the browser back to. The suite reaches the mock from the host as localhost.
 */
async function atGoogle(providerUrl: URL): Promise<URL> {
  const page = new URL(providerUrl.pathname + providerUrl.search, MOCK);
  const answer = await fetch(page, { redirect: 'manual' });
  expect(isRedirect(answer), await answer.clone().text()).toBe(true);
  const back = new URL(answer.headers.get('location') ?? '');
  expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
  return back;
}

/**
 * Follow the server from the callback to the application, granting consent
 * on the way when the page asks; the code the application receives.
 */
async function toApplication(jar: CookieJar, afterCallback: Response): Promise<string> {
  let response = afterCallback;
  for (let step = 0; step < 10; step += 1) {
    const location = response.headers.get('location');
    if (isRedirect(response) && location !== null) {
      const next = new URL(location, SERVER);
      if (next.href.startsWith(REDIRECT_URI)) {
        const code = next.searchParams.get('code');
        expect(next.searchParams.get('error')).toBeNull();
        expect(code).not.toBeNull();
        return code ?? '';
      }
      response = await browse(jar, next);
      continue;
    }
    expect(response.status, `step ${String(step)}`).toBe(200);
    const consent = formsOf(await response.text()).find(
      (form) =>
        form.action.endsWith('/ui/consent') ||
        form.buttons.some((button) => button.name === 'decision' && button.value === 'allow')
    );
    expect(consent, 'a consent form').toBeDefined();
    if (consent === undefined) break;
    const form = new URLSearchParams(consent.fields);
    form.set('decision', 'allow');
    response = await browse(jar, consent.action, { method: 'POST', form });
  }
  throw new Error('the server did not send the browser back to the application');
}

/** A whole sign-in of `person`; the code the application receives, and its verifier. */
async function signIn(person: MockPerson): Promise<{ code: string; verifier: string }> {
  await setPerson(person);
  const { jar, verifier, providerUrl } = await startSignIn();
  const back = await atGoogle(providerUrl);
  const callback = await browse(jar, back);
  expect(isRedirect(callback), await callback.clone().text()).toBe(true);
  return { code: await toApplication(jar, callback), verifier };
}

/** The accounts the Google credential of `sub` belongs to. */
function accountsOf(sub: string): string[] {
  return sql(
    `SELECT user_id FROM user_credentials
     WHERE provider_type = 'google' AND external_sub = ${literal(sub)}`
  );
}

function userCount(): number {
  return Number(sql('SELECT count(*) FROM users')[0]);
}

/** The attributes the plugin wrote for an account: key, value and whether verified. */
function attributesOf(accountId: string): { key: string; value: string; verified: boolean }[] {
  return sql(
    `SELECT attr_key, attr_value, verified FROM user_attributes
     WHERE user_id = ${literal(accountId)} AND source = 'google' ORDER BY attr_key`
  ).map((row) => {
    const [key = '', value = '', verified = ''] = row.split('|');
    return { key, value, verified: verified === 't' };
  });
}

function failedSignIns(reason: string): number {
  return Number(
    sql(
      `SELECT count(*) FROM events WHERE type = ${literal(SIGN_IN_FAILED)}
       AND data->>'method' = 'upstream' AND data->>'reason' = ${literal(reason)}`
    )[0]
  );
}

/** The calls the server made to the mock since `from`: every one but the suite's own. */
async function serverCallsSince(from: number): Promise<string[]> {
  return (await mockCalls())
    .slice(from)
    .filter((call) => call.host !== 'localhost:8443')
    .map((call) => `${call.method} ${call.host}${call.path}`);
}

/** The claims of a JWT, unverified: the suite reads what the server issued. */
function claimsOf(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** A Google Workspace account at example.com, verified email and all. */
const ADA: MockPerson = {
  sub: '110169484474386276334',
  claims: {
    hd: 'example.com',
    email: 'ada@example.com',
    email_verified: true,
    name: 'Ada Lovelace',
    picture: 'https://lh3.googleusercontent.com/a/ACg8ocAda',
    given_name: 'Ada',
    family_name: 'Lovelace',
    locale: 'en-GB',
  },
};

beforeAll(async () => {
  const [master] = sql(`SELECT id FROM realms WHERE name = 'master'`);
  if (master === undefined) throw new Error('no master realm');
  realmId = master;
  admin = await Admin.create(realmId);
  const registered = await fetch(`${SERVER}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'plugin-google e2e application',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'openid email',
    }),
  });
  expect(registered.status, await registered.clone().text()).toBe(201);
  clientId = ((await registered.json()) as { client_id: string }).client_id;
});

describe('the deployment', () => {
  it("puts the mock at the preset's origins: its network names, its certificate and the allowlist", () => {
    const config = JSON.parse(compose('config', '--format', 'json')) as {
      services: Record<string, { networks?: Record<string, { aliases?: string[] } | null> }>;
    };
    const aliases = config.services['mock-google']?.networks?.['internet']?.aliases ?? [];
    expect([...aliases].sort()).toEqual([...GOOGLE_HOSTS].sort());

    const certificate = new X509Certificate(
      readFileSync(join(process.env['E2E_WORK'] ?? '', 'certs', 'mock.crt'))
    );
    expect(certificate.subjectAltName?.split(', ').sort()).toEqual(
      [...GOOGLE_HOSTS, 'localhost'].map((host) => `DNS:${host}`).sort()
    );

    const allowlist = JSON.parse(
      readFileSync(new URL('./egress-allowlist.json', import.meta.url), 'utf8')
    ) as { entries: { host: string }[] };
    expect(allowlist.entries.map((entry) => entry.host).sort()).toEqual([...GOOGLE_HOSTS].sort());
  });
});

describe('the boot', () => {
  it('loads the plugin as an upstream OpenID Connect preset while PLUGIN_API_ENABLED is on', () => {
    const loaded = logLinesOf('auth-server').filter(
      (line) => line.msg === `AuthMethod plugin ${PACKAGE} loaded: google (google)`
    );
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      authMethodPlugin: PACKAGE,
      id: 'google',
      type: 'google',
      kind: 'upstream-oidc-preset',
      firstParty: false,
      contract: 'qauth-auth-method/1-rc.0',
    });
  });

  it('skips the plugin with PLUGIN_API_ENABLED off, and says why', () => {
    const log = logsOf('auth-server-plugin-api-off');
    expect(log).toContain(
      `The AuthMethod plugin ${PACKAGE} is not loaded: it is not a first-party plugin, and the experimental plugin API is off.`
    );
    expect(log).not.toContain(`AuthMethod plugin ${PACKAGE} loaded`);
    expect(
      logLinesOf('auth-server-plugin-api-off').filter(
        (line) => line['authMethodPlugin'] === PACKAGE
      )
    ).toEqual([expect.objectContaining({ level: 40, reason: 'plugin-api-off' })]);
  });

  it('lists the plugin in the admin API, off, with its client secret write-only', async () => {
    const plugin = await admin.call('GET', '/plugins/google');
    expect(plugin.status).toBe(200);
    expect(plugin.body).toMatchObject({
      name: 'google',
      type: 'google',
      package: PACKAGE,
      firstParty: false,
      contract: 'qauth-auth-method/1-rc.0',
      displayName: 'Google',
      enabled: false,
      config: {},
      secrets: [{ path: 'clientSecret', set: false }],
    });
  });
});

describe('the configuration', () => {
  it('takes the client id and the sealed secret, and never shows the secret', async () => {
    await configure();
    const plugin = await admin.call('GET', '/plugins/google');
    expect(plugin.status).toBe(200);
    expect(plugin.body).toMatchObject({
      enabled: true,
      config: { clientId: mockClient().clientId },
      secrets: [{ path: 'clientSecret', set: true }],
    });
    expect(JSON.stringify(plugin.body)).not.toContain(mockClient().clientSecret);
  });
});

describe('sign-in', () => {
  let account: string;
  let first: { code: string; verifier: string };

  it('sends the browser to Google for openid email profile, with PKCE, a nonce and its own callback', async () => {
    const { providerUrl, waitingPage } = await startSignIn();
    expect(`${providerUrl.origin}${providerUrl.pathname}`).toBe(AUTHORIZATION_ENDPOINT);
    const query = providerUrl.searchParams;
    expect(query.get('client_id')).toBe(mockClient().clientId);
    expect(query.get('response_type')).toBe('code');
    expect(query.get('scope')).toBe('openid email profile');
    expect(query.get('redirect_uri')).toBe(CALLBACK);
    expect(query.get('code_challenge_method')).toBe('S256');
    expect(query.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(query.get('state')).toMatch(/.{22,}/);
    expect(query.get('nonce')).toMatch(/.{22,}/);
    // The waiting page names the provider, and shows no logo.
    expect(waitingPage).toContain('Continue to Google');
    expect(waitingPage).not.toMatch(/<img\b/i);
  });

  it('the first sign-in creates an account with the right attributes', async () => {
    const before = userCount();
    const callsBefore = (await mockCalls()).length;
    first = await signIn(ADA);

    const accounts = accountsOf(ADA.sub);
    expect(accounts).toHaveLength(1);
    account = accounts[0] ?? '';
    expect(userCount()).toBe(before + 1);
    // The account is the Google subject, under Google's issuer.
    const [credential] = sql(
      `SELECT is_primary, credential_data->>'kind', credential_data->>'iss',
              credential_data->>'verified'
       FROM user_credentials WHERE user_id = ${literal(account)} AND provider_type = 'google'`
    );
    expect(credential).toBe(`t|upstream|${ISSUER}|true`);
    expect(
      sql(
        `SELECT data->>'method' FROM events
         WHERE type = ${literal(REGISTERED)} AND subject_id = ${literal(account)}`
      )
    ).toEqual(['upstream']);
    // The email verified as Google said; the profile and hd never; no picture.
    expect(attributesOf(account)).toEqual([
      { key: 'email', value: 'ada@example.com', verified: true },
      { key: 'family_name', value: 'Lovelace', verified: false },
      { key: 'given_name', value: 'Ada', verified: false },
      { key: 'hd', value: 'example.com', verified: false },
      { key: 'locale', value: 'en-GB', verified: false },
      { key: 'name', value: 'Ada Lovelace', verified: false },
    ]);

    // The server read Google's discovery document and key set and redeemed
    // the code at Google's own hosts, and called nothing else: no userinfo.
    const calls = await serverCallsSince(callsBefore);
    expect(calls).toContain('POST oauth2.googleapis.com/token');
    expect(calls).toContain('GET www.googleapis.com/oauth2/v3/certs');
    expect(calls).not.toContain('GET openidconnect.googleapis.com/v1/userinfo');
    for (const call of calls) {
      expect(GOOGLE_HOSTS).toContain(call.split(' ')[1]?.split('/')[0]);
    }
    expect(
      (await mockCalls()).some((call) => call.path === '/.well-known/openid-configuration')
    ).toBe(true);
  });

  it('redeems the code with the client secret in the body', async () => {
    const requests = await tokenRequests();
    expect(requests.length).toBeGreaterThan(0);
    expect(new Set(requests.map((request) => request.clientAuthentication))).toEqual(
      new Set(['client_secret_post'])
    );
    expect(requests.at(-1)?.grantType).toBe('authorization_code');
  });

  it('stores hd as an unverified attribute', () => {
    expect(attributesOf(account).filter((attribute) => attribute.key === 'hd')).toEqual([
      { key: 'hd', value: 'example.com', verified: false },
    ]);
  });

  it("ranks its attributes with an oidc_ provider's: the application's ID token carries the verified email", async () => {
    // Each row records that the method was built from a preset, which is
    // what ranks it with the oidc_* providers in claim resolution.
    expect(
      sql(
        `SELECT DISTINCT provenance->>'builtFrom' FROM user_attributes
         WHERE user_id = ${literal(account)} AND source = 'google'`
      )
    ).toEqual(['upstream-oidc-preset']);

    const response = await fetch(`${SERVER}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: first.code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: first.verifier,
      }).toString(),
    });
    const tokens = (await response.json()) as Record<string, unknown>;
    expect(response.status, JSON.stringify(tokens)).toBe(200);
    expect(typeof tokens['id_token']).toBe('string');
    expect(claimsOf(String(tokens['id_token']))).toMatchObject({
      email: 'ada@example.com',
      email_verified: true,
    });
  });

  it('a returning sign-in of the same Google account signs in the same account, whatever its email', async () => {
    const before = userCount();
    await signIn({ ...ADA, claims: { ...ADA.claims, email: 'ada.lovelace@example.com' } });
    expect(accountsOf(ADA.sub)).toEqual([account]);
    expect(userCount()).toBe(before);
  });

  it.each([
    ['false', '110169484474386276335', false],
    ['the string "true"', '110169484474386276336', 'true'],
    ['absent', '110169484474386276337', undefined],
  ])(
    'keeps the email an unverified attribute when email_verified is %s',
    async (_case, sub, flag) => {
      const before = userCount();
      const email = `person-${sub}@example.com`;
      await signIn({
        sub,
        claims: { email, ...(flag === undefined ? {} : { email_verified: flag }), name: 'Bob' },
      });
      const accounts = accountsOf(sub);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).not.toBe(account);
      expect(userCount()).toBe(before + 1);
      expect(attributesOf(accounts[0] ?? '')).toEqual([
        { key: 'email', value: email, verified: false },
        { key: 'name', value: 'Bob', verified: false },
      ]);
    }
  );

  it('a person who declines at Google is not signed in, and the page names Google', async () => {
    const before = userCount();
    const declinedBefore = failedSignIns('declined');
    const tokensBefore = (await issuedTokens()).length;
    await setPerson(ADA);
    await declineNext();
    const { jar, providerUrl } = await startSignIn();
    const back = await atGoogle(providerUrl);
    expect(back.searchParams.get('error')).toBe('access_denied');

    const page = await browse(jar, back);
    const text = await page.text();
    expect(isRedirect(page), text).toBe(false);
    expect(text).toContain('Sign-in was not completed');
    expect(text).toContain('Google did not sign you in');
    expect(failedSignIns('declined')).toBe(declinedBefore + 1);
    expect(userCount()).toBe(before);
    expect(await issuedTokens()).toHaveLength(tokensBefore);
  });
});

describe('the access token and the client secret', () => {
  it('are not in the database, the logs or the events', async () => {
    const tokens = await issuedTokens();
    // One per completed sign-in above.
    expect(tokens.length).toBeGreaterThanOrEqual(5);

    const dump = databaseDump();
    const events = sql('SELECT row_to_json(events)::text FROM events').join('\n');
    const logs = [logsOf('auth-server'), logsOf('auth-server-plugin-api-off')].join('\n');
    expect(events).toContain(REGISTERED);
    for (const token of tokens) {
      expect(dump.includes(token), 'a token in the database').toBe(false);
      expect(events.includes(token), 'a token in the events').toBe(false);
      expect(logs.includes(token), 'a token in the logs').toBe(false);
    }
    // Nor is the client secret, which the server keeps sealed.
    const { clientSecret } = mockClient();
    expect(dump.includes(clientSecret), 'the client secret in the database').toBe(false);
    expect(logs.includes(clientSecret), 'the client secret in the logs').toBe(false);
  });
});

// Last: it restarts the server, whose cache keeps a discovery document it
// has read for five minutes, so that it reads the changed one.
describe("a discovery document that names an endpoint off Google's origins", () => {
  beforeAll(async () => {
    await changeDiscovery({ token_endpoint: 'https://oauth2.example.com/token' });
    await restart('auth-server', `${SERVER}/ready`);
  });

  it('is refused before anything is sent there, and no one is signed in', async () => {
    const before = userCount();
    const callsBefore = (await mockCalls()).length;
    const tokensBefore = (await tokenRequests()).length;
    await setPerson(ADA);

    const jar = new CookieJar();
    const toStart = await browse(jar, authorizeUrl(randomBytes(32).toString('base64url')));
    expect(isRedirect(toStart)).toBe(true);
    const start = await browse(jar, toStart.headers.get('location') ?? '');
    const text = await start.text();
    expect(start.status, text).toBe(400);
    expect(text).toContain('We could not sign you in');

    // The server read the document, and went nowhere else: the client
    // secret never left for the other host.
    expect(await serverCallsSince(callsBefore)).toEqual([
      'GET accounts.google.com/.well-known/openid-configuration',
    ]);
    expect(await tokenRequests()).toHaveLength(tokensBefore);
    expect(userCount()).toBe(before);
    expect(logsOf('auth-server')).toContain("off the preset's origins");
  });
});
