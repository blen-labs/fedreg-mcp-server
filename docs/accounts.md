# Personal account authentication

`FEDREG_AUTH_PROVIDER=accounts` enables Google sign-in (through Better Auth), an OAuth
provider for MCP clients, and an account page. Accounts are personal: each user signs in with a
Google account and has their own regulations.gov key. There are no organizations and no email and
password sign-in.

Users visit `/account`, sign in with Google, and save their regulations.gov key.
The server checks the key against the regulations.gov documents endpoint before
replacing an existing key. The account page only returns connection status, never
the stored key. Users can replace or remove it at any time.

Account mode serves two MCP endpoints, because MCP clients only start OAuth when
an endpoint answers 401:

| URL | Sign-in | Federal Register, eCFR | regulations.gov |
| --- | --- | --- | --- |
| `/mcp` | none | yes | the operator's shared `FEDREG_REGS_API_KEY` if set, otherwise a `SourceUnavailable` error naming `/mcp/account` |
| `/mcp/account` | Google, OAuth/PKCE | yes | the user's own saved key |

`/mcp` ignores any bearer token, refuses browser requests from other origins unless
listed in `FEDREG_ALLOWED_ORIGINS` (as the base transport does), and is limited per client IP with `FEDREG_IP_RPS`
and `FEDREG_IP_BURST` (in memory per replica, like the base transport).

An MCP client connects to `/mcp/account`, discovers the authorization server, registers
with DCR or CIMD, and uses authorization code + S256 PKCE. After sign-in, a separate Connect page lets the user check and save a key or
continue without one for Federal Register and eCFR. The Authorize page then shows
the client and callback destination and offers Allow/Cancel, with a link back to
change the key. Account settings support replacement, removal, and sign-out.

## Configuration

Use a **dedicated** PostgreSQL database for this server, with its own secrets.
Set the following in the deployment secret manager:

