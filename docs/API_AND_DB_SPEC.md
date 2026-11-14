# SM Office Desk — API, WebSocket, Storage & Database Specification

> **Document Status**: Phase 1 Architecture Specification (Authoritative Contract)  
> **Target Runtime**: Node.js 22 LTS (`node:22-bookworm-slim`), Fastify v5, SQLite WAL (`better-sqlite3` + Drizzle ORM), Cloudflare R2 (`@aws-sdk/client-s3`) / Local Disk Fallback, Tauri v2 Desktop (64-bit `x86_64` & `arm64` only).

---

## 1. Architectural Invariants & Non-Negotiable Rules

1. **Scale Caps & Admin Availability**:
   - Maximum **10 active employees** (`role = 'employee' AND is_active = 1`).
   - Maximum **2 active admins** (`role = 'admin' AND is_active = 1`).
   - Minimum **1 active admin** at all times (impossible to deactivate, demote, or delete the last active admin).
   - Enforced at **both** backend API validation and atomic SQLite `BEFORE INSERT` / `BEFORE UPDATE` / `BEFORE DELETE` triggers.
2. **64-Bit Desktop Architecture Only**:
   - Desktop tracker sessions and WebSocket connections accept ONLY `device_arch: "x86_64" | "arm64"` across `"windows" | "macos" | "linux"`. Any 32-bit identifier (`i686`, `x86`, `ia32`) is rejected with `400 UNSUPPORTED_ARCHITECTURE`.
3. **1 Active Session Per Employee (`device_id` bound)**:
   - Enforced atomically via SQLite partial unique index `idx_one_active_session ON work_sessions(employee_id) WHERE status = 'active'`.
   - Heartbeats occur every **60 seconds**; sessions silent for **>180 seconds** are automatically transitioned to `stopped` by the server sweeper with `ended_at = last_heartbeat_at`.
4. **Screenshot Lock Policy**:
   - Once tracking starts, the employee has zero controls to pause, disable, delay, blur, or delete screenshots.
   - Desktop uses monotonic timers (`std::time::Instant`) for **10–30 minute (`600–1800s`)** randomized intervals plus WebSocket `CAPTURE_NOW`.
   - Client resizes/stitches active monitors (`<= 1440px`, or `<= 1600px` for multi-ultrawide) to WebP `q=70` (`<= 512 KB` upload limit; typical `60–110 KB`).
   - OS lock screen / sleep sends `capture_status = "screen_locked"` without uploading blank frames.
5. **Strict Live Location Consent Policy**:
   - Coordinates are collected and sent ONLY when employee toggle `Share Live Location` is `ON` (`location_enabled = true`) and the tracker is active.
   - When `location_enabled = false`, client sends `latitude: null, longitude: null, accuracy_meters: null, location_source: "disabled"`. **Server-side IP geolocation fallback is strictly forbidden** (enforced by API validation and a SQLite `CHECK` constraint).
6. **Private Image Serving & Instant Revocation**:
   - No raw storage URLs or directories are ever publicly readable.
   - Every REST and WebSocket request validates `is_active === 1` and `jwt.tv === user.token_version`. Deactivating or modifying credentials increments `token_version`, revoking access immediately.
