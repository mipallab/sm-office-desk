import type Database from "better-sqlite3";
import type { FastifyBaseLogger } from "fastify";
import { and, eq, inArray, lt } from "drizzle-orm";
import cron, { type ScheduledTask } from "node-cron";
import {
  HEARTBEAT_STALE_TIMEOUT_SECONDS,
  PURGE_BATCH_SIZE,
} from "@sm-office/shared";
import type { AppDb } from "../db/client.js";
import { writeAuditLog } from "../db/helpers.js";
import { screenshots, workSessions } from "../db/schema.js";
import type { StorageDriver } from "../storage/types.js";
import type { WsHub } from "../ws/hub.js";

/**
 * Transitions active sessions silent for >180s to `stopped` using `last_heartbeat_at`
 * as `ended_at` so offline sleep/crashes never overcount worked hours.
 */
export function sweepStaleSessions(
  db: AppDb,
  wsHub: WsHub,
  now: Date = new Date()
): number {
  const cutoffIso = new Date(
    now.getTime() - HEARTBEAT_STALE_TIMEOUT_SECONDS * 1000
  ).toISOString();

  const staleSessions = db
    .select()
    .from(workSessions)
    .where(
      and(
        eq(workSessions.status, "active"),
        lt(workSessions.lastHeartbeatAt, cutoffIso)
      )
    )
    .all();

  let closedCount = 0;
  for (const session of staleSessions) {
    const endedAtIso = session.lastHeartbeatAt;
    const durationSeconds = Math.max(
      0,
      Math.floor((Date.parse(endedAtIso) - Date.parse(session.startedAt)) / 1000)
    );

    const updated = db
      .update(workSessions)
      .set({
        status: "stopped",
        endedAt: endedAtIso,
        durationSeconds,
      })
      .where(
        and(eq(workSessions.id, session.id), eq(workSessions.status, "active"))
      )
      .returning()
      .get();

    if (updated) {
      closedCount += 1;
      wsHub.clearPresence(updated.employeeId);
      wsHub.broadcastToAdmins({
        type: "employee_status",
        payload: {
          employee_id: updated.employeeId,
          is_online: false,
          ws_connected: wsHub.isDesktopConnected(updated.employeeId),
          session_id: updated.id,
          device_id: updated.deviceId,
          device_os: updated.deviceOs,
          device_arch: updated.deviceArch,
          screen_locked: false,
          started_at: updated.startedAt,
          last_heartbeat_at: updated.lastHeartbeatAt,
          reason: "heartbeat_timeout",
        },
      });
    }
  }

  return closedCount;
}

let isPurgeRunning = false;

export interface PurgeResult {
  skipped: boolean;
  screenshotsDeleted: number;
  locationsDeleted: number;
}

/**
 * Daily 90-day retention purge: deletes expired storage files first, then DB rows
 * in batches of 500 for both `screenshots` and `location_logs`, then truncates WAL.
 */
export async function purgeExpiredData(
  sqlite: Database.Database,
  db: AppDb,
  storageDriver: StorageDriver,
  now: Date = new Date()
): Promise<PurgeResult> {
  if (isPurgeRunning) {
    return { skipped: true, screenshotsDeleted: 0, locationsDeleted: 0 };
  }

  isPurgeRunning = true;
  try {
    const nowIso = now.toISOString();
    let screenshotsDeleted = 0;
    let locationsDeleted = 0;

    // Step 1: Purge expired screenshots (storage objects first, then DB rows)
    const selectExpiredShots = sqlite.prepare(
      `SELECT id, storage_key FROM screenshots
       WHERE expires_at <= ?
       ORDER BY expires_at ASC, id ASC
       LIMIT ?`
    );

    while (true) {
      const batch = selectExpiredShots.all(nowIso, PURGE_BATCH_SIZE) as Array<{
        id: number;
        storage_key: string | null;
      }>;

      if (batch.length === 0) break;

      const keys = batch
        .map((row) => row.storage_key)
        .filter((k): k is string => k !== null);

      if (keys.length > 0) {
        await storageDriver.deleteObjects(keys);
      }

      const ids = batch.map((row) => row.id);
      db.delete(screenshots).where(inArray(screenshots.id, ids)).run();
      screenshotsDeleted += ids.length;

      if (batch.length < PURGE_BATCH_SIZE) break;
    }

    // Step 2: Purge expired location_logs in batches of 500
    const deleteLocationsBatch = sqlite.prepare(
      `DELETE FROM location_logs
       WHERE id IN (
         SELECT id FROM location_logs
         WHERE expires_at <= ?
         ORDER BY expires_at ASC, id ASC
         LIMIT ?
       )`
    );

    while (true) {
      const res = deleteLocationsBatch.run(nowIso, PURGE_BATCH_SIZE);
      locationsDeleted += res.changes;
      if (res.changes < PURGE_BATCH_SIZE) break;
    }

    // Step 3: Reclaim WAL disk space
    sqlite.pragma("wal_checkpoint(TRUNCATE)");

    // Step 4: Record audit log if any rows were purged
    if (screenshotsDeleted > 0 || locationsDeleted > 0) {
      writeAuditLog(db, {
        actorId: null,
        action: "SYSTEM_RETENTION_PURGE",
        targetType: "retention",
        targetId: null,
        details: {
          cutoff_utc: nowIso,
          screenshots_deleted: screenshotsDeleted,
          location_logs_deleted: locationsDeleted,
        },
      });
    }

    return {
      skipped: false,
      screenshotsDeleted,
      locationsDeleted,
    };
  } finally {
    isPurgeRunning = false;
  }
}

