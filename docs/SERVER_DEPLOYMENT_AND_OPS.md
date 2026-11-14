# SM Office Desk — Low-Budget VPS Deployment & Operations Guide

This guide covers end-to-end production provisioning, HTTPS/WSS termination, **Cloudflare R2 (10 GB Free Tier)** private screenshot storage, safe online SQLite WAL backups/restores, health monitoring, upgrades, and desktop tracker connection setup for **SM Office Desk** (`<= 10` active employees, `<= 2` active admins).

---

## 1. Low-Budget Server Options (`$0–$6/month`, 1–2 GB RAM)

The entire production stack (`caddy:2-alpine` + `node:22-bookworm-slim` + SQLite WAL) uses **~150–250 MB RAM** at idle/normal load and fits comfortably on any 64-bit Linux VPS (`x86_64` or `ARM64`):

| Provider / Tier | Specs | Approx. Monthly Cost | Notes |
| :--- | :--- | :--- | :--- |
| **Oracle Cloud Always Free (ARM64)** | Up to 4 ARM OCPUs, 24 GB RAM | **`$0/month`** | Supported natively (`linux/arm64`); verify home-region capacity. |
| **Hetzner Cloud (`CX22` / `CAX11`)** | 2 vCPU, 4 GB RAM, 40 GB NVMe | **`~€3.79–€4.50/mo`** | Best reliability & NVMe speed at low cost (`x86_64` or `ARM64`). |
| **DigitalOcean / Vultr / Linode** | 1 vCPU, 1–2 GB RAM, 25–50 GB SSD | **`$4–$6/month`** | Enable 1–2 GB swap via `vps-harden.sh` on 1 GB RAM plans. |

> **CPU Architecture Note**: Both `node:22-bookworm-slim` and `caddy:2-alpine` ship multi-arch images for `linux/amd64` (`x86_64`) and `linux/arm64` (`aarch64`).

---

## 2. Cloudflare R2 Setup (10 GB Free Tier, `$0` Egress)

Using Cloudflare R2 keeps screenshot storage (`~2–4 GB` steady state for 10 employees across 90 days) completely off the VPS SSD at **`$0/month`**.

### 2.1 Primary Screenshot Bucket (`R2_BUCKET_NAME`)
1. Log into the Cloudflare Dashboard -> **R2 Object Storage** -> **Create bucket**.
2. Name it e.g. `sm-office-desk-screenshots` (must match `R2_BUCKET_NAME` in `deploy/.env.production`).
3. **Keep the bucket strictly private**:
   - Do **NOT** enable the public `r2.dev` subdomain.
   - Do **NOT** attach a public custom domain.
   - Screenshots are only served to authenticated Admins via short-lived (`300s`) presigned GET URLs (`R2_PRESIGNED_URL_TTL_SECONDS=300`).
4. **Create Scoped R2 API Token**:
   - Go to **R2 -> Manage R2 API Tokens -> Create API Token**.
   - Permissions: **Object Read & Write**.
   - Scope: **Apply to specific buckets only** -> select `sm-office-desk-screenshots`.
   - Record your **Account ID** (`R2_ACCOUNT_ID`), **Access Key ID** (`R2_ACCESS_KEY_ID`), and **Secret Access Key** (`R2_SECRET_ACCESS_KEY`).
