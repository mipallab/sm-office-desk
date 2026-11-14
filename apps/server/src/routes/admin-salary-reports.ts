import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  CreateSalaryReportSchema,
  ExportSalaryReportsQuerySchema,
  getUtcRangeForLocalMonth,
  ListSalaryReportsQuerySchema,
  ReportMonthSchema,
  UpdateSalaryReportSchema,
} from "@sm-office/shared";
import type { AppConfig } from "../config.js";
import type { AppDb } from "../db/client.js";
import { getAppSettingsRow, writeAuditLog } from "../db/helpers.js";
import { salaryReports, users } from "../db/schema.js";
import { createAuthenticateHook, requireAdmin } from "../plugins/auth.js";
import {
  calculateNetPayable,
  computeWorkedSecondsInPeriod,
  toSalaryReportDto,
} from "../services/salary.service.js";
import { AppError } from "../utils/errors.js";
import {
  formatCsvCell,
  parsePositiveIntId,
  parseWithSchema,
} from "../utils/validation.js";

export interface AdminSalaryRoutesDeps {
  config: AppConfig;
  sqlite: Database.Database;
  db: AppDb;
}

const PreviewSalaryQuerySchema = z.object({
  employeeId: z.coerce.number().int().positive(),
  month: ReportMonthSchema,
});