- `FEDREG_AUTH_PROVIDER=accounts`
- `FEDREG_PUBLIC_ORIGIN=https://fedreg.mcp.blenlabs.com` (or your own origin)
- `DATABASE_URL` pointing to the dedicated database
- `BETTER_AUTH_SECRET`: a random secret of at least 32 characters. It also keys the access-token MAC and
  encrypts confidential-client secrets, so changing it forces every connection and confidential client to
  re-authorize (see [Bearer token rollout](#bearer-token-rollout) and [Secret rotation](#secret-rotation)).
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- `ENCRYPTION_KEYS_JSON`: a JSON object mapping key IDs to base64-encoded 32-byte keys
- `ENCRYPTION_ACTIVE_KEY_ID`: the key ID used for new writes, for example `v1`

Configure the Google OAuth web application's redirect URI as
`https://fedreg.mcp.blenlabs.com/api/auth/callback/google` (substitute your origin).
The application must have the appropriate Google consent-screen configuration.
Create Google credentials for this server; do not reuse another application's.

Start with `pnpm build && pnpm start --http`. The build compiles the React frontend
to `dist/web`; `pnpm dev:web` rebuilds it while editing. Do not use `--insecure` in account
mode; startup rejects that combination. Migrations run before traffic is served,
under a PostgreSQL advisory lock. Back up the database before upgrading.

HTTP loopback origins are accepted only with `NODE_ENV=development` or `test`.
Production requires HTTPS and checks Host against the configured public origin.
The production server assumes one trusted proxy hop, as on Railway. Direct public
hosting or a different proxy chain needs a corresponding trust-proxy review.

### Requirements

- **Node.js 24.11 or later in the 24 line, or Node.js 26** (`engines` in `package.json`).
- **Deno on `PATH`.** Account mode serves many users from one process, so it runs each `execute`
  program only in a separate Deno process, never in the server's own process. Without Deno the
  server still starts, `search_api` and `describe_schema` work, and `execute` returns
  `SandboxUnavailable` with a message that says to install Deno. The Docker image in
  `deploy/Dockerfile` already contains Deno.
- A PostgreSQL database the server can create tables in (migrations run at startup).

## OAuth token locks and request budgets

`/oauth2/token` and `/oauth2/revoke` serialize per user with a
transaction-scoped PostgreSQL advisory lock, so refresh rotation and replay invalidation never
interleave across replicas. The lock follows the operation Better Auth runs: only form-encoded
bodies are accepted, a repeated field takes its last value (a conflicting repeat of `grant_type`
or of the chosen field is refused with 400), revoke uses `token`, a refresh grant `refresh_token`
and a code exchange `code`. Unrelated users do not queue together, and requests with nothing to
lock (client_credentials, missing fields, other media types) take no lock.

These requests use a separate pool of `FEDREG_AUTH_LOCK_POOL_SIZE` connections per replica
(default 10, 2 to 200) in addition to the main pool, so budget
`replicas x (main pool + FEDREG_AUTH_LOCK_POOL_SIZE)` against PostgreSQL's `max_connections`. A
waiting request holds one of them inside an open transaction (`idle in transaction`, with a 10
second `lock_timeout`), so do not set a shorter `idle_in_transaction_session_timeout` on the role
than that plus the slowest token response. A request that cannot get a connection within 10
seconds, or then the lock within another 10, is rolled back and answered `503` with `Retry-After: 1`; the client retries.

In memory per replica, before any lock or database lookup: each address may make 20 token or
revoke requests a second (bursts of 600). Bearer tokens at `/mcp/account` are admitted by their
authenticated format, and a bearer without that format is refused before any database work or shared
budget (see [Bearer token admission](#bearer-token-admission)); at most 256 token checks run at once per
address. IPv6 addresses count per /64 in every per-IP limit. Past a
budget the response is `429`.

## Isolation and persistence

- Ownership comes only from the verified browser session or OAuth token's user.
  Key-management requests cannot specify an owner or tenant.
- API keys use AES-256-GCM with random IVs and authenticated owner/purpose context.
  Encryption keys stay outside PostgreSQL. Database backups still need protection.
- OAuth access and refresh tokens are hashed; Google tokens and confidential
  client secrets are encrypted. Bearer access requires the right resource,
  `fedreg:read` scope, a current verified user, and an enabled client.
- Requests recheck the opaque token in PostgreSQL, so revocation takes effect on
  subsequent requests. Refresh-token rotation and revocation are serialized per
  user across replicas; each authorization-code exchange is serialized per code. Access tokens last 15 minutes; refresh tokens last 30 days.
- An execution reads the current personal key the first time its code calls
  `regs`; Federal Register and eCFR calls never read it. Replacement or deletion
  affects the next execution; a request already in flight may finish with the
  previous key.
- Signed-in calls at `/mcp/account` never fall back to `FEDREG_REGS_API_KEY`;
  that key only serves the anonymous `/mcp` endpoint (and stdio and legacy HTTP). Account credentials go only
  to `https://api.regulations.gov`; legacy upstream overrides cannot change this.
- Public-source caches stay shared. Each process caches regulations.gov clients
  (and their response caches) by account and key, so a new key gets a fresh cache.
  Keys never enter the sandbox.
- `FEDREG_REGS_RATE_PER_HOUR` caps each account in PostgreSQL across replicas.
  On the anonymous `/mcp`, it also caps the shared `FEDREG_REGS_API_KEY` per process
  (in memory), as in the base transport.
  `FEDREG_SUBJECT_DAILY_QUOTA` also caps MCP requests per account per UTC day.
  The per-execution call budget also applies; `FEDREG_REGS_SUBJECT_RATE_PER_HOUR`
  is ignored in account mode. Browser, key-validation, and OAuth endpoints have
  separate rate limits. Per-IP limits here are fixed (600/min per IP for browser
  traffic, 6000/min per IP on `/mcp/account` before the per-user limit) and ignore
  `FEDREG_IP_RPS`/`FEDREG_IP_BURST`; only the anonymous `/mcp` uses those. Behind a proxy, set `FEDREG_CLIENT_IP_HEADER`
  (Railway: `x-real-ip`): with it unset, Express's `trust proxy` takes the
  rightmost `X-Forwarded-For` entry, which on Railway is its edge, so many users
  would share one bucket, including Better Auth's OAuth limits.
- Browser state-changing requests require same-origin JSON; cookies are HttpOnly
  and SameSite, with Secure enabled in production. Responses are non-cacheable.
- Audit rows record owner, actor, action, and timestamp, not API-key material.
  An operator must define retention for accounts, audit records, and backups.

## Bearer token admission

Hosted connectors share a few egress IPs, so one client sending bad bearer tokens must not lock valid
users out of an address. Access tokens are issued in an authenticated format,
`at1.<kid>.<issued-at>.<24 random bytes>.<MAC>`: the MAC is an HMAC-SHA256 keyed from `BETTER_AUTH_SECRET`
(HKDF with the info string `fedreg-access-token-mac/<kid>`, so each key ID has its own key) over the rest of
the token. `/mcp/account` admits a token in this order:

1. A value with the `at1.` prefix and a wrong shape, unknown key ID or bad MAC is `401` with no database
   work, no flood allowance and no in-flight slot. Parsing is strict and the MAC is compared in constant time.
2. A MAC-valid token older than `issued-at + 15 minutes + 60 s` is `401` with no database work. The 60 s is
   clock skew for this cheap bound only; the database expiry stays authoritative and never gains the skew.
3. A digest whose completed database check was rejected (revoked, no row, wrong resource, disabled client,
   unverified user) is remembered for at most 60 s, a fixed time that hits never extend, and never beyond the
   admission bound of step 2. The cache holds 10,000 digests, never holds database errors or limit responses,
   and is per replica.
4. A digest whose own database check recently succeeded carries a "recently validated" marker, set or renewed
   by each such success (expiry 60 s from then), with the same cap at the admission bound and the same
   10,000-entry bound. It is a routing hint, not an authorization result: every request still runs its own
   database check, and a rejection deletes the marker.
5. Per digest and replica, one check runs at a time for an unknown digest and at most 16 for a marked one, and
   only running checks take shared in-flight slots (step 6). Further requests for the digest queue FIFO,
   holding no slot: up to 256 per digest and 4,096 overall, then `429` with `Retry-After` (a known cap: a cold
   replica serving more than 257 simultaneous first-use calls with one token refuses the excess). When a check
   finishes its permit passes directly to the oldest queued request (strict arrival order; a new request never
   overtakes the queue), each running its own fresh check. If the digest was rejected, or its admission bound
   passes, every queued request is answered `401` at once and the queue is released; if it succeeded, they
   proceed 16 at a time. A later rejection never renews an existing negative entry's expiry.
6. A running check takes an in-flight slot (256 per IP bucket) and the `mcp-ip:` flood guard (6,000 a minute),
   and every admitted request still does the full database check.

So one rejected digest that was never validated costs one lookup per replica while its entry is kept (a
restart or eviction costs one more). A token validated and then revoked holds at most 16 slots until its
first rejection is recorded, and none after, so it cannot starve other users of the address. Residual: N
distinct validated-then-revoked tokens can hold up to 16 x N slots, bounded by the in-flight cap and the flood
guard, and they need N real tokens. Revocation is never delayed (only rejections are cached), while a
re-enabled client is accepted again within 60 s. The per-IP in-flight cap and the flood guard remain shared by
everyone on an address: they are sized for connector traffic, and reaching them takes sustained load of real
tokens, but they are a capacity limit, not something this removes.

Queued requests wait without a shared slot but are not cancelled when their client disconnects; the queues are
bounded (256 per digest, 4,096 overall) and drain as checks finish.

Only tokens issued by this server's own OAuth provider go through these checks, and only on `/mcp/account`.
Everything else is unchanged: Better Auth's own `/api/auth/oauth2/userinfo` still looks the presented token
up by its digest and treats `at1` and old-format tokens alike (introspection and revocation take the token in the
request body); the anonymous `/mcp` endpoint reads no token and ignores any bearer value; the base HTTP
transport (`--http` with `FEDREG_AUTH_PROVIDER` set to `generic-oidc`, `clerk`, `workos` or `auth0`) verifies
OIDC/JWT bearer tokens by signature, issuer, audience and scope and treats every value, `at1`-shaped or not,
as a JWT, or accepts requests without a token under `--insecure`; stdio has no bearer tokens.

## Bearer token rollout

Only that format is accepted on `/mcp/account`: a bearer token without the `at1.` prefix, including an
old-format token that is still stored, is refused at step 1 with `401`, with no database work, no in-flight
slot and no flood allowance. Junk of any shape therefore never touches the `mcp-ip:` allowance or the
in-flight slots that valid users on a shared address depend on. The old format was retired in two releases,
with no timers: the change is code, so restarts never reopen it and every replica runs one rule.

- **Release 1 (dual-accept)** issued `at1` tokens and still accepted the old format on a separate path.
  **Release 2** removed that path. It could ship only after release 1 had been fully deployed, with no
  rollback, for at least `accessTokenExpiresIn + skew` (15 minutes + 60 s), the longest an old-format token
  issued by the last old instance can still be valid. Refresh tokens are unaffected.
- **Rollback.** Rolling back release 2 to release 1 is safe, as is rolling back release 1 to the version
  before it: that version validates by database digest only, and `at1` tokens are opaque strings to it.
- **Changing `accessTokenExpiresIn`.** The admission bound uses the maximum lifetime of any token that may
  still be valid: when raising or lowering it, keep the larger value in the bound until tokens issued under
  the old setting have expired.

Deploy prerequisite: all replicas must share `BETTER_AUTH_SECRET` (they already must), because the MAC key
derives from it; a replica with a different secret refuses other replicas' tokens.

## Secret rotation

Rotating `BETTER_AUTH_SECRET` is breaking, as it was before access-token MACs: confidential clients' secrets
are stored encrypted with it (`storeClientSecret: 'encrypted'`), so their refresh fails with `invalid_client`
until they re-register or re-authorize, and every outstanding access token stops verifying and is refused.
Plan a re-authorization of confidential clients and of all connections. A supported key-ring rotation (old and
new secrets side by side, key-ID overlap for the MAC, client-secret re-encryption) is not implemented. This is
separate from [Encryption rotation](#encryption-rotation), which covers the agency-key keyring and does not
rotate Better Auth's secret.

## Encryption rotation

To retire an encryption key:

1. Add the new key to `ENCRYPTION_KEYS_JSON`, **keeping the old one**, and set
   `ENCRYPTION_ACTIVE_KEY_ID` to the new ID. Deploy this. New writes now use the new key, and
   stored rows still open with the old one. Changing the active ID alone does not migrate
   stored rows.
2. Back up the database.
3. Run the rotation with the server's own account environment: the command loads the account
   configuration exactly as the server does, so it needs every variable listed above, not only
   `DATABASE_URL` and the encryption keys. Run it where the database is reachable, for example
   inside the deployed service:

   ```bash
   node dist/bin.js --rotate-keys
   ```

   It re-encrypts every stored credential that is not under the active key, in batches of 100
   (`Store.rotateAllKeys`), and records a `credential.reencrypted` audit event per row. A row
   that cannot be opened (its key ID is no longer in `ENCRYPTION_KEYS_JSON`, or it is damaged) is
   left as it was; the run continues with the next row. Like a normal start, the command creates
   or updates the tables first, and it accepts no server options (`--http`, `--insecure` and
   `--port` are refused). Each failed row gets one `credential.reencrypt_failed:<reason>:<key ID>`
   audit event, written once per owner, reason and key ID, so scheduled reruns do not grow the
   audit table.
4. Check the result. The command logs `accounts.keys_rotated` with the active key ID, the number
   of rows rotated and the number that failed, and one `accounts.key_rotation_failed` line with
   the owner and a coarse reason (`unknown_key`, `authentication` or `other`) for each failed row; it never logs key material. It exits 0 when every row was migrated and
   1 when any row failed, so a script can stop before step 5. It is safe to run again: rows
   already under the active key are skipped.
5. Remove the old key from `ENCRYPTION_KEYS_JSON` only when the command exits 0 and every backup
   that still holds rows sealed under it has been replaced or has expired. A restored backup
   cannot be opened without its key.

Loss of an encryption key makes the credentials sealed under it unrecoverable; users would need to
save them again.

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
flow in the deployed environment. Existing clients of `/mcp` keep working without
sign-in; users who want their own regulations.gov key connect `/mcp/account`.
This feature does not enable or deploy itself.
