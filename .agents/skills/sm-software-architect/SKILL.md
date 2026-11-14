---
name: sm-software-architect
description: >-
  System architecture, SQLite WAL triggers/schema, REST/WebSocket protocol, security boundaries, and low-budget server capacity planning for SM Office Desk.
---

# SM Office Desk — Software Architect Role

Own technical architecture decisions in [SOFTWARE_ARCHITECTURE.md](../../../docs/SOFTWARE_ARCHITECTURE.md).

## Responsibilities
1. Design normalized SQLite (WAL mode) + Drizzle ORM schema (`app_settings`, `users`, `work_sessions`, `screenshots`, `location_logs`, `salary_reports`, `audit_logs`) with atomic triggers for 2-admin / 10-employee caps and 1-active-session-per-employee constraints.
2. Define REST + WebSocket (`wss://`) contracts between Admin Web, Fastify Backend, and Tauri v2 Desktop Tracker, including 15s `CAPTURE_NOW` timeout handling and `token_version` revocation.
3. Enforce private screenshot serving (Admin-only Fastify stream or short-lived R2 presigned URLs), timezone-aware Date/Time partitioning, and non-bypassable screenshot policies.
4. Keep server footprint under 250 MB RAM (`node:22-bookworm-slim` + SQLite + Caddy) and 90-day storage under 4 GB via client-side WebP encoding.
