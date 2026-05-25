import type { SourceMeta } from './sources/source.js';

export interface RpcRequest {
  binding: string;
  path: string[];
  args: unknown[];
}

export interface RpcResponse {
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string; status?: number };
}

export interface DispatchRegistry {
  clients: Record<string, object>;
  meta: SourceMeta[];
}

export async function dispatch(reg: DispatchRegistry, req: RpcRequest): Promise<RpcResponse> {
  const client = reg.clients[req.binding];
  if (!client) {
    const m = reg.meta.find(x => x.name === req.binding);
    if (m && !m.enabled) {
      return { ok: false, error: { name: 'SourceUnavailable', message: m.disabledReason ?? `${m.label} is unavailable` } };
    }
    return { ok: false, error: { name: 'TypeError', message: `Cannot resolve binding '${req.binding}'` } };
  }
  try {
    let cur: unknown = client;
    let parent: unknown = client;
    for (const seg of req.path) {
      if (cur === null || typeof cur !== 'object') {
        return { ok: false, error: { name: 'TypeError', message: `Cannot resolve ${req.binding}.${req.path.join('.')}` } };
      }
      parent = cur;
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (typeof cur !== 'function') {
      return { ok: false, error: { name: 'TypeError', message: `${req.binding}.${req.path.join('.')} is not a function` } };
    }
    const value = await (cur as (...a: unknown[]) => unknown).apply(parent, req.args);
    return { ok: true, value };
  } catch (err) {
    const e = err as { name?: string; message?: string; status?: number };
    return { ok: false, error: { name: e.name ?? 'Error', message: e.message ?? String(err), status: e.status } };
  }
}
