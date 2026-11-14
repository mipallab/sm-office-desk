import { afterEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/utils/crypto.js";
import {
  createTestServer,
  loginAdmin,
  loginEmployee,
  seedUserDirect,
  type TestServerContext,
} from "./helpers.js";

describe("Authentication, Scrypt, Architecture Guard & Token Revocation", () => {
  let ctx: TestServerContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
      ctx = null;
    }
  });

  it("hashes and verifies passwords via scrypt and constant-time compare", async () => {
    const hash = await hashPassword("SuperSecret123!");
    expect(hash.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(await verifyPassword("SuperSecret123!", hash)).toBe(true);
    expect(await verifyPassword("WrongPassword!", hash)).toBe(false);
    expect(await verifyPassword("SuperSecret123!", "invalid$format")).toBe(false);
  });

  it("enforces role separation, 64-bit desktop architecture, and token_version revocation", async () => {
    ctx = await createTestServer({ loginRateLimitMaxAttempts: 4 });
    await seedUserDirect(ctx, {
      name: "Admin User",
      email: "admin@sm.test",
      password: "Password123!",
      role: "admin",
    });
    const emp = await seedUserDirect(ctx, {
      name: "Emp User",
      email: "emp@sm.test",
      password: "Password123!",
      role: "employee",
    });

    // Reject 32-bit architectures on desktop login
    for (const badArch of ["i686", "x86", "ia32"]) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          email: "emp@sm.test",
          password: "Password123!",
          client_type: "desktop",
          device_id: "dev_32bit_check",
          device_arch: badArch,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("UNSUPPORTED_ARCHITECTURE");
    }

    // Reject role mismatches
    const empOnAdminWeb = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "emp@sm.test",
        password: "Password123!",
        client_type: "admin_web",
      },
    });
    expect(empOnAdminWeb.statusCode).toBe(403);
    expect(empOnAdminWeb.json().error.code).toBe("FORBIDDEN");

    const adminOnDesktop = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "admin@sm.test",
        password: "Password123!",
        client_type: "desktop",
        device_id: "dev_admin_try",
        device_arch: "arm64",
      },
    });
    expect(adminOnDesktop.statusCode).toBe(403);
    expect(adminOnDesktop.json().error.code).toBe("FORBIDDEN");

    // Employee token works on /api/auth/me and fails on /api/admin/*
    const { accessToken: empToken, refreshToken: empRefresh } = await loginEmployee(
      ctx,
      "emp@sm.test",
      "Password123!"
    );
    const meRes = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${empToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().user.email).toBe("emp@sm.test");

    const adminRouteAttempt = await ctx.app.inject({
      method: "GET",
      url: "/api/admin/employees",
      headers: { authorization: `Bearer ${empToken}` },
    });
    expect(adminRouteAttempt.statusCode).toBe(403);
    expect(adminRouteAttempt.json().error.code).toBe("FORBIDDEN");

    // Logout all_devices immediately revokes both access and refresh tokens
    const logoutRes = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { authorization: `Bearer ${empToken}` },
      payload: { all_devices: true },
    });
    expect(logoutRes.statusCode).toBe(200);

    const revokedMe = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${empToken}` },
    });
    expect(revokedMe.statusCode).toBe(401);
    expect(revokedMe.json().error.code).toBe("TOKEN_REVOKED");

    const revokedRefresh = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refresh_token: empRefresh },
    });
    expect(revokedRefresh.statusCode).toBe(401);
    expect(revokedRefresh.json().error.code).toBe("TOKEN_REVOKED");

    // Re-login, then deactivate employee -> immediate TOKEN_REVOKED + 403 ACCOUNT_DISABLED
    const adminToken = await loginAdmin(ctx, "admin@sm.test", "Password123!");
    const { accessToken: empToken2 } = await loginEmployee(
      ctx,
      "emp@sm.test",
      "Password123!"
    );

    const deactRes = await ctx.app.inject({
      method: "PATCH",
      url: `/api/admin/employees/${emp.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { is_active: false },
    });
    expect(deactRes.statusCode).toBe(200);

    const afterDeactMe = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${empToken2}` },
    });
    expect(afterDeactMe.statusCode).toBe(401);
    expect(afterDeactMe.json().error.code).toBe("TOKEN_REVOKED");

    const disabledLogin = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "emp@sm.test",
        password: "Password123!",
        client_type: "desktop",
        device_id: "dev_test_0001",
        device_arch: "x86_64",
      },
    });
    expect(disabledLogin.statusCode).toBe(403);
    expect(disabledLogin.json().error.code).toBe("ACCOUNT_DISABLED");
  });

  it("rate limits repeated failed logins with 429 and Retry-After", async () => {
    ctx = await createTestServer({ loginRateLimitMaxAttempts: 3 });
    await seedUserDirect(ctx, {
      name: "Admin User",
      email: "ratelimit@sm.test",
      password: "Password123!",
      role: "admin",
    });

    for (let i = 0; i < 3; i++) {
      const bad = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          email: "ratelimit@sm.test",
          password: "WrongPassword!",
          client_type: "admin_web",
        },
      });
      expect(bad.statusCode).toBe(401);
    }

    const blocked = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "ratelimit@sm.test",
        password: "Password123!",
        client_type: "admin_web",
      },
    });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });
});
