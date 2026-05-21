# Federal Register MCP Server

[![CI](https://github.com/blen-labs/fedreg-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/blen-labs/fedreg-mcp-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@blen/fedreg-mcp-server.svg)](https://www.npmjs.com/package/@blen/fedreg-mcp-server)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.10-339933.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-1.29-7c3aed.svg)](https://modelcontextprotocol.io/)

<p align="center">
  <video src="https://github.com/blen-labs/fedreg-mcp-server/raw/main/media/fedreg-launch.mp4" poster="https://raw.githubusercontent.com/blen-labs/fedreg-mcp-server/main/media/launch-poster.png" controls muted playsinline width="760"></video>
</p>

**Ask your AI assistant real questions about U.S. federal regulations — and get answers grounded in the official Federal Register and eCFR.**

This is a [Model Context Protocol](https://modelcontextprotocol.io) server that connects any MCP client (Claude Desktop, and others) to two official U.S. government sources:

- **[Federal Register](https://www.federalregister.gov)** — the daily journal of the federal government: rules, proposed rules, notices, and presidential documents since 1994.
- **[Electronic Code of Federal Regulations (eCFR)](https://www.ecfr.gov)** — the current, continuously updated text of the Code of Federal Regulations.

Instead of bolting on dozens of rigid, narrow tools, it hands the model a small, well-typed TypeScript SDK and lets it write the exact query it needs — then runs that code in a locked-down sandbox. This is the **code-mode** pattern, and it makes wide government APIs usable without overwhelming the model with tool definitions.

> Independent open-source project. It calls public U.S. government APIs and is not affiliated with or endorsed by the U.S. government.

## See it in action

Ask Claude:

> *"What does 50 CFR 21.150 cover, and have there been recent Federal Register rules touching migratory-bird depredation?"*

The model finds the right calls and runs them in the sandbox — no hand-written tool per endpoint:

```ts
// Pull the current text of an eCFR section…
const { titles } = await ecfr.titles.list();
const date = titles.find(t => t.number === 50).latest_issue_date;
const section = await ecfr.full(date, 50, { part: '21', section: '21.150' });

// …and search the Federal Register for related rulemaking.
const rules = await fr.documents.search({
  conditions: { term: 'migratory bird depredation', type: ['RULE', 'PRORULE'] },
  fields: ['title', 'publication_date', 'html_url'],
  per_page: 5,
  order: 'newest',
});
```

…then answers in plain English, citing the section and the rules it found.

## Features

- **Two official sources, one server** — the full Federal Register v1 (`fr.*`) and eCFR (`ecfr.*`) APIs behind one tool.
- **Code mode, not tool sprawl** — the model writes TypeScript against typed `fr` / `ecfr` SDKs instead of juggling dozens of single-purpose tools.
- **Safe by construction** — user code runs in an `isolated-vm` (or Deno) sandbox with **no network, filesystem, env, or subprocess access**. The only way out is the two government APIs.
- **Runs anywhere MCP does** — stdio for Claude Desktop, or a remote Streamable HTTP server with OAuth, rate limiting, and quotas.
- **Discovery built in** — `search_api` and `describe_schema` help the model (and you) find the right call fast.

## Quickstart (Claude Desktop)

Add the server to your Claude Desktop config (**Settings → Developer → Edit Config**):

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

Restart Claude Desktop, then just ask in plain language:

> *"Find EPA methane rules published since 2024."*
> *"What does 40 CFR Part 60 cover?"*
> *"Which proposed rules opened for public comment this week?"*

Requires **Node.js ≥ 20.10**. `npx` downloads and runs the server on demand; no global install needed. If the `execute` tool reports `SandboxUnavailable`, see [Sandbox runtimes](#sandbox-runtimes).

## How it works

Three tools, in the order the model uses them:

| Tool | What it does |
|---|---|
| `search_api(query, k?)` | Finds the right endpoint/field via BM25 over the SDK docs. Returns ready-to-run TypeScript snippets. |
| `describe_schema({ path? \| prefix? })` | Looks up an exact call or lists a whole namespace. |
| `execute({ code, timeoutMs?, memoryMb? })` | Runs TypeScript in the sandbox, with `fr` and `ecfr` as globals. |

A request flows from the MCP client through `execute` into the sandbox; the `fr.*` / `ecfr.*` globals are thin proxies that marshal each call across a host-side RPC bridge to the real APIs:

```text
MCP client → execute(code) → sandbox → fr.* / ecfr.* RPC bridge → upstream APIs
```

Full SDK surface: [`docs/sdk-reference.md`](./docs/sdk-reference.md) · Architecture: [`docs/architecture.md`](./docs/architecture.md) · Paste-ready examples: [`examples/`](./examples/).

## Sandbox runtimes

`execute` needs a sandbox runner. The server picks one automatically:

1. **`isolated-vm`** (preferred) — a fresh V8 isolate. Built automatically during install on Linux/macOS/Windows (x64/arm64) where a C++ toolchain is present.
2. **Deno** (fallback) — used when `isolated-vm` isn't available and `deno` is on `PATH`.
3. If neither is available, `search_api` and `describe_schema` still work; `execute` returns `SandboxUnavailable`.

> On very new Node majors, `isolated-vm` may not have a compatible prebuild yet. Install [Deno](https://docs.deno.com/runtime/getting_started/installation/) and run with `--sandbox deno` (or `FEDREG_SANDBOX=deno`). Node 20 and 22 build `isolated-vm` cleanly.

## Self-hosting (remote HTTP)

Run a shared, authenticated endpoint over Streamable HTTP:

```bash
# Dev only — no auth:
npx @blen/fedreg-mcp-server --http --insecure --port 8080

# Production — auth via any OIDC issuer:
FEDREG_AUTH_PROVIDER=clerk \
FEDREG_AUTH_ISSUER=https://<tenant>.clerk.accounts.dev \
FEDREG_AUTH_JWKS_URL=https://<tenant>.clerk.accounts.dev/.well-known/jwks.json \
FEDREG_PUBLIC_ORIGIN=https://your-host.example.com \
FEDREG_ALLOWED_HOSTS=your-host.example.com \
  npx @blen/fedreg-mcp-server --http
```

Then point any MCP client at it:

```json
{ "mcpServers": { "fedreg": { "type": "http", "url": "https://your-host.example.com/mcp" } } }
```

The HTTP transport adds OAuth 2.0 Protected Resource Metadata (RFC 9728), per-IP rate limiting, per-subject daily quotas, and Host-header allowlisting. A one-command Railway walkthrough is in [`deploy/RAILWAY.md`](./deploy/RAILWAY.md); the bundled [`Dockerfile`](./deploy/Dockerfile) precompiles `isolated-vm` and slims to a ~220 MB `node:22-bookworm-slim` runtime.

### Configuration

The most common knobs (full list and defaults in [`.env.example`](./.env.example)):

| Variable | Default | Notes |
|---|---|---|
| `FEDREG_SANDBOX` | `auto` | `auto` / `isolate` / `deno` |
| `FEDREG_USER_AGENT` | `fedreg-mcp-server/1.0 …` | Identify yourself, per FR/eCFR etiquette. |
| `FEDREG_AUTH_PROVIDER` | `none` | `none` / `embedded` / `generic-oidc` / `clerk` / `workos` / `auth0` |
| `FEDREG_PUBLIC_ORIGIN` | — | Public origin clients reach (used in OAuth metadata). |
| `FEDREG_SUBJECT_DAILY_QUOTA` | `10000` | Requests per authenticated subject per UTC day. |

CLI options: `--http`, `--port`, `--host`, `--sandbox auto|isolate|deno`, `--insecure`, `--help`.

## Security

User code is sandboxed by design — no network, filesystem, env, or subprocess access, an `acorn` AST preflight, a wall-clock timeout, and a heap cap. The full threat model is in [`SECURITY.md`](./SECURITY.md). Found a sandbox escape or auth bypass? Please open a [private Security Advisory](https://github.com/blen-labs/fedreg-mcp-server/security/advisories/new) rather than a public issue.

## Contributing

Contributions are welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the dev setup and ground rules, and please open an issue before anything non-trivial. By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[Apache-2.0](./LICENSE) © 2026 BLEN, Inc. See also [`NOTICE`](./NOTICE).

## Acknowledgements

- The U.S. Government Publishing Office and the National Archives for publishing the Federal Register and eCFR APIs.
- The [Model Context Protocol](https://modelcontextprotocol.io) team for the spec and TypeScript SDK.
- The teams who popularized the code-mode pattern for wide APIs.

---

## About BLEN

BLEN, Inc is a digital services company that provides Emerging Technology (ML/AI, RPA), Digital Modernization (Legacy to Cloud), and Human-Centered Web/Mobile Design and Development.

Built with ❤️ by [BLEN, Inc](https://www.blenlabs.com).