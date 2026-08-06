# SDK reference

Inside `execute`, up to three globals are available — `fr` for
FederalRegister.gov v1, `ecfr` for the Electronic Code of Federal Regulations,
and `regs` for regulations.gov v4. All return plain JSON; every method is
`async` and resolves with the upstream payload.

> `regs` is injected only when `FEDREG_REGS_API_KEY` is set. Without a key the
> source is disabled and `regs.*` calls return a `SourceUnavailable` error;
> `fr` and `ecfr` are unaffected.

You can always discover the full surface from inside the model:

```ts
await search_api({ query: 'methane rules EPA' });
await describe_schema({ prefix: 'fr.documents' });
```

## `fr.*` — FederalRegister.gov v1

### `fr.documents`

| Method | Returns | Notes |
|--------|---------|-------|
| `search(opts)` | `{ count, total_pages, results: Doc[], next_page_url? }` | `opts.conditions` is a structured filter; common keys: `term`, `agencies` (slugs), `publication_date: { gte, lte, year, is }`, `type` (e.g. `RULE`, `PRORULE`, `NOTICE`, `PRESDOCU`), `topics`, `docket_id`, `regulation_id_number`. `fields` narrows the response. `per_page` (max 1000 with `fields`, else 20), `page`, `order` (`relevance` \| `newest` \| `oldest` \| `executive_order_number`). |
| `get(documentNumber)` | `Doc` | Single document by `document_number` (e.g. `'2024-12345'`). |
| `getMany(documentNumbers, fields?)` | `Doc[]` | Multi-fetch up to ~20 documents in one request. |
| `facets({ facet, conditions? })` | `Record<string, { count, name? }>` | `facet`: `daily` \| `weekly` \| `monthly` \| `quarterly` \| `yearly` \| `agency` \| `topic` \| `section` \| `subtype` \| `type`. |

### `fr.publicInspection`

| Method | Returns |
|--------|---------|
| `current()` | Documents on public inspection right now. |
| `byDate(date)` | Documents on public inspection on `YYYY-MM-DD`. |
| `get(documentNumber)` | Single PI document. |

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
| `list({ sections? })` | Editorially curated searches, optionally filtered to a section slug. |

### `fr.images`

| Method | Returns |
|--------|---------|
| `get(identifier)` | Image metadata for the given image identifier. |

## `ecfr.*` — Electronic Code of Federal Regulations

### `ecfr.titles`

| Method | Returns |
|--------|---------|
| `list()` | All 50 CFR titles with their latest amendment dates. |

### `ecfr.admin.agencies`

| Method | Returns |
|--------|---------|
| `list()` | Agencies and their CFR references. |

### Versioned structure / content

All of the below take a date as `YYYY-MM-DD` plus a numeric title, and an
optional positional filter (`{ chapter, subchapter, part, subpart, section }`)
to scope the response.

| Method | Returns |
|--------|---------|
| `ecfr.structure(date, title, scope?)` | Hierarchical TOC for the title (or sub-scope). |
| `ecfr.ancestry(date, title, scope?)` | The ancestor chain (title → chapter → … → leaf). |
| `ecfr.versions(date, title, scope?)` | Amendment history for the selected slice. |
| `ecfr.full(date, title, scope?)` | Full XML/HTML content of the slice. |

### `ecfr.search`

| Method | Returns |
|--------|---------|
| `results(opts)` | Search results across the eCFR. `opts.query`, `opts.agency_slugs`, `opts.hierarchy` (`{ title, subtitle, chapter, subchapter, part, subpart, section, appendix }`), `opts.last_modified_after/before`, `opts.date`, `opts.per_page`, `opts.page`, `opts.order` (`relevance` \| `hierarchy` \| `newest` \| `oldest`). |
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
- `TimeoutError` — the upstream call exceeded `FEDREG_UPSTREAM_TIMEOUT_MS`.
- `SourceUnavailable` — the source is registered but disabled (e.g. `regs.*`
  without `FEDREG_REGS_API_KEY`).
- `RateLimited` / `RegsRateLimited` — an upstream 429 (never retried for
  `regs`) / the process-wide hourly regs bucket ran dry.
- `RegsCallBudgetExceeded` — the per-`execute()` regs call budget
  (`FEDREG_REGS_MAX_CALLS_PER_EXECUTE`) ran out.
- `RegsSubjectQuotaExceeded` — the per-subject hourly regs quota ran out.

Inside `execute` a thrown error is captured by `execute`'s own
`{ ok: false, error: { name, message, stack } }` envelope and surfaces to
the MCP client as a normal tool result (no `isError` field) whose text block
contains that structured error JSON — inspect `ok`, not `isError`.

## Style guidelines for sandboxed code

- Prefer `fields` on `fr.documents.search` to keep payloads small.
- For exploratory queries, set `per_page` low (5–25) then drill down.
- `ecfr.full` returns large XML; pass a `scope` (at least `{ part }`) to
  stay under a few MB.
- Cache idempotent calls in your own code; the host LRU caches identical
  URL hits for 5 minutes by default.
