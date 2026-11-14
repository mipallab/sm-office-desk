-- SM Office Desk — Initial SQLite Schema Migration
-- Required connection boot PRAGMAs (executed outside transactions by DB client):
--   PRAGMA journal_mode = WAL;
--   PRAGMA synchronous = NORMAL;
--   PRAGMA busy_timeout = 5000;
--   PRAGMA foreign_keys = ON;

-- 1. Singleton Company Settings
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company_name TEXT NOT NULL DEFAULT 'SM Office',
  company_timezone TEXT NOT NULL DEFAULT 'Asia/Dhaka',
  currency_code TEXT NOT NULL DEFAULT 'BDT',
  retention_days INTEGER NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 7 AND 90),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO app_settings (
  id,
  company_name,
  company_timezone,
  currency_code,
  retention_days,
  updated_at
) VALUES (
  1,
  'SM Office',
  'Asia/Dhaka',
  'BDT',
  90,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

-- 2. Users (Admins max 2 active, Employees max 10 active)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'employee')),
  designation TEXT NOT NULL DEFAULT '',
  salary_type TEXT NOT NULL DEFAULT 'monthly' CHECK (salary_type IN ('monthly', 'hourly')),
  base_salary REAL NOT NULL DEFAULT 0 CHECK (base_salary >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  token_version INTEGER NOT NULL DEFAULT 1 CHECK (token_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_role_active
  ON users(role, is_active);

-- 3. Work Sessions (1 active session per employee, 64-bit desktop only)
CREATE TABLE IF NOT EXISTS work_sessions (
  id TEXT PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  last_heartbeat_at TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  device_os TEXT NOT NULL CHECK (device_os IN ('windows', 'macos', 'linux')),
  device_arch TEXT NOT NULL CHECK (device_arch IN ('x86_64', 'arm64')),
  app_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'stopped'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_session
  ON work_sessions(employee_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_work_sessions_employee_started
  ON work_sessions(employee_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_sessions_status_heartbeat
  ON work_sessions(status, last_heartbeat_at);

-- 4. Screenshots (Private WebP metadata + 90-day expiry)
CREATE TABLE IF NOT EXISTS screenshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
  capture_type TEXT NOT NULL CHECK (capture_type IN ('random', 'on_demand')),
  capture_status TEXT NOT NULL CHECK (capture_status IN ('ok', 'screen_locked')),
  request_id TEXT,
  triggered_by_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  storage_key TEXT UNIQUE,
  file_size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (file_size_bytes >= 0),
  width INTEGER NOT NULL DEFAULT 0 CHECK (width >= 0),
  height INTEGER NOT NULL DEFAULT 0 CHECK (height >= 0),
  monitor_count INTEGER NOT NULL DEFAULT 1 CHECK (monitor_count >= 0),
  captured_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (capture_status = 'ok' AND storage_key IS NOT NULL AND width > 0 AND height > 0 AND monitor_count >= 1)
    OR
    (capture_status = 'screen_locked' AND storage_key IS NULL AND file_size_bytes = 0 AND width = 0 AND height = 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_screenshots_employee_captured
  ON screenshots(employee_id, captured_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_screenshots_captured_at
  ON screenshots(captured_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_screenshots_expires_at
  ON screenshots(expires_at);

CREATE INDEX IF NOT EXISTS idx_screenshots_session_id
  ON screenshots(session_id);

-- 5. Live Location Logs (Strict employee consent + 90-day expiry)
CREATE TABLE IF NOT EXISTS location_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
  location_enabled INTEGER NOT NULL CHECK (location_enabled IN (0, 1)),
  latitude REAL,
  longitude REAL,
  accuracy_meters REAL CHECK (accuracy_meters IS NULL OR accuracy_meters >= 0),
  source TEXT NOT NULL CHECK (source IN ('os_native', 'ip_approx', 'disabled')),
  recorded_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (
    (location_enabled = 0 AND latitude IS NULL AND longitude IS NULL AND accuracy_meters IS NULL AND source = 'disabled')
    OR
    (location_enabled = 1 AND latitude IS NOT NULL AND longitude IS NOT NULL AND latitude BETWEEN -90.0 AND 90.0 AND longitude BETWEEN -180.0 AND 180.0 AND source IN ('os_native', 'ip_approx'))
  )
);

CREATE INDEX IF NOT EXISTS idx_location_logs_employee_recorded
  ON location_logs(employee_id, recorded_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_location_logs_expires_at
  ON location_logs(expires_at);

-- 6. Salary Reports (Immutable rate & worked-hours snapshot per month)
CREATE TABLE IF NOT EXISTS salary_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  report_month TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  total_worked_seconds INTEGER NOT NULL DEFAULT 0 CHECK (total_worked_seconds >= 0),
  salary_type_snapshot TEXT NOT NULL CHECK (salary_type_snapshot IN ('monthly', 'hourly')),
  base_rate_snapshot REAL NOT NULL CHECK (base_rate_snapshot >= 0),
  overtime_or_bonus REAL NOT NULL DEFAULT 0 CHECK (overtime_or_bonus >= 0),
  deductions REAL NOT NULL DEFAULT 0 CHECK (deductions >= 0),
  net_payable REAL NOT NULL CHECK (net_payable >= 0),
  currency_code TEXT NOT NULL DEFAULT 'BDT',
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid')),
  paid_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_by_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(employee_id, report_month)
);

CREATE INDEX IF NOT EXISTS idx_salary_reports_month_status
  ON salary_reports(report_month, payment_status);

-- 7. Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON audit_logs(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created
  ON audit_logs(actor_id, created_at DESC);

-- ============================================================================
-- Atomic Scale Cap & Last-Admin Protection Triggers
-- ============================================================================

-- Enforce max 2 active admins on INSERT
CREATE TRIGGER IF NOT EXISTS trg_limit_admins_insert
BEFORE INSERT ON users
FOR EACH ROW
WHEN NEW.role = 'admin' AND NEW.is_active = 1
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1) >= 2
    THEN RAISE(ABORT, 'MAX_ADMINS_EXCEEDED')
  END;
END;

-- Enforce max 2 active admins on UPDATE (only when transitioning into active admin)
CREATE TRIGGER IF NOT EXISTS trg_limit_admins_update
BEFORE UPDATE ON users
FOR EACH ROW
WHEN NEW.role = 'admin' AND NEW.is_active = 1
 AND NOT (OLD.role = 'admin' AND OLD.is_active = 1)
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1 AND id != OLD.id) >= 2
    THEN RAISE(ABORT, 'MAX_ADMINS_EXCEEDED')
  END;
END;

-- Enforce max 10 active employees on INSERT
CREATE TRIGGER IF NOT EXISTS trg_limit_employees_insert
BEFORE INSERT ON users
FOR EACH ROW
WHEN NEW.role = 'employee' AND NEW.is_active = 1
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM users WHERE role = 'employee' AND is_active = 1) >= 10
    THEN RAISE(ABORT, 'MAX_EMPLOYEES_EXCEEDED')
  END;
END;

-- Enforce max 10 active employees on UPDATE (only when transitioning into active employee)
CREATE TRIGGER IF NOT EXISTS trg_limit_employees_update
BEFORE UPDATE ON users
FOR EACH ROW
WHEN NEW.role = 'employee' AND NEW.is_active = 1
 AND NOT (OLD.role = 'employee' AND OLD.is_active = 1)
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM users WHERE role = 'employee' AND is_active = 1 AND id != OLD.id) >= 10
    THEN RAISE(ABORT, 'MAX_EMPLOYEES_EXCEEDED')
  END;
END;

-- Prevent deactivating or demoting the sole remaining active admin
CREATE TRIGGER IF NOT EXISTS trg_prevent_last_admin_disable
BEFORE UPDATE ON users
FOR EACH ROW
WHEN OLD.role = 'admin' AND OLD.is_active = 1
 AND (NEW.is_active = 0 OR NEW.role != 'admin')
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1 AND id != OLD.id) < 1
    THEN RAISE(ABORT, 'CANNOT_DISABLE_LAST_ADMIN')
  END;
END;

-- Prevent deleting the sole remaining active admin
CREATE TRIGGER IF NOT EXISTS trg_prevent_last_admin_delete
BEFORE DELETE ON users
FOR EACH ROW
WHEN OLD.role = 'admin' AND OLD.is_active = 1
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1 AND id != OLD.id) < 1
    THEN RAISE(ABORT, 'CANNOT_DISABLE_LAST_ADMIN')
  END;
END;
