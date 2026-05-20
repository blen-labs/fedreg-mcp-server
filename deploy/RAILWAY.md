# Deploying to Railway

The included `deploy/Dockerfile` and `deploy/railway.toml` produce a single-process
HTTP MCP server with the `isolated-vm` sandbox precompiled.

## 1. Create the service

1. Create a new Railway project pointed at this repo.
2. **If this server lives in a subdirectory** of a larger repo (e.g. `fedreg-mcp-server/`),
   set **Settings → Source → Root Directory** to that subdirectory. All paths
   below are relative to that root.
3. In **Settings → Build**, set the **Dockerfile path** to `deploy/Dockerfile`.
   (Or copy `deploy/railway.toml` to the root and Railway will pick it up.)
4. Railway will inject `PORT`. Our server binds to it automatically.
5. Attach your custom domain (e.g. **`your-host.example.com`**) in **Settings →
   Networking → Custom Domains**, then add the `CNAME` Railway gives you to
   your DNS zone. Wait for the cert to provision before testing the metadata
   URL below.

## 2. Required environment variables

Set these in **Settings → Variables**:

| Variable | Required | Example | Notes |
|---|---|---|---|
| `FEDREG_PUBLIC_ORIGIN` | yes | `https://your-host.example.com` | Public origin clients see. Used in OAuth resource metadata and `WWW-Authenticate` URLs. |
| `FEDREG_ALLOWED_HOSTS` | recommended | `your-host.example.com` | Comma-separated Host header allowlist (DNS-rebinding protection). |
| `FEDREG_LOG_LEVEL` | no | `info` | `debug`/`info`/`warn`/`error`. |
| `FEDREG_USER_AGENT` | recommended | `acme-fedreg-mcp/1.0 (contact: ops@acme.com)` | FederalRegister.gov and eCFR appreciate identifiable user agents. |
| `FEDREG_SANDBOX` | no | `auto` | `isolate` is best on Linux; `auto` falls back to `deno` if available. |

## 3. Authentication

Pick **one** provider. For production, point at any OIDC issuer that publishes a
JWKS endpoint.

| Variable | Required | Example |
|---|---|---|
| `FEDREG_AUTH_PROVIDER` | yes | `generic-oidc` \| `clerk` \| `workos` \| `auth0` |
| `FEDREG_AUTH_ISSUER` | yes | `https://<tenant>.clerk.accounts.dev` |
| `FEDREG_AUTH_JWKS_URL` | yes | `https://<tenant>.clerk.accounts.dev/.well-known/jwks.json` |
| `FEDREG_AUTH_AUDIENCE` | recommended | `https://your-host.example.com/mcp` |
| `FEDREG_AUTH_SCOPES` | no | `mcp:read,mcp:execute` |

For a quick stand-up, set `FEDREG_AUTH_PROVIDER=none` and pass the `--insecure`
flag on the start command. **Do not do this in production.** With `--insecure` the
server skips bearer-token verification entirely.

## 4. Tunables

| Variable | Default |
|---|---|
| `FEDREG_IP_RPS` | `5` (token-bucket sustained rate per IP) |
| `FEDREG_IP_BURST` | `20` (token-bucket burst per IP) |
| `FEDREG_MAX_SESSIONS` | `500` |
| `FEDREG_SUBJECT_DAILY_QUOTA` | `10000` requests per authenticated subject per day |
| `FEDREG_CACHE_TTL_MS` | `300000` (5 min upstream LRU) |
| `FEDREG_UPSTREAM_TIMEOUT_MS` | `20000` |
| `FEDREG_UPSTREAM_RETRIES` | `3` (with exponential backoff) |

## 5. Verifying after deploy

```bash
# 1) Resource metadata (RFC 9728)
curl -s "$URL/.well-known/oauth-protected-resource/mcp" | jq

# 2) Health
curl -s "$URL/health" | jq

# 3) Initialize a session (unauthed gets 401 with WWW-Authenticate)
curl -i -X POST "$URL/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Note the `mcp-session-id` response header — pass it back on subsequent calls.

## 6. Pointing Claude at it

```json
{
  "mcpServers": {
    "fedreg": {
      "type": "http",
      "url": "https://your-host.example.com/mcp"
    }
  }
}
```

Claude follows the OAuth Protected Resource Metadata flow automatically when it
sees a `401` with a `WWW-Authenticate` header pointing at your metadata URL.

## 7. Image notes

- The build stage compiles `isolated-vm` from source (~2 min on first build,
  cached on rebuilds with `--cache-from`).
- The runtime image is `node:22-bookworm-slim` + `libstdc++`. No Python, no
  toolchain — about 220 MB.
- `dumb-init` is the PID 1 so signals are forwarded cleanly. The server handles
  `SIGTERM`/`SIGINT` and drains open MCP sessions before exit.