export function registerAdminSalaryRoutes(
  app: FastifyInstance,
  deps: AdminSalaryRoutesDeps
): void {
  const authenticate = createAuthenticateHook(deps.db, deps.config.jwtSecret);

  app.get(
    "/api/admin/salary-reports",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const query = parseWithSchema(ListSalaryReportsQuerySchema, request.query);
      const settings = getAppSettingsRow(deps.db);

      const conditions = [];
      if (query.month !== undefined) {
        conditions.push(eq(salaryReports.reportMonth, query.month));
      }
      if (query.employeeId !== undefined) {
        conditions.push(eq(salaryReports.employeeId, query.employeeId));
      }
      if (query.paymentStatus !== "all") {
        conditions.push(eq(salaryReports.paymentStatus, query.paymentStatus));
      }

      const rows = deps.db
        .select({
          report: salaryReports,
          employeeName: users.name,
          employeeEmail: users.email,
          employeeDesignation: users.designation,
        })
        .from(salaryReports)
        .innerJoin(users, eq(salaryReports.employeeId, users.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(
          desc(salaryReports.reportMonth),
          asc(users.name),
          desc(salaryReports.id)
        )
        .all();

      let pendingCount = 0;
      let paidCount = 0;
      let totalNetPayable = 0;

      const reports = rows.map(
        ({ report, employeeName, employeeEmail, employeeDesignation }) => {
          if (report.paymentStatus === "paid") {
            paidCount += 1;
          } else {
            pendingCount += 1;
          }
          totalNetPayable += report.netPayable;

          return toSalaryReportDto(report, {
            name: employeeName,
            email: employeeEmail,
            designation: employeeDesignation,
          });
        }
      );

      return reply.code(200).send({
        currency_code: settings.currencyCode,
        summary: {
          total_reports: reports.length,
          pending_count: pendingCount,
          paid_count: paidCount,
          total_net_payable: Math.round(totalNetPayable * 100) / 100,
        },
        reports,
      });
    }
  );

  app.get(
    "/api/admin/salary-reports/preview",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const query = parseWithSchema(PreviewSalaryQuerySchema, request.query);
      const settings = getAppSettingsRow(deps.db);

      const employee = deps.db
        .select()
        .from(users)
        .where(eq(users.id, query.employeeId))
        .get();

      if (!employee || employee.role !== "employee") {
        throw new AppError(404, "NOT_FOUND", "Employee not found");
      }

      const { startUtcIso, endUtcIso } = getUtcRangeForLocalMonth(
        query.month,
        settings.companyTimezone
      );
      const totalWorkedSeconds = computeWorkedSecondsInPeriod(
        deps.sqlite,
        employee.id,
        startUtcIso,
        endUtcIso
      );

      const existing = deps.db
        .select({ id: salaryReports.id })
        .from(salaryReports)
        .where(
          and(
            eq(salaryReports.employeeId, employee.id),
            eq(salaryReports.reportMonth, query.month)
          )
        )
        .get();

      return reply.code(200).send({
        employee_id: employee.id,
        report_month: query.month,
        period_start: startUtcIso,
        period_end: endUtcIso,
        total_worked_seconds: totalWorkedSeconds,
        total_worked_hours: Math.round((totalWorkedSeconds / 3600) * 100) / 100,
        salary_type: employee.salaryType,
        base_salary: employee.baseSalary,
        currency_code: settings.currencyCode,
        existing_report_id: existing?.id ?? null,
      });
    }
  );

  app.post(
    "/api/admin/salary-reports",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.authUser!;
      const input = parseWithSchema(CreateSalaryReportSchema, request.body);
      const nowIso = new Date().toISOString();

      const tx = deps.sqlite.transaction(() => {
        const employee = deps.db
          .select()
          .from(users)
          .where(eq(users.id, input.employee_id))
          .get();

        if (!employee || employee.role !== "employee") {
          throw new AppError(404, "NOT_FOUND", "Employee not found");
        }

        const existing = deps.db
          .select({ id: salaryReports.id })
          .from(salaryReports)
          .where(
            and(
              eq(salaryReports.employeeId, employee.id),
              eq(salaryReports.reportMonth, input.report_month)
            )
          )
          .get();

        if (existing) {
          throw new AppError(
            409,
            "SALARY_REPORT_EXISTS",
            "A salary report for this employee and month already exists"
          );
        }

        const settings = getAppSettingsRow(deps.db);
        const { startUtcIso, endUtcIso } = getUtcRangeForLocalMonth(
          input.report_month,
          settings.companyTimezone
        );

        const totalWorkedSeconds = computeWorkedSecondsInPeriod(
          deps.sqlite,
          employee.id,
          startUtcIso,
          endUtcIso
        );

        const netPayable = calculateNetPayable({
          salaryType: employee.salaryType,
          baseRate: employee.baseSalary,
          totalWorkedSeconds,
          overtimeOrBonus: input.overtime_or_bonus,
          deductions: input.deductions,
        });

        const inserted = deps.db
          .insert(salaryReports)
          .values({
            employeeId: employee.id,
            reportMonth: input.report_month,
            periodStart: startUtcIso,
            periodEnd: endUtcIso,
            totalWorkedSeconds,
            salaryTypeSnapshot: employee.salaryType,
            baseRateSnapshot: employee.baseSalary,
            overtimeOrBonus: input.overtime_or_bonus,
            deductions: input.deductions,
            netPayable,
            currencyCode: settings.currencyCode,
            paymentStatus: "pending",
            paidAt: null,
            notes: input.notes,
            createdByAdminId: actor.id,
            createdAt: nowIso,
            updatedAt: nowIso,
          })
          .returning()
          .get();

        writeAuditLog(deps.db, {
          actorId: actor.id,
          action: "SALARY_REPORT_CREATED",
          targetType: "salary_report",
          targetId: inserted.id,
          details: {
            employee_id: employee.id,
            report_month: inserted.reportMonth,
            salary_type_snapshot: inserted.salaryTypeSnapshot,
            base_rate_snapshot: inserted.baseRateSnapshot,
            total_worked_seconds: inserted.totalWorkedSeconds,
            net_payable: inserted.netPayable,
          },
          createdAt: nowIso,
        });

        return toSalaryReportDto(inserted, employee);
      });

      const report = tx.immediate();
      return reply.code(201).send({ report });
    }
  );

  app.patch(
    "/api/admin/salary-reports/:id",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.authUser!;
      const params = request.params as { id: string };
      const reportId = parsePositiveIntId(params.id, "id");
      const input = parseWithSchema(UpdateSalaryReportSchema, request.body);
      const nowIso = new Date().toISOString();

      const tx = deps.sqlite.transaction(() => {
        const existing = deps.db
          .select()
          .from(salaryReports)
          .where(eq(salaryReports.id, reportId))
          .get();

        if (!existing) {
          throw new AppError(404, "NOT_FOUND", "Salary report not found");
        }

        const employee = deps.db
          .select()
          .from(users)
          .where(eq(users.id, existing.employeeId))
          .get();

        if (!employee) {
          throw new AppError(404, "NOT_FOUND", "Employee not found");
        }

        const modifyingFinancials =
          input.overtime_or_bonus !== undefined || input.deductions !== undefined;

        if (
          existing.paymentStatus === "paid" &&
          modifyingFinancials &&
          input.payment_status !== "pending"
        ) {
          throw new AppError(
            409,
            "SALARY_REPORT_PAID_LOCKED",
            "Cannot modify financial fields of a paid salary report without reverting to pending first"
          );
        }

        const nextBonus = input.overtime_or_bonus ?? existing.overtimeOrBonus;
        const nextDeductions = input.deductions ?? existing.deductions;
        const nextNotes = input.notes ?? existing.notes;
        const nextStatus = input.payment_status ?? existing.paymentStatus;

        const nextNetPayable = calculateNetPayable({
          salaryType: existing.salaryTypeSnapshot,
          baseRate: existing.baseRateSnapshot,
          totalWorkedSeconds: existing.totalWorkedSeconds,
          overtimeOrBonus: nextBonus,
          deductions: nextDeductions,
        });

        let nextPaidAt = existing.paidAt;
        if (nextStatus === "paid" && existing.paymentStatus !== "paid") {
          nextPaidAt = nowIso;
        } else if (nextStatus === "pending") {
          nextPaidAt = null;
        }

        const updated = deps.db
          .update(salaryReports)
          .set({
            overtimeOrBonus: nextBonus,
            deductions: nextDeductions,
            netPayable: nextNetPayable,
            notes: nextNotes,
            paymentStatus: nextStatus,
            paidAt: nextPaidAt,
            updatedAt: nowIso,
          })
          .where(eq(salaryReports.id, reportId))
          .returning()
          .get();

        const action =
          nextStatus === "paid" && existing.paymentStatus !== "paid"
            ? "SALARY_REPORT_MARKED_PAID"
            : "SALARY_REPORT_UPDATED";

        writeAuditLog(deps.db, {
          actorId: actor.id,
          action,
          targetType: "salary_report",
          targetId: updated.id,
          details: {
            payment_status: updated.paymentStatus,
            net_payable: updated.netPayable,
          },
          createdAt: nowIso,
        });

        return toSalaryReportDto(updated, employee);
      });

      const report = tx.immediate();
      return reply.code(200).send({ report });
    }
  );

  app.delete(
    "/api/admin/salary-reports/:id",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.authUser!;
      const params = request.params as { id: string };
      const reportId = parsePositiveIntId(params.id, "id");
      const nowIso = new Date().toISOString();

      const tx = deps.sqlite.transaction(() => {
        const existing = deps.db
          .select()
          .from(salaryReports)
          .where(eq(salaryReports.id, reportId))
          .get();

        if (!existing) {
          throw new AppError(404, "NOT_FOUND", "Salary report not found");
        }

        if (existing.paymentStatus === "paid") {
          throw new AppError(
            409,
            "SALARY_REPORT_PAID_LOCKED",
            "Cannot delete a paid salary report"
          );
        }

        deps.db
          .delete(salaryReports)
          .where(eq(salaryReports.id, reportId))
          .run();

        writeAuditLog(deps.db, {
          actorId: actor.id,
          action: "SALARY_REPORT_DELETED",
          targetType: "salary_report",
          targetId: reportId,
          details: {
            deleted_snapshot: existing,
          },
          createdAt: nowIso,
        });
      });

      tx.immediate();
      return reply.code(200).send({ deleted_id: reportId });
    }
  );

  app.get(
    "/api/admin/salary-reports/export",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const query = parseWithSchema(ExportSalaryReportsQuerySchema, request.query);

      const rows = deps.db
        .select({
          report: salaryReports,
          employeeName: users.name,
          employeeEmail: users.email,
          employeeDesignation: users.designation,
        })
        .from(salaryReports)
        .innerJoin(users, eq(salaryReports.employeeId, users.id))
        .where(eq(salaryReports.reportMonth, query.month))
        .orderBy(asc(users.name), asc(salaryReports.id))
        .all();

      const header = [
        "Employee ID",
        "Employee Name",
        "Email",
        "Designation",
        "Month",
        "Period Start (UTC)",
        "Period End (UTC)",
        "Worked Seconds",
        "Worked Hours",
        "Salary Type",
        "Base Rate",
        "Overtime/Bonus",
        "Deductions",
        "Net Payable",
        "Currency",
        "Payment Status",
        "Paid At (UTC)",
        "Notes",
      ];

      const lines = [header.map((col) => formatCsvCell(col)).join(",")];
      for (const { report, employeeName, employeeEmail, employeeDesignation } of rows) {
        const workedHours = Math.round((report.totalWorkedSeconds / 3600) * 100) / 100;
        const cells = [
          report.employeeId,
          employeeName,
          employeeEmail,
          employeeDesignation,
          report.reportMonth,
          report.periodStart,
          report.periodEnd,
          report.totalWorkedSeconds,
          workedHours.toFixed(2),
          report.salaryTypeSnapshot,
          report.baseRateSnapshot.toFixed(2),
          report.overtimeOrBonus.toFixed(2),
          report.deductions.toFixed(2),
          report.netPayable.toFixed(2),
          report.currencyCode,
          report.paymentStatus,
          report.paidAt ?? "",
          report.notes,
        ];
        lines.push(cells.map((cell) => formatCsvCell(cell)).join(","));
      }

      const csvBody = `\uFEFF${lines.join("\r\n")}\r\n`;

      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="salary-report-${query.month}.csv"`
      );
      reply.header("X-Content-Type-Options", "nosniff");
      return reply.code(200).send(csvBody);
    }
  );
}
