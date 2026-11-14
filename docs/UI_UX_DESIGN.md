# SM Office Desk — UI/UX Design System, Wireframes & Interaction Specification

> **Document Status**: Phase 1 Design Specification (Authoritative UI Contract)  
> **Aligned Architecture**: [`docs/SOFTWARE_ARCHITECTURE.md`](./SOFTWARE_ARCHITECTURE.md)  
> **Scope**: Surface A (Admin Web Dashboard — React + Vite + Tailwind CSS + Leaflet) & Surface B (Employee Desktop App — Tauri v2 `360×480` + System Tray)  
> **Scale Guardrails**: Max **10 active employees** · Max **2 active admins** · **90-day** retention policy · **$0 Map API** (OpenStreetMap + Leaflet) · **64-bit Desktop Only** (`x86_64` & `ARM64` for Windows 10/11, macOS, Linux)

---

## 1. Design Philosophy & Core UX Principles

1. **Calm, High-Trust Operational Clarity**: Telemetry and payroll interfaces must never feel chaotic or intrusive. Every piece of tracking metadata (screenshot intervals, location consent, rate snapshots, 90-day expiry) is labeled honestly and predictably.
2. **Explicit Privacy Ethics (Zero Dark Patterns)**:
   - On the Employee Desktop App, **Live Location** is explicitly employee-controlled (`Share Live Location: ON / OFF`). When `OFF`, the UI clearly confirms that zero coordinates and no IP geolocation fallback are transmitted.
   - When the timer runs, **Screenshot Auditing** is strictly mandatory and non-removable; the Desktop UI states this transparently without exposing any pause, disable, delay, blur, or delete controls.
3. **Zero-Bloat Scale Calibration**: Designed purposefully for small teams (`<= 10` active employees, `<= 2` active admins). Live Monitoring fits cleanly on a single screen without pagination fatigue, while the Desktop App renders comfortably in a compact `360×480 px` viewport (`<70 MB` RAM).
4. **Timezone-Honest Grouping**: All timestamps are stored as server UTC and rendered/grouped in `Company Timezone` (`Asia/Dhaka` default) so late-night work and salary month cutoffs match local company operations.

---

## 2. Design Tokens & Visual System (Tailwind CSS)

### 2.1 Color Palette & WCAG AA Contrast Matrix

All color pairs below meet or exceed **WCAG 2.1 AA** contrast ratios (`>= 4.5:1` for normal body/badge text, `>= 3:1` for large headers, icons, and focus boundaries).

| Semantic Token | Usage | Background | Foreground Text | Border / Ring | Contrast Ratio |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **App Canvas** | Page background | `#F8FAFC` (`slate-50`) | `#0F172A` (`slate-900`) | `#E2E8F0` (`slate-200`) | `17.4 : 1` |
| **Surface Card** | Cards, modals, drawers | `#FFFFFF` (`white`) | `#0F172A` (`slate-900`) | `#E2E8F0` (`slate-200`) | `18.3 : 1` |
| **Surface Muted** | Table headers, secondary panels | `#F1F5F9` (`slate-100`) | `#334155` (`slate-700`) | `#CBD5E1` (`slate-300`) | `10.1 : 1` |
| **Primary Brand** | Primary CTAs, active tabs, focus | `#4F46E5` (`indigo-600`) | `#FFFFFF` (`white`) | `#4338CA` (`indigo-700`) | `6.29 : 1` |
| **Primary Soft** | Selected pills, `On-Demand` badge | `#EEF2FF` (`indigo-50`) | `#3730A3` (`indigo-800`) | `#C7D2FE` (`indigo-200`) | `9.38 : 1` |
| **Status: Active / Tracking** | Online timer, `Paid` salary, WS connected | `#ECFDF5` (`emerald-50`) | `#065F46` (`emerald-800`) | `#A7F3D0` (`emerald-200`) | `7.38 : 1` |
| **Status: Screen Locked** | OS lock screen / sleep, `Pending` salary | `#FFFBEB` (`amber-50`) | `#92400E` (`amber-800`) | `#FDE68A` (`amber-200`) | `7.02 : 1` |
| **Status: Offline / Stopped** | Idle desktop, offline employee | `#F1F5F9` (`slate-100`) | `#475569` (`slate-600`) | `#CBD5E1` (`slate-300`) | `6.82 : 1` |
| **Location: OS Precise** | Native OS GPS/Wi-Fi (`os_native`) | `#F0FDFA` (`teal-50`) | `#115E59` (`teal-800`) | `#99F6E4` (`teal-200`) | `7.34 : 1` |
| **Location: IP Approx** | Opt-in IP fallback (`ip_approx`) | `#F0F9FF` (`sky-50`) | `#075985` (`sky-800`) | `#BAE6FD` (`sky-200`) | `7.21 : 1` |
| **Location: Disabled** | `location_enabled = false` | `#F1F5F9` (`slate-100`) | `#334155` (`slate-700`) | `#CBD5E1` (`slate-300`) | `10.1 : 1` |
| **Expiry Warning (`<=7d`)** | Screenshots expiring soon | `#FFF7ED` (`orange-50`) | `#9A3412` (`orange-800`) | `#FED7AA` (`orange-200`) | `7.12 : 1` |
| **Destructive / Stop** | Delete, Deactivate, Stop Timer, Error | `#E11D48` (`rose-600`) | `#FFFFFF` (`white`) | `#BE123C` (`rose-700`) | `4.70 : 1` |
| **Destructive Soft** | Error banners, delete warning box | `#FFF1F2` (`rose-50`) | `#9F1239` (`rose-800`) | `#FECDD3` (`rose-200`) | `7.92 : 1` |
| **Mandatory Audit Lock** | Non-removable Desktop auditing banner | `#0F172A` (`slate-900`) | `#F8FAFC` (`slate-50`) | `#334155` (`slate-700`) | `17.4 : 1` |

> **Accessibility Guard**: Never use `amber-500` or `emerald-500` as text color on light `#FFFFFF` / `#F8FAFC` backgrounds (contrast `< 3.0:1`). Reserve bright `500` hues (`emerald-500`, `amber-500`, `rose-500`) strictly for `8px` status indicator dots, progress bar fills, and map pin accents paired with `700`/`800` text labels.

### 2.2 Typography Scale & Tabular Numerals

