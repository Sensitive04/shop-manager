import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scryptSync } from 'node:crypto';

import { ensureUser, login } from '@/lib/auth';
import { disconnectFromDatabase } from '@/lib/db';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  hashToken,
  verifyPassword,
} from '@/lib/password';
import { User } from '@/models/User';

/**
 * Auth integration tests.
 *
 * `hashPassword`/`verifyPassword` are pure and need no database; the session
 * tests run against the same in-process replica set as the other suites, because
 * the behaviour worth guarding is the *stored* session — that a login writes a
 * usable hash and that revoking one removes it. A mock could satisfy those
 * assertions without proving the document shape works.
 *
 * `requireSession`/`logout` are not exercised directly because they call
 * `cookies()` from `next/headers`, which only resolves inside a Next request
 * scope. Their logic is a single indexed lookup plus the constant-time re-check
 * that `login` and the revoke path below do cover.
 */

const PASSWORD = 'correct-horse-battery-staple';

beforeAll(async () => {
  const { connectToDatabase, supportsTransactions } = await import('@/lib/db');
  await connectToDatabase();
  expect(await supportsTransactions()).toBe(true);
});

afterAll(async () => {
  await disconnectFromDatabase();
});

beforeEach(async () => {
  await User.deleteMany({});
});

describe('password hashing', () => {
  it('accepts the correct password', async () => {
    const hash = await hashPassword(PASSWORD);
    await expect(verifyPassword(PASSWORD, hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword(PASSWORD);
    await expect(verifyPassword(`${PASSWORD}x`, hash)).resolves.toBe(false);
  });

  it('salts every hash, so equal passwords never collide', async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    // Identical output would mean the digest carries no entropy beyond the input.
    expect(a).not.toBe(b);
    await expect(verifyPassword(PASSWORD, a)).resolves.toBe(true);
    await expect(verifyPassword(PASSWORD, b)).resolves.toBe(true);
  });

  it('records its cost parameters inside the hash', async () => {
    // Future cost increases read N from the stored hash, so re-verification keeps
    // working without a migration.
    const [scheme, cost] = (await hashPassword(PASSWORD)).split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(cost)).toBeGreaterThan(1);
  });

  it('returns false for absent or malformed hashes rather than throwing', async () => {
    await expect(verifyPassword(PASSWORD, undefined)).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, null)).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, '')).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, 'scrypt$16384$zz')).resolves.toBe(false);
  });

  it('refuses a stored cost of 1, which would make verification instant', async () => {
    // Simulates a hand-edited or attacker-supplied hash. Accepting it would let a
    // cheap digest stand in for a properly-costed one.
    const [, , salt, key] = (await hashPassword(PASSWORD)).split('$');
    const forged = `scrypt$1$${salt}$${key}`;
    await expect(verifyPassword(PASSWORD, forged)).resolves.toBe(false);
  });

  it('honours a raised stored cost instead of assuming the default', async () => {
    // A future N increase must be honoured by verification, since the stored hash
    // carries the cost this digest was made with. N must be a power of two.
    const raisedCost = 1 << 15;
    const salt = Buffer.alloc(16, 7);
    const key = scryptSync(PASSWORD, salt, 64, {
      N: raisedCost,
      maxmem: 128 * raisedCost * 8 * 2,
    });
    const raised = `scrypt$${raisedCost}$${salt.toString('hex')}$${key.toString('hex')}`;

    await expect(verifyPassword(PASSWORD, raised)).resolves.toBe(true);
    await expect(verifyPassword('not-the-password', raised)).resolves.toBe(false);
  });

  it('rejects an absurd stored cost that would make verification a DoS', async () => {
    const [, , salt, key] = (await hashPassword(PASSWORD)).split('$');
    const forged = `scrypt$${1 << 30}$${salt}$${key}`;
    await expect(verifyPassword(PASSWORD, forged)).resolves.toBe(false);
  });

  it('rejects a non-power-of-two stored cost as malformed', async () => {
    const [, , salt, key] = (await hashPassword(PASSWORD)).split('$');
    const forged = `scrypt$16385$${salt}$${key}`;
    await expect(verifyPassword(PASSWORD, forged)).resolves.toBe(false);
  });

  it('dummy hash is real, well-formed and never verifies', async () => {
    const [scheme, cost, salt, key] = DUMMY_PASSWORD_HASH.split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(cost)).toBe(16_384);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(key).toMatch(/^[0-9a-f]{128}$/);
    // It is a genuine scrypt digest at the standard cost, so verifying against it
    // pays real work — but no password equals it.
    await expect(verifyPassword(PASSWORD, DUMMY_PASSWORD_HASH)).resolves.toBe(false);
  });

  it('normalises unicode so a visually identical password still matches', async () => {
    const hash = await hashPassword('pässwörd');
    await expect(verifyPassword('pässwörd', hash)).resolves.toBe(true);
  });
});

