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
    ↓
HttpClient  (undici + LRU cache + retry-with-backoff)
    ↓
Upstream APIs
```

The server exposes exactly three MCP tools — the "code-mode" pattern that
Cloudflare popularized and that `clinicaltrials-mcp-server` uses:

| Tool              | Purpose |
|-------------------|---------|
| `search_api`      | BM25 over the merged endpoint + field dictionary |
| `describe_schema` | Exact path lookup or namespace enumeration (`prefix`) |
| `execute`         | Run TypeScript in a sandbox against `fr.*` / `ecfr.*` |

## SDK bindings

Two sibling globals are injected into the sandbox:

- **`fr.*`** — FederalRegister.gov v1: `documents`, `publicInspection`,
  `agencies`, `issues`, `suggestedSearches`, `images`.
- **`ecfr.*`** — eCFR: `titles`, `admin.agencies`, `structure`, `ancestry`,
  `versions`, `full`, `search.{results, counts_*, suggestions}`.

The bindings are implemented in TypeScript on the host
(`src/sdk/{fr,ecfr}-client.ts`) and exposed inside the sandbox as Proxy
objects that RPC back to the host. The host translates each RPC call into
a parameterized HTTP request, threading through retry, LRU caching, and a
configurable user agent.

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

`--http` enables a Node `http.Server` that handles:

- `GET /.well-known/oauth-protected-resource/mcp` — RFC 9728 metadata
  document (`resource`, `authorization_servers`, `bearer_methods_supported`,
  `scopes_supported`).
- `GET /health` — liveness probe (used by Docker `HEALTHCHECK` and Railway).
- `POST /mcp` and `GET /mcp` — MCP endpoint. POSTs without a session id
  must be `initialize` requests; the response carries an
  `mcp-session-id` header that subsequent requests pass back.

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
  authenticated subject per UTC day.
- **Graceful drain on SIGTERM** — closes the listener and every open MCP
  session before exiting.

## Caching and retry

`HttpClient` wraps `undici.request` with:

- An in-memory LRU keyed on canonical URL (5 minutes by default).
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
  sdk/                     # fr/ecfr clients + sandbox-visible types
  sandbox/                 # isolate + deno runners, AST preflight
  search/                  # BM25 + corpus loader
  auth/                    # auth re-exports + embedded HS256 dev minter
  supervisor/              # builds SDK + picks sandbox
  util/                    # http client, logger, quotas
schema/
  field-dictionary.json    # merged endpoint + field corpus
test/                      # vitest specs (5 files, 27 tests)
examples/                  # snippets you can paste into `execute`
deploy/                    # Dockerfile, railway.toml, RAILWAY.md
docs/                      # this file + sdk-reference.md
```