- **Primary Sans Stack**: `'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` (zero dependency failure if external CDN is unavailable).
- **Monospace / Telemetry Stack**: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`.
- **Mandatory `tabular-nums` Rule**: Apply `tabular-nums` (`font-variant-numeric: tabular-nums`) on **all** live timers (`02:14:38`), countdown buttons (`14s`, `5s`), currency totals (`৳ 45,000.00`), slot meters (`7 / 10`), file sizes (`84 KB`), and timestamps (`14:22:05`).

| Scale Token | Size / Line Height | Weight | Tailwind Classes | Use Case |
| :--- | :--- | :--- | :--- | :--- |
| `timer-hero` | `36px / 40px` | `700` | `font-mono text-4xl font-bold tracking-tight tabular-nums` | Desktop Tracker active session clock (`02:14:38`) |
| `page-title` | `24px / 32px` | `700` | `text-2xl font-bold tracking-tight text-slate-900` | Admin view headers (`Live Monitor`, `Salary Reports`) |
| `section-title` | `18px / 26px` | `600` | `text-lg font-semibold text-slate-900` | Card/modal headers (`Active Employees (7 / 10)`) |
| `card-title` | `15px / 22px` | `600` | `text-[15px] font-semibold text-slate-900` | Employee card names, settings group titles |
| `body` | `14px / 20px` | `400/500` | `text-sm text-slate-700` | Form inputs, table rows, modal descriptions |
| `caption` | `12px / 16px` | `500` | `text-xs font-medium text-slate-600` | Secondary metadata, timestamps, expiry countdown |
| `micro-badge` | `11px / 14px` | `600` | `text-[11px] font-semibold uppercase tracking-wide` | Status pills (`OS PRECISE`, `ON-DEMAND`, `PAID`) |

### 2.3 Spacing, Radii, Shadows & Z-Index Scale

- **Spacing Grid**: `4px` base unit (`gap-1.5` = 6px, `gap-3` = 12px, `p-4` = 16px Desktop cards, `p-5`/`p-6` = 20–24px Admin cards & modals).
- **Border Radii**:
  - `rounded-md` (`6px`): Badges, checkboxes, inline code/keys.
  - `rounded-lg` (`8px`): Buttons, form inputs, segmented tabs.
  - `rounded-xl` (`12px`): Dashboard cards, map container, desktop tracker cards.
  - `rounded-2xl` (`16px`): Modals, lightbox container, login card.
  - `rounded-full` (`9999px`): Status dots, pill badges, avatar circles.
- **Elevation / Shadows**:
  - `shadow-xs` (`0 1px 2px rgba(15,23,42,0.05)`): Standard cards.
  - `shadow-md` (`0 4px 12px rgba(15,23,42,0.08)`): Sticky bulk action bar, Leaflet popups, hover states.
  - `shadow-xl` (`0 20px 40px rgba(15,23,42,0.20)`): Confirmation modals & Lightbox.
- **Z-Index Layers**:
  - `z-0`: Leaflet map canvas & image thumbnails
  - `z-10`: Sticky table headers & card hover checkboxes
  - `z-20`: App shell topbar, left sidebar, sticky Bulk Delete Action Bar
  - `z-30`: Dropdown menus, date popovers, Leaflet popups
  - `z-40`: Modal / drawer backdrop (`bg-slate-950/60 backdrop-blur-[2px]`)
  - `z-50`: Confirmation modals & WebP Lightbox
  - `z-60`: Toast notifications (top-right on Admin Web; inline banner on Desktop `360×480`)

### 2.4 Icon Strategy (`lucide-react`)

Use `lucide-react` (`strokeWidth={1.75}`) consistently across both React apps (`admin-web` and `desktop-ui`):
- **Navigation & Shell**: `LayoutDashboard`, `Images`, `Users`, `Banknote`, `Settings`, `LogOut`, `Wifi`, `WifiOff`, `Globe`
- **Monitoring & Captures**: `Camera`, `Clock`, `Monitor`, `Lock`, `ShieldCheck`, `AlertTriangle`, `RefreshCw`, `CheckCircle2`, `XCircle`
- **Location**: `MapPin`, `MapPinOff`, `Navigation`, `Crosshair`
- **Gallery & Actions**: `Calendar`, `Filter`, `Trash2`, `CheckSquare`, `Square`, `ZoomIn`, `ChevronLeft`, `ChevronRight`, `X`
- **Employees & Payroll**: `UserPlus`, `UserCheck`, `UserX`, `Pencil`, `Download`, `Printer`, `Eye`, `EyeOff`

### 2.5 Copy-Ready Tailwind Theme Tokens (`tokens.css` / `@theme`)

```css
/* Shared Tailwind v4 @theme / CSS custom properties for Admin Web & Desktop Tauri UI */
:root {
  --sm-bg-canvas: #f8fafc;
  --sm-bg-surface: #ffffff;
  --sm-bg-muted: #f1f5f9;
  --sm-border-default: #e2e8f0;
  --sm-border-strong: #cbd5e1;

  --sm-text-primary: #0f172a;
  --sm-text-secondary: #475569;
  --sm-text-muted: #64748b;

  --sm-brand-primary: #4f46e5;
  --sm-brand-hover: #4338ca;
  --sm-brand-soft: #eef2ff;

  --sm-status-active-bg: #ecfdf5;
  --sm-status-active-fg: #065f46;
  --sm-status-locked-bg: #fffbeb;
  --sm-status-locked-fg: #92400e;
  --sm-status-offline-bg: #f1f5f9;
  --sm-status-offline-fg: #475569;

  --sm-loc-precise-bg: #f0fdfa;
  --sm-loc-precise-fg: #115e59;
  --sm-loc-approx-bg: #f0f9ff;
  --sm-loc-approx-fg: #075985;

  --sm-danger-solid: #e11d48;
  --sm-danger-soft: #fff1f2;
  --sm-danger-fg: #9f1239;
}
```

---

## 3. Surface A: Admin Web Dashboard

### 3.1 Information Architecture & Responsive Breakpoints

| Route | View Name | Primary Purpose | Key Controls |
| :--- | :--- | :--- | :--- |
| `/login` | Admin Login | Authenticate active admin (`role = admin`) | Email, Password, Sign In |
| `/monitor` | Live Monitor & Map | Real-time tracking of <=10 employees + Leaflet map | Per-employee `Take Screenshot Now`, Map focus |
| `/screenshots` | Screenshot Gallery | Timezone-aware (`Employee -> Date -> Time`) browser | Filters, Lightbox, Single & Bulk Delete |
| `/employees` | Employees & Admins | Manage `X / 10` employee slots & `Y / 2` admin roster | Register, Edit, Safe Deactivate/Reactivate |
| `/salary` | Salary Reports | Monthly payroll snapshots (`BDT`), Paid/Pending, exports | Create/Edit modal, Mark Paid, CSV & Print/PDF |
| `/settings` | System Settings | Company name, timezone, currency, retention & storage info | Company Name, IANA Timezone, Currency Code |

**Responsive Behavior**:
- **Desktop (`>= 1280px`)**: Persistent `232px` left sidebar + `64px` top bar + `12-column` fluid content grid (`max-w-[1440px]`).
- **Tablet (`768px – 1279px`)**: Sidebar collapses to slide-over drawer (triggered by topbar menu icon); Monitor + Map stack vertically (`Grid` on top, `Map` `420px` tall below); tables allow horizontal scroll with sticky first column.
- **Mobile (`< 768px`)**: Slide-over navigation drawer; single-column cards; Salary & Employee tables convert to stacked summary cards (`md:table` / `block md:hidden` cards) so no data clips horizontally.

---

### 3.2 App Shell & Navigation Wireframe

```text
+---------------------------------------------------------------------------------------------------+
| [≡] SM Office Desk   |  [● 7 / 10 Active Slots]  [● WS: Connected]  [TZ: Asia/Dhaka (UTC+6)]      |
|                      |                                           [Tariq Hasan (Admin)] [Sign Out] |
+----------------------+----------------------------------------------------------------------------+
|                      |                                                                            |
|  NAVIGATION          |   <MAIN VIEWPORT CANVAS — bg-slate-50 p-6>                                 |
|  ------------------  |                                                                            |
|  [■] Live Monitor    |   (Active route content renders here: Monitor, Gallery, Employees,         |
|  [ ] Screenshots     |    Salary Reports, or Settings)                                            |
|  [ ] Employees  (7)  |                                                                            |
|  [ ] Salary Reports  |                                                                            |
|  [ ] Settings        |                                                                            |
|                      |                                                                            |
|  ------------------  |                                                                            |
|  QUOTA SNAPSHOT      |                                                                            |
|  Employees: 7 / 10   |                                                                            |
|  [███████░░░]        |                                                                            |
|  Admins:    2 / 2    |                                                                            |
|  Retention: 90 days  |                                                                            |
+----------------------+----------------------------------------------------------------------------+
```

**Shell Status Indicators**:
- **WS Health Pill**:
  - `WS: Connected` (`emerald-50` / `emerald-800` + pulsing dot)
  - `WS: Reconnecting...` (`amber-50` / `amber-800` + spinner; triggers automatic REST poll fallback every 15s until reconnected)
  - `WS: Disconnected` (`rose-50` / `rose-800` + manual `"Reconnect"` action)
- **Active Slots Badge**: `7 / 10 Active` (links directly to `/employees`).
- **Company Timezone Badge**: `TZ: Asia/Dhaka` (links to `/settings`, clarifies all UI dates & times).

---

### 3.3 Admin Login Screen (`/login`)

```text
+-----------------------------------------------------------------------------+
|                           bg-slate-50 (full height)                         |
|                                                                             |
|                     +-----------------------------------+                   |
|                     |   [Logo]  SM Office Desk          |                   |
|                     |   Admin Web Console               |                   |
|                     |-----------------------------------|                   |
|                     |  [!] Error / Rate-limit Banner    | <-- Conditional   |
|                     |                                   |                   |
|                     |  Work Email                       |                   |
|                     |  [ admin@company.com            ] |                   |
|                     |                                   |                   |
|                     |  Password                         |                   |
|                     |  [ ••••••••••••••••        (Eye)] |                   |
|                     |                                   |                   |
|                     |  [       Sign In to Console     ] | <-- Enter submits |
|                     |-----------------------------------|                   |
|                     |  Admin accounts only (Max 2).     |                   |
|                     |  Need a password reset? Use CLI:  |                   |
|                     |  npm run reset:password           |                   |
|                     +-----------------------------------+                   |
+-----------------------------------------------------------------------------+
```

**Login Interaction & Error States**:
1. **Validation Error**: Inline `text-xs text-rose-700` under empty/malformed email or password `< 8` chars; `aria-invalid="true"` + `aria-describedby`.
2. **Invalid Credentials (`401`)**: Soft-red alert banner `"Invalid email or password."` (never reveals whether email exists).
3. **Employee Role Login Attempt (`403`)**: `"This portal is restricted to Admin accounts. Employees must use the SM Office Desk desktop app."`
4. **Deactivated Account (`403`)**: `"Your administrator account has been deactivated. Contact another active admin or server operator."`
5. **Rate Limit (`429`)**: Amber/Rose alert banner with live countdown `"Too many sign-in attempts. Retry allowed in 42s."` (`Sign In` button disabled during cooldown).
6. **Loading State**: Button shows spinner + `"Signing in..."` (`disabled`, `aria-busy="true"`).

---

### 3.4 Live Monitor Grid + OpenStreetMap / Leaflet Map (`/monitor`)

```text
+---------------------------------------------------------------------------------------------------+
| LIVE MONITOR  ·  Updated 14:22:08 Asia/Dhaka                               [Filter: All v] [View] |
| [● 5 Tracking]   [🔒 1 Screen Locked]   [○ 1 Offline]   [📍 4 Sharing Location]                   |
+---------------------------------------------------------------------------------------------------+
|  EMPLOYEE LIVE GRID (7/12 cols on >=1280px)        |  LIVE TEAM MAP — OpenStreetMap + Leaflet      |
|                                                    |  (5/12 cols sticky on >=1280px, min-h 540px) |
| +----------------------+  +----------------------+ | +------------------------------------------+ |
| | NR  Nadia Rahman     |  | AR  Arif Hossain     | | | [+] [-] [Fit All Active]                 | |
| |     Senior Designer  |  |     Backend Dev      | | |                                          | |
| | [● ACTIVE  02:14:38] |  | [🔒 SCREEN LOCKED]   | | |       ~ OpenStreetMap Tiles ~            | |
| | Win11 x64 · 2 Mon    |  | macOS ARM64 · 01:40  | | |                                          | |
| |----------------------|  |----------------------| | |       (( (NR) )) <-- Teal L.circle       | |
| | +------------------+ |  | +------------------+ | | |         OS Precise (±15m)                | |
| | | [Latest WebP     | |  | |      [🔒]        | | | |                                          | |
| | |  Preview 16:9]   | |  | | Screen Locked    | | | |    ( ( ( (SH) ) ) ) <-- Sky dashed       | |
| | +------------------+ |  | +------------------+ | | |         IP Approx (±5km)                 | |
| | 14:20 BDT · Random   |  | 14:15 BDT · Locked   | | |                                          | |
| | [📍 OS Precise ±15m] |  | [⊘ Disabled by Emp]  | | |  +------------------------------------+  | |
| | [📷 Take Screenshot] |  | [📷 Take Screenshot] | | |  | Popup: Nadia Rahman (OS Precise)   |  | |
| +----------------------+  +----------------------+ | |  | Accuracy: ±15m · 14:21:40 BDT      |  | |
|                                                    | |  | [Focus Card] [Take Screenshot Now] |  | |
| +----------------------+  +----------------------+ | |  +------------------------------------+  | |
| | SH  Sadia Haque      |  | KM  Kamal Mia        | | +------------------------------------------+ |
| |     QA Engineer      |  |     Frontend Dev     | | LOCATION PRIVACY SUMMARY                     |
| | [● ACTIVE  04:05:11] |  | [○ OFFLINE]          | | ● 4 Sharing (3 OS Precise · 1 IP Approx)     |
| | Ubuntu x64 · 1 Mon   |  | Today: 03h 15m       | | ⊘ Location Disabled by Employee (2):         |
| |----------------------|  |----------------------| |   Arif Hossain, Tariqul Islam                |
| | [Requesting... 11s]  |  | Last seen: 12:30 BDT | |   (Zero coordinates or IP geo collected)     |
| |  (Spinner active)    |  | [⊘ Offline]          | |                                              |
| | [📍 IP Approx ±5km]  |  | [📷 Offline (Disab.)]| |                                              |
| +----------------------+  +----------------------+ |                                              |
+---------------------------------------------------------------------------------------------------+
```

#### Employee Live Card Anatomy (Max 10 Cards — Zero Pagination)
- **Header**: Initials circle (`36px`), Full Name, Designation, Live Status Badge (`Active` emerald, `Screen Locked` amber, `Offline` slate).
- **Telemetry Row**:
  - When Active/Locked: Live ticking timer `HH:MM:SS` (`tabular-nums`, incremented client-side every 1s anchored to server `started_at`, corrected on `employee_status` WS event) + Today total (`Today: 06h 12m`).
  - Device & Monitor tag: `Win11 · x64 · 2 Monitors` / `macOS · ARM64 · 1 Monitor` / `Ubuntu · x64`.
- **Latest Screenshot Thumbnail**:
  - `aspect-video` (`16:9`) private WebP preview (`loading="lazy"`) with capture type & local timestamp (`14:20:11 BDT · Random`). Clicking opens Lightbox Modal immediately.
  - If latest event is `screen_locked`: clean amber/slate placeholder (`Lock` icon + `"Screen locked at 14:15 BDT"` — never a broken image).
  - If no captures yet in current session: clean subtle camera placeholder `"Awaiting first capture (10–30m)"`.
- **Location Status Row**:
  - `os_native`: Teal pill `[Navigation] OS Precise (±15m)` — interactive button that pans & zooms Leaflet map to employee's marker and opens its popup.
  - `ip_approx`: Sky pill `[Globe] IP Approx (±5.2km)` — interactive button that pans map to approximate area circle.
  - `disabled`: Slate pill `[MapPinOff] Disabled by Employee` — non-error privacy status (zero coordinates displayed).
  - `offline`: Muted text `"Location inactive (offline)"`.
- **Single-Employee "Take Screenshot Now" Button**:
  - **Strict Design Rule**: Placed individually on each employee card. **Do NOT** add a global "Capture All Employees" button; on-demand captures are single-employee by design.

#### "Take Screenshot Now" Complete State Machine

| State | Trigger | Button Visual & Copy | Card / Toast Feedback | Next Allowed State |
| :--- | :--- | :--- | :--- | :--- |
| **`Idle`** | Employee status is `Active` or `Screen Locked` | Indigo outline/solid button: `[Camera] Take Screenshot Now` | Normal card state | `Pending` (on click) / `Offline` (on WS disconnect) |
| **`Pending (15s)`** | Admin clicks button (`POST /capture-now` returns `202` + `request_id`) | Disabled indigo-soft button with spinner: `[Spinner] Capturing... 14s` (`tabular-nums` countdown `15 -> 1`) | Subtle indigo border pulse on card | `Ready`, `Screen Locked Event`, `Failed`, or `Timeout` |
| **`Ready -> Cooldown (5s)`** | WS `screenshot_ready` matches `request_id` within `15s` | Transitions immediately into `Cooldown`: Disabled slate/emerald-muted `[Check] Captured · Wait 5s` (`5 -> 1`) | Success toast: `"Screenshot captured for Nadia Rahman"`; card thumbnail flashes softly and updates to new WebP | `Idle` (after 5s cooldown expires) |
| **`Screen Locked Event`** | WS `screenshot_ready` with `capture_status = "screen_locked"` | Enters `5s` Cooldown (`[Lock] Screen Locked · Wait 4s`) | Toast warning: `"Nadia Rahman's screen is currently locked — lock event logged."`; thumbnail shows lock card | `Idle` (after 5s cooldown) |
| **`Timeout (15s)`** | `15s` timer hits `0` with no WS `screenshot_ready` / `capture_ack`, or server emits `capture_status: timeout` | Returns to `Idle` (or brief 2s `"Retry Capture"` state) | Amber inline alert on card + toast: `"Device did not respond within 15s (network lag or sleep)."` | `Idle` |
| **`Failed`** | WS `capture_failed` (e.g., OS permission denied) | Returns to `Idle` | Rose inline alert on card: `"Capture failed: OS Screen Recording permission missing."` | `Idle` |
| **`Offline`** | Employee WS offline / session stopped | Disabled muted button: `Offline — Cannot Capture` (`disabled`) | Card status badge shows `Offline` | `Idle` (when employee reconnects & starts timer) |

#### OpenStreetMap + Leaflet Map Rules
1. **Free Tiles**: Standard OpenStreetMap raster tiles (`https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`) with required attribution `© OpenStreetMap contributors`.
2. **Custom DivIcon Pins**: `32px` circular badge showing employee initials, ring color matching `source` (`#0F766E` teal for `os_native`, `#0369A1` sky for `ip_approx`), plus active green pulse dot.
3. **Accuracy Circle (`L.circle`)**:
   - `os_native`: Teal stroke (`#0D9488`, `weight: 2`), `fillOpacity: 0.14`.
   - `ip_approx`: Dashed sky stroke (`#0284C7`, `dashArray: '6 4'`, `weight: 2`), `fillOpacity: 0.08`.
   - **Zoom Clamp UX**: `"Fit All Active"` computes `fitBounds` over **marker center coordinates** (not massive `5–20km` IP accuracy circles) so one employee with `IP Approx` doesn't zoom the entire map out to country level and obscure nearby `OS Precise` markers. Clicking a specific marker zooms comfortably to show its accuracy circle.
