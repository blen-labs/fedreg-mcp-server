import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { preflight } from '../src/sandbox/policy.js';
import { DenoRunner } from '../src/sandbox/deno.js';
import { IsolateRunner } from '../src/sandbox/isolate.js';

// examples/ is documented as paste-ready input for `execute`, so it must pass the
// same preflight the tool applies — plain JavaScript, no TypeScript syntax.
const dir = resolve(__dirname, '../examples');
const examples = readdirSync(dir).filter(f => f.endsWith('.js')).map(f => [f, readFileSync(resolve(dir, f), 'utf8')] as const);

// One canned payload shaped to satisfy every example's property accesses.
const bridge = {
  dispatch: async () => ({
    ok: true,
    value: { results: [{ document_number: '2024-00001' }], data: [{ id: 'c1', attributes: { objectId: 'o1' } }], meta: { totalElements: 1 } },
  }),
};

describe('examples/', () => {
  it('contains only paste-ready .js snippets', () => {
    expect(examples.length).toBeGreaterThan(0);
    expect(readdirSync(dir).filter(f => f.endsWith('.ts'))).toEqual([]);
  });

  it.each(examples)('%s passes execute preflight', (_name, code) => {
    expect(preflight(code)).toMatchObject({ ok: true });
  });

  it('preflight rejects TypeScript type annotations (why the examples are plain JS)', () => {
    expect(preflight('const x: number = 1; return x;').ok).toBe(false);
  });

  describe.each([new IsolateRunner(), new DenoRunner()])('$kind', runner => {
    // `it.for` (not `it.each`) passes the test context, which carries `skip`.
    it.for(examples)('%s runs and returns a value', async ([, code], { skip }) => {
      if (!(await runner.available())) return skip();
      const res = await runner.execute({ code, bindings: ['fr', 'ecfr', 'regs'], timeoutMs: 3000 }, bridge);
      expect(res.ok).toBe(true);
      expect(res.value).toBeDefined();
    });
  });
});
