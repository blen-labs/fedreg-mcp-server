# SDK reference

Inside `execute`, two globals are available — `fr` for FederalRegister.gov v1
and `ecfr` for the Electronic Code of Federal Regulations. Both return plain
JSON; all methods are `async` and resolve with the upstream payload.

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
| `results(opts)` | Search results across the eCFR. `opts.query`, `opts.agency_slugs`, `opts.title`, `opts.last_modified_after/before`, `opts.date`, `opts.per_page`, `opts.page`. |
| `counts_daily(opts)` | Result counts grouped by day. |
| `counts_hierarchy(opts)` | Result counts grouped by CFR hierarchy. |
| `counts_titles(opts)` | Result counts grouped by title. |
| `suggestions(opts)` | Did-you-mean suggestions. |

## Errors

The SDK throws (and the proxy re-throws inside the sandbox) named errors:

- `HttpError` — non-2xx upstream response. `message` includes method, URL,
  and status code.
- `ValidationError` — a parameter failed local validation before sending.
- `TimeoutError` — the upstream call exceeded `FEDREG_UPSTREAM_TIMEOUT_MS`.

Inside `execute` the result of a thrown error is captured by `execute`'s
own `{ ok: false, error: { name, message, stack } }` envelope, so a thrown
`HttpError` will surface to the MCP client as an `isError: false` tool result
that contains the structured error JSON.

## Style guidelines for sandboxed code

- Prefer `fields` on `fr.documents.search` to keep payloads small.
- For exploratory queries, set `per_page` low (5–25) then drill down.
- `ecfr.full` returns large XML; pass a `scope` (at least `{ part }`) to
  stay under a few MB.
- Cache idempotent calls in your own code; the host LRU caches identical
  URL hits for 5 minutes by default.
