import { z } from 'zod/v3';
import type { Sdk } from '../sdk/bindings.js';
import { dispatch } from '../sdk/runtime.js';
import { TEARDOWN, type SandboxRunner, type WithTeardown } from '../sandbox/types.js';
import { SubjectQuota } from '../util/quotas.js';
import { ExecutionLimiter } from '../util/executionLimiter.js';
import { runWithSignal } from '../util/executionContext.js';

export const ExecuteInput = z.object({
  code: z.string().min(1).describe('JavaScript to run inside the sandbox (plain JS: TypeScript type annotations are rejected; top-level await/return are allowed). SDK globals are bound per source (e.g. `fr`, `ecfr`, `regs`).'),
  timeoutMs: z.number().int().min(100).max(60_000).default(15_000),
  memoryMb: z.number().int().min(16).max(256).default(64),
});

export type ExecuteInputT = z.infer<typeof ExecuteInput>;

export interface ExecuteDeps {
  sdk: Sdk;
  sdkForSubject?: (subject?: string) => Promise<Sdk>;
  sandbox: SandboxRunner;
  regsMaxCallsPerExecute: number;
  /** Absent in account mode, which limits regs per account in PostgreSQL instead. */
  regsSubjectQuota?: SubjectQuota;
  /** fr/ecfr calls allowed per execute; defaults to PUBLIC_MAX_CALLS_PER_EXECUTE. */
  publicMaxCallsPerExecute?: number;
  /** Caps simultaneous executions; omitted means unlimited (tests). */
  executionLimiter?: ExecutionLimiter;
  /** Aborts every execution, e.g. on shutdown. */
  shutdownSignal?: AbortSignal;
}

export const PUBLIC_MAX_CALLS_PER_EXECUTE = 100;

/**
 * Per-request context, re-derived from the caller's bearer token on every HTTP request.
 * stdio has no subject.
 */
export interface RequestCtx {
  subject?: string;
  /** The MCP request's abort signal: the client cancelled or disconnected. */
  signal?: AbortSignal;
}

export async function execute(input: ExecuteInputT, deps: ExecuteDeps, requestCtx?: RequestCtx) {
  const upstream = [deps.shutdownSignal, requestCtx?.signal].filter((s): s is AbortSignal => Boolean(s));
  if (upstream.some(s => s.aborted)) {
    return { ok: false, logs: [], error: { name: 'AbortError', message: deps.shutdownSignal?.aborted ? 'The server is shutting down.' : 'The request was cancelled.' }, durationMs: 0 };
  }
  const admitted = deps.executionLimiter?.tryAcquire(requestCtx?.subject);
  if (admitted && 'error' in admitted) {
    return { ok: false, logs: [], error: { name: 'Busy', message: admitted.error }, durationMs: 0 };
  }
  // Aborted when this execution ends for any reason, or when the client cancels / disconnects or
  // the server shuts down, so the sandbox and queued and in-flight upstream calls stop.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const s of upstream) s.addEventListener('abort', onAbort, { once: true });
  let teardown: Promise<void> | undefined;
  try {
    const result = await runExecution(input, deps, requestCtx, controller.signal);
    teardown = (result as WithTeardown<typeof result>)[TEARDOWN];
    return result;
  } finally {
    controller.abort();
    for (const s of upstream) s.removeEventListener('abort', onAbort);
    // A sandbox process that has not exited yet keeps its execution slot until it does.
    if (teardown) void teardown.then(() => admitted?.release());
    else admitted?.release();
  }
}

async function runExecution(input: ExecuteInputT, deps: ExecuteDeps, requestCtx: RequestCtx | undefined, signal: AbortSignal) {
  const sdk = deps.sdkForSubject ? await deps.sdkForSubject(requestCtx?.subject) : deps.sdk;
  let regsCalls = 0;
  let publicCalls = 0;
  const publicBudget = deps.publicMaxCallsPerExecute ?? PUBLIC_MAX_CALLS_PER_EXECUTE;
  return deps.sandbox.execute(
    { code: input.code, timeoutMs: input.timeoutMs, memoryMb: input.memoryMb, bindings: sdk.registeredNames, signal },
    {
      dispatch: (req, ctx) => {
        if (req.binding === 'regs') {
          if (regsCalls >= deps.regsMaxCallsPerExecute) {
            return Promise.resolve({ ok: false, error: { name: 'RegsCallBudgetExceeded', message: `Exceeded the per-execute regulations.gov call budget (${deps.regsMaxCallsPerExecute}). Narrow your query or paginate across separate execute calls.` } });
          }
          if (requestCtx?.subject && deps.regsSubjectQuota) {
            const q = deps.regsSubjectQuota.consume(requestCtx.subject);
            if (!q.allowed) {
              return Promise.resolve({ ok: false, error: { name: 'RegsSubjectQuotaExceeded', message: `Per-subject regulations.gov quota exceeded. Try again after ${new Date(q.resetAt).toISOString()}.` } });
            }
          }
          regsCalls++;
        } else {
          // Every user shares this server's footprint on the public APIs; cap what one execute can spend.
          if (publicCalls >= publicBudget) {
            return Promise.resolve({ ok: false, error: { name: 'CallBudgetExceeded', message: `Exceeded the per-execute Federal Register/eCFR call budget (${publicBudget}). Narrow your query, use getMany for batches, or split the work across separate execute calls.` } });
          }
          publicCalls++;
        }
        return runWithSignal(ctx?.signal ?? signal, () => dispatch(sdk, req));
      },
    },
  );
}
