# Migrating to v4.0.0

v4 returns structured tool results, marks failed runs as errors, and moves the runtime to
Node 24/26. The three tools and the `fr.*` / `ecfr.*` / `regs.*` globals are unchanged. Coming
from v2, read [migration-v3.md](migration-v3.md) first.

## Do I need to do anything?

| You are… | Impact |
|---|---|
| A **stdio** user (Claude Desktop, `npx`) | Use Node 24 or 26. A failed `execute` now carries `isError: true` (change 1). Nothing else. |
| An **MCP client** of any kind | Read changes 1 and 2: failed programs are tool errors, and results carry `structuredContent`. |
| A **server operator** (`--http`) | Use Node 24 or 26, or the Docker image (change 5). |

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
   were.
4. **Request bodies over 1 MiB** are refused on `/mcp` and both account endpoints, while the body
   is still arriving.

## Operator changes

5. **Node 24 or 26** (`^24.11.0 || ^26.0.0`). isolated-vm 7 ships prebuilt binaries for both,
   so no compiler is needed. The Docker image runs Node 26.
6. **Docs site.** Account mode serves the documentation site at `/docs` (built into the Docker
   image as `docs-site/`).
