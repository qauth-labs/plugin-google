/**
 * `@qauth-labs/plugin-google` — Google sign-in for QAuth, as an upstream
 * OpenID Connect preset (qauth-labs/qauth#671). EXPERIMENTAL, like the plugin
 * API it is written against.
 *
 * The operator installs the package with the deployment, lists it in
 * `AUTH_METHOD_PLUGINS` and turns on `PLUGIN_API_ENABLED`. The server's
 * plugin loader imports its `upstreamOidcPreset` and builds the sign-in
 * method on its own OpenID Connect client. Each realm then configures and
 * enables it through the admin API. See the README.
 *
 * @packageDocumentation
 */
export {
  GOOGLE_ATTRIBUTES,
  GOOGLE_DISPLAY_NAME,
  GOOGLE_ID_TOKEN_ALGORITHMS,
  GOOGLE_ISSUER,
  GOOGLE_ORIGINS,
  GOOGLE_PLUGIN_ID,
  GOOGLE_PLUGIN_TYPE,
  GOOGLE_SCOPES,
  type GoogleConfig,
  googleConfigSchema,
  googleRedirectUri,
  googleUpstreamConfig,
  googleVouchesForEmail,
  MAX_GOOGLE_CLIENT_ID_LENGTH,
  MAX_GOOGLE_CLIENT_SECRET_LENGTH,
  upstreamOidcPreset,
} from './google.js';
