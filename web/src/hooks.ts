import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/** Loads a GET endpoint; `reload` refetches after a mutation. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return;
    let live = true;
    setError(null);
    api<T>(path)
      .then((d) => live && setData(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [path, tick]);

  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []) };
}
