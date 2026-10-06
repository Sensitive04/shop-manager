'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiResponse } from '@/types/api';

/**
 * Typed fetch wrapper for the app's API.
 *
 * Every endpoint answers with the same `{ ok, data } | { ok, error }` envelope,
 * so this unwraps it in one place. Failures throw an `ApiRequestError` carrying
 * the per-field issues, which lets forms highlight individual inputs.
 */

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: { path: string; message: string }[];

  constructor(
    message: string,
    status: number,
    code: string,
    issues: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }

  /** Build a field -> message map for form rendering. */
  get fieldErrors(): Record<string, string> {
    return this.issues.reduce<Record<string, string>>((acc, issue) => {
      // Keep the first message per field; later ones are usually cascading.
      if (!(issue.path in acc)) acc[issue.path] = issue.message;
      return acc;
    }, {});
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...init,
      // Explicit: the session cookie is the app's only credential, so every
      // request must carry it. `same-origin` is the default for a same-origin
      // fetch, but relying on that implicitly is how a future absolute-URL call
      // silently starts dropping auth.
      credentials: 'same-origin',
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    // Network-level failure: the server was unreachable.
    throw new ApiRequestError(
      'Could not reach the server. Check your connection and try again.',
      0,
      'NETWORK_ERROR',
    );
  }

  let payload: ApiResponse<T>;

  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiRequestError(
      'The server returned an unexpected response.',
      response.status,
      'BAD_RESPONSE',
    );
  }

  if (!payload.ok) {
    // An expired or revoked session turns every page into a stream of 401s. Bounce
    // to the login screen once, rather than letting each card render its own
    // "sign in to continue" message. `replace` keeps the dead page out of history
    // so Back cannot loop the visitor into another 401.
    if (response.status === 401 && !path.startsWith('/api/auth')) {
      redirectToLogin();
    }

    throw new ApiRequestError(
      payload.error.message,
      response.status,
      payload.error.code,
      payload.error.issues ?? [],
    );
  }

  return payload.data;
}

/**
 * Send the visitor to the login page, preserving where they were.
 *
 * A full navigation rather than a router push, and deliberately: the session
 * cookie has to be re-read by the server before the new route renders, and a
 * client-side navigation would render the page shell first and then bounce. The
 * `next` value is built from `pathname` + `search` only, both of which are
 * same-site by construction, and the login page re-validates it server-side.
 */
function redirectToLogin() {
  if (typeof window === 'undefined') return;
  if (window.location.pathname === '/login') return;

  const next = `${window.location.pathname}${window.location.search}`;
  // The lint rule prefers a router push, which is not reachable here: this is a
  // plain module called from a fetch callback, not a component render or event
  // handler, so there is no router instance to use. A client-side push would also
  // be wrong — the `(app)` layout's session check only runs on a server render,
  // so the redirect has to be a real navigation.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.href = `/login?next=${encodeURIComponent(next)}`;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  /** True only for the first load, so refreshes don't blank the screen. */
  loading: boolean;
  /** True while re-fetching with data already on screen. */
  refreshing: boolean;
}

export interface UseAsyncResult<T> extends AsyncState<T> {
  reload: () => Promise<void>;
  setData: (value: T | null) => void;
}

/**
 * Load data on mount and expose a `reload` for after mutations.
 *
 * Stale responses are discarded via a request counter, so a slow first request
 * cannot overwrite a fast second one.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
): UseAsyncResult<T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    error: null,
    loading: true,
    refreshing: false,
  });

  const requestId = useRef(0);
  const mounted = useRef(true);
  // Hold the latest loader in a ref so `run` stays stable while still calling the
  // current closure. Written in an effect rather than during render — mutating a
  // ref mid-render is unsafe under concurrent rendering, and the fetch effect
  // below is declared afterwards so it always observes the fresh value.
  const loaderRef = useRef(loader);

  useEffect(() => {
    loaderRef.current = loader;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    const id = ++requestId.current;

    setState((previous) => ({
      ...previous,
      loading: previous.data === null,
      refreshing: previous.data !== null,
      error: null,
    }));

    try {
      const data = await loaderRef.current();
      // Ignore a response that a newer request has already superseded.
      if (!mounted.current || id !== requestId.current) return;
      setState({ data, error: null, loading: false, refreshing: false });
    } catch (error) {
      if (!mounted.current || id !== requestId.current) return;
      setState({
        data: null,
        error:
          error instanceof Error
            ? error.message
            : 'Something went wrong loading this data.',
        loading: false,
        refreshing: false,
      });
    }
  }, []);

  useEffect(() => {
    // Fetching on mount is precisely "synchronising with an external system", so
    // the loading flag legitimately comes from an effect. Every page guards on
    // `loading` rather than deriving it, so there is nothing better to move to
    // render time.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const setData = useCallback((value: T | null) => {
    setState((previous) => ({ ...previous, data: value }));
  }, []);

  return { ...state, reload: run, setData };
}

/**
 * Submit helper that tracks pending state and normalises errors.
 *
 * `submit` keeps a stable identity across renders (the action is held in a ref)
 * so it is safe to pass into memoised children. When the action takes no
 * argument, the parameter becomes optional.
 */
export function useSubmit<TArgs = void, TResult = unknown>(
  action: (args: TArgs) => Promise<TResult>,
): {
  submit: [TArgs] extends [void]
    ? (args?: TArgs) => Promise<TResult | null>
    : (args: TArgs) => Promise<TResult | null>;
  pending: boolean;
  error: string | null;
  fieldErrors: Record<string, string>;
  clearError: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});

  // An inline arrow in render would otherwise invalidate `submit` every pass.
  // Written in an effect, not during render — see the note in `useAsync`.
  const actionRef = useRef(action);

  useEffect(() => {
    actionRef.current = action;
  });

  const submit = useCallback(async (args?: TArgs) => {
    setPending(true);
    setError(null);
    setIssues({});

    try {
      return await actionRef.current(args as TArgs);
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        setError(caught.message);
        setIssues(caught.fieldErrors);
      } else {
        setError(
          caught instanceof Error
            ? caught.message
            : 'Something went wrong. Please try again.',
        );
      }
      return null;
    } finally {
      setPending(false);
    }
  }, []);

  return {
    submit,
    pending,
    error,
    fieldErrors: issues,
    clearError: () => {
      setError(null);
      setIssues({});
    },
  };
}