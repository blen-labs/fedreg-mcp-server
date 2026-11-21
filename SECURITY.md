# Security Policy

## Reporting a vulnerability

Please **do not file public GitHub issues for security reports**. Instead,
open a private GitHub Security Advisory:

> <https://github.com/blen-labs/fedreg-mcp-server/security/advisories/new>

If that's not available, contact the maintainers via the GitHub organization
page at <https://github.com/blen-labs>.

We try to respond within **3 business days**. A typical timeline for a
confirmed sandbox-escape report:

1. Initial acknowledgement and severity triage — within 3 business days.
2. Coordinated fix in a private branch — within 14 days for critical, 30 for
   high-severity issues.
3. Patched release published to npm with a credit line (unless you ask not
   to be credited).
4. Public advisory and CVE filing once users have had reasonable upgrade time.

## Scope

In scope:
- **Sandbox escapes** — any code in `execute` that gets host filesystem,
  network, environment, subprocess, native binding, or out-of-isolate
  references.
- **AST preflight bypasses** — code that passes `preflight()` in
  `src/sandbox/policy.ts` but performs disallowed operations at runtime.
- **Auth bypass** — sending requests to `/mcp` (or `/mcp/account` in account
  mode) without a valid bearer that reaches a tool handler, or reaching `/mcp/account`
  without signing in. (Account mode's anonymous `/mcp` is public by design: see the
  threat model.)
- **Key exposure** — any way for sandboxed code, logs, results or errors to reveal
  the regulations.gov API key, or for one user's key to serve another user's calls.
- **Resource bounds** — an execution that outlives its deadline, leaves a process
  behind, or makes the host buffer more than the documented byte budgets.
- **DNS rebinding / SSRF** against the HTTP transport.
- **Quota / rate-limit bypass** that allows a single subject or IP to exceed
  the configured ceiling.

Out of scope (please file a normal issue instead):
- Upstream API rate limits (those are FederalRegister.gov / eCFR /
  regulations.gov limits; see the `FEDREG_REGS_*` and `FEDREG_UPSTREAM_*` guardrails in the README).
- Denial of service via lawful but expensive queries (we accept this risk
  on a per-tenant basis; tune `FEDREG_SUBJECT_DAILY_QUOTA` and
  `FEDREG_IP_RPS`).
- Issues that only occur with `--insecure` (which is documented as dev-only).

## Sandbox guarantees

The `execute` tool runs user-supplied JavaScript with layered defenses:

1. **AST preflight** (`acorn` + `acorn-walk`, see `src/sandbox/policy.ts`):
   rejects `import` / `import()` / `eval` / `new Function` and references to
   `process`, `globalThis`, `Buffer`, `Deno`, `fetch`, `Worker`, plus
   `__proto__` / `constructor` / `prototype` member access. The check rejects
   *static* uses of these names; runtime synthesis (e.g. via string
   concatenation) is the next layer's job. It reads the code both as a module
   and as a script, because the two grammars treat HTML-like comments
   differently, and it rejects code that closes the function that wraps it.
2. **Runtime isolation** — one of:
   - `isolated-vm`: a fresh V8 isolate per execution, **no host references**
     other than a Reference to the RPC dispatcher and a log sink for `console.*`;
     heap cap; a host-owned wall-clock deadline (started before setup, covering
     never-settling promises) disposes the isolate. It runs inside the server
     process, so it is used only for single-user operation (stdio, `--insecure`).
   - Deno: `deno run --no-prompt --no-config --no-lock --no-remote --no-npm` of a
     fixed supervisor script with **no `--allow-*` flags** (no net/fs/env/ffi/
     subprocess access) and a minimal environment. User code arrives by message
     (it is never written to disk) and runs as a module in a Worker. Before it
     runs, the worker deletes every global that is not part of the language
     (`Deno`, `fetch`, `Worker`, `process`, `postMessage`, …) and refuses to run
     if one stays, so a program gets the language's globals, `console` and the SDK
     bindings. V8 builds no code from strings in this process (`eval` and
     `Function` throw). Frames to the host are prefixed with a random token the worker
     never sees; all other output is untrusted text. The host owns the deadline,
     kills the process group, and waits for the child to exit before releasing the
     execution. The heap flag does not count buffers, so the supervisor also ends
     the process when its resident memory has grown by more than twice `memoryMb`
     plus 96 MiB during an execution. It checks every 5 ms, so a program can pass
     that bound by what it writes in one interval.
     **Authenticated HTTP serving uses only this runner** (an
     in-process runner is refused there, with no fallback).