4. **Disabled Location Panel**: Located directly below the Leaflet canvas inside the Map panel. Explicitly lists employees whose `location_enabled = false` under `"Location Disabled by Employee"` with `MapPinOff` icon — confirming compliance with the strict no-IP-fallback rule.

---

### 3.5 Timezone-Aware Screenshot Gallery (`Employee -> Date -> Time`) (`/screenshots`)

```text
+---------------------------------------------------------------------------------------------------+
| SCREENSHOT GALLERY  ·  Grouped in Company Timezone: Asia/Dhaka (UTC+6)   [Retention: 90d Policy]  |
+----------------------+----------------------------------------------------------------------------+
| 1. EMPLOYEE          |  3. TIME SLOTS & FILTERS                                                   |
| [All Employees (10)] |  Type: [All (24)]  [Random (19)]  [On-Demand (4)]  [Screen Locked (1)]      |
| > Nadia Rahman  (24) |  Hour: [All Hours v]                          [Select All in View]         |
|   Arif Hossain  (18) |----------------------------------------------------------------------------|
|   Sadia Haque   (22) |  v  14:00 – 14:59 BDT  (4 events)                                          |
|   Kamal Mia     (12) |  +------------------------+ +------------------------+ +-----------------+ |
|   [Deactivated]      |  | [x]        [ON-DEMAND] | | [ ]           [RANDOM] | | [ ]    [LOCKED] | |
|   Rashed Khan   (45) |  | +--------------------+ | | +--------------------+ | | +-------------+ | |
|                      |  | | WebP Lazy Preview  | | | | WebP Lazy Preview  | | | |    [🔒]     | | |
| 2. DATE (Asia/Dhaka) |  | +--------------------+ | | +--------------------+ | | |Screen Locked| | |
| [Today: 2026-11-14]  |  | 14:42:10 BDT  · 2 Mon  | | 14:21:04 BDT  · 2 Mon  | | +-------------+ | |
|   2026-11-13    (26) |  | 88 KB · [Exp: 89d] [🗑]| | 74 KB · [Exp: 89d] [🗑]| | 14:05:12 [🗑]   | |
|   2026-11-12    (25) |  +------------------------+ +------------------------+ +-----------------+ |
|   2026-11-11    (21) |                                                                            |
|   [Calendar Picker]  |  v  13:00 – 13:59 BDT  (3 events)                                          |
|                      |  ...                                                                       |
+----------------------+----------------------------------------------------------------------------+
| [STICKY BULK BAR when >=1 selected]:  [ 2 Selected ]   [Select All (24)]  [Clear]  [Delete (2)]  |
+---------------------------------------------------------------------------------------------------+
```

