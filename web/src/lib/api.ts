export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The form field the error is about (`apiKey`), or undefined for a page-level error. */
    readonly field?: string,
  ) {
    super(message);
  }
}

/** A failed call as the page shows it: tied to a field, or a page-level notice. */
export interface Failure {
  message: string;
  field?: string;
}
export function failure(e: unknown): Failure {
  if (e instanceof ApiError) return { message: e.message, field: e.field };
  return { message: e instanceof Error ? e.message : 'Something went wrong. Try again.' };
}

/** Calls this server's portal API as the signed-in browser. */
export async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`/api/portal${path}`, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      data.error ?? 'Something went wrong. Try again.',
      response.status,
      typeof data.field === 'string' ? data.field : undefined,
    );
  return data as T;
}

export interface Config {
  google: boolean;
  email: boolean;
  /** Signed-in endpoint: OAuth, regulations.gov with the user's own key. */
  mcpUrl: string;
  /** Anonymous endpoint: Federal Register and eCFR, no sign-in. */
  publicMcpUrl?: string;
}
export interface Keys {
  email: string;
  personal: { connected: boolean };
}
export interface Connection {
  client: string;
  destination: string;
  local: boolean;
}