3. **Byte budgets** (`src/sandbox/limits.ts`): code 256 KiB, result 8 MiB,
   logs 1 MiB / 10,000 lines, SDK-call arguments 1 MiB, 100 pending calls. Executions are capped per server and per
   subject, and are aborted when the client cancels or disconnects.

Both runners deny network access to user code; the only way to reach
upstream APIs is via the `fr.*` / `ecfr.*` / `regs.*` proxies, which serialize
calls through a host-side RPC and execute them against the configured base URLs
(`FEDREG_FR_BASE_URL`, `FEDREG_ECFR_BASE_URL`, `FEDREG_REGS_BASE_URL`).

The dispatcher resolves exact method names from each source's explicit, frozen
`methods` table. It never traverses the host client object or inherited
properties. Only the registered read methods are callable; HTTP clients,
caches, and other host internals are outside the RPC surface. New SDK methods
must be explicitly registered before sandboxed code can call them.

The regulations.gov API key (`FEDREG_REGS_API_KEY`, and in account mode each user's
saved key) is held host-side in the `HttpClient` and is **never exposed to sandboxed
user code**: it is injected into the upstream request on the host side of the RPC
bridge, not passed into the sandbox, so user code cannot read or exfiltrate it. In
account mode, if an upstream echoes a user's key back, it is replaced with
`[REDACTED]` in error messages and in decoded results. Account mode never uses one
user's key for another user's calls.

We treat any of the following as a vulnerability:
- Reading the contents of any file under `/`.
- Establishing any outbound socket to a host not configured in the SDK.
- Reading process environment variables.
- Reading or modifying host globals (this includes obtaining `globalThis`,
  `Reflect`, `Function`, `eval`, or any constructor reachable from them).
- Causing the host process to crash, or an execution (or its child process) to
  outlive `timeoutMs` plus a few seconds.
- Forging the result of an execution or of an SDK call from sandboxed code in a
  way the host accepts as protocol data.

## Threat model

This server is designed to be exposed to **untrusted MCP clients** behind
authentication: personal accounts (Google sign-in + OAuth/PKCE, account mode) or
an external OIDC issuer (Clerk / WorkOS / Auth0 / generic OIDC) verified via JWKS
with required issuer, audience, expiry, subject and scopes. It fails closed: `--http`
without real authentication refuses to start, and an unknown provider stops
startup. The HTTP transport checks `Host` against configured names (DNS rebinding;
the trusted origin is never taken from the request), validates browser `Origin`s,
caps request bodies at 1 MiB, and adds per-IP token-bucket rate limiting and
per-subject daily quotas.

The only unauthenticated public surface by design is account mode's `/mcp`, which
serves the Federal Register and the eCFR (public data that needs no key) and
regulations.gov only through the operator's `FEDREG_REGS_API_KEY`, if one is set.
`--insecure` disables authentication for local development and binds to
`127.0.0.1` by default; operators who expose it publicly opt out of all auth-layer
protections and accept the resulting risk.

## Dependencies

We track advisories on direct runtime dependencies — `@modelcontextprotocol/server`,
`@modelcontextprotocol/node`, `undici`, `jose`, `acorn`, `lru-cache`, `zod`,
`express`, `better-auth`, `pg`, and the optional `isolated-vm` — plus the Deno
runtime pinned in the Docker image. CI fails on any known advisory
(`pnpm audit --audit-level moderate`, dev dependencies included), and Dependabot
proposes updates weekly. For an advisory that affects this server, expect a patch
release within the timeline above.