#### Gallery Specification Details
- **3-Level Hierarchy (`Employee -> Date -> Time`)**:
  - **Level 1 (Employee)**: Left column (top dropdown on mobile `< 1024px`). Shows Active Employees first, then an expandable `Deactivated (Retained <=90d)` sub-list so admins can still audit historical captures of former staff until 90-day expiry.
  - **Level 2 (Date in Company Timezone)**: Lists dates with captures in `Asia/Dhaka` (or configured `company_timezone`) plus a native/accessible Date input jump. Example: a screenshot captured at `2026-11-14 19:30 UTC` automatically appears under `2026-11-15` in `Asia/Dhaka (UTC+6)`.
  - **Level 3 (Time Slot Timeline)**: Collapsible hourly groups (`14:00 – 14:59 BDT`, `13:00 – 13:59 BDT`, sorted newest-first or chronological toggle) with `All / Random / On-Demand / Screen Locked` segmented filters.
- **Lazy-Loaded Single WebP Card**:
  - Uses `<img src={secureUrl} loading="lazy" decoding="async" alt="..." />` directly against the `~60–110 KB` WebP file (avoiding duplicate thumbnail storage).
  - Shows subtle `slate-200` pulse skeleton while fetching; on transient 401/network failure shows `"Preview unavailable — Retry"` button.
  - Displays:
    - Badge: `Random` (`slate-100`/`slate-700`) or `On-Demand` (`indigo-50`/`indigo-800` with hover/title `"Requested by Tariq Hasan"`).
    - Local time (`14:42:10 BDT`, `tabular-nums`).
    - Monitor badge & size (`2 Monitors · 88 KB`).
    - **90-Day Expiry Countdown**:
      - `> 7 days` remaining: `Expires in 89d` (`slate-500` text)
      - `2–7 days` remaining: `Expires in 5d` (`orange-50` / `orange-800` warning pill)
      - `<= 1 day` remaining: `Expires in <24h` (`rose-50` / `rose-800` pill)
- **Screen Locked Non-Image Event Card**:
  - Never renders an `<img>` element. Displays dashed `amber-200` / `slate-200` frame, centered `Lock` icon badge, `"Screen Locked / OS Sleep"`, capture trigger (`Random` / `On-Demand`), timestamp, and Delete icon.

#### WebP Lightbox Modal

