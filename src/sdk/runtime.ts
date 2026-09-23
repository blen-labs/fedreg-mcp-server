import type { RpcMethods, SourceMeta } from './sources/source.js';

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
  methods: Readonly<Record<string, RpcMethods>>;
  meta: SourceMeta[];
}

export async function dispatch(reg: DispatchRegistry, req: RpcRequest): Promise<RpcResponse> {
  // Validate the RPC envelope independently of AST preflight. Dotted keys inside
  // a single path segment must not alias an explicitly registered method.
  if (!req || typeof req.binding !== 'string' || !Array.isArray(req.path)
    || req.path.length === 0 || !req.path.every(p => typeof p === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p))
    || !Array.isArray(req.args)) {
    return { ok: false, error: { name: 'TypeError', message: 'Invalid SDK call' } };
  }
  const methods = Object.getOwnPropertyDescriptor(reg.methods, req.binding)?.value as RpcMethods | undefined;
  if (!methods) {
    const m = reg.meta.find(x => x.name === req.binding);
    if (m && !m.enabled) {
      return { ok: false, error: { name: 'SourceUnavailable', message: m.disabledReason ?? `${m.label} is unavailable` } };
    }
    return { ok: false, error: { name: 'TypeError', message: `Cannot resolve binding '${req.binding}'` } };
  }
  try {
    // Resolve only an own data property in the source's explicit registry.
    // Never walk the client object: TypeScript `private` is not a runtime boundary.
    const method = Object.getOwnPropertyDescriptor(methods, req.path.join('.'))?.value;
    if (typeof method !== 'function') {
      return { ok: false, error: { name: 'TypeError', message: `${req.binding}.${req.path.join('.')} is not a function` } };
    }
    const value = await method(...req.args);
    return { ok: true, value };
  } catch (err) {
    const e = err as { name?: string; message?: string; status?: number };
    return { ok: false, error: { name: e.name ?? 'Error', message: e.message ?? String(err), status: e.status } };
  }
}
