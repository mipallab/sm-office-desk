# SM Office Desk — Desktop Build Matrix & OS Permissions Guide

This document describes the **64-bit-only** Tauri v2 packaging configuration, OS permission declarations, runtime caveats, CI/CD release pipeline, and local developer build steps for **SM Office Desk** (`apps/desktop`).

---

## 1. 64-Bit-Only Target Matrix (`x86_64` & `ARM64`)

SM Office Desk targets **strictly 64-bit desktop architectures**. Zero 32-bit (`i686`, `armv7`) targets are built or supported.

| OS | CPU Architecture | Rust Target Triple | CI Runner | Installers / Bundles |
| :--- | :--- | :--- | :--- | :--- |
| **Windows 10 / 11** | `x86_64` | `x86_64-pc-windows-msvc` | `windows-latest` | `.exe` (`-setup.exe` NSIS + `-portable.exe` standalone) + `.msi` (WiX) |
| **Windows 11 ARM64** | `ARM64` | `aarch64-pc-windows-msvc` | `windows-11-arm` | `.exe` (`-setup.exe` NSIS + `-portable.exe` standalone) + `.msi` (WiX) |
| **macOS 12+** | Universal (`ARM64` + `x86_64`) | `universal-apple-darwin` (`aarch64-apple-darwin` + `x86_64-apple-darwin`) | `macos-14` | Universal `.dmg` + `.app.tar.gz` |
| **Linux (Ubuntu 24.04+ / Debian 13+ / Fedora 40–45+)** | `x86_64` | `x86_64-unknown-linux-gnu` | `ubuntu-24.04` (`glibc 2.39`) | `.deb` + `.rpm` + `.AppImage` |
| **Linux (Ubuntu 24.04+ / Fedora 40+ ARM64)** | `ARM64` | `aarch64-unknown-linux-gnu` | `ubuntu-24.04-arm` (`glibc 2.39`) | `.deb` + `.rpm` + `.AppImage` |

### Resource & Packaging Budgets
- **Installer size target**: `< 15 MB` (achieved by Tauri v2 native system WebViews, LZMA NSIS compression, `appimage.bundleMediaFramework: false`, and `downloadBootstrapper` for WebView2).
- **Runtime RAM target**: `< 70 MB` idle/active footprint.

---

## 2. Windows 10 / 11 Packaging & OS Permissions

### 2.1 WebView2 Evergreen Bootstrapper (Windows 10 Compatibility) & Portable Executable
In `apps/desktop/src-tauri/tauri.conf.json` (`bundle.windows`):
- `webviewInstallMode`: `{ "type": "downloadBootstrapper", "silent": true }`
  - Windows 11 ships Microsoft Edge WebView2 out of the box.
  - Older Windows 10 machines that lack WebView2 automatically download and silently execute Microsoft's Evergreen WebView2 Bootstrapper during installation without bloating the `-setup.exe` / `.msi` installer.
- **NSIS (`-setup.exe`)**:
  - `installMode: "currentUser"` installs under `%LOCALAPPDATA%` without requiring local Administrator UAC elevation for employees.
  - `displayLanguageSelector: false`, `compression: "lzma"`.
  - Runs the WebView2 `downloadBootstrapper` automatically if WebView2 is absent.
- **Standalone Portable Binary (`-portable.exe`)**:
  - Staged directly from the compiled Cargo release binary (`apps/desktop/src-tauri/target/<rust_target>/release/sm-office-desktop.exe` -> `SM-Office-Desk_<version>_windows_<arch>-portable.exe`).
  - Zero-install standalone executable for Windows 11 and updated Windows 10 machines that **already have Microsoft Edge WebView2 Runtime pre-installed**.
  - **Clean Windows 10 Caveat**: `-portable.exe` does **not** run the NSIS/WiX WebView2 bootstrapper. Older clean Windows 10 machines without WebView2 Runtime installed should use `-setup.exe` or `.msi`.
