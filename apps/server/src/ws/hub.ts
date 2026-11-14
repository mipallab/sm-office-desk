import crypto from "node:crypto";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import WebSocket from "ws";
import {
  AdminWsInboundSchema,
  CAPTURE_NOW_COOLDOWN_SECONDS,
  CAPTURE_NOW_TIMEOUT_SECONDS,
  CaptureNowResponseSchema,
  DesktopWsInboundSchema,
  DeviceArchSchema,
  HEARTBEAT_INTERVAL_SECONDS,
  type AdminWsOutbound,
  type CaptureNowResponse,
  type CaptureStatus,
  type DesktopWsOutbound,
  type DeviceArch,
  type DeviceOs,
  type ForceStopReason,
} from "@sm-office/shared";
import type { AppDb } from "../db/client.js";
import { screenshots, users, workSessions } from "../db/schema.js";
import { processHeartbeat } from "../services/session.service.js";
import { verifyJwt } from "../utils/crypto.js";
import { AppError } from "../utils/errors.js";

export interface DesktopSocketEntry {
  socket: WebSocket;
  userId: number;
  deviceId: string;
  deviceOs: DeviceOs;
  deviceArch: DeviceArch;
  appVersion: string;
}

export interface AdminSocketEntry {
  socket: WebSocket;
  userId: number;
}

export interface EmployeePresenceState {
  screenLocked: boolean;
  locationEnabled: boolean;
}

export interface PendingCaptureEntry {
  requestId: string;
  employeeId: number;
  adminId: number;
  createdAtMs: number;
  timer: NodeJS.Timeout;
}

export interface WsHubOptions {
  db: AppDb;
  jwtSecret: string;
  logger: FastifyBaseLogger;
  authTimeoutMs?: number;
  captureTimeoutMs?: number;
  captureCooldownMs?: number;
}

export class WsHub {
  private readonly db: AppDb;
  private readonly jwtSecret: string;
  private readonly logger: FastifyBaseLogger;
  private readonly authTimeoutMs: number;
  private readonly captureTimeoutMs: number;
  private readonly captureCooldownMs: number;

  private readonly desktopSockets = new Map<number, DesktopSocketEntry>();
  private readonly adminSockets = new Set<AdminSocketEntry>();
  private readonly livePresence = new Map<number, EmployeePresenceState>();
  private readonly pendingCaptures = new Map<string, PendingCaptureEntry>();
  private readonly captureCooldowns = new Map<number, number>();

  constructor(options: WsHubOptions) {
    this.db = options.db;
    this.jwtSecret = options.jwtSecret;
    this.logger = options.logger;
    this.authTimeoutMs = options.authTimeoutMs ?? 5000;
    this.captureTimeoutMs =
      options.captureTimeoutMs ?? CAPTURE_NOW_TIMEOUT_SECONDS * 1000;
    this.captureCooldownMs =
      options.captureCooldownMs ?? CAPTURE_NOW_COOLDOWN_SECONDS * 1000;
  }

  private sendJson(
    socket: WebSocket,
    msg: DesktopWsOutbound | AdminWsOutbound
  ): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  private rejectAndClose(
    socket: WebSocket,
    code: string,
    message: string,
    closeCode: number = 4003
  ): void {
    this.sendJson(socket, {
      type: "auth_error",
      payload: { code, message },
    });
    try {
      socket.close(closeCode, code);
    } catch {
      // ignore close errors on already closing sockets
    }
  }

