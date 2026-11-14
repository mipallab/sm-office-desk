# SM Office Desk — Project Constitution & Agent Tree

## Project Scope & Hard Limits
- **Purpose**: Lightweight employee work tracking, screenshot auditing, optional live location, and salary reporting platform.
- **Scale Cap**: Maximum **10 active employees** and **2 active admins**. Enforce atomically via SQLite `BEFORE INSERT`/`BEFORE UPDATE` triggers and backend API validation. Always keep at least 1 active admin (block deactivating the last active admin).
- **Budget & Server Footprint**: Optimized for a single low-budget VPS (`$4–$6/month`, 1–2 GB RAM, `node:22-bookworm-slim` + SQLite WAL + Caddy v2) + **Cloudflare R2 (10 GB Free Tier)** as primary screenshot storage (`local` disk fallback for local dev/testing). Avoid microservices, Kubernetes, or paid SaaS dependencies.

## Mandatory Functional, Security & Privacy Rules
1. **Employee Desktop App (Win 10/11, macOS, Linux; 64-bit ONLY: `x86_64` & `ARM64`)**:
   - Built with **Tauri v2 (Rust + React/TypeScript)** targeting `<15 MB` installer and `<70 MB` RAM.
   - Employee controls **Start/Stop Timer**. Closing window while active minimizes to System Tray (never silently stops or leaves ghost active sessions). Enforce **1 active session per employee** (`device_id` bound).
   - **Screenshot Lock Policy**: Once the tracker/timer is active, the employee has **NO** ability to pause, disable, delay, blur, or delete screenshots. Use monotonic timers (`std::time::Instant`) so system clock tampering cannot bypass intervals.
   - **Multi-Monitor & Lock Screen**: Stitch/scale active monitors proportionally (max `1440px` width, WebP `q=70`, target `60–110 KB`) so secondary displays aren't missed. Detect OS lock screen/sleep cleanly (`screen_locked` status) instead of crashing or storing blank frames.
   - **Random Captures**: Automatic screenshot at randomized **10 to 30 minute** intervals (`600–1800s`) while active.
   - **On-Demand Captures**: Persistent WebSocket (`wss://`) listens for Admin `CAPTURE_NOW` command for any single active employee (15s timeout feedback + 5s per-employee cooldown).
   - **Live Location Consent**: Explicit employee-controlled `Share Live Location` toggle (`ON`/`OFF`). Only collect/transmit coordinates when toggled `ON` and tracker is active; when `OFF`, transmit zero coordinates and **forbid server-side IP geolocation fallback**.
2. **Image Optimization, Security & 90-Day Lifecycle**:
   - Resize and compress screenshots **client-side before upload** (max width `1440px`, **WebP** quality `~70`).
   - **Private Serving Only**: Never expose screenshots publicly. Serve via Admin-authenticated Fastify stream or short-lived R2 presigned URLs. Check `token_version` on JWT/WS auth so deactivated users lose access immediately.
   - Store UTC timestamps in DB; organize storage & UI hierarchically by **Company Timezone (`Asia/Dhaka` default): Employee -> Date -> Time** (`<tz_YYYY>/<MM>/<DD>/emp_<id>/<unix_ms>_<rand6>_<type>.webp`).
   - Admins can **manually delete** (single) and **bulk delete** screenshots.
   - Daily automated purge job deletes expired DB rows and storage files older than **90 days** for **both** `screenshots` and `location_logs`, plus weekly orphan file cleanup and SQLite WAL checkpointing.
3. **Admin Dashboard & Salary Reports**:
   - Only active admins (max 2) can register/deactivate employees, trigger live screenshots, view random/on-demand screenshots, view consented live location (with accuracy radius & `OS Native` vs `IP Approx` badge on free **OpenStreetMap + Leaflet**), delete screenshots, and create/view/export **Salary Reports** (snapshotting salary rate & worked hours at report creation).
   - Include CLI scripts for first-admin bootstrap (`seed:admin`) and safe admin password reset (`reset:password`).

## Hierarchical Agent Tree
When executing tasks in this workspace, delegate strictly through this tree structure:

```text
team-leader (Root Orchestrator)
├── software-architect      # System design, DB triggers/schema, API/WS contracts, storage math, security
├── ui-ux-agent             # Admin Web Dashboard & Desktop App UI/UX, Tailwind tokens, wireframes
├── coding-agent            # Node.js/Fastify/TS Backend + SQLite WAL + React/Vite Admin Dashboard
├── desktop-app-agent       # Tauri v2 Desktop Tracker (Win 10/11, macOS, Linux)
│   └── arch-build-agent    # x86_64 & ARM64 builds, Win10 WebView2, macOS signing/TCC, Linux Wayland/X11
└── server-management-agent # Low-budget VPS, Caddy SSL, Local SSD/R2, 90-day purge, SQLite .backup
```

### Role Skills
Use the matching workspace skill under `.agents/skills/` or invoke the matching subagent (`team-leader`, `software-architect`, `ui-ux-agent`, `coding-agent`, `desktop-app-agent`, `arch-build-agent`, `server-management-agent`):
- `sm-team-leader`
- `sm-software-architect`
- `sm-ui-ux`
- `sm-coding`
- `sm-desktop-app`
- `sm-arch-build`
- `sm-server-management`