```text
+---------------------------------------------------------------------------------------------------+
|  [X Close (Esc)]   Nadia Rahman  ·  2026-11-14 14:42:10 Asia/Dhaka        [< Prev]  [Next >]      |
+-----------------------------------------------------------------------+---------------------------+
|                                                                       |  CAPTURE METADATA         |
|                                                                       |  Employee: Nadia Rahman   |
|                                                                       |  Local: 14:42:10 BDT      |
|           [ Full-Resolution Private WebP Image ]                      |  UTC:   08:42:10 UTC      |
|           (Multi-monitor stitched canvas <= 1440/1600px)              |  Type:  [On-Demand]       |
|                                                                       |  By:    Tariq Hasan       |
|           [Fit Width]  [Actual Pixels (100%)]                         |  Size:  1440 x 450 · 88KB |
|                                                                       |  Displays: 2 Monitors     |
|                                                                       |  Retention: Expires 89d   |
|                                                                       |  (Purges 2027-02-12)      |
|                                                                       |---------------------------|
|                                                                       |  [🗑 Delete Screenshot]   |
+-----------------------------------------------------------------------+---------------------------+
```

- **Keyboard Support**: `ArrowLeft` (newer/previous), `ArrowRight` (older/next), `Escape` (close lightbox), `Tab` trapped inside modal.

#### Single & Bulk Delete Confirmation Flow
- **Single Delete**: Clicking `[Trash2]` on a card or in the Lightbox opens a centered confirmation modal (`role="alertdialog"`):
  - Title: `"Delete Screenshot Permanently?"`
  - Body: `"This removes Nadia Rahman's screenshot from 2026-11-14 14:42:10 BDT from both storage and database logs. This action cannot be undone."`
  - Actions: `[Cancel]` (default focus!) and `[Delete Permanently]` (rose solid).
- **Bulk Select Delete**:
  - Checking any card displays the sticky bottom action bar (`[N Selected] [Select All in View] [Clear] [Delete Selected]`).
  - Clicking `[Delete Selected]` opens bulk confirmation modal: `"Permanently delete N selected screenshots (total ~X MB)?"` -> executes `POST /api/admin/screenshots/bulk-delete` -> shows progress state -> refreshes gallery & displays toast `"N screenshots permanently deleted"`.

---

### 3.6 Employee Registration & Quota Management (`/employees`)

```text
+---------------------------------------------------------------------------------------------------+
| EMPLOYEES & ADMIN ACCESS                                                                          |
+---------------------------------------------------------------------------------------------------+
|  +---------------------------------------------------------------------------------------------+  |
|  |  ACTIVE EMPLOYEE SLOTS:  7 / 10 Used   (3 slots available)         [ + Register Employee ]  |  |
|  |  [███████████████████████░░░░░░░░░] 70%                                                     |  |
|  |  * Hard limit of 10 active employees enforced by database & API.                            |  |
|  +---------------------------------------------------------------------------------------------+  |
|                                                                                                   |
|  Tabs: [ Active (7) ]   [ Deactivated (3) ]   [ All (10) ]            Search: [ Filter name... ]  |
|  +---------------------------------------------------------------------------------------------+  |
|  | EMPLOYEE               | DESIGNATION     | SALARY TERMS        | STATUS      | ACTIONS      |  |
|  |------------------------+-----------------+---------------------+-------------+--------------|  |
|  | Nadia Rahman           | Senior Designer | Monthly · ৳ 55,000  | ● Tracking  | Edit | Deact |  |
|  | nadia@company.com      |                 |                     |             |              |  |
|  |------------------------+-----------------+---------------------+-------------+--------------|  |
|  | Arif Hossain           | Backend Dev     | Hourly  · ৳ 450/hr  | ○ Offline   | Edit | Deact |  |
|  | arif@company.com       |                 |                     |             |              |  |
|  +---------------------------------------------------------------------------------------------+  |
|                                                                                                   |
|  ADMIN ROSTER  ( 2 / 2 Active Admins — Maximum Reached )                  [+ Add Admin (Disabled)]|
|  +---------------------------------------------------------------------------------------------+  |
|  | Tariq Hasan (tariq@company.com)   | Active Admin (You) | [Edit]  [Deactivate]               |  |
|  |Farhana Akter (farhana@company.com)| Active Admin       | [Edit]  [Deactivate]               |  |
|  +---------------------------------------------------------------------------------------------+  |
|  * Note: When only 1 active admin remains, Deactivate is locked ("Cannot disable last admin").    |
+---------------------------------------------------------------------------------------------------+
```

#### Quota & Modal Interactions
1. **Slot Meter States**:
   - `0–8 / 10`: Indigo fill; `[+ Register Employee]` enabled.
   - `9 / 10`: Amber fill (`"1 slot remaining"`).
   - `10 / 10`: Rose/Slate-900 capped fill; `[+ Register Employee]` disabled (`aria-disabled="true"`) with inline helper `"10/10 active limit reached. Deactivate an employee to add someone new."`
2. **Register / Edit Employee Modal**:
   - Fields: `Full Name*`, `Email Address*`, `Initial Password*` (required on Register, min 8 chars, includes `[Generate]` & `[Copy]` helper so admin can hand credentials securely to employee; optional `"Set New Password"` toggle when editing), `Designation*`, `Salary Type*` (`Monthly` | `Hourly`), `Base Salary*` (prefixed with company currency e.g. `BDT`).
   - Handles API conflicts gracefully (`409 MAX_EMPLOYEES_EXCEEDED` refreshes meter; `409 EMAIL_EXISTS` highlights email input).
3. **Safe Deactivation Confirmation Modal**:
   - Triggered when clicking `Deactivate` on an active employee (`role="alertdialog"`):
     - Header: `"Deactivate Nadia Rahman?"`
     - Bullet Summary (explicitly reassuring & accurate):
       - **Immediate Lockout**: Forces active desktop session to stop (`FORCE_STOP`) and revokes auth tokens immediately (`token_version` incremented).
       - **Frees Quota Slot**: Active employee count drops (`7 / 10 -> 6 / 10`).
       - **History Preserved**: Existing salary reports, work hours, and screenshots remain intact until natural 90-day expiry.
     - Actions: `[Cancel]` | `[Deactivate Employee]` (rose button).
4. **Reactivate Guard**: Clicking `Reactivate` on a deactivated employee checks `activeCount < 10`. If `10 / 10`, button is disabled with tooltip `"Cannot reactivate: 10/10 active slots are full."`
5. **Admin Roster Guard (`Max 2, Min 1`)**:
   - `[+ Add Admin]` is disabled when `activeAdmins === 2` (`"Max 2 active admins allowed"`).
   - When `activeAdmins === 1`, the sole remaining admin's `[Deactivate]` button is disabled with visible lock reason `"Last active admin cannot be deactivated"`.

---

### 3.7 Salary Reports Manager (`/salary`)

```text
+---------------------------------------------------------------------------------------------------+
| SALARY REPORTS                                      Month: [ < 2026-11 > ]  [Export CSV] [Print]  |
+---------------------------------------------------------------------------------------------------+
|  [Total Payroll: ৳ 315,400]   [Paid: 4 (৳ 180,000)]   [Pending: 3 (৳ 135,400)]   [Hours: 1,142h]  |
+---------------------------------------------------------------------------------------------------+
|  Filter Employee: [All Employees v]   Status: [All | Paid | Pending]     [+ Create Salary Report] |
|  +---------------------------------------------------------------------------------------------+  |
|  | EMPLOYEE      | TRACKED TIME | SNAPSHOT RATE       | BONUS / DED.    | NET PAYABLE | STATUS |  |
|  |---------------+--------------+---------------------+-----------------+-------------+--------|  |
|  | Nadia Rahman  | 168h 20m     | Monthly · ৳ 55,000  | +2,000 / -0     | ৳ 57,000.00 | [Paid] |  |
|  |               |              | (Snapshotted rate)  |                 |             | 11/14  |  |
|  |---------------+--------------+---------------------+-----------------+-------------+--------|  |
|  | Arif Hossain  | 142h 30m     | Hourly · ৳ 450/hr   | +0 / -500       | ৳ 63,625.00 | [Pend] |  |
|  |               |              | (Base: ৳ 64,125)    |                 |             | [Mark] |  |
|  +---------------------------------------------------------------------------------------------+  |
+---------------------------------------------------------------------------------------------------+
```

