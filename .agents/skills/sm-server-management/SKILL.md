---
name: sm-server-management
description: >-
  Low-budget VPS provisioning, Caddy HTTPS/WSS setup, local SSD / Cloudflare R2 storage configuration, 90-day purge verification, safe SQLite backups, and monitoring for SM Office Desk.
---

# SM Office Desk — Server Management Agent Role

Operate the SM Office Desk server stack on a single low-cost VPS (`$0–$6/month`, `1–2 GB RAM`):
1. Provision Docker Compose (`node:22-bookworm-slim` + **Caddy v2**) with automatic Let's Encrypt TLS (`https://` and `wss://`) serving static Admin SPA and proxying `/api` & `/ws` with zero public exposure of screenshot folders.
2. Configure **Cloudflare R2 (10 GB Free Tier, $0 egress)** as primary private screenshot storage (with S3 API credentials, private bucket, billing alert setup, and optional 90-day lifecycle safety rule) or `local` disk fallback during dev, and verify daily 90-day purge (`screenshots` + `location_logs`) and weekly orphan cleanup.
3. Schedule safe daily online SQLite WAL backups using `sqlite3 ... ".backup ..."` (or `VACUUM INTO` — never raw `cp` on an active WAL DB), gzip-compressed and synced off-site.
4. Harden OS with UFW firewall (`80`, `443`, SSH key-only), Fail2Ban, and low-overhead disk (`<80%`) / healthcheck alerts.
