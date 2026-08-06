# regulations.gov Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add regulations.gov v4 as a third data source (`regs.*`: documents, comments, dockets) to the fedreg-mcp-server, behind a pluggable Source registry, without leaking the API key or letting one tenant exhaust the shared key.

**Architecture:** Replace the hardcoded `'fr' | 'ecfr'` binding union with a `Source` contract + `getSources()` registry. The registry drives the runtime (`dispatch`), the sandbox global injection, the BM25 corpus, and the tool catalog. The regulations.gov client (`regs`) holds its `X-Api-Key` inside `HttpClient`'s `#private` field (never on enumerable metadata), degrades gracefully when no key is set, and is bounded by lean rate guardrails (no 429 retry + per-execute call budget).

**Tech Stack:** TypeScript (ESM, NodeNext), `@modelcontextprotocol/sdk`, `undici` (HTTP + `MockAgent` in tests), `zod`, `acorn` AST preflight, `isolated-vm` / Deno sandboxes, `vitest`.

**Spec:** `docs/superpowers/specs/2026-05-24-regulations-gov-support-design.md`

---

## Conventions for this plan

- **Test runner:** `pnpm test` (the package script) may be blocked in this environment, and `isolated-vm` may not load on Node 24. Per-task commands use **`npx vitest run <file>`** for targeted runs and **`npx tsc --noEmit`** for typecheck. Sandbox-execution tests are **gated on `await runner.available()`** so they pass whether or not a runner is present.
- **Every task ends with a commit** on the feature branch (Task 1). If you have not been authorized to commit, stop after Task 1 and confirm.
- **TDD:** write the failing test, watch it fail, implement the minimum, watch it pass, commit.
- ESM imports use the `.js` extension on relative paths (NodeNext), even for `.ts` sources. Match the existing style.

---

## File Structure

New files:
- `src/sdk/sources/source.ts` — `Source` / `SourceMeta` / `SourceConfig` contracts.
- `src/sdk/sources/corpus-loader.ts` — reads `schema/<name>.json` for a source.
- `src/sdk/sources/fr.ts`, `src/sdk/sources/ecfr.ts`, `src/sdk/sources/regs.ts` — source factories.
- `src/sdk/sources/index.ts` — `getSources(cfg)` registry + startup name validation.
- `src/sdk/regs-client.ts` — `RegulationsClient` + `toJsonApiQuery`.
- `schema/fr.json`, `schema/ecfr.json`, `schema/regs.json` — per-source corpora (replace `field-dictionary.json`).
- `test/regs-client.spec.ts`, `test/sources.spec.ts`, `test/bindings.spec.ts`.

Modified:
- `src/util/httpClient.ts` — `#defaultHeaders`, `retry429`, `RateLimited` on 429.
- `src/sdk/bindings.ts` — registry-driven `buildSdk`.
- `src/sdk/runtime.ts` — `binding: string`, dispatch-by-name, `SourceUnavailable`.
- `src/search/corpus.ts` — `CorpusEntry.binding: string`, `buildCorpus(sources)`, `lookupByPathOrPrefix(entries, …)`.
- `src/tools/searchApi.ts`, `src/tools/describeSchema.ts`, `src/tools/execute.ts` — take deps explicitly.
- `src/server/toolCatalog.ts` — richer `CatalogDeps`, dynamic descriptions.
- `src/sandbox/types.ts`, `src/sandbox/isolate.ts`, `src/sandbox/deno.ts` — `bindings: string[]`, dynamic injection.
- `src/sandbox/policy.ts` — export `BANNED_GLOBALS`.
- `src/supervisor/index.ts`, `src/bin.ts` — regs config wiring.
- `test/sdk.spec.ts`, `test/search.spec.ts` — mechanical updates.
- `README.md`, `.env.example`, `docs/sdk-reference.md`, `docs/architecture.md`, `package.json`, `mcpb-build/manifest.json`.

Deleted/replaced:
- `src/sdk/generated.d.ts` (deleted — unreferenced).
- `schema/field-dictionary.json` (replaced by per-source files).

---

## Phase 1 — Setup

### Task 1: Create the feature branch

**Files:** none (git only)

- [ ] **Step 1: Create and switch to the branch**

Run:
```bash
git checkout -b feat/regulations-gov-support
```
Expected: `Switched to a new branch 'feat/regulations-gov-support'`

- [ ] **Step 2: Confirm clean baseline**

Run: `git status --short`
Expected: only the untracked spec under `docs/superpowers/specs/` (and this plan).

### Task 2: Commit the spec and plan

**Files:**
- Add: `docs/superpowers/specs/2026-05-24-regulations-gov-support-design.md`
- Add: `docs/superpowers/plans/2026-05-24-regulations-gov-support.md`

- [ ] **Step 1: Commit**

```bash
git add docs/superpowers/
git commit -m "docs: regulations.gov design spec + implementation plan"
```

---

## Phase 2 — HttpClient guardrails

### Task 3: `HttpClient` default headers (private) + 429 handling

**Files:**
- Modify: `src/util/httpClient.ts`
- Test: `test/http.spec.ts` (append cases)

Rationale: the API key must live in a `#private` field (not enumerable, absent from `JSON.stringify`). regs disables 429 retry so it surfaces `RateLimited` instead of amplifying against the shared key.

- [ ] **Step 1: Write the failing tests**

Append to `test/http.spec.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent } from 'undici';
import { HttpClient } from '../src/util/httpClient.js';

describe('HttpClient default headers + 429', () => {
  let agent: MockAgent;
  const ORIGIN = 'https://api.example.gov';
  beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); });
  afterEach(async () => { await agent.close(); });

  function client(extra: Record<string, unknown> = {}) {
    return new HttpClient({ baseUrl: ORIGIN, dispatcher: agent, retries: 2, cacheTtlMs: 0, cacheMaxItems: 0, ...extra });
  }

  it('sends defaultHeaders and never exposes them via JSON.stringify', async () => {
    let seen: Record<string, unknown> = {};
    agent.get(ORIGIN).intercept({ path: '/v4/documents', method: 'GET' })
      .reply(200, (opts) => { seen = (opts.headers ?? {}) as Record<string, unknown>; return { data: [] }; });
    const c = client({ defaultHeaders: { 'X-Api-Key': 'SECRET-KEY' } });
    await c.call({ path: '/v4/documents' });
    const headerVal = Object.entries(seen).find(([k]) => k.toLowerCase() === 'x-api-key')?.[1];
    expect(headerVal).toBe('SECRET-KEY');
    expect(JSON.stringify(c)).not.toContain('SECRET-KEY');
  });

  it('per-call headers win over defaultHeaders', async () => {
    let seen: Record<string, unknown> = {};
    agent.get(ORIGIN).intercept({ path: '/x', method: 'GET' })
      .reply(200, (opts) => { seen = (opts.headers ?? {}) as Record<string, unknown>; return {}; });
    const c = client({ defaultHeaders: { 'X-Api-Key': 'A' } });
    await c.call({ path: '/x', headers: { 'X-Api-Key': 'B' } });
    const v = Object.entries(seen).find(([k]) => k.toLowerCase() === 'x-api-key')?.[1];
    expect(v).toBe('B');
  });

  it('with retry429=false a 429 throws RateLimited and is not retried', async () => {
    agent.get(ORIGIN).intercept({ path: '/lim', method: 'GET' })
      .reply(429, 'slow down', { headers: { 'retry-after': '7' } });
    const c = client({ retry429: false });
    await expect(c.call({ path: '/lim' })).rejects.toMatchObject({ name: 'RateLimited' });
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run test/http.spec.ts`
Expected: FAIL (`defaultHeaders` ignored / `RateLimited` not thrown).

- [ ] **Step 3: Rewrite `src/util/httpClient.ts`**

