import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';

/** Loads data once (and on demand); a 401 sends the browser to sign in. */
export function useLoad<T>(load: () => Promise<T>, signInNext?: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
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
