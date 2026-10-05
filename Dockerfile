# syntax=docker/dockerfile:1

# ----------------------------------------------------------------- deps stage
# Installed separately so a source-only change does not re-run npm ci.
FROM node:24-alpine AS deps
WORKDIR /app

# Only the manifests are copied first, so this layer is cached until a
# dependency actually changes.
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------- build stage
FROM node:24-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# next build statically analyses the routes. The API handlers touch the database
# at request time only, so a placeholder URI is enough to compile.
ENV NEXT_TELEMETRY_DISABLED=1
ENV MONGODB_URI=mongodb://build:27017/build

# output: 'standalone' (see next.config.ts) emits a self-contained server with
# only the modules actually imported, which keeps the runtime image small.
RUN npm run build

# --------------------------------------------------------------- runtime stage
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# The standalone output already includes the pruned node_modules it needs.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

# ----------------------------------------------------------------- seed stage
# Target for `docker compose run --rm seed`.
#
# It needs the full source tree and the *dev* dependencies (tsx), because the
# seed script imports the service layer directly rather than going through the
# standalone server bundle. Reuses the build stage's node_modules rather than
# installing again.
FROM node:24-alpine AS seed
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
# The seeder wipes and rebuilds the collections, so it must never be mistaken for
# a production process.
ENV NODE_ENV=development

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/lib ./lib
COPY --from=build /app/models ./models
COPY --from=build /app/types ./types
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json

CMD ["npx", "tsx", "--conditions=react-server", "scripts/seed.ts"]