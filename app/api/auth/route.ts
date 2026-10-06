import { created, handleRoute, ok, readJson } from '@/lib/api';
import { login, logout, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth';
import { loginSchema } from '@/lib/validators';

/**
 * POST /api/auth/login — exchange credentials for a session cookie.
 *
 * This is the only unauthenticated write in the app. It returns 401 on bad
 * credentials via `UnauthorizedError`, which `handleRoute` renders through the
 * normal envelope — so the client needs no special case to read the error.
 */
export const POST = handleRoute(async (request: Request) => {
  const input = loginSchema.parse(await readJson(request));
  const { token } = await login(input.username, input.password);

  // The raw token goes out only here, once. Everything stored server-side is a
  // hash of it, so there is no path from the database back to a live cookie.
  const response = created({ ok: true });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return response;
});

/**
 * DELETE /api/auth/login — sign out.
 *
 * Revokes the session server-side *and* clears the cookie. Clearing only the
 * cookie would leave a stolen copy valid for the full 30 days; revoking only the
 * session would leave the browser replaying a dead token.
 *
 * Safe to call when already signed out, so the client can call it on a 401 loop
 * without checking.
 */
export const DELETE = handleRoute(async () => {
  await logout();

  const response = ok({ signedOut: true });
  response.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0 });
  return response;
});