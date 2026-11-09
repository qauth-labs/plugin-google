/**
 * The preset, checked as far as the plugin SDK allows without the server:
 * the SDK's preset kit (`checkUpstreamOidcPreset`), the config schema and its
 * write-only secret, the client config `upstreamConfig` makes, the attribute
 * rules, and Google's own discovery document against the preset's origins.
 *
 * The sign-in itself runs on the server's OpenID Connect client, which is
 * the server's own code: the end-to-end suite (e2e/) runs it, against a mock
 * Google, in QAuth's server image with the plugin installed.
 */
import { readFileSync } from 'node:fs';

import {
  AUTH_METHOD_CONTRACT,
  AUTH_METHOD_PLUGIN_EXPORT,
  AuthMethodContractError,
  defineUpstreamOidcPreset,
  isUpstreamOidcPreset,
  UPSTREAM_OIDC_PRESET_EXPORT,
  type UpstreamClaimAttribute,
  upstreamOidcPresetProblems,
} from '@qauth-labs/plugin-sdk';
import { checkUpstreamOidcPreset } from '@qauth-labs/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as plugin from '../src/index.js';

const {
  GOOGLE_ATTRIBUTES,
  GOOGLE_ISSUER,
  GOOGLE_ORIGINS,
  googleConfigSchema,
  googleRedirectUri,
  googleUpstreamConfig,
  upstreamOidcPreset,
} = plugin;

const CLIENT_ID = '1234-qauth.apps.googleusercontent.com';
const CLIENT_SECRET = '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th';
const CONFIG = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };

/** Google's discovery document, as https://accounts.google.com serves it (the mock serves it too). */
const GOOGLE_DISCOVERY = JSON.parse(
  readFileSync(new URL('../e2e/mock-google/openid-configuration.json', import.meta.url), 'utf8')
) as Record<string, unknown>;

/**
 * The attributes `rules` map `claims` to, as the SDK defines a rule
 * (`UpstreamClaimAttribute`): a string claim becomes the attribute under the
 * rule's key, verified only when the rule's `verified` returns the boolean
 * `true`. The server applies the rules; the end-to-end suite checks what it
 * stores.
 */
function mapped(
  rules: readonly UpstreamClaimAttribute[],
  claims: Readonly<Record<string, unknown>>
): { key: string; value: string; verified: boolean }[] {
  return rules.flatMap((rule) => {
    const value = claims[rule.claim];
    if (typeof value !== 'string') return [];
    return [
      {
        key: rule.attribute ?? rule.claim,
        value,
        verified: rule.verified?.(claims) === true,
      },
    ];
  });
}

describe('the package', () => {
  it('exports the preset as upstreamOidcPreset, and no authMethod', () => {
    expect(UPSTREAM_OIDC_PRESET_EXPORT in plugin).toBe(true);
    expect(AUTH_METHOD_PLUGIN_EXPORT in plugin).toBe(false);
  });

  it("is written against the SDK's contract, frozen, and meets the loader's static checks", () => {
    expect(upstreamOidcPreset.contract).toBe(AUTH_METHOD_CONTRACT);
    expect(Object.isFrozen(upstreamOidcPreset)).toBe(true);
    expect(Object.isFrozen(upstreamOidcPreset.origins)).toBe(true);
    expect(upstreamOidcPresetProblems(upstreamOidcPreset)).toEqual([]);
    expect(isUpstreamOidcPreset(upstreamOidcPreset)).toBe(true);
  });

  it('is the google method, named Google on the sign-in pages, with no logo', () => {
    expect(upstreamOidcPreset.id).toBe('google');
    expect(upstreamOidcPreset.type).toBe('google');
    expect(upstreamOidcPreset.display).toEqual({ name: 'Google' });
  });

  it('reads no response member and sets no claim of its own', () => {
    expect(upstreamOidcPreset.responseMembers).toBeUndefined();
    expect(upstreamOidcPreset.identityClaims).toBeUndefined();
  });
});

describe("the SDK's preset kit", () => {
  it('passes, for every config an admin may write', () => {
    const report = checkUpstreamOidcPreset(upstreamOidcPreset, {
      configs: [
        CONFIG,
        {
          clientId: `${'9'.repeat(12)}-${'a'.repeat(32)}.apps.googleusercontent.com`,
          clientSecret: `GOCSPX-${'b'.repeat(28)}`,
        },
      ],
    });
    expect(report.checks).toEqual([
      'static',
      'config-schema',
      'upstream-config',
      'secret',
      'response-members',
      'identity-claims',
    ]);
  });

  it('refuses the same preset with a client secret that is not write-only', () => {
    const plain = defineUpstreamOidcPreset({
      ...upstreamOidcPreset,
      configSchema: z.strictObject({ clientId: z.string(), clientSecret: z.string() }),
    });
    expect(() => checkUpstreamOidcPreset(plain, { configs: [CONFIG] })).toThrow(
      AuthMethodContractError
    );
    expect(() => checkUpstreamOidcPreset(plain, { configs: [CONFIG] })).toThrow(/writeOnly/);
  });
});

