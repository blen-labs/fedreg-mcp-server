# SDK reference

Inside `execute`, three globals are available — `fr` for
FederalRegister.gov v1, `ecfr` for the Electronic Code of Federal Regulations,
and `regs` for regulations.gov v4. All return plain JSON; every method is
`async` and resolves with the upstream payload.

> `regs` is always defined, but without `FEDREG_REGS_API_KEY` the source is
> disabled and `regs.*` calls throw a `SourceUnavailable` error; `fr` and
> `ecfr` are unaffected.
>
> Only the methods listed below are callable: the host resolves each call
> against an explicit per-source method table, so anything else (including
> client internals) throws `TypeError: … is not a function`.

You can always discover the full surface from inside the model:

```ts
await search_api({ query: 'methane rules EPA' });
await describe_schema({ prefix: 'fr.documents' });
```

## `fr.*` — FederalRegister.gov v1

### `fr.documents`

| Method | Returns | Notes |
|--------|---------|-------|
| `search(opts)` | `{ count, total_pages, results: Doc[], next_page_url? }` | `opts.conditions` is a structured filter; common keys: `term`, `agencies` (slugs), `publication_date: { gte, lte, year, is }`, `type` (e.g. `RULE`, `PRORULE`, `NOTICE`, `PRESDOCU`), `topics`, `docket_id`, `effective_date` (same shape as `publication_date`), `significant` (`0`/`1`), `cfr: { title, part }`, `president`, `presidential_document_type`. `fields` narrows the response. `per_page` (max 1000 with `fields`, else 20), `page`, `order` (`relevance` \| `newest` \| `oldest` \| `executive_order_number`). |
| `get(documentNumber, fields?)` | `Doc` | Single document by `document_number` (e.g. `'2024-12345'`). |
| `getMany(documentNumbers, fields?)` | `Doc[]` | Multi-fetch up to ~20 documents in one request. |
| `facets({ facet, conditions? })` | `Record<string, { count, name? }>` | `facet`: `daily` \| `weekly` \| `monthly` \| `quarterly` \| `yearly` \| `agency` \| `topic` \| `section` \| `subject` \| `type`. |

### `fr.publicInspection`

| Method | Returns |
|--------|---------|
| `current(fields?)` | Documents on public inspection right now. |
| `search(params)` | Search PI documents. `params.conditions`: `available_on` (`YYYY-MM-DD`), `agencies`, `type`, `special_filing` (`0`/`1`), `docket_id`; plus `fields`, `per_page`, `page`. |
| `get(documentNumber, fields?)` | Single PI document. |
| `getMany(documentNumbers, fields?)` | Multiple PI documents in one request. |

### `fr.agencies`

| Method | Returns |
|--------|---------|
| `list()` | `Agency[]` — all agencies known to FR. |
| `get(slug)` | One agency (`'environmental-protection-agency'`, etc.). |

### `fr.issues`

| Method | Returns |
|--------|---------|
| `get(publicationDate)` | The Table of Contents for that day's issue. |

### `fr.suggestedSearches`

| Method | Returns |
|--------|---------|
| `list(sections?)` | Editorially curated searches, optionally filtered to a section slug (a string). |
| `get(section)` | Suggested searches for one section slug. |

### `fr.images`

| Method | Returns |
|--------|---------|
| `get(identifier)` | Image metadata for the given image identifier. |

## `ecfr.*` — Electronic Code of Federal Regulations

### `ecfr.titles`

| Method | Returns |
|--------|---------|
| `list()` | All 50 CFR titles with their latest amendment dates. |

### `ecfr.admin`

| Method | Returns |
|--------|---------|
| `agencies()` | Agencies and their CFR references. |
| `corrections(query?)` | eCFR corrections. `query`: `{ date?, title?, error_corrected_date? }`. |
| `corrections_for_title(title, query?)` | Corrections for one title. `query`: `{ date? }`. |

### Versioned structure / content

Dates are `YYYY-MM-DD`; `title` is numeric. Where a `query` is accepted it is
a flat positional filter (`{ chapter, subchapter, part, subpart, section }`)
that scopes the response.

| Method | Returns |
|--------|---------|
| `ecfr.structure(date, title)` | Hierarchical TOC for the whole title. |
| `ecfr.ancestry(date, title, query?)` | The ancestor chain (title → chapter → … → leaf). |
| `ecfr.versions(title, query?)` | Amendment history. `query`: `{ issue_date?: { on?, lte?, gte? }, identifier? }` (no date argument). |
| `ecfr.full(date, title, query?)` | Full XML of the slice, as a string. |

### `ecfr.search`

| Method | Returns |
|--------|---------|
| `results(opts)` | Search results across the eCFR. `opts.query`, `opts.agency_slugs`, `opts.hierarchy` (`{ title, subtitle, chapter, subchapter, part, subpart, section, appendix }`), `opts.last_modified_after/before`, `opts.last_modified_on_or_after/on_or_before`, `opts.date`, `opts.per_page`, `opts.page`, `opts.order` (`relevance` \| `hierarchy` \| `newest` \| `oldest`). |
| `counts_daily(opts)` | Result counts grouped by day. |
| `counts_hierarchy(opts)` | Result counts grouped by CFR hierarchy. |
| `counts_titles(opts)` | Result counts grouped by title. |
| `suggestions(opts)` | Did-you-mean suggestions. |

