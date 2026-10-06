/**
 * Constants shared between the Next middleware and the server auth code.
 *
 * Kept out of `lib/auth.ts` on purpose: middleware runs on the Edge runtime and
 * must not pull in `server-only` or `next/headers`. `SESSION_COOKIE` is the one
 * thing both sides need to agree on.
 */

/** Name of the HttpOnly session cookie set by the login route. */
export const SESSION_COOKIE = 'shop_session';