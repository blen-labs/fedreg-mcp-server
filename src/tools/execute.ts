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
