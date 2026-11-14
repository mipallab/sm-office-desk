import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ============================================================================
// 1. app_settings (Singleton row id = 1)
// ============================================================================

export const appSettings = sqliteTable(
  "app_settings",
  {
    id: integer("id").primaryKey(),
    companyName: text("company_name").notNull().default("SM Office"),
    companyTimezone: text("company_timezone").notNull().default("Asia/Dhaka"),
    currencyCode: text("currency_code").notNull().default("BDT"),
    retentionDays: integer("retention_days").notNull().default(90),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("chk_app_settings_singleton", sql`${t.id} = 1`),
    check("chk_app_settings_retention_days", sql`${t.retentionDays} BETWEEN 7 AND 90`),
  ]
);

// ============================================================================
// 2. users (Admins max 2 active, Employees max 10 active via SQLite triggers)
// ============================================================================

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["admin", "employee"] }).notNull(),
    designation: text("designation").notNull().default(""),
    salaryType: text("salary_type", { enum: ["monthly", "hourly"] })
      .notNull()
      .default("monthly"),
    baseSalary: real("base_salary").notNull().default(0),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    tokenVersion: integer("token_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_users_role_active").on(t.role, t.isActive),
    check("chk_users_role", sql`${t.role} IN ('admin', 'employee')`),
    check("chk_users_salary_type", sql`${t.salaryType} IN ('monthly', 'hourly')`),
    check("chk_users_base_salary", sql`${t.baseSalary} >= 0`),
    check("chk_users_is_active", sql`${t.isActive} IN (0, 1)`),
    check("chk_users_token_version", sql`${t.tokenVersion} >= 1`),
  ]
);

// ============================================================================
// 3. work_sessions (1 active session per employee, 64-bit desktop only)
// ============================================================================

export const workSessions = sqliteTable(
  "work_sessions",
  {
    id: text("id").primaryKey(),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    deviceId: text("device_id").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    lastHeartbeatAt: text("last_heartbeat_at").notNull(),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    deviceOs: text("device_os", { enum: ["windows", "macos", "linux"] }).notNull(),
    deviceArch: text("device_arch", { enum: ["x86_64", "arm64"] }).notNull(),
    appVersion: text("app_version").notNull(),
    status: text("status", { enum: ["active", "stopped"] }).notNull(),
  },
  (t) => [
    uniqueIndex("idx_one_active_session")
      .on(t.employeeId)
      .where(sql`${t.status} = 'active'`),
    index("idx_work_sessions_employee_started").on(
      t.employeeId,
      sql`${t.startedAt} DESC`
    ),
    index("idx_work_sessions_status_heartbeat").on(t.status, t.lastHeartbeatAt),
    check("chk_work_sessions_duration", sql`${t.durationSeconds} >= 0`),
    check("chk_work_sessions_os", sql`${t.deviceOs} IN ('windows', 'macos', 'linux')`),
    check("chk_work_sessions_arch", sql`${t.deviceArch} IN ('x86_64', 'arm64')`),
    check("chk_work_sessions_status", sql`${t.status} IN ('active', 'stopped')`),
  ]
);

// ============================================================================
// 4. screenshots (Private WebP metadata + 90-day expiry)
// ============================================================================

export const screenshots = sqliteTable(
  "screenshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => workSessions.id, { onDelete: "cascade" }),
    captureType: text("capture_type", { enum: ["random", "on_demand"] }).notNull(),
    captureStatus: text("capture_status", { enum: ["ok", "screen_locked"] }).notNull(),
    requestId: text("request_id"),
    triggeredByAdminId: integer("triggered_by_admin_id").references(() => users.id, {
      onDelete: "set null",
    }),
    storageKey: text("storage_key").unique(),
    fileSizeBytes: integer("file_size_bytes").notNull().default(0),
    width: integer("width").notNull().default(0),
    height: integer("height").notNull().default(0),
    monitorCount: integer("monitor_count").notNull().default(1),
    capturedAt: text("captured_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_screenshots_employee_captured").on(
      t.employeeId,
      sql`${t.capturedAt} DESC`,
      sql`${t.id} DESC`
    ),
    index("idx_screenshots_captured_at").on(
      sql`${t.capturedAt} DESC`,
      sql`${t.id} DESC`
    ),
    index("idx_screenshots_expires_at").on(t.expiresAt),
    index("idx_screenshots_session_id").on(t.sessionId),
    check(
      "chk_screenshots_payload_consistency",
      sql`(${t.captureStatus} = 'ok' AND ${t.storageKey} IS NOT NULL AND ${t.width} > 0 AND ${t.height} > 0 AND ${t.monitorCount} >= 1) OR (${t.captureStatus} = 'screen_locked' AND ${t.storageKey} IS NULL AND ${t.fileSizeBytes} = 0 AND ${t.width} = 0 AND ${t.height} = 0)`
    ),
  ]
);

