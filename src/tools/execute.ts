import { z } from 'zod';
import type { Sdk } from '../sdk/bindings.js';
import { dispatch } from '../sdk/runtime.js';
import type { SandboxRunner } from '../sandbox/types.js';

export const ExecuteInput = z.object({
  code: z.string().min(1).describe('TypeScript code to run inside the sandbox. The globals `fr` and `ecfr` are bound to the SDK.'),
  timeoutMs: z.number().int().min(100).max(60_000).default(15_000),
  memoryMb: z.number().int().min(16).max(256).default(64),
});

export type ExecuteInputT = z.infer<typeof ExecuteInput>;

export interface ExecuteDeps {
  sdk: Sdk;
  sandbox: SandboxRunner;
}

export async function execute(input: ExecuteInputT, deps: ExecuteDeps) {
  const result = await deps.sandbox.execute(
    { code: input.code, timeoutMs: input.timeoutMs, memoryMb: input.memoryMb },
    { dispatch: (req) => dispatch(deps.sdk, req) },
  );
  return result;
}
