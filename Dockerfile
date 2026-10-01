# syntax=docker/dockerfile:1

# ─── Build ────────────────────────────────────────────────────────────────────
# Node 22 is the floor: the project uses `node:sqlite` directly rather than through a
# native module, and it is still flagged experimental there.
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Manifests first so dependency installation is cached independently of source changes.
# The workspace packages are the source of truth — they have no build step of their own.
COPY package.json package-lock.json* ./
COPY apps/web/package.json            apps/web/
COPY packages/core/package.json       packages/core/
COPY packages/db/package.json         packages/db/
COPY packages/llm/package.json        packages/llm/
COPY packages/asr/package.json        packages/asr/
COPY packages/memory/package.json     packages/memory/
COPY packages/channels/package.json   packages/channels/
COPY packages/gatekeeper/package.json packages/gatekeeper/
COPY packages/orchestration/package.json packages/orchestration/
COPY packages/observability/package.json packages/observability/

# esbuild arrives through Vite, but it is declared here explicitly: the build depends
# on it directly, and relying on a transitive dependency of a dev tool is how a build
# breaks silently on the next Vite upgrade.
RUN npm ci --include=dev --no-audit --no-fund

COPY . .

# Typecheck first, so a type error fails the image build rather than the first request.
# `noEmit` is set in tsconfig.json — the server is bundled, never emitted per-file.
RUN npm run typecheck

# Bundle each service to a single ESM file. The workspace packages expose raw `.ts`
# entry points (`exports: { ".": "./src/index.ts" }`), so there is nothing for Node to
# resolve after a `tsc` emit; bundling is what makes the output runnable.
RUN npm run build

# A production-only dependency tree for the runtime stage.
RUN npm prune --omit=dev


# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# `tini` reaps zombies and, more importantly here, forwards SIGTERM to PID 1. Without
# an init, Node runs as PID 1, does not receive the signal, and every deploy falls back
# to a hard kill that truncates in-flight requests.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    API_PORT=3000 \
    DATABASE_PATH=/data/execugate.db \
    SERVE_WEB=true \
    WEB_DIST_DIR=/app/dist/web

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist         ./dist

# The database lives on a volume, never in an image layer.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000

# Readiness, not liveness: `/ready` reports 503 until migrations are applied and the
# dependencies the request path needs answer. `/health` would report ok even while the
# process could not serve traffic, which is the wrong signal for a load balancer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/api.js"]
