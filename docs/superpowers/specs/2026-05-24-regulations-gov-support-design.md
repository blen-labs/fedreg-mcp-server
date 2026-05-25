# Design: regulations.gov support in fedreg-mcp-server

Status: REVISED after Codex adversarial review (for owner review before implementation)
Date: 2026-05-24

## Summary

Add a third upstream data source, **regulations.gov v4**, to the existing code-mode
MCP server alongside `fr` (Federal Register) and `ecfr` (eCFR). The new sandbox
global is **`regs`**, exposing `regs.documents`, `regs.comments`, and `regs.dockets`
as a complete mirror of the v4 API.

Two decisions are already locked by the project owner:

- **Scope: FULL MIRROR.** documents + comments + dockets, not just the
  comments/dockets wedge.
- **Structure: PLUGGABLE SOURCE INTERFACE.** Introduce a `Source` contract + a
  registry; the runtime, sandbox, corpus, and tools read from the registry instead
  of hardcoded `'fr' | 'ecfr'` unions. Kept lean: a contract + a registry, not a
  dynamic plugin loader.

Defaults (not separately negotiated):

- **Read-only.** No `POST /comments` submission. Preserves the sandbox's "no side
  effects" guarantee.
- **Single server-wide API key** for v1. Per-user key passthrough deferred.

## Background: how the server works today

- Three MCP tools: `search_api` (BM25 over `schema/field-dictionary.json`),
  `describe_schema` (exact/prefix lookup in the same corpus), `execute` (runs
  model-authored TypeScript in a sandbox).
- `buildSdk()` (`src/sdk/bindings.ts`) constructs host-side clients
  `{ fr, ecfr }` over `HttpClient` (`src/util/httpClient.ts`: undici + LRU cache +
  retry/backoff).
- The sandbox (`src/sandbox/isolate.ts` primary, `src/sandbox/deno.ts` fallback)
  injects `globalThis.fr` / `globalThis.ecfr` as **Proxy stubs**. Each call
  marshals `{ binding, path, args }` across an RPC bridge to the host, where
  `dispatch()` (`src/sdk/runtime.ts`) resolves the path on the real client.
- **Security property:** the real SDK lives host-side. Only Proxy stubs cross into
  the sandbox. User code cannot reach the network, fs, env, or secrets. An acorn
  AST preflight (`src/sandbox/policy.ts`) bans `process`, `fetch`, `eval`, etc.
- `RpcRequest.binding` is the union `'fr' | 'ecfr'` (`runtime.ts`). The same union
  appears in `corpus.ts`, `searchApi.ts`, `describeSchema.ts`, and as a `"binding"`
  field on each `schema/field-dictionary.json` entry.

## Why regulations.gov is different

1. **It requires an API key** (`X-Api-Key`, free from api.data.gov). FR/eCFR are
   keyless. The header is set host-side in `HttpClient`; it must never reach the
   sandbox.
2. **Unique value: public comments + dockets.** Its *documents* overlap heavily
   with `fr.documents` (shared FR document numbers via `frDocNum`).
3. **Rate limits + pagination caps.** api.data.gov default ~1,000 req/hr per key;
   the commenting API has tighter limits (read endpoints follow the standard
   bucket). Result sets cap at ~5,000 (page[size] max 250); going past it requires
   a `lastModifiedDate` cursor technique.

## Goals / Non-goals

Goals:
- `regs.{documents,comments,dockets}.{search,get}` over v4, full mirror.
- A `Source` contract + registry; remove the hardcoded binding union.
- API key host-side only; graceful degradation when absent.
- Corpus entries + cross-source "recipe" so the model knows when to use `regs` vs
  `fr`.

Non-goals (v1):
- No comment submission / file upload (`POST /comments`).
- No per-user/per-request API keys (single server key).
- No automatic cursor-stitching SDK helper (document the pattern instead).

## Design

### 1. The `Source` contract — `src/sdk/sources/source.ts`

