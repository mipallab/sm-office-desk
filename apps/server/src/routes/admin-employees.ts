import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  CreateUserSchema,
  formatDatePartsInTimezone,
  ListUsersQuerySchema,
  MAX_ACTIVE_ADMINS,
  MAX_ACTIVE_EMPLOYEES,
  UpdateUserSchema,
  type LiveEmployeeSessionStatus,
} from "@sm-office/shared";
import type { AppConfig } from "../config.js";
import type { AppDb } from "../db/client.js";
import {
  getAppSettingsRow,
  getQuotaSummary,
  toPublicUser,
  writeAuditLog,
} from "../db/helpers.js";
import { users, workSessions, type UserRow } from "../db/schema.js";
import { createAuthenticateHook, requireAdmin } from "../plugins/auth.js";
import { computeTodayWorkedSecondsMap } from "../services/session.service.js";
import type { StorageDriver } from "../storage/types.js";
import { hashPassword } from "../utils/crypto.js";
import { AppError } from "../utils/errors.js";
import { parsePositiveIntId, parseWithSchema } from "../utils/validation.js";
import type { WsHub } from "../ws/hub.js";

export interface AdminEmployeesRoutesDeps {
  config: AppConfig;
  sqlite: Database.Database;
  db: AppDb;
  wsHub: WsHub;
  storageDriver: StorageDriver;
}

interface LatestScreenshotRaw {
  id: number;
  employee_id: number;
  capture_type: "random" | "on_demand";
  capture_status: "ok" | "screen_locked";
  storage_key: string | null;
  monitor_count: number;
  width: number;
  height: number;
  file_size_bytes: number;
  captured_at: string;
}