describe('the config schema', () => {
  it('takes the client id and the client secret', () => {
    expect(googleConfigSchema.parse(CONFIG)).toEqual(CONFIG);
    expect(upstreamOidcPreset.configSchema.safeParse(CONFIG).success).toBe(true);
  });

  it('marks the client secret write-only, and nothing else', () => {
    const schema = z.toJSONSchema(googleConfigSchema) as {
      properties: Record<string, { writeOnly?: boolean; maxLength?: number }>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.properties['clientSecret']?.writeOnly).toBe(true);
    expect(schema.properties['clientId']?.writeOnly).toBeUndefined();
    expect([...schema.required].sort()).toEqual(['clientId', 'clientSecret']);
    expect(schema.additionalProperties).toBe(false);
  });

  it.each([
    ['an issuer', { issuer: 'https://idp.example.com' }],
    ['scopes', { scopes: ['openid'] }],
    ['endpoints', { endpoints: {} }],
    ['a client authentication', { clientAuthentication: { method: 'client_secret_basic' } }],
  ])('lets an admin set the client and nothing else: refuses %s', (_what, extra) => {
    expect(upstreamOidcPreset.configSchema.safeParse({ ...CONFIG, ...extra }).success).toBe(false);
  });

  it.each([
    ['no client secret', { clientId: CLIENT_ID }],
    ['no client id', { clientSecret: CLIENT_SECRET }],
    ['an empty client id', { ...CONFIG, clientId: '' }],
    ['an empty client secret', { ...CONFIG, clientSecret: '' }],
    ['a client id over 255 characters', { ...CONFIG, clientId: 'c'.repeat(256) }],
    ['a client secret over 1024 characters', { ...CONFIG, clientSecret: 's'.repeat(1025) }],
    ['a client id that is no string', { ...CONFIG, clientId: 1234 }],
  ])('refuses %s', (_what, config) => {
    expect(googleConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe('the client config', () => {
  it("is Google's issuer by discovery, the client, the secret in the body, openid email profile and RS256", () => {
    expect(googleUpstreamConfig(CONFIG)).toEqual({
      issuer: 'https://accounts.google.com',
      clientId: CLIENT_ID,
      clientAuthentication: { method: 'client_secret_post', clientSecret: CLIENT_SECRET },
      scopes: ['openid', 'email', 'profile'],
      idTokenSigningAlgorithms: ['RS256'],
    });
    expect(upstreamOidcPreset.upstreamConfig(CONFIG)).toEqual(googleUpstreamConfig(CONFIG));
  });

  it('sets no endpoint by hand, reads no userinfo and takes the response by query', () => {
    const config = googleUpstreamConfig(CONFIG);
    expect(config.endpoints).toBeUndefined();
    expect(config.fetchUserinfo).toBeUndefined();
    expect(config.responseMode).toBeUndefined();
    expect(config.tenantIssuer).toBeUndefined();
  });

  it('makes fresh lists at every use', () => {
    const first = googleUpstreamConfig(CONFIG);
    first.scopes?.push('https://www.googleapis.com/auth/drive');
    first.idTokenSigningAlgorithms?.push('HS256' as never);
    expect(googleUpstreamConfig(CONFIG).scopes).toEqual(['openid', 'email', 'profile']);
    expect(googleUpstreamConfig(CONFIG).idTokenSigningAlgorithms).toEqual(['RS256']);
  });
});

describe("Google's discovery document", () => {
  it('names the configured issuer', () => {
    expect(GOOGLE_DISCOVERY['issuer']).toBe(GOOGLE_ISSUER);
  });

  it.each(['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'userinfo_endpoint'])(
    "puts its %s on the preset's origins",
    (member) => {
      const url = new URL(String(GOOGLE_DISCOVERY[member]));
      expect(url.protocol).toBe('https:');
      expect(GOOGLE_ORIGINS).toContain(url.origin);
    }
  );

  it('uses every origin the preset names', () => {
    const named = [
      'issuer',
      'authorization_endpoint',
      'token_endpoint',
      'jwks_uri',
      'userinfo_endpoint',
    ].map((member) => new URL(String(GOOGLE_DISCOVERY[member])).origin);
    expect(new Set(named)).toEqual(new Set(GOOGLE_ORIGINS));
  });

  it('supports what the client config asks for', () => {
    const listed = (member: string) => GOOGLE_DISCOVERY[member] as string[];
    const config = googleUpstreamConfig(CONFIG);
    expect(listed('response_types_supported')).toContain('code');
    expect(listed('response_modes_supported')).toContain('query');
    expect(listed('code_challenge_methods_supported')).toContain('S256');
    expect(listed('token_endpoint_auth_methods_supported')).toContain('client_secret_post');
    expect(listed('id_token_signing_alg_values_supported')).toEqual(['RS256']);
    for (const scope of config.scopes ?? []) {
      expect(listed('scopes_supported')).toContain(scope);
    }
  });
});

describe('the attribute rules', () => {
  const PERSON = {
    iss: GOOGLE_ISSUER,
    sub: '110169484474386276334',
    email: 'ada@example.com',
    email_verified: true,
    name: 'Ada Lovelace',
    given_name: 'Ada',
    family_name: 'Lovelace',
    hd: 'example.com',
    picture: 'https://lh3.googleusercontent.com/a/ada',
  };

  it("are the preset's own", () => {
    expect(upstreamOidcPreset.attributes).toEqual(GOOGLE_ATTRIBUTES);
    expect(GOOGLE_ATTRIBUTES.map((rule) => rule.attribute ?? rule.claim)).toEqual([
      'email',
      'name',
      'given_name',
      'family_name',
      'locale',
      'hd',
    ]);
  });

  it('map the email as verified when email_verified says so, and keep hd unverified', () => {
    expect(mapped(GOOGLE_ATTRIBUTES, PERSON)).toEqual([
      { key: 'email', value: 'ada@example.com', verified: true },
      { key: 'name', value: 'Ada Lovelace', verified: false },
      { key: 'given_name', value: 'Ada', verified: false },
      { key: 'family_name', value: 'Lovelace', verified: false },
      { key: 'hd', value: 'example.com', verified: false },
    ]);
  });

  it.each([
    ['false', false],
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['null', null],
    ['absent', undefined],
  ])('keep the email unverified when email_verified is %s', (_case, flag) => {
    const claims: Record<string, unknown> = { sub: 'user-2', email: 'bob@example.com' };
    if (flag !== undefined) claims['email_verified'] = flag;
    expect(mapped(GOOGLE_ATTRIBUTES, claims)).toEqual([
      { key: 'email', value: 'bob@example.com', verified: false },
    ]);
  });

  it('read email_verified only as an own member of the claims', () => {
    const inherited = Object.create({ email_verified: true }) as Record<string, unknown>;
    inherited['email'] = 'eve@example.com';
    expect(mapped(GOOGLE_ATTRIBUTES, inherited)).toEqual([
      { key: 'email', value: 'eve@example.com', verified: false },
    ]);
  });

  it('never verify any attribute but the email, whatever the claims say', () => {
    for (const rule of GOOGLE_ATTRIBUTES.filter((rule) => rule.claim !== 'email')) {
      expect(rule.verified).toBeUndefined();
    }
    const claims = { ...PERSON, hd_verified: true, name_verified: true, locale: 'en' };
    expect(
      mapped(GOOGLE_ATTRIBUTES, claims)
        .filter((attribute) => attribute.verified)
        .map((attribute) => attribute.key)
    ).toEqual(['email']);
  });

  it('keep no claim without a rule, such as picture', () => {
    expect(mapped(GOOGLE_ATTRIBUTES, PERSON).map((attribute) => attribute.key)).not.toContain(
      'picture'
    );
  });
});

describe('the redirect URI to register at Google', () => {
  it("is the realm's origin and the plugin's callback", () => {
    expect(googleRedirectUri('https://auth.example.com')).toBe(
      'https://auth.example.com/upstream/google/callback'
    );
    expect(googleRedirectUri('https://auth.example.com:8443')).toBe(
      'https://auth.example.com:8443/upstream/google/callback'
    );
  });

  it.each([
    'https://auth.example.com/realm',
    'https://auth.example.com/',
    'https://auth.example.com?x=1',
    'auth.example.com',
    '',
  ])('refuses %j, which is no bare origin', (origin) => {
    expect(() => googleRedirectUri(origin)).toThrow(TypeError);
  });
});
