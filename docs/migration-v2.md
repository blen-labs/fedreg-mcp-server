# Migrating to v2.0.0

v2 moves the HTTP transport to the stateless **MCP `2026-07-28`** protocol
(SDK v2: `@modelcontextprotocol/server` / `@modelcontextprotocol/node`) and
tightens tool-argument validation. The three-tool surface and the
`fr.*` / `ecfr.*` / `regs.*` globals are unchanged.

## Do I need to do anything?

| You are… | Impact |
|---|---|
| A **stdio** user (Claude Desktop) | Transport and protocol changes don't apply. **But client-visible changes 3 and 4 below do** — unknown tool names now return JSON-RPC `-32602`, and unknown argument keys are rejected with `isError: true`. Everything else is the same. |
| An **HTTP client on a pre-2026 MCP SDK** | Keeps working. `initialize` is answered by a per-request stateless fallback. Note the removals below. |
| An **HTTP client on MCP SDK v2** (`@modelcontextprotocol/client@2`) | Pass `versionNegotiation: { mode: 'auto' }` (or `{ mode: { pin: '2026-07-28' } }`) to speak the modern protocol. |
| A **server operator** | Two env-var changes and one behavioral note — see below. |

## Client-visible changes

1. **No more sessions.** The server never returns an `mcp-session-id` header,
   on either protocol leg. Every request is self-contained; retries and
   load-balancing across replicas need no sticky routing. If your client
   stored and replayed a session id, delete that code — it was already being
   ignored.
2. **`GET` and `DELETE` on `/mcp` return `405`.** The 2025-era standalone SSE
   stream and session-delete operations are gone. Server-to-client streaming
   still happens on the POST response itself.
3. **Unknown tool names are a JSON-RPC error** (`-32602`, `"Tool X not
   found"`), not an `isError: true` tool result. Don't read `result.isError`
   to detect this case.
4. **Unknown argument keys are rejected.** Tool inputs are validated against
   the advertised JSON Schema (`additionalProperties: false`). Under v1,
   unknown keys were silently stripped; now the call returns `isError: true`
   with a validation message. Send only the documented arguments.
5. **Modern-protocol requests must carry the full per-request envelope**:
   the `MCP-Protocol-Version` and `Mcp-Method` headers (plus `Mcp-Name` for
   `tools/call`), and `_meta` entries for
   `io.modelcontextprotocol/protocolVersion`, `clientInfo`, and
   `clientCapabilities`. SDK v2 clients do all of this for you — hand-rolled
   requests should copy the shapes in `test/http-integration.spec.ts`.

## Operator-visible changes

1. **`FEDREG_MAX_SESSIONS` is removed** — there are no sessions to cap. It is
   ignored if still set. The analogous long-lived-state bound is now
   `maxSubscriptions: 0` (baked in; `subscriptions/listen` is refused).
2. **Per-subject quotas no longer bind to a session.** The subject is
   re-derived from the bearer token on every request. Behavior under
   `--insecure` is unchanged: all callers share the `anonymous` subject.
3. **Load balancers need no sticky sessions.** Replicas are fully
   interchangeable. (The in-memory rate guardrails still don't coordinate
   across replicas — same as v1.)
4. `/health` now reports the served protocol revision:
   `{"ok":true,"sandbox":"…","protocolVersion":"2026-07-28"}`.

## For contributors

- The SDK dependency is now `@modelcontextprotocol/server` +
  `@modelcontextprotocol/node` (v2). The v1 `@modelcontextprotocol/sdk`
  package will never implement `2026-07-28` — don't reintroduce it.
- Do **not** use the SDK's `LATEST_PROTOCOL_VERSION` /
  `SUPPORTED_PROTOCOL_VERSIONS` constants to detect or advertise the modern
  protocol: in SDK v2 they describe the *legacy* `initialize` era (still
  `2025-11-25`). Use the locally pinned `MCP_PROTOCOL_VERSION` export from
  `src/server/mcpServer.ts`.
- MCP Inspector (≤ 2.1.0) can only exercise the legacy leg. To test the
  modern path, use `@modelcontextprotocol/client@2` — see
  `test/official-client.spec.ts`.
