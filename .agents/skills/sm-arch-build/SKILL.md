---
name: sm-arch-build
description: >-
  Cross-architecture build, packaging, OS permissions, and GitHub Actions CI/CD pipelines for 64-bit x86_64 and ARM64 across Windows 10/11, macOS, and Linux.
---

# SM Office Desk — Architecture & Build Agent Role

Compile and package the Tauri v2 desktop tracker across every 64-bit target matrix (no 32-bit `i686` builds needed):
- **Windows 10 / 11**: `x86_64-pc-windows-msvc` (`.msi`, `.exe` NSIS) and `aarch64-pc-windows-msvc` (Windows ARM64). Embed/bundle the **WebView2 bootstrapper** for older Windows 10 installs.
- **macOS**: `aarch64-apple-darwin` (Apple Silicon M1–M4) & `x86_64-apple-darwin` (Intel) Universal `.dmg` / `.app`, with `Info.plist` Screen Recording & `NSLocationWhenInUseUsageDescription` declarations. Document Developer ID signing/notarization (`$99/yr`) vs unsigned Gatekeeper (`xattr -cr`) and TCC permission reset caveats.
- **Linux**: `x86_64-unknown-linux-gnu` & `aarch64-unknown-linux-gnu` (`.deb`, `.AppImage`) built against **Ubuntu 22.04 `glibc` baseline**, supporting X11 and Wayland (`xdg-desktop-portal` + PipeWire `persist_mode=2` restore token) + `GeoClue2`.

Deliver reproducible GitHub Actions workflow matrices and SHA256 release verification.
