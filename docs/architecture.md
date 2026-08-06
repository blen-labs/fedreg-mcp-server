# fedreg-mcp-server architecture

## Overview

```
Transport (stdio | Streamable HTTP + OAuth)
    ↓
buildMcpServer  (search_api | describe_schema | execute)
    ↓
Supervisor  (SDK + Sandbox + Quota)
    ↓
SDK bindings  fr.*  (FederalRegister.gov v1)
              ecfr.* (Electronic Code of Federal Regulations)
              regs.* (regulations.gov v4)
    ↓
HttpClient  (undici + LRU cache + retry-with-backoff)
    ↓
Upstream APIs
```

The server exposes exactly three MCP tools — the "code-mode" pattern that
Cloudflare popularized and that `clinicaltrials-mcp-server` uses:

| Tool              | Purpose |
|-------------------|---------|
| `search_api`      | BM25 over the per-source endpoint + field corpora |
| `describe_schema` | Exact path lookup or namespace enumeration (`prefix`) |
| `execute`         | Run TypeScript in a sandbox against `fr.*` / `ecfr.*` / `regs.*` |

## SDK bindings

Up to three sibling globals are injected into the sandbox:

- **`fr.*`** — FederalRegister.gov v1: `documents`, `publicInspection`,
  `agencies`, `issues`, `suggestedSearches`, `images`.
- **`ecfr.*`** — eCFR: `titles`, `admin.agencies`, `structure`, `ancestry`,
  `versions`, `full`, `search.{results, counts_*, suggestions}`.
- **`regs.*`** — regulations.gov v4: `documents`, `comments`, `dockets`, each
  with `search()` / `get()`. Responses are raw JSON:API
  (`{ data, included?, meta }`). This is the only source for public comments,
  dockets, and live comment-period status.

The bindings are implemented in TypeScript on the host
(`src/sdk/{fr,ecfr,regs}-client.ts`) and exposed inside the sandbox as Proxy
objects that RPC back to the host. The host translates each RPC call into
a parameterized HTTP request, threading through retry, LRU caching, and a
configurable user agent.

### Source registry

Each binding is produced by a `Source` factory under `src/sdk/sources/`
(`fr.ts`, `ecfr.ts`, `regs.ts`); `getSources(cfg)` (`src/sdk/sources/index.ts`)
assembles the list, validates that each name is a safe JS identifier that does
not collide with a sandbox global, and hands the set to the supervisor and the
sandbox global injector. Adding a source is one factory plus one line here —
the tools, sandbox injection, and dispatch are all registry-driven.

A `Source` reports `enabled` / `disabledReason`. The dispatcher
(`src/sdk/runtime.ts`) injects only enabled sources; a call to a disabled
source returns a `SourceUnavailable` error carrying its `disabledReason`,
so one missing dependency never takes the others down.

### regulations.gov: key handling and degradation

regulations.gov requires a free API key (`FEDREG_REGS_API_KEY`). It is held
**host-side** inside the `regs` `HttpClient` (sent as the `X-Api-Key` default
header) and **never reaches the sandbox** — sandboxed code cannot read or
exfiltrate it. Without the key, the `regs` source is **disabled**: `regs.*`
calls return `SourceUnavailable` while `fr` and `ecfr` keep working
(graceful degradation).

Four layered rate guardrails protect the shared upstream quota:

- **No-429-retry** — the `regs` `HttpClient` is built with `retry429: false`,
  so a `429` surfaces immediately as `RateLimited` instead of being retried
  (retrying a quota error only burns more of the budget).
- **Per-execute budget** — at most `FEDREG_REGS_MAX_CALLS_PER_EXECUTE`
  (default `30`) regulations.gov upstream calls per single `execute()` run;
  exceeding it fails the call (`RegsCallBudgetExceeded`) rather than fanning
  out unbounded requests.
- **Process-wide token bucket** — a single in-memory bucket caps total `regs`
  upstream calls to `FEDREG_REGS_RATE_PER_HOUR` (default `1000`/hr) across all
  tenants, protecting the shared api.data.gov key; over the limit
  returns `RegsRateLimited`. It sits *after* the response cache, so cache hits
  are free. **It is in-memory / single-process and does NOT coordinate across
  replicas:** N replicas allow up to N× the configured rate against the shared
  key, so divide the rate by replica count or use per-replica keys.
- **Per-subject hourly quota** — in HTTP auth mode only,
  `FEDREG_REGS_SUBJECT_RATE_PER_HOUR` (default `500`/hr) per authenticated
  subject (over the limit returns `RegsSubjectQuotaExceeded`). Skipped in stdio
  (no subject). The subject is re-derived from the caller's bearer token on
  every request, so quota is always attributed to the tenant that actually
  presented credentials for that call.

For the two hourly rates, `0` is **not** "unlimited" — it blocks all regs
calls; to disable the source, leave `FEDREG_REGS_API_KEY` unset.

The full surface lives in [`docs/sdk-reference.md`](./sdk-reference.md).

## Sandbox

Two runners are supported:

- **`isolate`** — `isolated-vm` (V8 isolate). First choice on Linux / macOS /
  Windows on x64 / arm64.
