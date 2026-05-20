# Examples

Each file here is a snippet you can paste into the `execute` tool. They're
written as standalone TypeScript so editors can syntax-check them; the
`declare const fr: any` / `declare const ecfr: any` lines exist only to keep
the type checker happy outside the sandbox.

| File | Demonstrates |
|------|--------------|
| [`fr-search.ts`](./fr-search.ts) | Federal Register: structured `documents.search` with `conditions`, `fields`, ordering. |
| [`ecfr-search.ts`](./ecfr-search.ts) | eCFR: `counts_hierarchy` + paginated `search.results` for one agency. |

## Tips for sandboxed code

- Prefer `fields` on `fr.documents.search` to keep responses small.
- For exploratory queries, set `per_page` low (5–25) and only widen when
  you know what you're after.
- `ecfr.full` returns large XML — always pass a `scope` (at least `{ part }`)
  to stay under a few MB.
- Use `await` freely; the proxies are async by construction.
- Errors thrown inside `execute` (including `HttpError` from a non-2xx
  upstream response) are captured in the result envelope's `error` field —
  you don't need a `try/catch` unless you want to handle them inline.

See [`../docs/sdk-reference.md`](../docs/sdk-reference.md) for the full
method list, or call `search_api({ query: '...' })` / `describe_schema(...)`
from inside the model.
