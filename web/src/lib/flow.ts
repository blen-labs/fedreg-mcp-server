import { useLocation } from 'react-router';

/**
 * The signed subset of a Better Auth redirect query: `sig`, `ba_param`, and the
 * parameters `ba_param` names. Empty outside an OAuth connection.
 */
export function signedQuery(search: string) {
  const params = new URLSearchParams(search);
  const names = new Set(params.getAll('ba_param'));
  if (!params.has('sig') || names.size === 0) return '';
  const signed = new URLSearchParams();
  for (const [key, value] of params)
    if (key === 'sig' || key === 'ba_param' || names.has(key)) signed.append(key, value);
  return signed.toString();
}

/** A same-origin path to return to after signing in outside a connection. */
export function safeNext(value: string | null) {
  if (!value?.startsWith('/')) return '/account';
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin ? url.pathname + url.search : '/account';
  } catch {
    return '/account';
  }
}

/** The current connection request (if any) and the page to return to otherwise. */
export function useFlow() {
  const { search } = useLocation();
  const oauthQuery = signedQuery(search);
  const next = safeNext(new URLSearchParams(search).get('next'));
  // Links between sign-in pages keep the signed query, or the return path.
  const keep = oauthQuery ? `?${oauthQuery}` : `?${new URLSearchParams({ next })}`;
  return { oauthQuery, next, keep };
}
