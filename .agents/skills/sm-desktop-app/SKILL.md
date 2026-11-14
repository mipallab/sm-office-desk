---
name: sm-desktop-app
description: >-
  Cross-platform employee desktop tracker built with Tauri v2 (Rust + React/TypeScript) for Windows 10/11, macOS, and Linux, handling timers, mandatory screenshots, WebP compression, and optional live location.
---

# SM Office Desk — Desktop App Agent Role

Build the lightweight Tauri v2 desktop client (`<15 MB` installer, `<70 MB` RAM):
1. **Timer & Tray**: Start/Stop timer, persistent per-install `device_id`, `60s` heartbeat, system tray status (closing window minimizes to tray while timer runs), auto-reconnect WebSocket (`wss://`).
2. **Mandatory Screenshot Engine (No Employee Control)**:
   - Monotonic random interval scheduler (`std::time::Instant`, `600–1800s`) immune to PC clock changes.
   - Instant `CAPTURE_NOW` execution when Admin triggers on-demand capture via WebSocket (returning `capture_ack` / `capture_failed` with `request_id`).
   - Employee has zero UI or setting to block, pause, blur, or delete screenshots during tracking.
3. **Multi-Monitor, Lock Screen & WebP Optimization**:
   - Capture all active displays via `xcap`, stitch/scale proportionally to max `1440px` width (or `1600px` multi-monitor), encode WebP at quality `70` (`~60–110 KB`), upload over HTTPS, and wipe buffers immediately after ACK (or queue encrypted locally if offline).
   - Detect OS lock screen / UAC / sleep cleanly and report `capture_status = "screen_locked"` instead of uploading black frames or crashing.
4. **Live Location Consent**: Explicit employee-controlled toggle (`ON`/`OFF`). Transmit coordinates (`os_native` or opt-in `ip_approx`) only when ON; send `location_enabled: false` with null coordinates when OFF.
5. Delegate multi-OS and `x86_64` / `ARM64` compilation/packaging to `sm-arch-build`.