#### Create / Edit Salary Report Modal
1. **Employee & Month Selection**: Selecting `(employee_id, YYYY-MM)` queries tracked `work_sessions` in Company Timezone and displays:
   - `Total Tracked Hours`: e.g. `142h 30m (513,000s)` (read-only server-computed baseline, or visible audit summary).
   - `Rate Snapshot Box` (muted info card): Shows `Salary Type: Hourly` & `Base Rate: BDT 450.00 / hr` (or `Monthly: BDT 55,000.00`), explicitly noting `"These rate values are snapshotted onto this report so future salary raises do not alter past payroll records."`
2. **Adjustments**:
   - `Overtime / Bonus` (`number >= 0`, `tabular-nums`)
   - `Deductions` (`number >= 0`, `tabular-nums`)
   - `Notes` (optional textarea, max 500 chars)
   - `Payment Status`: `Pending` | `Paid` (marking `Paid` records `paid_at` timestamp).
3. **Live Calculation Footer**:
   `Calculated Base (৳ 64,125.00) + Bonus (৳ 0.00) - Deductions (৳ 500.00) = Net Payable: ৳ 63,625.00`
4. **Duplicate Report Guard**: If `(employee_id, report_month)` already exists, inline banner prompts `"A report for Arif Hossain (2026-11) already exists"` with `"Open Existing Report"` button instead of crashing on the DB unique constraint.

#### Export CSV & Print/PDF Layout (`@media print`)
- **Export CSV**: Calls `GET /api/admin/salary-reports/export?month=YYYY-MM&format=csv`, triggering direct authenticated download (`sm-office-desk-salary-2026-11.csv`).
- **Print / Save as PDF**: Opens browser print (`window.print()`) styled via dedicated `@media print` CSS:
  - Hides sidebar, top header, filter inputs, and table action columns (`print:hidden`).
  - Displays clean company masthead (`Company Name`, `Salary Report — November 2026`, `Timezone: Asia/Dhaka`, `Currency: BDT`, `Printed on: ...`), crisp high-contrast black/slate borders, and summary totals footer.

---

### 3.8 Settings Screen (`/settings`)

```text
+---------------------------------------------------------------------------------------------------+
| SETTINGS                                                                                          |
+---------------------------------------------------------------------------------------------------+
|  +---------------------------------------------------------------+                                |
|  | ORGANIZATION & LOCALE                                         |                                |
|  | Company Name                                                  |                                |
|  | [ SM Creative Studio                                        ] |                                |
|  |                                                               |                                |
|  | Company Timezone (Default: Asia/Dhaka)                        |                                |
|  | [ Asia/Dhaka (UTC+06:00) — Current: 2026-11-14 14:22:08     ] |                                |
|  | * Organizes screenshot date folders & monthly salary cutoffs. |                                |
|  |                                                               |                                |
|  | Currency Code                                                 |                                |
|  | [ BDT — Bangladeshi Taka (৳)                                ] |                                |
|  |                                                               |                                |
|  |                                              [ Save Changes ] |                                |
|  +---------------------------------------------------------------+                                |
|                                                                                                   |
|  +---------------------------------------------------------------+                                |
|  | RETENTION & INFRASTRUCTURE POLICY (READ-ONLY)                 |                                |
|  | Data Retention Limit    [ 🔒 90 Days Fixed Policy ]           |                                |
|  | Automatic Purge Cron    Daily at 02:00 UTC (Screenshots &     |                                |
|  |                         Location Logs > 90 days deleted)      |                                |
|  | Storage Backend         [ ● Cloudflare R2 (Private Bucket) ]    |  (or Local Disk fallback)    |
|  | Database Engine         SQLite WAL Mode · 7/10 Emp · 2/2 Adm  |                                |
|  +---------------------------------------------------------------+                                |
|                                                                                                   |
|  +---------------------------------------------------------------+                                |
|  | ADMIN SECURITY & RECOVERY                                     |                                |
|  | Signed in as: tariq@company.com (Role: Admin)                 |                                |
|  | Server CLI password reset: npm run reset:password -- --email  |                                |
|  +---------------------------------------------------------------+                                |
+---------------------------------------------------------------------------------------------------+
```

---

## 4. Surface B: Employee Desktop App (`360×480` px + System Tray)

### 4.1 Window Geometry & Cross-Platform Context

- **Window Size**: Fixed compact `360px × 480px` (`minWidth: 360, minHeight: 480, resizable: false, maximizable: false`).
- **Target Platforms (64-bit Only)**:
  - Windows 10 / 11 (`x86_64`, `ARM64`) — WebView2 Edge rendering.
  - macOS (`ARM64` Apple Silicon + `x86_64` Intel) — WKWebView.
  - Linux (`x86_64`, `ARM64`) — WebKitGTK (X11 & Wayland).
- **Layout Density Rule**: Every primary element on the Main Tracker view fits inside `480px` height **without vertical scrolling** in normal state; conditional permission/offline banners use compact `36–44px` pills or expand gracefully with clean vertical scroll only when multiple alerts stack simultaneously.

---

### 4.2 Desktop Login Screen (`360×480`)

```text
+------------------------------------------+
|  SM Office Desk               [_]   [X]  |
+------------------------------------------+
|                                          |
|        [Logo]  SM Office Desk            |
|        Employee Work Tracker             |
|                                          |
|  +------------------------------------+  |
|  | [!] Invalid email or password      |  | <-- Shown on 401/403/network error
|  +------------------------------------+  |
|                                          |
|  Work Email                              |
|  [ nadia@company.com                  ]  |
|                                          |
|  Password                                |
|  [ •••••••••••••••             (Eye)  ]  |
|                                          |
|  v Server URL (Advanced)                 | <-- Collapsed by default if preconfigured
|  [ https://desk.company.com           ]  |
|                                          |
|  [             Sign In                ]  | <-- Full-width h-11 indigo-600
|                                          |
|------------------------------------------|
|  v1.0.0 · win-x64 · Device: dev_8f3a2c   |
+------------------------------------------+
```

**Desktop Login Edge Cases**:
- **Deactivated Account (`403`)**: Clear alert `"Account deactivated by admin. Contact your manager."`
- **Admin Role Guard (`403`)**: If an administrator attempts to sign in on the Desktop Tracker, display `"Admin accounts manage the team on the Web Dashboard."` (keeps tracker sessions strictly limited to employee accounts).
- **Preconfigured Server URL**: Collapsed behind `"Server Settings"` toggle if bundled with company URL; auto-expands with validation prompt if empty/unreachable.

---

### 4.3 Main Tracker Screen (`360×480`)

#### State 1: Active Tracking + Location ON + Connected
```text
+------------------------------------------+
|  SM Office Desk               [_]   [X]  |  <- 32px Title/Header (X minimizes to tray!)
+------------------------------------------+
|  Nadia Rahman        [● Connected]  [Out]|  <- Out disabled w/ tooltip while active
|  Senior Designer                         |
|------------------------------------------|
|  +------------------------------------+  |
|  |  ● TRACKING ACTIVE   [🔒 Dev Bound]|  |
|  |                                    |  |
|  |           02:14:38                 |  |  <- 36px font-mono tabular-nums
|  |      Today's Total: 05h 42m        |  |
|  |                                    |  |
|  |  [       ■ Stop Timer           ]  |  |  <- Rose-600 h-11 CTA
|  +------------------------------------+  |
|                                          |
|  +------------------------------------+  |
|  | [🛡🔒] Screenshot Auditing Active  |  |  <- bg-slate-900 text-slate-50
|  | Random (10–30m) & Admin on-demand  |  |     ZERO pause/disable/blur/delete UI!
|  | captures run while timer is active.|  |
|  +------------------------------------+  |
|                                          |
|  +------------------------------------+  |
|  | [📍] Share Live Location    [ ON ] |  |  <- Explicit employee consent switch
|  | Sharing while timer runs           |  |
|  | Source: OS Precise (±15m)          |  |  <- Or IP Approx (±5km) / Permission Needed
|  +------------------------------------+  |
|                                          |
|  Closing window minimizes to tray.       |  <- 24px subtle footer
+------------------------------------------+
```