export interface OrphanCleanupResult {
  scannedCount: number;
  deletedCount: number;
}

/**
 * Weekly orphan cleanup: removes storage objects older than `cutoffDate` (default >24h)
 * that have no matching `screenshots.storage_key` row in SQLite.
 */
export async function cleanupOrphanFiles(
  sqlite: Database.Database,
  storageDriver: StorageDriver,
  cutoffDate: Date = new Date(Date.now() - 24 * 60 * 60 * 1000)
): Promise<OrphanCleanupResult> {
  const objects = await storageDriver.listObjectsOlderThan(cutoffDate);
  if (objects.length === 0) {
    return { scannedCount: 0, deletedCount: 0 };
  }

  const orphanKeys: string[] = [];
  for (let i = 0; i < objects.length; i += PURGE_BATCH_SIZE) {
    const chunk = objects.slice(i, i + PURGE_BATCH_SIZE);
    const keys = chunk.map((o) => o.key);
    const placeholders = keys.map(() => "?").join(",");
    const existingRows = sqlite
      .prepare(
        `SELECT storage_key FROM screenshots WHERE storage_key IN (${placeholders})`
      )
      .all(...keys) as Array<{ storage_key: string }>;

    const existingSet = new Set(existingRows.map((r) => r.storage_key));
    for (const key of keys) {
      if (!existingSet.has(key)) {
        orphanKeys.push(key);
      }
    }
  }

  if (orphanKeys.length > 0) {
    await storageDriver.deleteObjects(orphanKeys);
  }

  return {
    scannedCount: objects.length,
    deletedCount: orphanKeys.length,
  };
}

export interface StartCronJobsDeps {
  sqlite: Database.Database;
  db: AppDb;
  storageDriver: StorageDriver;
  wsHub: WsHub;
  logger: FastifyBaseLogger;
}

export function startCronJobs(deps: StartCronJobsDeps): { stop: () => void } {
  const tasks: ScheduledTask[] = [];

  tasks.push(
    cron.schedule("*/30 * * * * *", () => {
      try {
        const closed = sweepStaleSessions(deps.db, deps.wsHub);
        if (closed > 0) {
          deps.logger.info({ closed }, "Swept stale work sessions");
        }
      } catch (err) {
        deps.logger.error({ err }, "Stale session sweeper failed");
      }
    })
  );

  tasks.push(
    cron.schedule(
      "0 2 * * *",
      () => {
        void purgeExpiredData(deps.sqlite, deps.db, deps.storageDriver)
          .then((res) => {
            if (!res.skipped) {
              deps.logger.info(res, "Daily 90-day retention purge completed");
            }
          })
          .catch((err) => {
            deps.logger.error({ err }, "Daily 90-day retention purge failed");
          });
      },
      { timezone: "UTC" }
    )
  );

  tasks.push(
    cron.schedule(
      "0 3 * * 0",
      () => {
        void cleanupOrphanFiles(deps.sqlite, deps.storageDriver)
          .then((res) => {
            deps.logger.info(res, "Weekly orphan file cleanup completed");
          })
          .catch((err) => {
            deps.logger.error({ err }, "Weekly orphan file cleanup failed");
          });
      },
      { timezone: "UTC" }
    )
  );

  return {
    stop: () => {
      for (const task of tasks) {
        task.stop();
      }
    },
  };
}