- **WiX (`.msi`)**:
  - `language: "en-US"`, pinned deterministic `upgradeCode` (`8cce718a-39d9-5f9a-b3b4-4d9b094e380b`) so MSI upgrades replace previous versions cleanly, and includes the `downloadBootstrapper` WebView2 mode.
  - **Local Windows `.msi` Build Caveat**: WiX v3 requires the Windows **VBSCRIPT** optional feature (`Settings -> Apps -> Optional features -> More Windows features -> VBSCRIPT`) when generating `.msi` installers locally.

### 2.2 Screen Capture & Lock-Screen Detection
- **Capture**: `xcap` (`0.9`) uses **DXGI Desktop Duplication** with GDI fallback across all active monitors (`capture.rs`), stitching displays proportionally (`<= 1440px` single monitor / `<= 1600px` multi-monitor) and encoding WebP client-side.
- **Lock-Screen / Secure Desktop Detection**: `lock.rs` calls `user32!OpenInputDesktop(0, 0, DESKTOP_READOBJECTS)` + `CloseDesktop`. When the workstation is locked (`Win+L`), sleeping, or displaying a UAC secure desktop, `OpenInputDesktop` returns `NULL` or DXGI returns `DXGI_ERROR_ACCESS_LOST` / `0x80070005`, causing the tracker to record `capture_status = "screen_locked"` cleanly rather than crashing or uploading blank frames.

### 2.3 Windows Live Location Consent (`Geolocator`)
- When the employee toggles **Share Live Location** `ON` while the timer is active, `location.rs` queries WinRT `Windows.Devices.Geolocation.Geolocator` (`RequestAccessAsync` + `GetGeopositionAsync`).
- If Windows Location access is blocked, the app offers `[Open Settings]` (`ms-settings:privacy-location` -> **Settings > Privacy & security > Location > Let desktop apps access your location**) and waits for explicit employee opt-in (`NeedsIpOptIn`) before using IP-approximate coordinates (`source: "ip_approx"`).
- When `Share Live Location` is `OFF`, zero OS or network location lookups occur.

---

## 3. macOS Packaging, Signing, `Info.plist` & TCC Permissions

### 3.1 `apps/desktop/src-tauri/Info.plist` & Bundle Settings
Tauri v2 automatically merges `apps/desktop/src-tauri/Info.plist` into `SM Office Desk.app/Contents/Info.plist`:
- `NSScreenCaptureUsageDescription`: Explains mandatory periodic (10–30 min) and admin-requested work-session screenshot auditing while the work timer is active.
- `NSLocationWhenInUseUsageDescription`: Explains optional live location sharing only while the timer is active and the employee toggles `Share Live Location` `ON`.
- `LSMinimumSystemVersion`: `12.0` (matches `bundle.macOS.minimumSystemVersion: "12.0"` in `tauri.conf.json`, supporting Universal `arm64` + `x86_64`).
- `LSUIElement`: `false` (displays standard `360x480` app window alongside the System Tray icon).
- `NSHighResolutionCapable`: `true` (Retina display support).
- `hardenedRuntime`: `true` (required for Apple notarization).

### 3.2 Screen Recording & Lock Detection (`CoreGraphics` / `ioreg`)
- `lock.rs` checks `CGPreflightScreenCaptureAccess()` before capture and invokes `CGRequestScreenCaptureAccess()` plus `open x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture` when permission is missing.
- Screen lock state is checked via `/usr/sbin/ioreg -n Root -d1` (`"CGSSessionScreenIsLocked" = Yes`).

### 3.3 Signed + Notarized (`$99/yr`) vs. Unsigned Builds
- **With Apple Developer ID (`$99/yr`)**:
  Configure repository secrets in GitHub Actions to sign and notarize Universal `.app` / `.dmg` bundles automatically:
  - `APPLE_CERTIFICATE` (single-line base64 `.p12`: `openssl base64 -A -in DeveloperID.p12`)
  - `APPLE_CERTIFICATE_PASSWORD`
  - `APPLE_SIGNING_IDENTITY` (e.g., `Developer ID Application: Your Org (TEAMID)`)
  - Optional notarization secrets: `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID`
  `tauri.conf.json` keeps `"signingIdentity": null` so local builds remain unblocked while CI injects `APPLE_SIGNING_IDENTITY` when present.
