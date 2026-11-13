/**
 * Byte budgets for one execution. They bound what the host buffers and what reaches the model,
 * independently of the V8 heap limit inside the sandbox. The defaults are deliberately generous:
 * they exist to stop runaway or hostile output, not to constrain ordinary queries (a filtered
 * `ecfr.full` part or a page of Federal Register documents fits comfortably).
 */
export interface SandboxLimits {
  /** Largest accepted user code. */
  maxCodeBytes: number;
  /** Total log size kept (text plus per-line overhead); later lines are dropped with a marker. */
  maxLogBytes: number;
  /** Most log lines kept, however short. */
  maxLogLines: number;
  /** Largest JSON-serialized return value; bigger results fail with ResultTooLarge. */
  maxResultBytes: number;
  /** Largest JSON-serialized argument list for one SDK call. */
  maxRpcArgBytes: number;
  /** SDK calls that may be awaiting a response at once. */
  maxPendingRpc: number;
  /** Deno only: total bytes the child may write to stdout over the execution. */
  maxStdoutBytes: number;
  /** Deno only: largest single frame (line) on stdout. */
  maxFrameBytes: number;
}

export const DEFAULT_LIMITS: Readonly<SandboxLimits> = Object.freeze({
  maxCodeBytes: 256 * 1024,
  maxLogBytes: 1024 * 1024,
  maxLogLines: 10_000,
  maxResultBytes: 8 * 1024 * 1024,
  maxRpcArgBytes: 1024 * 1024,
  // Matches the per-execute public call budget, so `Promise.all` over a full budget still works.
  maxPendingRpc: 100,
  maxStdoutBytes: 128 * 1024 * 1024,
  // A result travels as an escaped JSON string inside a frame, so allow for escaping overhead.
  maxFrameBytes: 48 * 1024 * 1024,
});

/** Bytes charged per log line on top of its text, so empty-line floods are bounded too. */
export const LOG_LINE_OVERHEAD = 16;
export const LOG_TRUNCATED = '[logs truncated]';

/** Host-side log budget. The sandboxes enforce the same budget before sending (defense in depth). */
export class LogSink {
  private readonly out: string[] = [];
  private bytes = 0;
  private dropped = false;
  constructor(private readonly max: number, private readonly maxLines = DEFAULT_LIMITS.maxLogLines) {}
  push(line: string): void {
    if (this.dropped) return;
    const text = line.length > this.max ? line.slice(0, this.max) : line;
    const cost = Buffer.byteLength(text, 'utf8') + LOG_LINE_OVERHEAD;
    // Room for the marker is reserved up front, so the total never exceeds the budget.
    const reserve = Buffer.byteLength(LOG_TRUNCATED, 'utf8') + LOG_LINE_OVERHEAD;
    if (text === LOG_TRUNCATED || this.out.length >= this.maxLines - 1 || this.bytes + cost > this.max - reserve) {
      this.dropped = true;
      if (reserve <= this.max) this.out.push(LOG_TRUNCATED);
      return;
    }
    this.bytes += cost;
    this.out.push(text);
  }
  lines(): string[] { return [...this.out]; }
}

export function checkRpcArgs(args: unknown[], limits: SandboxLimits): { name: string; message: string } | undefined {
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(args) ?? '', 'utf8'); }
  catch { return { name: 'TypeError', message: 'SDK arguments must be JSON-serializable.' }; }
  return size > limits.maxRpcArgBytes
    ? { name: 'ArgumentsTooLarge', message: `SDK call arguments exceed ${limits.maxRpcArgBytes} bytes.` }
    : undefined;
}

/** Turn the sandbox's JSON result into the execute envelope, enforcing maxResultBytes. */
export function finishValue(json: string, limits: SandboxLimits): { ok: boolean; value?: unknown; error?: { name: string; message: string } } {
  const size = Buffer.byteLength(json, 'utf8');
  if (size > limits.maxResultBytes) return { ok: false, error: resultTooLarge(size, limits) };
  try { return { ok: true, value: JSON.parse(json) as unknown }; }
  catch { return { ok: false, error: { name: 'SandboxProtocolError', message: 'The sandbox returned an invalid result.' } }; }
}

export function resultTooLarge(size: number, limits: SandboxLimits): { name: string; message: string } {
  return {
    name: 'ResultTooLarge',
    message: `The returned value is ${size} bytes; the limit is ${limits.maxResultBytes}. Return only what you need: `
      + 'request fewer records (per_page), select fields, filter ecfr.full by part or section, map records to the attributes you need, or slice long text.',
  };
}

/** Longest error message any execution reports. */
export const MAX_ERROR_MESSAGE = 4000;

export function boundMessage(message: string): string {
  return message.length > MAX_ERROR_MESSAGE ? `${message.slice(0, MAX_ERROR_MESSAGE)}… [truncated]` : message;
}

/** Preflight diagnostics: distinct messages only, at most 10, bounded in total. */
export function policyMessage(errors: string[]): string {
  const unique = [...new Set(errors)];
  const shown = unique.slice(0, 10).join('; ');
  return boundMessage(unique.length > 10 ? `${shown}; and ${unique.length - 10} more` : shown);
}
