import 'server-only';

import { randomBytes } from 'node:crypto';

import { cookies } from 'next/headers';

import { connectToDatabase } from '@/lib/db';
import { UnauthorizedError } from '@/lib/errors';
import { hashesMatch, hashPassword, hashToken, verifyPassword } from '@/lib/password';
import { DUMMY_PASSWORD_HASH } from '@/lib/password';
import { SESSION_COOKIE } from '@/lib/session';
import { User } from '@/models/User';

/**
 * Authentication.
 *
 * One shop, one user. The design is deliberately small, but two choices are worth
 * stating because they are the parts that are hard to change later:
 *
 *  1. **Server-side revocable sessions, not JWTs.** A signed self-contained token
 *     cannot be withdrawn — a leaked cookie stays valid until it expires. Since
 *     this app is about to expose a *permanent delete*, "revoke this session now"
 *     has to exist. A random token whose hash lives in `user.sessionTokens` gives
 *     that for free, at the cost of one indexed lookup per request.
 *
 *  2. **Hashing lives in `lib/password.ts`.** This module touches `next/headers`,
 *     which only resolves inside a request, so anything that needs to hash a
 *     password outside a request (the seed script) imports the primitives
 *     directly instead.
 */

export { hashPassword, verifyPassword } from '@/lib/password';
export { SESSION_COOKIE } from '@/lib/session';

/**
 * Session lifetime. Long enough that nobody is logged out mid-shift, short
 * enough that a forgotten cookie on a shared till machine stops mattering.
 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Drop tokens that have expired, so the array cannot grow without bound.
 *
 * Runs on every login, before the new token is added. It is one indexed
 * `updateOne` and logins are rare, so it needs no throttle — and skipping that
 * optimisation keeps the ordering guarantee that the new token is never itself a
 * candidate for removal.
 */
async function sweepExpiredSessions(userId: unknown): Promise<void> {
  await User.updateOne(
    { _id: userId },
    { $pull: { sessionTokens: { expiresAt: { $lt: new Date() } } } },
  );
}

/**
 * Authenticate and start a session.
 *
 * A missing user and a wrong password take the same code path and comparable
 * time, so this cannot be used to enumerate usernames.
 */
export async function login(
  username: string,
  password: string,
): Promise<{ userId: string; token: string }> {
  await connectToDatabase();

  const normalized = username.trim().toLowerCase();
  const user = await User.findOne({ username: normalized }).select('+passwordHash');

  // Verify against the stored digest when the account exists, and against a real
  // dummy digest when it does not, so an unknown username is not measurably
  // faster than a wrong password. The dummy hash is never a real credential.
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !passwordOk) {
    throw new UnauthorizedError('Incorrect username or password.');
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  // Sweep first: pruning after the push would put the new token in the same
  // `$pull` scope, which is only safe because its expiry is in the future.
  await sweepExpiredSessions(user._id);
  await User.updateOne(
    { _id: user._id },
    {
      $push: { sessionTokens: { tokenHash: await hashToken(token), expiresAt } },
      $set: { lastLoginAt: new Date() },
    },
  );

  return { userId: String(user._id), token };
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
}

/**
 * Resolve the current session, or throw `UnauthorizedError`.
 *
 * The indexed lookup proves some token matched; the constant-time re-check then
 * confirms it and that it has not expired. That second pass matters because an
 * expired-but-present token must not authenticate.
 */
export async function requireSession(): Promise<SessionUser> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new UnauthorizedError();

  await connectToDatabase();

  const tokenHash = await hashToken(token);
  const user = await User.findOne({ 'sessionTokens.tokenHash': tokenHash });
  if (!user) throw new UnauthorizedError();

  const now = Date.now();
  const live = user.sessionTokens.some(
    (entry) => entry.expiresAt.getTime() > now && hashesMatch(entry.tokenHash, tokenHash),
  );
  if (!live) throw new UnauthorizedError();

  return {
    id: String(user._id),
    username: user.username,
    displayName: user.displayName || user.username,
  };
}

/** Invalidate the current session. Safe to call when already signed out. */
export async function logout(): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return;

  await connectToDatabase();

  const tokenHash = await hashToken(token);
  await User.updateOne(
    { 'sessionTokens.tokenHash': tokenHash },
    { $pull: { sessionTokens: { tokenHash } } },
  );
}

/** Cookie options for the session. */
export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    // Not readable from JavaScript, so an XSS bug cannot exfiltrate the session.
    httpOnly: true,
    // `lax` still sends the cookie on top-level navigation, so a deep link into
    // /pos works after signing in, but not on cross-site POSTs — which blocks
    // CSRF without needing a separate token.
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  };
}

/**
 * Create the owner account if it does not exist.
 *
 * Never overwrites an existing username. Re-running the seed must not silently
 * reset a password that has since been changed or rotated.
 */
export async function ensureUser(input: {
  username: string;
  password: string;
  displayName?: string;
}): Promise<{ id: string; created: boolean }> {
  await connectToDatabase();

  const username = input.username.trim().toLowerCase();
  const existing = await User.findOne({ username }).select('_id').lean();
  if (existing) return { id: String(existing._id), created: false };

  const created = await User.create({
    username,
    passwordHash: await hashPassword(input.password),
    ...(input.displayName ? { displayName: input.displayName } : {}),
  });

  return { id: String(created._id), created: true };
}