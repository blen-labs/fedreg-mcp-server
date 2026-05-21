# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-05-20

Initial public release.

### Added
- **Three-tool code-mode MCP surface** — `search_api`, `describe_schema`,
  `execute` (the same pattern as `clinicaltrials-mcp-server`).
- **SDK bindings** — `fr.*` for FederalRegister.gov v1 (`documents`,
  `publicInspection`, `agencies`, `issues`, `suggestedSearches`, `images`)
  and `ecfr.*` for the Electronic Code of Federal Regulations (`titles`,
  `admin.agencies`, `structure`, `ancestry`, `versions`, `full`, `search.*`).
- **BM25 search** over a curated endpoint + field dictionary
  (`schema/field-dictionary.json`).
- **Sandbox** — `isolated-vm` (primary) and Deno subprocess (fallback) with
  shared AST preflight via `acorn`, wall-clock timeout, and heap cap.
- **stdio transport** for Claude Desktop and MCPB.
- **Streamable HTTP transport** built on `@modelcontextprotocol/sdk` 1.29:
  per-session `StreamableHTTPServerTransport`, SSE streaming, graceful
  SIGTERM/SIGINT drain.
- **OAuth 2.0 Protected Resource Metadata** per RFC 9728 at
  `/.well-known/oauth-protected-resource/mcp`, `WWW-Authenticate` header
  pointing at it on 401.
- **Bearer token verification** via `jose` against any JWKS endpoint
  (presets: `clerk`, `workos`, `auth0`, `generic-oidc`; `embedded` HS256
  for dev).
- **Hardening** — per-IP token-bucket rate limiting, per-subject daily
  quotas, Host-header allowlist for DNS-rebinding protection.
- **Deploy** — multi-stage Dockerfile (`deploy/Dockerfile`) that builds
  `isolated-vm` and slims to a `node:22-bookworm-slim` runtime, plus a
  Railway walkthrough in `deploy/RAILWAY.md`.
- **27 tests** across BM25, sandbox policy, both SDK clients (vs `undici`
  MockAgent), HTTP rate limiter, and an end-to-end MCP flow (initialize
  → notifications/initialized → tools/list → tools/call → sandbox → SDK
  → mocked upstream).

[Unreleased]: https://github.com/blen-labs/fedreg-mcp-server/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/blen-labs/fedreg-mcp-server/releases/tag/v1.0.0
