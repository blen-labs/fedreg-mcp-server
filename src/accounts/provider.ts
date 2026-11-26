import { betterAuth } from 'better-auth';
import { mcp } from '@better-auth/mcp';
import { ACCOUNT_MCP_PATH } from './paths.js';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { getMigrations } from 'better-auth/db/migration';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import type { AccountConfig } from './config.js';
import type { Store } from './store.js';
import { digest } from './crypto.js';
import { ACCESS_TOKEN_LIFETIME_SECONDS, ACCESS_TOKEN_SKEW_SECONDS, AccessTokenFormat } from './token-admission.js';

export const SCOPES = ['fedreg:read', 'offline_access'];

/** Same Google / OAuth provider as Data.gov, scoped to personal accounts. */
export function createAuth(config: AccountConfig, store: Store, now: () => number = Date.now) {
  const accessTokens = new AccessTokenFormat(config.authSecret, ACCESS_TOKEN_LIFETIME_SECONDS, ACCESS_TOKEN_SKEW_SECONDS, now);
  return betterAuth({
    baseURL: config.origin,
    basePath: '/api/auth',
    secret: config.authSecret,
    database: store.pool,
    trustedOrigins: [config.origin],
    logger: { disabled: true },
    // Sign-in and OAuth errors go to the portal's own page instead of Better Auth's unstyled one.
    onAPIError: { errorURL: '/error' },
    advanced: { useSecureCookies: config.production },
    // Better Auth enables its limiter only when NODE_ENV is exactly 'production', but an unset
    // NODE_ENV is production here. The app exempts OAuth registration and token endpoints from
    // its own IP limit on the strength of these limits, so tie them to the same flag.
    rateLimit: { enabled: config.production },
    session: { expiresIn: 7 * 86400, cookieCache: { enabled: false } },
    account: { encryptOAuthTokens: true, accountLinking: { enabled: false } },
    emailAndPassword: { enabled: false },
    disabledPaths: ['/link-social', '/update-user', '/change-email'],
    socialProviders: {
      google: {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        accessType: 'online',
        prompt: 'select_account',
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!['/oauth2/authorize', '/oauth2/consent', '/oauth2/continue'].includes(ctx.path)) return;
        const logged = await getSessionFromCtx(ctx);
        if (logged && !logged.user.emailVerified) throw new APIError('FORBIDDEN', { error: 'access_denied' });
      }),
    },
    plugins: [
      mcp({
        resource: `${config.origin}${ACCOUNT_MCP_PATH}`,
        loginPage: '/sign-in',
        consentPage: '/consent',
        scopes: SCOPES,
        grantTypes: ['authorization_code', 'refresh_token'],
        disableJwtPlugin: true,
        storeClientSecret: 'encrypted',
        storeTokens: { hash: digest },
        refreshTokenReuseInterval: 0,
        rateLimit: { register: { window: 60, max: 120 }, token: { window: 60, max: 1200 } },
        // Tokens carry an issuer MAC so /mcp/account can refuse made-up ones without a lookup (token-admission.ts).
        // Leave `prefix.opaqueAccessToken` unset: Better Auth would add it after hashing, and /mcp/account and
        // the token locks hash the presented value as is.
        accessTokenExpiresIn: ACCESS_TOKEN_LIFETIME_SECONDS,
        generateOpaqueAccessToken: () => accessTokens.generate(),
        refreshTokenExpiresIn: 30 * 86400,
        codeExpiresIn: 600,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: SCOPES,
        clientPrivileges: () => false,
        resourcePrivileges: () => false,
        // Personal accounts have one key source. Every new authorization gets the
        // same key-entry step as SAM.gov; /oauth2/continue completes this step.
        postLogin: {
          page: '/connect',
          shouldRedirect: async ({ user, session }) => !await store.connectionReady(session.id, user.id),
          consentReferenceId: async () => 'personal',
        },
        customAccessTokenClaims: async ({ user }) => {
          if (!user?.emailVerified) throw new APIError('FORBIDDEN', { error: 'access_denied' });
          return {};
        },
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    ],
  });
}
export type Auth = ReturnType<typeof createAuth>;

export async function initializeAuth(auth: Auth, config: AccountConfig, store: Store) {
  const lock = await store.pool.connect();
  let failure: unknown;
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext('fedreg-auth-migration'))");
    const migration = await getMigrations(auth.options);
    await migration.runMigrations();
    const context = await auth.$context;
    const resource = `${config.origin}${ACCOUNT_MCP_PATH}`;
    if (!await context.adapter.findOne({ model: 'oauthResource', where: [{ field: 'identifier', value: resource }] })) {
      await context.adapter.create({ model: 'oauthResource', data: {
        identifier: resource, name: 'Federal Regulations MCP', allowedScopes: SCOPES,
        disabled: false, policyVersion: 1, createdAt: new Date(), updatedAt: new Date(),
      } });
    }
  } catch (err) {
    failure = err;
  }
  // Unlock after the work either way. A connection that cannot unlock is discarded, and the
  // migration's own error (if any) is what the caller sees.
  try {
    await lock.query("SELECT pg_advisory_unlock(hashtext('fedreg-auth-migration'))");
  } catch {
    lock.release(true);
    throw failure ?? new Error('Auth migration lock connection failed');
  }
  lock.release();
  if (failure !== undefined) throw failure;
}
