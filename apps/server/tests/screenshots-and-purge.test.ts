import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { MAX_SCREENSHOT_UPLOAD_BYTES } from "@sm-office/shared";
import { locationLogs, screenshots } from "../src/db/schema.js";
import { cleanupOrphanFiles, purgeExpiredData } from "../src/jobs/maintenance.js";
import {
  buildMultipartScreenshotPayload,
  createFakeWebpBuffer,
  createTestServer,
  loginAdmin,
  loginEmployee,
  seedUserDirect,
  type TestServerContext,
} from "./helpers.js";

describe("Screenshots, Timezone Grouping, Private Image Serving & 90-Day Purge", () => {
  let ctx: TestServerContext | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (ctx) {
      await ctx.cleanup();
      ctx = null;
    }
  });

  it("validates WebP magic bytes, 512KB limit, screen_locked zero-file, private serving, and delete/bulk-delete", async () => {
    ctx = await createTestServer();
    await seedUserDirect(ctx, {
      name: "Admin",
      email: "admin@sm.test",
      password: "Password123!",
      role: "admin",
    });
    await seedUserDirect(ctx, {
      name: "Emp One",
      email: "emp@sm.test",
      password: "Password123!",
      role: "employee",
    });

    const adminToken = await loginAdmin(ctx, "admin@sm.test", "Password123!");
    const { accessToken: empToken } = await loginEmployee(
      ctx,
      "emp@sm.test",
      "Password123!"
    );

    const startRes = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/sessions/start",
      headers: { authorization: `Bearer ${empToken}` },
      payload: {
        device_id: "dev_shot_01",
        device_os: "windows",
        device_arch: "x86_64",
        app_version: "1.0.0",
      },
    });
    const sessionId = (startRes.json() as { session: { id: string } }).session.id;

    // 1. Reject non-WebP magic header
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const badMagic = buildMultipartScreenshotPayload(
      {
        session_id: sessionId,
        capture_type: "random",
        capture_status: "ok",
        monitor_count: 1,
        width: 1440,
        height: 900,
        captured_at_client_monotonic_ms: 1000,
      },
      fakePng
    );
    const badMagicRes = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/screenshots",
      headers: {
        authorization: `Bearer ${empToken}`,
        "content-type": badMagic.contentType,
      },
      payload: badMagic.payload,
    });
    expect(badMagicRes.statusCode).toBe(400);
    expect(badMagicRes.json().error.code).toBe("INVALID_SCREENSHOT_PAYLOAD");

    // 2. Reject payload > 512 KB (524289 bytes)
    const oversizedWebp = createFakeWebpBuffer(MAX_SCREENSHOT_UPLOAD_BYTES + 1);
    const tooLarge = buildMultipartScreenshotPayload(
      {
        session_id: sessionId,
        capture_type: "random",
        capture_status: "ok",
        monitor_count: 1,
        width: 1440,
        height: 900,
        captured_at_client_monotonic_ms: 2000,
      },
      oversizedWebp
    );
    const tooLargeRes = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/screenshots",
      headers: {
        authorization: `Bearer ${empToken}`,
        "content-type": tooLarge.contentType,
      },
      payload: tooLarge.payload,
    });
    expect(tooLargeRes.statusCode).toBe(413);
    expect(tooLargeRes.json().error.code).toBe("PAYLOAD_TOO_LARGE");

    // 3. Valid WebP upload -> 201 + private image stream
    const validWebp = createFakeWebpBuffer(2048);
    const validUpload = buildMultipartScreenshotPayload(
      {
        session_id: sessionId,
        capture_type: "random",
        capture_status: "ok",
        monitor_count: 2,
        width: 1440,
        height: 450,
        captured_at_client_monotonic_ms: 3000,
      },
      validWebp
    );
    const uploadRes1 = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/screenshots",
      headers: {
        authorization: `Bearer ${empToken}`,
        "content-type": validUpload.contentType,
      },
      payload: validUpload.payload,
    });
    expect(uploadRes1.statusCode).toBe(201);
    const shotId1 = (uploadRes1.json() as { screenshot: { id: number } }).screenshot.id;

    // Upload a 2nd valid WebP + a screen_locked event
    const uploadRes2 = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/screenshots",
      headers: {
        authorization: `Bearer ${empToken}`,
        "content-type": validUpload.contentType,
      },
      payload: validUpload.payload,
    });
    expect(uploadRes2.statusCode).toBe(201);
    const shotId2 = (uploadRes2.json() as { screenshot: { id: number } }).screenshot.id;

    const lockedPayload = buildMultipartScreenshotPayload({
      session_id: sessionId,
      capture_type: "random",
      capture_status: "screen_locked",
      monitor_count: 0,
      width: 0,
      height: 0,
      captured_at_client_monotonic_ms: 4000,
    });
    const lockedRes = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/screenshots",
      headers: {
        authorization: `Bearer ${empToken}`,
        "content-type": lockedPayload.contentType,
      },
      payload: lockedPayload.payload,
    });
    expect(lockedRes.statusCode).toBe(201);
    const lockedId = (lockedRes.json() as { screenshot: { id: number } }).screenshot.id;

    // Screen locked image endpoint -> 404 SCREENSHOT_NO_IMAGE
    const lockedImgRes = await ctx.app.inject({
      method: "GET",
      url: `/api/admin/screenshots/${lockedId}/image`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(lockedImgRes.statusCode).toBe(404);
    expect(lockedImgRes.json().error.code).toBe("SCREENSHOT_NO_IMAGE");

    // Private image stream requires admin auth
    const unauthImg = await ctx.app.inject({
      method: "GET",
      url: `/api/admin/screenshots/${shotId1}/image`,
    });
    expect(unauthImg.statusCode).toBe(401);

    const empImg = await ctx.app.inject({
      method: "GET",
      url: `/api/admin/screenshots/${shotId1}/image`,
      headers: { authorization: `Bearer ${empToken}` },
    });
    expect(empImg.statusCode).toBe(403);

    const adminImg = await ctx.app.inject({
      method: "GET",
      url: `/api/admin/screenshots/${shotId1}/image`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminImg.statusCode).toBe(200);
    expect(adminImg.headers["content-type"]).toBe("image/webp");
    expect(adminImg.headers["cache-control"]).toBe("private, max-age=3600");
    expect(adminImg.rawPayload.equals(validWebp)).toBe(true);

    // Single delete deletes storage file + DB row
    const shot1Row = ctx.db
      .select()
      .from(screenshots)
      .where(eq(screenshots.id, shotId1))
      .get();
    const shot1File = path.join(ctx.tempDir, "screenshots", shot1Row!.storageKey!);
    expect(fs.existsSync(shot1File)).toBe(true);

    const del1 = await ctx.app.inject({
      method: "DELETE",
      url: `/api/admin/screenshots/${shotId1}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del1.statusCode).toBe(200);
    expect(fs.existsSync(shot1File)).toBe(false);

    // Bulk delete removes remaining items (shotId2 + lockedId) and ignores non-existent IDs
    const shot2Row = ctx.db
      .select()
      .from(screenshots)
      .where(eq(screenshots.id, shotId2))
      .get();
    const shot2File = path.join(ctx.tempDir, "screenshots", shot2Row!.storageKey!);
    expect(fs.existsSync(shot2File)).toBe(true);

    const bulkDel = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/screenshots/bulk-delete",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { ids: [shotId2, lockedId, 99999] },
    });
    expect(bulkDel.statusCode).toBe(200);
    expect(bulkDel.json()).toEqual({
      deleted_count: 2,
      deleted_ids: [shotId2, lockedId],
      not_found_ids: [99999],
    });
    expect(fs.existsSync(shot2File)).toBe(false);
  });

  it("groups storage keys & queries by company_timezone (Asia/Dhaka) and runs 90-day purge + orphan cleanup", async () => {
    ctx = await createTestServer({ companyTimezone: "Asia/Dhaka" });
    await seedUserDirect(ctx, {
      name: "Admin",
      email: "admin@sm.test",
      password: "Password123!",
      role: "admin",
    });
    const emp = await seedUserDirect(ctx, {
      name: "Rahim Ahmed",
      email: "rahim@sm.test",
      password: "Password123!",
      role: "employee",
    });

    // 2026-11-14T19:30:00.000Z == 2026-11-15 01:30:00 in Asia/Dhaka (UTC+06:00)
    vi.useFakeTimers({
      now: new Date("2026-11-14T19:30:00.000Z"),
      toFake: ["Date"],
    });

    const adminToken = await loginAdmin(ctx, "admin@sm.test", "Password123!");
    const { accessToken: empToken } = await loginEmployee(
      ctx,
      "rahim@sm.test",
      "Password123!"
    );

    const startRes = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/sessions/start",
      headers: { authorization: `Bearer ${empToken}` },
      payload: {
        device_id: "dev_tz_01",
        device_os: "linux",
        device_arch: "x86_64",
        app_version: "1.0.0",
      },
    });
    const sessionId = (startRes.json() as { session: { id: string } }).session.id;

    const webpBuf = createFakeWebpBuffer(512);
    const upload = buildMultipartScreenshotPayload(
      {
        session_id: sessionId,
        capture_type: "random",
        capture_status: "ok",
        monitor_count: 1,
        width: 1440,
        height: 900,
        captured_at_client_monotonic_ms: 5000,
      },
      webpBuf
    );

    const upRes = await ctx.app.inject({
      method: "POST",
      url: "/api/tracker/screenshots",
      headers: {
        authorization: `Bearer ${empToken}`,
        "content-type": upload.contentType,
      },
      payload: upload.payload,
    });
    expect(upRes.statusCode).toBe(201);
    const shotRow = ctx.db.select().from(screenshots).get()!;
    expect(shotRow.storageKey?.startsWith(`2026/11/15/emp_${emp.id}/`)).toBe(true);

    // Date=2026-11-15 & hour=01 matches in Asia/Dhaka, while 2026-11-14 does not
    const matchRes = await ctx.app.inject({
      method: "GET",
      url: "/api/admin/screenshots?date=2026-11-15&hour=01",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(matchRes.statusCode).toBe(200);
    expect(matchRes.json().items).toHaveLength(1);
    expect(matchRes.json().items[0]).toMatchObject({
      local_date: "2026-11-15",
      local_hour: "01",
      local_time: "01:30:00",
    });

    const missRes = await ctx.app.inject({
      method: "GET",
      url: "/api/admin/screenshots?date=2026-11-14",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(missRes.json().items).toHaveLength(0);

    // /summary endpoint reflects Asia/Dhaka local dates & hours
    const summaryRes = await ctx.app.inject({
      method: "GET",
      url: `/api/admin/screenshots/summary?employeeId=${emp.id}&date=2026-11-15`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(summaryRes.statusCode).toBe(200);
    expect(summaryRes.json()).toMatchObject({
      company_timezone: "Asia/Dhaka",
      dates: [{ date: "2026-11-15", count: 1 }],
      type_counts: { all: 1, random: 1, on_demand: 0, screen_locked: 0 },
      hours: [{ hour: "01", count: 1 }],
    });

    // Also add an expired screenshot + expired location_log + active future screenshot + orphan file
    vi.useRealTimers();
    const expiredKey = `2026/08/01/emp_${emp.id}/1785542400000_abc123_random.webp`;
    await ctx.storageDriver.putObject(expiredKey, webpBuf, "image/webp");
    const expiredFile = path.join(ctx.tempDir, "screenshots", expiredKey);
    expect(fs.existsSync(expiredFile)).toBe(true);

    const pastExpiredIso = new Date("2026-11-01T00:00:00.000Z").toISOString();
    ctx.db
      .insert(screenshots)
      .values({
        employeeId: emp.id,
        sessionId,
        captureType: "random",
        captureStatus: "ok",
        storageKey: expiredKey,
        fileSizeBytes: webpBuf.length,
        width: 1440,
        height: 900,
        monitorCount: 1,
        capturedAt: "2026-08-01T00:00:00.000Z",
        expiresAt: pastExpiredIso,
        createdAt: "2026-08-01T00:00:00.000Z",
      })
      .run();

    ctx.db
      .insert(locationLogs)
      .values({
        employeeId: emp.id,
        sessionId,
        locationEnabled: false,
        latitude: null,
        longitude: null,
        accuracyMeters: null,
        source: "disabled",
        recordedAt: "2026-08-01T00:00:00.000Z",
        expiresAt: pastExpiredIso,
      })
      .run();

    ctx.db
      .insert(locationLogs)
      .values({
        employeeId: emp.id,
        sessionId,
        locationEnabled: false,
        latitude: null,
        longitude: null,
        accuracyMeters: null,
        source: "disabled",
        recordedAt: "2026-11-14T19:30:00.000Z",
        expiresAt: "2027-02-12T19:30:00.000Z",
      })
      .run();

    const purgeRes = await purgeExpiredData(
      ctx.sqlite,
      ctx.db,
      ctx.storageDriver,
      new Date("2026-11-15T02:00:00.000Z")
    );
    expect(purgeRes.screenshotsDeleted).toBe(1);
    expect(purgeRes.locationsDeleted).toBe(1);
    expect(fs.existsSync(expiredFile)).toBe(false);
    expect(ctx.db.select().from(screenshots).all()).toHaveLength(1);
    expect(ctx.db.select().from(locationLogs).all()).toHaveLength(1);

    // Orphan cleanup: create old orphan file (>24h old) & fresh .tmp- file (<1h old)
    const orphanKey = `2026/10/10/emp_${emp.id}/1791590400000_orph12_random.webp`;
    await ctx.storageDriver.putObject(orphanKey, webpBuf, "image/webp");
    const orphanPath = path.join(ctx.tempDir, "screenshots", orphanKey);
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
    await fsp.utimes(orphanPath, twoDaysAgo, twoDaysAgo);

    const activeShotPath = path.join(ctx.tempDir, "screenshots", shotRow.storageKey!);
    await fsp.utimes(activeShotPath, twoDaysAgo, twoDaysAgo);

    const freshTmpPath = `${activeShotPath}.tmp-1234-5678`;
    await fsp.writeFile(freshTmpPath, webpBuf);

    const orphanRes = await cleanupOrphanFiles(ctx.sqlite, ctx.storageDriver);
    expect(orphanRes.deletedCount).toBe(1);
    expect(fs.existsSync(orphanPath)).toBe(false);
    expect(fs.existsSync(activeShotPath)).toBe(true);
    expect(fs.existsSync(freshTmpPath)).toBe(true);
  });
});