## `regs.*` — regulations.gov v4

The unique value over `fr` / `ecfr`: public **comments**, **dockets**, and
live comment-period status. regulations.gov documents overlap `fr.documents`,
so prefer `fr.documents` for canonical Federal Register text/metadata since
1994 and reach for `regs` when you need comments or docket context.

Responses are raw [JSON:API](https://jsonapi.org/) payloads:
`{ data, included?, meta }`, with `meta.totalElements` carrying the total
match count. Each `search` takes a single params object:

```ts
{
  filter?: Record<string, string | number | boolean | { ge?: string; le?: string }>,
  sort?: string,          // e.g. 'lastModifiedDate' or '-postedDate'
  page?: { number?: number; size?: number },  // size max 250
}
```

A scalar `filter` value becomes `filter[key]=value`; a `{ ge, le }` value
becomes `filter[key][ge]` / `filter[key][le]` (date-range bounds). `get`
methods take an id and, for documents/comments, an optional
`{ include: 'attachments' }`.

### `regs.documents`

| Method | Returns | Notes |
|--------|---------|-------|
| `search(params)` | JSON:API `{ data, included?, meta }` | Filters: `searchTerm`, `agencyId`, `docketId`, `documentType`, `postedDate: { ge, le }`, `lastModifiedDate: { ge, le }`. Each result's `attributes.objectId` is what `regs.comments` filters on; `attributes.frDocNum` is the Federal Register document number (a *returned* attribute, not a filter — bridge from a known FR doc number via `filter: { searchTerm: docNumber }`). |
| `get(documentId, { include? })` | JSON:API `{ data, included? }` | One document by id (e.g. `'EPA-HQ-OAR-2021-0317-0001'`). `include: 'attachments'` adds attachment resources. |

### `regs.comments`

| Method | Returns | Notes |
|--------|---------|-------|
| `search(params)` | JSON:API `{ data, included?, meta }` | The unique value vs `fr`/`ecfr`. Filters: `commentOnId` (a document's `objectId`), `searchTerm`, `agencyId`, `postedDate: { ge, le }`, `lastModifiedDate: { ge, le }`. |
| `get(commentId, { include? })` | JSON:API `{ data, included? }` | One comment's full text (+ attachments with `include`). Some submitter fields (email, phone, address) are never public. |

### `regs.dockets`

| Method | Returns | Notes |
|--------|---------|-------|
| `search(params)` | JSON:API `{ data, included?, meta }` | The folder grouping a rulemaking's documents and comments. Filters: `searchTerm`, `agencyId` (comma-separated), `lastModifiedDate: { ge, le }`. Sort by `title` / `-title`. |
| `get(docketId)` | JSON:API `{ data, included? }` | One docket, incl. comment-period metadata and counts. |

### Pagination past 5000 results

regulations.gov caps any single query at ~5000 results (`page[size]` max 250,
so ~20 pages). To read further, page with the `lastModifiedDate` cursor: sort
by `lastModifiedDate`, walk the pages, then re-query with
`filter: { lastModifiedDate: { ge: <last value seen> } }` and continue.

## Errors

The SDK throws (and the proxy re-throws inside the sandbox) named errors:

- `HttpError` — non-2xx upstream response. `message` includes method, URL,
  and status code.
- `HeadersTimeoutError` / `BodyTimeoutError` — the upstream call exceeded
  `FEDREG_UPSTREAM_TIMEOUT_MS` (undici's error names are passed through).
- `SourceUnavailable` — the source is registered but disabled (e.g. `regs.*`
  without `FEDREG_REGS_API_KEY`).
- `RateLimited` / `RegsRateLimited` — an upstream 429 (never retried for
  `regs`) / the process-wide hourly regs bucket ran dry.
- `RegsCallBudgetExceeded` — the per-`execute()` regs call budget
  (`FEDREG_REGS_MAX_CALLS_PER_EXECUTE`) ran out.
- `RegsSubjectQuotaExceeded` — the per-subject hourly regs quota ran out.
- `TypeError` — the call isn't a registered SDK method (`… is not a function`)
  or the RPC message was malformed.

Failures of the `execute` call itself (not thrown inside your code) use the
same envelope: `PolicyError` (preflight rejected the code, including parse
errors), `SandboxUnavailable` (no runner), and a timeout when `timeoutMs` is
exceeded.

Inside `execute` a thrown error is captured by `execute`'s own
`{ ok: false, error: { name, message, stack } }` envelope and surfaces to
the MCP client as a normal tool result (no `isError` field) whose text block
contains that structured error JSON — inspect `ok`, not `isError`.

## Style guidelines for sandboxed code

- Prefer `fields` on `fr.documents.search` to keep payloads small.
- For exploratory queries, set `per_page` low (5–25) then drill down.
- `ecfr.full` returns large XML; pass a `query` (at least `{ part }`) to
  stay under a few MB.
- Cache idempotent calls in your own code; the host LRU caches identical
  URL hits for 5 minutes by default.