Secrets are NEVER enumerable on objects the registry returns (Codex P1 #1). The
contract is split into redacted metadata + an already-built client:

```ts
export interface SourceMeta {
  name: string;           // sandbox global + RPC binding id: 'fr' | 'ecfr' | 'regs'
  label: string;          // 'Regulations.gov', for docs/errors
  enabled: boolean;       // false when a required secret is missing
  disabledReason?: string;
}

export interface Source extends SourceMeta {
  client: object;         // host-side client reachable as <name>.* in the sandbox
  corpus: { endpoints: CorpusEntry[]; fields: CorpusEntry[] };
}
```

There is NO `http` / `defaultHeaders` / secret field on `Source`. Each source is
built by a factory (`createRegsSource(cfg)` etc.) that closes over the API key,
passes it to the `HttpClient` constructor, and returns only the redacted fields
above. The key lives in a `#private` field inside `HttpClient` so it is not
enumerable and cannot appear in `JSON.stringify`, logs, tool descriptions, or error
payloads. Corpus, tooling, and logging only ever read `SourceMeta` — never client
internals.

A registry `getSources(cfg): Source[]` builds all three and validates them at startup
(see §4). `fr` / `ecfr` move into `sources/fr.ts` / `sources/ecfr.ts` as thin wrappers
over the existing client classes (the classes themselves change minimally). `regs` is
`sources/regs.ts`.

`buildSdk(cfg)` becomes registry-driven and returns:

```ts
{
  clients: Record<string, object>;  // ENABLED sources only — drives dispatch
  meta: SourceMeta[];               // ALL registered sources, redacted — drives docs/tooling
  registeredNames: string[];        // ALL names — drives sandbox global injection
  version: () => string;
}
```

### 2. The regulations.gov client — `src/sdk/regs-client.ts`

```ts
regs.documents.search(params)               // GET /v4/documents
regs.documents.get(id, { include?: 'attachments' })  // GET /v4/documents/{id}
regs.comments.search(params)                // GET /v4/comments
regs.comments.get(id, { include?: 'attachments' })   // GET /v4/comments/{id}
regs.dockets.search(params)                 // GET /v4/dockets
regs.dockets.get(id)                        // GET /v4/dockets/{id}
```

Params use the v4 JSON:API shape, flattened by a helper reusing the existing
bracket-nesting logic from `fr-client.ts`/`ecfr-client.ts`:

```
{ filter: { searchTerm, agencyId, postedDate: { ge, le }, commentOnId,
            docketId, withinCommentPeriod, lastModifiedDate: { ge, le } },
  sort, page: { number, size } }
  -> filter[postedDate][ge]=...&page[size]=250&sort=-postedDate
```

Responses **pass through raw** (the `data` / `included` / `meta.totalElements`
envelope). The model reads `meta` for paging. (Exact `filter[...]` names confirmed
against live v4 docs during implementation.)

### 3. API key + graceful degradation

- New env: `FEDREG_REGS_API_KEY` (enables `regs`), `FEDREG_REGS_BASE_URL`
  (default `https://api.regulations.gov`).
- `HttpClient` gains a `defaultHeaders` constructor option merged into every request
  (per-call `headers` win), stored in a `#private` field. The `regs` factory passes
  `{ 'X-Api-Key': key }`. The key is a constructor arg, not a property on `Source`,
  and is never serialized into RPC payloads, corpus, tool descriptions, logs, or
  error messages.
- **No key → `regs.enabled = false`, but `regs` is still a *registered* name and is
  injected as a global in every sandbox.** All registered globals are injected; the
  host-side `dispatch` is what distinguishes enabled vs disabled — a call to a
  disabled source returns a `SourceUnavailable` error: *"regulations.gov requires an
  API key. Set FEDREG_REGS_API_KEY (free at api.data.gov)."* This avoids the
  `ReferenceError` trap (Codex P2 #3): globals come from `registeredNames` (all),
  clients come from the enabled set. `search_api` / `describe_schema` still list
  `regs`, annotated "requires API key". `fr` / `ecfr` unaffected. Mirrors the
  existing `SandboxUnavailable` philosophy. **The no-key path is tested in BOTH
  isolate and deno runners.**

### 4. De-hardcoding the `'fr' | 'ecfr'` union (~8 sites)

- **Startup validation of source names (Codex P2 #5).** Names are first-party (our
  own registry, never model- or API-supplied), but `getSources` still validates each
  `Source.name` against `/^[a-zA-Z_$][a-zA-Z0-9_$]*$/`, rejects any name in a denylist
  (`BANNED_GLOBALS` ∪ `{ 'console', 'global', 'globalThis' }`), and rejects
  duplicates. Fail fast at boot, never at execute time.
- `runtime.ts`: `RpcRequest.binding: string`; `dispatch` resolves the client by name
  from the **enabled** `Record<string, object>`. Unknown name → `TypeError`;
  registered-but-disabled → `SourceUnavailable`.
- `isolate.ts` / `deno.ts`: iterate **`registeredNames` (all sources, enabled or
  not)** and inject `globalThis[name] = makeProxy(name)`. Names passed via
  `ExecuteOptions.bindings: string[]`. Isolate: as an `ExternalCopy`'d array. Deno:
  injected with `JSON.stringify(names)` ONLY (no raw string interpolation) and
  iterated in the generated runner.
- `corpus.ts`, `searchApi.ts`, `describeSchema.ts`: `binding: string`; the corpus
  loads from each source's contributed entries.
- `toolCatalog.ts` / `ExecuteInput`: tool descriptions list the registered globals
  dynamically (e.g., "Globals: fr, ecfr, regs").
- `policy.ts`: no change to banned globals; binding names are validated against the
  denylist at startup instead.

### 5. Disambiguation (the full-mirror tax)

`regs.documents` overlaps `fr.documents`. Corpus descriptions steer the model:
- `regs.documents.*`: "regulations.gov view — adds docket linkage, live
  comment-period status (openForComment, commentEndDate), and the `objectId`
  needed to fetch comments. For canonical rule text/metadata since 1994, prefer
  `fr.documents`. Use this when you need comments or docket context."
- A cross-source **recipe** corpus entry: `fr.documents.search` → read
  `frDocNum`/`objectId` → `regs.comments.search({ filter: { commentOnId } })`.
- README "which source for what" table.

### 6. Pagination & rate limits — lean guardrails (Codex P1 #2)

The shared key's ~1,000/hr bucket is a global ceiling that `FEDREG_SUBJECT_DAILY_QUOTA`
(charged per MCP request) does NOT protect: one `execute` call can loop and
`HttpClient` retries 429, so a single tenant could burn the bucket for every tenant.
v1 ships these layered, in-code guardrails:

- **No 429 retry for regs.** `HttpClient` gains `retry429?: boolean` (default `true`
  to preserve fr/ecfr behavior). `regs` sets it `false`: a 429 surfaces immediately
  as a `RateLimited` error including any `Retry-After`, instead of being amplified by
  backoff retries. Limited 5xx retry stays.
- **Per-execute upstream-call budget.** The `execute` tool creates a per-invocation
  counter; the `dispatch` bridge increments it on each `regs` call and returns
  `RegsCallBudgetExceeded` past a cap (`FEDREG_REGS_MAX_CALLS_PER_EXECUTE`, default
  ~30). It counts host-side RPC calls, so it holds regardless of any sandbox loop.
  This bounds per-execute fan-out.
- **Process-wide token bucket.** A single in-memory bucket caps total `regs`
  upstream calls to `FEDREG_REGS_RATE_PER_HOUR` (default 1000/hr) across all
  sessions/tenants, protecting the shared api.data.gov key; over the limit returns
  `RegsRateLimited`. It sits AFTER the response cache, so cache hits are free.
  **Caveat:** the bucket is in-memory/single-process — it does NOT coordinate across
  replicas, so N replicas allow up to N× the configured rate against the shared key
  (operators should divide the rate by replica count or use per-replica keys). A
  value of 0 is NOT "unlimited" (it blocks all regs calls); to disable regs, leave
  `FEDREG_REGS_API_KEY` unset.
- **Per-subject hourly quota (HTTP auth mode).** `FEDREG_REGS_SUBJECT_RATE_PER_HOUR`
  (default 500/hr) per authenticated subject; over the limit returns
  `RegsSubjectQuotaExceeded`. Skipped in stdio (no subject). The subject is bound to
  the MCP session at init, and a session id reused with a different token is rejected
  (403).
- **Caching independently protects the shared bucket.** Each source has its own
  `HttpClient` + LRU; cached GETs never reach api.data.gov, so the existing cache is
  a rate-limit ally — keep it on for regs.
- The model still writes its own paging loop; the `regs.comments.search` corpus
  example demonstrates the `lastModifiedDate` cursor to get past the ~5,000-result
  cap, within the per-execute budget.

In short, four guardrails layer up: no-429-retry → per-execute budget →
process-wide token bucket → per-subject quota. Operators can also request a
rate-limit increase or run per-deployment keys.

### 7. Caching (Codex P2 #4)

Each source gets its OWN `HttpClient` instance with its OWN LRU (as today: `frHttp`,
`ecfrHttp`, now `regsHttp`), so cross-source cache collisions are impossible — caches
are already isolated per source instance. Within single-server-key v1, URL-only
keying is therefore correct (no actual bug today).

Auth-aware cache keys are now IMPLEMENTED in v1: the GET response cache key
includes a redacted hash of the request's auth headers, so a cached response is
never served across different `X-Api-Key` values — preventing cross-key cache bleed
even when one source instance sees multiple keys. (The source-scoped cache namespace
remains in place too.) A rotation test asserts no cross-key cache bleed.

### 8. Tests (vitest + undici MockAgent, mirroring `test/sdk.spec.ts`)

- `regs-client`: path building, JSON:API filter flattening, `X-Api-Key` header
  present, `include=attachments`, raw passthrough of `data`/`included`/`meta`.
- Degradation in BOTH runners: no key → `regs` global is defined but `regs.*`
  returns `SourceUnavailable` (no `ReferenceError`); `fr`/`ecfr` still work.
- Security: the API key never appears in the sandbox-visible surface, redacted
  source metadata, tool descriptions, RPC payloads, or `JSON.stringify` of the
  sources/sdk.
- Rate guardrails: regs 429 is NOT retried (surfaces `RateLimited` + `Retry-After`);
  the per-execute budget returns `RegsCallBudgetExceeded` past the cap.
- Cache: GET served per-source; a rotation test asserts no cross-key cache bleed.
- Name validation: `getSources` rejects an invalid / duplicate / denylisted source
  name at startup.
- Corpus: `regs` entries are findable via `search_api`; registered globals match
  `registeredNames`.

### 9. Out-of-code changes

- `README.md`: "two sources" → "three"; API-key setup section; bridge example;
  "which source" table.
- `.env.example`: `FEDREG_REGS_API_KEY`, `FEDREG_REGS_BASE_URL`.
- `docs/sdk-reference.md`, `docs/architecture.md`: add `regs`.
- Delete `src/sdk/generated.d.ts` — unreferenced and never injected (its header
  comment is wrong).
- `package.json` keywords; mcpb manifest.

## File-by-file change list

New:
- `src/sdk/sources/source.ts` (contract + CorpusEntry re-export)
- `src/sdk/sources/index.ts` (`getSources(cfg)` registry)
- `src/sdk/sources/fr.ts`, `src/sdk/sources/ecfr.ts`, `src/sdk/sources/regs.ts`
- `src/sdk/regs-client.ts`
- `schema/fr.json`, `schema/ecfr.json`, `schema/regs.json` — split the single
  `schema/field-dictionary.json` into per-source corpus files; each `Source` loads
  its own and the corpus loader merges them into one BM25 index. (Update the
  `package.json` `files` glob accordingly.)
- `test/regs-client.spec.ts`, `test/sources.spec.ts`

Modified:
- `src/sdk/bindings.ts`, `src/sdk/runtime.ts`
- `src/util/httpClient.ts` (`defaultHeaders` in `#private`; `retry429` option)
- `src/sandbox/isolate.ts`, `src/sandbox/deno.ts`, `src/sandbox/types.ts`
  (`ExecuteOptions.bindings`)
- `src/search/corpus.ts`, `src/tools/searchApi.ts`, `src/tools/describeSchema.ts`,
  `src/tools/execute.ts` (per-execute regs budget), `src/server/toolCatalog.ts`
- `src/supervisor/index.ts`, `src/bin.ts` (regs env wiring)
- existing tests that assume only fr/ecfr

Deleted / replaced:
- `src/sdk/generated.d.ts` (deleted — unreferenced).
- `schema/field-dictionary.json` (replaced by per-source `schema/{fr,ecfr,regs}.json`;
  `corpus.ts` loads + merges them).

## Resolutions from Codex adversarial review (2026-05-24)

- **P1 secret-as-metadata → resolved (§1, §3).** No secret fields on `Source`; key
  held in `HttpClient` `#private`; registry exposes redacted `SourceMeta` only.
- **P1 shared-key exhaustion → layered guardrails (§6).** No 429 retry for regs +
  per-execute call budget + process-wide token bucket (`FEDREG_REGS_RATE_PER_HOUR`)
  + per-subject hourly quota (`FEDREG_REGS_SUBJECT_RATE_PER_HOUR`), all built in v1
  after a re-run flagged the gap. The bucket is in-memory/single-process (no
  cross-replica coordination).
- **P2 disabled-global contradiction → resolved (§3, §4).** `registeredNames` (all)
  drive global injection; `clients` (enabled) drive dispatch; disabled →
  host-side `SourceUnavailable`. Tested in both runners.
- **P2 URL-only cache → resolved (§7).** Caches are per-source-instance already;
  source-scoped namespace added; the GET cache key now also includes a redacted
  auth-context hash (built in v1), preventing cross-key cache bleed.
- **P2 union→string hardening → resolved (§4).** Startup name validation (identifier
  regex + denylist + dedupe); deno injection via `JSON.stringify` only.

## Decisions locked for v1 (were open questions)

1. **JSON:API passthrough — YES.** Return raw `data` / `included` / `meta`; no
   unwrapping. Consistent with `ecfr.full` returning XML as a string (honest,
   low-magic). Revisit only if the model demonstrably struggles.
2. **`FEDREG_REGS_MAX_CALLS_PER_EXECUTE = 30`** (default; env-tunable).
3. **Per-subject / per-key upstream meter → INCLUDED in v1.** A re-run of the
   adversarial review re-flagged shared-key exhaustion, so the meter shipped in v1
   rather than v1.1: a **process-wide token bucket** (`FEDREG_REGS_RATE_PER_HOUR`,
   default 1000/hr) caps total regs upstream calls across all sessions/tenants to
   protect the shared api.data.gov key, plus a **per-subject hourly quota**
   (`FEDREG_REGS_SUBJECT_RATE_PER_HOUR`, default 500/hr) in HTTP auth mode. The
   bucket is in-memory/single-process — it does NOT coordinate across replicas, so
   N replicas allow up to N× the configured rate against the shared key (divide the
   rate by replica count or use per-replica keys).