- **Without Apple Developer ID (Unsigned Build Caveats)**:
  1. **Gatekeeper One-Time Bypass**: After dragging `SM Office Desk.app` into `/Applications`, macOS Gatekeeper quarantines unsigned downloads. Employees must clear the quarantine attribute once:
     ```bash
     xattr -cr "/Applications/SM Office Desk.app"
     ```
     (Alternatively: Control-click -> **Open** -> **Open**, or **System Settings > Privacy & Security > Open Anyway**.)
  2. **TCC Screen Recording Permission Reset Across Unsigned Updates**: Without a stable Developer ID code signature, macOS TCC binds Screen Recording permission for `com.smoffice.desk` to the binary's ad-hoc CDHash. Whenever an unsigned `.app` is replaced by a newer build, macOS silently invalidates Screen Recording access even if the checkbox still appears enabled in System Settings. Reset and re-approve it with:
     ```bash
     tccutil reset ScreenCapture com.smoffice.desk
     ```
     Then re-enable **SM Office Desk** under **System Settings > Privacy & Security > Screen & System Audio Recording** and restart tracking.

---

## 4. Linux Packaging, X11 vs. Wayland & `GeoClue2`

### 4.1 `glibc` Cross-Distro Build Strategy, Runtime Dependencies & Pure-Rust `.rpm` Bundling
- **Cross-Distro `glibc` Strategy**:
  - **`x86_64` builds** run on `ubuntu-24.04` (`glibc 2.39`, PipeWire >= 1.0 required by `xcap` / `libspa`) so `.deb`, `.rpm`, and `.AppImage` artifacts run across Ubuntu 24.04+ and Fedora 40–45+.
  - **`aarch64` (`ARM64`) builds** run natively on `ubuntu-24.04-arm` (**`glibc` 2.39** baseline), supporting Ubuntu 24.04+ and Fedora 40+ ARM64.
- **Pure-Rust `.rpm` Bundling & CI Verification**:
  - Tauri v2's `tauri-bundler` builds `.rpm` packages natively in pure Rust without requiring `rpmbuild` on Ubuntu runners.
  - Ubuntu CI runners install `rpm` (`apt-get install rpm`) so `.deb` and `.rpm` artifacts are verified automatically on every build via `dpkg-deb -I`, `rpm -qpi`, and `rpm -qpR`.
