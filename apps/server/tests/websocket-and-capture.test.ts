import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  buildMultipartScreenshotPayload,
  createFakeWebpBuffer,
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

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs: number = 4000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error("Timed out waiting for expected WS message"));
    }, timeoutMs);

    const handler = (data: WebSocket.RawData) => {
      const parsed = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(parsed);
      }
    };
    ws.on("message", handler);
  });
}

function waitForClose(
  ws: WebSocket,
  timeoutMs: number = 4000
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for WS close")),
      timeoutMs
    );
    ws.once("close", (code, reasonBuf) => {
      clearTimeout(timer);
      resolve({ code, reason: reasonBuf.toString("utf8") });
    });
  });
}

describe("WebSocket Hub & On-Demand Capture State Machine", () => {
  let ctx: TestServerContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
      ctx = null;
    }
  });

  it("closes unauthenticated sockets with 4001 and rejects role/arch mismatches with 4003", async () => {
    ctx = await createTestServer({ wsAuthTimeoutMs: 250 });
    await seedUserDirect(ctx, {
      name: "Emp",
      email: "emp@sm.test",
      password: "Password123!",
      role: "employee",
    });
    const { accessToken: empToken } = await loginEmployee(
      ctx,
      "emp@sm.test",
      "Password123!"
    );

    const address = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const wsUrl = address.replace("http://", "ws://") + "/ws";

    // 1. Auth timeout -> 4001
    const silentWs = await openWs(wsUrl);
    const closeInfo = await waitForClose(silentWs, 2000);
    expect(closeInfo.code).toBe(4001);

    // 2. Employee trying admin_web WS -> auth_error + 4003
    const mismatchWs = await openWs(wsUrl);
    const errPromise = waitForMessage(mismatchWs, (m) => m["type"] === "auth_error");
    const closePromise = waitForClose(mismatchWs);
    mismatchWs.send(
      JSON.stringify({
        type: "auth",
        payload: { token: empToken, client_type: "admin_web" },
      })
    );
    const errMsg = await errPromise;
    expect((errMsg["payload"] as { code: string }).code).toBe("FORBIDDEN");
    expect((await closePromise).code).toBe(4003);
  });

  it("relays CAPTURE_NOW end-to-end, enforces 5s cooldown, and broadcasts timeout", async () => {
    ctx = await createTestServer({
      wsAuthTimeoutMs: 2000,
      captureTimeoutMs: 350,
      captureCooldownMs: 5000,
    });
    await seedUserDirect(ctx, {
      name: "Admin",
      email: "admin@sm.test",
      password: "Password123!",
      role: "admin",
    });
    const emp = await seedUserDirect(ctx, {
      name: "Nadia",
      email: "nadia@sm.test",
      password: "Password123!",
      role: "employee",
    });

    const adminToken = await loginAdmin(ctx, "admin@sm.test", "Password123!");
    const { accessToken: empToken } = await loginEmployee(
      ctx,
      "nadia@sm.test",
      "Password123!",
      "dev_nadia_ws"
    );

    const startRes = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/sessions/start",
      headers: { authorization: `Bearer ${empToken}` },
      payload: {
        device_id: "dev_nadia_ws",
        device_os: "macos",
        device_arch: "arm64",
        app_version: "1.0.0",
      },
    });
    const sessionId = (startRes.json() as { session: { id: string } }).session.id;

    const address = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const wsUrl = address.replace("http://", "ws://") + "/ws";

    // Authenticate Admin WS
    const adminWs = await openWs(wsUrl);
    const adminAuthOkP = waitForMessage(adminWs, (m) => m["type"] === "auth_ok");
    adminWs.send(
      JSON.stringify({
        type: "auth",
        payload: { token: adminToken, client_type: "admin_web" },
      })
    );
    const adminAuthOk = await adminAuthOkP;
    expect((adminAuthOk["payload"] as { online_employee_ids: number[] }).online_employee_ids).toContain(
      emp.id
    );

    // Authenticate Desktop WS
    const deskWs = await openWs(wsUrl);
    const deskAuthOkP = waitForMessage(deskWs, (m) => m["type"] === "auth_ok");
    deskWs.send(
      JSON.stringify({
        type: "auth",
        payload: {
          token: empToken,
          client_type: "desktop",
          device_id: "dev_nadia_ws",
          device_os: "macos",
          device_arch: "arm64",
          app_version: "1.0.0",
        },
      })
    );
    const deskAuthOk = await deskAuthOkP;
    expect((deskAuthOk["payload"] as { active_session_id: string }).active_session_id).toBe(
      sessionId
    );

    // Trigger CAPTURE_NOW
    const deskCmdP = waitForMessage(deskWs, (m) => m["type"] === "CAPTURE_NOW");
    const adminPendingP = waitForMessage(
      adminWs,
      (m) =>
        m["type"] === "capture_status" &&
        (m["payload"] as { status?: string }).status === "pending"
    );

    const captureRes = await ctx.app.inject({
      method: "POST",
      url: `/api/admin/employees/${emp.id}/capture-now`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(captureRes.statusCode).toBe(202);
    const requestId = (captureRes.json() as { request_id: string }).request_id;

    const deskCmd = await deskCmdP;
    expect((deskCmd["payload"] as { request_id: string }).request_id).toBe(requestId);
    await adminPendingP;

    // Immediate second call hits 5s cooldown -> 429 CAPTURE_COOLDOWN
    const cooldownRes = await ctx.app.inject({
      method: "POST",
      url: `/api/admin/employees/${emp.id}/capture-now`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(cooldownRes.statusCode).toBe(429);
    expect(cooldownRes.json().error.code).toBe("CAPTURE_COOLDOWN");
    expect(Number(cooldownRes.headers["retry-after"])).toBeGreaterThan(0);

    // Desktop uploads screenshot with matching request_id
    const adminCompletedP = waitForMessage(
      adminWs,
      (m) =>
        m["type"] === "capture_status" &&
        (m["payload"] as { status?: string }).status === "completed"
    );
    const adminReadyP = waitForMessage(adminWs, (m) => m["type"] === "screenshot_ready");

    const upload = buildMultipartScreenshotPayload(
      {
        session_id: sessionId,
        capture_type: "on_demand",
        capture_status: "ok",
        request_id: requestId,
        monitor_count: 1,
        width: 1440,
        height: 900,
        captured_at_client_monotonic_ms: 1234,
      },
      createFakeWebpBuffer(1024)
    );
    const uploadRes = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/screenshots",
      headers: {
        authorization: `Bearer ${empToken}`,
        "content-type": upload.contentType,
      },
      payload: upload.payload,
    });
    expect(uploadRes.statusCode).toBe(201);

    const completedMsg = await adminCompletedP;
    expect((completedMsg["payload"] as { request_id: string }).request_id).toBe(requestId);
    const readyMsg = await adminReadyP;
    expect(
      (readyMsg["payload"] as { screenshot: { request_id: string } }).screenshot.request_id
    ).toBe(requestId);

    adminWs.close();
    deskWs.close();
  });

  it("emits capture_status timeout when desktop does not upload within timeout window", async () => {
    ctx = await createTestServer({
      wsAuthTimeoutMs: 2000,
      captureTimeoutMs: 250,
      captureCooldownMs: 10,
    });
    await seedUserDirect(ctx, {
      name: "Admin",
      email: "admin@sm.test",
      password: "Password123!",
      role: "admin",
    });
    const emp = await seedUserDirect(ctx, {
      name: "Emp",
      email: "emp@sm.test",
      password: "Password123!",
      role: "employee",
    });

    const adminToken = await loginAdmin(ctx, "admin@sm.test", "Password123!");
    const { accessToken: empToken } = await loginEmployee(
      ctx,
      "emp@sm.test",
      "Password123!",
      "dev_timeout_01"
    );

    await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/sessions/start",
      headers: { authorization: `Bearer ${empToken}` },
      payload: {
        device_id: "dev_timeout_01",
        device_os: "linux",
        device_arch: "x86_64",
        app_version: "1.0.0",
      },
    });

    const address = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const wsUrl = address.replace("http://", "ws://") + "/ws";

    const adminWs = await openWs(wsUrl);
    const adminOkP = waitForMessage(adminWs, (m) => m["type"] === "auth_ok");
    adminWs.send(
      JSON.stringify({
        type: "auth",
        payload: { token: adminToken, client_type: "admin_web" },
      })
    );
    await adminOkP;

    const deskWs = await openWs(wsUrl);
    const deskOkP = waitForMessage(deskWs, (m) => m["type"] === "auth_ok");
    deskWs.send(
      JSON.stringify({
        type: "auth",
        payload: {
          token: empToken,
          client_type: "desktop",
          device_id: "dev_timeout_01",
          device_os: "linux",
          device_arch: "x86_64",
          app_version: "1.0.0",
        },
      })
    );
    await deskOkP;

    const timeoutMsgP = waitForMessage(
      adminWs,
      (m) =>
        m["type"] === "capture_status" &&
        (m["payload"] as { status?: string }).status === "timeout",
      3000
    );

    const capRes = await ctx.app.inject({
      method: "POST",
      url: `/api/admin/employees/${emp.id}/capture-now`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(capRes.statusCode).toBe(202);

    const timeoutMsg = await timeoutMsgP;
    expect((timeoutMsg["payload"] as { employee_id: number }).employee_id).toBe(emp.id);

    adminWs.close();
    deskWs.close();
  });
});
