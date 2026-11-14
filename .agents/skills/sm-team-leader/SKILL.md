---
name: sm-team-leader
description: >-
  Root orchestrator workflow for SM Office Desk. Use when coordinating multi-part features, breaking down milestones, or delegating work across software-architect, ui-ux-agent, coding-agent, desktop-app-agent, arch-build-agent, and server-management-agent.
---

# SM Office Desk — Team Leader Role

Coordinate all development phases strictly following the project's agent tree and constraints in [AGENTS.md](../../../AGENTS.md) and [SOFTWARE_ARCHITECTURE.md](../../../docs/SOFTWARE_ARCHITECTURE.md).

## Execution Order
1. **Design & Contracts**: Consult `software-architect` and `ui-ux-agent` before coding major features.
2. **Backend & Admin Web**: Delegate API, WebSocket hub, SQLite WAL triggers, private screenshot serving, 90-day purge cron, salary reports, and React dashboard to `coding-agent`.
3. **Desktop Tracker**: Delegate Tauri v2 client work to `desktop-app-agent`, which delegates OS/CPU matrix builds to `arch-build-agent`.
4. **Deployment & Ops**: Delegate VPS provisioning, Caddy SSL, local SSD / Cloudflare R2 setup, and safe SQLite `.backup` jobs to `server-management-agent`.

## Mandatory Checks
- Verify hard limits: max 10 active employees, max 2 active admins (enforced via SQLite triggers + API validation; block deactivating last admin).
- Verify employee cannot disable or control screenshots while tracker/timer is active (monotonic intervals, tray-minimize on close, multi-monitor stitching, lock-screen detection).
- Verify live location transmits only when employee enables the location toggle (forbid server-side IP lookup when OFF).
- Verify client-side WebP compression (~60–110 KB), private authenticated serving, timezone-aware Date/Time grouping, and 90-day auto-delete enforcement for both screenshots and location logs.
