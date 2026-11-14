import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { workSessions } from "../src/db/schema.js";
import {
  createTestServer,
  loginAdmin,
  seedUserDirect,
  type TestServerContext,
} from "./helpers.js";

describe("Salary Reports, Month-Boundary Overlap, Snapshots, Paid Lock & CSV Export", () => {
  let ctx: TestServerContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
      ctx = null;
    }
  });

  it("computes timezone-clamped worked hours, preserves snapshots, enforces paid lock, and sanitizes CSV export", async () => {
    ctx = await createTestServer({ companyTimezone: "Asia/Dhaka" });
    await seedUserDirect(ctx, {
      name: "Admin",
      email: "admin@sm.test",
      password: "Password123!",
      role: "admin",
    });

    const hourlyEmp = await seedUserDirect(ctx, {
      name: "Arif Hossain",
      email: "arif@sm.test",
      password: "Password123!",
      role: "employee",
      designation: "QA Engineer",
      salaryType: "hourly",
      baseSalary: 500,
    });

    const monthlyEmp = await seedUserDirect(ctx, {
      name: "Nadia Rahman",
      email: "nadia@sm.test",
      password: "Password123!",
      role: "employee",
      designation: "Senior Designer",
      salaryType: "monthly",
      baseSalary: 45000,
    });

    const adminToken = await loginAdmin(ctx, "admin@sm.test", "Password123!");

    // Asia/Dhaka 2026-11 is [2026-10-31T18:00:00.000Z, 2026-11-30T17:59:59.999Z]
    // Session 1 spans start boundary: 1h before + 2h inside = 7200s inside
    ctx.db
      .insert(workSessions)
      .values({
        id: crypto.randomUUID(),
        employeeId: hourlyEmp.id,
        deviceId: "dev_arif",
        startedAt: "2026-10-31T17:00:00.000Z",
        endedAt: "2026-10-31T20:00:00.000Z",
        lastHeartbeatAt: "2026-10-31T20:00:00.000Z",
        durationSeconds: 10800,
        deviceOs: "linux",
        deviceArch: "x86_64",
        appVersion: "1.0.0",
        status: "stopped",
      })
      .run();

    // Session 2 spans end boundary: 1h inside + 1h after = 3600s inside
    ctx.db
      .insert(workSessions)
      .values({
        id: crypto.randomUUID(),
        employeeId: hourlyEmp.id,
        deviceId: "dev_arif",
        startedAt: "2026-11-30T16:59:59.999Z",
        endedAt: "2026-11-30T19:00:00.000Z",
        lastHeartbeatAt: "2026-11-30T19:00:00.000Z",
        durationSeconds: 7200,
        deviceOs: "linux",
        deviceArch: "x86_64",
        appVersion: "1.0.0",
        status: "stopped",
      })
      .run();

    // Preview confirms 7200 + 3600 = 10800 seconds (3.0 hours)
    const previewRes = await ctx.app.inject({
      method: "GET",
      url: `/api/admin/salary-reports/preview?employeeId=${hourlyEmp.id}&month=2026-11`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(previewRes.statusCode).toBe(200);
    expect(previewRes.json()).toMatchObject({
      employee_id: hourlyEmp.id,
      report_month: "2026-11",
      period_start: "2026-10-31T18:00:00.000Z",
      period_end: "2026-11-30T17:59:59.999Z",
      total_worked_seconds: 10800,
      total_worked_hours: 3,
      salary_type: "hourly",
      base_salary: 500,
      currency_code: "BDT",
      existing_report_id: null,
    });

    // Create hourly report: 3h * 500 + 250 bonus - 50 deduction = 1700
    const hourlyRes = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/salary-reports",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        employee_id: hourlyEmp.id,
        report_month: "2026-11",
        overtime_or_bonus: 250,
        deductions: 50,
        notes: "=SUM(A1:B2)",
      },
    });
    expect(hourlyRes.statusCode).toBe(201);
    const hourlyReportId = hourlyRes.json().report.id as number;
    expect(hourlyRes.json().report).toMatchObject({
      total_worked_seconds: 10800,
      salary_type_snapshot: "hourly",
      base_rate_snapshot: 500,
      net_payable: 1700,
      payment_status: "pending",
    });

    // Duplicate (employee_id, report_month) blocked -> 409 SALARY_REPORT_EXISTS
    const dupRes = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/salary-reports",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        employee_id: hourlyEmp.id,
        report_month: "2026-11",
      },
    });
    expect(dupRes.statusCode).toBe(409);
    expect(dupRes.json().error.code).toBe("SALARY_REPORT_EXISTS");

    // Create monthly report: 45000 + 2000 - 500 = 46500
    const monthlyRes = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/salary-reports",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        employee_id: monthlyEmp.id,
        report_month: "2026-11",
        overtime_or_bonus: 2000,
        deductions: 500,
        notes: "+cmd|' /C calc'!A0",
      },
    });
    expect(monthlyRes.statusCode).toBe(201);
    const monthlyReportId = monthlyRes.json().report.id as number;
    expect(monthlyRes.json().report.net_payable).toBe(46500);

    // Give both employees a raise; historical report snapshots must stay unchanged!
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/admin/employees/${hourlyEmp.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { base_salary: 999 },
    });
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/admin/employees/${monthlyEmp.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { base_salary: 80000 },
    });

    const listRes = await ctx.app.inject({
      method: "GET",
      url: "/api/admin/salary-reports?month=2026-11",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().summary).toEqual({
      total_reports: 2,
      pending_count: 2,
      paid_count: 0,
      total_net_payable: 48200,
    });

    // Mark hourly report as paid
    const markPaidRes = await ctx.app.inject({
      method: "PATCH",
      url: `/api/admin/salary-reports/${hourlyReportId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { payment_status: "paid" },
    });
    expect(markPaidRes.statusCode).toBe(200);
    expect(markPaidRes.json().report.payment_status).toBe("paid");
    expect(markPaidRes.json().report.paid_at).toBeTruthy();

    // Paid report rejects financial edits & delete
    const editPaidRes = await ctx.app.inject({
      method: "PATCH",
      url: `/api/admin/salary-reports/${hourlyReportId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { overtime_or_bonus: 9999 },
    });
    expect(editPaidRes.statusCode).toBe(409);
    expect(editPaidRes.json().error.code).toBe("SALARY_REPORT_PAID_LOCKED");

    const delPaidRes = await ctx.app.inject({
      method: "DELETE",
      url: `/api/admin/salary-reports/${hourlyReportId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(delPaidRes.statusCode).toBe(409);
    expect(delPaidRes.json().error.code).toBe("SALARY_REPORT_PAID_LOCKED");

    // Export CSV: UTF-8 BOM + formula-injection prefix
    const csvRes = await ctx.app.inject({
      method: "GET",
      url: "/api/admin/salary-reports/export?month=2026-11&format=csv",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(csvRes.statusCode).toBe(200);
    expect(csvRes.headers["content-type"]).toContain("text/csv");
    expect(csvRes.body.startsWith("\uFEFF")).toBe(true);
    expect(csvRes.body).toContain("'=SUM(A1:B2)");
    expect(csvRes.body).toContain("'+cmd|' /C calc'!A0");
    expect(csvRes.body).toContain("500.00");
    expect(csvRes.body).toContain("45000.00");

    // Pending report can be deleted cleanly
    const delPendingRes = await ctx.app.inject({
      method: "DELETE",
      url: `/api/admin/salary-reports/${monthlyReportId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(delPendingRes.statusCode).toBe(200);
  });
});
