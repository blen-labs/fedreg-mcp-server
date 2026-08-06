# Contributing

Thanks for considering a contribution. This project is small enough that
process is mostly conversational — open an issue describing what you want
to do before sending anything non-trivial, and we'll figure it out together.

## Ground rules

- The server's whole reason for existing is to be a safe place to run untrusted
  TypeScript against two public APIs. **Anything that weakens the sandbox is
  out of scope.** That includes adding `fetch`, `import`, filesystem, env,
  or subprocess access to the sandbox surface.
- New SDK methods are welcome but must be paired with field/endpoint entries
  in the corpus so `search_api` and `describe_schema` can surface them. Each
  source owns its own file — `schema/{fr,ecfr,regs}.json` — so add the entry to
  the file for the source you're touching.
- Public API shape (the three tools, the `fr.*` / `ecfr.*` / `regs.*` globals)
  is stable; breaking changes need a major version bump and a migration note.

## Development

```bash
pnpm install
pnpm test          # vitest, ~1s
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm dev           # tsx src/bin.ts (stdio)
pnpm dev -- --http # tsx src/bin.ts --http
pnpm build         # tsc + chmod
```

The HTTP integration test (`test/http-integration.spec.ts`) exercises a real
`http.Server` against the v2 SDK's `createMcpHandler`/`toNodeHandler` over `fetch`,
covering both the stateless `2026-07-28` leg and the legacy `initialize` fallback,
including sandbox → SDK → mocked upstream. That's the canonical end-to-end check;
please keep it green and add to it for new HTTP-visible behavior.

`test/official-client.spec.ts` drives the same server with the real
`@modelcontextprotocol/client` SDK, which builds the `_meta` envelope and routing
headers itself — keep it passing whenever you touch the transport, since hand-built
requests cannot catch a protocol misunderstanding shared by both sides.

## Sandbox runners

- The primary runner is `isolated-vm`. On platforms where it compiles cleanly
  (Linux/macOS/Windows on x64/arm64), `pnpm install` will build it.
- The fallback runner shells out to `deno run --no-prompt` against a temporary
  runner file (stdin is reserved for the host↔sandbox RPC channel). Install Deno
  separately if you want to test that path: <https://docs.deno.com/runtime/getting_started/installation/>.
- `pickSandbox('auto')` prefers `isolate`, then `deno`, then `unavailable`
  (which surfaces a `SandboxUnavailable` error from `execute`).

## What needs work

- More fixtures and shape assertions for the eCFR `/full` endpoint.
- A small Cloudflare Workers deploy target sharing the core logic (today the
  HTTP transport is Node-only).
- An "embedded" auth provider that mints/verifies short-lived HS256 tokens
  end-to-end with a documented dev flow.
- Schema entries for the few Federal Register fields not yet in
  `schema/fr.json`.

## Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please)
(`.github/workflows/release.yml`):

1. Land changes on `main` using [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat:`, `fix:`, `docs:`, …; add `!` or a `BREAKING CHANGE:` footer for majors).
   The commit types determine the next SemVer version.
2. On every push to `main`, release-please opens or updates a **Release PR**
   that bumps the version (in `package.json` and the annotated
   `x-release-please-version` lines in `src/server/mcpServer.ts` and
   `src/sdk/bindings.ts`) and drafts the CHANGELOG section.
3. **Merging the Release PR** creates the `vX.Y.Z` tag and GitHub Release, and
   triggers the publish job: full gates (typecheck, lint, test) and then
   `pnpm publish --access public` with npm provenance.

Setup requirement: an `NPM_TOKEN` repository secret with publish rights to
`@blen/fedreg-mcp-server` (Settings → Secrets and variables → Actions). The
`files` field in `package.json` ships only `dist/`, `schema/`, `README.md`,
`LICENSE`, `NOTICE`, `CHANGELOG.md`, and `SECURITY.md`.

Breaking changes additionally need a migration note (see
`docs/migration-v2.md` for the pattern).

## Reporting security issues

See [SECURITY.md](./SECURITY.md). **Do not** open a public issue for
sandbox-escape reports.
