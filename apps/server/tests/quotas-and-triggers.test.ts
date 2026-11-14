import { afterEach, describe, expect, it } from "vitest";
import { createTestServer, loginAdmin, seedUserDirect, type TestServerContext } from "./helpers.js";

describe("Quotas, SQLite Triggers & Last-Admin Guard", () => {
  let ctx: TestServerContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
      ctx = null;
    }
  });

  it("enforces max 10 active employees while allowing inactive employees above 10", async () => {
    ctx = await createTestServer();
    await seedUserDirect(ctx, {
      name: "Root Admin",
      email: "admin@sm.test",
      password: "Password123!",
      role: "admin",
    });
    const adminToken = await loginAdmin(ctx, "admin@sm.test", "Password123!");

    const createdIds: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/admin/employees",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: `Employee ${i}`,
          email: `emp${i}@sm.test`,
          password: "Password123!",
          role: "employee",
          designation: "Dev",
          salary_type: "monthly",
          base_salary: 35000,
        },
      });
      expect(res.statusCode).toBe(201);
      createdIds.push((res.json() as { user: { id: number } }).user.id);
    }

    // 11th active employee fails via API
    const overLimitRes = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/employees",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: "Employee 11",
        email: "emp11@sm.test",
        password: "Password123!",
        role: "employee",
      },
    });
    expect(overLimitRes.statusCode).toBe(409);
    expect(overLimitRes.json().error.code).toBe("MAX_EMPLOYEES_EXCEEDED");

    // Raw SQLite INSERT must also be blocked atomically by trg_limit_employees_insert
    const nowIso = new Date().toISOString();
    expect(() =>
      ctx!.sqlite
        .prepare(
          `INSERT INTO users (name, email, password_hash, role, is_active, created_at, updated_at)
           VALUES ('Raw 11', 'raw11@sm.test', 'hash', 'employee', 1, ?, ?)`
        )
        .run(nowIso, nowIso)
    ).toThrow(/MAX_EMPLOYEES_EXCEEDED/);

    // Creating an INACTIVE employee succeeds even at 10/10
    const inactiveCreateRes = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/employees",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: "Inactive Emp",
        email: "inactive@sm.test",
        password: "Password123!",
        role: "employee",
        is_active: false,
      },
    });
    expect(inactiveCreateRes.statusCode).toBe(201);
    const inactiveId = (inactiveCreateRes.json() as { user: { id: number } }).user.id;

    // Reactivating inactive employee while 10 active exist fails via API and trigger
    const reactivateFailRes = await ctx.app.inject({
      method: "PATCH",
      url: `/api/admin/employees/${inactiveId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { is_active: true },
    });
    expect(reactivateFailRes.statusCode).toBe(409);
    expect(reactivateFailRes.json().error.code).toBe("MAX_EMPLOYEES_EXCEEDED");

    expect(() =>
      ctx!.sqlite
        .prepare("UPDATE users SET is_active = 1 WHERE id = ?")
        .run(inactiveId)
    ).toThrow(/MAX_EMPLOYEES_EXCEEDED/);

    // Deactivating one active employee frees a slot for reactivation
    const deactRes = await ctx.app.inject({
      method: "PATCH",
      url: `/api/admin/employees/${createdIds[0]}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { is_active: false },
    });
    expect(deactRes.statusCode).toBe(200);
    expect(deactRes.json().quotas.active_employees).toBe(9);

    const reactivateOkRes = await ctx.app.inject({
      method: "PATCH",
      url: `/api/admin/employees/${inactiveId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { is_active: true },
    });
    expect(reactivateOkRes.statusCode).toBe(200);
    expect(reactivateOkRes.json().quotas.active_employees).toBe(10);
  });

  it("enforces max 2 active admins, min 1 active admin, and SELF_ADMIN_LOCKOUT", async () => {
    ctx = await createTestServer();
    const admin1 = await seedUserDirect(ctx, {
      name: "Admin One",
      email: "admin1@sm.test",
      password: "Password123!",
      role: "admin",
    });
    const token1 = await loginAdmin(ctx, "admin1@sm.test", "Password123!");

    // Self-deactivation and self-demotion blocked with SELF_ADMIN_LOCKOUT
    const selfDeact = await ctx.app.inject({
      method: "PATCH",
      url: `/api/admin/employees/${admin1.id}`,
      headers: { authorization: `Bearer ${token1}` },
      payload: { is_active: false },
    });
    expect(selfDeact.statusCode).toBe(409);
    expect(selfDeact.json().error.code).toBe("SELF_ADMIN_LOCKOUT");

    const selfDemote = await ctx.app.inject({
      method: "PATCH",
      url: `/api/admin/employees/${admin1.id}`,
      headers: { authorization: `Bearer ${token1}` },
      payload: { role: "employee" },
    });
    expect(selfDemote.statusCode).toBe(409);
    expect(selfDemote.json().error.code).toBe("SELF_ADMIN_LOCKOUT");

    // Direct SQLite UPDATE/DELETE on last active admin blocked by triggers
    expect(() =>
      ctx!.sqlite
        .prepare("UPDATE users SET is_active = 0 WHERE id = ?")
        .run(admin1.id)
    ).toThrow(/CANNOT_DISABLE_LAST_ADMIN/);

    expect(() =>
      ctx!.sqlite
        .prepare("UPDATE users SET role = 'employee' WHERE id = ?")
        .run(admin1.id)
    ).toThrow(/CANNOT_DISABLE_LAST_ADMIN/);

    expect(() =>
      ctx!.sqlite.prepare("DELETE FROM users WHERE id = ?").run(admin1.id)
    ).toThrow(/CANNOT_DISABLE_LAST_ADMIN/);

    // Add 2nd active admin
    const admin2Res = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/employees",
      headers: { authorization: `Bearer ${token1}` },
      payload: {
        name: "Admin Two",
        email: "admin2@sm.test",
        password: "Password123!",
        role: "admin",
      },
    });
    expect(admin2Res.statusCode).toBe(201);
    expect(admin2Res.json().quotas.active_admins).toBe(2);
    const admin2Id = (admin2Res.json() as { user: { id: number } }).user.id;

    // 3rd active admin blocked via API & raw trigger
    const admin3Res = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/employees",
      headers: { authorization: `Bearer ${token1}` },
      payload: {
        name: "Admin Three",
        email: "admin3@sm.test",
        password: "Password123!",
        role: "admin",
      },
    });
    expect(admin3Res.statusCode).toBe(409);
    expect(admin3Res.json().error.code).toBe("MAX_ADMINS_EXCEEDED");

    const nowIso = new Date().toISOString();
    expect(() =>
      ctx!.sqlite
        .prepare(
          `INSERT INTO users (name, email, password_hash, role, is_active, created_at, updated_at)
           VALUES ('Raw Admin 3', 'rawadmin3@sm.test', 'hash', 'admin', 1, ?, ?)`
        )
        .run(nowIso, nowIso)
    ).toThrow(/MAX_ADMINS_EXCEEDED/);

    // Admin 1 can deactivate Admin 2 cleanly
    const deact2 = await ctx.app.inject({
      method: "PATCH",
      url: `/api/admin/employees/${admin2Id}`,
      headers: { authorization: `Bearer ${token1}` },
      payload: { is_active: false },
    });
    expect(deact2.statusCode).toBe(200);
    expect(deact2.json().quotas.active_admins).toBe(1);
  });
});
