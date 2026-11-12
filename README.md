# @qauth-labs/plugin-google

> **Experimental.** This plugin runs on QAuth's experimental plugin API. QAuth
> loads it only while `PLUGIN_API_ENABLED=true`, and the API, the contract and
> this package may change before QAuth 1.0. Do not rely on it for production
> sign-in yet.

Sign-in with Google for [QAuth](https://github.com/qauth-labs/qauth), as an
upstream OpenID Connect preset. A realm that enables it offers "Google" as an
upstream sign-in: the person signs in with their Google account, and QAuth
signs them into the account that belongs to it. Applications keep receiving
QAuth's own OAuth 2.1 and OpenID Connect tokens.

A preset holds a provider's facts and claim rules, and nothing of the
protocol: QAuth builds the sign-in method from it on its own
[OpenID Connect client](https://docs.qauth.dev/extend/preset-plugins/), which
does discovery, PKCE, `state` and `nonce`, the token request and the ID token
checks. A fix there reaches this plugin with a QAuth release.

The plugin is made and released by the QAuth project, in its own repository,
the way a third party writes a plugin: it depends only on the published
[`@qauth-labs/plugin-sdk`](https://www.npmjs.com/package/@qauth-labs/plugin-sdk)
and has its own version line.

## Compatibility

| Plugin       | QAuth server               | AuthMethod contract        | Plugin SDK |
| ------------ | -------------------------- | -------------------------- | ---------- |
| `0.1.0-rc.0` | `0.2.3` and later on `0.2` | `qauth-auth-method/1-rc.0` | `0.2.3`    |

## What it sets

| What                  | Value                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| AuthMethod id, type   | `google`, `google`                                                                                   |
| Issuer                | `https://accounts.google.com`, by discovery                                                          |
| Origins it may call   | `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `openidconnect.googleapis.com` |
| Scopes                | `openid email profile`                                                                               |
| Client authentication | `client_secret_post`: the client secret in the token request's body                                  |
| ID token algorithm    | `RS256`                                                                                              |
| Userinfo              | not read: the ID token carries every claim the plugin keeps                                          |
| Sign-in pages         | the name `Google`, and no logo                                                                       |

## How it signs a person in

QAuth's client does each step; the plugin only says where and what.

1. **Discovery.** The server reads Google's discovery document,
   `https://accounts.google.com/.well-known/openid-configuration`, and keeps
   it for five minutes. Every endpoint it names must be on one of the
   plugin's four origins: a document that names one elsewhere is refused
   before anything is sent there, so the client secret goes to Google and to
   no other host.
2. **Authorization request.** The browser goes to Google's authorization
   endpoint with `openid email profile`, a fresh `state` and `nonce`, and a
   PKCE challenge (S256). The `redirect_uri` is this provider's own callback,
   `https://<realm host>/upstream/google/callback`.
3. **Callback.** Google sends the browser back with the code, the `state`
   and `iss` (RFC 9207), which the server checks.
4. **Token exchange.** The code is redeemed at Google's token endpoint with
   the PKCE verifier, the client id and the client secret in the body.
5. **The ID token.** It must be signed with RS256 by a key of Google's key
   set, name Google's issuer and the client as its audience (and as `azp`),
   be current, and carry the `nonce` of step 2.

**The account is Google's `sub`**, under the issuer
`https://accounts.google.com`. It is never the email address: a changed
address signs in the same account.

**Attributes.** When the account is created, QAuth stores, under the source
`google`:

| Attribute     | From the claim | Verified                                |
| ------------- | -------------- | --------------------------------------- |
| `email`       | `email`        | only when Google vouches for it (below) |
| `name`        | `name`         | never                                   |
| `given_name`  | `given_name`   | never                                   |
| `family_name` | `family_name`  | never                                   |
| `locale`      | `locale`       | never                                   |
| `hd`          | `hd`           | never                                   |

Google vouches for the email when `email_verified` is the boolean `true` and
Google hosts the address: a Gmail address, or a Google Workspace account,
whose ID token carries `hd`. For any other address, `email_verified` only says
that the address was verified when the Google account was made, and its owner
may have changed since, so the plugin keeps it unverified. `email_verified` as
a string, a number or absent leaves the email unverified. No other claim is kept, `picture` among them. A method built from
a preset ranks its verified attributes with QAuth's `oidc_*` providers in
claim resolution, so a verified Google email is the one an application's ID
token carries when the scope `email` was granted.

**`hd`**, the Google Workspace domain of the account, is kept as an attribute
and nothing more: the plugin does not restrict who signs in by it, and QAuth
does not treat it as verified.

**No logo.** The sign-in pages show the provider's name, `Google`. A plugin
that carried Google's logo would carry a copy of brand assets that Google
changes; the name needs none.

**Outbound calls.** The plugin makes none. QAuth's client makes every call
through its egress client, to Google's four origins only. The plugin holds no
key. QAuth reaches Google's hosts only at public addresses: an egress
allowlist entry does not open a private address for a preset's calls.

## Install it (operators)

You need QAuth `0.2.3` or later, and an image you build on top of QAuth's
released one.

### 1. Register the client at Google

In the Google Cloud console, under "APIs & Services", configure the OAuth
consent screen with the scopes `openid`, `email` and `profile`, and create an
OAuth client ID of the type **Web application**:

- **Authorized redirect URIs**: one per realm host,
  `https://<realm host>/upstream/google/callback`.
  `googleRedirectUri(realmOrigin)` builds it.
- No JavaScript origin is needed: QAuth redeems the code itself.

Keep the client id (`…apps.googleusercontent.com`) and the client secret.

### 2. Add the package to the server image

The image is a self-contained tree under `/app`. Install the plugin into a
separate stage, nested, so it brings its own copy of the plugin SDK, and copy
it in. `--omit=peer` makes it use the server's own `zod`; `--ignore-scripts`
runs no install script. Pin the server image by digest and the plugin by
version, and install from a lockfile you have read, so every build gets the
same dependency tree. Write the lockfile once, in a `plugins/` directory of
your build context, without installing anything:

```bash
mkdir plugins && cd plugins
npm init --yes > /dev/null
npm install --package-lock-only --save-exact --omit=dev --omit=peer \
  --install-strategy=nested --ignore-scripts @qauth-labs/plugin-google@0.1.0-rc.0
```

Read `package-lock.json` and commit both files. Then:

```dockerfile
ARG QAUTH_IMAGE=ghcr.io/qauth-labs/qauth/auth-server:0.2.3@sha256:<digest>

# The build stage writes the files the server will run: pin it by digest too.
FROM node:26-alpine@sha256:<digest> AS plugin
WORKDIR /plugin
COPY plugins/package.json plugins/package-lock.json ./
RUN npm ci --omit=dev --omit=peer --install-strategy=nested --ignore-scripts

FROM ${QAUTH_IMAGE}
COPY --from=plugin --chown=nodejs:nodejs \
  /plugin/node_modules/@qauth-labs/plugin-google \
  /app/node_modules/@qauth-labs/plugin-google
```

Rebuild it at every QAuth upgrade, with the lockfile moved to the plugin
version made for that release. To know the package was built by this
repository's release workflow, read the version's provenance on npmjs.com,
or the attestation at
`npm view @qauth-labs/plugin-google@<version> dist.attestations.url`, and
check that it names `qauth-labs/plugin-google` and
`.github/workflows/release.yml`. QAuth's own docs describe the recipe under
"Operate → Images → Add a plugin to the image".

### 3. Turn it on

```sh
AUTH_METHOD_PLUGINS=@qauth-labs/plugin-google
PLUGIN_API_ENABLED=true
```

The boot logs `AuthMethod plugin @qauth-labs/plugin-google loaded: google (google)`,
with `kind: "upstream-oidc-preset"`. With `PLUGIN_API_ENABLED` off, the
server does not load it and logs why:
`The AuthMethod plugin @qauth-labs/plugin-google is not loaded: it is not a
first-party plugin, and the experimental plugin API is off. …`

### 4. Configure it for a realm

Through QAuth's admin API, per realm (`{realm}` is the realm's id, `google`
the plugin's name):

1. Seal the client secret for the configure that will carry it:
   `POST /admin/v1-rc.0/realms/{realm}/secrets/seal` with
   `{"operation": "plugins.update", "member": "/secrets/clientSecret", "params": {"plugin": "google"}, "value": "<client secret>"}`.
   The answer's `sealed` value opens only in that request; no request,
   approval or log holds the secret itself.
2. Set the configuration:
   `POST /admin/v1-rc.0/realms/{realm}/plugins/google/config` with
   `{"version": <current version>, "config": {"clientId": "<client id>"}, "secrets": {"clientSecret": {"sealed": "<sealed>"}}}`.
3. Enable it: `POST /admin/v1-rc.0/realms/{realm}/plugins/google/enable` with
   `{"version": <current version>}`.

Setting the configuration and enabling the plugin are security operations:
each needs an approval (`QAuth-Approval` header), as QAuth's admin API
documentation describes.

| Setting        | Required | What it is                                                                                    |
| -------------- | -------- | --------------------------------------------------------------------------------------------- |
| `clientId`     | yes      | The OAuth client id, 1 to 255 characters.                                                     |
| `clientSecret` | yes      | The client secret, 1 to 1024 characters. Write-only: sealed by the server, never shown again. |

No other member is accepted: the issuer, the endpoints and the scopes are the
plugin's. Once enabled, the realm's sign-in offers Google, and an application
can send the browser straight to it with `qauth_upstream=google` on
`/oauth/authorize`. A first sign-in creates an account when the realm allows
sign-up.

## Develop

The repository uses QAuth's own toolchain: Node 26, pnpm (the version in
`package.json`'s `packageManager`), TypeScript, Oxlint, Oxfmt and Vitest.
pnpm resolves a dependency version only once it has been on the registry
for 7 days (`pnpm-workspace.yaml`), as QAuth does.

```sh
pnpm install
pnpm run lint && pnpm run format:check && pnpm run typecheck && pnpm test
```

`pnpm test` runs the unit tests and the plugin SDK's preset kit
(`checkUpstreamOidcPreset`): the config schema and its write-only secret, the
client config, the attribute rules, and Google's own discovery document
against the plugin's origins. The sign-in itself runs on QAuth's client, so
it is the end-to-end suite's.

The end-to-end suite needs docker, openssl, Node and pnpm:

```sh
pnpm run e2e
```

It packs the plugin, builds QAuth's released server image with the plugin
added as above, starts it with PostgreSQL, Redis and a mock Google at
Google's own host names, configures the plugin through the admin API and
signs in through the server's pages. It checks that:

- the boot loads the plugin with `PLUGIN_API_ENABLED` on, and skips it,
  saying why, with it off;
- the admin API keeps the client secret write-only;
- the browser goes to Google for `openid email profile` with PKCE, a `nonce`
  and the plugin's callback, and the page names Google with no logo;
- a first sign-in creates an account keyed by Google's `sub`, with the
  attributes above, the email verified and `hd` unverified;
- the code is redeemed with the client secret in the body;
- the application's ID token carries the verified email;
- a returning sign-in with a changed email finds the same account;
- the email stays unverified when `email_verified` is `false`, the string
  `"true"`, or absent;
- a person who declines at Google is not signed in;
- no access token or client secret reaches the database, the events or the
  logs;
- a discovery document that names an endpoint off Google's origins is refused
  before anything is sent there.

The mock answers on a network with a public address range: QAuth's egress
client reaches no private address for a preset, as Google is on public
addresses. CI runs both on every pull request. Releases are described in
[RELEASING.md](RELEASING.md).

It has been run against the mock only, not against Google itself, which would
need a real Google Cloud project.

## License

[Apache-2.0](LICENSE)