// ============================================================================
// 5. location_logs (Strict employee consent + 90-day expiry)
// ============================================================================

export const locationLogs = sqliteTable(
  "location_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => workSessions.id, { onDelete: "cascade" }),
    locationEnabled: integer("location_enabled", { mode: "boolean" }).notNull(),
    latitude: real("latitude"),
    longitude: real("longitude"),
    accuracyMeters: real("accuracy_meters"),
    source: text("source", { enum: ["os_native", "ip_approx", "disabled"] }).notNull(),
    recordedAt: text("recorded_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [
    index("idx_location_logs_employee_recorded").on(
      t.employeeId,
      sql`${t.recordedAt} DESC`,
      sql`${t.id} DESC`
    ),
    index("idx_location_logs_expires_at").on(t.expiresAt),
    check(
      "chk_location_logs_consent_privacy",
      sql`(${t.locationEnabled} = 0 AND ${t.latitude} IS NULL AND ${t.longitude} IS NULL AND ${t.accuracyMeters} IS NULL AND ${t.source} = 'disabled') OR (${t.locationEnabled} = 1 AND ${t.latitude} IS NOT NULL AND ${t.longitude} IS NOT NULL AND ${t.latitude} BETWEEN -90.0 AND 90.0 AND ${t.longitude} BETWEEN -180.0 AND 180.0 AND ${t.source} IN ('os_native', 'ip_approx'))`
    ),
  ]
);

// ============================================================================
// 6. salary_reports (Snapshotted rate & worked hours per employee per month)
// ============================================================================

export const salaryReports = sqliteTable(
  "salary_reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    employeeId: integer("employee_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reportMonth: text("report_month").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    totalWorkedSeconds: integer("total_worked_seconds").notNull().default(0),
    salaryTypeSnapshot: text("salary_type_snapshot", {
      enum: ["monthly", "hourly"],
    }).notNull(),
    baseRateSnapshot: real("base_rate_snapshot").notNull(),
    overtimeOrBonus: real("overtime_or_bonus").notNull().default(0),
    deductions: real("deductions").notNull().default(0),
    netPayable: real("net_payable").notNull(),
    currencyCode: text("currency_code").notNull().default("BDT"),
    paymentStatus: text("payment_status", { enum: ["pending", "paid"] })
      .notNull()
      .default("pending"),
    paidAt: text("paid_at"),
    notes: text("notes").notNull().default(""),
    createdByAdminId: integer("created_by_admin_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_salary_reports_emp_month").on(t.employeeId, t.reportMonth),
    index("idx_salary_reports_month_status").on(t.reportMonth, t.paymentStatus),
    check("chk_salary_reports_worked", sql`${t.totalWorkedSeconds} >= 0`),
    check("chk_salary_reports_base_rate", sql`${t.baseRateSnapshot} >= 0`),
    check("chk_salary_reports_bonus", sql`${t.overtimeOrBonus} >= 0`),
    check("chk_salary_reports_deductions", sql`${t.deductions} >= 0`),
    check("chk_salary_reports_net_payable", sql`${t.netPayable} >= 0`),
  ]
);

// ============================================================================
// 7. audit_logs
// ============================================================================

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actorId: integer("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    detailsJson: text("details_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_audit_logs_created_at").on(sql`${t.createdAt} DESC`, sql`${t.id} DESC`),
    index("idx_audit_logs_actor_created").on(t.actorId, sql`${t.createdAt} DESC`),
  ]
);

// ============================================================================
// Inferred Row Types
// ============================================================================

export type AppSettingRow = typeof appSettings.$inferSelect;
export type NewAppSettingRow = typeof appSettings.$inferInsert;

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;

export type WorkSessionRow = typeof workSessions.$inferSelect;
export type NewWorkSessionRow = typeof workSessions.$inferInsert;

export type ScreenshotRow = typeof screenshots.$inferSelect;
export type NewScreenshotRow = typeof screenshots.$inferInsert;

export type LocationLogRow = typeof locationLogs.$inferSelect;
export type NewLocationLogRow = typeof locationLogs.$inferInsert;

export type SalaryReportRow = typeof salaryReports.$inferSelect;
export type NewSalaryReportRow = typeof salaryReports.$inferInsert;

export type AuditLogRow = typeof auditLogs.$inferSelect;
export type NewAuditLogRow = typeof auditLogs.$inferInsert;
