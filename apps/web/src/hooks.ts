import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Runs an async loader, tracking loading/error and allowing a manual refresh.
 *
 * `deps` must include anything the loader closes over (typically the actor id), since
 * the loader function itself is intentionally excluded: callers pass an inline arrow,
 * and including it would restart the effect on every render.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loaderRef.current();
      if (mounted.current) setData(result);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, deps);

  useEffect(() => { void run(); }, [run]);

  return { data, error, loading, reload: run, setData };
}

/** Tracks a one-shot mutation (approve, verify, upload) with its result message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const run = useCallback(async (fn: () => Promise<string>) => {
    setBusy(true);
    setResult(null);
    try {
      setResult({ kind: 'ok', text: await fn() });
    } catch (err) {
      setResult({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, result, setResult, run };
}