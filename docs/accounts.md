# Personal account authentication

`FEDREG_AUTH_PROVIDER=accounts` enables the same Better Auth Google sign-in and
OAuth provider used by the sibling Data.gov server. This implementation supports
personal accounts; Data.gov's organization membership and email/password flows
are not enabled here.

Users visit `/account`, sign in with Google, and save their regulations.gov key.
The server checks the key against the regulations.gov documents endpoint before
replacing an existing key. The account page only returns connection status, never
the stored key. Users can replace or remove it at any time.

An MCP client connects to `/mcp`, discovers the authorization server, registers
with DCR or CIMD, and uses authorization code + S256 PKCE. The consent page shows
the client and callback destination and offers authorize/cancel. Users can save a
key on that page, or authorize without one to use Federal Register and eCFR.

## Configuration

Use a **dedicated** PostgreSQL database; do not share Data.gov's tables or secrets.
Set the following in the deployment secret manager:

- `FEDREG_AUTH_PROVIDER=accounts`
- `FEDREG_PUBLIC_ORIGIN=https://fedreg.mcp.blenlabs.com` (or your own origin)
- `DATABASE_URL` pointing to the dedicated database
- `BETTER_AUTH_SECRET`: a random secret of at least 32 characters
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- `ENCRYPTION_KEYS_JSON`: a JSON object mapping key IDs to base64-encoded 32-byte keys
- `ENCRYPTION_ACTIVE_KEY_ID`: the key ID used for new writes, for example `v1`

Configure the Google OAuth web application's redirect URI as
`https://fedreg.mcp.blenlabs.com/api/auth/callback/google` (substitute your origin).
The application must have the appropriate Google consent-screen configuration.
No Google credentials from the sibling app are copied automatically.

Start with `pnpm build && pnpm start --http`. Do not use `--insecure` in account
mode; startup rejects that combination. Migrations run before traffic is served,
under a PostgreSQL advisory lock. Back up the database before upgrading.

HTTP loopback origins are accepted only with `NODE_ENV=development` or `test`.
Production requires HTTPS and checks Host against the configured public origin.
The production server assumes one trusted proxy hop, as on Railway. Direct public
hosting or a different proxy chain needs a corresponding trust-proxy review.

## Isolation and persistence

- Ownership comes only from the verified browser session or OAuth token's user.
  Key-management requests cannot specify an owner or tenant.
- API keys use AES-256-GCM with random IVs and authenticated owner/purpose context.
  Encryption keys stay outside PostgreSQL. Database backups still need protection.
- OAuth access and refresh tokens are hashed; Google tokens and confidential
  client secrets are encrypted. Bearer access requires the right resource,
  `fedreg:read` scope, a current verified user, and an enabled client.
- Requests recheck the opaque token in PostgreSQL, so revocation takes effect on
  subsequent requests. Refresh-token rotation and revocation are serialized across
  replicas. Access tokens last 15 minutes; refresh tokens last 30 days.
- Each execution reads the current personal key. Replacement or deletion affects
  the next execution; a request already in flight may finish with the previous key.
- The account transport never falls back to `FEDREG_REGS_API_KEY`. That setting
  remains available for stdio and legacy HTTP modes. Account credentials go only
  to `https://api.regulations.gov`; legacy upstream overrides cannot change this.
- Public-source caches stay shared. Authenticated regulations.gov bindings and
  their response caches live only for an execution. Keys never enter the sandbox.
- `FEDREG_REGS_RATE_PER_HOUR` caps each account in PostgreSQL across replicas.
  `FEDREG_SUBJECT_DAILY_QUOTA` also caps MCP requests per account per UTC day.
  Per-execution budgets and the existing per-subject guard also apply. Browser,
  key-validation, and OAuth endpoints have separate rate limits.
- Browser state-changing requests require same-origin JSON; cookies are HttpOnly
  and SameSite, with Secure enabled in production. Responses are non-cacheable.
- Audit rows record owner, actor, action, and timestamp, not API-key material.
  An operator must define retention for accounts, audit records, and backups.

## Encryption rotation

Add the new key to `ENCRYPTION_KEYS_JSON`, retaining the old one, and set the new
active ID. `Store.rotateKeys(batchSize)` reencrypts stored credentials in locked
batches and records an audit event. Keep old keys until all rows and required
backups have been migrated or expired. Loss of an encryption key makes affected
credentials unrecoverable; users would need to save them again.

## Verification and rollout

`pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm test` cover the existing
transports and sandbox. Account integration tests require Deno on PATH and
`TEST_DATABASE_URL` pointing to a disposable PostgreSQL database. Each run creates
and removes its own randomly named schema. CI supplies both PostgreSQL and Deno.

The tests run real local HTTP requests, PostgreSQL migrations, browser sessions,
OAuth registration/consent/PKCE/refresh/revocation, and sandbox execution. Google
identity is seeded by Better Auth's test helper; regulations.gov is mocked. These
checks do **not** establish live Google sign-in or hosted-client interoperability.

Before enabling account mode on the hosted endpoint, configure its own Google
credentials, public callback, database, and encryption secrets. Verify Google
sign-in, a real user-provided API key, and the target MCP client's complete OAuth
flow in the deployed environment. Existing anonymous clients will need to
reconnect with OAuth. This feature does not enable or deploy itself.
