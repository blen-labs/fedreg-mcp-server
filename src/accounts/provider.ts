import { betterAuth } from 'better-auth';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { getMigrations } from 'better-auth/db/migration';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import type { AccountConfig } from './config.js';
import type { Store } from './store.js';
import { digest } from './crypto.js';

export const SCOPES = ['fedreg:read', 'offline_access'];

/** Same Google / OAuth provider as Data.gov, scoped to personal accounts. */
export function createAuth(config: AccountConfig, store: Store) {
  return betterAuth({
    baseURL: config.origin,
    basePath: '/api/auth',
    secret: config.authSecret,
    database: store.pool,
    trustedOrigins: [config.origin],
    logger: { disabled: true },
    advanced: { useSecureCookies: config.production },
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
        resource: `${config.origin}/mcp`,
        loginPage: '/sign-in',
        consentPage: '/consent',
        scopes: SCOPES,
        grantTypes: ['authorization_code', 'refresh_token'],
        disableJwtPlugin: true,
        storeClientSecret: 'encrypted',
        storeTokens: { hash: digest },
        refreshTokenReuseInterval: 0,
        rateLimit: { register: { window: 60, max: 120 }, token: { window: 60, max: 1200 } },
        accessTokenExpiresIn: 900,
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
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext('fedreg-auth-migration'))");
    const migration = await getMigrations(auth.options);
    await migration.runMigrations();
    const context = await auth.$context;
    const resource = `${config.origin}/mcp`;
    if (!await context.adapter.findOne({ model: 'oauthResource', where: [{ field: 'identifier', value: resource }] })) {
      await context.adapter.create({ model: 'oauthResource', data: {
        identifier: resource, name: 'Federal Register MCP', allowedScopes: SCOPES,
        disabled: false, policyVersion: 1, createdAt: new Date(), updatedAt: new Date(),
      } });
    }
  } finally {
    try { await lock.query("SELECT pg_advisory_unlock(hashtext('fedreg-auth-migration'))"); }
    catch { lock.release(true); throw new Error('Auth migration lock connection failed'); }
    lock.release();
  }
}
