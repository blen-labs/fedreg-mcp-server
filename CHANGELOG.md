# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]




## [2.0.3] - 2026-08-06

### Changed
- pin the npm CLI version in the publish step
## [2.0.2] - 2026-08-06

### Changed
- publish with npm CLI >= 11.5 for OIDC trusted publishing
## [2.0.1] - 2026-08-06

### Fixed
- produce a valid, self-contained MCPB bundle (mcpb)
- validate Origin on /mcp per the MCP spec MUST (http)

### Changed
- release on every merge to main (continuous releases)
- remove all emoji from release notes and README
- switch npm publishing to tokenless trusted publishing (OIDC)
### Added
- **Origin validation on `/mcp`** (a spec MUST previously unimplemented, and
  unchanged since 1.x): browser-originated cross-site requests are rejected
  with `403 origin_not_allowed` unless the `Origin` is the server's own, a
  loopback origin, or listed in the new `FEDREG_ALLOWED_ORIGINS`
  (comma-separated exact origins). Requests without an `Origin` header —
  every non-browser MCP client — are unaffected.

### Fixed
- **MCPB packaging works again.** `scripts/mcpb-prepare.mjs` now emits a
  schema-valid v0.1 manifest (`author` + `server.mcp_config`, replacing the
  obsolete DXT-shaped top-level keys), stages hoisted production
  `node_modules` into the bundle so it runs standalone, and validates the
  manifest during prepare. `pnpm mcpb:pack` targets `mcpb-build/` and emits
  `fedreg-mcp-server.mcpb`. Note: `isolated-vm` ships unbuilt, so `execute`
  inside a bundle uses the Deno runner when available and reports
  `SandboxUnavailable` otherwise.

## [2.0.0] - 2026-08-06

**Breaking release.** The HTTP transport moves to the stateless MCP `2026-07-28`
protocol and tool arguments are now strictly validated. Pre-2026 MCP clients
keep working via a built-in legacy fallback. See the
[v2 migration guide](docs/migration-v2.md) for client and operator upgrade
steps.

### Changed
- **MCP protocol upgraded to `2026-07-28` (stateless core).** BREAKING for the
  HTTP transport. The `initialize`/`initialized` handshake and the
  `Mcp-Session-Id` header are gone; each request is self-contained, carrying its
  protocol version, client info, and capabilities in `_meta`. Requests can now
  be load-balanced across replicas with no sticky routing or shared session
  store. Migrated from `@modelcontextprotocol/sdk@1.x` to the v2 SDK
  (`@modelcontextprotocol/server` + `@modelcontextprotocol/node` `2.0.0`), which
  is the release line implementing this revision.
- **Per-subject quota attribution no longer depends on a session.** The
  authenticated subject is re-derived from the caller's bearer token on every
  request and passed to the tool catalog for that request only. This replaces
  the 2025-era session-subject binding (and the `403 session_subject_mismatch`
  guard added on `main` after v1.0.0, which never shipped in a release). The
  binding existed to stop one tenant reusing another's session id to spend
  or pollute their quota — an attack with no carrier now that no session id
  exists.
- **Tool arguments are now validated against the advertised JSON Schema.**
  BREAKING for clients that sent extra argument keys. `registerTool` attaches the
  SDK's validator, and the generated schemas set `additionalProperties: false`, so
  an unrecognized key returns `isError: true` with `"Input validation error: …
  must NOT have additional properties"`. Under `1.x` the schema was advertisement
  only and Zod silently stripped unknown keys.
- **An unknown tool name is now a JSON-RPC error, not a tool result.** It returns
  `{"error":{"code":-32602,"message":"Tool X not found"}}` instead of the previous
  `isError: true` content block, so clients must not read `result.isError` to
  detect it.
- **Per-source corpora** — the merged `schema/field-dictionary.json` is now
  split into per-source files (`schema/{fr,ecfr,regs}.json`), each loaded by
  its own `Source` via a registry (`getSources`).

### Added
- `server/discover` — advertises supported protocol versions, capabilities, and
  server identity on demand, replacing what the handshake used to carry.
- On modern (`2026-07-28`) requests the `Mcp-Method` routing header is
  required — plus `Mcp-Name` for `tools/call` — and is validated against the
  request body; a missing or disagreeing header is rejected with `-32020`
  (`HeaderMismatch`). Legacy requests are unaffected.
- `tools/list` and `server/discover` results carry `ttlMs` (300 s) and
  `cacheScope: "public"`. The catalog derives only from process configuration,
  never from the caller, so it is identical for every tenant and safe to share.