```ts
import { request, type Dispatcher } from 'undici';
import { LRUCache } from 'lru-cache';
import { log } from './logger.js';

export interface HttpClientOptions {
  baseUrl: string;
  userAgent?: string;
  timeoutMs?: number;
  retries?: number;
  cacheTtlMs?: number;
  cacheMaxItems?: number;
  dispatcher?: Dispatcher;
  defaultHeaders?: Record<string, string>;
  retry429?: boolean;
}

export interface CallOptions {
  method?: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | boolean | string[] | undefined>;
  headers?: Record<string, string>;
  accept?: 'json' | 'xml' | 'text';
  body?: unknown;
}

export class HttpClient {
  #defaultHeaders: Record<string, string>;
  private readonly cache: LRUCache<string, { status: number; body: unknown; headers: Record<string, string> }>;
  private readonly cacheEnabled: boolean;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retry429: boolean;
  private readonly dispatcher?: Dispatcher;

  constructor(opts: HttpClientOptions) {
    this.#defaultHeaders = opts.defaultHeaders ?? {};
    this.baseUrl = opts.baseUrl;
    this.userAgent = opts.userAgent ?? 'fedreg-mcp-server/1.0 (+https://github.com/blen-labs/fedreg-mcp-server)';
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retries = opts.retries ?? 3;
    this.retry429 = opts.retry429 ?? true;
    this.dispatcher = opts.dispatcher;
    const max = opts.cacheMaxItems ?? 2000;
    const ttl = opts.cacheTtlMs ?? 300_000;
    this.cacheEnabled = max > 0 && ttl > 0;
    this.cache = new LRUCache({ max: Math.max(max, 1), ttl: Math.max(ttl, 1) });
  }

  async call<T = unknown>(o: CallOptions): Promise<T> {
    const url = this.buildUrl(o.path, o.query);
    const method = o.method ?? 'GET';
    const key = method === 'GET' && this.cacheEnabled ? url : '';
    if (key && this.cache.has(key)) {
      log.debug('http.cache_hit', { url });
      return this.cache.get(key)!.body as T;
    }

    const accept =
      o.accept === 'xml' ? 'application/xml,text/xml'
      : o.accept === 'text' ? 'text/plain'
      : 'application/json';

    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= this.retries) {
      try {
        const res = await request(url, {
          method,
          headers: {
            'accept': accept,
            'user-agent': this.userAgent,
            ...this.#defaultHeaders,
            ...(o.body ? { 'content-type': 'application/json' } : {}),
            ...(o.headers ?? {}),
          },
          body: o.body ? JSON.stringify(o.body) : undefined,
          bodyTimeout: this.timeoutMs,
          headersTimeout: this.timeoutMs,
          ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
        });

        if (res.statusCode >= 400) {
          const text = await res.body.text();
          const err = new HttpError(`${method} ${url} -> ${res.statusCode}`, res.statusCode, text);
          if (res.statusCode === 429) {
            const retryAfter = Array.isArray(res.headers['retry-after']) ? res.headers['retry-after'][0] : res.headers['retry-after'];
            err.name = 'RateLimited';
            err.message = `${method} ${url} -> 429 Too Many Requests${retryAfter ? ` (retry-after ${retryAfter})` : ''}`;
          }
          throw err;
        }

        let body: unknown;
        if (accept.startsWith('application/json')) body = await res.body.json();
        else body = await res.body.text();
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(',') : String(v ?? '');
        if (key) this.cache.set(key, { status: res.statusCode, body, headers });
        return body as T;
      } catch (err) {
        lastErr = err;
        const status = err instanceof HttpError ? err.status : 0;
        const retryable = status === 0 || (status === 429 && this.retry429) || status >= 500;
        if (!retryable || attempt === this.retries) break;
        const delay = Math.min(2 ** attempt * 250, 4000);
        await new Promise(r => setTimeout(r, delay));
        attempt++;
      }
    }
    throw lastErr;
  }

  private buildUrl(path: string, query?: CallOptions['query']): string {
    const base = this.baseUrl.replace(/\/$/, '');
    const p = path.startsWith('/') ? path : '/' + path;
    const url = new URL(base + p);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
        else url.searchParams.append(k, String(v));
      }
    }
    return url.toString();
  }
}

export class HttpError extends Error {
  constructor(message: string, public readonly status: number, public readonly bodySnippet: string) {
    super(message);
    this.name = 'HttpError';
  }
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run test/http.spec.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/util/httpClient.ts test/http.spec.ts
git commit -m "feat(http): private default headers + no-retry 429 (RateLimited)"
```

---

## Phase 2 (cont.) — Registry refactor (no behavior change for fr/ecfr)

### Task 4 (2a): Split the corpus into per-source files

**Files:**
- Create: `schema/fr.json`, `schema/ecfr.json`
- Delete: `schema/field-dictionary.json`
- Modify: `src/search/corpus.ts`

- [ ] **Step 1: Generate the per-source files from the current corpus**

Run (mechanical split by `binding`, preserves all entries):
```bash
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const raw = JSON.parse(readFileSync("schema/field-dictionary.json","utf8"));
for (const b of ["fr","ecfr"]) {
  writeFileSync(`schema/${b}.json`, JSON.stringify({
    endpoints: raw.endpoints.filter(e => e.binding === b),
    fields: raw.fields.filter(e => e.binding === b),
  }, null, 2) + "\n");
}
console.log("fr endpoints:", raw.endpoints.filter(e=>e.binding==="fr").length);
console.log("ecfr endpoints:", raw.endpoints.filter(e=>e.binding==="ecfr").length);
'
```
Expected: prints non-zero counts; creates `schema/fr.json`, `schema/ecfr.json`.

- [ ] **Step 2: Point the loader at the per-source files**

In `src/search/corpus.ts`, replace the body of `getCorpus()` (the single-file read) with a merge over a fixed list. Replace:
```ts
  const path = resolve(__dirname, '../../schema/field-dictionary.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as FieldDictionary;
  const index = new Bm25Index();
  const entries = new Map<string, CorpusEntry>();
  for (const e of [...raw.endpoints, ...raw.fields]) {
```
with:
```ts
  const index = new Bm25Index();
  const entries = new Map<string, CorpusEntry>();
  const sourceFiles = ['fr', 'ecfr'];
  const merged: CorpusEntry[] = [];
  for (const name of sourceFiles) {
    const path = resolve(__dirname, `../../schema/${name}.json`);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as FieldDictionary;
    merged.push(...raw.endpoints, ...raw.fields);
  }
  for (const e of merged) {
```

- [ ] **Step 3: Run existing corpus tests, expect PASS**

Run: `npx vitest run test/search.spec.ts`
Expected: PASS (same corpus content, new layout).

- [ ] **Step 4: Remove the old file**

```bash
git rm schema/field-dictionary.json
```

- [ ] **Step 5: Commit**

```bash
git add schema/fr.json schema/ecfr.json src/search/corpus.ts
git commit -m "refactor(corpus): split field-dictionary into per-source schema files"
```

### Task 5 (2b): Widen `CorpusEntry.binding` to `string`; export `BANNED_GLOBALS`

**Files:**
- Modify: `src/search/corpus.ts`, `src/sandbox/policy.ts`

- [ ] **Step 1: Widen the type**

In `src/search/corpus.ts`, change `CorpusEntry.binding` from `'fr' | 'ecfr'` to `string`:
```ts
export interface CorpusEntry {
  id: string;
  kind: 'endpoint' | 'field';
  binding: string;        // source name: 'fr' | 'ecfr' | 'regs' | …
  description: string;
  example?: string;
  signature?: string;
}
```

- [ ] **Step 2: Export `BANNED_GLOBALS` for reuse by the registry denylist**

In `src/sandbox/policy.ts`, change `const BANNED_GLOBALS = new Set([` to:
```ts
export const BANNED_GLOBALS = new Set([
```

- [ ] **Step 3: Run typecheck + tests, expect PASS**

Run: `npx tsc --noEmit && npx vitest run test/search.spec.ts test/sandbox.spec.ts`
Expected: PASS (string is a supertype of the old union; `binding: 'fr'` comparisons still hold).

- [ ] **Step 4: Commit**

```bash
git add src/search/corpus.ts src/sandbox/policy.ts
git commit -m "refactor: CorpusEntry.binding is string; export BANNED_GLOBALS"
```

### Task 6 (2c): Source contract, corpus loader, fr/ecfr factories, registry

**Files:**
- Create: `src/sdk/sources/source.ts`, `src/sdk/sources/corpus-loader.ts`, `src/sdk/sources/fr.ts`, `src/sdk/sources/ecfr.ts`, `src/sdk/sources/index.ts`
- Test: `test/sources.spec.ts`

Net-new files only; no existing callsites change yet.

- [ ] **Step 1: Write the failing test**

Create `test/sources.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { getSources } from '../src/sdk/sources/index.js';

function cfg(extra = {}) {
  return {
    frBaseUrl: 'https://www.federalregister.gov/api/v1',
    ecfrBaseUrl: 'https://www.ecfr.gov/api',
    regsBaseUrl: 'https://api.regulations.gov',
    userAgent: 'test/0.0', timeoutMs: 5000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0,
    ...extra,
  };
}

describe('source registry', () => {
  it('builds fr and ecfr as enabled sources with corpus', () => {
    const sources = getSources(cfg());
    const fr = sources.find(s => s.name === 'fr');
    const ecfr = sources.find(s => s.name === 'ecfr');
    expect(fr?.enabled).toBe(true);
    expect(ecfr?.enabled).toBe(true);
    expect(fr!.corpus.endpoints.length).toBeGreaterThan(0);
    expect(fr!.label).toBe('Federal Register');
  });

  it('never exposes secrets on the source object', () => {
    const sources = getSources(cfg());
    for (const s of sources) {
      expect(JSON.stringify(s)).not.toContain('X-Api-Key');
    }
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run test/sources.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `src/sdk/sources/source.ts`**

```ts
import type { Dispatcher } from 'undici';
import type { CorpusEntry } from '../../search/corpus.js';

