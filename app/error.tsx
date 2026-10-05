'use client';

import Link from 'next/link';

import { Button } from '@/components/ui';

/**
 * App-level error boundary.
 *
 * `error` is whatever was thrown; `reset` re-renders the segment, which re-runs
 * the client fetch. Because every page is a client component fetching from
 * `/api/*`, this is where a database outage surfaces for the user.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-red-200 bg-red-50 p-8 text-center">
        <h1 className="text-lg font-semibold text-red-900">Something went wrong</h1>
        <p className="mt-2 text-sm text-red-800">
          {error.message || 'An unexpected error occurred while loading this page.'}
        </p>
        {error.digest && (
          <p className="mt-1 font-mono text-xs text-red-600">Reference: {error.digest}</p>
        )}
        <div className="mt-6 flex justify-center gap-2">
          <Button variant="secondary" onClick={reset}>
            Try again
          </Button>
          <Link
            href="/"
            className="inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium text-red-900 hover:bg-red-100"
          >
            Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}