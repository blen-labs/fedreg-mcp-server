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
  in `schema/field-dictionary.json` so `search_api` and `describe_schema` can
  surface them.
- Public API shape (the three tools, the `fr.*` / `ecfr.*` globals) is
  stable; breaking changes need a major version bump and a migration note.

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
`http.Server` against `StreamableHTTPServerTransport` over `fetch`, including
sandbox → SDK → mocked upstream. That's the canonical end-to-end check; please
keep it green and add to it for new HTTP-visible behavior.

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
  `schema/field-dictionary.json`.

## Releasing

Maintainers tag and publish with `npm publish --access public`. The `files`
field in `package.json` ships only `dist/`, `schema/`, `README.md`, `LICENSE`,
`NOTICE`, `CHANGELOG.md`, and `SECURITY.md`. Pre-publish, `pnpm build && pnpm test`
must pass on Node 20 and 22.

## Reporting security issues

See [SECURITY.md](./SECURITY.md). **Do not** open a public issue for
sandbox-escape reports.
