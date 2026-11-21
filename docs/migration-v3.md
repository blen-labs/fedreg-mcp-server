# Migrating to v3.0.0

v3 makes HTTP serving fail closed, runs code from authenticated callers only in a separate
process, returns structured tool results, and moves the toolchain to Node 24/26. The three tools
and the `fr.*` / `ecfr.*` / `regs.*` globals are unchanged.

## Do I need to do anything?

| You are… | Impact |
|---|---|
| A **stdio** user (Claude Desktop, `npx`) | Use Node 24 or 26. A failed `execute` now carries `isError: true` (change 1). Nothing else. |
| An **MCP client** of any kind | Read change 1 and 2: failed programs are tool errors, and results carry `structuredContent`. |
| A **server operator** (`--http`) | Read every item under "Operator changes": startup now refuses incomplete auth configuration. |

## Client-visible changes

1. **A failed `execute` is a tool error.** When the program throws, breaks a limit, times out,
   is refused by the preflight, or the server is busy (`ok: false`), the result now has
   `isError: true`. The text block still holds the full envelope
   `{ ok, error: { name, message, status? }, logs, durationMs }`. Clients that treated every
   non-error result as success should check `isError` (or `ok`).
2. **Structured results.** Every tool declares an `outputSchema` and returns its result as
   `structuredContent`, with the same object as compact JSON text. Clients may read either.
3. **Tool input schemas** come from Zod 4 and carry real integer, minimum and maximum
   constraints. Arguments outside them are rejected with `isError: true`, as unknown keys already
   were in v2.
4. **Request bodies over 1 MiB** are refused on `/mcp` and both account endpoints.
5. **Browser-based MCP clients on another origin** are refused (403) unless that origin is in
   `FEDREG_ALLOWED_ORIGINS`. Non-browser clients send no `Origin` and are unaffected.

## Operator changes

1. **Node 24 or 26** (`^24.11.0 || ^26.0.0`). isolated-vm 7 ships prebuilt binaries for both,
   so no compiler is needed.
2. **`--http` fails closed.** Without `--insecure` the server refuses to start unless an OIDC
   provider (`generic-oidc`, `clerk`, `workos`, `auth0`) or `accounts` is configured.
   - `FEDREG_AUTH_PROVIDER=embedded` is removed (it accepted any bearer token).
   - `none` is valid only with `--insecure`; an empty value means `none`; any other unknown
     value stops startup.
   - OIDC needs `FEDREG_AUTH_ISSUER`, `FEDREG_AUTH_AUDIENCE` and an https
     `FEDREG_AUTH_JWKS_URL`; tokens need `exp` and `sub` and every `FEDREG_AUTH_SCOPES` scope.
3. **Host validation is always on.** Binding a non-loopback address needs `FEDREG_PUBLIC_ORIGIN`
   or `FEDREG_ALLOWED_HOSTS`. `--insecure` binds 127.0.0.1 unless `--host` or `HOST` says
   otherwise.
4. **Authenticated serving runs `execute` only in Deno.** With auth configured (including
   `accounts`), `--sandbox isolate` is refused and `auto` never uses the in-process isolate.
   Install Deno, or use the Docker image, which ships a pinned Deno. The Deno sandbox exposes
   only the language's own globals (no `setTimeout`, `URL`, `URLSearchParams`, `structuredClone`),
   the same as the isolated-vm runner.
5. **Execution limits.** At most 8 programs run at once, 2 per caller (anonymous callers are
   counted per client address); beyond that `execute` answers `Busy`. Tune with
   `FEDREG_MAX_CONCURRENT_EXECUTIONS` and `FEDREG_MAX_EXECUTIONS_PER_SUBJECT`. A cancelled or
   disconnected request now stops its program and its pending upstream calls.
6. **Docs site.** Account mode serves the documentation site at `/docs` (built into the Docker
   image as `docs-site/`).
