import {
  authMethodRoutePrefix,
  defineUpstreamOidcPreset,
  type UpstreamClaimAttribute,
  upstreamClaimIsTrue,
  type UpstreamIdTokenAlgorithm,
  type UpstreamOidcProviderConfig,
} from '@qauth-labs/plugin-sdk';
import { z } from 'zod';

/**
 * Google's OpenID Provider, `https://accounts.google.com`, as a preset on
 * QAuth's own OpenID Connect client (qauth-labs/qauth#671). The preset holds
 * Google's facts (its issuer, its origins, how QAuth authenticates to it, the
 * scopes) and its claim rules; the server's client does the protocol:
 * discovery, PKCE with S256, `state` and `nonce`, the token request, and the
 * ID token and key set checks. A realm's admin sets the OAuth client of a web
 * application registered at Google, and nothing else.
 *
 * EXPERIMENTAL, like the plugin API it is written against.
 */

/** The plugin's AuthMethod id: its name in the admin API. */
export const GOOGLE_PLUGIN_ID = 'google';

/**
 * The plugin's AuthMethod type: the source of the attributes it writes, the
 * provider type of its credentials, and the segment of its callback,
 * `/upstream/google/callback`.
 */
export const GOOGLE_PLUGIN_TYPE = 'google';

/** The name the sign-in pages show. No logo: see the README. */
export const GOOGLE_DISPLAY_NAME = 'Google';

/** Google's issuer identifier, which its ID tokens carry as `iss`. */
export const GOOGLE_ISSUER = 'https://accounts.google.com';

/**
 * The origins Google's OpenID Provider answers on, as its discovery document
 * names them: the issuer and the authorization endpoint
 * (`accounts.google.com`), the token endpoint (`oauth2.googleapis.com`), the
 * key set (`www.googleapis.com`) and userinfo
 * (`openidconnect.googleapis.com`). The server's client calls no other host:
 * a discovery document that names an endpoint elsewhere is refused.
 */
export const GOOGLE_ORIGINS: readonly string[] = Object.freeze([
  'https://accounts.google.com',
  'https://oauth2.googleapis.com',
  'https://www.googleapis.com',
  'https://openidconnect.googleapis.com',
]);

/** The scopes the plugin asks Google for. */
export const GOOGLE_SCOPES: readonly string[] = Object.freeze(['openid', 'email', 'profile']);

/** The algorithm Google signs its ID tokens with, the only one accepted. */
export const GOOGLE_ID_TOKEN_ALGORITHMS: readonly UpstreamIdTokenAlgorithm[] = Object.freeze([
  'RS256',
]);

/** The longest client id the server's client takes. */
export const MAX_GOOGLE_CLIENT_ID_LENGTH = 255;

/** The longest client secret the server's client takes. */
export const MAX_GOOGLE_CLIENT_SECRET_LENGTH = 1024;

/**
 * The plugin's config for one realm: the OAuth client of a web application
 * registered at Google. No other member is accepted, so an admin sets neither
 * the issuer, the endpoints nor the scopes.
 */
export const googleConfigSchema = z.strictObject({
  /** The OAuth client id, such as `1234-abc.apps.googleusercontent.com`. */
  clientId: z.string().min(1).max(MAX_GOOGLE_CLIENT_ID_LENGTH),
  /**
   * The client secret. Write-only: the server takes it sealed, stores it
   * encrypted under the plugin's own context, and never shows it again.
   */
  clientSecret: z.string().min(1).max(MAX_GOOGLE_CLIENT_SECRET_LENGTH).meta({ writeOnly: true }),
});

/** The plugin's config, parsed. */
export type GoogleConfig = z.output<typeof googleConfigSchema>;

/**
 * The attributes a Google sign-in maps to, under the source `google`.
 *
 * - `email` is verified only when the ID token's `email_verified` is the
 *   boolean `true`: a string, a number or an absent flag leaves it
 *   unverified.
 * - `name`, `given_name`, `family_name` and `locale` are never verified.
 * - `hd`, the Google Workspace domain of the account, is kept as an
 *   attribute that is never verified. It says which domain the account
 *   belongs to; the plugin restricts nothing by it.
 *
 * Any other claim, such as `picture`, is not kept.
 */
export const GOOGLE_ATTRIBUTES: readonly UpstreamClaimAttribute[] = Object.freeze([
  Object.freeze({
    claim: 'email',
    verified: (claims: Readonly<Record<string, unknown>>) =>
      upstreamClaimIsTrue(claims, 'email_verified'),
  }),
  Object.freeze({ claim: 'name' }),
  Object.freeze({ claim: 'given_name' }),
  Object.freeze({ claim: 'family_name' }),
  Object.freeze({ claim: 'locale' }),
  Object.freeze({ claim: 'hd' }),
]);

/**
 * The server's client config for a parsed config: Google's issuer, found by
 * discovery; the client id; the client secret in the token request's body
 * (`client_secret_post`); `openid email profile`; ID tokens signed with
 * RS256. The authorization response comes back by query, and userinfo is not
 * read: the ID token carries every claim the plugin keeps.
 */
export function googleUpstreamConfig(config: GoogleConfig): UpstreamOidcProviderConfig {
  return {
    issuer: GOOGLE_ISSUER,
    clientId: config.clientId,
    clientAuthentication: { method: 'client_secret_post', clientSecret: config.clientSecret },
    scopes: [...GOOGLE_SCOPES],
    idTokenSigningAlgorithms: [...GOOGLE_ID_TOKEN_ALGORITHMS],
  };
}

/**
 * The preset, as the server's plugin loader imports it: the package's
 * `upstreamOidcPreset` export. The server builds the sign-in method from it
 * on its own OpenID Connect client.
 *
 * @experimental
 */
export const upstreamOidcPreset = defineUpstreamOidcPreset<GoogleConfig>({
  id: GOOGLE_PLUGIN_ID,
  type: GOOGLE_PLUGIN_TYPE,
  display: { name: GOOGLE_DISPLAY_NAME },
  origins: GOOGLE_ORIGINS,
  configSchema: googleConfigSchema,
  upstreamConfig: googleUpstreamConfig,
  attributes: GOOGLE_ATTRIBUTES,
});

/** The path of the plugin's callback below the realm's origin. */
const CALLBACK_PATH = `${authMethodRoutePrefix(GOOGLE_PLUGIN_TYPE)}/callback`;

/**
 * The redirect URI to register for the OAuth client at Google, for a realm
 * served at `realmOrigin`: `<realm origin>/upstream/google/callback`.
 *
 * @throws TypeError when `realmOrigin` is not a bare origin, such as
 *   `https://auth.example.com`
 */
export function googleRedirectUri(realmOrigin: string): string {
  const refusal = 'realmOrigin must be a bare origin, such as https://auth.example.com';
  let origin: string;
  try {
    origin = new URL(realmOrigin).origin;
  } catch {
    throw new TypeError(refusal);
  }
  if (origin !== realmOrigin) throw new TypeError(refusal);
  return `${origin}${CALLBACK_PATH}`;
}
