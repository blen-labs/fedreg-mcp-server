import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';

/** Loads data once (and on demand); a 401 sends the browser to sign in. */
export function useLoad<T>(load: () => Promise<T>, signInNext?: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  // Callers pass inline functions; keep the latest ones without making `reload` change identity
  // (it would re-run the load effect after every render).
  const latest = useRef({ load, signInNext });
  useLayoutEffect(() => {
    latest.current = { load, signInNext };
  });
  const reload = useCallback(() => {
    const { load, signInNext } = latest.current;
    load()
      .then((value) => {
        setData(value);
        setError(undefined);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401 && signInNext !== undefined) {
          window.location.assign(`/sign-in?${new URLSearchParams({ next: signInNext })}`);
          return;
        }
        setError(e instanceof Error ? e.message : 'Something went wrong.');
      });
  }, []);
  useEffect(reload, [reload]);
  return { data, error, reload };
}