#### State 2: Idle (Stopped) + Location OFF + Offline Retry Queue
```text
+------------------------------------------+
|  SM Office Desk               [_]   [X]  |
+------------------------------------------+
|  Nadia Rahman   [⚠ Offline: 3 queued][Out]|
|  Senior Designer                         |
|------------------------------------------|
|  +------------------------------------+  |
|  |  ○ TIMER STOPPED                   |  |
|  |                                    |  |
|  |           00:00:00                 |  |
|  |      Today's Total: 05h 42m        |  |
|  |                                    |  |
|  |  [       ▶ Start Timer          ]  |  |  <- Indigo-600 h-11 CTA
|  +------------------------------------+  |
|                                          |
|  +------------------------------------+  |
|  | [🛡] Screenshot Auditing Ready     |  |  <- Muted slate notice when stopped
|  | Captures run automatically only    |  |
|  | while your work timer is active.   |  |
|  +------------------------------------+  |
|                                          |
|  +------------------------------------+  |
|  | [⊘] Share Live Location    [ OFF ] |  |
|  | Disabled — Zero GPS coordinates or |  |
|  | IP location data are collected.    |  |
|  +------------------------------------+  |
|                                          |
|  3 encrypted captures queued — auto-syncs|  |  <- Offline queue indicator
+------------------------------------------+
```

#### Non-Negotiable Desktop UI Rules
1. **Zero Employee Screenshot Controls**: Inside both the `360×480` window and System Tray, there must be **zero** toggles, checkboxes, sliders, tray items, or context buttons to pause, delay, disable, blur, preview, or delete screenshots while tracking.
2. **Explicit Location Consent Wording**:
   - Toggle `OFF` (default on fresh install or persisted employee preference): `"Disabled — Zero GPS coordinates or IP location data are collected."`
   - Toggle `ON` while Timer Stopped: `"Enabled — Coordinates are transmitted only after you click Start Timer."`
   - Toggle `ON` while Timer Active: `"Sharing active · Source: OS Precise (±15m)"` or `"Sharing active · Source: IP Approx (±5km)"`.
   - Toggle works freely whether timer is Idle or Active; flipping `ON -> OFF` immediately sends a heartbeat with `{ location_enabled: false, lat: null, lng: null }` so the Admin map immediately switches the employee to `Disabled by Employee`.
3. **Logout Guard**: The `[Sign Out]` button is disabled (`aria-disabled="true"`) while the timer is active, displaying `"Stop timer before signing out"`.
4. **Window Close (`X`) Behavior**:
   - **While Timer is Stopped**: Exits app cleanly (terminates process).
   - **While Timer is Active**: Intercepts `CloseRequested`, hides window to System Tray (never stops timer silently!), and fires a first-time OS notification: `"SM Office Desk is still tracking (02:14:38) in the system tray."`

---

### 4.4 Desktop OS Permission, Offline & Force-Stop Edge Cases

These banners/overlays fit cleanly inside the `360×480` viewport:

| Edge Case | Visual Treatment (`360×480`) | User Action / Copy |
| :--- | :--- | :--- |
| **macOS Screen Recording TCC Missing** | Amber top alert card (`[AlertTriangle]`) | `"Screen Recording Permission Needed"` — `"Grant permission in System Settings > Privacy & Security > Screen Recording, then restart tracking."` + `[Open System Settings]` button. |
| **Linux Wayland Portal Setup** | Indigo/Amber prompt banner | `"Wayland Screen Capture Setup"` — `"Approve screen sharing in the system prompt so captures continue smoothly."` + `[Grant Screen Access]` button (saves `persist_mode=2` restore token). |
| **OS Location Permission Denied (while Toggle ON)** | Amber inline sub-card inside Location box | `"OS location denied. Allow access in OS Privacy Settings or use IP Approx fallback?"` + `[Enable IP Approx]` / `[Keep Disabled]` explicit consent prompt (never uses IP fallback silently without employee opt-in!). |
| **Offline Encrypted Retry Queue** | Orange/Amber status pill + footer line | `"Offline · 3 captures buffered locally (AES-GCM encrypted)"` — clears automatically when `201` upload ACKs complete on reconnect. |
| **`FORCE_STOP` (Admin Deactivated)** | Blocking full-card modal inside `360×480` | `"Account Deactivated"` — `"An administrator ended your session and deactivated your access at 14:35. Your logged hours remain saved."` + `[Return to Sign In]` button. |
| **`FORCE_STOP` (Session Override / Another Device)** | Blocking modal inside `360×480` | `"Session Stopped"` — `"Your timer was stopped because a new session started on another device."` + `[Dismiss]` button (returns to Idle state). |

---

### 4.5 System Tray Icon & Context Menu Wireframe

#### Tray Icon Variants (`16×16` / `22×22`, Template Monochrome on macOS + Status Dot)
- **Idle**: Slate/monochrome desk-clock glyph (`SM Office Desk — Idle`).
- **Active Tracking**: Desk-clock glyph with crisp `#10B981` emerald status dot (`SM Office Desk — Tracking 02:14:38`).
- **Offline Queue / Permission Warning**: Desk-clock glyph with `#F59E0B` amber status dot.

#### Native Context Menu Structure

```text
+---------------------------------------------+
|  ● Tracking: 02:14:38  (Today: 05h 42m)     |  <-- Disabled status header
|  🔒 Screenshot Auditing Active              |  <-- Disabled status indicator (when active)
|---------------------------------------------|
|  Open SM Office Desk                        |  <-- Restores & focuses 360x480 window
|  Stop Timer                                 |  <-- Or "Start Timer" when Idle
|  [✓] Share Live Location                    |  <-- Synced consent toggle (ON/OFF)
|---------------------------------------------|
|  Quit (Stop timer first)         [Disabled] |  <-- Disabled while active! Enabled as "Quit SM Office Desk" when Idle
+---------------------------------------------+
```

> **Ghost-Session Prevention**: Disabling `Quit` in the System Tray while the timer is active (alongside minimizing on `X`) prevents employees from accidentally killing the desktop daemon while leaving an open server work session.

---

## 5. Cross-Surface State Transition Matrices

### 5.1 Desktop Session & Window State Matrix

| Current State | User / System Event | Next State | API / WS Action | UI Visible Effect |
| :--- | :--- | :--- | :--- | :--- |
| `Idle (Window Open)` | Clicks `Start Timer` | `Starting -> Active` | `POST /api/tracker/sessions/start` + WS `auth` | Timer ticks `00:00:01`; dark `Screenshot Auditing Active` banner locks in; Tray icon turns green |
| `Active (Window Open)` | Clicks `X` (Close button) | `Active (Tray Minimized)` | None (heartbeat `60s` & random `10–30m` continue) | Window hides; first-time OS toast `"Still tracking in system tray"` |
| `Active (Tray Minimized)` | Clicks `Open SM Office Desk` in Tray | `Active (Window Open)` | None | `360×480` window restores & focuses |
| `Active` | Network drops | `Active (Offline Buffer)` | Heartbeat queues/retries; screenshots AES-GCM encrypted to disk | Header pill switches to `Offline (N queued)` amber/orange |
| `Active (Offline Buffer)` | Network restores | `Active` | Flushes queued screenshots -> HTTP `201` wipes local files; WS reconnects | Queue count drops to `0`, pill turns `Connected` green |
| `Active` | OS locks screen (`Win+L` / Sleep) | `Active (Screen Locked)` | Heartbeat / Capture sends `capture_status: "screen_locked"` | Admin card flips to `Screen Locked`; Desktop stays active until user unlocks or stops (or 180s sleep timeout closes session cleanly) |
| `Active` | Clicks `Stop Timer` | `Idle` | `POST /api/tracker/sessions/stop` | Timer resets to `00:00:00`, Today's Total increments, Tray `Quit` unlocks |
| `Active` | Server sends `FORCE_STOP` (deactivated) | `Signed Out (Alert)` | WS closes (`token_version` invalid), local timer stops | Blocking modal `"Account Deactivated"` + OS notification |

