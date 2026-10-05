import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration.
 *
 * The `@/*` alias mirrors tsconfig.json so tests import from the same paths the
 * app uses.
 */
export default defineConfig({
  // Vitest runs the suite through Vite's SSR pipeline, so the conditions that
  // matter live under `ssr.resolve`. `react-server` is required because the
  // server modules import `server-only`, whose default export throws outside a
  // React Server Component graph — the same reason the seed script runs with
  // `--conditions=react-server`.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  ssr: {
    resolve: {
      conditions: ['react-server', 'node', 'import', 'default'],
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests share one in-process MongoDB replica set; running files
    // in parallel would mean several mongod instances competing for ports.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