7. **UTC Storage & Company Timezone Partitioning**:
   - All DB timestamps are UTC ISO-8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`).
   - Storage keys (`<tz_YYYY>/<MM>/<DD>/emp_<id>/<unix_ms>_<rand6>_<type>.webp`), Admin Date/Hour screenshot filters, and Salary Report monthly periods are computed in `app_settings.company_timezone` (default `Asia/Dhaka`).
8. **90-Day Lifecycle**:
   - Both `screenshots` and `location_logs` expire after `app_settings.retention_days` (default `90`), purged daily at `02:00 UTC`.

---

## 2. Unified Error Response Envelope & Status Mapping

All non-2xx API responses MUST use the unified JSON error envelope:

```json
{
  "error": {
    "code": "STRING_SCREAMING_SNAKE_CASE",
    "message": "Human-readable error summary",
    "details": {}
  }
}
```

(`details` is optional and omitted when there is no structured context.)

### Canonical Error Codes

| HTTP Status | Error Code | Trigger / Condition |
| :--- | :--- | :--- |
| `400` | `VALIDATION_ERROR` | Zod schema or query/path parameter failure (`details.fieldErrors`) |
| `400` | `UNSUPPORTED_ARCHITECTURE` | Desktop `device_arch` is not `x86_64` or `arm64` |
| `400` | `LOCATION_CONSENT_VIOLATION` | `location_enabled = false` with non-null coords, or missing coords/invalid source |
| `400` | `INVALID_SCREENSHOT_PAYLOAD` | Missing WebP on `capture_status = "ok"`, invalid WebP magic bytes, or invalid `request_id` |
| `401` | `INVALID_CREDENTIALS` | Wrong email or password on login |
| `401` | `UNAUTHORIZED` | Missing, malformed, or expired access/refresh JWT |
| `401` | `TOKEN_REVOKED` | JWT `tv` != DB `token_version` or user deactivated (`is_active = 0`) |
| `403` | `FORBIDDEN` | Role mismatch (e.g., employee calling `/api/admin/*` or admin calling `/api/tracker/*`) |
| `403` | `ACCOUNT_DISABLED` | Inactive account attempting login |
| `404` | `NOT_FOUND` | Target user, screenshot, session, or salary report does not exist |
| `404` | `SCREENSHOT_NO_IMAGE` | Requested `/image` for a `screen_locked` metadata record |
| `409` | `MAX_EMPLOYEES_EXCEEDED` | SQLite trigger `MAX_EMPLOYEES_EXCEEDED` or pre-check (>10 active employees) |
| `409` | `MAX_ADMINS_EXCEEDED` | SQLite trigger `MAX_ADMINS_EXCEEDED` or pre-check (>2 active admins) |
| `409` | `CANNOT_DISABLE_LAST_ADMIN` | SQLite trigger `CANNOT_DISABLE_LAST_ADMIN` (disable/demote/delete last active admin) |
| `409` | `SELF_ADMIN_LOCKOUT` | Admin attempted to deactivate or demote their own currently authenticated account |
| `409` | `EMAIL_ALREADY_EXISTS` | Unique constraint violation on `users.email` |
| `409` | `ACTIVE_SESSION_CONFLICT` | Employee already has an active session on another `device_id` (`override_existing = false`) |
| `409` | `SESSION_NOT_ACTIVE` | Heartbeat sent for an already stopped/timed-out session |
| `409` | `EMPLOYEE_OFFLINE` | `capture-now` requested for employee without active session / active WS connection |
| `409` | `CAPTURE_IN_PROGRESS` | Another `capture-now` for that employee is currently pending |
| `409` | `SALARY_REPORT_EXISTS` | Duplicate `(employee_id, report_month)` |
| `409` | `SALARY_REPORT_PAID_LOCKED` | Attempted delete or financial edit of a `paid` salary report |
| `413` | `PAYLOAD_TOO_LARGE` | Uploaded WebP exceeds `512 KB` (`524288` bytes) |
| `429` | `CAPTURE_COOLDOWN` | `capture-now` called within 5s cooldown for the same employee (`Retry-After` header included) |
| `500` | `INTERNAL_ERROR` | Unhandled server or storage error |
| `503` | `SERVICE_UNAVAILABLE` | Health check failure (DB or storage unreachable) |

### SQLite Trigger & Constraint Error Mapping

When `better-sqlite3` throws `SqliteError`:
- If `err.message.includes('MAX_EMPLOYEES_EXCEEDED')` -> `409 MAX_EMPLOYEES_EXCEEDED`
- If `err.message.includes('MAX_ADMINS_EXCEEDED')` -> `409 MAX_ADMINS_EXCEEDED`
- If `err.message.includes('CANNOT_DISABLE_LAST_ADMIN')` -> `409 CANNOT_DISABLE_LAST_ADMIN`
- If `err.code === 'SQLITE_CONSTRAINT_UNIQUE'` and message references `users.email` -> `409 EMAIL_ALREADY_EXISTS`
- If `err.code === 'SQLITE_CONSTRAINT_UNIQUE'` and message references `idx_one_active_session` -> `409 ACTIVE_SESSION_CONFLICT`
- If `err.code === 'SQLITE_CONSTRAINT_UNIQUE'` and message references `idx_salary_reports_emp_month` -> `409 SALARY_REPORT_EXISTS`

---

## 3. Authentication, RBAC & Admin Account Lifecycle

### Password Hashing & JWT Tokens
- **Password Hashing**: Node.js built-in `crypto.scrypt` (`N=16384, r=8, p=1`, 16-byte random salt, 64-byte derived key, stored as `scrypt$16384$8$1$<salt_hex>$<hash_hex>`, verified with `crypto.timingSafeEqual`) — zero C++ native addon risk on `node:22-bookworm-slim` — or Argon2id (`@node-rs/argon2`).
- **Access JWT** (`JWT_ACCESS_TTL_SECONDS`, default `900` = 15 min):
  ```json
  {
    "sub": 1,
    "role": "admin",
    "tv": 1,
    "type": "access",
    "jti": "uuid-v4",
    "iat": 1763118000,
    "exp": 1763118900
  }
  ```
- **Refresh JWT** (`JWT_REFRESH_TTL_SECONDS`, default `2592000` = 30 days):
  Same claims with `"type": "refresh"`.
- **Auth Middleware**:
  On every protected REST call and WebSocket handshake:
  1. Verify JWT HMAC-SHA256 signature and `exp`, and `type === "access"`.
  2. Query `SELECT id, role, is_active, token_version FROM users WHERE id = ?`.
  3. Reject with `401 TOKEN_REVOKED` if row missing, `user.is_active !== 1`, or `payload.tv !== user.token_version`.
  4. Verify route role (`admin` vs `employee`).

### 1st Admin Seed & 2nd Admin Management Workflow
1. **Initial Bootstrap (`npm run seed:admin`)**:
   - Checks `SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`.
   - Aborts immediately if `count > 0` (prevents unauthorized admin injection after setup).
   - Accepts CLI flags/env/interactive prompt (`name`, `email`, `password` >= 8 chars) and inserts the 1st active admin (`role = 'admin'`, `is_active = 1`, `salary_type = 'monthly'`, `base_salary = 0`).
2. **Creating the 2nd Admin (via Role-Aware Admin API)**:
   - Admin #1 logs into the Admin Web Dashboard -> **Settings / Admin Accounts** -> submits **Add Admin**, calling `POST /api/admin/employees` with `"role": "admin"`.
   - API + SQLite `trg_limit_admins_insert` enforce `active admins <= 2` (`409 MAX_ADMINS_EXCEEDED` on a 3rd active admin).
3. **Managing / Deactivating Admins (`PATCH /api/admin/employees/:id`)**:
   - An active admin may deactivate or update the *other* admin (`is_active: false`, password reset, name update).
   - Self-deactivation or self-demotion (`actor.id === target.id` when `is_active === false` or `role === "employee"`) is rejected by API (`409 SELF_ADMIN_LOCKOUT`).
   - Deactivating, demoting (`role -> "employee"`), or deleting the sole remaining active admin is blocked by SQLite triggers `trg_prevent_last_admin_disable` and `trg_prevent_last_admin_delete` (`409 CANNOT_DISABLE_LAST_ADMIN`).
   - Inactive admins do not count toward the active limit of 2, but reactivating an inactive admin when 2 active admins already exist is blocked by `trg_limit_admins_update`.
4. **Password Recovery (`npm run reset:password -- --email=<email>`)**:
   - CLI updates `password_hash` and increments `token_version = token_version + 1` in SQLite so all active tokens for that user are revoked.

---

## 4. REST API Contract

**Base URL**: `/api`  
**Content-Type**: `application/json` (except `POST /api/tracker/screenshots` which uses `multipart/form-data`, `GET /api/admin/screenshots/:id/image` which streams `image/webp` or redirects `302`, and `GET /api/admin/salary-reports/export` which returns `text/csv`).

### 4.1 Health & Auth

#### `GET /api/health`
- **Auth**: Public
- **Behavior**: Executes `SELECT 1` on SQLite and verifies storage driver configuration/writability (`StorageDriver.healthCheck()`). Does not expose secrets or filesystem paths.
- **Response `200 OK`**:
  ```json
  {
    "status": "ok",
    "timestamp": "2026-11-14T11:10:00.000Z",
    "version": "1.0.0",
    "uptime_seconds": 3621,
    "db": "ok",
    "storage_driver": "r2"
  }
  ```
- **Response `503 Service Unavailable`**:
  ```json
  {
    "error": {
      "code": "SERVICE_UNAVAILABLE",
      "message": "Database health check failed"
    }
  }
  ```

#### `POST /api/auth/login`
- **Auth**: Public
- **Request Body**:
  ```json
  {
    "email": "string (email, trimmed lowercase)",
    "password": "string (min 1, max 128)",
    "client_type": "admin_web | desktop (default: admin_web)",
    "device_id": "string? (required if client_type = desktop, 1..128 chars)",
    "device_arch": "x86_64 | arm64? (required if client_type = desktop)"
  }
  ```
- **Rules**:
  - If `client_type === "desktop"`, `user.role` MUST be `"employee"` (rejects admin accounts with `403 FORBIDDEN`) and `device_arch` MUST be `"x86_64"` or `"arm64"` (`400 UNSUPPORTED_ARCHITECTURE`).
  - If `client_type === "admin_web"`, `user.role` MUST be `"admin"` (rejects employee accounts with `403 FORBIDDEN`).
  - If `user.is_active === 0` after valid password check, returns `403 ACCOUNT_DISABLED`.
- **Response `200 OK`**:
  ```json
  {
    "access_token": "jwt...",
    "refresh_token": "jwt...",
    "expires_in_seconds": 900,
    "user": {
      "id": 2,
      "name": "Rahim Ahmed",
      "email": "rahim@company.com",
      "role": "employee",
      "designation": "Software Engineer",
      "salary_type": "monthly",
      "base_salary": 45000,
      "is_active": true,
      "created_at": "2026-11-01T08:00:00.000Z",
      "updated_at": "2026-11-01T08:00:00.000Z"
    }
  }
  ```
- **Errors**: `400 VALIDATION_ERROR`, `400 UNSUPPORTED_ARCHITECTURE`, `401 INVALID_CREDENTIALS`, `403 ACCOUNT_DISABLED`, `403 FORBIDDEN`.

#### `POST /api/auth/refresh`
- **Auth**: Public (Refresh JWT in body)
- **Request Body**:
  ```json
  {
    "refresh_token": "string (non-empty JWT)"
  }
  ```
- **Behavior**: Verifies JWT signature, `type === "refresh"`, DB `is_active === 1`, and `payload.tv === user.token_version`. Issues fresh access & refresh tokens with current `token_version`.
- **Response `200 OK`**: Same shape as `POST /api/auth/login`.
- **Errors**: `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `401 TOKEN_REVOKED`.

#### `POST /api/auth/logout`
- **Auth**: Authenticated (`admin` or `employee`)
- **Request Body** (optional `{}`):
  ```json
  {
    "all_devices": "boolean (default: true)",
    "device_id": "string?"
  }
  ```
- **Behavior**:
  - If user is `employee` and has an active `work_sessions` row (matching `device_id` if provided, or any active session if `all_devices`), transitions the session to `stopped` (`ended_at = UTC_NOW()`), updates `duration_seconds`, and broadcasts `employee_status` (`is_online: false`) to Admins.
  - When `all_devices` is `true` (default), increments `users.token_version = token_version + 1` in SQLite and disconnects active WebSocket sessions for that user so both access and refresh tokens are invalidated immediately.
- **Response `200 OK`**:
  ```json
  {
    "logged_out": true
  }
  ```

#### `GET /api/auth/me`
- **Auth**: Authenticated (`admin` or `employee`)
- **Response `200 OK`**:
  ```json
  {
    "user": { "...PublicUser..." },
    "company": {
      "company_name": "SM Office",
      "company_timezone": "Asia/Dhaka",
      "currency_code": "BDT",
      "retention_days": 90
    },
    "active_session": {
      "id": "uuid",
      "employee_id": 2,
      "device_id": "dev_...",
      "started_at": "2026-11-14T03:00:00.000Z",
      "ended_at": null,
      "last_heartbeat_at": "2026-11-14T09:12:00.000Z",
      "duration_seconds": 22320,
      "device_os": "linux",
      "device_arch": "x86_64",
      "app_version": "1.0.0",
      "status": "active"
    }
  }
  ```
  (`active_session` is `null` if no active session exists or if `user.role === "admin"`.)

---

### 4.2 Admin — Employees & Admins

#### `GET /api/admin/employees`
- **Auth**: `admin`
- **Query Params**:
  - `role`: `"employee" | "admin" | "all"` (default `"employee"`)
  - `status`: `"active" | "inactive" | "all"` (default `"all"`)
  - `search`: `string?` (matches `name`, `email`, or `designation` case-insensitively)
- **Response `200 OK`**:
  ```json
  {
    "quotas": {
      "active_employees": 6,
      "max_active_employees": 10,
      "active_admins": 1,
      "max_active_admins": 2
    },
    "users": [
      {
        "id": 2,
        "name": "Rahim Ahmed",
        "email": "rahim@company.com",
        "role": "employee",
        "designation": "Backend Developer",
        "salary_type": "monthly",
        "base_salary": 45000,
        "is_active": true,
        "created_at": "2026-11-01T08:00:00.000Z",
        "updated_at": "2026-11-01T08:00:00.000Z",
        "live_status": {
          "is_online": true,
          "ws_connected": true,
          "session_id": "sess_uuid",
          "device_id": "dev_uuid",
          "device_os": "windows",
          "device_arch": "x86_64",
          "app_version": "1.0.0",
          "started_at": "2026-11-14T03:00:00.000Z",
          "last_heartbeat_at": "2026-11-14T09:12:00.000Z",
          "screen_locked": false,
          "location_enabled": false
        }
      }
    ]
  }
  ```

#### `POST /api/admin/employees`
- **Auth**: `admin`
- **Request Body**:
  ```json
  {
    "name": "string (min 2, max 100)",
    "email": "string (email, max 160)",
    "password": "string (min 8, max 128)",
    "role": "employee | admin (default: employee)",
    "designation": "string (max 100, default: '')",
    "salary_type": "monthly | hourly (default: monthly)",
    "base_salary": "number (>= 0, default: 0)",
    "is_active": "boolean (default: true)"
  }
  ```
- **Behavior**:
  - Inserts user into `users` inside transaction (atomic SQLite triggers `trg_limit_employees_insert` / `trg_limit_admins_insert` enforce max 10 active employees / max 2 active admins).
  - Writes `audit_logs` entry (`action: "USER_CREATED"`, `target_type: "user"`).
- **Response `201 Created`**:
  ```json
  {
    "user": { "...PublicUser..." },
    "quotas": {
      "active_employees": 7,
      "max_active_employees": 10,
      "active_admins": 1,
      "max_active_admins": 2
    }
  }
  ```
- **Errors**: `400 VALIDATION_ERROR`, `409 EMAIL_ALREADY_EXISTS`, `409 MAX_EMPLOYEES_EXCEEDED`, `409 MAX_ADMINS_EXCEEDED`.

#### `PATCH /api/admin/employees/:id`
- **Auth**: `admin`
- **Path Param**: `id` (positive integer)
- **Request Body** (at least 1 property required):
  ```json
  {
    "name": "string? (min 2, max 100)",
    "email": "string? (email, max 160)",
    "password": "string? (min 8, max 128)",
    "role": "employee | admin?",
    "designation": "string? (max 100)",
    "salary_type": "monthly | hourly?",
    "base_salary": "number? (>= 0)",
    "is_active": "boolean?"
  }
  ```
- **Behavior**:
  - Blocks self-deactivation or self-demotion (`id === actor.id` and (`is_active === false` or `role === "employee"`)) -> `409 SELF_ADMIN_LOCKOUT`.
  - Runs inside SQLite `IMMEDIATE` transaction; triggers enforce max 10 active employees, max 2 active admins, and `CANNOT_DISABLE_LAST_ADMIN`.
  - If `is_active` transitions `true -> false`, `role` changes, or `password` changes: increments `token_version = token_version + 1`.
  - If target has an active `work_sessions` row and (`is_active === false` or `role === "admin"`): sets session `status = 'stopped'`, `ended_at = UTC_NOW()`, `duration_seconds`, sends WS `FORCE_STOP`, closes desktop WS socket, and notifies Admin WS clients via `employee_status`.
  - Writes `audit_logs` entry (`USER_UPDATED`, `USER_DEACTIVATED`, `USER_REACTIVATED`, `USER_ROLE_CHANGED`, or `USER_PASSWORD_RESET`).
- **Response `200 OK`**:
  ```json
  {
    "user": { "...PublicUser..." },
    "quotas": { "...QuotaSummary..." }
  }
  ```
- **Errors**: `400 VALIDATION_ERROR`, `404 NOT_FOUND`, `409 EMAIL_ALREADY_EXISTS`, `409 MAX_EMPLOYEES_EXCEEDED`, `409 MAX_ADMINS_EXCEEDED`, `409 CANNOT_DISABLE_LAST_ADMIN`, `409 SELF_ADMIN_LOCKOUT`.

---

### 4.3 Employee Desktop — Sessions & Uploads

#### `POST /api/tracker/sessions/start`
- **Auth**: `employee`
- **Request Body**:
  ```json
  {
    "device_id": "string (min 4, max 128)",
    "device_os": "windows | macos | linux",
    "device_arch": "x86_64 | arm64",
    "app_version": "string (min 1, max 32)",
    "override_existing": "boolean (default: false)"
  }
  ```
- **Behavior**:
  - Rejects non-64-bit `device_arch` (`400 UNSUPPORTED_ARCHITECTURE`).
  - Inside SQLite `IMMEDIATE` transaction, checks active `work_sessions` for `employee_id`:
    - If active session exists and `now - last_heartbeat_at > 180s` (stale): closes stale session with `ended_at = last_heartbeat_at`, `duration_seconds`, `status = 'stopped'`, then proceeds to create new active session.
    - If active non-stale session exists on **same `device_id`**: returns `200 OK` with existing session (idempotent reconnect).
    - If active non-stale session exists on **different `device_id`** and `override_existing === false`: returns `409 ACTIVE_SESSION_CONFLICT` with `details: { active_session_id, active_device_id, active_device_os, started_at }`.
    - If active non-stale session exists on **different `device_id`** and `override_existing === true`: stops previous session (`ended_at = UTC_NOW()`), inserts new session (`idx_one_active_session` guarantees atomicity), dispatches WS `FORCE_STOP` (`reason: "session_overridden"`) to the previous `device_id` socket, and broadcasts `employee_status` to Admins.
- **Response `201 Created` (or `200 OK` on idempotent same-device resume)**:
  ```json
  {
    "session": {
      "id": "uuid-v4",
      "employee_id": 2,
      "device_id": "dev_abc123",
      "started_at": "2026-11-14T03:00:00.000Z",
      "ended_at": null,
      "last_heartbeat_at": "2026-11-14T03:00:00.000Z",
      "duration_seconds": 0,
      "device_os": "linux",
      "device_arch": "x86_64",
      "app_version": "1.0.0",
      "status": "active"
    },
    "server_time_utc": "2026-11-14T03:00:00.000Z",
    "config": {
      "heartbeat_interval_seconds": 60,
      "random_capture_min_seconds": 600,
      "random_capture_max_seconds": 1800,
      "max_screenshot_width_px": 1440,
      "max_ultrawide_screenshot_width_px": 1600,
      "webp_quality": 70
    }
  }
  ```

#### `POST /api/tracker/sessions/heartbeat`
- **Auth**: `employee`
- **Request Body**:
  ```json
  {
    "session_id": "string (uuid)",
    "screen_locked": "boolean (default: false)",
    "location_enabled": "boolean",
    "latitude": "number? | null (-90..90)",
    "longitude": "number? | null (-180..180)",
    "accuracy_meters": "number? | null (>= 0)",
    "location_source": "os_native | ip_approx | disabled"
  }
  ```
- **Strict Location Privacy Rules**:
  - When `location_enabled === false`:
    - `latitude`, `longitude`, and `accuracy_meters` MUST be `null` (or omitted), and `location_source` MUST be `"disabled"`. Otherwise reject `400 LOCATION_CONSENT_VIOLATION`.
    - **Server-side IP geolocation lookup is strictly forbidden.**
    - Server records a `location_logs` entry (`location_enabled: 0, latitude: null, longitude: null, accuracy_meters: null, source: "disabled"`) whenever the employee's latest recorded location state was not already `"disabled"`, keeping `expires_at = UTC_NOW() + retention_days`.
  - When `location_enabled === true`:
    - `location_source` MUST be `"os_native"` or `"ip_approx"`.
    - If coordinates are provided (`latitude !== null && longitude !== null`), both must be finite valid bounds and inserted into `location_logs` with `expires_at = UTC_NOW() + retention_days`.
    - If coordinates are transiently unavailable (`null` while `location_enabled === true`), heartbeat still succeeds without recording invalid `(0, 0)` coordinates.
- **Session Update**:
  - Verifies `work_sessions.id === session_id`, `employee_id === auth.user.id`, and `status === "active"`. If already `"stopped"`, returns `409 SESSION_NOT_ACTIVE`.
  - Updates `last_heartbeat_at = UTC_NOW()` and `duration_seconds = max(0, floor((now - started_at) / 1000))`.
  - Updates in-memory `screen_locked` / `location_enabled` presence state and broadcasts `employee_status` / `location_update` to Admin WS clients.
- **Response `200 OK`**:
  ```json
  {
    "session_id": "uuid-v4",
    "status": "active",
    "server_time_utc": "2026-11-14T03:05:00.000Z",
    "last_heartbeat_at": "2026-11-14T03:05:00.000Z",
    "duration_seconds": 300
  }
  ```

#### `POST /api/tracker/sessions/stop`
- **Auth**: `employee`
- **Request Body**:
  ```json
  {
    "session_id": "string (uuid)",
    "reason": "user_stop | app_quit | system_shutdown (default: user_stop)"
  }
  ```
- **Behavior**:
  - Verifies session ownership (`404` if not found / belongs to another user).
  - If `status === "active"`, sets `status = "stopped"`, `ended_at = UTC_NOW()`, computes `duration_seconds`, clears active desktop presence state, and broadcasts `employee_status` (`is_online: false`) to Admins.
  - Idempotent if session is already `"stopped"`.
- **Response `200 OK`**:
  ```json
  {
    "session": { "...WorkSession (status: stopped)..." }
  }
  ```

#### `POST /api/tracker/screenshots`
- **Auth**: `employee`
- **Content-Type**: `multipart/form-data` (max file size `512 KB = 524288 bytes`)
- **Multipart Form Fields**:
  - `session_id`: `string (uuid)` (must exist and belong to authenticated employee; `stopped` sessions are still accepted so encrypted offline retry queues can flush cleanly after reconnect!)
  - `capture_type`: `"random" | "on_demand"`
  - `capture_status`: `"ok" | "screen_locked"`
  - `request_id`: `string?` (required when `capture_type === "on_demand"`; must be omitted/empty when `"random"`)
  - `monitor_count`: `integer` (`>= 1` when `ok`, `>= 0` when `screen_locked`)
  - `width`: `integer` (`1..3840` when `ok`, `0` when `screen_locked`)
  - `height`: `integer` (`1..4320` when `ok`, `0` when `screen_locked`)
  - `captured_at_client_monotonic_ms`: `integer >= 0` (client monotonic offset/audit telemetry; **server uses authoritative `UTC_NOW()` for `captured_at` and `expires_at`**)
  - `file`: binary WebP image part (REQUIRED and non-empty when `capture_status === "ok"`, validated via `RIFF....WEBP` magic header bytes `[0..3] === "RIFF"` & `[8..11] === "WEBP"`, `<= 524288` bytes; OMITTED or zero-byte when `capture_status === "screen_locked"`).
- **Behavior**:
  1. Look up `app_settings` (`company_timezone`, `retention_days`).
  2. Set authoritative `capturedAt = new Date()` (UTC ISO-8601) and `expiresAt = capturedAt + retention_days`.
  3. If `capture_status === "ok"`:
     - Generate key via `generateScreenshotStorageKey({ employeeId, captureType, capturedAt, companyTimezone })`:
       `<tz_YYYY>/<MM>/<DD>/emp_<id>/<unix_ms>_<rand6>_<type>.webp`
     - Call `storageDriver.putObject(storageKey, buffer, "image/webp")`.
  4. If `capture_status === "screen_locked"`:
     - Do NOT write any file to storage (`storage_key = null`, `file_size_bytes = 0`, `width = 0`, `height = 0`).
  5. Insert row into `screenshots` (compensate by calling `storageDriver.deleteObject(storageKey)` if DB write fails).
  6. If `capture_type === "on_demand"` and `request_id` matches an entry in `pendingCaptures`: clear its 15s timer, delete from `pendingCaptures`, and broadcast `capture_status` (`status: "completed"`) to Admin WS clients.
  7. Broadcast `screenshot_ready` to Admin WS clients (including `local_date`, `local_hour`, `image_endpoint`, and optional `presigned_url` if `STORAGE_DRIVER=r2`).
- **Response `201 Created`**:
  ```json
  {
    "screenshot": {
      "id": 418,
      "employee_id": 2,
      "session_id": "uuid-v4",
      "capture_type": "random",
      "capture_status": "ok",
      "request_id": null,
      "monitor_count": 2,
      "width": 1440,
      "height": 450,
      "file_size_bytes": 84210,
      "captured_at": "2026-11-14T11:15:00.000Z",
      "expires_at": "2027-02-12T11:15:00.000Z"
    }
  }
  ```
- **Errors**: `400 VALIDATION_ERROR`, `400 INVALID_SCREENSHOT_PAYLOAD`, `404 NOT_FOUND` (invalid `session_id`), `413 PAYLOAD_TOO_LARGE`.

---

### 4.4 Admin — Live Monitoring, Screenshots & Locations

#### `POST /api/admin/employees/:id/capture-now`
- **Auth**: `admin`
- **Path Param**: `id` (target employee user ID; single employee only — bulk `capture-now` does not exist)
- **Request Body**: Empty `{}` (optional empty body)
- **Behavior**:
  1. Verify target user exists, `role === "employee"`, and `is_active === 1` (`404 NOT_FOUND` or `409 ACCOUNT_DISABLED`).
  2. Check `captureCooldowns.get(employeeId)`: if `now - lastTs < 5000ms`, return `429 CAPTURE_COOLDOWN` with header `Retry-After: <ceil_seconds>` and `details: { retry_after_seconds }`.
  3. Check employee has an active `work_sessions` row AND an open authenticated desktop WS connection in `desktopSockets`: if either is missing, return `409 EMPLOYEE_OFFLINE`.
  4. Check if another `pendingCaptures` entry is currently active for `employeeId`: if so, return `409 CAPTURE_IN_PROGRESS`.
  5. Create `request_id` (UUID v4), set `captureCooldowns.set(employeeId, now)`, register 15s timeout in `pendingCaptures`.
  6. Send WS `CAPTURE_NOW` to that single employee's `desktopSockets` entry.
  7. Broadcast WS `capture_status` (`status: "pending"`) to Admins.
- **Response `202 Accepted`**:
  ```json
  {
    "request_id": "uuid-v4",
    "employee_id": 2,
    "status": "pending",
    "timeout_seconds": 15,
    "cooldown_seconds": 5,
    "expires_at": "2026-11-14T11:15:15.000Z"
  }
  ```

#### `GET /api/admin/screenshots`
- **Auth**: `admin`
- **Query Params**:
  - `employeeId`: `integer?`
  - `date`: `YYYY-MM-DD?` (interpreted in `app_settings.company_timezone`, e.g., `Asia/Dhaka` UTC+06:00)
  - `hour`: `00..23?` (`HH` in `company_timezone`; requires `date` if specified, otherwise returns `400 VALIDATION_ERROR`)
  - `type`: `"random" | "on_demand" | "all"` (default `"all"`)
  - `status`: `"ok" | "screen_locked" | "all"` (default `"all"`)
  - `cursor`: `string?` (opaque base64url token encoding `{ captured_at, id }` for deterministic keyset pagination `ORDER BY captured_at DESC, id DESC`)
  - `limit`: `integer` (`1..60`, default `24`)
  - `include_presigned`: `boolean` (default `true`; when `STORAGE_DRIVER=r2`, attaches a 300s presigned GET URL for each `ok` row in the current page so the gallery loads in 1 round-trip)
- **Timezone Filtering Logic**:
  - Given `date = "2026-11-14"` (and optional `hour = "14"`) in `company_timezone`:
    - Server converts `[2026-11-14 00:00:00.000, 2026-11-14 23:59:59.999]` (or `[14:00:00.000, 14:59:59.999]`) in `company_timezone` to UTC ISO bounds `[startUtcIso, endUtcIso]` and queries indexed `captured_at >= startUtcIso AND captured_at <= endUtcIso`.
- **Response `200 OK`**:
  ```json
  {
    "company_timezone": "Asia/Dhaka",
    "pagination": {
      "limit": 24,
      "next_cursor": "eyJjYXB0dXJlZF9hdCI6IjIwMjYtMTEtMTRUMDk6MDA6MDBaIiwiaWQiOjQxNX0",
      "has_more": true
    },
    "items": [
      {
        "id": 418,
        "employee_id": 2,
        "employee_name": "Rahim Ahmed",
        "session_id": "uuid-v4",
        "capture_type": "random",
        "capture_status": "ok",
        "request_id": null,
        "triggered_by_admin_id": null,
        "monitor_count": 2,
        "width": 1440,
        "height": 450,
        "file_size_bytes": 84210,
        "captured_at": "2026-11-14T09:15:00.000Z",
        "expires_at": "2027-02-12T09:15:00.000Z",
        "local_date": "2026-11-14",
        "local_hour": "15",
        "local_time": "15:15:00",
        "image_endpoint": "/api/admin/screenshots/418/image",
        "presigned_url": "https://<r2-presigned-300s-url-or-null-on-local>",
        "presigned_url_expires_at": "2026-11-14T09:20:00.000Z"
      }
    ],
    "grouped": [
      {
        "employee_id": 2,
        "employee_name": "Rahim Ahmed",
        "dates": [
          {
            "date": "2026-11-14",
            "hours": [
              {
                "hour": "15",
                "screenshot_ids": [418]
              }
            ]
          }
        ]
      }
    ]
  }
  ```

#### `GET /api/admin/screenshots/:id/image`
- **Auth**: `admin` (Authorization Bearer JWT + `token_version` + `is_active = 1`)
- **Query Param**: `delivery?: "auto" | "json" | "stream"` (default `"auto"`)
- **Browser `<img>` & Lightbox Security Contract** (NO JWTs in URL query parameters!):
  - **When `STORAGE_DRIVER === "local"`**:
    - `delivery === "auto"` or `"stream"`: Streams `.webp` bytes directly from `LOCAL_STORAGE_PATH` with:
      - `200 OK`
      - `Content-Type: image/webp`
      - `Cache-Control: private, max-age=3600`
      - `X-Content-Type-Options: nosniff`
    - Admin React SPA fetches with `fetch(image_endpoint, { headers: { Authorization: "Bearer " + token } })`, turns response into an object URL via `URL.createObjectURL(blob)` for `<img>` / Lightbox, and calls `URL.revokeObjectURL()` on unmount.
  - **When `STORAGE_DRIVER === "r2"`**:
    - `delivery === "json"` (or `Accept: application/json`): Returns `200 OK`:
      ```json
      {
        "mode": "presigned_url",
        "url": "https://<account>.r2.cloudflarestorage.com/...",
        "expires_in_seconds": 300,
        "expires_at": "2026-11-14T09:20:00.000Z"
      }
      ```
    - `delivery === "auto"`: Returns `302 Found` with `Location: <300s presigned GET URL>` and `Cache-Control: private, no-store`.
    - Admin React SPA primarily uses the batch `presigned_url` from `GET /api/admin/screenshots` for `<img src={presigned_url} loading="lazy" />` (zero VPS bandwidth), and calls `?delivery=json` before opening the Lightbox or whenever an image's `presigned_url_expires_at` is within 30s of expiry!
- **Errors**: `401 UNAUTHORIZED`, `401 TOKEN_REVOKED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `404 SCREENSHOT_NO_IMAGE`.

#### `DELETE /api/admin/screenshots/:id`
- **Auth**: `admin`
- **Behavior**:
  1. Look up screenshot (`404 NOT_FOUND` if missing).
  2. Delete storage object first via `storageDriver.deleteObject(storage_key)` if `storage_key !== null` (`ENOENT` / S3 `NoSuchKey` treated as idempotent success).
  3. Delete DB row and write `audit_logs` (`action: "SCREENSHOT_DELETED"`, `target_type: "screenshot"`, `target_id: String(id)`).
- **Response `200 OK`**:
  ```json
  {
    "deleted_id": 418
  }
  ```

#### `POST /api/admin/screenshots/bulk-delete`
- **Auth**: `admin`
- **Request Body**:
  ```json
  {
    "ids": ["integer[] (min 1, max 100)"]
  }
  ```
- **Behavior**:
  1. Deduplicate `ids` and query matching `screenshots` rows.
  2. Call `storageDriver.deleteObjects(nonNullKeys)` BEFORE deleting DB rows (R2 batch `DeleteObjectsCommand` <= 1000 keys; `LocalStorageDriver` unlinks ignoring `ENOENT`).
  3. Delete matching rows from `screenshots` inside a SQLite transaction and write `audit_logs` (`action: "SCREENSHOTS_BULK_DELETED"`, `details_json: { deleted_ids, count }`).
- **Response `200 OK`**:
  ```json
  {
    "deleted_count": 12,
    "deleted_ids": [410, 411, 412],
    "not_found_ids": []
  }
  ```

#### `GET /api/admin/locations/live`
- **Auth**: `admin`
- **Behavior**:
  - Fetches all active employees (`role = 'employee' AND is_active = 1`) along with their active session (if any) and latest `location_logs` row.
  - If latest `location_logs` row is missing or `location_enabled === 0` or `source === "disabled"`, returns explicit `"Disabled by Employee"` state with `null` coordinates (never falls back to IP geolocation!).
- **Response `200 OK`**:
  ```json
  {
    "company_timezone": "Asia/Dhaka",
    "employees": [
      {
        "employee_id": 2,
        "employee_name": "Rahim Ahmed",
        "designation": "Backend Developer",
        "is_online": true,
        "session_id": "uuid-v4",
        "sharing_enabled": true,
        "status": "active",
        "label": "OS Native",
        "latitude": 23.8103,
        "longitude": 90.4125,
        "accuracy_meters": 25.0,
        "source": "os_native",
        "recorded_at": "2026-11-14T11:14:00.000Z"
      },
      {
        "employee_id": 3,
        "employee_name": "Karim Hasan",
        "designation": "QA Engineer",
        "is_online": true,
        "session_id": "uuid-v4-2",
        "sharing_enabled": false,
        "status": "disabled_by_employee",
        "label": "Disabled by Employee",
        "latitude": null,
        "longitude": null,
        "accuracy_meters": null,
        "source": "disabled",
        "recorded_at": "2026-11-14T10:50:00.000Z"
      }
    ]
  }
  ```

---

### 4.5 Admin — Salary Reports, Settings & Audit Logs

#### `GET /api/admin/salary-reports`
- **Auth**: `admin`
- **Query Params**:
  - `month`: `YYYY-MM?`
  - `employeeId`: `integer?`
  - `paymentStatus`: `"pending" | "paid" | "all"` (default `"all"`)
- **Response `200 OK`**:
  ```json
  {
    "currency_code": "BDT",
    "summary": {
      "total_reports": 6,
      "pending_count": 4,
      "paid_count": 2,
      "total_net_payable": 245000.00
    },
    "reports": [
      {
        "id": 15,
        "employee_id": 2,
        "employee_name": "Rahim Ahmed",
        "employee_email": "rahim@company.com",
        "employee_designation": "Backend Developer",
        "report_month": "2026-11",
        "period_start": "2026-10-31T18:00:00.000Z",
        "period_end": "2026-11-30T17:59:59.999Z",
        "total_worked_seconds": 612000,
        "total_worked_hours": 170.0,
        "salary_type_snapshot": "monthly",
        "base_rate_snapshot": 45000,
        "overtime_or_bonus": 2000,
        "deductions": 0,
        "net_payable": 47000,
        "currency_code": "BDT",
        "payment_status": "pending",
        "paid_at": null,
        "notes": "",
        "created_by_admin_id": 1,
        "created_at": "2026-11-30T18:05:00.000Z",
        "updated_at": "2026-11-30T18:05:00.000Z"
      }
    ]
  }
  ```

#### `POST /api/admin/salary-reports`
- **Auth**: `admin`
- **Request Body**:
  ```json
  {
    "employee_id": "integer (> 0)",
    "report_month": "string (regex /^\\d{4}-(0[1-9]|1[0-2])$/)",
    "overtime_or_bonus": "number (>= 0, default: 0)",
    "deductions": "number (>= 0, default: 0)",
    "notes": "string (max 500, default: '')"
  }
  ```
- **Snapshot Computation Rules**:
  1. Look up employee (`role === "employee"`; allowed even if `is_active === 0` for final settlement).
  2. Resolve `[period_start, period_end]` as UTC boundaries of `report_month` (`01 00:00:00.000` through `lastDay 23:59:59.999`) in `app_settings.company_timezone`.
  3. Sum worked seconds from `work_sessions` overlapping `[period_start, period_end]`:
     - For each session where `started_at <= period_end AND COALESCE(ended_at, last_heartbeat_at) >= period_start`:
       - `effectiveStart = max(started_at, period_start)`
       - `effectiveEnd = min(COALESCE(ended_at, last_heartbeat_at), period_end)`
       - Accumulate `max(0, floor((effectiveEnd - effectiveStart) / 1000))`.
  4. Snapshot `salary_type_snapshot = user.salary_type`, `base_rate_snapshot = user.base_salary`, `currency_code = app_settings.currency_code`.
  5. Compute `gross = salary_type_snapshot === "monthly" ? base_rate_snapshot : (total_worked_seconds / 3600) * base_rate_snapshot`.
  6. Compute `net_payable = Math.max(0, Math.round((gross + overtime_or_bonus - deductions) * 100) / 100)`.
  7. Insert row (`UNIQUE(employee_id, report_month)`) and write `audit_logs` (`SALARY_REPORT_CREATED`).
- **Response `201 Created`**: `{ "report": { ...SalaryReport... } }`.
- **Errors**: `400 VALIDATION_ERROR`, `404 NOT_FOUND`, `409 SALARY_REPORT_EXISTS`.

#### `PATCH /api/admin/salary-reports/:id`
- **Auth**: `admin`
- **Request Body** (at least 1 field):
  ```json
  {
    "overtime_or_bonus": "number? (>= 0)",
    "deductions": "number? (>= 0)",
    "notes": "string? (max 500)",
    "payment_status": "pending | paid?"
  }
  ```
- **Rules**:
  - If report is currently `paid` and the request modifies `overtime_or_bonus` or `deductions` without setting `payment_status: "pending"`, return `409 SALARY_REPORT_PAID_LOCKED`.
  - Recalculates `net_payable` from snapshotted `salary_type_snapshot`, `base_rate_snapshot`, and `total_worked_seconds` whenever `overtime_or_bonus` or `deductions` changes.
  - Transitions to `paid` set `paid_at = UTC_NOW()`; transitions back to `pending` clear `paid_at = null`.
  - Writes `audit_logs` (`SALARY_REPORT_UPDATED` / `SALARY_REPORT_MARKED_PAID`).
- **Response `200 OK`**: `{ "report": { ...SalaryReport... } }`.

#### `DELETE /api/admin/salary-reports/:id`
- **Auth**: `admin`
- **Rules**:
  - Only `pending` reports can be deleted; attempting to delete a `paid` report returns `409 SALARY_REPORT_PAID_LOCKED`.
  - Writes `audit_logs` (`SALARY_REPORT_DELETED`, preserving the deleted snapshot JSON inside `details_json`).
- **Response `200 OK`**: `{ "deleted_id": 15 }`.

#### `GET /api/admin/salary-reports/export`
- **Auth**: `admin`
- **Query Params**: `month` (`YYYY-MM`, required), `format` (`"csv"`, default `"csv"`).
- **Response `200 OK`**:
  - Headers: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="salary-report-YYYY-MM.csv"`, `X-Content-Type-Options: nosniff`.
  - Body: UTF-8 BOM (`\uFEFF`) + RFC 4180 CSV with spreadsheet formula-injection sanitization (cells beginning with `=`, `+`, `-`, `@` prefixed with `'`).

#### `GET /api/admin/settings`
- **Auth**: `admin`
- **Response `200 OK`**:
  ```json
  {
    "settings": {
      "id": 1,
      "company_name": "SM Office",
      "company_timezone": "Asia/Dhaka",
      "currency_code": "BDT",
      "retention_days": 90,
      "updated_at": "2026-11-01T00:00:00.000Z"
    },
    "runtime": {
      "storage_driver": "r2",
      "max_active_employees": 10,
      "max_active_admins": 2
    }
  }
  ```

#### `PATCH /api/admin/settings`
- **Auth**: `admin`
- **Request Body** (at least 1 field):
  ```json
  {
    "company_name": "string? (min 2, max 100)",
    "company_timezone": "string? (valid IANA timezone, e.g. Asia/Dhaka)",
    "currency_code": "string? (3 uppercase ISO-4217 letters, e.g. BDT)",
    "retention_days": "integer? (7..90)"
  }
  ```
  (`retention_days` is capped at `90` so DB cleanup stays aligned with the Cloudflare R2 90-day lifecycle safety net.)
- **Behavior**: Updates `app_settings WHERE id = 1`, sets `updated_at = UTC_NOW()`, writes `audit_logs` (`SETTINGS_UPDATED`).
- **Response `200 OK`**: `{ "settings": { ... } }`.

#### `GET /api/admin/audit-logs`
- **Auth**: `admin`
- **Query Params**:
  - `actorId`: `integer?`
  - `action`: `string?`
  - `targetType`: `string?`
  - `from`: `ISO-8601 UTC?`
  - `to`: `ISO-8601 UTC?`
  - `cursor`: `integer?` (last seen `id`, paginating `id < cursor ORDER BY id DESC`)
  - `limit`: `integer` (`1..100`, default `50`)
- **Response `200 OK`**:
  ```json
  {
    "pagination": {
      "limit": 50,
      "next_cursor": 102,
      "has_more": true
    },
    "logs": [
      {
        "id": 152,
        "actor_id": 1,
        "actor_name": "Super Admin",
        "actor_email": "admin@company.com",
        "action": "SCREENSHOT_DELETED",
        "target_type": "screenshot",
        "target_id": "418",
        "details_json": "{\"storage_key\":\"2026/11/14/emp_2/1763118000000_a1b2c3_random.webp\"}",
        "created_at": "2026-11-14T11:20:00.000Z"
      }
    ]
  }
  ```

---

## 5. WebSocket Protocol (`wss://<domain>/ws`)

### 5.1 Connection & Authentication Handshake
1. Client opens WebSocket to `wss://<domain>/ws` (or `ws://localhost:3000/ws` in local dev) **without** tokens in the URL query string.
2. Client MUST send an `auth` JSON message within **5,000 ms** of socket open; otherwise server closes with `4001` (`AUTH_TIMEOUT`).
3. Server validates:
   - JWT signature, expiration, and `type === "access"`.
   - SQLite `users` row: `is_active === 1` and `payload.tv === user.token_version`.
   - For `client_type === "desktop"`: `user.role === "employee"`, `device_id` non-empty, `device_arch` in `["x86_64", "arm64"]`.
   - For `client_type === "admin_web"`: `user.role === "admin"`.
4. On failure, server sends `auth_error` and immediately closes the connection (`4003`).
5. On success, server registers the socket (`desktopSockets` keyed by `employee_id`, or `adminSockets` set) and replies with `auth_ok`.
   - Note: If an older desktop WS exists for the same `employee_id` and same `device_id`, close the stale socket cleanly (`1000`); if different `device_id` without active override, reject or track only the active session's `device_id`.

### 5.2 Exact Message Schemas (All messages follow `{ "type": string, "payload": object }`)

#### Desktop -> Server
1. `auth`:
   ```json
   {
     "type": "auth",
     "payload": {
       "token": "eyJ...",
       "client_type": "desktop",
       "device_id": "dev_uuid",
       "device_os": "windows",
       "device_arch": "x86_64",
       "app_version": "1.0.0"
     }
   }
   ```
2. `heartbeat` (mirrors HTTP heartbeat every 60s when WS is connected; enforces exact same strict location consent validation):
   ```json
   {
     "type": "heartbeat",
     "payload": {
       "session_id": "uuid-v4",
       "screen_locked": false,
       "location_enabled": false,
       "latitude": null,
       "longitude": null,
       "accuracy_meters": null,
       "location_source": "disabled"
     }
   }
   ```
3. `capture_ack` (sent when desktop begins/completes an on-demand capture before or alongside upload):
   ```json
   {
     "type": "capture_ack",
     "payload": {
       "request_id": "uuid-v4",
       "screenshot_id": 419,
       "capture_status": "ok"
     }
   }
   ```
   *(Optional `screenshot_id` if sent as early `"received"` ack; final `completed` broadcast to Admins happens when `POST /api/tracker/screenshots` persists the file or `capture_ack` includes `screenshot_id`.)*
4. `capture_failed`:
   ```json
   {
     "type": "capture_failed",
     "payload": {
       "request_id": "uuid-v4",
       "reason": "OS Screen Recording permission denied"
     }
   }
   ```
5. `ping`:
   ```json
   {
     "type": "ping",
     "payload": { "ts": 1763118900000 }
   }
   ```

#### Server -> Desktop
1. `auth_ok`:
   ```json
   {
     "type": "auth_ok",
     "payload": {
       "user_id": 2,
       "server_time_utc": "2026-11-14T11:15:00.000Z",
       "active_session_id": "uuid-v4",
       "heartbeat_interval_seconds": 60
     }
   }
   ```
2. `auth_error`:
   ```json
   {
     "type": "auth_error",
     "payload": {
       "code": "TOKEN_REVOKED",
       "message": "Session revoked; re-authentication required"
     }
   }
   ```
3. `CAPTURE_NOW`:
   ```json
   {
     "type": "CAPTURE_NOW",
     "payload": {
       "request_id": "uuid-v4",
       "triggered_by_admin_id": 1,
       "requested_at": "2026-11-14T11:15:00.000Z",
       "timeout_seconds": 15
     }
   }
   ```
4. `FORCE_STOP`:
   ```json
   {
     "type": "FORCE_STOP",
     "payload": {
       "session_id": "uuid-v4",
       "reason": "account_deactivated",
       "message": "Account deactivated by administrator"
     }
   }
   ```
   (`reason`: `"account_deactivated" | "session_overridden" | "admin_force_stop" | "token_revoked"`)
5. `pong`:
   ```json
   {
     "type": "pong",
     "payload": {
       "ts": 1763118900000,
       "server_time_utc": "2026-11-14T11:15:00.000Z"
     }
   }
   ```

#### Admin -> Server
1. `auth`:
   ```json
   {
     "type": "auth",
     "payload": {
       "token": "eyJ...",
       "client_type": "admin_web"
     }
   }
   ```
2. `ping`:
   ```json
   {
     "type": "ping",
     "payload": { "ts": 1763118900000 }
   }
   ```

#### Server -> Admin
1. `auth_ok`:
   ```json
   {
     "type": "auth_ok",
     "payload": {
       "user_id": 1,
       "server_time_utc": "2026-11-14T11:15:00.000Z",
       "online_employee_ids": [2, 4, 5]
     }
   }
   ```
2. `auth_error`:
   ```json
   {
     "type": "auth_error",
     "payload": {
       "code": "UNAUTHORIZED",
       "message": "Invalid token"
     }
   }
   ```
3. `employee_status`:
   ```json
   {
     "type": "employee_status",
     "payload": {
       "employee_id": 2,
       "is_online": true,
       "ws_connected": true,
       "session_id": "uuid-v4",
       "device_id": "dev_uuid",
       "device_os": "windows",
       "device_arch": "x86_64",
       "screen_locked": false,
       "started_at": "2026-11-14T03:00:00.000Z",
       "last_heartbeat_at": "2026-11-14T11:15:00.000Z",
       "reason": "heartbeat"
     }
   }
   ```
4. `location_update`:
   ```json
   {
     "type": "location_update",
     "payload": {
       "employee_id": 2,
       "sharing_enabled": false,
       "latitude": null,
       "longitude": null,
       "accuracy_meters": null,
       "source": "disabled",
       "recorded_at": "2026-11-14T11:15:00.000Z"
     }
   }
   ```
5. `capture_status`:
   ```json
   {
     "type": "capture_status",
     "payload": {
       "request_id": "uuid-v4",
       "employee_id": 2,
       "status": "timeout",
       "screenshot_id": null,
       "capture_status": null,
       "reason": "Desktop did not respond within 15 seconds",
       "updated_at": "2026-11-14T11:15:15.000Z"
     }
   }
   ```
   (`status`: `"pending" | "completed" | "timeout" | "failed"`)
6. `screenshot_ready`:
   ```json
   {
     "type": "screenshot_ready",
     "payload": {
       "screenshot": {
         "id": 419,
         "employee_id": 2,
         "session_id": "uuid-v4",
         "capture_type": "on_demand",
         "capture_status": "ok",
         "request_id": "uuid-v4",
         "monitor_count": 1,
         "width": 1440,
         "height": 900,
         "file_size_bytes": 78200,
         "captured_at": "2026-11-14T11:15:03.000Z",
         "local_date": "2026-11-14",
         "local_hour": "17",
         "image_endpoint": "/api/admin/screenshots/419/image",
         "presigned_url": "https://..."
       }
     }
   }
   ```
7. `pong`:
   ```json
   {
     "type": "pong",
     "payload": {
       "ts": 1763118900000,
       "server_time_utc": "2026-11-14T11:15:00.000Z"
     }
   }
   ```

### 5.3 In-Memory Pending Capture Tracker & Cooldown State

```typescript
interface PendingCaptureEntry {
  requestId: string;
  employeeId: number;
  adminId: number;
  createdAtMs: number;
  timer: NodeJS.Timeout;
}

// request_id -> 15-second timeout tracker
const pendingCaptures = new Map<string, PendingCaptureEntry>();

// employee_id -> epoch ms of last accepted CAPTURE_NOW trigger (5-second cooldown)
const captureCooldowns = new Map<number, number>();
```

- **Timeout (`15,000 ms`)**: If neither `POST /api/tracker/screenshots` (with matching `request_id`) nor WS `capture_failed` completes within 15 seconds, the timer deletes the entry from `pendingCaptures` and emits `capture_status: "timeout"` to all `adminSockets`.
- **Late Upload Resilience**: If a desktop upload arrives after 15 seconds (e.g., network jitter), `POST /api/tracker/screenshots` still stores the screenshot as `on_demand` and emits `screenshot_ready` so no evidence is lost.
- **Socket Disconnect Cleanup**: When a desktop WS closes unexpectedly while a `pendingCaptures` item exists for that `employeeId`, do NOT cancel immediately — allow up to the remaining 15s window for an HTTP `POST /api/tracker/screenshots` upload (or let it time out naturally at 15s).

---

## 6. Pluggable Storage Driver (`StorageDriver`), Cloudflare R2 & Local Fallback

### 6.1 `StorageDriver` TypeScript Contract

```typescript
export type PrivateReadResult =
  | {
      mode: "presigned_url";
      url: string;
      expiresInSeconds: number;
      expiresAt: string;
    }
  | {
      mode: "stream";
      contentType: string;
      contentLength: number;
      createStream: () => NodeJS.ReadableStream;
    };

export interface ListedStorageObject {
  key: string;
  lastModified: Date;
  sizeBytes: number;
}

export interface StorageDriver {
  readonly driverName: "r2" | "local";

  putObject(key: string, body: Buffer, contentType: "image/webp"): Promise<void>;

  getPrivateReadAccess(
    key: string,
    ttlSeconds?: number
  ): Promise<PrivateReadResult>;

  /** Idempotent delete: missing key / ENOENT / NoSuchKey succeeds silently. */
  deleteObject(key: string): Promise<void>;

  /** Batch delete up to 1000 keys per call; returns keys successfully deleted or absent. */
  deleteObjects(keys: string[]): Promise<void>;

  /** Used by weekly orphan cleanup cron to discover keys older than cutoffDate. */
  listObjectsOlderThan(cutoffDate: Date): Promise<ListedStorageObject[]>;

  healthCheck(): Promise<void>;
}
```

### 6.2 `R2StorageDriver` (Primary Production Driver)
- **Dependencies**: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.
- **Client Configuration**:
  - `endpoint`: `` `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` ``
  - `region`: `"auto"`
  - `credentials`: `{ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }`
- **Bucket Security**:
  - Bucket (`R2_BUCKET_NAME`) MUST remain **strictly private** (`r2.dev` public URL disabled, no public read policy).
  - Configure R2 CORS policy to allow `GET` and `HEAD` only from the Admin Dashboard HTTPS origin (`CORS_ORIGIN`).
- **Operations**:
  - `putObject`: `PutObjectCommand({ Bucket, Key, Body, ContentType: "image/webp" })`.
  - `getPrivateReadAccess`: `getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn: ttlSeconds ?? R2_PRESIGNED_URL_TTL_SECONDS })` (default `300s`).
  - `deleteObject`: `DeleteObjectCommand` (swallows `NoSuchKey` / 404).
  - `deleteObjects`: chunks input keys into batches of `1000` and calls `DeleteObjectsCommand({ Bucket, Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true } })`. Throws only if `Errors` contains a non-`NoSuchKey` failure.
  - `listObjectsOlderThan(cutoffDate)`: paginates `ListObjectsV2Command` (`MaxKeys: 1000`, `ContinuationToken`), returning items where `LastModified < cutoffDate`.
  - `healthCheck`: `HeadBucketCommand({ Bucket })`.

### 6.3 `LocalStorageDriver` (Dev / Single-VPS Fallback)
- **Configuration**: `LOCAL_STORAGE_PATH` (default `./data/screenshots`), resolved via `path.resolve()`.
- **Strict Path Traversal Guard**:
  - Reject any `key` containing `..`, `\`, leading `/`, or `\0`, or not matching `^[0-9]{4}/[0-9]{2}/[0-9]{2}/emp_[0-9]+/[0-9]+_[a-z0-9]{6}_(random|on_demand)\.webp$`.
  - Resolve `target = path.resolve(baseDir, key)` and assert `target.startsWith(baseDir + path.sep)`.
- **Operations**:
  - `putObject`: creates parent dirs (`mkdir(..., { recursive: true })`), writes to `${target}.tmp-${randomUUID()}`, and atomically `rename()`s to `target`.
  - `getPrivateReadAccess`: `stat(target)` + returns `{ mode: "stream", contentType: "image/webp", contentLength: stats.size, createStream: () => fs.createReadStream(target) }`.
  - `deleteObject` / `deleteObjects`: `fs.unlink(target)` catching `ENOENT` as idempotent success.
  - `listObjectsOlderThan(cutoffDate)`: walks `baseDir` recursively, skipping `*.tmp-*` younger than 1 hour, collecting files with `stat.mtime < cutoffDate`.
  - `healthCheck`: checks directory exists / writable via `fs.access(baseDir, constants.R_OK | constants.W_OK)`.

---

## 7. 90-Day Lifecycle, Daily Purge Cron & Maintenance Jobs

1. **Daily Purge Cron (`0 2 * * *` UTC — 02:00 UTC)**:
   - Runs inside Fastify backend via `node-cron` (with an in-process mutex so overlapping runs never happen).
   - Step 1 (`screenshots` purge in batches of `500`):
     - Query `SELECT id, storage_key FROM screenshots WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT 500`.
     - Delete non-null `storage_key`s via `storageDriver.deleteObjects(keys)` **first** (so DB rows are never dropped before object deletion succeeds).
     - Delete those `id`s from `screenshots` (`DELETE FROM screenshots WHERE id IN (...)`).
     - Loop until fewer than `500` rows remain.
   - Step 2 (`location_logs` purge in batches of `500`):
     - Loop `DELETE FROM location_logs WHERE id IN (SELECT id FROM location_logs WHERE expires_at <= ? LIMIT 500)` until `changes === 0`.
   - Step 3 (WAL reclaim):
     - Execute `PRAGMA wal_checkpoint(TRUNCATE);`.
   - Step 4: Emit structured log + insert `audit_logs` (`SYSTEM_RETENTION_PURGE`) if rows were deleted.
2. **Weekly Orphan Cleanup Cron (`0 3 * * 0` UTC — Sunday 03:00 UTC)**:
   - `cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)` (only inspects objects >24h old to avoid racing active uploads).
   - Calls `storageDriver.listObjectsOlderThan(cutoff)`.
   - Checks existence against `screenshots.storage_key` in batches of `500`.
   - Calls `storageDriver.deleteObjects(orphanKeys)` for keys missing from DB.
3. **Cloudflare R2 90-Day Lifecycle Rule (Safety Net)**:
   - Configure a Cloudflare R2 Bucket Object Lifecycle Rule:
     - Rule Name: `expire-after-90-days`
     - Scope: All objects (`prefix: ""`)
     - Action: **Delete objects after `90` days** from creation.
   - This guarantees hard 90-day storage capping (`~2–4 GB` steady state) even if the VPS is offline for maintenance.
4. **Stale Session Sweeper (`*/30 * * * * *` — every 30 seconds)**:
   - Queries active sessions where `last_heartbeat_at < now - 180s`.
   - Marks `status = 'stopped'`, `ended_at = last_heartbeat_at`, `duration_seconds = max(0, floor((last_heartbeat_at - started_at) / 1000))`, and broadcasts `employee_status` (`is_online: false`, `reason: "heartbeat_timeout"`).

---

## 8. SQLite WAL Schema & Atomic Triggers Summary

See canonical SQL DDL in [`apps/server/src/db/migrations/0001_init.sql`](../apps/server/src/db/migrations/0001_init.sql) and Drizzle schema in [`apps/server/src/db/schema.ts`](../apps/server/src/db/schema.ts).

### Boot PRAGMAs
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

### Tables & Key Constraints
- `app_settings`: Singleton row (`id = 1 CHECK (id = 1)`), defaults `company_name = 'SM Office'`, `company_timezone = 'Asia/Dhaka'`, `currency_code = 'BDT'`, `retention_days = 90`.
- `users`: `role IN ('admin', 'employee')`, `salary_type IN ('monthly', 'hourly')`, `is_active IN (0, 1)`, `token_version >= 1`.
  - Triggers:
    - `trg_limit_admins_insert` (`BEFORE INSERT`) -> `RAISE(ABORT, 'MAX_ADMINS_EXCEEDED')`
    - `trg_limit_admins_update` (`BEFORE UPDATE`) -> `RAISE(ABORT, 'MAX_ADMINS_EXCEEDED')` (only fires when transitioning into active admin)
    - `trg_limit_employees_insert` (`BEFORE INSERT`) -> `RAISE(ABORT, 'MAX_EMPLOYEES_EXCEEDED')`
    - `trg_limit_employees_update` (`BEFORE UPDATE`) -> `RAISE(ABORT, 'MAX_EMPLOYEES_EXCEEDED')` (only fires when transitioning into active employee)
    - `trg_prevent_last_admin_disable` (`BEFORE UPDATE`) -> `RAISE(ABORT, 'CANNOT_DISABLE_LAST_ADMIN')` (blocks deactivating OR demoting the sole active admin)
    - `trg_prevent_last_admin_delete` (`BEFORE DELETE`) -> `RAISE(ABORT, 'CANNOT_DISABLE_LAST_ADMIN')` (blocks deleting the sole active admin)
- `work_sessions`: UUID `id`, `employee_id`, `device_id`, `device_os`, `device_arch IN ('x86_64', 'arm64')`, partial unique index `idx_one_active_session ON work_sessions(employee_id) WHERE status = 'active'`.
- `screenshots`: `capture_type IN ('random', 'on_demand')`, `capture_status IN ('ok', 'screen_locked')`, nullable `storage_key` (NULL when `screen_locked`), `captured_at`, `expires_at`, indexed by `(employee_id, captured_at DESC)` and `(expires_at)`.
- `location_logs`: DB `CHECK` enforces `(location_enabled = 0 AND latitude IS NULL AND longitude IS NULL AND accuracy_meters IS NULL AND source = 'disabled') OR (location_enabled = 1 AND latitude IS NOT NULL AND longitude IS NOT NULL AND source IN ('os_native', 'ip_approx'))`, indexed by `(employee_id, recorded_at DESC)` and `(expires_at)`.
- `salary_reports`: `UNIQUE(employee_id, report_month)`, stores snapshotted `salary_type_snapshot`, `base_rate_snapshot`, `total_worked_seconds`, `net_payable`, `payment_status IN ('pending', 'paid')`.
- `audit_logs`: Immutable security/admin audit log indexed by `(created_at DESC)` and `(actor_id, created_at DESC)`.
