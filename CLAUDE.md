# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@blen/fedreg-mcp-server` — a "code-mode" MCP server for three U.S. government APIs: Federal Register (`fr.*`), eCFR (`ecfr.*`), and regulations.gov (`regs.*`). Instead of dozens of narrow tools it exposes exactly three — `search_api`, `describe_schema`, `execute` — and lets the model write TypeScript that runs in a locked-down sandbox with one global per source. Transports: stdio (default) and Streamable HTTP (`--http`).

## Commands

Run everything from this directory (`pnpm@10.33.0` pinned via `packageManager`; Node >= 20.10):

```bash
pnpm install
pnpm typecheck                          # tsc --noEmit — THE correctness gate; covers src/ AND test/
pnpm test                               # vitest run (all 12 spec files, ~1s, no network/keys needed)
pnpm test test/search.spec.ts           # single file (args forward to vitest, no -- needed)
pnpm test test/search.spec.ts -t "bm25" # single test by name (pair with file path to keep it fast)
pnpm lint                               # eslint . — minimal config (unused-vars only); passing means little
pnpm build                              # tsc -p tsconfig.build.json && chmod +x dist/bin.js || true
pnpm dev                                # tsx src/bin.ts (stdio)
pnpm dev --http                         # HTTP transport; also --port, --host, --sandbox, --insecure
```

- **`pnpm build` exits 0 even when compilation fails** (the script ends in `|| true`). Never treat a green build as proof it compiled — `pnpm typecheck` is the real gate.
- CI (`.github/workflows/ci.yml`) runs `typecheck`, `lint`, `test`, `build` in that order on Node 20 and 22, plus a Docker build. All four must pass; the PR template also requires them as checkboxes.
- A green `pnpm test` does NOT prove the sandbox works: sandbox-execution tests are gated on `await runner.available()` and silently no-op when no runner is present. CI compiles isolated-vm (Ubuntu + build tools); Deno is untested in CI.

### Environment notes

