/**
 * The runtime "shape" we expose to sandboxed user code.
 * The sandbox receives a synchronous-looking RPC proxy that forwards to the host SDK.
 */
import type { Sdk } from './bindings.js';

export interface RpcRequest {
  binding: 'fr' | 'ecfr';
  path: string[];           // e.g. ['documents', 'search']
  args: unknown[];
}

export interface RpcResponse {
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string; status?: number };
}

export async function dispatch(sdk: Sdk, req: RpcRequest): Promise<RpcResponse> {
  try {
    const root = req.binding === 'fr' ? (sdk.fr as unknown as Record<string, unknown>) : (sdk.ecfr as unknown as Record<string, unknown>);
    let cur: unknown = root;
    let parent: unknown = root;
    for (const seg of req.path) {
      if (cur === null || typeof cur !== 'object') {
        return { ok: false, error: { name: 'TypeError', message: `Cannot resolve ${req.path.join('.')}` } };
      }
      parent = cur;
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (typeof cur !== 'function') {
      return { ok: false, error: { name: 'TypeError', message: `${req.path.join('.')} is not a function` } };
    }
    const value = await (cur as (...a: unknown[]) => unknown).apply(parent, req.args);
    return { ok: true, value };
  } catch (err) {
    const e = err as { name?: string; message?: string; status?: number };
    return { ok: false, error: { name: e.name ?? 'Error', message: e.message ?? String(err), status: e.status } };
  }
}
