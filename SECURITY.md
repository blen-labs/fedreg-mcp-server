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
- **Auth bypass** — sending requests to `/mcp` without a valid bearer that
  reaches a tool handler.
- **DNS rebinding / SSRF** against the HTTP transport.
- **Quota / rate-limit bypass** that allows a single subject or IP to exceed
  the configured ceiling.

Out of scope (please file a normal issue instead):
- Upstream API rate limits (those are FederalRegister.gov / eCFR limits).
- Denial of service via lawful but expensive queries (we accept this risk
  on a per-tenant basis; tune `FEDREG_SUBJECT_DAILY_QUOTA` and
  `FEDREG_IP_RPS`).
- Issues that only occur with `--insecure` (which is documented as dev-only).

## Sandbox guarantees

The `execute` tool runs user-supplied TypeScript with two layered defenses:

1. **AST preflight** (`acorn` + `acorn-walk`, see `src/sandbox/policy.ts`):
   rejects `import` / `import()` / `eval` / `new Function` and references to
   `process`, `globalThis`, `Buffer`, `Deno`, `fetch`, `Worker`, plus
   `__proto__` / `constructor` / `prototype` member access. The check rejects
   *static* uses of these names; runtime synthesis (e.g. via string
   concatenation) is the next layer's job.
2. **Runtime isolation** — one of:
   - `isolated-vm`: a fresh V8 isolate, **no host references** other than
     a single Reference to the RPC dispatcher; heap cap, wall-clock cap.
   - `deno run --no-prompt <runner>`: subprocess with **no `--allow-*` flags**,
     so no net/fs/env/ffi/subprocess access; wall-clock cap. The runner is a
     temporary file so stdin stays free for the host RPC channel.

Both runners deny network access to user code; the only way to reach
upstream APIs is via the `fr.*` / `ecfr.*` proxies, which serialize calls
through a host-side RPC and execute them against the configured URL
allowlist (`FEDREG_FR_BASE_URL`, `FEDREG_ECFR_BASE_URL`).

We treat any of the following as a vulnerability:
- Reading the contents of any file under `/`.
- Establishing any outbound socket to a host not configured in the SDK.
- Reading process environment variables.
- Reading or modifying host globals (this includes obtaining `globalThis`,
  `Reflect`, `Function`, `eval`, or any constructor reachable from them).
- Causing the host process to crash or hang past `timeoutMs * 2`.

## Threat model

This server is designed to be exposed to **untrusted MCP clients** behind
an authenticated edge. Authentication is provided by an external OIDC issuer
(Clerk / WorkOS / Auth0 / generic OIDC) and verified via JWKS. The HTTP
transport adds Host-header allowlisting (DNS rebinding), per-IP token-bucket
rate limiting, and per-subject daily quotas.

This server is **not** designed to be a public unauthenticated endpoint.
Operators who deploy with `--insecure` are explicitly opting out of all
auth-layer protections and accept the resulting risk.

## Dependencies

We track advisories on direct runtime dependencies — `@modelcontextprotocol/sdk`,
`undici`, `jose`, `acorn`, `lru-cache`, `zod`, and the optional `isolated-vm`.
For an advisory in any of these that affects this server, expect a patch
release within the timeline above.