- On very new Node majors (e.g. 24), the optional `isolated-vm` dependency may fail to compile — harmless: install succeeds and `execute` falls back. Install [Deno](https://deno.com) and run with `--sandbox deno` (Deno must be on PATH; if installed to `~/.deno/bin`, prefix commands with `PATH="$HOME/.deno/bin:$PATH"`):
  `pnpm dev --http --insecure --port 8090 --host 127.0.0.1 --sandbox deno`
- Build-script approval for esbuild/isolated-vm lives in `pnpm-workspace.yaml` (`allowBuilds:`); don't move it to package.json and don't casually bump the pnpm major.

## Architecture

Request flow (both transports converge on the same tool catalog):

```
stdio | Streamable HTTP (+OAuth, per-IP bucket, quotas)     src/server/{stdio,http}.ts
  -> buildMcpServer (SDK v2 McpServer, 3 registerTool calls) src/server/mcpServer.ts, toolCatalog.ts
  -> tools: searchApi | describeSchema | execute             src/tools/
  -> execute: AST preflight -> sandbox runner                src/sandbox/{policy,isolate,deno}.ts
  -> sandbox globals (fr/ecfr/regs Proxies) --RPC bridge--> dispatch()   src/sdk/runtime.ts
  -> per-source HttpClient (undici + LRU + retry)            src/util/httpClient.ts
  -> upstream government APIs
```

`buildSupervisor(cfg)` in `src/supervisor/index.ts` is the single composition root: it assembles sources, SDK bindings, corpus, sandbox, and quota objects into `CatalogDeps`, which everything downstream receives by injection. All env vars are read in `src/bin.ts` (plus `FEDREG_LOG_LEVEL` in the logger) — nothing else touches `process.env`, and there is no dotenv: `.env.example` is documentation only.

**Source registry** (`src/sdk/sources/`): each source is a factory returning `{ name, label, enabled, disabledReason?, client, corpus }`. Adding a source = one factory + one line in `getSources()` + a `schema/<name>.json` corpus file — tools, sandbox injection, and dispatch are registry-driven. Source names are validated at boot as safe JS identifiers (they get string-interpolated into generated sandbox code — the validation is the security precondition). Disabled sources (e.g. `regs` without `FEDREG_REGS_API_KEY`) are still registered: the sandbox global exists and corpus stays searchable, but dispatch returns `SourceUnavailable` instead of a `ReferenceError`. This is by design and tested — don't "fix" it.

**Corpus** (`schema/{fr,ecfr,regs}.json`): hand-written, NOT generated. `search_api`/`describe_schema` only surface what's in these files, so every new SDK method needs a matching corpus entry (PR-template checkbox). Loaded at runtime via `readFileSync(resolve(__dirname, '../../../schema/...'))` from the compiled location — `schema/` must ship as a sibling of `dist/`, and moving `src/sdk/sources/` breaks the path.

**Sandbox**: two layers — an acorn AST preflight (`src/sandbox/policy.ts`, bans imports/eval/`process`/`globalThis`/`constructor`/`__proto__`/etc.) and then either `isolated-vm` (fresh V8 isolate, heap cap + timeout) or a `deno run --no-prompt` subprocess (no `--allow-*` flags; RPC over stdin/stdout with hex-length frames; **`memoryMb` is silently ignored on the Deno path**). User code is wrapped in `(async () => { ... })()`, so top-level `await`/`return` are legal. `pickSandbox` never throws — with no runner, the server still starts and `execute` returns `SandboxUnavailable`.

**HTTP transport** (`src/server/http.ts`): MCP `2026-07-28` — stateless, no `initialize` handshake, no `Mcp-Session-Id`. `createMcpHandler` builds a fresh `McpServer` + tool catalog **per request** via a factory, so the subject a tool sees always comes from that request's own bearer token; auth runs on every request. Pre-2026 clients are served by the SDK's stateless legacy fallback (`legacy: 'stateless'`), and `GET`/`DELETE /mcp` return 405. Auth is real only for the OIDC providers (`generic-oidc`/`clerk`/`workos`/`auth0` via jose JWKS); `none` and `embedded` map to a NoopVerifier that accepts any bearer token as subject `anonymous` (`src/auth/embedded.ts`'s `mintDevToken` is dead code). stdio has no auth and no subject, so per-subject quotas are skipped there.

**regulations.gov guardrails** (4 layers, all in-memory/single-process): per-execute call budget → per-subject hourly quota (any authenticated HTTP request — under `--insecure` every client collapses to subject `anonymous` and shares one bucket; stdio has no subject so it's skipped) → process-wide hourly token bucket (preflight, after the cache) → `retry429: false` so upstream 429s surface immediately. The API key lives host-side in a private `HttpClient` field and must never appear on `Source` objects, logs, or `JSON.stringify` output — tests assert this. A rate of `0` would mean "block everything", not "unlimited" — which is why `src/bin.ts` silently replaces any value < 1 with the default; disable regs by unsetting the key.

**Error shape** (changed with the v2 SDK — three distinct channels, verified on the wire):
- Exceptions inside `execute` do NOT become MCP errors. The result is a normal tool result (no `isError` field at all) whose text block is the full `ExecuteResult` — `{ ok, value?, logs, error?, durationMs }` — so clients must inspect `ok`.
- `isError: true` appears for a thrown handler exception (e.g. Zod parse failures) **and for argument-validation failures**: `registerTool` attaches the SDK's Ajv validator, and `zodToJsonSchema` emits `additionalProperties: false`, so an unknown argument key now yields `isError` + `"Input validation error: … must NOT have additional properties"`. Under v1 the schema was advertisement only and Zod silently stripped extra keys.
- An **unknown tool name is no longer a tool result at all** — the v2 `tools/call` path throws before the handler's try/catch, so it surfaces as a JSON-RPC error `{"error":{"code":-32602,"message":"Tool X not found"}}` (HTTP 200, no `result`). Clients that read `result.isError` to detect a bad tool name see `undefined`.

## Hard project rules (from CONTRIBUTING / SECURITY / the PR template, plus code conventions)

- **Anything that weakens the sandbox is out of scope** — never add `fetch`, `import`, filesystem, env, or subprocess access to the sandbox surface. Sandbox-escape reports go to a private GitHub Security Advisory, never a public issue.
- The public API (three tools; `fr.*`/`ecfr.*`/`regs.*` globals) is stable; breaking it needs a major version bump and migration note.
- PR checklist beyond the four gates: HTTP-visible change → add a case to `test/http-integration.spec.ts`; sandbox-visible change → add a positive AND a negative case to `test/sandbox.spec.ts`; new SDK method → corpus entry in the owning `schema/*.json`.
- ESM everywhere: relative imports use the `.js` extension even in `.ts` sources.
- Logs go to stderr only (`src/util/logger.ts`) — stdout is reserved for stdio JSON-RPC; a stray `console.log` in server code corrupts the protocol stream.

## Test conventions

- HTTP mocking is undici `MockAgent` injected via the `dispatcher` config field on `HttpClient`/`SourceConfig` — never `nock` (dead devDependency), never `setGlobalDispatcher`. A new client that doesn't thread `dispatcher` through will silently make real network calls in tests.
- No `vi.mock`/`vi.fn`/fake timers anywhere; the pattern is hand-written fakes satisfying the DI interfaces (`SandboxRunner`, `RpcBridge`, `preflightLimiter`). Follow it.
- No vitest globals and no setup files — every spec imports `describe/it/expect` from `vitest` explicitly. `pool: 'forks'` is required (sandbox runners spawn processes).
- `test/http-integration.spec.ts` is the canonical end-to-end check, and covers both eras: stateless `2026-07-28` requests (with the `_meta` envelope and `Mcp-Method`/`Mcp-Name` headers) and the legacy `initialize` fallback. Its `rpc()` helper builds the modern shape; use `post()` for raw/legacy bodies.
- `test/official-client.spec.ts` drives the server with the real `@modelcontextprotocol/client` SDK, which builds the `_meta` envelope and routing headers itself. Hand-built requests can't catch a protocol misunderstanding — the same wrong assumption goes into both the test and the server — so keep this spec passing when touching the transport.
- **MCP Inspector 2.1.0 cannot exercise the 2026-07-28 path.** Its CLI exposes no version-negotiation flag and the v2 client defaults to `versionNegotiation: 'legacy'`, so `npx @modelcontextprotocol/inspector --cli` always drives the *legacy* leg (verified on the wire: it sends `initialize`). It's a good compat-leg check; for the modern path use the client SDK directly with `versionNegotiation: { mode: 'auto' }` or `versionNegotiation: { mode: { pin: '2026-07-28' } }` — note the pin is a **nested object**, not `{ mode: 'pin', pin: ... }`; the flat form is not a valid `VersionNegotiationMode` and silently degrades to legacy negotiation.
- Several specs match URL-encoded query fragments (`conditions%5Bterm%5D=...`); changing query serialization surfaces as cryptic MockAgent "no interceptor" errors, not assertion diffs.

## Known traps

- `LATEST_PROTOCOL_VERSION` / `SUPPORTED_PROTOCOL_VERSIONS` exported by the v2 SDK are the **legacy-era** vocabulary (`2025-11-25` and older) kept for the backward-compat leg — they are NOT the revision this server speaks, and reading them as an era signal is the documented way to wrongly conclude v2 lacks 2026-07-28 support (upstream PR #2585). The modern value lives in the SDK's `core-internal` as `FIRST_MODERN_PROTOCOL_VERSION` but is not exported, so use `MCP_PROTOCOL_VERSION` from `src/server/mcpServer.ts`; a test pins `/health` to it.

- `.env.example` documents `FEDREG_EXEC_TIMEOUT_MS`/`FEDREG_EXEC_MEMORY_MB`, and `deploy/Dockerfile` sets `FEDREG_TRANSPORT` — all three are read nowhere. Execute limits are per-call Zod defaults in `src/tools/execute.ts`; transport is chosen only by the `--http` flag.
- The mcpb packaging pipeline is currently broken end-to-end: `scripts/mcpb-prepare.mjs` writes an obsolete DXT-0.1-shaped manifest that `@anthropic-ai/mcpb` rejects (`author`/`server` required), bare `pnpm mcpb:pack` targets the repo root (no manifest there → it stalls on an interactive init prompt), and the prepared bundle contains no `node_modules`, so its runtime deps wouldn't resolve anyway. Fixing it means rewriting the manifest literal in the script, staging production deps into `mcpb-build/`, then `pnpm build && pnpm mcpb:prepare && pnpm mcpb:pack mcpb-build`.
- `dist/` is never cleaned between builds — delete it manually after renaming/moving source files. Never edit `dist/` or `mcpb-build/` (both gitignored artifacts; `mcpb-build/` on disk is stale).
- `buildSupervisor` instantiates the sources twice (once directly, once inside `buildSdk`), so HttpClients/LRU caches exist in duplicate; the corpus comes from the first set, dispatch uses the second. Know this before refactoring wiring or reasoning about cache memory.
- Version strings live in three places (package.json, `src/server/mcpServer.ts`, `src/sdk/bindings.ts` `version()`). Releases are automated: release-please bumps all three (the two source lines carry `x-release-please-version` annotations — don't remove them) from Conventional Commit messages, so commit types (`feat:`/`fix:`/`!`) determine the next version. See CONTRIBUTING "Releasing".

## Docs

`docs/architecture.md` (layered design, guardrails rationale) and `docs/sdk-reference.md` (full `fr`/`ecfr`/`regs` method surface + query patterns like the FR→regs `objectId` bridge) are the deep references. `docs/superpowers/{specs,plans}/` hold the regulations.gov design spec and implementation plan — their status lines predate implementation; trust git history over doc status labels.