  handleConnection(socket: WebSocket, _request: FastifyRequest): void {
    let authenticated = false;
    let roleKind: "desktop" | "admin_web" | null = null;
    let userId: number | null = null;
    let desktopEntry: DesktopSocketEntry | null = null;
    let adminEntry: AdminSocketEntry | null = null;

    const authTimer = setTimeout(() => {
      if (!authenticated) {
        this.rejectAndClose(
          socket,
          "AUTH_TIMEOUT",
          "WebSocket authentication timeout (5000ms)",
          4001
        );
      }
    }, this.authTimeoutMs);

    const cleanup = () => {
      clearTimeout(authTimer);
      if (roleKind === "admin_web" && adminEntry) {
        this.adminSockets.delete(adminEntry);
      } else if (roleKind === "desktop" && desktopEntry && userId !== null) {
        const current = this.desktopSockets.get(userId);
        if (current && current.socket === socket) {
          this.desktopSockets.delete(userId);

          // Notify admins if employee still has an active work session
          const activeSession = this.db
            .select()
            .from(workSessions)
            .where(
              and(
                eq(workSessions.employeeId, userId),
                eq(workSessions.status, "active")
              )
            )
            .get();

          if (activeSession) {
            const presence = this.getPresence(userId);
            this.broadcastToAdmins({
              type: "employee_status",
              payload: {
                employee_id: userId,
                is_online: true,
                ws_connected: false,
                session_id: activeSession.id,
                device_id: activeSession.deviceId,
                device_os: activeSession.deviceOs,
                device_arch: activeSession.deviceArch,
                screen_locked: presence.screenLocked,
                started_at: activeSession.startedAt,
                last_heartbeat_at: activeSession.lastHeartbeatAt,
                reason: "ws_disconnected",
              },
            });
          }
        }
      }
    };

    socket.on("close", cleanup);
    socket.on("error", (err) => {
      this.logger.debug({ err }, "WebSocket socket error");
    });

    socket.on("message", (rawData) => {
      let msg: unknown;
      try {
        const text =
          typeof rawData === "string"
            ? rawData
            : Buffer.isBuffer(rawData)
              ? rawData.toString("utf8")
              : Buffer.from(rawData as ArrayBuffer).toString("utf8");
        msg = JSON.parse(text);
      } catch {
        if (!authenticated) {
          clearTimeout(authTimer);
          this.rejectAndClose(socket, "UNAUTHORIZED", "Invalid JSON message");
        }
        return;
      }

      if (!authenticated) {
        clearTimeout(authTimer);
        if (!msg || typeof msg !== "object") {
          this.rejectAndClose(socket, "UNAUTHORIZED", "Expected auth frame");
          return;
        }
        const record = msg as { type?: unknown; payload?: Record<string, unknown> };
        if (record.type !== "auth" || !record.payload || typeof record.payload !== "object") {
          this.rejectAndClose(socket, "UNAUTHORIZED", "First message must be auth");
          return;
        }

        const clientType = record.payload["client_type"];
        if (clientType === "admin_web") {
          const parsed = AdminWsInboundSchema.safeParse(msg);
          if (!parsed.success || parsed.data.type !== "auth") {
            this.rejectAndClose(socket, "UNAUTHORIZED", "Invalid admin auth payload");
            return;
          }

          let claims;
          try {
            claims = verifyJwt(parsed.data.payload.token, this.jwtSecret, "access");
          } catch {
            this.rejectAndClose(socket, "UNAUTHORIZED", "Invalid or expired token");
            return;
          }

          const user = this.db
            .select()
            .from(users)
            .where(eq(users.id, claims.sub))
            .get();
          if (!user || !user.isActive || claims.tv !== user.tokenVersion) {
            this.rejectAndClose(
              socket,
              "TOKEN_REVOKED",
              "Session revoked; re-authentication required"
            );
            return;
          }
          if (user.role !== "admin") {
            this.rejectAndClose(socket, "FORBIDDEN", "Administrator role required");
            return;
          }

          authenticated = true;
          roleKind = "admin_web";
          userId = user.id;
          adminEntry = { socket, userId: user.id };
          this.adminSockets.add(adminEntry);

          const activeRows = this.db
            .select({ employeeId: workSessions.employeeId })
            .from(workSessions)
            .where(eq(workSessions.status, "active"))
            .all();

          this.sendJson(socket, {
            type: "auth_ok",
            payload: {
              user_id: user.id,
              server_time_utc: new Date().toISOString(),
              online_employee_ids: activeRows.map((r) => r.employeeId),
            },
          });
          return;
        }

        if (clientType === "desktop") {
          const rawArch = record.payload["device_arch"];
          if (
            typeof rawArch === "string" &&
            !DeviceArchSchema.safeParse(rawArch).success
          ) {
            this.rejectAndClose(
              socket,
              "UNSUPPORTED_ARCHITECTURE",
              "Desktop tracker only supports 64-bit x86_64 or arm64 architectures"
            );
            return;
          }

          const parsed = DesktopWsInboundSchema.safeParse(msg);
          if (!parsed.success || parsed.data.type !== "auth") {
            this.rejectAndClose(socket, "UNAUTHORIZED", "Invalid desktop auth payload");
            return;
          }

          const payload = parsed.data.payload;
          let claims;
          try {
            claims = verifyJwt(payload.token, this.jwtSecret, "access");
          } catch {
            this.rejectAndClose(socket, "UNAUTHORIZED", "Invalid or expired token");
            return;
          }

          const user = this.db
            .select()
            .from(users)
            .where(eq(users.id, claims.sub))
            .get();
          if (!user || !user.isActive || claims.tv !== user.tokenVersion) {
            this.rejectAndClose(
              socket,
              "TOKEN_REVOKED",
              "Session revoked; re-authentication required"
            );
            return;
          }
          if (user.role !== "employee") {
            this.rejectAndClose(socket, "FORBIDDEN", "Employee role required");
            return;
          }

          const activeSession = this.db
            .select()
            .from(workSessions)
            .where(
              and(
                eq(workSessions.employeeId, user.id),
                eq(workSessions.status, "active")
              )
            )
            .get();

          if (activeSession && activeSession.deviceId !== payload.device_id) {
            this.rejectAndClose(
              socket,
              "ACTIVE_SESSION_CONFLICT",
              "Active session is bound to a different device_id"
            );
            return;
          }

          const prevSocket = this.desktopSockets.get(user.id);
          if (prevSocket) {
            try {
              prevSocket.socket.close(1000, "Replaced by new desktop connection");
            } catch {
              // ignore
            }
          }

          authenticated = true;
          roleKind = "desktop";
          userId = user.id;
          desktopEntry = {
            socket,
            userId: user.id,
            deviceId: payload.device_id,
            deviceOs: payload.device_os,
            deviceArch: payload.device_arch,
            appVersion: payload.app_version,
          };
          this.desktopSockets.set(user.id, desktopEntry);

          this.sendJson(socket, {
            type: "auth_ok",
            payload: {
              user_id: user.id,
              server_time_utc: new Date().toISOString(),
              active_session_id: activeSession?.id ?? null,
              heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
            },
          });

          if (activeSession) {
            const presence = this.getPresence(user.id);
            this.broadcastToAdmins({
              type: "employee_status",
              payload: {
                employee_id: user.id,
                is_online: true,
                ws_connected: true,
                session_id: activeSession.id,
                device_id: activeSession.deviceId,
                device_os: activeSession.deviceOs,
                device_arch: activeSession.deviceArch,
                screen_locked: presence.screenLocked,
                started_at: activeSession.startedAt,
                last_heartbeat_at: activeSession.lastHeartbeatAt,
                reason: "ws_connected",
              },
            });
          }
          return;
        }

        this.rejectAndClose(socket, "UNAUTHORIZED", "Invalid client_type");
        return;
      }

      // Authenticated message dispatch
      if (roleKind === "admin_web") {
        const parsed = AdminWsInboundSchema.safeParse(msg);
        if (!parsed.success) return;
        if (parsed.data.type === "ping") {
          this.sendJson(socket, {
            type: "pong",
            payload: {
              ts: parsed.data.payload.ts,
              server_time_utc: new Date().toISOString(),
            },
          });
        }
        return;
      }

      if (roleKind === "desktop" && userId !== null) {
        const parsed = DesktopWsInboundSchema.safeParse(msg);
        if (!parsed.success) {
          this.logger.warn(
            { userId, issues: parsed.error.issues },
            "Rejected malformed desktop WS message"
          );
          return;
        }

        const data = parsed.data;
        if (data.type === "ping") {
          this.sendJson(socket, {
            type: "pong",
            payload: {
              ts: data.payload.ts,
              server_time_utc: new Date().toISOString(),
            },
          });
          return;
        }

        if (data.type === "heartbeat") {
          try {
            processHeartbeat(data.payload, userId, this.db, this);
          } catch (err) {
            this.logger.warn(
              { err, userId },
              "Rejected desktop WS heartbeat"
            );
          }
          return;
        }

        if (data.type === "capture_ack") {
          const pending = this.pendingCaptures.get(data.payload.request_id);
          if (!pending || pending.employeeId !== userId) return;

          const shot = this.db
            .select()
            .from(screenshots)
            .where(
              and(
                eq(screenshots.id, data.payload.screenshot_id),
                eq(screenshots.employeeId, userId)
              )
            )
            .get();
          if (!shot) return;

          clearTimeout(pending.timer);
          this.pendingCaptures.delete(data.payload.request_id);
          this.broadcastToAdmins({
            type: "capture_status",
            payload: {
              request_id: data.payload.request_id,
              employee_id: userId,
              status: "completed",
              screenshot_id: shot.id,
              capture_status: data.payload.capture_status,
              updated_at: new Date().toISOString(),
            },
          });
          return;
        }

        if (data.type === "capture_failed") {
          const pending = this.pendingCaptures.get(data.payload.request_id);
          if (!pending || pending.employeeId !== userId) return;

          clearTimeout(pending.timer);
          this.pendingCaptures.delete(data.payload.request_id);
          this.broadcastToAdmins({
            type: "capture_status",
            payload: {
              request_id: data.payload.request_id,
              employee_id: userId,
              status: "failed",
              screenshot_id: null,
              capture_status: null,
              reason: data.payload.reason,
              updated_at: new Date().toISOString(),
            },
          });
        }
      }
    });
  }

