import { describe, it, expect } from 'vitest';
import { execute, PUBLIC_MAX_CALLS_PER_EXECUTE } from '../src/tools/execute.js';
import { ExecutionLimiter } from '../src/util/executionLimiter.js';
import { currentSignal } from '../src/util/executionContext.js';
import { TEARDOWN } from '../src/sandbox/types.js';
import { SubjectQuota } from '../src/util/quotas.js';
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
  methods: { regs: { 'documents.search': async () => ({ data: [] }) } },
  meta: [{ name: 'regs', label: 'Regulations.gov', enabled: true }],
  registeredNames: ['regs'],
  version: () => '1.0.0',
};

const mixedSdk = {
  methods: {
    fr: { 'documents.search': async () => ({ results: [] }) },
    regs: { 'documents.search': async () => ({ data: [] }) },
  },
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
    const deps = { sdk, sandbox: fakeRunner(5), regsMaxCallsPerExecute: 3, regsSubjectQuota: new SubjectQuota(1_000_000, 3_600_000) };
    const res = await execute({ code: '', timeoutMs: 1000, memoryMb: 64 }, deps) as { value: DispatchResult[] };
    const oks = res.value.filter(r => r.ok).length;
    const blocked = res.value.filter(r => !r.ok && r.error?.name === 'RegsCallBudgetExceeded').length;
    expect(oks).toBe(3);
    expect(blocked).toBe(2);
  });

  it('never counts or blocks fr/ecfr calls when the regs budget is exhausted', async () => {
    const deps = { sdk: mixedSdk, sandbox: fakeMixedRunner(4, 5), regsMaxCallsPerExecute: 2, regsSubjectQuota: new SubjectQuota(1_000_000, 3_600_000) };
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

describe('per-execute fr/ecfr budget', () => {
  it('rejects fr calls past the cap without touching the regs budget', async () => {
    const deps = { sdk: mixedSdk, sandbox: fakeMixedRunner(5, 2), regsMaxCallsPerExecute: 2, publicMaxCallsPerExecute: 3, regsSubjectQuota: new SubjectQuota(1_000_000, 3_600_000) };
    const res = await execute({ code: '', timeoutMs: 1000, memoryMb: 64 }, deps) as { value: { fr: DispatchResult[]; regs: DispatchResult[] } };
    expect(res.value.fr.filter(r => r.ok).length).toBe(3);
    expect(res.value.fr.filter(r => !r.ok && r.error?.name === 'CallBudgetExceeded').length).toBe(2);
    expect(res.value.regs.every(r => r.ok)).toBe(true);
  });

  it('allows the default budget of fr calls', async () => {
    const deps = { sdk: mixedSdk, sandbox: fakeMixedRunner(PUBLIC_MAX_CALLS_PER_EXECUTE, 0), regsMaxCallsPerExecute: 2, regsSubjectQuota: new SubjectQuota(1_000_000, 3_600_000) };
    const res = await execute({ code: '', timeoutMs: 1000, memoryMb: 64 }, deps) as { value: { fr: DispatchResult[] } };
    expect(res.value.fr.every(r => r.ok)).toBe(true);
  });
});

describe('per-subject regs quota', () => {
  it('blocks a subject past its hourly quota (sessionCtx provided)', async () => {
    const deps = { sdk, sandbox: fakeRunner(4), regsMaxCallsPerExecute: 100, regsSubjectQuota: new SubjectQuota(2, 3_600_000) };
    const res = await execute({ code: '', timeoutMs: 1000, memoryMb: 64 }, deps, { subject: 'tenant-1' }) as { value: Array<{ ok: boolean; error?: { name: string } }> };
    expect(res.value.filter(r => r.ok).length).toBe(2);
    expect(res.value.filter(r => !r.ok && r.error?.name === 'RegsSubjectQuotaExceeded').length).toBe(2);
  });
  it('does not consult the per-subject quota when no subject (stdio)', async () => {
    const deps = { sdk, sandbox: fakeRunner(4), regsMaxCallsPerExecute: 100, regsSubjectQuota: new SubjectQuota(1, 3_600_000) };
    const res = await execute({ code: '', timeoutMs: 1000, memoryMb: 64 }, deps) as { value: Array<{ ok: boolean }> };
    expect(res.value.every(r => r.ok)).toBe(true); // all 4 pass; quota skipped without a subject
  });
});

const input = { code: '', timeoutMs: 1000, memoryMb: 64 };
const okResult = { ok: true, value: 1, logs: [] as string[], durationMs: 0 };

/** A runner whose executions stay running until `finish()`; records the abort signals it was given. */
function blockingRunner() {
  const signals: AbortSignal[] = [];
  const waiting: Array<() => void> = [];
  const runner: SandboxRunner = {
    kind: 'unavailable',
    available: async () => true,
    execute(opts: ExecuteOptions) {
      if (opts.signal) signals.push(opts.signal);
      return new Promise(resolve => {
        waiting.push(() => resolve(okResult));
        opts.signal?.addEventListener('abort', () => resolve({ ok: false, logs: [], error: { name: 'AbortError', message: 'aborted' }, durationMs: 0 }), { once: true });
      });
    },
  };
  return { runner, signals, finish: () => { for (const w of waiting.splice(0)) w(); } };
}

const tick = () => new Promise(r => setTimeout(r, 10));

describe('execution limiter', () => {
  it('returns Busy past the global cap and admits again once an execution ends', async () => {
    const { runner, finish } = blockingRunner();
    const deps = { sdk, sandbox: runner, regsMaxCallsPerExecute: 1, executionLimiter: new ExecutionLimiter(2, 2) };
    const running = [execute(input, deps, { subject: 'a' }), execute(input, deps, { subject: 'b' })];
    await tick();
    expect(await execute(input, deps, { subject: 'c' })).toMatchObject({ ok: false, error: { name: 'Busy', message: expect.stringMatching(/maximum of 2/) } });
    finish();
    await Promise.all(running);
    expect(await execute(input, { ...deps, sandbox: fakeRunner(0) }, { subject: 'c' })).toMatchObject({ ok: true });
  });

  it('returns Busy past the per-subject cap without blocking other subjects', async () => {
    const { runner, finish } = blockingRunner();
    const deps = { sdk, sandbox: runner, regsMaxCallsPerExecute: 1, executionLimiter: new ExecutionLimiter(8, 2) };
    const running = [execute(input, deps, { subject: 'a' }), execute(input, deps, { subject: 'a' })];
    await tick();
    expect(await execute(input, deps, { subject: 'a' })).toMatchObject({ ok: false, error: { name: 'Busy', message: expect.stringMatching(/already have 2/) } });
    const other = execute(input, deps, { subject: 'b' });
    await tick();
    finish();
    expect(await other).toMatchObject({ ok: true });
    await Promise.all(running);
  });

  it('admits at most the cap out of 25 simultaneous calls from one subject', async () => {
    const { runner, finish } = blockingRunner();
    const deps = { sdk, sandbox: runner, regsMaxCallsPerExecute: 1, executionLimiter: new ExecutionLimiter(8, 2) };
    const all = Array.from({ length: 25 }, () => execute(input, deps, { subject: 'one' }));
    await tick();
    finish();
    const results = await Promise.all(all) as Array<{ error?: { name: string } }>;
    expect(results.filter(r => r.error?.name === 'Busy').length).toBe(23);
  });

  it('frees the slot when the sandbox throws', async () => {
    const limiter = new ExecutionLimiter(1, 1);
    const throwing: SandboxRunner = { kind: 'unavailable', available: async () => true, async execute() { throw new Error('boom'); } };
    await expect(execute(input, { sdk, sandbox: throwing, regsMaxCallsPerExecute: 1, executionLimiter: limiter })).rejects.toThrow('boom');
    expect('release' in limiter.tryAcquire()).toBe(true);
  });

  it('keeps the slot until a lingering sandbox process has exited', async () => {
    let exited!: () => void;
    const gone = new Promise<void>(r => { exited = r; });
    const lingering: SandboxRunner = { kind: 'unavailable', available: async () => true,
      async execute() { return Object.defineProperty({ ...okResult }, TEARDOWN, { value: gone }); } };
    const limiter = new ExecutionLimiter(1, 1);
    const deps = { sdk, sandbox: lingering, regsMaxCallsPerExecute: 1, executionLimiter: limiter };
    expect(await execute(input, deps)).toMatchObject({ ok: true });
    expect(await execute(input, deps)).toMatchObject({ ok: false, error: { name: 'Busy' } }); // still quarantined
    exited();
    await tick();
    expect(await execute(input, deps)).toMatchObject({ ok: true }); // released once the process exited
  });
});

describe('cancellation', () => {
  it('does not start when shutdown or the request is already aborted', async () => {
    let started = false;
    const sandbox: SandboxRunner = { kind: 'unavailable', available: async () => true, async execute() { started = true; return okResult; } };
    const shut = new AbortController(); shut.abort();
    expect(await execute(input, { sdk, sandbox, regsMaxCallsPerExecute: 1, shutdownSignal: shut.signal })).toMatchObject({ ok: false, error: { name: 'AbortError' } });
    const req = new AbortController(); req.abort();
    expect(await execute(input, { sdk, sandbox, regsMaxCallsPerExecute: 1 }, { signal: req.signal })).toMatchObject({ ok: false, error: { name: 'AbortError' } });
    expect(started).toBe(false);
  });

  it('aborts the sandbox when the client cancels, and frees the slot', async () => {
    const { runner, signals } = blockingRunner();
    const limiter = new ExecutionLimiter(1, 1);
    const req = new AbortController();
    const running = execute(input, { sdk, sandbox: runner, regsMaxCallsPerExecute: 1, executionLimiter: limiter }, { signal: req.signal });
    await tick();
    expect(signals[0]!.aborted).toBe(false);
    req.abort();
    expect(await running).toMatchObject({ ok: false, error: { name: 'AbortError' } });
    expect(signals[0]!.aborted).toBe(true);
    expect('release' in limiter.tryAcquire()).toBe(true);
  });

  it('aborts the sandbox on server shutdown', async () => {
    const { runner, signals } = blockingRunner();
    const shut = new AbortController();
    const running = execute(input, { sdk, sandbox: runner, regsMaxCallsPerExecute: 1, shutdownSignal: shut.signal });
    await tick();
    shut.abort();
    expect(await running).toMatchObject({ ok: false, error: { name: 'AbortError' } });
    expect(signals[0]!.aborted).toBe(true);
  });

  it('gives upstream calls the execution signal, aborted by cancel and by the end of the execution', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const probeSdk = { ...sdk, methods: { regs: { 'documents.search': async () => { seen.push(currentSignal()); return {}; } } } };
    const req = new AbortController();
    const once: SandboxRunner = { kind: 'unavailable', available: async () => true,
      async execute(_o: ExecuteOptions, rpc: RpcBridge) { await rpc.dispatch({ binding: 'regs', path: ['documents', 'search'], args: [{}] }); return okResult; } };
    await execute(input, { sdk: probeSdk, sandbox: once, regsMaxCallsPerExecute: 5 }, { signal: req.signal });
    expect(seen[0]).toBeDefined();
    expect(seen[0]!.aborted).toBe(true); // the execution has ended
    const live: Array<AbortSignal | undefined> = [];
    const probeSdk2 = { ...sdk, methods: { regs: { 'documents.search': async () => { live.push(currentSignal()); return {}; } } } };
    const hold: SandboxRunner = { kind: 'unavailable', available: async () => true,
      async execute(_o: ExecuteOptions, rpc: RpcBridge) { await rpc.dispatch({ binding: 'regs', path: ['documents', 'search'], args: [{}] }); await new Promise(r => setTimeout(r, 30)); return okResult; } };
    const running = execute(input, { sdk: probeSdk2, sandbox: hold, regsMaxCallsPerExecute: 5 }, { signal: req.signal });
    await tick();
    expect(live[0]!.aborted).toBe(false);
    req.abort();
    expect(live[0]!.aborted).toBe(true);
    await running;
  });
});
