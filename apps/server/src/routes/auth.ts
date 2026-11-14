import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import {
  DeviceArchSchema,
  LoginRequestSchema,
  LogoutRequestSchema,
  RefreshRequestSchema,
} from "@sm-office/shared";
import type { AppConfig } from "../config.js";
import type { AppDb } from "../db/client.js";
import { getAppSettingsRow, toPublicUser, toWorkSession } from "../db/helpers.js";
import { users, workSessions } from "../db/schema.js";
import { createAuthenticateHook } from "../plugins/auth.js";
import { signJwt, verifyJwt, verifyPassword } from "../utils/crypto.js";
import { AppError } from "../utils/errors.js";
import type { LoginRateLimiter } from "../utils/rate-limit.js";
import { parseWithSchema } from "../utils/validation.js";
import type { WsHub } from "../ws/hub.js";

export interface AuthRoutesDeps {
  config: AppConfig;
  db: AppDb;
  wsHub: WsHub;
  rateLimiter: LoginRateLimiter;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): void {
  const authenticate = createAuthenticateHook(deps.db, deps.config.jwtSecret);

  app.post("/api/auth/login", async (request, reply) => {
    const rawBody =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};

    if (
      rawBody["client_type"] === "desktop" &&
      typeof rawBody["device_arch"] === "string" &&
      !DeviceArchSchema.safeParse(rawBody["device_arch"]).success
    ) {
      throw new AppError(
        400,
        "UNSUPPORTED_ARCHITECTURE",
        "Desktop tracker only supports 64-bit x86_64 or arm64 architectures"
      );
    }

    const input = parseWithSchema(LoginRequestSchema, request.body);
    deps.rateLimiter.assertAllowed(request.ip, input.email);

    const user = deps.db
      .select()
      .from(users)
      .where(eq(users.email, input.email))
      .get();

    if (!user) {
      deps.rateLimiter.recordFailure(request.ip, input.email);
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
    }

    const passwordOk = await verifyPassword(input.password, user.passwordHash);
    if (!passwordOk) {
      deps.rateLimiter.recordFailure(request.ip, input.email);
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
    }

    if (input.client_type === "desktop" && user.role !== "employee") {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Only employee accounts may sign in to the desktop tracker"
      );
    }

    if (input.client_type === "admin_web" && user.role !== "admin") {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Only administrator accounts may sign in to the admin console"
      );
    }

    if (!user.isActive) {
      throw new AppError(403, "ACCOUNT_DISABLED", "Account has been deactivated");
    }

    deps.rateLimiter.clear(request.ip, input.email);

    const accessToken = signJwt({
      sub: user.id,
      role: user.role,
      tv: user.tokenVersion,
      type: "access",
      ttlSeconds: deps.config.jwtAccessTtlSeconds,
      secret: deps.config.jwtSecret,
    });
    const refreshToken = signJwt({
      sub: user.id,
      role: user.role,
      tv: user.tokenVersion,
      type: "refresh",
      ttlSeconds: deps.config.jwtRefreshTtlSeconds,
      secret: deps.config.jwtSecret,
    });

    return reply.code(200).send({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in_seconds: deps.config.jwtAccessTtlSeconds,
      user: toPublicUser(user),
    });
  });

  app.post("/api/auth/refresh", async (request, reply) => {
    const input = parseWithSchema(RefreshRequestSchema, request.body);
    const claims = verifyJwt(input.refresh_token, deps.config.jwtSecret, "refresh");

    const user = deps.db
      .select()
      .from(users)
      .where(eq(users.id, claims.sub))
      .get();

    if (!user || !user.isActive || claims.tv !== user.tokenVersion) {
      throw new AppError(
        401,
        "TOKEN_REVOKED",
        "Refresh token revoked; re-authentication required"
      );
    }

    const accessToken = signJwt({
      sub: user.id,
      role: user.role,
      tv: user.tokenVersion,
      type: "access",
      ttlSeconds: deps.config.jwtAccessTtlSeconds,
      secret: deps.config.jwtSecret,
    });
    const refreshToken = signJwt({
      sub: user.id,
      role: user.role,
      tv: user.tokenVersion,
      type: "refresh",
      ttlSeconds: deps.config.jwtRefreshTtlSeconds,
      secret: deps.config.jwtSecret,
    });

    return reply.code(200).send({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in_seconds: deps.config.jwtAccessTtlSeconds,
      user: toPublicUser(user),
    });
  });

  app.post(
    "/api/auth/logout",
    { preHandler: authenticate },
    async (request, reply) => {
      const authUser = request.authUser!;
      const input = parseWithSchema(LogoutRequestSchema, request.body ?? {});
      const nowIso = new Date().toISOString();

      let stoppedSessionId: string | null = null;
      if (authUser.role === "employee") {
        const activeSession = deps.db
          .select()
          .from(workSessions)
          .where(
            input.device_id && !input.all_devices
              ? and(
                  eq(workSessions.employeeId, authUser.id),
                  eq(workSessions.deviceId, input.device_id),
                  eq(workSessions.status, "active")
                )
              : and(
                  eq(workSessions.employeeId, authUser.id),
                  eq(workSessions.status, "active")
                )
          )
          .get();

        if (activeSession) {
          const durationSeconds = Math.max(
            0,
            Math.floor((Date.parse(nowIso) - Date.parse(activeSession.startedAt)) / 1000)
          );
          deps.db
            .update(workSessions)
            .set({
              status: "stopped",
              endedAt: nowIso,
              durationSeconds,
            })
            .where(eq(workSessions.id, activeSession.id))
            .run();

          stoppedSessionId = activeSession.id;
          deps.wsHub.clearPresence(authUser.id);
          deps.wsHub.broadcastToAdmins({
            type: "employee_status",
            payload: {
              employee_id: authUser.id,
              is_online: false,
              ws_connected: false,
              session_id: activeSession.id,
              device_id: activeSession.deviceId,
              device_os: activeSession.deviceOs,
              device_arch: activeSession.deviceArch,
              screen_locked: false,
              started_at: activeSession.startedAt,
              last_heartbeat_at: activeSession.lastHeartbeatAt,
              reason: "logout",
            },
          });
        }
      }

      if (input.all_devices) {
        deps.db
          .update(users)
          .set({
            tokenVersion: sql`${users.tokenVersion} + 1`,
            updatedAt: nowIso,
          })
          .where(eq(users.id, authUser.id))
          .run();

        deps.wsHub.forceDisconnectUser(
          authUser.id,
          "token_revoked",
          "User logged out from all devices",
          stoppedSessionId
        );
      }

      return reply.code(200).send({ logged_out: true });
    }
  );

  app.get(
    "/api/auth/me",
    { preHandler: authenticate },
    async (request, reply) => {
      const authUser = request.authUser!;
      const user = deps.db
        .select()
        .from(users)
        .where(eq(users.id, authUser.id))
        .get();

      if (!user) {
        throw new AppError(401, "TOKEN_REVOKED", "User no longer exists");
      }

      const settings = getAppSettingsRow(deps.db);
      const activeSession =
        user.role === "employee"
          ? deps.db
              .select()
              .from(workSessions)
              .where(
                and(
                  eq(workSessions.employeeId, user.id),
                  eq(workSessions.status, "active")
                )
              )
              .get()
          : undefined;

      return reply.code(200).send({
        user: toPublicUser(user),
        company: {
          company_name: settings.companyName,
          company_timezone: settings.companyTimezone,
          currency_code: settings.currencyCode,
          retention_days: settings.retentionDays,
        },
        active_session: activeSession ? toWorkSession(activeSession) : null,
      });
    }
  );
}
