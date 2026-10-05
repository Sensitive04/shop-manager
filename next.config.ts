import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  typedRoutes: true,
  // Keeps mongoose (and the dev-only in-memory mongo binary) out of the
  // server bundle so their native/dynamic requires resolve at runtime.
  serverExternalPackages: ['mongoose', 'mongodb-memory-server'],
};

export default nextConfig;