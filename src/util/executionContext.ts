import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-execution context carried from the sandbox bridge to the HTTP client without threading it
 * through SDK method arguments (those are user data). Holds the execution's abort signal.
 */
const storage = new AsyncLocalStorage<{ signal?: AbortSignal }>();

export function runWithSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return storage.run({ signal }, fn);
}

export function currentSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

export function abortError(): Error {
  return Object.assign(new Error('The execution ended before this request completed.'), { name: 'AbortError' });
}

/** Resolve after `ms`, or reject with AbortError as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
