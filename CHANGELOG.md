# Changelog

All notable changes to `@qauth-labs/plugin-google` are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The
package has its own version line, separate from QAuth's: 0.x while QAuth's
plugin API is experimental, with a `-rc.N` release candidate before each
release (RELEASING.md).

## [Unreleased]

The first version, not released yet. Experimental: QAuth loads it only with
`PLUGIN_API_ENABLED=true`, and its plugin API may change before QAuth 1.0.

### Added

- Sign-in with Google as a QAuth upstream OpenID Connect preset (contract
  `qauth-auth-method/1-rc.0`): the package exports `upstreamOidcPreset`, and
  QAuth's own OpenID Connect client builds the sign-in method from it and
  runs the protocol. It depends only on `@qauth-labs/plugin-sdk`, with `zod`
  as a peer.
- Google's issuer, `https://accounts.google.com`, by discovery; its four
  origins (`accounts.google.com`, `oauth2.googleapis.com`,
  `www.googleapis.com`, `openidconnect.googleapis.com`), off which no
  endpoint is called; the scopes `openid email profile`; the client secret in
  the token request's body (`client_secret_post`); RS256 ID tokens. The
  callback is `/upstream/google/callback`; `googleRedirectUri` builds the
  redirect URI to register at Google.
- A realm's admin sets the client id and the client secret, which the config
  schema marks write-only, and nothing else.
- The account is Google's `sub`. The email is a verified attribute only when
  `email_verified` is the boolean `true`; `name`, `given_name`,
  `family_name`, `locale` and `hd` are unverified attributes, and `hd`
  restricts nothing. The sign-in pages show the name Google and no logo.
- CI with the plugin SDK's preset kit, and an end-to-end suite that runs
  QAuth's server image with the plugin installed, against a mock Google at
  Google's own host names.
- A release workflow that stages the package on npm through trusted
  publishing, for a maintainer's approval with 2FA.

### Temporary

- The plugin SDK is the vendored tarball in `vendor/`, until the SDK release
  that carries the preset shape (qauth-labs/qauth#671) is on npm.
- The end-to-end suite builds QAuth's server and migration-runner images from
  the qauth commit `e2e/qauth-commit` names, until a QAuth release carries
  qauth-labs/qauth#671.

[Unreleased]: https://github.com/qauth-labs/plugin-google/commits/main
