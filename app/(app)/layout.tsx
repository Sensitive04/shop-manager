import { redirect } from 'next/navigation';

import { AppShell } from '@/components/app-shell';
import { requireSession } from '@/lib/auth';
import { UnauthorizedError } from '@/lib/errors';

/**
 * Route group holding the signed-in app pages.
 *
 * The session check lives here rather than in each page so a new page cannot
 * accidentally ship unprotected. It is the single server-side gate: the pages
 * themselves stay client components that fetch from `/api/*`, and every one of
 * those endpoints is independently guarded by `protectedRoute`, so this redirect
 * is a usability affordance and not the only thing standing between a visitor
 * and the ledger.
 *
 * A missing session throws `UnauthorizedError` from `requireSession`; catching it
 * here is what turns that into a redirect. Anything else propagates — a database
 * outage must render an error page, not bounce the user to a login form that
 * would fail the same way.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  let session;
  try {
    session = await requireSession();
  } catch (error) {
    // Only a missing/invalid session may send a visitor to /login. Anything else
    // (a database outage, a bug) must propagate so the error boundary renders
    // instead of bouncing the user to a form that cannot work anyway.
    if (!(error instanceof UnauthorizedError)) throw error;
  }

  if (!session) redirect('/login');

  return <AppShell user={session.displayName}>{children}</AppShell>;
}