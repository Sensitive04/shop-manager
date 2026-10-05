import { describe, expect, it } from 'vitest';

import { resolveConnectionSettings } from '@/lib/db';

/**
 * Guards for the misconfiguration that took the Netlify deploy down.
 *
 * Two independent failures came out of declaring `NODE_ENV=production` in the
 * Netlify UI:
 *
 *   1. npm skipped every devDependency at install time, so the build could not
 *      resolve `@tailwindcss/postcss` (the CSS pipeline) or `mongodb-memory-server`
 *      (the development database). Both are development-only, so a production
 *      build should not need either to exist.
 *
 *   2. The in-memory fallback guard consulted NODE_ENV, which meant the only thing
 *      stopping a deployed function from silently attaching to a throwaway
 *      database was a variable that also had to stay unset for the build to work.
 *
 * These tests pin the behaviour that removes the contradiction. Everything here
 * is pure — `resolveConnectionSettings` inspects an environment object and
 * returns a verdict, it never connects — so no replica set is needed.
 */

describe('resolveConnectionSettings with a configured URI', () => {
  it('returns the trimmed URI and no error', () => {
    const result = resolveConnectionSettings({
      MONGODB_URI: 'mongodb+srv://user:pw@cluster.example.net/',
    });

    expect(result.uri).toBe('mongodb+srv://user:pw@cluster.example.net/');
    expect(result.error).toBeNull();
  });

  it('trims surrounding whitespace, which is easy to paste in', () => {
    const result = resolveConnectionSettings({
      MONGODB_URI: '  mongodb://localhost:27017/shop  ',
    });

    expect(result.uri).toBe('mongodb://localhost:27017/shop');
  });

  it('treats a whitespace-only value as unset rather than connecting to nothing', () => {
    const result = resolveConnectionSettings({
      MONGODB_URI: '   ',
    });

    expect(result.uri).toBeNull();
  });

  it('succeeds even with the fallback disabled, because the URI is authoritative', () => {
    const result = resolveConnectionSettings({
      MONGODB_URI: 'mongodb+srv://user:pw@cluster.example.net/',
      MONGODB_MEMORY_FALLBACK: 'false',
    });

    expect(result.error).toBeNull();
    expect(result.memoryFallbackAllowed).toBe(false);
  });
});

describe('resolveConnectionSettings database name', () => {
  it('defaults to shopmanager, never the driver default of test', () => {
    const result = resolveConnectionSettings({
      MONGODB_URI: 'mongodb+srv://user:pw@cluster.example.net/',
    });

    // An Atlas SRV string ends in a bare `/` and names no database. Without an
    // explicit name the driver writes every sale to a database called `test`.
    expect(result.dbName).toBe('shopmanager');
  });

  it('honours MONGODB_DB_NAME when provided', () => {
    const result = resolveConnectionSettings({
      MONGODB_URI: 'mongodb+srv://user:pw@cluster.example.net/',
      MONGODB_DB_NAME: 'another-shop',
    });

    expect(result.dbName).toBe('another-shop');
  });

  it('falls back to the default when MONGODB_DB_NAME is blank', () => {
    const result = resolveConnectionSettings({
      MONGODB_URI: 'mongodb://localhost:27017/',
      MONGODB_DB_NAME: '  ',
    });

    expect(result.dbName).toBe('shopmanager');
  });
});

describe('resolveConnectionSettings fallback policy', () => {
  it('allows the in-memory fallback when nothing is configured (development)', () => {
    const result = resolveConnectionSettings({});

    expect(result.uri).toBeNull();
    expect(result.memoryFallbackAllowed).toBe(true);
    expect(result.error).toBeNull();
  });

  it.each(['false', '0', 'no', 'FALSE', 'No'])(
    'treats MONGODB_MEMORY_FALLBACK=%s as disabled',
    (value) => {
      const result = resolveConnectionSettings({
        MONGODB_MEMORY_FALLBACK: value,
      });

      expect(result.memoryFallbackAllowed).toBe(false);
      expect(result.error).not.toBeNull();
    },
  );

  it.each(['true', '1', 'yes', 'anything-else'])(
    'treats MONGODB_MEMORY_FALLBACK=%s as enabled',
    (value) => {
      const result = resolveConnectionSettings({
        MONGODB_MEMORY_FALLBACK: value,
      });

      expect(result.memoryFallbackAllowed).toBe(true);
      expect(result.error).toBeNull();
    },
  );

  it('does not consult NODE_ENV, so the production guard survives its absence', () => {
    // The whole point: a deployed function must not depend on NODE_ENV being
    // set, because setting it in the Netlify UI also breaks the build.
    const withProduction = resolveConnectionSettings({
      NODE_ENV: 'production',
      MONGODB_MEMORY_FALLBACK: 'false',
    });

    expect(withProduction.error).not.toBeNull();

    const withoutNodeEnv = resolveConnectionSettings({
      MONGODB_MEMORY_FALLBACK: 'false',
    });

    expect(withoutNodeEnv.error).toBe(withProduction.error);
  });

  it('still allows the fallback under NODE_ENV=production when explicitly enabled', () => {
    // Documented behaviour rather than aspiration: the fallback is controlled by
    // one variable, so a developer who sets NODE_ENV=production locally and wants
    // the throwaway database still gets it.
    const result = resolveConnectionSettings({
      NODE_ENV: 'production',
    });

    expect(result.memoryFallbackAllowed).toBe(true);
    expect(result.error).toBeNull();
  });
});

describe('resolveConnectionSettings error message', () => {
  it('names the missing variable and the fix', () => {
    const { error } = resolveConnectionSettings({
      MONGODB_MEMORY_FALLBACK: 'false',
    });

    // This message is the only clue an operator gets, since handleRoute returns a
    // generic INTERNAL_ERROR to the browser and the detail goes to the log.
    expect(error).toContain('MONGODB_URI');
    expect(error).toContain('MONGODB_MEMORY_FALLBACK=false');
    expect(error).toContain('replica set');
  });

  it('never echoes the URI or any credential', () => {
    const { error } = resolveConnectionSettings({});
    expect(error).toBeNull();

    const withError = resolveConnectionSettings({
      MONGODB_URI: '',
      MONGODB_MEMORY_FALLBACK: 'false',
      DB_PASSWORD: 'super-secret',
    });

    expect(withError.error).not.toContain('super-secret');
  });
});
