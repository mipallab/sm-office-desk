import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  DeviceArchSchema,
  formatDatePartsInTimezone,
  generateScreenshotStorageKey,
  HEARTBEAT_INTERVAL_SECONDS,
  HEARTBEAT_STALE_TIMEOUT_SECONDS,
  MAX_SCREENSHOT_UPLOAD_BYTES,
  MAX_SCREENSHOT_WIDTH_PX,
  MAX_ULTRAWIDE_SCREENSHOT_WIDTH_PX,
  RANDOM_CAPTURE_MAX_SECONDS,
  RANDOM_CAPTURE_MIN_SECONDS,
  StartSessionSchema,
  StopSessionSchema,
  UploadScreenshotMetaSchema,
  WEBP_QUALITY,
} from "@sm-office/shared";
import type { AppConfig } from "../config.js";
import type { AppDb } from "../db/client.js";
import { getAppSettingsRow, toWorkSession } from "../db/helpers.js";
import { screenshots, workSessions, type WorkSessionRow } from "../db/schema.js";
import { createAuthenticateHook, requireEmployee } from "../plugins/auth.js";
import { processHeartbeat } from "../services/session.service.js";
import type { StorageDriver } from "../storage/types.js";
import { AppError } from "../utils/errors.js";
import { isValidWebpBuffer, parseWithSchema } from "../utils/validation.js";
import type { WsHub } from "../ws/hub.js";

export interface TrackerRoutesDeps {
  config: AppConfig;
  sqlite: Database.Database;
  db: AppDb;
  wsHub: WsHub;
  storageDriver: StorageDriver;
}

const SESSION_CONFIG = {
  heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
  random_capture_min_seconds: RANDOM_CAPTURE_MIN_SECONDS,
  random_capture_max_seconds: RANDOM_CAPTURE_MAX_SECONDS,
  max_screenshot_width_px: MAX_SCREENSHOT_WIDTH_PX,
  max_ultrawide_screenshot_width_px: MAX_ULTRAWIDE_SCREENSHOT_WIDTH_PX,
  webp_quality: WEBP_QUALITY,
};

