import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing.
 *
 * Split out from `lib/auth.ts` deliberately: the seed script needs to hash a
 * password but has no business importing `next/headers`, which only resolves
 * inside a request scope. Keeping the primitives here means both the session
 * code and standalone scripts depend on this module alone.
 *
 * scrypt is used rather than bcrypt or argon2 because it is memory-hard, ships
 * with Node, and has no native build step — nothing here can break the Netlify
 * bundle, which is the failure mode that already cost one deployment.
 */

type ScryptOptions = { N: number; maxmem: number };

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: ScryptOptions,
) => Promise<Buffer>;

/**
 * Memory budget for one scrypt call.
 *
 * Node's own default `maxmem` is 32 MB, which silently caps N at 32768
 * (128·N·r bytes). Since a stored hash can legitimately carry a cost above that,
 * verification must compute a budget from the digest it is checking rather than
 * rely on the default. The 2× headroom keeps the math away from the boundary.
 */
function scryptBudget(N: number): number {
  return 128 * N * 8 * 2;
}

/**
 * scrypt cost parameters.
 *
 * N=16384 with Node's default r=8/p=1 costs roughly 16 MB and 50-80 ms per hash:
 * appropriate for a single-shop login, and expensive enough that an offline crack
 * of a leaked digest is not trivial. N is stored *inside* the hash so the cost can
 * be raised later without a migration — `verifyPassword` reads it from what it is
 * checking, though note only N is recoverable; r and p are fixed at Node's
 * defaults, so changing them would need the format version too.
 */
export const SCRYPT_N = 16_384;

/**
 * Ceiling for a stored N in a hash this code will verify.
 *
 * `verifyPassword` regularly checks untrusted strings (a corrupted database, a
 * forged hash), so the parsed cost must be bounded: an attacker who could write
 * a `scrypt$17179869184$...` blob would otherwise make verification itself a
 * denial-of-service. The memory that 128·N·8 bytes requires keeps rising with
 * cost, so hashes at or above this bound are treated as malformed and rejected
 * as false. 2^16 is still far beyond anything the app stores today.
 */
const SCRYPT_MAX_N = 1 << 16;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * A real scrypt digest of a throwaway string, used to equalise login timing when
 * the username does not exist.
 *
 * `verifyPassword` returns instantly when no stored hash is given, so a login
 * against an unknown username would otherwise do zero KDF work — measurably
 * cheaper than a wrong password against a real account, and exactly the
 * enumeration signal that the identical error message is meant to hide. Verifying
 * the supplied password against this fixed digest keeps both paths through the
 * same cost. It is never a valid credential for anything, and it is not a secret.
 */
export const DUMMY_PASSWORD_HASH =
  'scrypt$16384$de5ab740ad7312d99a06d5a49ae547da$5798379d2d77f1575eae24c60bbb16a6bbaddf142370cbfe7cce2b1ce6ab85bea9170a8e680734e2ded2e86a0ffbc4d1338b213f22ca69c66147cb97d8455dd1';

/** Hash a password as `scrypt$<N>$<saltHex>$<keyHex>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    maxmem: scryptBudget(SCRYPT_N),
  });

  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verify a password against a stored hash in constant time.
 *
 * Returns false instead of throwing on malformed input, so a corrupted or
 * foreign-format hash is indistinguishable from a wrong password to the caller.
 */
export async function verifyPassword(
  password: string,
  stored: string | undefined | null,
): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

  const cost = Number(parts[1]);
  const salt = Buffer.from(parts[2] ?? '', 'hex');
  const expected = Buffer.from(parts[3] ?? '', 'hex');

  // Reject an attacker-supplied cost of 1: scrypt with a tiny N would otherwise
  // make verification near-instant and undermine the whole point of the KDF.
  // The upper bound keeps verification from becoming a DoS in its own right.
  if (
    !Number.isInteger(cost) ||
    cost <= 1 ||
    cost > SCRYPT_MAX_N ||
    (cost & (cost - 1)) !== 0 ||
    salt.length === 0 ||
    expected.length === 0
  ) {
    return false;
  }

  const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N: cost,
    maxmem: scryptBudget(cost),
  });

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Fixed salt for token hashing.
 *
 * Not secret, and deliberately not per-token: the input is 32 bytes of CSPRNG
 * output, so there is no dictionary to slow down and nothing to brute-force. This
 * is a lookup key for an indexed query, not a password.
 */
const TOKEN_SALT = 'shop-manager/session-token/v1';

/** Hash a high-entropy session token to a hex digest. */
export async function hashToken(token: string): Promise<string> {
  const derived = await scrypt(token, TOKEN_SALT, 32);
  return derived.toString('hex');
}

/** Constant-time hex-string compare, for re-checking a candidate session token. */
export function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}