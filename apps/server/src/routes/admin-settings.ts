import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  MAX_ACTIVE_ADMINS,
  MAX_ACTIVE_EMPLOYEES,
  UpdateAppSettingsSchema,
} from "@sm-office/shared";
import type { AppConfig } from "../config.js";
import type { AppDb } from "../db/client.js";
import {
  getAppSettingsRow,
  toAppSettings,
  writeAuditLog,
} from "../db/helpers.js";
import { appSettings } from "../db/schema.js";
import { createAuthenticateHook, requireAdmin } from "../plugins/auth.js";
import type { StorageDriver } from "../storage/types.js";
import { parseWithSchema } from "../utils/validation.js";

export interface AdminSettingsRoutesDeps {
  config: AppConfig;
  sqlite: Database.Database;
  db: AppDb;
  storageDriver: StorageDriver;
}

export function registerAdminSettingsRoutes(
  app: FastifyInstance,
  deps: AdminSettingsRoutesDeps
): void {
  const authenticate = createAuthenticateHook(deps.db, deps.config.jwtSecret);

  app.get(
    "/api/admin/settings",
    { preHandler: [authenticate, requireAdmin] },
    async (_request, reply) => {
      const row = getAppSettingsRow(deps.db);
      return reply.code(200).send({
        settings: toAppSettings(row),
        runtime: {
          storage_driver: deps.storageDriver.driverName,
          max_active_employees: MAX_ACTIVE_EMPLOYEES,
          max_active_admins: MAX_ACTIVE_ADMINS,
        },
      });
    }
  );

  app.patch(
    "/api/admin/settings",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.authUser!;
      const input = parseWithSchema(UpdateAppSettingsSchema, request.body);
      const nowIso = new Date().toISOString();

      const tx = deps.sqlite.transaction(() => {
        const existing = getAppSettingsRow(deps.db);

        const updated = deps.db
          .update(appSettings)
          .set({
            companyName: input.company_name ?? existing.companyName,
            companyTimezone: input.company_timezone ?? existing.companyTimezone,
            currencyCode: input.currency_code ?? existing.currencyCode,
            retentionDays: input.retention_days ?? existing.retentionDays,
            updatedAt: nowIso,
          })
          .where(eq(appSettings.id, 1))
          .returning()
          .get();

        writeAuditLog(deps.db, {
          actorId: actor.id,
          action: "SETTINGS_UPDATED",
          targetType: "app_settings",
          targetId: 1,
          details: input as Record<string, unknown>,
          createdAt: nowIso,
        });

        return updated;
      });

      const updated = tx.immediate();
      return reply.code(200).send({ settings: toAppSettings(updated) });
    }
  );
}
