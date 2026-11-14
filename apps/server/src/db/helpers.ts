import { and, eq, sql } from "drizzle-orm";
import {
  MAX_ACTIVE_ADMINS,
  MAX_ACTIVE_EMPLOYEES,
  type AppSettings,
  type PublicUser,
  type QuotaSummary,
  type WorkSession,
} from "@sm-office/shared";
import type { AppDb } from "./client.js";
import {
  appSettings,
  auditLogs,
  users,
  type AppSettingRow,
  type UserRow,
  type WorkSessionRow,
} from "./schema.js";

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    designation: row.designation,
    salary_type: row.salaryType,
    base_salary: row.baseSalary,
    is_active: row.isActive,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function toWorkSession(row: WorkSessionRow): WorkSession {
  return {
    id: row.id,
    employee_id: row.employeeId,
    device_id: row.deviceId,
    started_at: row.startedAt,
    ended_at: row.endedAt,
    last_heartbeat_at: row.lastHeartbeatAt,
    duration_seconds: row.durationSeconds,
    device_os: row.deviceOs,
    device_arch: row.deviceArch,
    app_version: row.appVersion,
    status: row.status,
  };
}

export function toAppSettings(row: AppSettingRow): AppSettings {
  return {
    id: 1,
    company_name: row.companyName,
    company_timezone: row.companyTimezone,
    currency_code: row.currencyCode,
    retention_days: row.retentionDays,
    updated_at: row.updatedAt,
  };
}

export function getAppSettingsRow(db: AppDb): AppSettingRow {
  const row = db.select().from(appSettings).where(eq(appSettings.id, 1)).get();
  if (!row) {
    throw new Error("Singleton app_settings row (id = 1) is missing");
  }
  return row;
}

export function getQuotaSummary(db: AppDb): QuotaSummary {
  const empRow = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(users)
    .where(and(eq(users.role, "employee"), eq(users.isActive, true)))
    .get();
  const adminRow = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.isActive, true)))
    .get();

  return {
    active_employees: empRow?.count ?? 0,
    max_active_employees: MAX_ACTIVE_EMPLOYEES,
    active_admins: adminRow?.count ?? 0,
    max_active_admins: MAX_ACTIVE_ADMINS,
  };
}

export interface WriteAuditLogInput {
  actorId: number | null;
  action: string;
  targetType: string;
  targetId?: string | number | null;
  details?: Record<string, unknown>;
  createdAt?: string;
}

export function writeAuditLog(db: AppDb, input: WriteAuditLogInput): void {
  db.insert(auditLogs)
    .values({
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId:
        input.targetId !== undefined && input.targetId !== null
          ? String(input.targetId)
          : null,
      detailsJson: JSON.stringify(input.details ?? {}),
      createdAt: input.createdAt ?? new Date().toISOString(),
    })
    .run();
}
