import type Database from "better-sqlite3";
import { desc, eq } from "drizzle-orm";
import {
  formatDatePartsInTimezone,
  getUtcRangeForLocalDate,
  HeartbeatSchema,
  type HeartbeatInput,
} from "@sm-office/shared";
import type { AppDb } from "../db/client.js";
import { getAppSettingsRow } from "../db/helpers.js";
import { locationLogs, workSessions } from "../db/schema.js";
import { AppError } from "../utils/errors.js";
import type { WsHub } from "../ws/hub.js";

const LOCATION_CONSENT_FIELDS = new Set<string>([
  "latitude",
  "longitude",
  "accuracy_meters",
  "location_source",
  "location_enabled",
]);

export function parseHeartbeatPayload(raw: unknown): HeartbeatInput {
  const parsed = HeartbeatSchema.safeParse(raw);
  if (!parsed.success) {
    const hasConsentViolation = parsed.error.issues.some((issue) =>
      issue.path.some((segment) => LOCATION_CONSENT_FIELDS.has(String(segment)))
    );
    if (hasConsentViolation) {
      throw new AppError(
        400,
        "LOCATION_CONSENT_VIOLATION",
        parsed.error.issues[0]?.message ?? "Location consent policy violated",
        { fieldErrors: parsed.error.flatten().fieldErrors }
      );
    }
    throw parsed.error;
  }
  return parsed.data;
}

export interface HeartbeatResult {
  session_id: string;
  status: "active";
  server_time_utc: string;
  last_heartbeat_at: string;
  duration_seconds: number;
}

/**
 * Shared heartbeat processor for both `POST /api/tracker/sessions/heartbeat`
 * and WebSocket `heartbeat` frames. Never performs IP geolocation fallback.
 */
export function processHeartbeat(
  rawPayload: unknown,
  employeeId: number,
  db: AppDb,
  wsHub: WsHub
): HeartbeatResult {
  const input = parseHeartbeatPayload(rawPayload);

  const session = db
    .select()
    .from(workSessions)
    .where(eq(workSessions.id, input.session_id))
    .get();

  if (!session || session.employeeId !== employeeId) {
    throw new AppError(404, "NOT_FOUND", "Work session not found");
  }

  if (session.status !== "active") {
    throw new AppError(409, "SESSION_NOT_ACTIVE", "Work session is no longer active");
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const durationSeconds = Math.max(
    0,
    Math.floor((now.getTime() - Date.parse(session.startedAt)) / 1000)
  );

  db.update(workSessions)
    .set({
      lastHeartbeatAt: nowIso,
      durationSeconds,
    })
    .where(eq(workSessions.id, session.id))
    .run();

  const settings = getAppSettingsRow(db);
  const expiresAtIso = new Date(
    now.getTime() + settings.retentionDays * 86_400_000
  ).toISOString();

  if (!input.location_enabled) {
    // Strictly record disabled state without any coordinate or IP fallback
    const latestLoc = db
      .select()
      .from(locationLogs)
      .where(eq(locationLogs.employeeId, employeeId))
      .orderBy(desc(locationLogs.recordedAt), desc(locationLogs.id))
      .limit(1)
      .get();

    if (!latestLoc || latestLoc.source !== "disabled") {
      db.insert(locationLogs)
        .values({
          employeeId,
          sessionId: session.id,
          locationEnabled: false,
          latitude: null,
          longitude: null,
          accuracyMeters: null,
          source: "disabled",
          recordedAt: nowIso,
          expiresAt: expiresAtIso,
        })
        .run();
    }
  } else if (
    input.latitude !== null &&
    input.latitude !== undefined &&
    input.longitude !== null &&
    input.longitude !== undefined
  ) {
    db.insert(locationLogs)
      .values({
        employeeId,
        sessionId: session.id,
        locationEnabled: true,
        latitude: input.latitude,
        longitude: input.longitude,
        accuracyMeters: input.accuracy_meters ?? null,
        source: input.location_source,
        recordedAt: nowIso,
        expiresAt: expiresAtIso,
      })
      .run();
  }

  wsHub.setPresence(employeeId, {
    screenLocked: input.screen_locked,
    locationEnabled: input.location_enabled,
  });

  wsHub.broadcastToAdmins({
    type: "employee_status",
    payload: {
      employee_id: employeeId,
      is_online: true,
      ws_connected: wsHub.isDesktopConnected(employeeId),
      session_id: session.id,
      device_id: session.deviceId,
      device_os: session.deviceOs,
      device_arch: session.deviceArch,
      screen_locked: input.screen_locked,
      started_at: session.startedAt,
      last_heartbeat_at: nowIso,
      reason: "heartbeat",
    },
  });

  if (!input.location_enabled) {
    wsHub.broadcastToAdmins({
      type: "location_update",
      payload: {
        employee_id: employeeId,
        sharing_enabled: false,
        latitude: null,
        longitude: null,
        accuracy_meters: null,
        source: "disabled",
        recorded_at: nowIso,
      },
    });
  } else if (
    input.latitude !== null &&
    input.latitude !== undefined &&
    input.longitude !== null &&
    input.longitude !== undefined
  ) {
    wsHub.broadcastToAdmins({
      type: "location_update",
      payload: {
        employee_id: employeeId,
        sharing_enabled: true,
        latitude: input.latitude,
        longitude: input.longitude,
        accuracy_meters: input.accuracy_meters ?? null,
        source: input.location_source,
        recorded_at: nowIso,
      },
    });
  }

  return {
    session_id: session.id,
    status: "active",
    server_time_utc: nowIso,
    last_heartbeat_at: nowIso,
    duration_seconds: durationSeconds,
  };
}

interface TodaySessionRow {
  started_at: string;
  ended_at: string | null;
  last_heartbeat_at: string;
  status: string;
}

/**
 * Computes total worked seconds for an employee during the current calendar day
 * in `companyTimezone`, clamping overlapping sessions to `[todayStartUtc, now]`.
 */
export function computeTodayWorkedSecondsMap(
  sqlite: Database.Database,
  companyTimezone: string,
  now: Date = new Date()
): Map<number, number> {
  const localDate = formatDatePartsInTimezone(now, companyTimezone).dateString;
  const { startUtcIso } = getUtcRangeForLocalDate(localDate, companyTimezone);
  const startMs = Date.parse(startUtcIso);
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  const rows = sqlite
    .prepare(
      `SELECT employee_id, started_at, ended_at, last_heartbeat_at, status
       FROM work_sessions
       WHERE started_at <= ?
         AND (status = 'active' OR COALESCE(ended_at, last_heartbeat_at) >= ?)`
    )
    .all(nowIso, startUtcIso) as Array<TodaySessionRow & { employee_id: number }>;

  const totals = new Map<number, number>();
  for (const row of rows) {
    const sStart = Date.parse(row.started_at);
    const sEnd =
      row.status === "active"
        ? nowMs
        : Date.parse(row.ended_at ?? row.last_heartbeat_at);
    if (Number.isNaN(sStart) || Number.isNaN(sEnd)) continue;

    const effStart = Math.max(sStart, startMs);
    const effEnd = Math.min(sEnd, nowMs);
    if (effEnd > effStart) {
      const prev = totals.get(row.employee_id) ?? 0;
      totals.set(
        row.employee_id,
        prev + Math.max(0, Math.floor((effEnd - effStart) / 1000))
      );
    }
  }

  return totals;
}