### 5.2 Live Location Consent State Matrix

| Desktop Toggle | Timer State | OS Permission / Fallback | Desktop UI Subtext | Data Transmitted (`60s` Heartbeat) | Admin Dashboard & Leaflet Map |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `OFF` | Any | N/A | `"Disabled — Zero GPS or IP location collected."` | `{ location_enabled: false, lat: null, lng: null }` | Badge: `Disabled by Employee`; excluded from map pins; shown in privacy list |
| `ON` | `Stopped` | Ready | `"Enabled — Coordinates share only while timer runs."` | None (no active session) | Badge: `Offline` (no coordinates stored) |
| `ON` | `Active` | OS Native Granted | `"Sharing active · Source: OS Precise (±15m)"` | `{ location_enabled: true, lat, lng, accuracy_meters, source: "os_native" }` | Teal pin + solid `L.circle` + badge `OS Precise (±15m)` |
| `ON` | `Active` | OS Denied + User Opted Into IP Fallback | `"Sharing active · Source: IP Approx (±5km)"` | `{ location_enabled: true, lat, lng, accuracy_meters, source: "ip_approx" }` | Sky pin + dashed `L.circle` + badge `IP Approx (±5km)` |
| `ON` | `Active` | OS Denied + Declined IP Fallback | `"Location permission needed"` | `{ location_enabled: false, lat: null, lng: null }` | Badge: `Disabled by Employee` (never silently falls back!) |

### 5.3 Employee & Admin Quota Lifecycle Matrix

| Action | Pre-condition | Result | UI Feedback |
| :--- | :--- | :--- | :--- |
| Register Employee | `activeEmployees < 10` | `201 Created`, slot meter increments | Modal closes, table updates, slot bar updates (`7/10 -> 8/10`) |
| Register Employee | `activeEmployees === 10` | Button disabled in UI; API `409 MAX_EMPLOYEES_EXCEEDED` | Disabled CTA + helper `"Maximum 10 active slots reached"` |
| Deactivate Employee | Employee `is_active = 1` | `200 OK`, `token_version++`, WS `FORCE_STOP`, slot freed | Safe confirmation modal closes, row moves to `Deactivated` tab, slot drops (`8/10 -> 7/10`) |
| Reactivate Employee | `activeEmployees === 10` | Button disabled in UI; API `409` | Tooltip `"Free a slot before reactivating"` |
| Add Admin | `activeAdmins === 2` | Button disabled in UI; API `409 MAX_ADMINS_EXCEEDED` | Badge `"2 / 2 Active Admins — Limit Reached"` |
| Deactivate Last Admin | `activeAdmins === 1` | Button strictly disabled in UI; API `409 CANNOT_DISABLE_LAST_ADMIN` | Lock tooltip `"Cannot deactivate sole remaining active admin"` |

---

## 6. Accessibility (WCAG 2.1 AA), Keyboard Navigation & Performance Guidelines

### 6.1 Keyboard Navigation & Focus Management

1. **Visible Focus Rings**: Apply `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2` globally to every interactive button, link, checkbox, switch, and card preview trigger.
2. **Modals & Lightbox (`role="dialog"` / `role="alertdialog"`, `aria-modal="true"`)**:
   - Focus moves into modal on open (default focus on safe `[Cancel]` button in destructive Delete/Deactivate dialogs!).
   - `Tab` / `Shift+Tab` is trapped inside open modals.
   - `Escape` closes Lightbox and non-blocking modals; returns focus to the triggering card/button on close.
   - Lightbox supports `ArrowLeft` (previous capture) and `ArrowRight` (next capture).
3. **Desktop Toggle Switch**: Uses `<button role="switch" aria-checked={locationEnabled}>` (`Space` or `Enter` toggles cleanly).
4. **Leaflet Map Keyboard Accessibility**: Provide the `"Focus on Map"` buttons inside the accessible Employee Live Cards and a keyboard-navigable `"Location Summary"` list below the map so keyboard/screen-reader users never depend solely on mouse canvas dragging.

### 6.2 ARIA Live Regions & Screen Reader Announcements

- **`aria-live="polite"`** (non-interrupting status updates):
  - Admin `Take Screenshot Now` transitions (`"Capturing screenshot for Nadia Rahman"`, `"Screenshot ready"`).
  - Admin WebSocket connection changes (`"Live connection restored"`).
  - Gallery bulk selection count changes (`"4 screenshots selected"`).
  - Desktop `Share Live Location` state change (`"Live location sharing enabled"`).
- **`aria-live="assertive"`** (urgent alerts):
  - Login errors & `429` rate limits.
  - `Capture Timeout (15s)` or `Offline` warning.
  - Desktop `FORCE_STOP` / Account Deactivation modal.
  - Quota limit rejection (`MAX_EMPLOYEES_EXCEEDED`).

### 6.3 Reduced Motion & Performance Targets

- **Reduced Motion (`@media (prefers-reduced-motion: reduce)`)**: Disable pulsing animation on the `Active` green status dot (`motion-safe:animate-pulse`) and replace modal scale/slide transitions with instant opacity transitions.
- **Image Loading**: Admin Gallery uses `loading="lazy" decoding="async"` directly on WebP previews with explicit `aspect-video` container boxes (`bg-slate-200`) to guarantee **zero Cumulative Layout Shift (CLS = 0)**.
- **Desktop RAM Budget (`<70 MB`)**: Keep Desktop React bundle ultra-minimal — no Leaflet, no heavy chart libraries, no animation frameworks; use native CSS transitions + lightweight `lucide-react` tree-shaken icons only.
- **Admin Print Optimization**: Dedicated `@media print` rules inside `/salary` ensure zero wasted ink, clean page breaks (`break-inside-avoid`), and clear tabular alignment for monthly payroll PDFs.

---

## 7. Implementation Checklist for Downstream Agents

- **`coding-agent` (`admin-web`)**:
  - Implement shared Tailwind color/typography tokens (`tabular-nums` mandatory on timers/currency/counts).
  - Enforce `Take Screenshot Now` 15s timeout + 5s per-employee cooldown state machine; never add a bulk "Capture All" button.
  - Configure Leaflet with OSM tiles, `L.circle` accuracy rings, zoom bounds on marker centers, and explicit `Location Disabled by Employee` privacy list.
  - Group Gallery strictly by `Company Timezone` (`Employee -> Date -> Time`) with `Screen Locked` non-image cards, Lightbox, `Expires in Xd` badges, and Single/Bulk Delete confirmation modals.
  - Implement `X / 10` Employee slots meter, safe Deactivation modal, `Y / 2` Admin guard, Salary Report rate-snapshot creation/edit + CSV/Print, and read-only `90 Days` Retention + Storage Driver status on Settings.
- **`desktop-app-agent` (`desktop-ui` + `src-tauri`)**:
  - Enforce fixed `360×480` window dimensions and close-to-tray behavior while timer is active (with first-time OS notification).
  - Render non-removable `Screenshot Auditing Active` lock card with **zero** pause/disable/delay/blur/delete controls.
  - Implement accessible `Share Live Location` consent switch (`OFF` = zero coordinates & explicit opt-in for IP fallback if OS native fails).
  - Disable Tray `Quit` (`Quit (Stop timer first)`) while timer is active and handle `FORCE_STOP` + OS permission prompts cleanly.
