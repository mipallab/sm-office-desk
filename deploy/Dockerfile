# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: Full Workspace Dependencies (for TypeScript / Vite builds)
# ==============================================================================
FROM node:22-bookworm-slim AS deps

WORKDIR /app

# Build tools in builder/deps only in case better-sqlite3 prebuilt binary needs source fallback
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/admin/package.json ./apps/admin/
COPY apps/desktop/package.json ./apps/desktop/

RUN npm ci

# ==============================================================================
# Stage 2: Build Shared, Server (incl. 0001_init.sql), and Admin Static SPA
# ==============================================================================
FROM deps AS builder

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
COPY apps/admin ./apps/admin

RUN npm --workspace=@sm-office/shared run build \
  && npm --workspace=@sm-office/server run build \
  && npm --workspace=@sm-office/admin run build

# ==============================================================================
# Stage 3: Pruned Production Dependencies for Server + Shared Only
# ==============================================================================
FROM node:22-bookworm-slim AS prod-deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/admin/package.json ./apps/admin/
COPY apps/desktop/package.json ./apps/desktop/

RUN npm ci --omit=dev --workspace=@sm-office/server --workspace=@sm-office/shared --include-workspace-root \
  && npm cache clean --force

# ==============================================================================
# Stage 4: Production Fastify API & SQLite WAL Runtime (Non-Root node UID 1000)
# ==============================================================================
FROM node:22-bookworm-slim AS api

WORKDIR /app

# Runtime essentials only:
# - ca-certificates: TLS validation for Cloudflare R2 HTTPS requests
# - sqlite3: Online WAL backup & integrity_check execution via docker compose exec
# - curl: Container /api/health probe
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl sqlite3 \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3000 \
  SQLITE_PATH=/data/office.db \
  LOCAL_STORAGE_PATH=/data/screenshots

# Pre-create directories owned by node (UID/GID 1000) before COPY --chown so
# OverlayFS does not duplicate the ~69 MB node_modules layer with a post-COPY chown.
RUN mkdir -p /app /data/screenshots \
  && chown -R 1000:1000 /app /data

COPY --chown=node:node package.json ./
COPY --chown=node:node packages/shared/package.json ./packages/shared/
COPY --chown=node:node --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node apps/server/package.json ./apps/server/
COPY --chown=node:node --from=builder /app/apps/server/dist ./apps/server/dist
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "apps/server/dist/index.js"]

# ==============================================================================
# Stage 5: Caddy v2 Reverse Proxy & Static Admin SPA Server
# ==============================================================================
FROM caddy:2-alpine AS caddy

COPY --from=builder /app/apps/admin/dist /srv/admin
COPY deploy/Caddyfile /etc/caddy/Caddyfile

EXPOSE 80 443 443/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:2019/config/ >/dev/null 2>&1 || exit 1
