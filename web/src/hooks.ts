import { useCallback, useEffect, useRef, useState } from 'react';
import { UnauthorizedError } from './api.js';

/** Hash-router location, e.g. `#/runs/1/2/3` → ['runs','1','2','3']. */
export function useHashRoute(): { segments: string[]; navigate: (to: string) => void } {
  const [hash, setHash] = useState(() => window.location.hash || '#/');
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((to: string) => {
    window.location.hash = to.startsWith('#') ? to : `#${to}`;
  }, []);
  const segments = hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  return { segments, navigate };
}

export interface AsyncState<T> {
  data?: T;
  error?: string;
  loading: boolean;
  /** True when the session expired — the shell renders the login prompt. */
  unauthorized: boolean;
  reload: () => void;
}

/**
 * Fetch-with-polling hook. Polling (not WebSocket/SSE) is the v1 live-update mechanism
 * (ADR-026 / spec 04 OQ-1): a plain interval re-fetch, paused while the tab is hidden so a
 * background console doesn't bill DynamoDB reads forever.
 */
export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  pollMs?: number,
): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [unauthorized, setUnauthorized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetcherRef
      .current()
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(undefined);
        setUnauthorized(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) setUnauthorized(true);
        else setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  useEffect(() => {
    if (!pollMs) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, pollMs);
    return () => window.clearInterval(id);
  }, [pollMs]);

  return { data, error, loading, unauthorized, reload: () => setTick((t) => t + 1) };
}

/** Remember the selected installation across screens + reloads. */
export function useInstallation(): [number | undefined, (id: number) => void] {
  const [id, setId] = useState<number | undefined>(() => {
    const raw = window.localStorage.getItem('lca.installation');
    return raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
  });
  const set = useCallback((next: number) => {
    window.localStorage.setItem('lca.installation', String(next));
    setId(next);
  }, []);
  return [id, set];
}
