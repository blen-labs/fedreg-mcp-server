# @blen/fedreg-mcp-server

[![CI](https://github.com/blencorp/fedreg-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/blencorp/fedreg-mcp-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@blen/fedreg-mcp-server.svg)](https://www.npmjs.com/package/@blen/fedreg-mcp-server)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.10-339933.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-1.29-7c3aed.svg)](https://modelcontextprotocol.io/)

A **code-mode** MCP server that lets an LLM write TypeScript against the U.S.
**Federal Register** (`fr.*`) and the **Electronic Code of Federal Regulations**
(`ecfr.*`) and run it inside a sandbox. Same three-tool pattern as
[`clinicaltrials-mcp-server`](https://github.com/blencorp/clinicaltrials-mcp-server).

```text
                   ┌────────────────────────┐
   MCP client ─▶  │  search_api            │  ── BM25 over endpoint+field docs
                  │  describe_schema       │  ── exact path / namespace lookup
                  │  execute(code)         │  ── runs TS in a sandbox
                   └──────────┬─────────────┘
                              ▼
                    fr.*  +  ecfr.*  globals
                              ▼
                    undici → upstream APIs
```

## Why this exists

The Federal Register and eCFR APIs are wide. Modeling each endpoint as its own
MCP tool produces dozens of overlapping, narrowly-typed tools. **Code mode**
inverts that: one `execute` tool, two well-typed SDK globals, and the model
writes whatever query it actually wants. `search_api` + `describe_schema` help
it find the right call. Cloudflare and the clinical-trials reference server
showed this pattern works; this server applies it to U.S. federal regulations.

## Tools

| Tool | What it does |
|---|---|
| `search_api(query, k?)` | BM25 over endpoint + field docs for both APIs. Returns TS snippets. |
| `describe_schema({ path? \| prefix? })` | Exact lookup or namespace enumeration. |
| `execute({ code, timeoutMs?, memoryMb? })` | Run TypeScript in a sandbox; globals `fr` and `ecfr` proxy to the SDKs. |

See [`docs/sdk-reference.md`](./docs/sdk-reference.md) for the full surface.

## Install

```bash
npm i -g @blen/fedreg-mcp-server
# or run on demand
npx -y @blen/fedreg-mcp-server
```

Requires Node.js ≥ 20.10. The `isolated-vm` sandbox is an `optionalDependency`
and is built automatically on Linux/macOS/Windows on x64/arm64; if it can't be
compiled, the server falls back to a Deno subprocess sandbox when `deno` is on
`PATH`. If neither is available, `search_api` and `describe_schema` still work;
`execute` returns a `SandboxUnavailable` error.

> **Troubleshooting `execute`.** On very new Node majors, `isolated-vm` may not
> yet have a compatible build and will fail to compile. In that case install
> [Deno](https://docs.deno.com/runtime/getting_started/installation/) and run
> with `--sandbox deno` (or set `FEDREG_SANDBOX=deno`) — `execute` then runs in
> the Deno subprocess sandbox. Node 20 and 22 build `isolated-vm` cleanly.

## Quickstart — Claude Desktop (stdio)

```json
{
  "mcpServers": {
    "fedreg": {
      "command": "npx",
      "args": ["-y", "@blen/fedreg-mcp-server"]
    }
  }
}
```

## Quickstart — HTTP (remote, OAuth-gated)

```bash
# Dev (no auth — DO NOT use in production)
fedreg-mcp-server --http --insecure --port 8080

# Production (auth via your OIDC issuer of choice)
FEDREG_AUTH_PROVIDER=clerk \
FEDREG_AUTH_ISSUER=https://<tenant>.clerk.accounts.dev \
FEDREG_AUTH_JWKS_URL=https://<tenant>.clerk.accounts.dev/.well-known/jwks.json \
FEDREG_PUBLIC_ORIGIN=https://your-host.example.com \
FEDREG_ALLOWED_HOSTS=your-host.example.com \
  fedreg-mcp-server --http
```

Then point any MCP client at it:

```json
{ "mcpServers": { "fedreg": { "type": "http", "url": "https://your-host.example.com/mcp" } } }
```

For Railway, see [`deploy/RAILWAY.md`](./deploy/RAILWAY.md). The bundled
[`Dockerfile`](./deploy/Dockerfile) builds `isolated-vm` and slims to a
`node:22-bookworm-slim` runtime (~220 MB).

## SDK surface (sandbox globals)

```ts
// Federal Register
await fr.documents.search({
  conditions: {
    term: 'methane',
    agencies: ['environmental-protection-agency'],
    publication_date: { gte: '2024-01-01' },
    type: ['RULE', 'PRORULE'],
  },
  fields: ['document_number', 'title', 'publication_date', 'html_url'],
  per_page: 25,
  order: 'newest',
});
await fr.documents.get('2024-12345');
await fr.documents.facets({ facet: 'monthly', conditions: { agencies: ['nuclear-regulatory-commission'] } });
await fr.publicInspection.current();
await fr.agencies.list();

// eCFR
await ecfr.titles.list();
await ecfr.structure('2024-01-01', 40);
await ecfr.ancestry('2024-01-01', 40, { part: '60' });
await ecfr.search.results({ query: 'greenhouse gas', agency_slugs: ['environmental-protection-agency'] });
await ecfr.full('2024-01-01', 40, { part: '60' });
```

Full reference: [`docs/sdk-reference.md`](./docs/sdk-reference.md).
Examples you can paste straight into `execute`: [`examples/`](./examples/).

## CLI

```
fedreg-mcp-server [options]

  --http                 Streamable HTTP transport (default: stdio)
  --port N               HTTP port (default 8080, env PORT)
  --host H               HTTP bind host (default 0.0.0.0, env HOST)
  --sandbox auto|isolate|deno
                         Sandbox runner (default auto, env FEDREG_SANDBOX)
  --insecure             HTTP without auth (DEV ONLY)
  -h, --help             Show help
```

## Configuration

See [`.env.example`](./.env.example) for the full list. Common knobs:

| Variable | Default | Notes |
|---|---|---|
| `FEDREG_SANDBOX` | `auto` | `auto` / `isolate` / `deno` |
| `FEDREG_USER_AGENT` | `fedreg-mcp-server/0.1 (+https://github.com/blencorp/fedreg-mcp-server)` | Please identify yourself per FR/eCFR etiquette. |
| `FEDREG_AUTH_PROVIDER` | `none` | `none` / `embedded` / `generic-oidc` / `clerk` / `workos` / `auth0` |
| `FEDREG_AUTH_ISSUER`, `FEDREG_AUTH_AUDIENCE`, `FEDREG_AUTH_JWKS_URL` | — | OIDC config |
| `FEDREG_PUBLIC_ORIGIN` | — | Public origin clients use (resource metadata, WWW-Authenticate) |
| `FEDREG_ALLOWED_HOSTS` | — | Comma-separated Host header allowlist (DNS rebinding) |
| `FEDREG_IP_RPS`, `FEDREG_IP_BURST` | 5 / 20 | Per-IP token-bucket rate limit |
| `FEDREG_SUBJECT_DAILY_QUOTA` | 10000 | Per authenticated subject per UTC day |
| `FEDREG_CACHE_TTL_MS` | 300000 | Upstream LRU cache |

## Sandbox guarantees

User code runs with:

- **No network, no filesystem, no env, no FFI, no subprocess**
- **AST preflight** via `acorn` rejects `import`, `import()`, `eval`, `new Function`,
  `process`, `globalThis`, `Buffer`, `Deno`, `fetch`, `Worker`, and
  `__proto__` / `constructor` / `prototype` member access.
- **Wall-clock timeout** (`timeoutMs`, default 15 s).
- **Heap cap** (`memoryMb`, default 64 MB; isolate runner only).

The only way out is the host-side RPC bridge that powers `fr.*` and `ecfr.*`,
which is restricted to the two configured base URLs. See
[`SECURITY.md`](./SECURITY.md) for the full threat model.

## Develop

```bash
pnpm install
pnpm test           # 27 tests, ~1s
pnpm typecheck
pnpm lint
pnpm dev            # tsx src/bin.ts (stdio)
pnpm dev -- --http  # tsx src/bin.ts --http
pnpm build
```

The HTTP integration test in [`test/http-integration.spec.ts`](./test/http-integration.spec.ts)
exercises a real `http.Server` against `StreamableHTTPServerTransport` via
`fetch`, including a full `initialize → notifications/initialized → tools/list
→ tools/call → sandbox → SDK → mocked upstream` round trip.

## Architecture

```
Transport (stdio | Streamable HTTP + OAuth)
    ↓
buildMcpServer  (search_api | describe_schema | execute)
    ↓
Supervisor  (SDK + Sandbox + Quota)
    ↓
SDK bindings  fr.* + ecfr.*
    ↓
HttpClient  (undici + LRU + retry)
    ↓
Upstream APIs
```

More detail in [`docs/architecture.md`](./docs/architecture.md).

## Project layout

```
src/{server,tools,sdk,sandbox,search,auth,supervisor,util}/
schema/field-dictionary.json
test/      examples/      docs/      deploy/
```

## Contributing

Pull requests welcome. Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md)
first and open an issue for anything non-trivial before sending.

## Security

If you find a sandbox escape, auth bypass, or other security issue, please
use a [GitHub Security Advisory](https://github.com/blencorp/fedreg-mcp-server/security/advisories/new)
rather than a public issue. See [`SECURITY.md`](./SECURITY.md).

## License

Apache-2.0 — see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).

## Acknowledgements

- The U.S. Government Publishing Office and the National Archives for
  publishing the Federal Register and eCFR APIs.
- The Anthropic Model Context Protocol team for the spec and TypeScript SDK.
- The Cloudflare Agents team for popularizing the code-mode pattern.
- The `clinicaltrials-mcp-server` reference implementation that this server
  mirrors.

## Upstream APIs

- FederalRegister.gov API v1 — <https://www.federalregister.gov/developers/documentation/api/v1>
- eCFR API — <https://www.ecfr.gov/developers/documentation/api/v1>