- Backward compatibility for pre-2026 clients: requests without the `_meta`
  envelope are classified as legacy and answered by a per-request stateless
  `2025-11-25` fallback, so the `initialize` handshake keeps working. No session
  is minted on either path.

- **regulations.gov source** — a third SDK binding, `regs.*`
  (`documents`, `comments`, `dockets`, each with `search` / `get`), exposing
  public comments, dockets, and live comment-period status. Requires a free
  API key (`FEDREG_REGS_API_KEY`); the key is held host-side and never reaches
  the sandbox. Without it, `regs` is disabled (`SourceUnavailable`) while `fr`
  and `ecfr` keep working. Configurable via `FEDREG_REGS_BASE_URL` and a
  per-`execute()` upstream-call budget (`FEDREG_REGS_MAX_CALLS_PER_EXECUTE`,
  default 30).
- **regulations.gov rate guardrails** — to protect the shared api.data.gov key:
  a process-wide hourly token bucket (`FEDREG_REGS_RATE_PER_HOUR`, default 1000;
  in-memory, so it does not coordinate across replicas), a per-authenticated-subject
  hourly quota in HTTP mode (`FEDREG_REGS_SUBJECT_RATE_PER_HOUR`, default 500), and
  no-429-retry on `regs`. The GET response cache key now also incorporates a redacted
  auth-context hash (no cross-key cache bleed), and the per-subject quota is keyed on
  the subject the request's own bearer token verified as.

### Removed
- `FEDREG_MAX_SESSIONS` — there are no protocol sessions left to cap. An existing
  deployment that still sets it is silently ignored rather than erroring.
- `GET`/`DELETE` on `/mcp` (2025-era session operations) now return `405`.
- `subscriptions/listen` is refused (`maxSubscriptions: 0`). This server declares
  only the `tools` capability, but the SDK routes the method regardless and would
  otherwise hold up to 1024 long-lived SSE streams per handler — the unbounded
  long-lived state that `FEDREG_MAX_SESSIONS` used to cap.

## [1.0.0] - 2026-05-20

Initial public release.

### Added
- **Three-tool code-mode MCP surface** — `search_api`, `describe_schema`,
  `execute` (the same pattern as `clinicaltrials-mcp-server`).
- **SDK bindings** — `fr.*` for FederalRegister.gov v1 (`documents`,
  `publicInspection`, `agencies`, `issues`, `suggestedSearches`, `images`)
  and `ecfr.*` for the Electronic Code of Federal Regulations (`titles`,
  `admin.agencies`, `structure`, `ancestry`, `versions`, `full`, `search.*`).
- **BM25 search** over a curated endpoint + field dictionary
  (`schema/field-dictionary.json`).
- **Sandbox** — `isolated-vm` (primary) and Deno subprocess (fallback) with
  shared AST preflight via `acorn`, wall-clock timeout, and heap cap.
- **stdio transport** for Claude Desktop and MCPB.
- **Streamable HTTP transport** built on `@modelcontextprotocol/sdk` 1.29:
  per-session `StreamableHTTPServerTransport`, SSE streaming, graceful
  SIGTERM/SIGINT drain.
- **OAuth 2.0 Protected Resource Metadata** per RFC 9728 at
  `/.well-known/oauth-protected-resource/mcp`, `WWW-Authenticate` header
  pointing at it on 401.
- **Bearer token verification** via `jose` against any JWKS endpoint
  (presets: `clerk`, `workos`, `auth0`, `generic-oidc`; `embedded` HS256
  for dev).
- **Hardening** — per-IP token-bucket rate limiting, per-subject daily
  quotas, Host-header allowlist for DNS-rebinding protection.
- **Deploy** — multi-stage Dockerfile (`deploy/Dockerfile`) that builds
  `isolated-vm` and slims to a `node:22-bookworm-slim` runtime, plus a
  Railway walkthrough in `deploy/RAILWAY.md`.
- **27 tests** across BM25, sandbox policy, both SDK clients (vs `undici`
  MockAgent), HTTP rate limiter, and an end-to-end MCP flow (initialize
  → notifications/initialized → tools/list → tools/call → sandbox → SDK
  → mocked upstream).

[Unreleased]: https://github.com/blen-labs/fedreg-mcp-server/compare/v2.0.3...HEAD
[2.0.3]: https://github.com/blen-labs/fedreg-mcp-server/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/blen-labs/fedreg-mcp-server/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/blen-labs/fedreg-mcp-server/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/blen-labs/fedreg-mcp-server/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/blen-labs/fedreg-mcp-server/releases/tag/v1.0.0