- **`deno`** — `deno run --no-prompt -` subprocess with **no `--allow-*`
  flags**. Fallback when `isolated-vm` is unavailable (e.g. Alpine, some
  ARM targets).

Both runners enforce:

- **AST preflight** via Acorn — rejects `import` / `import()` / `eval` /
  `new Function` and references to `process`, `globalThis`, `Buffer`,
  `Deno`, `fetch`, `Worker`, plus `__proto__` / `constructor` / `prototype`
  member access.
- **Wall-clock timeout** (default 15 s, configurable via `timeoutMs`).
- **Memory cap** (default 64 MB on the isolate runner; not directly
  enforceable on Deno).
- **No network / fs / env / subprocess** at the runtime layer (the AST
  check is just the first line of defense).

If neither runner is available, `pickSandbox('auto')` returns an
`UnavailableRunner` that returns a `SandboxUnavailable` error from
`execute` — the other two tools keep working.

## Streamable HTTP transport

The server speaks MCP `2026-07-28`, whose protocol core is **stateless**: there
is no `initialize`/`initialized` handshake and no `Mcp-Session-Id`. Every request
is self-contained, carrying its protocol version, client info, and capabilities
in `_meta`, so any request can be served by any replica with no sticky routing
or shared session store.

`--http` enables a Node `http.Server` that handles:

- `GET /.well-known/oauth-protected-resource/mcp` — RFC 9728 metadata
  document (`resource`, `authorization_servers`, `bearer_methods_supported`,
  `scopes_supported`).
- `GET /health` — liveness probe (used by Docker `HEALTHCHECK` and Railway).
- `POST /mcp` — the MCP endpoint. Each POST is one complete JSON-RPC request.
  `MCP-Protocol-Version` and `Mcp-Method` are required, plus `Mcp-Name` for
  `tools/call`; a header that disagrees with the body is rejected with
  `-32020 HeaderMismatch`. `GET`/`DELETE` on this path return `405` (they were
  2025-era session operations).
- `server/discover` returns supported protocol versions, capabilities, and
  server identity on demand, replacing what the handshake used to carry.

`tools/list` and `server/discover` results carry `ttlMs` and `cacheScope`
(`300000` / `public`) so clients and shared caches can hold them: the catalog is
derived from process configuration, never from the caller, so it is identical
for every tenant.

Pre-2026 clients are still served: requests that arrive without the `_meta`
envelope are classified as legacy and answered by a per-request stateless
`2025-11-25` fallback, so the `initialize` handshake continues to work. No
session is minted on either path.

Bearer authentication is gated by `FEDREG_AUTH_PROVIDER`:

| Provider | How tokens are verified |
|----------|-------------------------|
| `none`   | No verification. Combine with `--insecure` (HTTP only). |
| `embedded` | HS256 with a shared secret. DEV ONLY. |
| `generic-oidc` | JWKS via `jose` against `FEDREG_AUTH_JWKS_URL`. |
| `clerk`, `workos`, `auth0` | Preset issuer/JWKS shapes for the named provider. |

The HTTP transport also enforces:

- **DNS rebinding protection** — `FEDREG_ALLOWED_HOSTS` allowlist on the
  Host header.
- **Per-IP rate limit** — token bucket with `FEDREG_IP_RPS` sustained rate
  and `FEDREG_IP_BURST` burst.
- **Per-subject daily quota** — `FEDREG_SUBJECT_DAILY_QUOTA` requests per
  authenticated subject per UTC day. Auth runs on every request (there is no
  session in which an identity could persist), so both this quota and the
  per-subject regs quota are keyed on the subject that request's own token
  verified as.
- **Graceful shutdown on SIGTERM** — the MCP handler is closed first (which
  aborts in-flight exchanges and releases their sockets), then the listener.
  The order matters: `server.close()` only resolves once every connection is
  idle, so closing it first would hang behind an open exchange.

## Caching and retry

`HttpClient` wraps `undici.request` with:

- An in-memory LRU keyed on canonical URL **plus a redacted hash of the request's
  auth headers**, so a cached response is never served across different
  `X-Api-Key` values (no cross-key cache bleed). 5 minutes by default.
- Exponential backoff on `429` and `5xx` (3 retries by default).
- A configurable user agent — please set yours per FederalRegister.gov /
  eCFR etiquette via `FEDREG_USER_AGENT`.

## Layout

```
src/
  bin.ts                   # CLI entry
  index.ts                 # library exports
  server/                  # MCP server, transports, authz, rate limiting
  tools/                   # the three tools
  sdk/                     # fr/ecfr/regs clients + sources registry + types
  sandbox/                 # isolate + deno runners, AST preflight
  search/                  # BM25 + corpus loader
  auth/                    # auth re-exports + embedded HS256 dev minter
  supervisor/              # builds SDK + picks sandbox
  util/                    # http client, logger, quotas
schema/
  fr.json                  # Federal Register endpoint + field corpus
  ecfr.json                # eCFR endpoint + field corpus
  regs.json                # regulations.gov endpoint + field corpus
test/                      # vitest specs
examples/                  # snippets you can paste into `execute`
deploy/                    # Dockerfile, railway.toml, RAILWAY.md
docs/                      # this file + sdk-reference.md
```
