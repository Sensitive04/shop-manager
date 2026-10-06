'use client';

import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { api, useSubmit } from '@/components/api-client';
import { Button, Card, ErrorBanner, Input } from '@/components/ui';

/**
 * Sign-in page.
 *
 * The only page reachable without a session. A failed attempt shows the same
 * message whether the username or the password was wrong, matching what
 * `/api/auth/login` returns, so the form cannot be used to discover which
 * accounts exist.
 *
 * Wrapped in `<Suspense>` because `useSearchParams` opts the whole subtree into
 * client-side rendering, and this route is statically prerendered at build time.
 */
function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Preserve where the visitor was heading, but only accept a same-site path:
  // an attacker could otherwise craft /login?next=https://evil.example to bounce
  // someone off-site after they authenticate.
  const requested = searchParams.get('next') ?? '';
  const next = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const { submit, pending, error, fieldErrors } = useSubmit(async () => {
    await api.post<{ ok: true }>('/api/auth/login', { username, password });
    // The cookie is already set by the response; a refresh makes the server layout
    // re-run its own session check rather than trusting client state.
    //
    // `next` is a runtime string, so the typed-routes compiler cannot verify it is
    // one of the app's routes. It is constrained to a same-site absolute path by
    // the check above, which is what makes the cast safe rather than a way of
    // silencing a genuine mismatch.
    router.replace(next as Route);
    router.refresh();
  });

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink-50 px-4 py-12">
      <Card className="w-full max-w-sm">
        <div className="space-y-6">
          <div>
            <h1 className="text-xl font-semibold text-ink-900">Skincare Manager</h1>
            <p className="mt-1 text-sm text-ink-500">Sign in to continue.</p>
          </div>

          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {error && <ErrorBanner message={error} />}

            <Input
              label="Username"
              name="username"
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              error={fieldErrors.username}
            />
            <Input
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={fieldErrors.password}
            />

            <Button type="submit" loading={pending} className="w-full justify-center">
              {pending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </div>
      </Card>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-ink-50" />}>
      <LoginForm />
    </Suspense>
  );
}