# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/admin/package.json ./apps/admin/
COPY apps/desktop/package.json ./apps/desktop/

RUN npm ci

COPY packages/shared ./packages/shared
COPY apps/server ./apps/server
COPY apps/admin ./apps/admin

RUN npm --workspace=@sm-office/shared run build \
  && npm --workspace=@sm-office/admin run build \
  && npm --workspace=@sm-office/server run build

FROM node:22-bookworm-slim AS runner

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl sqlite3 \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=10000 \
  SQLITE_PATH=/data/office.db \
  LOCAL_STORAGE_PATH=/data/screenshots

RUN mkdir -p /app /data/screenshots \
  && chown -R 1000:1000 /app /data

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages/shared/package.json ./packages/shared/
COPY --chown=node:node apps/server/package.json ./apps/server/
COPY --chown=node:node apps/admin/package.json ./apps/admin/
COPY --chown=node:node apps/desktop/package.json ./apps/desktop/

RUN npm ci --omit=dev --workspace=@sm-office/server --workspace=@sm-office/shared --include-workspace-root \
  && npm cache clean --force

COPY --chown=node:node --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node --from=builder /app/apps/server/dist ./apps/server/dist
COPY --chown=node:node --from=builder /app/apps/admin/dist ./apps/admin/dist

USER node

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:10000/api/health || exit 1

CMD ["node", "apps/server/dist/index.js"]
