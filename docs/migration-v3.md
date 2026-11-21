# Migrating to v3.0.0

v3 makes HTTP serving fail closed and runs code from authenticated callers only in a separate
process. The three tools, their results and the `fr.*` / `ecfr.*` / `regs.*` globals are unchanged.
The next major version changes results and the runtime: see [migration-v4.md](migration-v4.md).

## Do I need to do anything?

| You are… | Impact |
|---|---|
| A **stdio** user (Claude Desktop, `npx`) | Nothing. |
| An **MCP client** of any kind | Nothing. |
| A **server operator** (`--http`) | Read every item below: startup now refuses incomplete auth configuration. |

## Operator changes

1. **`--http` fails closed.** Without `--insecure` the server refuses to start unless an OIDC
   provider (`generic-oidc`, `clerk`, `workos`, `auth0`) or `accounts` is configured.
   - `FEDREG_AUTH_PROVIDER=embedded` is removed (it accepted any bearer token).
   - `none` is valid only with `--insecure`; an empty value means `none`; any other unknown
     value stops startup.
   - OIDC needs `FEDREG_AUTH_ISSUER`, `FEDREG_AUTH_AUDIENCE` and an https
     `FEDREG_AUTH_JWKS_URL`; tokens need `exp` and `sub` and every `FEDREG_AUTH_SCOPES` scope.
2. **Host validation is always on.** Binding a non-loopback address needs `FEDREG_PUBLIC_ORIGIN`
   or `FEDREG_ALLOWED_HOSTS`; with authentication it needs `FEDREG_PUBLIC_ORIGIN` (OAuth metadata
   names it). `GET /health` is exempt, so platform health checks keep working. `--insecure` binds
   127.0.0.1 unless `--host` or `HOST` says otherwise.
3. **Authenticated serving runs `execute` only in Deno.** With auth configured (including
   `accounts`), `--sandbox isolate` is refused and `auto` never uses the in-process isolate.
   Install Deno, or use the Docker image, which ships a pinned Deno. The Deno sandbox exposes
   only the language's own globals (no `setTimeout`, `URL`, `URLSearchParams`, `structuredClone`),
   the same as the isolated-vm runner.
4. **Execution limits.** At most 8 programs run at once, 2 per caller (anonymous callers are
   counted per client address); beyond that `execute` answers `Busy`. Tune with
   `FEDREG_MAX_CONCURRENT_EXECUTIONS` and `FEDREG_MAX_EXECUTIONS_PER_SUBJECT`. A cancelled or
   disconnected request now stops its program and its pending upstream calls.
