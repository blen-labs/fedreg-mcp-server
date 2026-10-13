export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
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
    throw new ApiError(data.error ?? 'Something went wrong. Try again.', response.status);
  return data as T;
}

export interface Config {
  google: boolean;
  email: boolean;
  mcpUrl: string;
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
