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

// A fake runner that issues `frCalls` fr dispatches followed by `regsCalls` regs dispatches,
// returning the two result arrays separately so tests can assert per-binding behavior.
function fakeMixedRunner(frCalls: number, regsCalls: number): SandboxRunner {
  return {
    kind: 'unavailable',
    available: async () => true,
    async execute(_opts: ExecuteOptions, rpc: RpcBridge) {
      const fr: unknown[] = [];
      const regs: unknown[] = [];
      for (let i = 0; i < frCalls; i++) fr.push(await rpc.dispatch({ binding: 'fr', path: ['documents', 'search'], args: [{}] }));
      for (let i = 0; i < regsCalls; i++) regs.push(await rpc.dispatch({ binding: 'regs', path: ['documents', 'search'], args: [{}] }));
      return { ok: true, value: { fr, regs }, logs: [], durationMs: 0 };
    },
  };
}

const sdk = {
  clients: { regs: { documents: { search: async () => ({ data: [] }) } } } as Record<string, object>,
  meta: [{ name: 'regs', label: 'Regulations.gov', enabled: true }],
  registeredNames: ['regs'],
  version: () => '1.0.0',
};

const mixedSdk = {
  clients: {
    fr: { documents: { search: async () => ({ results: [] }) } },
    regs: { documents: { search: async () => ({ data: [] }) } },
  } as Record<string, object>,
  meta: [
    { name: 'fr', label: 'Federal Register', enabled: true },
    { name: 'regs', label: 'Regulations.gov', enabled: true },
  ],
  registeredNames: ['fr', 'regs'],
  version: () => '1.0.0',
};

type DispatchResult = { ok: boolean; error?: { name: string } };

describe('per-execute regs budget', () => {
  it('rejects regs calls past the cap', async () => {
    const deps = { sdk, sandbox: fakeRunner(5), regsMaxCallsPerExecute: 3 };
    const res = await execute({ code: '', timeoutMs: 1000, memoryMb: 64 }, deps) as { value: DispatchResult[] };
    const oks = res.value.filter(r => r.ok).length;
    const blocked = res.value.filter(r => !r.ok && r.error?.name === 'RegsCallBudgetExceeded').length;
    expect(oks).toBe(3);
    expect(blocked).toBe(2);
  });

  it('never counts or blocks fr/ecfr calls when the regs budget is exhausted', async () => {
    const deps = { sdk: mixedSdk, sandbox: fakeMixedRunner(4, 5), regsMaxCallsPerExecute: 2 };
    const res = await execute({ code: '', timeoutMs: 1000, memoryMb: 64 }, deps) as { value: { fr: DispatchResult[]; regs: DispatchResult[] } };

    // All 4 fr dispatches go through untouched, even though regs is over budget.
    expect(res.value.fr.length).toBe(4);
    expect(res.value.fr.every(r => r.ok)).toBe(true);
    expect(res.value.fr.some(r => r.error?.name === 'RegsCallBudgetExceeded')).toBe(false);

    // regs is capped at 2: 2 ok, 3 blocked.
    const regsOks = res.value.regs.filter(r => r.ok).length;
    const regsBlocked = res.value.regs.filter(r => !r.ok && r.error?.name === 'RegsCallBudgetExceeded').length;
    expect(regsOks).toBe(2);
    expect(regsBlocked).toBe(3);
  });
});
