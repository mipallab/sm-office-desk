import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, inArray, lte, lt, or } from "drizzle-orm";
import { z } from "zod";
import {
  BulkDeleteScreenshotsSchema,
  DateYmdSchema,
  formatDatePartsInTimezone,
  getUtcRangeForLocalDate,
  ScreenshotQuerySchema,
} from "@sm-office/shared";
import type { AppConfig } from "../config.js";
import type { AppDb } from "../db/client.js";
import { getAppSettingsRow, writeAuditLog } from "../db/helpers.js";
import { screenshots, users } from "../db/schema.js";
import { createAuthenticateHook, requireAdmin } from "../plugins/auth.js";
import type { StorageDriver } from "../storage/types.js";
import { AppError } from "../utils/errors.js";
import { parsePositiveIntId, parseWithSchema } from "../utils/validation.js";
import type { WsHub } from "../ws/hub.js";

export interface AdminScreenshotsRoutesDeps {
  config: AppConfig;
  sqlite: Database.Database;
  db: AppDb;
  wsHub: WsHub;
  storageDriver: StorageDriver;
}

const CursorPayloadSchema = z.object({
  captured_at: z.string().min(1),
  id: z.number().int().positive(),
});

const ImageDeliveryQuerySchema = z.object({
  delivery: z.enum(["auto", "json", "stream"]).default("auto"),
});

const ScreenshotSummaryQuerySchema = z.object({
  employeeId: z.coerce.number().int().positive().optional(),
  date: DateYmdSchema.optional(),
  type: z.enum(["random", "on_demand", "all"]).default("all"),
  status: z.enum(["ok", "screen_locked", "all"]).default("all"),
});

function encodeCursor(capturedAt: string, id: number): string {
  return Buffer.from(JSON.stringify({ captured_at: capturedAt, id }), "utf8").toString(
    "base64url"
  );
}

function decodeCursor(raw: string): { captured_at: string; id: number } {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return CursorPayloadSchema.parse(parsed);
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid pagination cursor", {
      fieldErrors: { cursor: ["Malformed cursor token"] },
    });
  }
}

