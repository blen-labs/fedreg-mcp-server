# Examples

Each file here is a snippet you can paste verbatim into the `execute` tool.
They're plain JavaScript — the sandbox rejects TypeScript type annotations —
and use top-level `await` and `return`, which `execute` allows because it wraps
your code in an async function. `fr`, `ecfr`, and `regs` are sandbox globals,
so the files aren't runnable with plain `node`.

| File | Demonstrates |
|------|--------------|
| [`fr-search.js`](./fr-search.js) | Federal Register: structured `documents.search` with `conditions`, `fields`, ordering. |
| [`ecfr-search.js`](./ecfr-search.js) | eCFR: `counts_hierarchy` + paginated `search.results` for one agency. |
| [`regs-comments.js`](./regs-comments.js) | regulations.gov: the fr → regs bridge — find a rule, then pull its public comments via `objectId`. |

## Tips for sandboxed code

- Prefer `fields` on `fr.documents.search` to keep responses small.
- For exploratory queries, set `per_page` low (5–25) and only widen when
  you know what you're after.
- `ecfr.full` returns large XML — always pass a `query` (at least `{ part }`)
  to stay under a few MB.
- Use `await` freely; the proxies are async by construction.
- Errors thrown inside `execute` (including `HttpError` from a non-2xx
  upstream response) are captured in the result envelope's `error` field —
  you don't need a `try/catch` unless you want to handle them inline.

See [`../docs/sdk-reference.md`](../docs/sdk-reference.md) for the full
method list, or call `search_api({ query: '...' })` / `describe_schema(...)`
from inside the model.