export interface SourceMeta {
  name: string;          // sandbox global + RPC binding id
  label: string;         // human label, e.g. 'Federal Register'
  enabled: boolean;      // false when a required secret is missing
  disabledReason?: string;
}

export interface Source extends SourceMeta {
  client: object;        // host-side client reachable as <name>.* in the sandbox
  corpus: { endpoints: CorpusEntry[]; fields: CorpusEntry[] };
}

export interface SourceConfig {
  frBaseUrl: string;
  ecfrBaseUrl: string;
  regsBaseUrl: string;
  regsApiKey?: string;
  userAgent: string;
  timeoutMs: number;
  retries: number;
  cacheTtlMs: number;
  cacheMaxItems: number;
  dispatcher?: Dispatcher;
}
```

- [ ] **Step 4: Create `src/sdk/sources/corpus-loader.ts`**

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { CorpusEntry } from '../../search/corpus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadSourceCorpus(name: string): { endpoints: CorpusEntry[]; fields: CorpusEntry[] } {
  const path = resolve(__dirname, `../../../schema/${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as { endpoints: CorpusEntry[]; fields: CorpusEntry[] };
}
```

- [ ] **Step 5: Create `src/sdk/sources/fr.ts` and `src/sdk/sources/ecfr.ts`**

`src/sdk/sources/fr.ts`:
```ts
import { HttpClient } from '../../util/httpClient.js';
import { FederalRegisterClient } from '../fr-client.js';
import { loadSourceCorpus } from './corpus-loader.js';
import type { Source, SourceConfig } from './source.js';

export function createFrSource(cfg: SourceConfig): Source {
  const http = new HttpClient({
    baseUrl: cfg.frBaseUrl, userAgent: cfg.userAgent, timeoutMs: cfg.timeoutMs,
    retries: cfg.retries, cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: cfg.cacheMaxItems,
    ...(cfg.dispatcher ? { dispatcher: cfg.dispatcher } : {}),
  });
  return { name: 'fr', label: 'Federal Register', enabled: true, client: new FederalRegisterClient(http), corpus: loadSourceCorpus('fr') };
}
```

`src/sdk/sources/ecfr.ts`:
```ts
import { HttpClient } from '../../util/httpClient.js';
import { EcfrClient } from '../ecfr-client.js';
import { loadSourceCorpus } from './corpus-loader.js';
import type { Source, SourceConfig } from './source.js';

export function createEcfrSource(cfg: SourceConfig): Source {
  const http = new HttpClient({
    baseUrl: cfg.ecfrBaseUrl, userAgent: cfg.userAgent, timeoutMs: cfg.timeoutMs,
    retries: cfg.retries, cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: cfg.cacheMaxItems,
    ...(cfg.dispatcher ? { dispatcher: cfg.dispatcher } : {}),
  });
  return { name: 'ecfr', label: 'eCFR', enabled: true, client: new EcfrClient(http), corpus: loadSourceCorpus('ecfr') };
}
```

- [ ] **Step 6: Create `src/sdk/sources/index.ts` (registry + validation)**

```ts
import { BANNED_GLOBALS } from '../../sandbox/policy.js';
import { createFrSource } from './fr.js';
import { createEcfrSource } from './ecfr.js';
import type { Source, SourceConfig } from './source.js';

export type { Source, SourceMeta, SourceConfig } from './source.js';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NAME_DENYLIST = new Set<string>([...BANNED_GLOBALS, 'console', 'global', 'globalThis']);

export function getSources(cfg: SourceConfig): Source[] {
  const sources: Source[] = [createFrSource(cfg), createEcfrSource(cfg)];
  const seen = new Set<string>();
  for (const s of sources) {
    if (!IDENTIFIER.test(s.name)) throw new Error(`Invalid source name '${s.name}': must be a JS identifier`);
    if (NAME_DENYLIST.has(s.name)) throw new Error(`Source name '${s.name}' is not allowed (collides with a sandbox global)`);
    if (seen.has(s.name)) throw new Error(`Duplicate source name '${s.name}'`);
    seen.add(s.name);
  }
  return sources;
}
```

- [ ] **Step 7: Run, expect PASS**

Run: `npx vitest run test/sources.spec.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/sdk/sources test/sources.spec.ts
git commit -m "feat(sdk): Source contract + registry with fr/ecfr factories"
```

### Task 7 (2d): Registry-driven `buildSdk` + dispatch-by-name

**Files:**
- Modify: `src/sdk/bindings.ts`, `src/sdk/runtime.ts`, `src/supervisor/index.ts`, `src/server/toolCatalog.ts`, `src/tools/execute.ts`, `src/bin.ts`
- Test: `test/bindings.spec.ts`; update `test/sdk.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `test/bindings.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildSdk } from '../src/sdk/bindings.js';
import { dispatch } from '../src/sdk/runtime.js';

function cfg() {
  return {
    frBaseUrl: 'https://www.federalregister.gov/api/v1',
    ecfrBaseUrl: 'https://www.ecfr.gov/api',
    regsBaseUrl: 'https://api.regulations.gov',
    userAgent: 'test/0.0', timeoutMs: 5000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0,
  };
}

describe('buildSdk + dispatch', () => {
  it('exposes enabled clients and registered names', () => {
    const sdk = buildSdk(cfg());
    expect(sdk.registeredNames).toEqual(['fr', 'ecfr']);
    expect(Object.keys(sdk.clients).sort()).toEqual(['ecfr', 'fr']);
    expect(sdk.meta.find(m => m.name === 'fr')?.enabled).toBe(true);
  });

  it('dispatch returns TypeError for an unknown binding', async () => {
    const sdk = buildSdk(cfg());
    const res = await dispatch({ clients: sdk.clients, meta: sdk.meta }, { binding: 'nope', path: ['x'], args: [] });
    expect(res.ok).toBe(false);
    expect(res.error?.name).toBe('TypeError');
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run test/bindings.spec.ts`
Expected: FAIL (`registeredNames`/`clients` undefined; dispatch signature mismatch).

- [ ] **Step 3: Rewrite `src/sdk/bindings.ts`**

```ts
import { getSources, type SourceConfig } from './sources/index.js';
import type { SourceMeta } from './sources/source.js';

export interface Sdk {
  clients: Record<string, object>;   // enabled sources only
  meta: SourceMeta[];                // all registered sources (redacted)
  registeredNames: string[];         // all names (drives global injection)
  version: () => string;
}

export function buildSdk(cfg: SourceConfig): Sdk {
  const sources = getSources(cfg);
  const clients: Record<string, object> = {};
  for (const s of sources) if (s.enabled) clients[s.name] = s.client;
  return {
    clients,
    meta: sources.map(({ name, label, enabled, disabledReason }) => ({ name, label, enabled, disabledReason })),
    registeredNames: sources.map(s => s.name),
    version: () => '1.0.0',
  };
}
```

- [ ] **Step 4: Rewrite `src/sdk/runtime.ts`**

```ts
import type { SourceMeta } from './sources/source.js';

export interface RpcRequest {
  binding: string;
  path: string[];
  args: unknown[];
}

export interface RpcResponse {
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string; status?: number };
}

export interface DispatchRegistry {
  clients: Record<string, object>;
  meta: SourceMeta[];
}

export async function dispatch(reg: DispatchRegistry, req: RpcRequest): Promise<RpcResponse> {
  const client = reg.clients[req.binding];
  if (!client) {
    const m = reg.meta.find(x => x.name === req.binding);
    if (m && !m.enabled) {
      return { ok: false, error: { name: 'SourceUnavailable', message: m.disabledReason ?? `${m.label} is unavailable` } };
    }
    return { ok: false, error: { name: 'TypeError', message: `Cannot resolve binding '${req.binding}'` } };
  }
  try {
    let cur: unknown = client;
    let parent: unknown = client;
    for (const seg of req.path) {
      if (cur === null || typeof cur !== 'object') {
        return { ok: false, error: { name: 'TypeError', message: `Cannot resolve ${req.binding}.${req.path.join('.')}` } };
      }
      parent = cur;
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (typeof cur !== 'function') {
      return { ok: false, error: { name: 'TypeError', message: `${req.binding}.${req.path.join('.')} is not a function` } };
    }
    const value = await (cur as (...a: unknown[]) => unknown).apply(parent, req.args);
    return { ok: true, value };
  } catch (err) {
    const e = err as { name?: string; message?: string; status?: number };
    return { ok: false, error: { name: e.name ?? 'Error', message: e.message ?? String(err), status: e.status } };
  }
}
```