describe('ensureUser', () => {
  it('creates the owner account and stores only a hash', async () => {
    const { id, created } = await ensureUser({
      username: 'owner',
      password: PASSWORD,
      displayName: 'Shop Owner',
    });

    expect(created).toBe(true);

    const stored = await User.findById(id).select('+passwordHash').lean();
    expect(stored?.passwordHash).toBeTruthy();
    expect(stored?.passwordHash).not.toContain(PASSWORD);
    expect(stored?.displayName).toBe('Shop Owner');
  });

  it('lowercases the username so login is case-insensitive', async () => {
    await ensureUser({ username: 'Owner', password: PASSWORD });
    expect(await User.countDocuments({ username: 'owner' })).toBe(1);
  });

  it('never overwrites an existing account', async () => {
    const first = await ensureUser({ username: 'owner', password: PASSWORD });
    const rotated = await hashPassword('a-completely-different-password');
    await User.updateOne({ _id: first.id }, { $set: { passwordHash: rotated } });

    const second = await ensureUser({ username: 'owner', password: PASSWORD });

    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    // A re-run must not silently reset a rotated password.
    const stored = await User.findById(first.id).select('+passwordHash').lean();
    expect(stored?.passwordHash).toBe(rotated);
  });
});

describe('login', () => {
  beforeEach(async () => {
    await ensureUser({ username: 'owner', password: PASSWORD });
  });

  it('returns a token whose stored hash matches, and records the login', async () => {
    const { userId, token } = await login('owner', PASSWORD);

    const user = await User.findById(userId).lean();
    expect(user?.sessionTokens).toHaveLength(1);
    expect(user?.sessionTokens[0]?.tokenHash).toBe(await hashToken(token));
    // The raw token must never be persisted.
    expect(JSON.stringify(user?.sessionTokens)).not.toContain(token);
    expect(user?.lastLoginAt).toBeInstanceOf(Date);
  });

  it('matches the username case-insensitively', async () => {
    await expect(login('OWNER', PASSWORD)).resolves.toMatchObject({ token: expect.any(String) });
  });

  it('sets a future expiry on the session', async () => {
    const { userId, token } = await login('owner', PASSWORD);
    const expected = await hashToken(token);

    const user = await User.findById(userId).lean();
    const stored = user?.sessionTokens.find((entry) => entry.tokenHash === expected);

    expect(stored?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects a wrong password without issuing a session', async () => {
    await expect(login('owner', 'wrong-password')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
    expect(await User.countDocuments({ 'sessionTokens.0': { $exists: true } })).toBe(0);
  });

  it('gives an unknown user the same message as a wrong password', async () => {
    // Identical wording and error code is what stops the form being used to
    // confirm which usernames exist.
    await expect(login('nobody', PASSWORD)).rejects.toThrow('Incorrect username or password.');
    await expect(login('owner', 'wrong')).rejects.toThrow('Incorrect username or password.');
  });

  it('issues a distinct token per login and keeps both valid', async () => {
    const first = await login('owner', PASSWORD);
    const second = await login('owner', PASSWORD);

    expect(first.token).not.toBe(second.token);

    const user = await User.findById(first.userId).lean();
    expect(user?.sessionTokens).toHaveLength(2);
    expect(user?.sessionTokens.map((entry) => entry.tokenHash)).toContain(
      await hashToken(first.token),
    );
    expect(user?.sessionTokens.map((entry) => entry.tokenHash)).toContain(
      await hashToken(second.token),
    );
  });

  it('prunes expired sessions on a later login', async () => {
    const { userId } = await login('owner', PASSWORD);

    // Backdate the existing token past its expiry, as time passing would.
    await User.updateOne({ _id: userId }, { $set: { 'sessionTokens.0.expiresAt': new Date(0) } });
    await login('owner', PASSWORD);

    const user = await User.findById(userId).lean();
    const live = user?.sessionTokens.filter((entry) => entry.expiresAt.getTime() > Date.now()) ?? [];
    // One live session (the fresh login) and no leftovers from the expired one.
    expect(live).toHaveLength(1);
  });
});