export function registerAdminScreenshotsRoutes(
  app: FastifyInstance,
  deps: AdminScreenshotsRoutesDeps
): void {
  const authenticate = createAuthenticateHook(deps.db, deps.config.jwtSecret);

  app.post(
    "/api/admin/employees/:id/capture-now",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.authUser!;
      const params = request.params as { id: string };
      const targetId = parsePositiveIntId(params.id, "id");

      const targetUser = deps.db
        .select()
        .from(users)
        .where(eq(users.id, targetId))
        .get();

      if (!targetUser || targetUser.role !== "employee") {
        throw new AppError(404, "NOT_FOUND", "Employee not found");
      }

      if (!targetUser.isActive) {
        throw new AppError(
          409,
          "ACCOUNT_DISABLED",
          "Cannot capture screenshot for a deactivated employee"
        );
      }

      const result = deps.wsHub.triggerCaptureNow(targetId, actor.id);
      return reply.code(202).send(result);
    }
  );

  app.get(
    "/api/admin/screenshots/summary",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const query = parseWithSchema(ScreenshotSummaryQuerySchema, request.query);
      const settings = getAppSettingsRow(deps.db);
      const tz = settings.companyTimezone;

      const allEmployees = deps.db
        .select({
          id: users.id,
          name: users.name,
          isActive: users.isActive,
        })
        .from(users)
        .where(eq(users.role, "employee"))
        .all()
        .sort((a, b) => {
          if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      const allShots = deps.db
        .select({
          id: screenshots.id,
          employeeId: screenshots.employeeId,
          captureType: screenshots.captureType,
          captureStatus: screenshots.captureStatus,
          capturedAt: screenshots.capturedAt,
        })
        .from(screenshots)
        .orderBy(desc(screenshots.capturedAt), desc(screenshots.id))
        .all();

      const countByEmployee = new Map<number, number>();
      const countByDate = new Map<string, number>();
      const countByHour = new Map<string, number>();
      const typeCounts = {
        all: 0,
        random: 0,
        on_demand: 0,
        screen_locked: 0,
      };

      for (const shot of allShots) {
        countByEmployee.set(
          shot.employeeId,
          (countByEmployee.get(shot.employeeId) ?? 0) + 1
        );

        if (query.employeeId && shot.employeeId !== query.employeeId) {
          continue;
        }

        const local = formatDatePartsInTimezone(shot.capturedAt, tz);
        countByDate.set(local.dateString, (countByDate.get(local.dateString) ?? 0) + 1);

        if (query.date && local.dateString !== query.date) {
          continue;
        }

        typeCounts.all += 1;
        if (shot.captureType === "random") typeCounts.random += 1;
        if (shot.captureType === "on_demand") typeCounts.on_demand += 1;
        if (shot.captureStatus === "screen_locked") typeCounts.screen_locked += 1;

        if (query.type !== "all" && shot.captureType !== query.type) {
          continue;
        }
        if (query.status !== "all" && shot.captureStatus !== query.status) {
          continue;
        }

        countByHour.set(local.hour, (countByHour.get(local.hour) ?? 0) + 1);
      }

      const employees = allEmployees.map((emp) => ({
        employee_id: emp.id,
        employee_name: emp.name,
        is_active: emp.isActive,
        total_count: countByEmployee.get(emp.id) ?? 0,
      }));

      const dates = [...countByDate.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([date, count]) => ({ date, count }));

      const hours = [...countByHour.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([hour, count]) => ({ hour, count }));

      return reply.code(200).send({
        company_timezone: tz,
        employees,
        dates,
        type_counts: typeCounts,
        hours,
      });
    }
  );

  app.get(
    "/api/admin/screenshots",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const query = parseWithSchema(ScreenshotQuerySchema, request.query);
      const settings = getAppSettingsRow(deps.db);
      const tz = settings.companyTimezone;

      const conditions = [];
      if (query.employeeId !== undefined) {
        conditions.push(eq(screenshots.employeeId, query.employeeId));
      }
      if (query.date !== undefined) {
        const { startUtcIso, endUtcIso } = getUtcRangeForLocalDate(
          query.date,
          tz,
          query.hour
        );
        conditions.push(gte(screenshots.capturedAt, startUtcIso));
        conditions.push(lte(screenshots.capturedAt, endUtcIso));
      }
      if (query.type !== "all") {
        conditions.push(eq(screenshots.captureType, query.type));
      }
      if (query.status !== "all") {
        conditions.push(eq(screenshots.captureStatus, query.status));
      }
      if (query.cursor !== undefined) {
        const cursor = decodeCursor(query.cursor);
        conditions.push(
          or(
            lt(screenshots.capturedAt, cursor.captured_at),
            and(
              eq(screenshots.capturedAt, cursor.captured_at),
              lt(screenshots.id, cursor.id)
            )
          )!
        );
      }

      const rows = deps.db
        .select({
          shot: screenshots,
          employeeName: users.name,
        })
        .from(screenshots)
        .innerJoin(users, eq(screenshots.employeeId, users.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(screenshots.capturedAt), desc(screenshots.id))
        .limit(query.limit + 1)
        .all();

      const hasMore = rows.length > query.limit;
      const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
      const lastRow = pageRows[pageRows.length - 1];
      const nextCursor =
        hasMore && lastRow
          ? encodeCursor(lastRow.shot.capturedAt, lastRow.shot.id)
          : null;

      const items = await Promise.all(
        pageRows.map(async ({ shot, employeeName }) => {
          const parts = formatDatePartsInTimezone(shot.capturedAt, tz);
          let presignedUrl: string | null = null;
          let presignedUrlExpiresAt: string | null = null;

          if (
            deps.storageDriver.driverName === "r2" &&
            query.include_presigned &&
            shot.captureStatus === "ok" &&
            shot.storageKey
          ) {
            const access = await deps.storageDriver.getPrivateReadAccess(
              shot.storageKey
            );
            if (access.mode === "presigned_url") {
              presignedUrl = access.url;
              presignedUrlExpiresAt = access.expiresAt;
            }
          }

          return {
            id: shot.id,
            employee_id: shot.employeeId,
            employee_name: employeeName,
            session_id: shot.sessionId,
            capture_type: shot.captureType,
            capture_status: shot.captureStatus,
            request_id: shot.requestId,
            triggered_by_admin_id: shot.triggeredByAdminId,
            monitor_count: shot.monitorCount,
            width: shot.width,
            height: shot.height,
            file_size_bytes: shot.fileSizeBytes,
            captured_at: shot.capturedAt,
            expires_at: shot.expiresAt,
            local_date: parts.dateString,
            local_hour: parts.hour,
            local_time: parts.timeString,
            image_endpoint: `/api/admin/screenshots/${shot.id}/image`,
            presigned_url: presignedUrl,
            presigned_url_expires_at: presignedUrlExpiresAt,
          };
        })
      );

      // Build Employee -> Date -> Hour -> screenshot_ids hierarchy
      const empOrder: number[] = [];
      const empMap = new Map<
        number,
        {
          employee_id: number;
          employee_name: string;
          dateOrder: string[];
          dates: Map<
            string,
            {
              hourOrder: string[];
              hours: Map<string, number[]>;
            }
          >;
        }
      >();

      for (const item of items) {
        let empGroup = empMap.get(item.employee_id);
        if (!empGroup) {
          empGroup = {
            employee_id: item.employee_id,
            employee_name: item.employee_name,
            dateOrder: [],
            dates: new Map(),
          };
          empMap.set(item.employee_id, empGroup);
          empOrder.push(item.employee_id);
        }

        let dateGroup = empGroup.dates.get(item.local_date);
        if (!dateGroup) {
          dateGroup = { hourOrder: [], hours: new Map() };
          empGroup.dates.set(item.local_date, dateGroup);
          empGroup.dateOrder.push(item.local_date);
        }

        let hourIds = dateGroup.hours.get(item.local_hour);
        if (!hourIds) {
          hourIds = [];
          dateGroup.hours.set(item.local_hour, hourIds);
          dateGroup.hourOrder.push(item.local_hour);
        }
        hourIds.push(item.id);
      }

      const grouped = empOrder.map((empId) => {
        const emp = empMap.get(empId)!;
        return {
          employee_id: emp.employee_id,
          employee_name: emp.employee_name,
          dates: emp.dateOrder.map((date) => {
            const dGroup = emp.dates.get(date)!;
            return {
              date,
              hours: dGroup.hourOrder.map((hour) => ({
                hour,
                screenshot_ids: dGroup.hours.get(hour)!,
              })),
            };
          }),
        };
      });

      return reply.code(200).send({
        company_timezone: tz,
        pagination: {
          limit: query.limit,
          next_cursor: nextCursor,
          has_more: hasMore,
        },
        items,
        grouped,
      });
    }
  );

  app.get(
    "/api/admin/screenshots/:id/image",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const params = request.params as { id: string };
      const screenshotId = parsePositiveIntId(params.id, "id");
      const query = parseWithSchema(ImageDeliveryQuerySchema, request.query);

      const shot = deps.db
        .select()
        .from(screenshots)
        .where(eq(screenshots.id, screenshotId))
        .get();

      if (!shot) {
        throw new AppError(404, "NOT_FOUND", "Screenshot not found");
      }

      if (shot.captureStatus === "screen_locked" || !shot.storageKey) {
        throw new AppError(
          404,
          "SCREENSHOT_NO_IMAGE",
          "No image available for a screen-locked capture event"
        );
      }

      const readAccess = await deps.storageDriver.getPrivateReadAccess(shot.storageKey);

      if (readAccess.mode === "stream") {
        reply.header("Content-Type", readAccess.contentType);
        reply.header("Content-Length", String(readAccess.contentLength));
        reply.header("Cache-Control", "private, max-age=3600");
        reply.header("X-Content-Type-Options", "nosniff");
        return reply.code(200).send(readAccess.createStream());
      }

      const wantsJson =
        query.delivery === "json" ||
        (query.delivery === "auto" &&
          Boolean(request.headers.accept?.includes("application/json")));

      if (wantsJson) {
        return reply.code(200).send({
          mode: "presigned_url",
          url: readAccess.url,
          expires_in_seconds: readAccess.expiresInSeconds,
          expires_at: readAccess.expiresAt,
        });
      }

      reply.header("Cache-Control", "private, no-store");
      return reply.redirect(readAccess.url, 302);
    }
  );

  app.delete(
    "/api/admin/screenshots/:id",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.authUser!;
      const params = request.params as { id: string };
      const screenshotId = parsePositiveIntId(params.id, "id");

      const existing = deps.db
        .select()
        .from(screenshots)
        .where(eq(screenshots.id, screenshotId))
        .get();

      if (!existing) {
        throw new AppError(404, "NOT_FOUND", "Screenshot not found");
      }

      if (existing.storageKey !== null) {
        await deps.storageDriver.deleteObject(existing.storageKey);
      }

      const tx = deps.sqlite.transaction(() => {
        deps.db
          .delete(screenshots)
          .where(eq(screenshots.id, screenshotId))
          .run();

        writeAuditLog(deps.db, {
          actorId: actor.id,
          action: "SCREENSHOT_DELETED",
          targetType: "screenshot",
          targetId: screenshotId,
          details: {
            employee_id: existing.employeeId,
            storage_key: existing.storageKey,
            capture_status: existing.captureStatus,
          },
        });
      });

      tx.immediate();
      return reply.code(200).send({ deleted_id: screenshotId });
    }
  );

  app.post(
    "/api/admin/screenshots/bulk-delete",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.authUser!;
      const input = parseWithSchema(BulkDeleteScreenshotsSchema, request.body);
      const uniqueIds = [...new Set(input.ids)];

      const existingRows = deps.db
        .select()
        .from(screenshots)
        .where(inArray(screenshots.id, uniqueIds))
        .all();

      const foundIdSet = new Set(existingRows.map((r) => r.id));
      const deletedIds = uniqueIds.filter((id) => foundIdSet.has(id));
      const notFoundIds = uniqueIds.filter((id) => !foundIdSet.has(id));

      const keysToDelete = existingRows
        .map((r) => r.storageKey)
        .filter((k): k is string => k !== null);

      if (keysToDelete.length > 0) {
        await deps.storageDriver.deleteObjects(keysToDelete);
      }

      if (deletedIds.length > 0) {
        const tx = deps.sqlite.transaction(() => {
          deps.db
            .delete(screenshots)
            .where(inArray(screenshots.id, deletedIds))
            .run();

          writeAuditLog(deps.db, {
            actorId: actor.id,
            action: "SCREENSHOTS_BULK_DELETED",
            targetType: "screenshot",
            targetId: null,
            details: {
              deleted_ids: deletedIds,
              count: deletedIds.length,
            },
          });
        });
        tx.immediate();
      }

      return reply.code(200).send({
        deleted_count: deletedIds.length,
        deleted_ids: deletedIds,
        not_found_ids: notFoundIds,
      });
    }
  );
}