export function registerAdminEmployeesRoutes(
  app: FastifyInstance,
  deps: AdminEmployeesRoutesDeps
): void {
  const authenticate = createAuthenticateHook(deps.db, deps.config.jwtSecret);

  app.get(
    "/api/admin/employees",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const query = parseWithSchema(ListUsersQuerySchema, request.query);
      const settings = getAppSettingsRow(deps.db);
      const quotas = getQuotaSummary(deps.db);

      const conditions = [];
      if (query.role !== "all") {
        conditions.push(eq(users.role, query.role));
      }
      if (query.status === "active") {
        conditions.push(eq(users.isActive, true));
      } else if (query.status === "inactive") {
        conditions.push(eq(users.isActive, false));
      }

      let rows = deps.db
        .select()
        .from(users)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(users.id))
        .all();

      if (query.search) {
        const needle = query.search.toLowerCase();
        rows = rows.filter(
          (u) =>
            u.name.toLowerCase().includes(needle) ||
            u.email.toLowerCase().includes(needle) ||
            u.designation.toLowerCase().includes(needle)
        );
      }

      const activeSessions = deps.db
        .select()
        .from(workSessions)
        .where(eq(workSessions.status, "active"))
        .all();
      const activeSessionByEmp = new Map(
        activeSessions.map((s) => [s.employeeId, s])
      );

      const todayWorkedMap = computeTodayWorkedSecondsMap(
        deps.sqlite,
        settings.companyTimezone
      );

      const latestRows = deps.sqlite
        .prepare(
          `SELECT id, employee_id, capture_type, capture_status, storage_key,
                  monitor_count, width, height, file_size_bytes, captured_at
           FROM (
             SELECT s.*,
                    ROW_NUMBER() OVER (
                      PARTITION BY s.employee_id
                      ORDER BY s.captured_at DESC, s.id DESC
                    ) AS rn
             FROM screenshots s
           )
           WHERE rn = 1`
        )
        .all() as LatestScreenshotRaw[];

      const latestByEmp = new Map<
        number,
        {
          id: number;
          capture_type: "random" | "on_demand";
          capture_status: "ok" | "screen_locked";
          monitor_count: number;
          width: number;
          height: number;
          file_size_bytes: number;
          captured_at: string;
          local_date: string;
          local_hour: string;
          local_time: string;
          image_endpoint: string;
          presigned_url: string | null;
          presigned_url_expires_at: string | null;
        }
      >();

      await Promise.all(
        latestRows.map(async (row) => {
          const parts = formatDatePartsInTimezone(
            row.captured_at,
            settings.companyTimezone
          );
          let presignedUrl: string | null = null;
          let presignedExpiresAt: string | null = null;
          if (
            deps.storageDriver.driverName === "r2" &&
            row.capture_status === "ok" &&
            row.storage_key
          ) {
            const access = await deps.storageDriver.getPrivateReadAccess(
              row.storage_key
            );
            if (access.mode === "presigned_url") {
              presignedUrl = access.url;
              presignedExpiresAt = access.expiresAt;
            }
          }

          latestByEmp.set(row.employee_id, {
            id: row.id,
            capture_type: row.capture_type,
            capture_status: row.capture_status,
            monitor_count: row.monitor_count,
            width: row.width,
            height: row.height,
            file_size_bytes: row.file_size_bytes,
            captured_at: row.captured_at,
            local_date: parts.dateString,
            local_hour: parts.hour,
            local_time: parts.timeString,
            image_endpoint: `/api/admin/screenshots/${row.id}/image`,
            presigned_url: presignedUrl,
            presigned_url_expires_at: presignedExpiresAt,
          });
        })
      );

      const formattedUsers = rows.map((user) => {
        let liveStatus: LiveEmployeeSessionStatus | null = null;
        if (user.role === "employee") {
          const session = activeSessionByEmp.get(user.id);
          const wsConnected = deps.wsHub.isDesktopConnected(user.id);
          const presence = deps.wsHub.getPresence(user.id);

          liveStatus = {
            is_online: Boolean(session),
            ws_connected: wsConnected,
            session_id: session?.id ?? null,
            device_id: session?.deviceId ?? null,
            device_os: session?.deviceOs ?? null,
            device_arch: session?.deviceArch ?? null,
            app_version: session?.appVersion ?? null,
            started_at: session?.startedAt ?? null,
            last_heartbeat_at: session?.lastHeartbeatAt ?? null,
            screen_locked: session ? presence.screenLocked : false,
            location_enabled: session ? presence.locationEnabled : false,
          };
        }

        return {
          ...toPublicUser(user),
          live_status: liveStatus,
          today_worked_seconds:
            user.role === "employee" ? (todayWorkedMap.get(user.id) ?? 0) : 0,
          latest_screenshot:
            user.role === "employee" ? (latestByEmp.get(user.id) ?? null) : null,
        };
      });

      return reply.code(200).send({
        quotas,
        users: formattedUsers,
      });
    }
  );

  app.post(
    "/api/admin/employees",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.authUser!;
      const input = parseWithSchema(CreateUserSchema, request.body);
      const passwordHash = await hashPassword(input.password);
      const nowIso = new Date().toISOString();

      const tx = deps.sqlite.transaction(() => {
        const existingEmail = deps.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, input.email))
          .get();
        if (existingEmail) {
          throw new AppError(
            409,
            "EMAIL_ALREADY_EXISTS",
            "Email address is already in use"
          );
        }

        const currentQuotas = getQuotaSummary(deps.db);
        if (
          input.role === "employee" &&
          input.is_active &&
          currentQuotas.active_employees >= MAX_ACTIVE_EMPLOYEES
        ) {
          throw new AppError(
            409,
            "MAX_EMPLOYEES_EXCEEDED",
            "Maximum active employee limit (10) reached"
          );
        }
        if (
          input.role === "admin" &&
          input.is_active &&
          currentQuotas.active_admins >= MAX_ACTIVE_ADMINS
        ) {
          throw new AppError(
            409,
            "MAX_ADMINS_EXCEEDED",
            "Maximum active administrator limit (2) reached"
          );
        }

        const inserted = deps.db
          .insert(users)
          .values({
            name: input.name,
            email: input.email,
            passwordHash,
            role: input.role,
            designation: input.designation,
            salaryType: input.salary_type,
            baseSalary: input.base_salary,
            isActive: input.is_active,
            tokenVersion: 1,
            createdAt: nowIso,
            updatedAt: nowIso,
          })
          .returning()
          .get();

        writeAuditLog(deps.db, {
          actorId: actor.id,
          action: "USER_CREATED",
          targetType: "user",
          targetId: inserted.id,
          details: {
            role: inserted.role,
            email: inserted.email,
            is_active: inserted.isActive,
          },
          createdAt: nowIso,
        });

        return {
          created: inserted,
          quotas: getQuotaSummary(deps.db),
        };
      });

      const result = tx.immediate();
      return reply.code(201).send({
        user: toPublicUser(result.created),
        quotas: result.quotas,
      });
    }
  );

  app.patch(
    "/api/admin/employees/:id",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.authUser!;
      const params = request.params as { id: string };
      const targetId = parsePositiveIntId(params.id, "id");
      const input = parseWithSchema(UpdateUserSchema, request.body);

      if (
        targetId === actor.id &&
        (input.is_active === false || input.role === "employee")
      ) {
        throw new AppError(
          409,
          "SELF_ADMIN_LOCKOUT",
          "Cannot deactivate or demote your own currently authenticated administrator account"
        );
      }

      const newPasswordHash =
        input.password !== undefined
          ? await hashPassword(input.password)
          : undefined;
      const nowIso = new Date().toISOString();

      const tx = deps.sqlite.transaction(() => {
        const existing = deps.db
          .select()
          .from(users)
          .where(eq(users.id, targetId))
          .get();

        if (!existing) {
          throw new AppError(404, "NOT_FOUND", "User not found");
        }

        const nextRole = input.role ?? existing.role;
        const nextIsActive = input.is_active ?? existing.isActive;

        if (input.email && input.email !== existing.email) {
          const dup = deps.db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, input.email))
            .get();
          if (dup && dup.id !== existing.id) {
            throw new AppError(
              409,
              "EMAIL_ALREADY_EXISTS",
              "Email address is already in use"
            );
          }
        }

        const becomingActiveEmployee =
          nextRole === "employee" &&
          nextIsActive &&
          !(existing.role === "employee" && existing.isActive);
        const becomingActiveAdmin =
          nextRole === "admin" &&
          nextIsActive &&
          !(existing.role === "admin" && existing.isActive);
        const leavingActiveAdmin =
          existing.role === "admin" &&
          existing.isActive &&
          (!nextIsActive || nextRole !== "admin");

        const currentQuotas = getQuotaSummary(deps.db);
        if (
          becomingActiveEmployee &&
          currentQuotas.active_employees >= MAX_ACTIVE_EMPLOYEES
        ) {
          throw new AppError(
            409,
            "MAX_EMPLOYEES_EXCEEDED",
            "Maximum active employee limit (10) reached"
          );
        }
        if (
          becomingActiveAdmin &&
          currentQuotas.active_admins >= MAX_ACTIVE_ADMINS
        ) {
          throw new AppError(
            409,
            "MAX_ADMINS_EXCEEDED",
            "Maximum active administrator limit (2) reached"
          );
        }
        if (leavingActiveAdmin && currentQuotas.active_admins <= 1) {
          throw new AppError(
            409,
            "CANNOT_DISABLE_LAST_ADMIN",
            "Cannot deactivate, demote, or delete the sole remaining active administrator"
          );
        }

        const deactivated = existing.isActive && !nextIsActive;
        const reactivated = !existing.isActive && nextIsActive;
        const roleChanged = nextRole !== existing.role;
        const passwordChanged = newPasswordHash !== undefined;
        const shouldBumpTokenVersion = deactivated || roleChanged || passwordChanged;

        const updated: UserRow = deps.db
          .update(users)
          .set({
            name: input.name ?? existing.name,
            email: input.email ?? existing.email,
            passwordHash: newPasswordHash ?? existing.passwordHash,
            role: nextRole,
            designation: input.designation ?? existing.designation,
            salaryType: input.salary_type ?? existing.salaryType,
            baseSalary: input.base_salary ?? existing.baseSalary,
            isActive: nextIsActive,
            tokenVersion: shouldBumpTokenVersion
              ? sql`${users.tokenVersion} + 1`
              : existing.tokenVersion,
            updatedAt: nowIso,
          })
          .where(eq(users.id, targetId))
          .returning()
          .get();

        let stoppedSession = null;
        if (!nextIsActive || nextRole === "admin") {
          const activeSession = deps.db
            .select()
            .from(workSessions)
            .where(
              and(
                eq(workSessions.employeeId, targetId),
                eq(workSessions.status, "active")
              )
            )
            .get();

          if (activeSession) {
            const durationSeconds = Math.max(
              0,
              Math.floor(
                (Date.parse(nowIso) - Date.parse(activeSession.startedAt)) / 1000
              )
            );
            stoppedSession = deps.db
              .update(workSessions)
              .set({
                status: "stopped",
                endedAt: nowIso,
                durationSeconds,
              })
              .where(eq(workSessions.id, activeSession.id))
              .returning()
              .get();
          }
        }

        const action = deactivated
          ? "USER_DEACTIVATED"
          : reactivated
            ? "USER_REACTIVATED"
            : roleChanged
              ? "USER_ROLE_CHANGED"
              : passwordChanged
                ? "USER_PASSWORD_RESET"
                : "USER_UPDATED";

        writeAuditLog(deps.db, {
          actorId: actor.id,
          action,
          targetType: "user",
          targetId: updated.id,
          details: {
            previous_role: existing.role,
            new_role: updated.role,
            previous_active: existing.isActive,
            new_active: updated.isActive,
            password_changed: passwordChanged,
          },
          createdAt: nowIso,
        });

        return {
          updated,
          stoppedSession,
          shouldRevokeWs: shouldBumpTokenVersion,
          deactivated,
          quotas: getQuotaSummary(deps.db),
        };
      });

      const result = tx.immediate();

      if (result.stoppedSession) {
        deps.wsHub.clearPresence(targetId);
        deps.wsHub.broadcastToAdmins({
          type: "employee_status",
          payload: {
            employee_id: targetId,
            is_online: false,
            ws_connected: false,
            session_id: result.stoppedSession.id,
            device_id: result.stoppedSession.deviceId,
            device_os: result.stoppedSession.deviceOs,
            device_arch: result.stoppedSession.deviceArch,
            screen_locked: false,
            started_at: result.stoppedSession.startedAt,
            last_heartbeat_at: result.stoppedSession.lastHeartbeatAt,
            reason: result.deactivated ? "account_deactivated" : "role_changed",
          },
        });
      }

      if (result.shouldRevokeWs) {
        deps.wsHub.forceDisconnectUser(
          targetId,
          result.deactivated ? "account_deactivated" : "token_revoked",
          result.deactivated
            ? "Account deactivated by administrator"
            : "Account credentials or role updated by administrator",
          result.stoppedSession?.id ?? null
        );
      }

      return reply.code(200).send({
        user: toPublicUser(result.updated),
        quotas: result.quotas,
      });
    }
  );
}
