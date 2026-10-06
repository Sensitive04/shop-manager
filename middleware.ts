import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE } from '@/lib/session';

/**
 * Server-side page guard.
 *
 * The `(app)` layout also redirects unauthenticated visitors, but Next streams a
 * route-group layout after the shell has flushed, so that guard can only emit a
 * client-side `<meta refresh>` — status 200, redirect executed by the browser a
 * second later. Middleware runs before the render, so a request with no session
 * cookie gets a real 307 straight to `/login`.
 *
 * This layer only checks that *a* session cookie exists. Proving it is still
 * valid (not expired, not revoked) requires a database lookup, which happens in
 * `requireSession` — the layout and every protected API route. A stale cookie
 * therefore still falls through to the layout guard, which is the correct place
 * for the expensive check.
 */
export default function middleware(request: NextRequest) {
  if (!request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Only the signed-in pages. API routes are guarded by `protectedRoute` (and
  // `/api/health` must stay reachable without a session for the Docker
  // healthcheck); `/login` is the destination we redirect to; `_next` and file
  // requests have no auth of their own to skip.
  matcher: ['/((?!api|_next|login|favicon.ico|.*\\..*).*)'],
};