# Federal Regulations MCP

[![CI](https://github.com/blen-labs/fedreg-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/blen-labs/fedreg-mcp-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@blen/fedreg-mcp-server.svg)](https://www.npmjs.com/package/@blen/fedreg-mcp-server)
[![license: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-24%20%7C%2026-339933.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-7c3aed.svg)](https://modelcontextprotocol.io/specification/2026-07-28)

<p align="center">
  <video src="https://github.com/blen-labs/fedreg-mcp-server/raw/main/media/fedreg-launch.mp4" poster="https://raw.githubusercontent.com/blen-labs/fedreg-mcp-server/main/media/launch-poster.png" controls muted playsinline width="760"></video>
</p>

**Ask your AI assistant real questions about U.S. federal regulations — and get answers grounded in the official Federal Register, eCFR and regulations.gov.**

**Documentation:** [fedreg.mcp.blenlabs.com/docs](https://fedreg.mcp.blenlabs.com/docs/) has connect buttons for Claude Desktop, Cursor and VS Code, key setup, recipes, and the SDK reference.

This is a [Model Context Protocol](https://modelcontextprotocol.io) server that connects any MCP client (Claude Desktop and others) to three official U.S. government sources:

- **[Federal Register](https://www.federalregister.gov)** — the daily journal of the federal government: rules, proposed rules, notices, presidential documents and public inspection documents since 1994.
- **[Electronic Code of Federal Regulations (eCFR)](https://www.ecfr.gov)** — the current, continuously updated text of the Code of Federal Regulations, its structure and its history.
- **[regulations.gov](https://www.regulations.gov)** — public comments, dockets and live comment-period status for federal rulemakings.

Instead of bolting on dozens of rigid, narrow tools, it hands the model a small, well-documented SDK and lets it write the exact query it needs in JavaScript — then runs that code in a locked-down sandbox. This is the **code-mode** pattern, and it makes wide government APIs usable without overwhelming the model with tool definitions.

> Independent open-source project. It calls public U.S. government APIs and is not affiliated with or endorsed by the U.S. government.

## API keys

Only regulations.gov needs a key. It is free, and it is yours alone: do not share it. The key is held host-side and never reaches the sandbox.

| Source | Key | How to get it | Env var |
|---|---|---|---|
| `fr` | None | — | — |
| `ecfr` | None | — | — |
| `regs` | A free api.data.gov key | Sign up in the **Getting Started** section of the [regulations.gov API page](https://open.gsa.gov/api/regulationsgov/) | `FEDREG_REGS_API_KEY` |

api.data.gov applies a default limit of 1,000 requests per hour to each key. Without a key, `regs` is **disabled**: its global still exists in the sandbox, but calls return a `SourceUnavailable` error that says how to get one, while `fr` and `ecfr` keep working.

## Quickstart (Claude Desktop)

Add the server to your Claude Desktop config (**Settings → Developer → Edit Config**):

```json
{
  "mcpServers": {
    "fedreg": {
      "command": "npx",
      "args": ["-y", "@blen/fedreg-mcp-server"],
      "env": {
        "FEDREG_REGS_API_KEY": "your-regulations-gov-key"
      }
    }
  }
}
```

The `env` block is optional: leave it out to use only the Federal Register and the eCFR. Restart Claude Desktop, then ask in plain language:

> *"Find EPA methane rules published since 2024."*
> *"What does 40 CFR Part 60 cover?"*
> *"Which proposed rules opened for public comment this week?"*

Requires **Node.js 24 or 26** (LTS). `npx` downloads and runs the server on demand. If `execute` reports `SandboxUnavailable`, see [Sandbox runtimes](#sandbox-runtimes). A Claude Desktop extension bundle (`.mcpb`) that asks for the key at install time is attached to each [GitHub release](https://github.com/blen-labs/fedreg-mcp-server/releases) and built from this repository (`pnpm mcpb:prepare && pnpm mcpb:pack`).

## See it in action

> *"What does 50 CFR 21.150 cover, and which recent Federal Register rules changed 50 CFR part 21?"*

The model finds the right calls with `search_api` and runs them in the sandbox — no hand-written tool per endpoint. This is [`examples/ecfr-section.js`](./examples/ecfr-section.js), which the test suite runs in the sandbox:

```js
// Paste into the `execute` tool. The current text of one eCFR section, plus the newest
// Federal Register rules that affect the same part, so an answer can cite both.

// 1. The eCFR is versioned by date: ask for the title's latest issue date, then that day's section.
const { titles } = await ecfr.titles.list();
const date = titles.find(t => t.number === 50).latest_issue_date;
const xml = await ecfr.full(date, 50, { part: '21', section: '21.150' });

// 2. The newest Federal Register rules and proposed rules that affect the same CFR part.
const rules = await fr.documents.search({
  conditions: { cfr: { title: 50, part: 21 }, type: ['RULE', 'PRORULE'] },
  fields: ['document_number', 'title', 'publication_date', 'html_url'],
  per_page: 3,
  order: 'newest',
});

// 3. Return a bounded result: the section as plain text (the full XML can be large) and the rules.
return {
  section: {
    citation: '50 CFR 21.150',
    asOf: date,
    url: 'https://www.ecfr.gov/current/title-50/section-21.150',
    text: xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240),
  },
  rules: rules.results,
};
```

It returns this (a real run on 2026-11-26 against the eCFR and Federal Register APIs, public-domain U.S. government data; the rule list changes as new rules are published):

```json
{
  "section": {
    "citation": "50 CFR 21.150",
    "asOf": "2026-11-17",
    "url": "https://www.ecfr.gov/current/title-50/section-21.150",
    "text": "§ 21.150 Depredation order for blackbirds, cowbirds, crows, grackles, and magpies. (a) Species covered. Blackbirds Cowbirds Crows Grackles Magpies Brewer's (Euphagus cyanocephalus) Bronzed ( Molothrus aeneus ) American (Corvus brachyrhyncho"
  },
  "rules": [
    {
      "document_number": "2026-20123",
      "title": "General Provisions; Revised List of Birds Protected by the Migratory Bird Treaty Act",
      "publication_date": "2026-10-01",
      "html_url": "https://www.federalregister.gov/documents/2026/10/01/2026-20123/general-provisions-revised-list-of-birds-protected-by-the-migratory-bird-treaty-act"
    },
    {
      "document_number": "2025-06782",
      "title": "Migratory Bird Permits; Authorizing the Incidental Take of Migratory Birds; Withdrawal",
      "publication_date": "2025-04-21",
      "html_url": "https://www.federalregister.gov/documents/2025/04/21/2025-06782/migratory-bird-permits-authorizing-the-incidental-take-of-migratory-birds-withdrawal"
    },
    {
      "document_number": "2024-31015",
      "title": "Regulatory Authorizations for Migratory Bird and Eagle Possession by the General Public, Educators, and Government Agencies",
      "publication_date": "2024-12-31",
      "html_url": "https://www.federalregister.gov/documents/2024/12/31/2024-31015/regulatory-authorizations-for-migratory-bird-and-eagle-possession-by-the-general-public-educators"
    }
  ]
}
```

…then the model answers in plain English, citing the section and the rules it found. More programs, including one that matches nothing, are in the [recipes](https://fedreg.mcp.blenlabs.com/docs/recipes/).

## What's covered

| Need | Call |
|---|---|
| Rules, proposed rules, notices and presidential documents since 1994 | `fr.documents.search` / `get` / `getMany` |
| Documents on public inspection, before they are published | `fr.publicInspection.*` |
| Agencies, issues, suggested searches, images | `fr.agencies.*`, `fr.issues.*`, `fr.suggestedSearches.*`, `fr.images.*` |
| The current text of the Code of Federal Regulations, and its structure | `ecfr.full`, `ecfr.titles.*` and the versioned structure and content calls |
| eCFR search, with counts per agency or title | `ecfr.search.*` |
| Dockets, documents and public comments on regulations.gov | `regs.dockets.*`, `regs.documents.*`, `regs.comments.*` |

For canonical Federal Register rule text and metadata since 1994, prefer `fr.documents`: regulations.gov documents overlap it. Reach for `regs` when you need what only it has: public **comments**, **dockets** and live comment-period status. `frDocNum` is a *returned* attribute of regs documents, not a filter, so bridge from the Federal Register to regulations.gov by passing the document number as a `searchTerm`; [`examples/regs-comments.js`](./examples/regs-comments.js) shows the whole bridge.

Full surface: [`docs/sdk-reference.md`](./docs/sdk-reference.md).

## How it works

Three tools, in the order the model uses them:

| Tool | What it does |
|---|---|
| `search_api(query, k?)` | BM25 over the SDK method docs and a response-field dictionary. Returns signatures and ready-to-run JavaScript. |
| `describe_schema({ path? \| prefix? })` | Looks up an exact entry (`fr.documents.search`) or lists a namespace (`regs.`). |
| `execute({ code, timeoutMs?, memoryMb? })` | Runs JavaScript (no type annotations; top-level `await`/`return` allowed) in the sandbox with `fr`, `ecfr` and `regs` as globals. `timeoutMs` defaults to 15 s (max 60 s). |

All three are annotated read-only and non-destructive (`execute` is also `openWorldHint: true`) and publish an `outputSchema`. Results come back as compact JSON text plus the same object as `structuredContent`. A failed execution (thrown error, timeout, limit) is returned with `isError: true` and the full envelope — `{ ok: false, error: { name, message, status? }, logs, durationMs }` — so the model sees what went wrong.

```text
MCP client → execute(code) → sandbox → fr.* / ecfr.* / regs.* RPC bridge → host HttpClient (key, gate, cache) → federalregister.gov / ecfr.gov / api.regulations.gov
```

Architecture: [`docs/architecture.md`](./docs/architecture.md) · Paste-ready examples: [`examples/`](./examples/).

### Rate limits and guardrails

The Federal Register and the eCFR see every user of a server as one client, and regulations.gov limits each key. So the server:

- shares one gate per public API (Federal Register, eCFR) across all users: 8 requests in flight and 10 started per second, and a call that waits more than 15 s for a slot fails with `RateLimited`;
- on a `429` from the Federal Register or eCFR, pauses every caller of that API and retries the call once after the `Retry-After` (at most 5 s); a `429` from regulations.gov is returned at once (`RateLimited`), never retried;
- caps upstream calls per `execute()`: 100 for the Federal Register and the eCFR together (`CallBudgetExceeded`), 30 for regulations.gov (`RegsCallBudgetExceeded`);
- paces regulations.gov for each key: the operator's shared key gets a token bucket that holds 1,000 calls and refills at 1,000 an hour (`RegsRateLimited` when empty), so a busy hour can briefly pass api.data.gov's 1,000-per-hour limit and get a `429`; each authenticated subject also gets 500 calls per hour (one shared `anonymous` subject under `--insecure`; stdio skips it). In account mode each account's own key instead gets a fixed hourly window of 1,000 calls, kept in PostgreSQL, and the per-subject quota does not apply;
- caches responses for 5 minutes, so repeated questions do not spend quota;
- rejects results over 8 MiB returned from `execute` (`ResultTooLarge`): use `fields` and `per_page` to keep records small.

These guardrails are in memory (except account mode's per-account window, which is in PostgreSQL), so run **one replica**; with more, divide the hourly rates by the replica count.

## Personal accounts (hosted mode)

`FEDREG_AUTH_PROVIDER=accounts` adds Google sign-in, an `/account` page where each user saves their own regulations.gov key (checked against regulations.gov, encrypted in PostgreSQL, never shown again), and OAuth/PKCE connections at `/mcp/account`. Each signed-in user's regulations.gov calls use only that user's own key. The anonymous `/mcp` endpoint needs no sign-in and serves the Federal Register and the eCFR, and regulations.gov only through the operator's `FEDREG_REGS_API_KEY`, if one is set. See [docs/accounts.md](docs/accounts.md).

## Sandbox runtimes

`execute` needs a sandbox runner:

1. **`isolated-vm`** — a fresh V8 isolate per execution, with a heap cap and a host-enforced deadline. `isolated-vm` 7 ships prebuilt binaries for Node 24 and 26, so no compiler is needed. Preferred for single-user use (stdio, `--insecure` local HTTP).
2. **Deno** — user code runs in a separate `deno` process with no permissions (no network, files, env or subprocesses), inside a Worker stripped of `Deno`, `fetch` and messaging globals; the server owns the deadline and kills the process group. Install [Deno](https://docs.deno.com/runtime/getting_started/installation/) and it is used when `isolated-vm` is unavailable, or always with `--sandbox deno` (`FEDREG_SANDBOX=deno`).
3. **Authenticated HTTP serving** (OIDC or accounts) runs user code **only** in the Deno runner — a separate, killable process per execution. `--sandbox isolate` is refused there, and without Deno, `execute` reports `SandboxUnavailable` instead of falling back to in-process execution.
4. If no runner is available, `search_api` and `describe_schema` still work; `execute` returns `SandboxUnavailable`.

Every execution is bounded: code 256 KiB, returned value 8 MiB (`ResultTooLarge`), logs 1 MiB / 10,000 lines, SDK-call arguments 1 MiB, 100 calls pending at once. At most 8 executions run at once per server and 2 per authenticated subject (`FEDREG_MAX_CONCURRENT_EXECUTIONS`, `FEDREG_MAX_EXECUTIONS_PER_SUBJECT`); a client that cancels or disconnects stops its execution and any upstream calls in flight. Each upstream response is also bounded in memory, compressed and decompressed: 16 MiB for the Federal Register and regulations.gov, 192 MiB for eCFR (Title 40, the largest full-text title, is about 157 MB). A larger response fails with `ResponseTooLarge`; it is never truncated.

## Self-hosting (remote HTTP)

```bash
# Local, single user, no auth (binds 127.0.0.1 unless HOST/--host says otherwise).
# Replace your-regulations-gov-key, or drop that variable to leave `regs` off.
FEDREG_REGS_API_KEY="your-regulations-gov-key" npx @blen/fedreg-mcp-server --http --insecure --port 8080

# Your own server, authenticated via an OIDC issuer (your regulations.gov key serves every
# token holder). Issuer, audience and an https JWKS URL are all required; Deno must be installed.
# Replace your-regulations-gov-key, your-tenant (your Clerk instance) and your-host.example.com.
FEDREG_REGS_API_KEY="your-regulations-gov-key" \
FEDREG_AUTH_PROVIDER=clerk \
FEDREG_AUTH_ISSUER="https://your-tenant.clerk.accounts.dev" \
FEDREG_AUTH_AUDIENCE="https://your-host.example.com/mcp" \
FEDREG_AUTH_JWKS_URL="https://your-tenant.clerk.accounts.dev/.well-known/jwks.json" \
FEDREG_PUBLIC_ORIGIN="https://your-host.example.com" \
  npx @blen/fedreg-mcp-server --http
```

Then point any MCP client at it:

```json
{ "mcpServers": { "fedreg": { "type": "http", "url": "https://your-host.example.com/mcp" } } }
```

The HTTP transport implements the stateless MCP `2026-07-28` Streamable HTTP profile — no `initialize` handshake and no `Mcp-Session-Id` — with a stateless legacy fallback for pre-2026 clients. It fails closed:

- `--http` without `--insecure` refuses to start unless real authentication is configured (an OIDC provider, or `accounts`). OIDC tokens must carry the configured issuer and audience, an expiry and a subject, use an asymmetric algorithm, and hold every scope in `FEDREG_AUTH_SCOPES` (otherwise `403 insufficient_scope`).
- Listening on anything but loopback requires `FEDREG_PUBLIC_ORIGIN` or `FEDREG_ALLOWED_HOSTS` (with authentication, `FEDREG_PUBLIC_ORIGIN` specifically, because OAuth metadata must name the URL clients connect to): every request's `Host` must match the configured names (DNS-rebinding protection); the trusted origin is never taken from the request. Browser `Origin`s other than the server's own, loopback, or `FEDREG_ALLOWED_ORIGINS` get `403`.
- Request bodies are capped at 1 MiB.

It also serves OAuth 2.0 Protected Resource Metadata (RFC 9728), per-IP rate limiting and per-subject daily quotas. A Railway walkthrough is in [`deploy/RAILWAY.md`](./deploy/RAILWAY.md); the [`Dockerfile`](./deploy/Dockerfile) runs on Node 26 (LTS) with Deno included.

### Configuration

The knobs below are every environment variable the server reads at startup (defaults and notes also in [`.env.example`](./.env.example); `FEDREG_LOG_LEVEL`, `debug` | `info` | `warn` | `error`, sets the log level; account mode reads more, see [docs/accounts.md](docs/accounts.md)):

| Variable | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | HTTP listener (`--port`, `--host`). `--insecure` binds `127.0.0.1` unless a host is given. |
| `FEDREG_SANDBOX` | `auto` | `auto` / `isolate` / `deno` |
| `FEDREG_FR_BASE_URL` | `https://www.federalregister.gov/api/v1` | Federal Register API base URL. |
| `FEDREG_ECFR_BASE_URL` | `https://www.ecfr.gov/api` | eCFR API base URL. |
| `FEDREG_REGS_BASE_URL` | `https://api.regulations.gov` | regulations.gov v4 API base URL. |
| `FEDREG_REGS_API_KEY` | — | Free key from regulations.gov / api.data.gov. Unset ⇒ `regs` disabled (`fr` and `ecfr` unaffected). In account mode it serves only the anonymous `/mcp` endpoint. |
| `FEDREG_USER_AGENT` | `fedreg-mcp-server/2.0 (+https://github.com/blen-labs/fedreg-mcp-server)` | Identify your deployment to the upstream APIs. |
| `FEDREG_UPSTREAM_TIMEOUT_MS` | `20000` | Timeout of one upstream request. |
| `FEDREG_UPSTREAM_RETRIES` | `3` | Retries for network errors and 5xx. |
| `FEDREG_UPSTREAM_CONCURRENCY` | `8` | Federal Register / eCFR requests in flight, per API, shared by all users. Must be ≥ 1. |
| `FEDREG_UPSTREAM_RATE_PER_SEC` | `10` | Federal Register / eCFR requests started per second, per API. Must be ≥ 1. |
| `FEDREG_UPSTREAM_MAX_WAIT_MS` | `15000` | Longest a call waits for a slot before failing with `RateLimited`. Must be ≥ 1. |
| `FEDREG_PUBLIC_MAX_CALLS_PER_EXECUTE` | `100` | Federal Register + eCFR calls per `execute()` (`CallBudgetExceeded`). Must be ≥ 1. |
| `FEDREG_REGS_MAX_CALLS_PER_EXECUTE` | `30` | regulations.gov calls per `execute()` (`RegsCallBudgetExceeded`). `0` blocks every regs call. |
| `FEDREG_REGS_RATE_PER_HOUR` | `1000` | regs pacing per key: the shared key's token bucket (capacity and hourly refill), and each account's hourly window in account mode. Must be ≥ 1. `0` is not "unlimited"; unset the key to disable regs. |
| `FEDREG_REGS_SUBJECT_RATE_PER_HOUR` | `500` | Per authenticated subject per hour (HTTP only; not applied in account mode, which limits per account in PostgreSQL). Must be ≥ 1. |
| `FEDREG_CACHE_TTL_MS` / `FEDREG_CACHE_MAX_ITEMS` | `300000` / `2000` | Response cache. |
| `FEDREG_MAX_CONCURRENT_EXECUTIONS` / `FEDREG_MAX_EXECUTIONS_PER_SUBJECT` | `8` / `2` | Simultaneous executions per server / per authenticated subject (`Busy` beyond). Must be ≥ 1. |
| `FEDREG_AUTH_PROVIDER` | `none` | `none` (stdio, or HTTP with `--insecure`) / `generic-oidc` / `clerk` / `workos` / `auth0` / `accounts`. Unknown values stop startup. The OIDC providers serve every token holder with this server's own regulations.gov key, so use them only for yourself; to host for other people use `accounts`, where each user brings their own key. |
| `FEDREG_AUTH_ISSUER` / `FEDREG_AUTH_AUDIENCE` / `FEDREG_AUTH_JWKS_URL` | — | Required for OIDC providers (JWKS over https; http only on loopback). |
| `FEDREG_AUTH_SCOPES` | — | Comma-separated scopes every token must carry. |
| `FEDREG_PUBLIC_ORIGIN` | — | Public origin clients reach (OAuth metadata, trusted Host). Required for authenticated non-loopback HTTP; otherwise `FEDREG_ALLOWED_HOSTS` can replace it. |
| `FEDREG_ALLOWED_HOSTS` | — | Extra accepted `Host` values (comma-separated). |
| `FEDREG_ALLOWED_ORIGINS` | — | Extra browser `Origin`s allowed on `/mcp` (comma-separated exact origins). |
| `FEDREG_IP_RPS` / `FEDREG_IP_BURST` | `5` / `20` | Per-IP token bucket on the HTTP transport. |
| `FEDREG_CLIENT_IP_HEADER` | unset | Header your proxy overwrites with the client address (Railway: `x-real-ip`). |
| `FEDREG_AUTH_LOCK_POOL_SIZE` | `10` | Accounts mode: connections per replica reserved for OAuth token locks (2 to 200); see [docs/accounts.md](docs/accounts.md#oauth-token-locks-and-request-budgets). |
| `FEDREG_SUBJECT_DAILY_QUOTA` | `10000` | Requests per authenticated subject per UTC day. |
| `RAILWAY_GIT_COMMIT_SHA` | set by Railway | The commit Railway built (GitHub-sourced deployments); `/health` reports it as `commit`, or `null` when unset or not a full SHA. Do not set it yourself. |

CLI options: `--http`, `--port`, `--host`, `--sandbox auto|isolate|deno`, `--insecure`, `--rotate-keys` (account mode: re-encrypt stored keys, see [docs/accounts.md](docs/accounts.md#encryption-rotation)), `--help`.

## Security

User code is sandboxed by design — no network, filesystem, env, or subprocess access, an `acorn` AST preflight, a host-enforced wall-clock deadline, byte budgets, and a V8 heap cap. The regulations.gov key stays in the host process and never appears on the objects the sandbox can see. The threat model is in [`SECURITY.md`](./SECURITY.md). Found a sandbox escape or auth bypass? Please open a [private Security Advisory](https://github.com/blen-labs/fedreg-mcp-server/security/advisories/new) rather than a public issue.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the dev setup and ground rules, and please open an issue before anything non-trivial. For questions and help, see [`SUPPORT.md`](./SUPPORT.md). By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[Apache-2.0](./LICENSE) © 2026 BLEN, Inc. See also [`NOTICE`](./NOTICE).

## Hosted service policies

The BLEN-hosted connector's [Privacy Policy](./legal/privacy-policy.md) and
[Terms of Service](./legal/terms.md) describe data handling and conditions of
use. The software remains licensed under Apache-2.0; self-hosted operators
are responsible for their own policies.

## Acknowledgements

- The U.S. Government Publishing Office and the National Archives for publishing the Federal Register and eCFR APIs, and the General Services Administration for regulations.gov and api.data.gov.
- The [Model Context Protocol](https://modelcontextprotocol.io) team for the spec and TypeScript SDK.
- The teams who popularized the code-mode pattern for wide APIs.

## For teams

Want an MCP server for your team's or agency's data, or help running this one? [Talk to BLEN](https://www.blencorp.com/mcp).

---

Built with ❤️ by [BLEN](https://www.blencorp.com).
