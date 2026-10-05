import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  typedRoutes: true,
  // Keeps mongoose (and the dev-only in-memory mongo binary) out of the
  // server bundle so their native/dynamic requires resolve at runtime.
  // mongoose is a runtime dependency, but it must not be inlined: the MongoDB
  // driver requires native add-ons conditionally, so a bundled copy fails at
  // runtime. Next.js emits a bare require() instead and the host resolves it
  // from node_modules.
  //
  // mongodb-memory-server is deliberately NOT listed here. It is dev-only and
  // absent from a production install, so asking the bundler to externalise a
  // package that may not exist turns a missing optional dev tool into a failed
  // build. lib/db.ts loads it through a computed specifier that no bundler can
  // statically analyse, which is what actually keeps it out of the graph.
  serverExternalPackages: ['mongoose'],
};

export default nextConfig;