export function registerTrackerRoutes(
  app: FastifyInstance,
  deps: TrackerRoutesDeps
): void {
  const authenticate = createAuthenticateHook(deps.db, deps.config.jwtSecret);

  app.post(
    "/api/tracker/sessions/start",
    { preHandler: [authenticate, requireEmployee] },
    async (request, reply) => {
      const authUser = request.authUser!;
      const rawBody =
        request.body && typeof request.body === "object"
          ? (request.body as Record<string, unknown>)
          : {};

      if (
        typeof rawBody["device_arch"] === "string" &&
        !DeviceArchSchema.safeParse(rawBody["device_arch"]).success
      ) {
        throw new AppError(
          400,
          "UNSUPPORTED_ARCHITECTURE",
          "Desktop tracker only supports 64-bit x86_64 or arm64 architectures"
        );
      }

      const input = parseWithSchema(StartSessionSchema, request.body);
      const now = new Date();
      const nowMs = now.getTime();
      const nowIso = now.toISOString();
      const staleCutoffMs = HEARTBEAT_STALE_TIMEOUT_SECONDS * 1000;

      const tx = deps.sqlite.transaction(() => {
        const active = deps.db
          .select()
          .from(workSessions)
          .where(
            and(
              eq(workSessions.employeeId, authUser.id),
              eq(workSessions.status, "active")
            )
          )
          .get();

        let overriddenSession: WorkSessionRow | null = null;
        let closedStaleSession: WorkSessionRow | null = null;

        if (active) {
          const lastHbMs = Date.parse(active.lastHeartbeatAt);
          const isStale = nowMs - lastHbMs > staleCutoffMs;

          if (isStale) {
            const staleEndedAt = active.lastHeartbeatAt;
            const staleDuration = Math.max(
              0,
              Math.floor((lastHbMs - Date.parse(active.startedAt)) / 1000)
            );
            closedStaleSession = deps.db
              .update(workSessions)
              .set({
                status: "stopped",
                endedAt: staleEndedAt,
                durationSeconds: staleDuration,
              })
              .where(eq(workSessions.id, active.id))
              .returning()
              .get();
          } else if (active.deviceId === input.device_id) {
            return {
              statusCode: 200 as const,
              session: active,
              overriddenSession: null,
              closedStaleSession: null,
            };
          } else if (!input.override_existing) {
            throw new AppError(
              409,
              "ACTIVE_SESSION_CONFLICT",
              "Employee already has an active session on another device",
              {
                active_session_id: active.id,
                active_device_id: active.deviceId,
                active_device_os: active.deviceOs,
                started_at: active.startedAt,
              }
            );
          } else {
            const overrideDuration = Math.max(
              0,
              Math.floor((nowMs - Date.parse(active.startedAt)) / 1000)
            );
            overriddenSession = deps.db
              .update(workSessions)
              .set({
                status: "stopped",
                endedAt: nowIso,
                durationSeconds: overrideDuration,
              })
              .where(eq(workSessions.id, active.id))
              .returning()
              .get();
          }
        }

        const inserted = deps.db
          .insert(workSessions)
          .values({
            id: crypto.randomUUID(),
            employeeId: authUser.id,
            deviceId: input.device_id,
            startedAt: nowIso,
            endedAt: null,
            lastHeartbeatAt: nowIso,
            durationSeconds: 0,
            deviceOs: input.device_os,
            deviceArch: input.device_arch,
            appVersion: input.app_version,
            status: "active",
          })
          .returning()
          .get();

        return {
          statusCode: 201 as const,
          session: inserted,
          overriddenSession,
          closedStaleSession,
        };
      });

      const result = tx.immediate();

      if (result.overriddenSession) {
        deps.wsHub.forceStopDevice(
          authUser.id,
          result.overriddenSession.deviceId,
          result.overriddenSession.id,
          "session_overridden",
          "Your timer was stopped because a new session started on another device"
        );
      }

      if (result.statusCode === 201) {
        deps.wsHub.setPresence(authUser.id, {
          screenLocked: false,
          locationEnabled: false,
        });
        deps.wsHub.broadcastToAdmins({
          type: "employee_status",
          payload: {
            employee_id: authUser.id,
            is_online: true,
            ws_connected: deps.wsHub.isDesktopConnected(authUser.id),
            session_id: result.session.id,
            device_id: result.session.deviceId,
            device_os: result.session.deviceOs,
            device_arch: result.session.deviceArch,
            screen_locked: false,
            started_at: result.session.startedAt,
            last_heartbeat_at: result.session.lastHeartbeatAt,
            reason: "session_started",
          },
        });
      }

      return reply.code(result.statusCode).send({
        session: toWorkSession(result.session),
        server_time_utc: nowIso,
        config: SESSION_CONFIG,
      });
    }
  );

  app.post(
    "/api/tracker/sessions/heartbeat",
    { preHandler: [authenticate, requireEmployee] },
    async (request, reply) => {
      const authUser = request.authUser!;
      const res = processHeartbeat(request.body, authUser.id, deps.db, deps.wsHub);
      return reply.code(200).send(res);
    }
  );

  app.post(
    "/api/tracker/sessions/stop",
    { preHandler: [authenticate, requireEmployee] },
    async (request, reply) => {
      const authUser = request.authUser!;
      const input = parseWithSchema(StopSessionSchema, request.body);

      const session = deps.db
        .select()
        .from(workSessions)
        .where(eq(workSessions.id, input.session_id))
        .get();

      if (!session || session.employeeId !== authUser.id) {
        throw new AppError(404, "NOT_FOUND", "Work session not found");
      }

      if (session.status === "stopped") {
        return reply.code(200).send({ session: toWorkSession(session) });
      }

      const nowIso = new Date().toISOString();
      const durationSeconds = Math.max(
        0,
        Math.floor((Date.parse(nowIso) - Date.parse(session.startedAt)) / 1000)
      );

      const stopped = deps.db
        .update(workSessions)
        .set({
          status: "stopped",
          endedAt: nowIso,
          durationSeconds,
        })
        .where(eq(workSessions.id, session.id))
        .returning()
        .get();

      deps.wsHub.clearPresence(authUser.id);
      deps.wsHub.broadcastToAdmins({
        type: "employee_status",
        payload: {
          employee_id: authUser.id,
          is_online: false,
          ws_connected: deps.wsHub.isDesktopConnected(authUser.id),
          session_id: stopped.id,
          device_id: stopped.deviceId,
          device_os: stopped.deviceOs,
          device_arch: stopped.deviceArch,
          screen_locked: false,
          started_at: stopped.startedAt,
          last_heartbeat_at: stopped.lastHeartbeatAt,
          reason: input.reason,
        },
      });

      return reply.code(200).send({ session: toWorkSession(stopped) });
    }
  );

  app.post(
    "/api/tracker/screenshots",
    { preHandler: [authenticate, requireEmployee] },
    async (request, reply) => {
      const authUser = request.authUser!;

      if (!request.isMultipart()) {
        throw new AppError(
          400,
          "INVALID_SCREENSHOT_PAYLOAD",
          "Screenshot upload requires multipart/form-data"
        );
      }

      const fields: Record<string, string> = {};
      let fileBuffer: Buffer | null = null;

      for await (const part of request.parts()) {
        if (part.type === "field") {
          fields[part.fieldname] = String(part.value ?? "");
        } else if (part.type === "file") {
          const buf = await part.toBuffer();
          if (part.fieldname === "file") {
            fileBuffer = buf;
          }
        }
      }

      if (fileBuffer && fileBuffer.length > MAX_SCREENSHOT_UPLOAD_BYTES) {
        throw new AppError(
          413,
          "PAYLOAD_TOO_LARGE",
          "Uploaded screenshot exceeds the 512 KB maximum limit"
        );
      }

      const normalizedRequestId =
        fields["request_id"] && fields["request_id"].trim().length > 0
          ? fields["request_id"].trim()
          : null;

      const metaParsed = UploadScreenshotMetaSchema.safeParse({
        session_id: fields["session_id"],
        capture_type: fields["capture_type"],
        capture_status: fields["capture_status"],
        request_id: normalizedRequestId,
        monitor_count: fields["monitor_count"],
        width: fields["width"],
        height: fields["height"],
        captured_at_client_monotonic_ms: fields["captured_at_client_monotonic_ms"],
      });

      if (!metaParsed.success) {
        const hasRequestIdError = metaParsed.error.issues.some((i) =>
          i.path.includes("request_id")
        );
        if (hasRequestIdError) {
          throw new AppError(
            400,
            "INVALID_SCREENSHOT_PAYLOAD",
            metaParsed.error.issues[0]?.message ?? "Invalid request_id",
            { fieldErrors: metaParsed.error.flatten().fieldErrors }
          );
        }
        throw metaParsed.error;
      }

      const meta = metaParsed.data;

      if (meta.capture_status === "ok") {
        if (!fileBuffer || fileBuffer.length === 0) {
          throw new AppError(
            400,
            "INVALID_SCREENSHOT_PAYLOAD",
            "WebP image file is required when capture_status is ok"
          );
        }
        if (!isValidWebpBuffer(fileBuffer)) {
          throw new AppError(
            400,
            "INVALID_SCREENSHOT_PAYLOAD",
            "Uploaded file does not have a valid RIFF/WEBP header"
          );
        }
      } else if (fileBuffer && fileBuffer.length > 0) {
        throw new AppError(
          400,
          "INVALID_SCREENSHOT_PAYLOAD",
          "Image file must be omitted or empty when capture_status is screen_locked"
        );
      }

      // Accepts stopped sessions too so encrypted offline retry queues flush cleanly
      const session = deps.db
        .select()
        .from(workSessions)
        .where(eq(workSessions.id, meta.session_id))
        .get();

      if (!session || session.employeeId !== authUser.id) {
        throw new AppError(404, "NOT_FOUND", "Work session not found");
      }

      const settings = getAppSettingsRow(deps.db);
      const capturedAt = new Date();
      const capturedAtIso = capturedAt.toISOString();
      const expiresAtIso = new Date(
        capturedAt.getTime() + settings.retentionDays * 86_400_000
      ).toISOString();

      const triggeredByAdminId =
        meta.capture_type === "on_demand" && meta.request_id
          ? deps.wsHub.getPendingCaptureAdminId(meta.request_id, authUser.id)
          : null;

      let storageKey: string | null = null;
      let fileSizeBytes = 0;

      if (meta.capture_status === "ok" && fileBuffer) {
        storageKey = generateScreenshotStorageKey({
          employeeId: authUser.id,
          captureType: meta.capture_type,
          capturedAt,
          companyTimezone: settings.companyTimezone,
        });
        fileSizeBytes = fileBuffer.length;
        await deps.storageDriver.putObject(storageKey, fileBuffer, "image/webp");
      }

      let inserted;
      try {
        inserted = deps.db
          .insert(screenshots)
          .values({
            employeeId: authUser.id,
            sessionId: session.id,
            captureType: meta.capture_type,
            captureStatus: meta.capture_status,
            requestId: meta.request_id ?? null,
            triggeredByAdminId,
            storageKey,
            fileSizeBytes,
            width: meta.capture_status === "ok" ? meta.width : 0,
            height: meta.capture_status === "ok" ? meta.height : 0,
            monitorCount: meta.monitor_count,
            capturedAt: capturedAtIso,
            expiresAt: expiresAtIso,
            createdAt: capturedAtIso,
          })
          .returning()
          .get();
      } catch (err) {
        if (storageKey) {
          await deps.storageDriver.deleteObject(storageKey).catch(() => {});
        }
        throw err;
      }

      if (meta.capture_type === "on_demand" && meta.request_id) {
        deps.wsHub.completePendingCapture(
          meta.request_id,
          authUser.id,
          inserted.id,
          inserted.captureStatus
        );
      }

      const localParts = formatDatePartsInTimezone(
        capturedAt,
        settings.companyTimezone
      );
      const imageEndpoint = `/api/admin/screenshots/${inserted.id}/image`;
      let presignedUrl: string | null = null;
      if (
        deps.storageDriver.driverName === "r2" &&
        inserted.captureStatus === "ok" &&
        inserted.storageKey
      ) {
        const readAccess = await deps.storageDriver.getPrivateReadAccess(
          inserted.storageKey
        );
        if (readAccess.mode === "presigned_url") {
          presignedUrl = readAccess.url;
        }
      }

      deps.wsHub.broadcastToAdmins({
        type: "screenshot_ready",
        payload: {
          screenshot: {
            id: inserted.id,
            employee_id: inserted.employeeId,
            session_id: inserted.sessionId,
            capture_type: inserted.captureType,
            capture_status: inserted.captureStatus,
            request_id: inserted.requestId,
            monitor_count: inserted.monitorCount,
            width: inserted.width,
            height: inserted.height,
            file_size_bytes: inserted.fileSizeBytes,
            captured_at: inserted.capturedAt,
            local_date: localParts.dateString,
            local_hour: localParts.hour,
            image_endpoint: imageEndpoint,
            presigned_url: presignedUrl,
          },
        },
      });

      return reply.code(201).send({
        screenshot: {
          id: inserted.id,
          employee_id: inserted.employeeId,
          session_id: inserted.sessionId,
          capture_type: inserted.captureType,
          capture_status: inserted.captureStatus,
          request_id: inserted.requestId,
          triggered_by_admin_id: inserted.triggeredByAdminId,
          monitor_count: inserted.monitorCount,
          width: inserted.width,
          height: inserted.height,
          file_size_bytes: inserted.fileSizeBytes,
          captured_at: inserted.capturedAt,
          expires_at: inserted.expiresAt,
        },
      });
    }
  );
}
