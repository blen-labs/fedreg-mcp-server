import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { preflight } from '../src/sandbox/policy.js';
import { DenoRunner } from '../src/sandbox/deno.js';
import { IsolateRunner } from '../src/sandbox/isolate.js';
import type { RpcBridge, SandboxRunner } from '../src/sandbox/types.js';

// examples/ is documented as paste-ready input for `execute`, so it must pass the
// same preflight the tool applies — plain JavaScript, no TypeScript syntax.
const dir = resolve(__dirname, '../examples');
const examples = readdirSync(dir).filter(f => f.endsWith('.js')).map(f => [f, readFileSync(resolve(dir, f), 'utf8')] as const);

// Synthetic upstream responses, answered by SDK method so each example sees the shape it reads.
// `frRules` is what fr.documents.search returns; tests change it to drive the no-match paths.
const rule = { document_number: '2024-00001', title: 'Example rule', publication_date: '2024-01-02' };
function bridge(frRules: unknown[] = [rule]): RpcBridge {
  const answers: Record<string, unknown> = {
    'fr.documents.search': { count: frRules.length, results: frRules },
    'ecfr.titles.list': { titles: [{ number: 49, latest_issue_date: '2024-01-01' }, { number: 50, latest_issue_date: '2024-02-03' }] },
    'ecfr.full': `<DIV8 N="§ 21.150"><HEAD>§ 21.150 Example section.</HEAD>${'<P>Text.</P>'.repeat(500)}</DIV8>`,
    'ecfr.search.counts_hierarchy': { count: { value: 7 }, children: [{ hierarchy: '40', heading: 'Protection of Environment', count: 7, children: [] }] },
    'ecfr.search.results': { results: [{ hierarchy: { title: '40', part: '98', section: '98.1' }, headings: { section: 'Example.' } }] },
    'regs.documents.search': { data: [{ id: 'EXAMPLE-0001', attributes: { objectId: 'o1' } }] },
    'regs.comments.search': {
      meta: { totalElements: 2 },
      data: [
        { id: 'EXAMPLE-0002', attributes: { title: 'Comment one', postedDate: '2024-02-01T00:00:00Z' } },
        { id: 'EXAMPLE-0003', attributes: { title: 'Comment two', postedDate: '2024-01-31T00:00:00Z' } },
      ],
    },
  };
  return {
    dispatch: async ({ binding, path }) => {
      const key = [binding, ...path].join('.');
      return key in answers
        ? { ok: true, value: answers[key] }
        : { ok: false, error: { name: 'NotStubbed', message: `No stub for ${key}` } };
    },
  };
}

const run = (runner: SandboxRunner, file: string, rules?: unknown[]) =>
  runner.execute({ code: readFileSync(resolve(dir, file), 'utf8'), bindings: ['fr', 'ecfr', 'regs'], timeoutMs: 3000 }, bridge(rules));

// What each example must return, so a program that assigns variables and exits (returning null) fails.
const expected: Record<string, unknown> = {
  'fr-search.js': { count: 1, results: [rule] },
  'ecfr-search.js': {
    matchingSections: 7,
    byTitle: [{ title: '40', heading: 'Protection of Environment', sections: 7 }],
    best: [{ title: '40', part: '98', section: '98.1', heading: 'Example.' }],
  },
  'ecfr-section.js': {
    section: {
      citation: '50 CFR 21.150',
      asOf: '2024-02-03',
      url: 'https://www.ecfr.gov/current/title-50/section-21.150',
      text: expect.stringMatching(/^§ 21\.150 Example section\. Text\. Text\. .{200,}$/),
    },
    rules: [rule],
  },
  'no-match.js': { count: 0, results: [] },
  'regs-comments.js': {
    rule,
    totalComments: 2,
    latest: [
      { id: 'EXAMPLE-0002', title: 'Comment one', postedDate: '2024-02-01T00:00:00Z' },
      { id: 'EXAMPLE-0003', title: 'Comment two', postedDate: '2024-01-31T00:00:00Z' },
    ],
  },
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
    it.for(examples)('%s returns its documented result', async ([name], { skip }) => {
      if (!(await runner.available())) return skip();
      // no-match.js runs against a search that finds nothing; the others against one match.
      const res = await run(runner, name, name === 'no-match.js' ? [] : undefined);
      expect(res.error).toBeUndefined();
      expect(res.value).toEqual(expected[name]);
    });

    it('stops with a clear result when the Federal Register has no rule to follow', async ({ skip }) => {
      if (!(await runner.available())) return skip();
      expect((await run(runner, 'regs-comments.js', [])).value).toEqual({ error: 'no matching rule' });
    });
  });

  it('has an expected result for every example, and a captured output for each', () => {
    expect(examples.map(([name]) => name).sort()).toEqual(Object.keys(expected).sort());
    for (const [name] of examples) expect(existsSync(resolve(dir, 'outputs', name.replace(/\.js$/, '.json'))), name).toBe(true);
  });

  describe('captured outputs', () => {
    const outputs = readdirSync(resolve(dir, 'outputs')).map(f => [f, JSON.parse(readFileSync(resolve(dir, 'outputs', f), 'utf8'))] as const);

    it.each(outputs)('%s is dated, attributed and small', (_name, output) => {
      expect(output.capturedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(output.source).toEqual(expect.any(String));
      expect(typeof output.synthetic).toBe('boolean');
      expect(output).toHaveProperty('value');
      expect(JSON.stringify(output).length).toBeLessThan(4096);
    });

    // A synthetic output is not a live capture, so it must be exactly what the example returns on the stubs above.
    it.each(outputs.filter(([, output]) => output.synthetic))('%s equals the example run on synthetic responses', async (name, output) => {
      const runner = new IsolateRunner();
      expect((await run(runner, name.replace(/\.json$/, '.js'))).value).toEqual(output.value);
    });
  });
});