  isDesktopConnected(employeeId: number): boolean {
    const entry = this.desktopSockets.get(employeeId);
    return Boolean(entry && entry.socket.readyState === WebSocket.OPEN);
  }

  getPresence(employeeId: number): EmployeePresenceState {
    return (
      this.livePresence.get(employeeId) ?? {
        screenLocked: false,
        locationEnabled: false,
      }
    );
  }

  setPresence(employeeId: number, state: EmployeePresenceState): void {
    this.livePresence.set(employeeId, state);
  }

  clearPresence(employeeId: number): void {
    this.livePresence.delete(employeeId);
  }

  broadcastToAdmins(msg: AdminWsOutbound): void {
    const serialized = JSON.stringify(msg);
    for (const admin of this.adminSockets) {
      if (admin.socket.readyState === WebSocket.OPEN) {
        admin.socket.send(serialized);
      }
    }
  }

  triggerCaptureNow(employeeId: number, adminId: number): CaptureNowResponse {
    const nowMs = Date.now();
    const lastTs = this.captureCooldowns.get(employeeId);
    if (lastTs !== undefined && nowMs - lastTs < this.captureCooldownMs) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((this.captureCooldownMs - (nowMs - lastTs)) / 1000)
      );
      throw new AppError(
        429,
        "CAPTURE_COOLDOWN",
        `Please wait ${retryAfterSeconds}s before requesting another capture for this employee`,
        { retry_after_seconds: retryAfterSeconds },
        { "Retry-After": String(retryAfterSeconds) }
      );
    }

    const activeSession = this.db
      .select()
      .from(workSessions)
      .where(
        and(
          eq(workSessions.employeeId, employeeId),
          eq(workSessions.status, "active")
        )
      )
      .get();

    const desktopEntry = this.desktopSockets.get(employeeId);
    if (
      !activeSession ||
      !desktopEntry ||
      desktopEntry.socket.readyState !== WebSocket.OPEN
    ) {
      throw new AppError(
        409,
        "EMPLOYEE_OFFLINE",
        "Employee does not have an active connected desktop session"
      );
    }

    for (const pending of this.pendingCaptures.values()) {
      if (pending.employeeId === employeeId) {
        throw new AppError(
          409,
          "CAPTURE_IN_PROGRESS",
          "An on-demand capture request is already pending for this employee"
        );
      }
    }

    const requestId = crypto.randomUUID();
    const requestedAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + this.captureTimeoutMs).toISOString();

    this.captureCooldowns.set(employeeId, nowMs);

    const timer = setTimeout(() => {
      const existing = this.pendingCaptures.get(requestId);
      if (!existing) return;
      this.pendingCaptures.delete(requestId);

      this.broadcastToAdmins({
        type: "capture_status",
        payload: {
          request_id: requestId,
          employee_id: employeeId,
          status: "timeout",
          screenshot_id: null,
          capture_status: null,
          reason: `Desktop did not respond within ${CAPTURE_NOW_TIMEOUT_SECONDS} seconds`,
          updated_at: new Date().toISOString(),
        },
      });
    }, this.captureTimeoutMs);

    this.pendingCaptures.set(requestId, {
      requestId,
      employeeId,
      adminId,
      createdAtMs: nowMs,
      timer,
    });

    this.sendJson(desktopEntry.socket, {
      type: "CAPTURE_NOW",
      payload: {
        request_id: requestId,
        triggered_by_admin_id: adminId,
        requested_at: requestedAt,
        timeout_seconds: CAPTURE_NOW_TIMEOUT_SECONDS,
      },
    });

    this.broadcastToAdmins({
      type: "capture_status",
      payload: {
        request_id: requestId,
        employee_id: employeeId,
        status: "pending",
        screenshot_id: null,
        capture_status: null,
        updated_at: requestedAt,
      },
    });

    return CaptureNowResponseSchema.parse({
      request_id: requestId,
      employee_id: employeeId,
      status: "pending",
      timeout_seconds: CAPTURE_NOW_TIMEOUT_SECONDS,
      cooldown_seconds: CAPTURE_NOW_COOLDOWN_SECONDS,
      expires_at: expiresAt,
    });
  }

  getPendingCaptureAdminId(requestId: string, employeeId: number): number | null {
    const entry = this.pendingCaptures.get(requestId);
    if (!entry || entry.employeeId !== employeeId) return null;
    return entry.adminId;
  }

  completePendingCapture(
    requestId: string,
    employeeId: number,
    screenshotId: number,
    captureStatus: CaptureStatus
  ): number | null {
    const entry = this.pendingCaptures.get(requestId);
    if (!entry || entry.employeeId !== employeeId) {
      return null;
    }

    clearTimeout(entry.timer);
    this.pendingCaptures.delete(requestId);

    this.broadcastToAdmins({
      type: "capture_status",
      payload: {
        request_id: requestId,
        employee_id: employeeId,
        status: "completed",
        screenshot_id: screenshotId,
        capture_status: captureStatus,
        updated_at: new Date().toISOString(),
      },
    });

    return entry.adminId;
  }

  forceStopDevice(
    employeeId: number,
    targetDeviceId: string,
    sessionId: string | null,
    reason: ForceStopReason,
    message: string
  ): void {
    const entry = this.desktopSockets.get(employeeId);
    if (!entry || entry.deviceId !== targetDeviceId) return;

    this.sendJson(entry.socket, {
      type: "FORCE_STOP",
      payload: {
        session_id: sessionId,
        reason,
        message,
      },
    });
    try {
      entry.socket.close(1000, reason);
    } catch {
      // ignore
    }
    this.desktopSockets.delete(employeeId);
  }

  forceDisconnectUser(
    userId: number,
    reason: ForceStopReason,
    message: string,
    sessionId: string | null = null
  ): void {
    const desktop = this.desktopSockets.get(userId);
    if (desktop) {
      this.sendJson(desktop.socket, {
        type: "FORCE_STOP",
        payload: {
          session_id: sessionId,
          reason,
          message,
        },
      });
      try {
        desktop.socket.close(4003, reason);
      } catch {
        // ignore
      }
      this.desktopSockets.delete(userId);
    }

    for (const admin of [...this.adminSockets]) {
      if (admin.userId === userId) {
        try {
          admin.socket.close(4003, reason);
        } catch {
          // ignore
        }
        this.adminSockets.delete(admin);
      }
    }
  }

  closeAll(): void {
    for (const pending of this.pendingCaptures.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingCaptures.clear();
    this.captureCooldowns.clear();
    this.livePresence.clear();

    for (const desktop of this.desktopSockets.values()) {
      try {
        desktop.socket.close(1000, "Server shutting down");
      } catch {
        // ignore
      }
    }
    this.desktopSockets.clear();

    for (const admin of this.adminSockets) {
      try {
        admin.socket.close(1000, "Server shutting down");
      } catch {
        // ignore
      }
    }
    this.adminSockets.clear();
  }
}