5. **Optional 90-Day R2 Lifecycle Safety Rule**:
   - Under bucket **Settings -> Object lifecycle rules**, add a rule expiring objects after `90` days (in addition to the server's built-in daily `02:00 UTC` purge cron).
6. **Billing Alert**:
   - Under **Manage Account -> Billing -> Notifications**, configure an alert so you are notified before exceeding the R2 Free Tier (`10 GB` storage, `1M` Class A ops/mo, `10M` Class B ops/mo, `$0` egress).

### 2.2 CRITICAL: Separate Bucket for SQLite Backups (`BACKUP_R2_BUCKET_NAME`)
- Never upload SQLite backups into `R2_BUCKET_NAME`!
- The server's weekly `cleanupOrphanFiles` job ([`apps/server/src/jobs/maintenance.ts`](../apps/server/src/jobs/maintenance.ts)) runs every **Sunday at `03:00 UTC`** and deletes any object older than `24 hours` in `R2_BUCKET_NAME` whose key is absent from the `screenshots.storage_key` table.
- If you want off-site R2 backups of your SQLite `.db.gz` files, create a **second private bucket** (e.g., `sm-office-desk-db-backups`) with its own token and configure `BACKUP_R2_BUCKET_NAME`. `deploy/scripts/backup-sqlite.sh` explicitly aborts if `BACKUP_R2_BUCKET_NAME == R2_BUCKET_NAME`.

### 2.3 Local SSD Fallback (`STORAGE_DRIVER=local`)
For single-VPS SSD storage or local testing without Cloudflare R2, set `STORAGE_DRIVER=local` in `deploy/.env.production`. Screenshots are written inside the persistent Docker volume `sm_office_data:/data/screenshots` and streamed only through Admin-authenticated `/api/admin/screenshots/:id/image` responses (never exposed by Caddy).

---

## 3. VPS Provisioning, DNS & Firewall Hardening

1. Point an `A` (and optional `AAAA`) DNS record for your domain (e.g., `desk.example.com`) to your VPS public IP.
   - If using Cloudflare DNS, keep the record **DNS-only** (grey cloud) during initial certificate issuance or ensure Full (Strict) TLS once Caddy holds its Let's Encrypt certificate.
2. SSH into your fresh Debian 12 or Ubuntu 22.04/24.04 VPS and clone the repository:
   ```bash
   git clone <your-repo-url> /opt/sm-office-desk
   cd /opt/sm-office-desk
   ```
3. Preview and apply OS hardening (`swapfile`, `vm.swappiness=10`, UFW `22/80/443`, Fail2Ban `sshd`, unattended security upgrades, and Docker Engine + Compose v2):
   ```bash
   bash deploy/scripts/vps-harden.sh --dry-run
   sudo bash deploy/scripts/vps-harden.sh --swap-size 2G --install-docker
   ```
4. Verify SSH key login works from a second terminal, then disable SSH password authentication:
   ```bash
   sudo bash deploy/scripts/vps-harden.sh --disable-ssh-password-auth
   ```
   > Port `3000` is never published on the host or allowed through UFW; all external HTTP/HTTPS/WSS traffic enters solely via Caddy on ports `80` and `443`.

---

## 4. Environment Configuration & Docker Deployment

1. Create `deploy/.env.production` from the template and restrict permissions:
   ```bash
   cp deploy/.env.production.example deploy/.env.production
   chmod 600 deploy/.env.production
   ```
2. Generate a strong production `JWT_SECRET` (`>= 32` characters; must NOT start with `replace-with` or `dev-only`):
   ```bash
   openssl rand -hex 32
   ```
3. Edit `deploy/.env.production` and verify:
   - `SITE_ADDRESS=desk.example.com`
   - `CORS_ORIGIN=https://desk.example.com`
   - `JWT_SECRET=<output from openssl rand -hex 32>`
   - `STORAGE_DRIVER=r2` + `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (or `STORAGE_DRIVER=local`)
   - Optional `BACKUP_R2_BUCKET_NAME` (must differ from `R2_BUCKET_NAME`), `BACKUP_R2_ENDPOINT`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`, `ALERT_WEBHOOK_URL`
4. Validate Compose config and build/start the stack:
   ```bash
   docker compose --env-file deploy/.env.production -f deploy/docker-compose.yml config >/dev/null
   docker compose --env-file deploy/.env.production -f deploy/docker-compose.yml up -d --build
   ```
   > **Security Isolation**: `deploy/docker-compose.yml` passes `deploy/.env.production` **only** to `api` (`512m` memory cap, non-root `node` UID `1000`). The `caddy` container (`128m` memory cap) receives only `SITE_ADDRESS` and has no access to `JWT_SECRET`, R2 credentials, or `sm_office_data:/data`.
5. Verify both containers and the health endpoint:
   ```bash
   docker compose --env-file deploy/.env.production -f deploy/docker-compose.yml ps
   curl -fsS https://desk.example.com/api/health
   ```

---

## 5. First Admin Bootstrap & Password Recovery CLI

The production `api` container compiles TypeScript to `/app/apps/server/dist` and omits `tsx` / `devDependencies`, so run the compiled JS scripts directly with `node`:

### Seed First Administrator (only runs when `0` admins exist)
Interactive (recommended so password stays out of shell history):
```bash
docker compose --env-file deploy/.env.production -f deploy/docker-compose.yml exec api \
  node apps/server/dist/cli/seed-admin.js
```
Non-interactive:
```bash
docker compose --env-file deploy/.env.production -f deploy/docker-compose.yml exec api \
  node apps/server/dist/cli/seed-admin.js --name "Company Admin" --email "admin@company.com" --password "StrongPassword123!"
```

### Reset Admin or Employee Password (revokes active JWT & WebSocket sessions immediately)
```bash
docker compose --env-file deploy/.env.production -f deploy/docker-compose.yml exec api \
  node apps/server/dist/cli/reset-password.js --email "admin@company.com"
```
(In local monorepo development outside Docker, use `npm run seed:admin` and `npm run reset:password -- --email=admin@company.com`.)

---

## 6. Automated Maintenance, Staggered Backups & Monitoring Cron

### Built-in Backend Maintenance (`apps/server/src/jobs/maintenance.ts`)
- **Every `30s`**: Sweeps stale active sessions silent for `> 180s` and closes them at `last_heartbeat_at`.
- **Daily at `02:00 UTC`**: Purges expired `screenshots` (storage object first, then DB row) and `location_logs` older than `90 days` in batches of `500`, then runs `PRAGMA wal_checkpoint(TRUNCATE)`.
- **Weekly on Sunday at `03:00 UTC`**: Runs `cleanupOrphanFiles` to delete objects `> 24h` old in `R2_BUCKET_NAME` (or `LOCAL_STORAGE_PATH`) not referenced in `screenshots.storage_key`.

### Host Cron Schedule (Staggered After `02:00 UTC` Purge)
Install root cron jobs so SQLite WAL backups run at **`02:30 UTC`** (after the `02:00 UTC` daily purge + WAL truncate, and before the `03:00 UTC` Sunday orphan cleanup):

```bash
sudo crontab -e
```
Add:
```cron
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Daily online SQLite WAL backup at 02:30 UTC (staggered after 02:00 UTC purge/checkpoint)
30 2 * * * /opt/sm-office-desk/deploy/scripts/backup-sqlite.sh >> /var/log/sm-office-backup.log 2>&1

# Health, disk (<80%), and WAL size check every 5 minutes
*/5 * * * * /opt/sm-office-desk/deploy/scripts/monitor-health.sh >> /var/log/sm-office-monitor.log 2>&1
```

Test monitoring & webhook alerts immediately:
```bash
bash deploy/scripts/monitor-health.sh --dry-run
bash deploy/scripts/monitor-health.sh
# Optional if ALERT_WEBHOOK_URL is configured:
bash deploy/scripts/monitor-health.sh --test-alert
```

---

## 7. Safe SQLite WAL Backup & Restore Drill

> **Never copy an active SQLite WAL database with `cp`!** Copying `office.db` without `office.db-wal` or while writes are occurring produces a corrupt backup. `backup-sqlite.sh` uses `sqlite3 ... ".backup ..."` inside the running container and verifies `PRAGMA integrity_check;`.

### Manual Backup Check
```bash
bash deploy/scripts/backup-sqlite.sh --dry-run
sudo bash deploy/scripts/backup-sqlite.sh
ls -lh /var/backups/sm-office-desk/
```

### Restore Drill (Non-Destructive Dry Run, Then Live Restore)
1. Validate checksum, gzip stream, SQLite `PRAGMA integrity_check;`, and schema tables without affecting the live server:
   ```bash
   bash deploy/scripts/restore-sqlite.sh --dry-run --file /var/backups/sm-office-desk/office_YYYYMMDDTHHMMSSZ.db.gz
   ```
2. Perform a live restore (snapshots existing DB/WAL/SHM first, stops `api`, replaces `/data/office.db` cleanly, removes stale `-wal`/`-shm`, sets `1000:1000` ownership, starts `api`, and polls `/api/health`):
   ```bash
   sudo bash deploy/scripts/restore-sqlite.sh --file /var/backups/sm-office-desk/office_YYYYMMDDTHHMMSSZ.db.gz
   ```

---

## 8. Upgrade Flow

1. Create a fresh pre-upgrade backup:
   ```bash
   cd /opt/sm-office-desk
   sudo bash deploy/scripts/backup-sqlite.sh
   ```
2. Pull the latest release and rebuild/recreate containers:
   ```bash
   git pull --ff-only
   docker compose --env-file deploy/.env.production -f deploy/docker-compose.yml build
   docker compose --env-file deploy/.env.production -f deploy/docker-compose.yml up -d
   ```
3. Verify container health and prune old dangling images to preserve VPS SSD space:
   ```bash
   bash deploy/scripts/monitor-health.sh
   docker image prune -f
   ```

---

## 9. Connecting the Employee Desktop App (`SM_OFFICE_DEFAULT_SERVER_URL`)

- **Standard Connection**: Employees enter `https://desk.example.com` (matching `SITE_ADDRESS`) in the Tauri desktop tracker login screen. `normalize_server_url` / `to_ws_url` ([`apps/desktop/src-tauri/src/network.rs`](../apps/desktop/src-tauri/src/network.rs)) automatically derives:
  - REST API: `https://desk.example.com/api/...`
  - WebSocket: `wss://desk.example.com/ws`
- **Pre-Configured Organization Builds**: You can bake a default server URL at compile time by setting `SM_OFFICE_DEFAULT_SERVER_URL=https://desk.example.com` when building `apps/desktop` (read via `option_env!("SM_OFFICE_DEFAULT_SERVER_URL")` in [`apps/desktop/src-tauri/src/state.rs`](../apps/desktop/src-tauri/src/state.rs)).
