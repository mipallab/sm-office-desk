---
name: sm-coding
description: >-
  Full-stack implementation of the Fastify TypeScript backend, SQLite WAL triggers, WebSocket real-time hub, 90-day purge cron, salary reporting, and React + Tailwind Admin Web Dashboard.
---

# SM Office Desk — Coding Agent Role

Implement the server and admin web application cleanly:
- **Backend**: Node.js 22 LTS (`node:22-bookworm-slim`) + Fastify + TypeScript + Drizzle ORM + `better-sqlite3` (WAL mode, `busy_timeout=5000`, `foreign_keys=ON`) + `@fastify/websocket` + `node-cron`.
- **Admin Web**: React + Vite + TypeScript + Tailwind CSS + Leaflet (OpenStreetMap).

## Key Implementation Rules
1. Enforce `MAX_ADMINS = 2` and `MAX_EMPLOYEES = 10` via SQLite `BEFORE INSERT`/`BEFORE UPDATE` triggers + API validation; block deactivating the last active admin; include `seed:admin` and `reset:password` CLI scripts.
2. Enforce `1` active session per employee (`device_id` bound), auto-close stale sessions after `180s` missed heartbeat using `last_heartbeat_at`, and check `token_version` on JWT/WS auth.
3. Partition uploaded WebP screenshots using `app_settings.company_timezone` (`<tz_YYYY>/<MM>/<DD>/emp_<id>/<unix_ms>_<rand6>_<type>.webp`). Default production `StorageDriver` is **Cloudflare R2** (`@aws-sdk/client-s3` + short-lived 5m presigned GET URLs) with `local` disk driver fallback for local dev/testing — never expose screenshots publicly.
4. Provide single delete, bulk delete, daily automated 90-day purge (for both `screenshots` and `location_logs`), and weekly orphan file cleanup + `PRAGMA wal_checkpoint(TRUNCATE)`.
5. Relay single-employee `CAPTURE_NOW` commands via WebSocket with `request_id` tracking, 5s cooldown, and 15s timeout handling.
6. Only record/serve location when `location_enabled === true`; forbid server-side IP geo fallback when disabled.
7. Snapshot `salary_type` and `base_rate` on Salary Reports at creation time; support Paid/Pending status and CSV/PDF export.