- **Ubuntu / Debian `.deb` runtime dependencies** (`bundle.linux.deb` in `tauri.conf.json`):
  - `depends`: `libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1`, `libpipewire-0.3-0` (satisfied on Ubuntu 24.04 via `libpipewire-0.3-0t64`'s `Provides: libpipewire-0.3-0`), `libdbus-1-3`, `libxcb1`, `libxrandr2`, `geoclue-2.0`, `libglib2.0-bin` (provides `gdbus` for `GeoClue2` D-Bus calls).
  - `recommends`: `xdg-desktop-portal`.
- **Fedora / RHEL-family `.rpm` runtime dependencies** (`bundle.linux.rpm` in `tauri.conf.json`, `epoch: 0`, `release: "1"`, `compression: { type: "gzip", level: 6 }`):
  - `depends`: `webkit2gtk4.1`, `gtk3`, `libayatana-appindicator-gtk3`, `pipewire-libs`, `dbus-libs`, `libxcb`, `libXrandr`, `geoclue2`, `glib2`.
  - `recommends`: `xdg-desktop-portal`.

#### Build-Time `apt` Dependencies (Ubuntu 24.04)
Required to compile Tauri v2 + `xcap = "0.9"` (plus `rpm` for CI/local `.rpm` metadata verification):
```bash
sudo apt-get update && sudo apt-get install -y \
  build-essential libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf rpm libssl-dev pkg-config libclang-dev \
  libxcb1-dev libxrandr-dev libdbus-1-dev libpipewire-0.3-dev \
  libwayland-dev libegl-dev libgbm-dev curl wget file
```

#### Build-Time `dnf` Dependencies (Fedora)
Required when compiling and bundling `.rpm` / `.AppImage` locally on Fedora:
```bash
sudo dnf install -y \
  gcc gcc-c++ make pkgconf-pkg-config webkit2gtk4.1-devel gtk3-devel \
  libayatana-appindicator-gtk3-devel librsvg2-devel openssl-devel clang-devel \
  libxcb-devel libXrandr-devel dbus-devel pipewire-devel wayland-devel \
  mesa-libEGL-devel mesa-libgbm-devel patchelf curl wget file
```

### 4.2 X11 vs. Wayland Screen Capture (`xdg-desktop-portal` + PipeWire)
- **X11**: `xcap` captures monitors directly via `libxcb1` + `libxrandr2` with no per-capture consent prompt.
- **Wayland**: Wayland isolates screen pixels by compositor security policy. `xcap` negotiates capture over D-Bus with `org.freedesktop.portal.Desktop` (`xdg-desktop-portal` + backend such as `xdg-desktop-portal-gnome`, `xdg-desktop-portal-kde`, or `xdg-desktop-portal-wlr`) and streams frames via PipeWire (`libpipewire-0.3-0` / `pipewire-libs`):
  - **Restore Token (`persist_mode = 2`)**: When the employee approves the portal dialog via `[Grant Screen Access]` (or initial capture), the compositor/portal backend stores a persistent restore token (`persist_mode=2`) so subsequent 10–30 minute random captures and admin `CAPTURE_NOW` requests execute seamlessly without repeatedly interrupting the employee with system dialogs.
  - **GNOME / KDE Portal Notes**: Ensure `pipewire`, `wireplumber`, and the desktop-appropriate portal backend (`xdg-desktop-portal-gnome` or `xdg-desktop-portal-kde`) are running (`systemctl --user status xdg-desktop-portal pipewire`).
- **Lock-Screen Detection**: `lock.rs` queries `loginctl show-session "$XDG_SESSION_ID" -p LockedHint --value` (`yes` -> `screen_locked`).

### 4.3 Linux Live Location (`GeoClue2`)
- When `Share Live Location` is toggled `ON`, `location.rs` calls `org.freedesktop.GeoClue2` (`/org/freedesktop/GeoClue2/Manager`) over the system D-Bus using `gdbus` with `DesktopId = 'com.smoffice.desk'`.
- Ensure the `geoclue` daemon (`geoclue-2.0` on Ubuntu / `geoclue2` on Fedora) is installed and Location Services are enabled in desktop privacy settings (e.g., **GNOME Settings > Privacy > Location**). If `GeoClue2` is unavailable or returns no location, the app asks for explicit IP Approx opt-in rather than using IP geolocation silently.

### 4.4 Fedora & Linux System Tray Notes
- **KDE Plasma (Fedora KDE Spin)**: Supports StatusNotifierItem system tray icons natively out of the box.
- **GNOME (Fedora Workstation Default)**: GNOME Shell removed built-in legacy tray icons. Install and enable the AppIndicator extension (`sudo dnf install gnome-shell-extension-appindicator`, then enable it in **Extensions** / GNOME Tweaks) to display the SM Office Desk tray icon.
- **Automatic Window-Minimize Fallback**: If no system tray daemon (`StatusNotifierWatcher` / AppIndicator) is available, `tray::create_tray` in `apps/desktop/src-tauri/src/lib.rs` logs a warning and starts cleanly without failing; closing the window while the timer is active automatically falls back to minimizing the window to the taskbar/dock (`window.minimize()`) instead of hiding it (`window.hide()`), and shows a notification explaining how to restore it.

### 4.5 AppImage `FUSE` Requirement
- Modern Ubuntu releases (`22.04` / `24.04`) do not preinstall FUSE v2 required to mount Type-2 AppImages directly. Employees running the `.AppImage` on Ubuntu should either:
  - Install FUSE 2 (`sudo apt install libfuse2` on Ubuntu 22.04, or `sudo apt install libfuse2t64` on Ubuntu 24.04), **or**
  - Extract and run without FUSE:
    ```bash
    chmod +x SM-Office-Desk_*.AppImage
    ./SM-Office-Desk_*.AppImage --appimage-extract
    ./squashfs-root/AppRun
    ```

---

## 5. GitHub Actions CI/CD & Checksum Verification

Workflow file: [`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml)

- **Triggers**:
  - Tag push `desktop-v*` -> verifies tests, creates/updates a **draft** GitHub Release (`prepare-release`), builds all 5 64-bit targets without uploading mismatched per-job assets directly from `tauri-action`, stages normalized installer filenames (`-setup.exe`, `-portable.exe`, `.msi`, `.dmg`, `.app.tar.gz`, `.deb`, `.rpm`, `.AppImage`), verifies Linux `.deb`/`.rpm` headers and dependencies (`dpkg-deb -I`, `rpm -qpi`, `rpm -qpR`), computes `SHA256SUMS.txt` in the `checksums` job, and idempotently uploads every installer + `SHA256SUMS.txt` to the draft release so release assets match `SHA256SUMS.txt` 1:1.
  - Pull requests touching `apps/desktop/**` or `packages/shared/**`, or manual `workflow_dispatch` -> verifies tests, builds all 5 targets, validates `.deb`/`.rpm` packages, computes `SHA256SUMS.txt`, and uploads installers + `SHA256SUMS.txt` as workflow artifacts without publishing a release.

### Verifying Downloaded Installers with `SHA256SUMS.txt`
- **Linux**:
  ```bash
  sha256sum -c SHA256SUMS.txt --ignore-missing
  ```
- **macOS**:
  ```bash
  shasum -a 256 -c SHA256SUMS.txt --ignore-missing
  ```
- **Windows (PowerShell)**:
  ```powershell
  Get-FileHash .\SM-Office-Desk_*_windows_x64-setup.exe -Algorithm SHA256
  # Compare Hash against SHA256SUMS.txt
  ```

---

## 6. Local Developer Prerequisites & Commands

### Prerequisites
- **Node.js 22 LTS** + **npm 10+**
- **Rust stable** (`rustup` 1.77+)
- **OS build tools**:
  - Windows: Visual Studio 2022 Build Tools (`Desktop development with C++`, MSVC + Windows 10/11 SDK) + WebView2 Runtime.
  - macOS: Xcode Command Line Tools (`xcode-select --install`), plus `rustup target add aarch64-apple-darwin x86_64-apple-darwin` for Universal builds.
  - Linux: `apt` packages (Ubuntu/Debian) or `dnf` packages (Fedora) listed in Section 4.1.

### Common Commands (from repository root)
```bash
# 1. Install workspace dependencies and build shared contracts
npm install
npm --workspace=@sm-office/shared run build

# 2. Run desktop TypeScript, Vitest, and Rust unit tests
npm --workspace=@sm-office/desktop run typecheck
npm --workspace=@sm-office/desktop run test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib

# 3. Run Tauri desktop app in development mode
npm --workspace=@sm-office/desktop run tauri dev

# 4. Build release installers locally (all default bundles or platform-specific scripts)
npm --workspace=@sm-office/desktop run tauri build
npm --workspace=@sm-office/desktop run tauri:build:win     # Windows (.exe NSIS + .msi)
npm --workspace=@sm-office/desktop run tauri:build:ubuntu  # Ubuntu/Debian (.deb)
npm --workspace=@sm-office/desktop run tauri:build:fedora  # Fedora/RHEL (.rpm)
npm --workspace=@sm-office/desktop run tauri build -- --bundles deb,rpm,appimage
```
