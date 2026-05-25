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
