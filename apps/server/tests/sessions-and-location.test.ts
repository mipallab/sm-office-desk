import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import { locationLogs, workSessions } from "../src/db/schema.js";
import { sweepStaleSessions } from "../src/jobs/maintenance.js";
import {
  createTestServer,
  loginAdmin,
  loginEmployee,
  seedUserDirect,
  type TestServerContext,
} from "./helpers.js";

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS message timeout")), 3000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
    });
  });
}

describe("Work Sessions, Stale Sweeper & Strict Location Consent", () => {
  let ctx: TestServerContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
      ctx = null;
    }
  });

  it("enforces 1 active session per employee, override FORCE_STOP, and stale sweeper", async () => {
    ctx = await createTestServer();
    await seedUserDirect(ctx, {
      name: "Admin",
      email: "admin@sm.test",
      password: "Password123!",
      role: "admin",
    });
    const emp = await seedUserDirect(ctx, {
      name: "Emp One",
      email: "emp1@sm.test",
      password: "Password123!",
      role: "employee",
    });

    const address = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const wsUrl = address.replace("http://", "ws://") + "/ws";

    const { accessToken: tokenDev1 } = await loginEmployee(
      ctx,
      "emp1@sm.test",
      "Password123!",
      "dev_laptop_01"
    );

    // Reject 32-bit arch on session start
    const badArch = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/sessions/start",
      headers: { authorization: `Bearer ${tokenDev1}` },
      payload: {
        device_id: "dev_laptop_01",
        device_os: "linux",
        device_arch: "x86",
        app_version: "1.0.0",
      },
    });
    expect(badArch.statusCode).toBe(400);
    expect(badArch.json().error.code).toBe("UNSUPPORTED_ARCHITECTURE");

    // Start session on dev_laptop_01
    const start1 = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/sessions/start",
      headers: { authorization: `Bearer ${tokenDev1}` },
      payload: {
        device_id: "dev_laptop_01",
        device_os: "linux",
        device_arch: "x86_64",
        app_version: "1.0.0",
      },
    });
    expect(start1.statusCode).toBe(201);
    const sessionId1 = (start1.json() as { session: { id: string } }).session.id;

    // Idempotent same-device start returns 200 with same session id
    const resume1 = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/sessions/start",
      headers: { authorization: `Bearer ${tokenDev1}` },
      payload: {
        device_id: "dev_laptop_01",
        device_os: "linux",
        device_arch: "x86_64",
        app_version: "1.0.0",
      },
    });
    expect(resume1.statusCode).toBe(200);
    expect(resume1.json().session.id).toBe(sessionId1);

    // Connect WS for dev_laptop_01
    const ws1 = await openWs(wsUrl);
    const authOkPromise = nextMessage(ws1);
    ws1.send(
      JSON.stringify({
        type: "auth",
        payload: {
          token: tokenDev1,
          client_type: "desktop",
          device_id: "dev_laptop_01",
          device_os: "linux",
          device_arch: "x86_64",
          app_version: "1.0.0",
        },
      })
    );
    const authOk = await authOkPromise;
    expect(authOk["type"]).toBe("auth_ok");

    // Start from second device without override -> 409 ACTIVE_SESSION_CONFLICT
    const conflict = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/sessions/start",
      headers: { authorization: `Bearer ${tokenDev1}` },
      payload: {
        device_id: "dev_desktop_02",
        device_os: "windows",
        device_arch: "arm64",
        app_version: "1.0.0",
        override_existing: false,
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("ACTIVE_SESSION_CONFLICT");

    // Override from second device -> stops session 1 and sends WS FORCE_STOP to ws1
    const forceStopPromise = nextMessage(ws1);
    const overrideStart = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/sessions/start",
      headers: { authorization: `Bearer ${tokenDev1}` },
      payload: {
        device_id: "dev_desktop_02",
        device_os: "windows",
        device_arch: "arm64",
        app_version: "1.0.0",
        override_existing: true,
      },
    });
    expect(overrideStart.statusCode).toBe(201);
    const sessionId2 = (overrideStart.json() as { session: { id: string } }).session.id;
    expect(sessionId2).not.toBe(sessionId1);

    const forceStopMsg = await forceStopPromise;
    expect(forceStopMsg["type"]).toBe("FORCE_STOP");
    expect((forceStopMsg["payload"] as { reason: string }).reason).toBe(
      "session_overridden"
    );
    ws1.close();

    // Verify stale session sweeper sets ended_at = last_heartbeat_at
    const startedAt = new Date(Date.now() - 600_000).toISOString();
    const lastHb = new Date(Date.now() - 240_000).toISOString();
    ctx.db
      .update(workSessions)
      .set({ startedAt, lastHeartbeatAt: lastHb })
      .where(eq(workSessions.id, sessionId2))
      .run();

    const closedCount = sweepStaleSessions(ctx.db, ctx.wsHub);
    expect(closedCount).toBe(1);

    const swept = ctx.db
      .select()
      .from(workSessions)
      .where(eq(workSessions.id, sessionId2))
      .get();
    expect(swept?.status).toBe("stopped");
    expect(swept?.endedAt).toBe(lastHb);
    expect(swept?.durationSeconds).toBe(360);

    // Heartbeat on stopped session -> 409 SESSION_NOT_ACTIVE
    const staleHbRes = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/sessions/heartbeat",
      headers: { authorization: `Bearer ${tokenDev1}` },
      payload: {
        session_id: sessionId2,
        screen_locked: false,
        location_enabled: false,
        latitude: null,
        longitude: null,
        accuracy_meters: null,
        location_source: "disabled",
      },
    });
    expect(staleHbRes.statusCode).toBe(409);
    expect(staleHbRes.json().error.code).toBe("SESSION_NOT_ACTIVE");
    expect(emp.id).toBeGreaterThan(0);
  });

  it("strictly enforces location consent and blocks server IP geo fallback", async () => {
    ctx = await createTestServer();
    await seedUserDirect(ctx, {
      name: "Admin",
      email: "admin@sm.test",
      password: "Password123!",
      role: "admin",
    });
    const emp = await seedUserDirect(ctx, {
      name: "Nadia Rahman",
      email: "nadia@sm.test",
      password: "Password123!",
      role: "employee",
      designation: "Senior Designer",
    });

    const adminToken = await loginAdmin(ctx, "admin@sm.test", "Password123!");
    const { accessToken: empToken } = await loginEmployee(
      ctx,
      "nadia@sm.test",
      "Password123!"
    );

    const startRes = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/sessions/start",
      headers: { authorization: `Bearer ${empToken}` },
      payload: {
        device_id: "dev_nadia_mac",
        device_os: "macos",
        device_arch: "arm64",
        app_version: "1.0.0",
      },
    });
    const sessionId = (startRes.json() as { session: { id: string } }).session.id;

    // 1. location_enabled=false with non-null coordinates -> 400 LOCATION_CONSENT_VIOLATION
    const consentViolation = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/sessions/heartbeat",
      headers: {
        authorization: `Bearer ${empToken}`,
        "x-forwarded-for": "8.8.8.8",
      },
      payload: {
        session_id: sessionId,
        screen_locked: false,
        location_enabled: false,
        latitude: 23.8103,
        longitude: 90.4125,
        accuracy_meters: 20,
        location_source: "disabled",
      },
    });
    expect(consentViolation.statusCode).toBe(400);
    expect(consentViolation.json().error.code).toBe("LOCATION_CONSENT_VIOLATION");

    // 2. location_enabled=false with location_source='ip_approx' -> 400 LOCATION_CONSENT_VIOLATION
    const sourceViolation = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/sessions/heartbeat",
      headers: { authorization: `Bearer ${empToken}` },
      payload: {
        session_id: sessionId,
        screen_locked: false,
        location_enabled: false,
        latitude: null,
        longitude: null,
        accuracy_meters: null,
        location_source: "ip_approx",
      },
    });
    expect(sourceViolation.statusCode).toBe(400);
    expect(sourceViolation.json().error.code).toBe("LOCATION_CONSENT_VIOLATION");

    // 3. Valid disabled heartbeat -> records disabled log with null coords
    const disabledHb = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/sessions/heartbeat",
      headers: {
        authorization: `Bearer ${empToken}`,
        "x-forwarded-for": "8.8.8.8",
      },
      payload: {
        session_id: sessionId,
        screen_locked: false,
        location_enabled: false,
        latitude: null,
        longitude: null,
        accuracy_meters: null,
        location_source: "disabled",
      },
    });
    expect(disabledHb.statusCode).toBe(200);

    const liveDisabled = await ctx.app.inject({
      method: "GET",
      url: "/api/admin/locations/live",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(liveDisabled.statusCode).toBe(200);
    expect(liveDisabled.json().employees[0]).toMatchObject({
      employee_id: emp.id,
      sharing_enabled: false,
      status: "disabled_by_employee",
      label: "Disabled by Employee",
      latitude: null,
      longitude: null,
      accuracy_meters: null,
      source: "disabled",
    });

    // 4. Employee opts in with OS Native coordinates
    const osNativeHb = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/sessions/heartbeat",
      headers: { authorization: `Bearer ${empToken}` },
      payload: {
        session_id: sessionId,
        screen_locked: false,
        location_enabled: true,
        latitude: 23.8103,
        longitude: 90.4125,
        accuracy_meters: 15,
        location_source: "os_native",
      },
    });
    expect(osNativeHb.statusCode).toBe(200);

    const liveActive = await ctx.app.inject({
      method: "GET",
      url: "/api/admin/locations/live",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(liveActive.json().employees[0]).toMatchObject({
      employee_id: emp.id,
      sharing_enabled: true,
      status: "active",
      label: "OS Native",
      latitude: 23.8103,
      longitude: 90.4125,
      accuracy_meters: 15,
      source: "os_native",
    });

    // 5. Employee toggles sharing OFF -> immediately switches back to Disabled by Employee
    const toggleOffHb = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/sessions/heartbeat",
      headers: { authorization: `Bearer ${empToken}` },
      payload: {
        session_id: sessionId,
        screen_locked: false,
        location_enabled: false,
        latitude: null,
        longitude: null,
        accuracy_meters: null,
        location_source: "disabled",
      },
    });
    expect(toggleOffHb.statusCode).toBe(200);

    const liveToggledOff = await ctx.app.inject({
      method: "GET",
      url: "/api/admin/locations/live",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(liveToggledOff.json().employees[0]).toMatchObject({
      sharing_enabled: false,
      status: "disabled_by_employee",
      label: "Disabled by Employee",
      latitude: null,
      longitude: null,
      source: "disabled",
    });

    const rows = ctx.db
      .select()
      .from(locationLogs)
      .where(eq(locationLogs.employeeId, emp.id))
      .all();
    expect(rows.length).toBe(3);
  });
});
