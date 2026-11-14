import type Database from "better-sqlite3";
import type { SalaryReport, SalaryType } from "@sm-office/shared";
import type { SalaryReportRow } from "../db/schema.js";

interface OverlappingSessionRow {
  started_at: string;
  ended_at: string | null;
  last_heartbeat_at: string;
}

/**
 * Computes total worked seconds for an employee within inclusive UTC bounds `[periodStartIso, periodEndIso]`
 * by clamping every overlapping session to `[periodStart, periodEnd]`.
 */
export function computeWorkedSecondsInPeriod(
  sqlite: Database.Database,
  employeeId: number,
  periodStartIso: string,
  periodEndIso: string
): number {
  const rows = sqlite
    .prepare(
      `SELECT started_at, ended_at, last_heartbeat_at
       FROM work_sessions
       WHERE employee_id = ?
         AND started_at <= ?
         AND COALESCE(ended_at, last_heartbeat_at) >= ?`
    )
    .all(employeeId, periodEndIso, periodStartIso) as OverlappingSessionRow[];

  const periodStartMs = Date.parse(periodStartIso);
  const periodEndMs = Date.parse(periodEndIso);
  let totalSeconds = 0;

  for (const row of rows) {
    const startMs = Date.parse(row.started_at);
    const endIso = row.ended_at ?? row.last_heartbeat_at;
    const endMs = Date.parse(endIso);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;

    const effectiveStart = Math.max(startMs, periodStartMs);
    const effectiveEnd = Math.min(endMs, periodEndMs);
    if (effectiveEnd > effectiveStart) {
      totalSeconds += Math.max(0, Math.floor((effectiveEnd - effectiveStart) / 1000));
    }
  }

  return totalSeconds;
}

export function calculateNetPayable(input: {
  salaryType: SalaryType;
  baseRate: number;
  totalWorkedSeconds: number;
  overtimeOrBonus: number;
  deductions: number;
}): number {
  const gross =
    input.salaryType === "monthly"
      ? input.baseRate
      : (input.totalWorkedSeconds / 3600) * input.baseRate;
  const net = gross + input.overtimeOrBonus - input.deductions;
  return Math.max(0, Math.round(net * 100) / 100);
}

export function toSalaryReportDto(
  row: SalaryReportRow,
  employee: { name: string; email: string; designation: string }
): SalaryReport {
  return {
    id: row.id,
    employee_id: row.employeeId,
    employee_name: employee.name,
    employee_email: employee.email,
    employee_designation: employee.designation,
    report_month: row.reportMonth,
    period_start: row.periodStart,
    period_end: row.periodEnd,
    total_worked_seconds: row.totalWorkedSeconds,
    total_worked_hours: Math.round((row.totalWorkedSeconds / 3600) * 100) / 100,
    salary_type_snapshot: row.salaryTypeSnapshot,
    base_rate_snapshot: row.baseRateSnapshot,
    overtime_or_bonus: row.overtimeOrBonus,
    deductions: row.deductions,
    net_payable: row.netPayable,
    currency_code: row.currencyCode,
    payment_status: row.paymentStatus,
    paid_at: row.paidAt,
    notes: row.notes,
    created_by_admin_id: row.createdByAdminId,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}