- [ ] **Step 5: Update `src/tools/execute.ts` to the new dispatch shape**

```ts
import { z } from 'zod';
import type { Sdk } from '../sdk/bindings.js';
import { dispatch } from '../sdk/runtime.js';
import type { SandboxRunner } from '../sandbox/types.js';

export const ExecuteInput = z.object({
  code: z.string().min(1).describe('TypeScript code to run inside the sandbox. SDK globals are bound per source (e.g. `fr`, `ecfr`, `regs`).'),
  timeoutMs: z.number().int().min(100).max(60_000).default(15_000),
  memoryMb: z.number().int().min(16).max(256).default(64),
});

export type ExecuteInputT = z.infer<typeof ExecuteInput>;

export interface ExecuteDeps {
  sdk: Sdk;
  sandbox: SandboxRunner;
}

export async function execute(input: ExecuteInputT, deps: ExecuteDeps) {
  return deps.sandbox.execute(
    { code: input.code, timeoutMs: input.timeoutMs, memoryMb: input.memoryMb, bindings: deps.sdk.registeredNames },
    { dispatch: (req) => dispatch({ clients: deps.sdk.clients, meta: deps.sdk.meta }, req) },
  );
}
```
(Note: `ExecuteOptions.bindings` is added in Task 9; until then TS will flag it — Task 9 follows immediately. To keep this task green on its own, also do Task 9's Step 3 type change to `ExecuteOptions` now, or run Tasks 7→9 before the typecheck gate. The dependency is called out in Task 9.)

- [ ] **Step 6: Update `src/supervisor/index.ts`**

```ts
import { buildSdk } from '../sdk/bindings.js';
import { pickSandbox } from '../sandbox/index.js';
import type { CatalogDeps } from '../server/toolCatalog.js';
import type { SandboxKind } from '../sandbox/types.js';

export interface SupervisorConfig {
  frBaseUrl: string;
  ecfrBaseUrl: string;
  regsBaseUrl: string;
  regsApiKey?: string;
  userAgent: string;
  upstreamTimeoutMs: number;
  upstreamRetries: number;
  cacheTtlMs: number;
  cacheMaxItems: number;
  sandbox: SandboxKind;
}

export async function buildSupervisor(cfg: SupervisorConfig): Promise<CatalogDeps> {
  const sdk = buildSdk({
    frBaseUrl: cfg.frBaseUrl,
    ecfrBaseUrl: cfg.ecfrBaseUrl,
    regsBaseUrl: cfg.regsBaseUrl,
    regsApiKey: cfg.regsApiKey,
    userAgent: cfg.userAgent,
    timeoutMs: cfg.upstreamTimeoutMs,
    retries: cfg.upstreamRetries,
    cacheTtlMs: cfg.cacheTtlMs,
    cacheMaxItems: cfg.cacheMaxItems,
  });
  const sandbox = await pickSandbox(cfg.sandbox);
  return { sdk, sandbox };
}
```

- [ ] **Step 7: Update `src/server/toolCatalog.ts` (`CatalogDeps`, execute handler)**

Change `CatalogDeps` and the execute handler to use `sdk`:
```ts
import type { Sdk } from '../sdk/bindings.js';
import type { SandboxRunner } from '../sandbox/types.js';

export interface CatalogDeps {
  sdk: Sdk;
  sandbox: SandboxRunner;
}
```
And in `buildCatalog`, the execute tool description becomes dynamic:
```ts
{
  name: 'execute',
  description:
    `Run TypeScript inside a sandbox (no net, fs, env, or subprocess). Globals: ${deps.sdk.registeredNames.join(', ')}. Return the awaited expression as the result.`,
  inputSchema: zodToJsonSchema(ExecuteInput),
  handler: async (args) => execute(ExecuteInput.parse(args), deps),
},
```
(`search_api` / `describe_schema` handlers are updated in Task 8.)

- [ ] **Step 8: Update `src/bin.ts` to pass the new config**

In the `buildSupervisor({ … })` call, add after `ecfrBaseUrl`:
```ts
    regsBaseUrl: process.env.FEDREG_REGS_BASE_URL ?? 'https://api.regulations.gov',
    regsApiKey: process.env.FEDREG_REGS_API_KEY,
```

- [ ] **Step 9: Update `test/sdk.spec.ts` (decouple from buildSdk shape)**

Replace the `sdk()` helper and its uses so the client classes are constructed directly (they are unchanged):
```ts
import { FederalRegisterClient } from '../src/sdk/fr-client.js';
import { EcfrClient } from '../src/sdk/ecfr-client.js';
import { HttpClient } from '../src/util/httpClient.js';

function frClient() {
  return new FederalRegisterClient(new HttpClient({ baseUrl: `${FR_ORIGIN}/api/v1`, userAgent: 'test/0.0', timeoutMs: 5000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0, dispatcher: agent }));
}
function ecfrClient() {
  return new EcfrClient(new HttpClient({ baseUrl: `${ECFR_ORIGIN}/api`, userAgent: 'test/0.0', timeoutMs: 5000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0, dispatcher: agent }));
}
```
Then replace `sdk().fr.` with `frClient().` and `sdk().ecfr.` with `ecfrClient().` throughout, and delete the old `buildSdk`-based `sdk()` helper + its import.

- [ ] **Step 10: Run, expect PASS**

Run: `npx vitest run test/bindings.spec.ts test/sdk.spec.ts && npx tsc --noEmit`
Expected: PASS (do Task 9 Step 3 first if `bindings` type errors appear).

- [ ] **Step 11: Commit**

```bash
git add src/sdk/bindings.ts src/sdk/runtime.ts src/tools/execute.ts src/supervisor/index.ts src/server/toolCatalog.ts src/bin.ts test/bindings.spec.ts test/sdk.spec.ts
git commit -m "refactor(sdk): registry-driven buildSdk + dispatch-by-name"
```

### Task 8 (2e): Tools take corpus via deps; remove `getCorpus()` singleton

**Files:**
- Modify: `src/search/corpus.ts`, `src/tools/searchApi.ts`, `src/tools/describeSchema.ts`, `src/server/toolCatalog.ts`, `src/supervisor/index.ts`
- Update: `test/search.spec.ts`

- [ ] **Step 1: Update the failing test**

Rewrite `test/search.spec.ts`'s corpus/tool sections to build the corpus from sources and pass it in:
```ts
import { describe, it, expect } from 'vitest';
import { Bm25Index, tokenize } from '../src/search/bm25.js';
import { buildCorpus } from '../src/search/corpus.js';
import { getSources } from '../src/sdk/sources/index.js';
import { searchApi } from '../src/tools/searchApi.js';
import { describeSchema } from '../src/tools/describeSchema.js';

function corpus() {
  return buildCorpus(getSources({
    frBaseUrl: 'https://www.federalregister.gov/api/v1', ecfrBaseUrl: 'https://www.ecfr.gov/api',
    regsBaseUrl: 'https://api.regulations.gov', userAgent: 't', timeoutMs: 1, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0,
  }));
}

describe('bm25', () => {
  it('tokenizes', () => {
    expect(tokenize('Hello, world! THE quick brown fox.')).toEqual(['hello', 'world', 'quick', 'brown', 'fox']);
  });
});

describe('corpus', () => {
  it('loads endpoints and fields from sources', () => {
    const { entries } = corpus();
    expect(entries.has('fr.documents.search')).toBe(true);
    expect(entries.has('ecfr.search.results')).toBe(true);
  });
});

describe('search_api tool', () => {
  it('finds the eCFR search endpoint', () => {
    const { hits } = searchApi({ query: 'search the code of federal regulations text', k: 5 }, corpus());
    expect(hits.some(h => h.id === 'ecfr.search.results')).toBe(true);
  });
});

describe('describe_schema tool', () => {
  it('resolves an exact path', () => {
    const r = describeSchema({ path: 'fr.documents.search' }, corpus().entries);
    expect(r.found).toBe(true);
    if (r.found) expect(r.entries[0]?.binding).toBe('fr');
  });
  it('lists by prefix', () => {
    const r = describeSchema({ prefix: 'ecfr.' }, corpus().entries);
    expect(r.found).toBe(true);
  });
  it('returns not-found cleanly', () => {
    const r = describeSchema({ path: 'fr.nope' }, corpus().entries);
    expect(r.found).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run test/search.spec.ts`
Expected: FAIL (`buildCorpus` undefined; tools take 1 arg).

- [ ] **Step 3: Replace the loader in `src/search/corpus.ts`**

Remove the `getCorpus()` singleton, the `node:fs`/`node:url`/`node:path` imports, `__dirname`, the `cached` variable, and `FieldDictionary`. Keep `CorpusEntry`. Add:
```ts
import { Bm25Index } from './bm25.js';

export interface CorpusEntry {
  id: string;
  kind: 'endpoint' | 'field';
  binding: string;
  description: string;
  example?: string;
  signature?: string;
}

export interface Corpus {
  index: Bm25Index;
  entries: Map<string, CorpusEntry>;
}

export function buildCorpus(sources: Array<{ corpus: { endpoints: CorpusEntry[]; fields: CorpusEntry[] } }>): Corpus {
  const index = new Bm25Index();
  const entries = new Map<string, CorpusEntry>();
  for (const s of sources) {
    for (const e of [...s.corpus.endpoints, ...s.corpus.fields]) {
      entries.set(e.id, e);
      index.add({ id: e.id, text: [e.id, e.description, e.signature ?? '', e.example ?? ''].join(' ') });
    }
  }
  return { index, entries };
}

export function lookupByPathOrPrefix(entries: Map<string, CorpusEntry>, target: { path?: string; prefix?: string }): CorpusEntry[] {
  const all = [...entries.values()];
  if (target.path) {
    const hit = entries.get(target.path);
    return hit ? [hit] : [];
  }
  if (target.prefix) return all.filter(e => e.id.startsWith(target.prefix!));
  return [];
}
```

- [ ] **Step 4: Update `src/tools/searchApi.ts`**

```ts
import { z } from 'zod';
import type { Corpus } from '../search/corpus.js';

export const SearchApiInput = z.object({
  query: z.string().min(1).describe('Free-text query over endpoint and field documentation across all bound sources (fr.*, ecfr.*, regs.*).'),
  k: z.number().int().min(1).max(50).default(10).describe('Max number of results to return'),
});
export type SearchApiInputT = z.infer<typeof SearchApiInput>;

export interface SearchHit {
  id: string; kind: 'endpoint' | 'field'; binding: string;
  description: string; signature?: string; example?: string; score: number;
}

export function searchApi(input: SearchApiInputT, corpus: Corpus): { hits: SearchHit[]; note: string } {
  const scored = corpus.index.search(input.query, input.k);
  const hits: SearchHit[] = scored.map(s => {
    const e = corpus.entries.get(s.id)!;
    return { id: e.id, kind: e.kind, binding: e.binding, description: e.description, signature: e.signature, example: e.example, score: Math.round(s.score * 1000) / 1000 };
  });
  return { hits, note: 'Use describe_schema with `path` for exact lookup or `prefix` to explore a namespace. Use execute to run TypeScript against the bound source globals.' };
}
```

- [ ] **Step 5: Update `src/tools/describeSchema.ts`**

Change the result `binding` type to `string`, accept `entries`, and call `lookupByPathOrPrefix(entries, input)`:
```ts
import { z } from 'zod';
import { lookupByPathOrPrefix, type CorpusEntry } from '../search/corpus.js';

export const DescribeSchemaInput = z.object({
  path: z.string().optional().describe("Exact dotted id, e.g. 'fr.documents.search' or 'regs.comments.search'"),
  prefix: z.string().optional().describe("Prefix to enumerate, e.g. 'fr.documents' or 'regs.'"),
}).refine(v => Boolean(v.path) !== Boolean(v.prefix), { message: 'Provide exactly one of `path` or `prefix`' });
export type DescribeSchemaInputT = z.infer<typeof DescribeSchemaInput>;

export type DescribeSchemaResult =
  | { found: false; message: string }
  | { found: true; entries: Array<{ id: string; kind: 'endpoint' | 'field'; binding: string; description: string; signature?: string; example?: string }> };

export function describeSchema(input: DescribeSchemaInputT, entries: Map<string, CorpusEntry>): DescribeSchemaResult {
  const hits = lookupByPathOrPrefix(entries, input);
  if (hits.length === 0) {
    return { found: false, message: `No entries matched ${input.path ? `path '${input.path}'` : `prefix '${input.prefix}'`}.` };
  }
  return { found: true, entries: hits.map(e => ({ id: e.id, kind: e.kind, binding: e.binding, description: e.description, signature: e.signature, example: e.example })) };
}
```

- [ ] **Step 6: Wire corpus into `CatalogDeps` and handlers**

In `src/server/toolCatalog.ts`, add `corpus` to `CatalogDeps` and pass it:
```ts
import type { Corpus } from '../search/corpus.js';
// …
export interface CatalogDeps {
  sdk: Sdk;
  sandbox: SandboxRunner;
  corpus: Corpus;
}
// handlers:
handler: async (args) => searchApi(SearchApiInput.parse(args), deps.corpus),
// …
handler: async (args) => describeSchema(DescribeSchemaInput.parse(args), deps.corpus.entries),
```
In `src/supervisor/index.ts`, build the corpus from the same sources and include it. Replace the body to call `getSources` once:
```ts
import { buildSdk } from '../sdk/bindings.js';
import { getSources } from '../sdk/sources/index.js';
import { buildCorpus } from '../search/corpus.js';
import { pickSandbox } from '../sandbox/index.js';
// …
export async function buildSupervisor(cfg: SupervisorConfig): Promise<CatalogDeps> {
  const sourceCfg = {
    frBaseUrl: cfg.frBaseUrl, ecfrBaseUrl: cfg.ecfrBaseUrl, regsBaseUrl: cfg.regsBaseUrl,
    regsApiKey: cfg.regsApiKey, userAgent: cfg.userAgent, timeoutMs: cfg.upstreamTimeoutMs,
    retries: cfg.upstreamRetries, cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: cfg.cacheMaxItems,
  };
  const sources = getSources(sourceCfg);
  const sdk = buildSdk(sourceCfg);
  const corpus = buildCorpus(sources);
  const sandbox = await pickSandbox(cfg.sandbox);
  return { sdk, sandbox, corpus };
}
```
(`buildSdk` calls `getSources` again internally; that is cheap and keeps `buildSdk` independently usable. Acceptable.)

- [ ] **Step 7: Run, expect PASS**

Run: `npx vitest run test/search.spec.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/search/corpus.ts src/tools/searchApi.ts src/tools/describeSchema.ts src/server/toolCatalog.ts src/supervisor/index.ts test/search.spec.ts
git commit -m "refactor(tools): corpus injected via deps; drop getCorpus singleton"
```

### Task 9 (2f): Dynamic sandbox global injection

**Files:**
- Modify: `src/sandbox/types.ts`, `src/sandbox/isolate.ts`, `src/sandbox/deno.ts`
- Test: `test/sandbox.spec.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `test/sandbox.spec.ts`:
```ts
import { buildDenoRunner } from '../src/sandbox/deno.js';
import { IsolateRunner } from '../src/sandbox/isolate.js';

describe('dynamic binding injection', () => {
  it('deno runner injects exactly the given bindings via JSON.stringify', () => {
    const runner = buildDenoRunner('return 1;', 1000, ['fr', 'ecfr', 'regs']);
    expect(runner).toContain('["fr","ecfr","regs"]');
    expect(runner).toContain('globalThis[name] = makeProxy(name)');
    expect(runner).not.toContain("globalThis.fr =");
  });

  it('isolate injects bindings as working proxies (gated on availability)', async () => {
    const runner = new IsolateRunner();
    if (!(await runner.available())) return; // skip where isolated-vm cannot load
    const bridge = { dispatch: async () => ({ ok: true, value: 'OK' }) };
    const res = await runner.execute({ code: 'return (typeof fr) + "," + (await fr.documents.search());', bindings: ['fr', 'ecfr'] }, bridge);
    expect(res.ok).toBe(true);
    expect(res.value).toBe('function,OK');
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run test/sandbox.spec.ts`
Expected: FAIL (`buildDenoRunner` not exported; `bindings` not on `ExecuteOptions`).

- [ ] **Step 3: Widen `src/sandbox/types.ts`**

```ts
export interface ExecuteOptions {
  code: string;
  timeoutMs?: number;
  memoryMb?: number;
  bindings?: string[];
}
// …
export interface RpcCall {
  binding: string;
  path: string[];
  args: unknown[];
}
```

- [ ] **Step 4: Update `src/sandbox/isolate.ts` injection block**

Replace the proxy-injection `evalClosure` call (the one that sets `globalThis.fr` / `globalThis.ecfr`) with a loop over validated names interpolated as a JSON literal:
```ts
    const namesLiteral = JSON.stringify(opts.bindings ?? []);
    await context.evalClosure(
      `function makeProxy(binding, rpc) {
         const handler = (path) => new Proxy(function(){}, {
           get(_, key) { return handler([...path, String(key)]); },
           apply(_, __, args) {
             return rpc.apply(
               undefined,
               [binding, path, args],
               { arguments: { copy: true }, result: { promise: true, copy: true } },
             ).then(r => {
               if (!r.ok) { const e = new Error(r.error.message); e.name = r.error.name; throw e; }
               return r.value;
             });
           },
         });
         return handler([]);
       }
       for (const name of ${namesLiteral}) { globalThis[name] = makeProxy(name, $0); }`,
      [hostRpc],
      { arguments: { reference: true } },
    );
```
Also widen the `hostRpc` binding cast: change `binding: binding as 'fr' | 'ecfr'` to `binding`.

- [ ] **Step 5: Update `src/sandbox/deno.ts`**

Export `buildDenoRunner` and add a `bindings` parameter; widen the RPC message `binding` type to `string`. Change the signature and call site:
```ts
    const runner = buildDenoRunner(opts.code, opts.timeoutMs ?? 15_000, opts.bindings ?? []);
```
and:
```ts
export function buildDenoRunner(userCode: string, timeoutMs: number, bindings: string[]): string {
```
Inside the template, replace:
```ts
globalThis.fr = makeProxy('fr');
globalThis.ecfr = makeProxy('ecfr');
```
with:
```ts
const __bindings = ${JSON.stringify(bindings)};
for (const name of __bindings) { globalThis[name] = makeProxy(name); }
```
And widen the parsed message union: change `binding: 'fr' | 'ecfr'` to `binding: string` in the `msg` type annotation.

- [ ] **Step 6: Run, expect PASS**

Run: `npx vitest run test/sandbox.spec.ts && npx tsc --noEmit`
Expected: PASS (isolate case skips if unavailable).

- [ ] **Step 7: Commit**

```bash
git add src/sandbox/types.ts src/sandbox/isolate.ts src/sandbox/deno.ts test/sandbox.spec.ts
git commit -m "feat(sandbox): inject SDK globals dynamically from registered names"
```

---

## Phase 3 — The regulations.gov source

### Task 10: `RegulationsClient`, corpus, source factory, config wiring

**Files:**
- Create: `src/sdk/regs-client.ts`, `schema/regs.json`, `src/sdk/sources/regs.ts`
- Modify: `src/sdk/sources/index.ts`
- Test: `test/regs-client.spec.ts`; extend `test/sources.spec.ts`

- [ ] **Step 1: Write the failing client test**

Create `test/regs-client.spec.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent } from 'undici';
import { RegulationsClient, toJsonApiQuery } from '../src/sdk/regs-client.js';
import { HttpClient } from '../src/util/httpClient.js';

const ORIGIN = 'https://api.regulations.gov';
let agent: MockAgent;
function client() {
  return new RegulationsClient(new HttpClient({ baseUrl: ORIGIN, userAgent: 'test/0.0', timeoutMs: 5000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0, dispatcher: agent }));
}

describe('toJsonApiQuery', () => {
  it('flattens filters, ranges, sort and page', () => {
    const q = toJsonApiQuery({ filter: { searchTerm: 'methane', postedDate: { ge: '2024-01-01', le: '2024-12-31' } }, sort: '-postedDate', page: { number: 1, size: 250 } });
    expect(q['filter[searchTerm]']).toBe('methane');
    expect(q['filter[postedDate][ge]']).toBe('2024-01-01');
    expect(q['filter[postedDate][le]']).toBe('2024-12-31');
    expect(q['sort']).toBe('-postedDate');
    expect(q['page[number]']).toBe(1);
    expect(q['page[size]']).toBe(250);
  });
});

describe('RegulationsClient', () => {
  beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); });
  afterEach(async () => { await agent.close(); });

  it('searches comments by commentOnId and passes filters through raw', async () => {
    agent.get(ORIGIN).intercept({
      path: (p) => p.startsWith('/v4/comments') && p.includes('filter%5BcommentOnId%5D=0900-XYZ') && p.includes('page%5Bsize%5D=250'),
      method: 'GET',
    }).reply(200, { data: [{ id: 'c1', type: 'comments' }], meta: { totalElements: 1 } });
    const out = await client().comments.search({ filter: { commentOnId: '0900-XYZ' }, page: { size: 250 } }) as { data: unknown[]; meta: { totalElements: number } };
    expect(out.data).toHaveLength(1);
    expect(out.meta.totalElements).toBe(1);
  });

  it('fetches a document with include=attachments', async () => {
    agent.get(ORIGIN).intercept({ path: '/v4/documents/EPA-HQ-2024-0001-0001?include=attachments', method: 'GET' })
      .reply(200, { data: { id: 'EPA-HQ-2024-0001-0001', type: 'documents' } });
    const out = await client().documents.get('EPA-HQ-2024-0001-0001', { include: 'attachments' }) as { data: { id: string } };
    expect(out.data.id).toBe('EPA-HQ-2024-0001-0001');
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run test/regs-client.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `src/sdk/regs-client.ts`**

```ts
import { HttpClient } from '../util/httpClient.js';

export type RegsRange = { ge?: string; le?: string };
export interface RegsListParams {
  filter?: Record<string, string | number | boolean | RegsRange | undefined>;
  sort?: string;
  page?: { number?: number; size?: number };
}
export interface RegsGetOptions { include?: 'attachments'; }

export function toJsonApiQuery(params: RegsListParams): Record<string, string | number | boolean | undefined> {
  const out: Record<string, string | number | boolean | undefined> = {};
  if (params.filter) {
    for (const [k, v] of Object.entries(params.filter)) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'object') {
        if (v.ge !== undefined) out[`filter[${k}][ge]`] = v.ge;
        if (v.le !== undefined) out[`filter[${k}][le]`] = v.le;
      } else {
        out[`filter[${k}]`] = v;
      }
    }
  }
  if (params.sort) out['sort'] = params.sort;
  if (params.page?.number !== undefined) out['page[number]'] = params.page.number;
  if (params.page?.size !== undefined) out['page[size]'] = params.page.size;
  return out;
}

export class RegulationsClient {
  constructor(private readonly http: HttpClient) {}

  documents = {
    search: (params: RegsListParams = {}) => this.http.call({ path: '/v4/documents', query: toJsonApiQuery(params) }),
    get: (id: string, opts?: RegsGetOptions) =>
      this.http.call({ path: `/v4/documents/${encodeURIComponent(id)}`, query: opts?.include ? { include: opts.include } : undefined }),
  };

  comments = {
    search: (params: RegsListParams = {}) => this.http.call({ path: '/v4/comments', query: toJsonApiQuery(params) }),
    get: (id: string, opts?: RegsGetOptions) =>
      this.http.call({ path: `/v4/comments/${encodeURIComponent(id)}`, query: opts?.include ? { include: opts.include } : undefined }),
  };

  dockets = {
    search: (params: RegsListParams = {}) => this.http.call({ path: '/v4/dockets', query: toJsonApiQuery(params) }),
    get: (id: string) => this.http.call({ path: `/v4/dockets/${encodeURIComponent(id)}` }),
  };
}
```

- [ ] **Step 4: Create `schema/regs.json` (corpus + disambiguation + recipe)**

```json
{
  "endpoints": [
    {
      "id": "regs.documents.search",
      "kind": "endpoint",
      "binding": "regs",
      "signature": "regs.documents.search(params)",
      "description": "Search regulations.gov documents (rules, proposed rules, notices, supporting & related material). The regulations.gov view adds docket linkage, live comment-period status (openForComment, commentEndDate), and the objectId needed to fetch comments. For canonical Federal Register rule text/metadata since 1994, prefer fr.documents; use this when you need comments or docket context. Filters: filter[searchTerm], filter[agencyId], filter[docketId], filter[documentType], filter[postedDate][ge|le], filter[lastModifiedDate][ge|le]. JSON:API response (data/included/meta.totalElements).",
      "example": "await regs.documents.search({ filter: { searchTerm: 'methane', postedDate: { ge: '2024-01-01' } }, sort: '-postedDate', page: { size: 250 } })"
    },
    {
      "id": "regs.documents.get",
      "kind": "endpoint",
      "binding": "regs",
      "signature": "regs.documents.get(documentId, { include?: 'attachments' })",
      "description": "Fetch one regulations.gov document by its documentId. Read objectId from data.attributes to then query comments via regs.comments.search({ filter: { commentOnId } }).",
      "example": "await regs.documents.get('EPA-HQ-OAR-2021-0317-0001', { include: 'attachments' })"
    },
    {
      "id": "regs.comments.search",
      "kind": "endpoint",
      "binding": "regs",
      "signature": "regs.comments.search(params)",
      "description": "Search public comments submitted to regulations.gov. The unique value over Federal Register / eCFR. Filter by filter[commentOnId] (the document's objectId), filter[searchTerm], filter[agencyId], filter[postedDate][ge|le], filter[lastModifiedDate][ge|le]. Results cap at ~5000 per query (page[size] max 250); page past it with the lastModifiedDate cursor (sort by lastModifiedDate, then re-query with filter[lastModifiedDate][ge] = last seen value).",
      "example": "await regs.comments.search({ filter: { commentOnId: '0900006481b...' }, sort: 'lastModifiedDate', page: { size: 250 } })"
    },
    {
      "id": "regs.comments.get",
      "kind": "endpoint",
      "binding": "regs",
      "signature": "regs.comments.get(commentId, { include?: 'attachments' })",
      "description": "Fetch one public comment (full text + optional attachments). Some submitter fields are never public (email, phone, address).",
      "example": "await regs.comments.get('EPA-HQ-OAR-2021-0317-0123', { include: 'attachments' })"
    },
    {
      "id": "regs.dockets.search",
      "kind": "endpoint",
      "binding": "regs",
      "signature": "regs.dockets.search(params)",
      "description": "Search regulations.gov dockets (the folder grouping a rulemaking's documents and comments). Filter by filter[searchTerm], filter[agencyId] (comma-separated), filter[lastModifiedDate][ge|le]. Sort by title or -title.",
      "example": "await regs.dockets.search({ filter: { agencyId: 'EPA', searchTerm: 'greenhouse gas' } })"
    },
    {
      "id": "regs.dockets.get",
      "kind": "endpoint",
      "binding": "regs",
      "signature": "regs.dockets.get(docketId)",
      "description": "Fetch one docket by its docketId, including its comment-period metadata and counts.",
      "example": "await regs.dockets.get('EPA-HQ-OAR-2021-0317')"
    },
    {
      "id": "regs.recipes.comments-on-a-rule",
      "kind": "endpoint",
      "binding": "regs",
      "signature": "(cross-source recipe)",
      "description": "Recipe: find public comments on a specific Federal Register rule. Use fr.documents.search to locate the rule and read its document number, then regs.documents.search by frDocNum to get the regulations.gov document and its objectId, then regs.comments.search filtered by commentOnId = that objectId.",
      "example": "const fr1 = await fr.documents.search({ conditions: { term: 'methane', type: ['RULE'] }, per_page: 1, order: 'newest' }); const docNum = fr1.results[0].document_number; const rd = await regs.documents.search({ filter: { searchTerm: docNum } }); const objectId = rd.data[0].attributes.objectId; const comments = await regs.comments.search({ filter: { commentOnId: objectId }, page: { size: 250 } });"
    }
  ],
  "fields": [
    { "id": "regs.documents.objectId", "kind": "field", "binding": "regs", "description": "Internal regulations.gov id of a document; pass as filter[commentOnId] to regs.comments.search to fetch its comments." },
    { "id": "regs.documents.frDocNum", "kind": "field", "binding": "regs", "description": "Federal Register document number; bridges a regulations.gov document to fr.documents." },
    { "id": "regs.documents.commentEndDate", "kind": "field", "binding": "regs", "description": "When the public comment period closes (regulations.gov view)." },
    { "id": "regs.documents.openForComment", "kind": "field", "binding": "regs", "description": "Boolean: whether the document is currently open for public comment." },
    { "id": "regs.meta.totalElements", "kind": "field", "binding": "regs", "description": "Total matching records for a search; read from the JSON:API meta object to drive pagination." }
  ]
}
```

- [ ] **Step 5: Create `src/sdk/sources/regs.ts`**

```ts
import { HttpClient } from '../../util/httpClient.js';
import { RegulationsClient } from '../regs-client.js';
import { loadSourceCorpus } from './corpus-loader.js';
import type { Source, SourceConfig } from './source.js';

export function createRegsSource(cfg: SourceConfig): Source {
  const key = cfg.regsApiKey?.trim();
  const enabled = Boolean(key);
  const http = new HttpClient({
    baseUrl: cfg.regsBaseUrl, userAgent: cfg.userAgent, timeoutMs: cfg.timeoutMs,
    retries: cfg.retries, cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: cfg.cacheMaxItems,
    retry429: false,
    ...(enabled ? { defaultHeaders: { 'X-Api-Key': key! } } : {}),
    ...(cfg.dispatcher ? { dispatcher: cfg.dispatcher } : {}),
  });
  return {
    name: 'regs',
    label: 'Regulations.gov',
    enabled,
    disabledReason: enabled ? undefined : 'regulations.gov requires an API key. Set FEDREG_REGS_API_KEY (free at https://open.gsa.gov/api/regulationsgov/).',
    client: new RegulationsClient(http),
    corpus: loadSourceCorpus('regs'),
  };
}
```

- [ ] **Step 6: Register regs in `src/sdk/sources/index.ts`**

Add the import and include it in the array:
```ts
import { createRegsSource } from './regs.js';
// …
  const sources: Source[] = [createFrSource(cfg), createEcfrSource(cfg), createRegsSource(cfg)];
```

- [ ] **Step 7: Extend `test/sources.spec.ts` for enable/disable**

Append:
```ts
describe('regs source enable/disable', () => {
  it('is disabled without an API key, with an actionable reason', () => {
    const regs = getSources(cfg()).find(s => s.name === 'regs')!;
    expect(regs.enabled).toBe(false);
    expect(regs.disabledReason).toMatch(/FEDREG_REGS_API_KEY/);
  });
  it('is enabled when a key is provided, and never leaks it', () => {
    const regs = getSources(cfg({ regsApiKey: 'SECRET-KEY' })).find(s => s.name === 'regs')!;
    expect(regs.enabled).toBe(true);
    expect(JSON.stringify(regs)).not.toContain('SECRET-KEY');
  });
});
```

- [ ] **Step 8: Run, expect PASS**

Run: `npx vitest run test/regs-client.spec.ts test/sources.spec.ts test/bindings.spec.ts && npx tsc --noEmit`
Expected: PASS; `buildSdk().registeredNames` is now `['fr','ecfr','regs']` — update the assertion in `test/bindings.spec.ts` Step 1 (`toEqual(['fr','ecfr','regs'])`) and re-run.

- [ ] **Step 9: Commit**

```bash
git add src/sdk/regs-client.ts schema/regs.json src/sdk/sources/regs.ts src/sdk/sources/index.ts test/regs-client.spec.ts test/sources.spec.ts test/bindings.spec.ts
git commit -m "feat(regs): regulations.gov v4 client, corpus, and source"
```

---

## Phase 4 — Degradation + rate guardrails

### Task 11: `SourceUnavailable` for a disabled source

**Files:**
- Test: `test/bindings.spec.ts` (append)

(The dispatch logic already returns `SourceUnavailable`; this task proves the contract end-to-end, including the no-`ReferenceError` global.)

- [ ] **Step 1: Write the failing/contract test**

Append to `test/bindings.spec.ts`:
```ts
import { IsolateRunner } from '../src/sandbox/isolate.js';

describe('disabled source degradation', () => {
  it('dispatch returns SourceUnavailable for a registered-but-disabled binding', async () => {
    const sdk = buildSdk(cfg()); // no regsApiKey -> regs disabled
    expect(sdk.registeredNames).toContain('regs');
    expect(sdk.clients.regs).toBeUndefined();
    const res = await dispatch({ clients: sdk.clients, meta: sdk.meta }, { binding: 'regs', path: ['documents', 'search'], args: [{}] });
    expect(res.ok).toBe(false);
    expect(res.error?.name).toBe('SourceUnavailable');
    expect(res.error?.message).toMatch(/FEDREG_REGS_API_KEY/);
  });

  it('regs global is defined in the sandbox even when disabled (no ReferenceError)', async () => {
    const runner = new IsolateRunner();
    if (!(await runner.available())) return;
    const sdk = buildSdk(cfg());
    const bridge = { dispatch: (req: { binding: string; path: string[]; args: unknown[] }) => dispatch({ clients: sdk.clients, meta: sdk.meta }, req) };
    const res = await runner.execute({ code: 'try { await regs.documents.search(); return "no-throw"; } catch (e) { return e.name; }', bindings: sdk.registeredNames }, bridge);
    expect(res.ok).toBe(true);
    expect(res.value).toBe('SourceUnavailable');
  });
});
```

- [ ] **Step 2: Run, expect PASS**

Run: `npx vitest run test/bindings.spec.ts`
Expected: PASS (logic already implemented in Tasks 7 + 9; isolate case skips if unavailable).

- [ ] **Step 3: Commit**

```bash
git add test/bindings.spec.ts
git commit -m "test(regs): prove SourceUnavailable degradation in dispatch + sandbox"
```

### Task 12: Per-execute regulations.gov call budget

**Files:**
- Modify: `src/tools/execute.ts`, `src/server/toolCatalog.ts`, `src/supervisor/index.ts`, `src/bin.ts`
- Test: `test/execute.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `test/execute.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { execute } from '../src/tools/execute.js';
import type { SandboxRunner, ExecuteOptions, RpcBridge } from '../src/sandbox/types.js';

// A fake runner that calls the bridge `calls` times for the `regs` binding.
function fakeRunner(calls: number): SandboxRunner {
  return {
    kind: 'unavailable',
    available: async () => true,
    async execute(_opts: ExecuteOptions, rpc: RpcBridge) {
      const results: unknown[] = [];
      for (let i = 0; i < calls; i++) results.push(await rpc.dispatch({ binding: 'regs', path: ['documents', 'search'], args: [{}] }));
      return { ok: true, value: results, logs: [], durationMs: 0 };
    },
  };
}

const sdk = {
  clients: { regs: { documents: { search: async () => ({ data: [] }) } } } as Record<string, object>,
  meta: [{ name: 'regs', label: 'Regulations.gov', enabled: true }],
  registeredNames: ['regs'],
  version: () => '1.0.0',
};

describe('per-execute regs budget', () => {
  it('rejects regs calls past the cap', async () => {
    const deps = { sdk, sandbox: fakeRunner(5), regsMaxCallsPerExecute: 3 };
    const res = await execute({ code: '', timeoutMs: 1000, memoryMb: 64 }, deps) as { value: Array<{ ok: boolean; error?: { name: string } }> };
    const oks = res.value.filter(r => r.ok).length;
    const blocked = res.value.filter(r => !r.ok && r.error?.name === 'RegsCallBudgetExceeded').length;
    expect(oks).toBe(3);
    expect(blocked).toBe(2);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run test/execute.spec.ts`
Expected: FAIL (`regsMaxCallsPerExecute` not in deps; no budget logic).

- [ ] **Step 3: Add the budget to `src/tools/execute.ts`**

```ts
export interface ExecuteDeps {
  sdk: Sdk;
  sandbox: SandboxRunner;
  regsMaxCallsPerExecute: number;
}

export async function execute(input: ExecuteInputT, deps: ExecuteDeps) {
  let regsCalls = 0;
  return deps.sandbox.execute(
    { code: input.code, timeoutMs: input.timeoutMs, memoryMb: input.memoryMb, bindings: deps.sdk.registeredNames },
    {
      dispatch: (req) => {
        if (req.binding === 'regs') {
          if (regsCalls >= deps.regsMaxCallsPerExecute) {
            return Promise.resolve({ ok: false, error: { name: 'RegsCallBudgetExceeded', message: `Exceeded the per-execute regulations.gov call budget (${deps.regsMaxCallsPerExecute}). Narrow your query or paginate across separate execute calls.` } });
          }
          regsCalls++;
        }
        return dispatch({ clients: deps.sdk.clients, meta: deps.sdk.meta }, req);
      },
    },
  );
}
```

- [ ] **Step 4: Thread the cap through deps**

In `src/server/toolCatalog.ts`, add to `CatalogDeps`:
```ts
  regsMaxCallsPerExecute: number;
```
In `src/supervisor/index.ts`, add to `SupervisorConfig`:
```ts
  regsMaxCallsPerExecute: number;
```
and return it: `return { sdk, sandbox, corpus, regsMaxCallsPerExecute: cfg.regsMaxCallsPerExecute };`
In `src/bin.ts`, in the `buildSupervisor({ … })` call, add:
```ts
    regsMaxCallsPerExecute: Number(process.env.FEDREG_REGS_MAX_CALLS_PER_EXECUTE ?? 30),
```

- [ ] **Step 5: Run, expect PASS**

Run: `npx vitest run test/execute.spec.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/execute.ts src/server/toolCatalog.ts src/supervisor/index.ts src/bin.ts test/execute.spec.ts
git commit -m "feat(regs): per-execute upstream call budget"
```

---

## Phase 5 — Docs, packaging, cleanup

### Task 13: Docs, env, packaging, and dead-code removal

**Files:**
- Delete: `src/sdk/generated.d.ts`
- Modify: `.env.example`, `package.json`, `mcpb-build/manifest.json`, `README.md`, `docs/sdk-reference.md`, `docs/architecture.md`

- [ ] **Step 1: Delete the dead type stub**

```bash
git rm src/sdk/generated.d.ts
```

- [ ] **Step 2: Update `.env.example`**

Under the `# Upstream` section, after the eCFR line, add:
```bash
FEDREG_REGS_BASE_URL=https://api.regulations.gov
# regulations.gov requires a free API key from https://open.gsa.gov/api/regulationsgov/
# Without it, the `regs` source is disabled (fr/ecfr keep working).
FEDREG_REGS_API_KEY=
# Max regulations.gov upstream calls per single execute() run (rate-limit guardrail).
FEDREG_REGS_MAX_CALLS_PER_EXECUTE=30
```

- [ ] **Step 3: Update `package.json`**

Change the `schema` entry in `files` so per-source corpora ship. Replace `"schema"` with the directory (already a dir, so confirm it still lists `schema`), and add keywords `"regulations.gov"` and `"public-comments"` to the `keywords` array.

Run to verify shipped files include the schema dir:
```bash
node -e "const p=require('./package.json'); console.log(p.files.includes('schema'))"
```
Expected: `true` (the `schema/` directory ships all of `fr.json`, `ecfr.json`, `regs.json`).

- [ ] **Step 4: Update `mcpb-build/manifest.json`**

Add regulations.gov to the description/keywords if present (mirror the `package.json` keyword additions). Keep wording consistent with the README.

- [ ] **Step 5: Update `README.md`**

- Change "two official sources" → "three official sources" and add regulations.gov to the intro/features.
- Add a regulations.gov API-key setup note (free key from api.data.gov; `FEDREG_REGS_API_KEY`; without it `regs` is disabled and fr/ecfr keep working).
- Add the bridge example (fr → objectId → regs.comments).
- Add a "which source for what" table:

```markdown
| Need | Source |
|---|---|
| Daily rules/notices, FR document metadata since 1994 | `fr` |
| Current Code of Federal Regulations text | `ecfr` |
| Public comments, dockets, live comment-period status | `regs` |
```

- Add the env knobs (`FEDREG_REGS_API_KEY`, `FEDREG_REGS_BASE_URL`, `FEDREG_REGS_MAX_CALLS_PER_EXECUTE`) to the configuration table.

- [ ] **Step 6: Update `docs/sdk-reference.md` and `docs/architecture.md`**

- `docs/sdk-reference.md`: add the `regs.*` surface (documents/comments/dockets, the JSON:API param shape, the lastModifiedDate cursor note).
- `docs/architecture.md`: update the SDK-bindings section to mention `regs.*`, the Source registry, the API-key/degradation model, and the rate guardrails. Update the overview diagram's "SDK bindings" line to include regs.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs(regs): README, sdk-reference, architecture, env, packaging; drop generated.d.ts"
```

### Task 14: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck + full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all tests PASS, no type errors. (Sandbox-execution cases skip gracefully if no runner is available.)

- [ ] **Step 2: Build**

Run: `npx tsc -p tsconfig.build.json`
Expected: clean build into `dist/`.

- [ ] **Step 3: Lint**

Run: `npx eslint .`
Expected: no errors.

- [ ] **Step 4: Smoke test the disabled-regs path (stdio)**

Run (no key set):
```bash
node dist/bin.js --help
```
Expected: help prints. (A deeper manual smoke test: start stdio, call `describe_schema` with `prefix: 'regs.'` and confirm entries are listed; call `execute` with `return await regs.documents.search();` and confirm a `SourceUnavailable` error mentioning `FEDREG_REGS_API_KEY`.)

- [ ] **Step 5: Final commit (if any doc tweaks from verification)**

```bash
git add -A
git commit -m "chore(regs): verification pass" || echo "nothing to commit"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** §1 Source contract → Task 6; §2 regs client → Task 10; §3 API key + degradation → Tasks 3, 10, 11; §4 de-hardcoding + name validation → Tasks 5, 6, 7, 8, 9; §5 disambiguation + recipe → Task 10 (`schema/regs.json`) + Task 13 (README table); §6 rate guardrails → Tasks 3 (429) + 12 (budget); §7 caching (per-source instances) → inherent in Task 6 factories; §8 tests → Tasks 3, 6, 9, 10, 11, 12; §9 out-of-code → Task 13. All sections covered.
- **Placeholder scan:** no TBD/TODO; every code step has complete code; every test step has assertions.
- **Type consistency:** `Sdk` = `{ clients, meta, registeredNames, version }` used consistently (bindings.ts, execute.ts, toolCatalog.ts, supervisor). `dispatch({ clients, meta }, req)` signature consistent across runtime.ts, execute.ts, tests. `RpcCall`/`RpcRequest.binding: string` and `ExecuteOptions.bindings: string[]` consistent across sandbox + execute. `buildCorpus(sources)` / `lookupByPathOrPrefix(entries, target)` consistent across corpus.ts, tools, tests.
```
