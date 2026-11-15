import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
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
import {
  DynamicStorageDriver,
  LocalStorageDriver,
  R2StorageDriver,
  type StorageDriver,
} from "../storage/index.js";
import { AppError } from "../utils/errors.js";
import { parseWithSchema } from "../utils/validation.js";

const UpdateStorageConfigSchema = z.object({
  storage_driver: z.enum(["local", "r2"]),
  r2_account_id: z.string().trim().max(128).optional(),
  r2_bucket_name: z.string().trim().max(128).optional(),
  r2_access_key_id: z.string().trim().max(256).optional(),
  r2_secret_access_key: z.string().trim().max(256).optional(),
});

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

  const getRuntimeInfo = () => {
    const saved = deps.sqlite
      .prepare(
        "SELECT storage_driver, r2_account_id, r2_bucket_name, r2_access_key_id, r2_secret_access_key FROM storage_config WHERE id = 1"
      )
      .get() as
      | {
          storage_driver: "local" | "r2";
          r2_account_id: string;
          r2_bucket_name: string;
          r2_access_key_id: string;
          r2_secret_access_key: string;
        }
      | undefined;

    const r2AccountId = saved?.r2_account_id || deps.config.r2AccountId || "";
    const r2BucketName = saved?.r2_bucket_name || deps.config.r2BucketName || "";
    const r2AccessKeyId = saved?.r2_access_key_id || deps.config.r2AccessKeyId || "";
    const r2SecretKey =
      saved?.r2_secret_access_key || deps.config.r2SecretAccessKey || "";

    return {
      storage_driver: deps.storageDriver.driverName,
      r2_account_id: r2AccountId,
      r2_bucket_name: r2BucketName,
      r2_access_key_id: r2AccessKeyId,
      r2_has_secret: Boolean(r2SecretKey),
      max_active_employees: MAX_ACTIVE_EMPLOYEES,
      max_active_admins: MAX_ACTIVE_ADMINS,
    };
  };

  app.get(
    "/api/admin/settings",
    { preHandler: [authenticate, requireAdmin] },
    async (_request, reply) => {
      const row = getAppSettingsRow(deps.db);
      return reply.code(200).send({
        settings: toAppSettings(row),
        runtime: getRuntimeInfo(),
      });
    }
  );

  app.put(
    "/api/admin/settings/storage",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const actor = request.authUser!;
      const input = parseWithSchema(UpdateStorageConfigSchema, request.body);
      const nowIso = new Date().toISOString();

      const existing = deps.sqlite
        .prepare(
          "SELECT storage_driver, r2_account_id, r2_bucket_name, r2_access_key_id, r2_secret_access_key FROM storage_config WHERE id = 1"
        )
        .get() as
        | {
            storage_driver: "local" | "r2";
            r2_account_id: string;
            r2_bucket_name: string;
            r2_access_key_id: string;
            r2_secret_access_key: string;
          }
        | undefined;

      const accountId =
        input.r2_account_id ?? existing?.r2_account_id ?? deps.config.r2AccountId ?? "";
      const bucketName =
        input.r2_bucket_name ??
        existing?.r2_bucket_name ??
        deps.config.r2BucketName ??
        "";
      const accessKeyId =
        input.r2_access_key_id ??
        existing?.r2_access_key_id ??
        deps.config.r2AccessKeyId ??
        "";
      const secretAccessKey =
        input.r2_secret_access_key && input.r2_secret_access_key.length > 0
          ? input.r2_secret_access_key
          : existing?.r2_secret_access_key ?? deps.config.r2SecretAccessKey ?? "";

      let nextDriver: StorageDriver;

      if (input.storage_driver === "r2") {
        if (!accountId || !bucketName || !accessKeyId || !secretAccessKey) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            "Cloudflare R2 requires Account ID, Bucket Name, Access Key ID, and Secret Access Key."
          );
        }

        nextDriver = new R2StorageDriver({
          accountId,
          bucketName,
          accessKeyId,
          secretAccessKey,
          defaultPresignedTtlSeconds: deps.config.r2PresignedUrlTtlSeconds,
        });

        try {
          await nextDriver.healthCheck();
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Could not connect to R2 bucket";
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            `Cloudflare R2 connection test failed: ${msg}`
          );
        }
      } else {
        nextDriver = new LocalStorageDriver(deps.config.localStoragePath);
        await nextDriver.healthCheck();
      }

      if (deps.storageDriver instanceof DynamicStorageDriver) {
        deps.storageDriver.setDriver(nextDriver);
      }

      deps.sqlite
        .prepare(
          `INSERT INTO storage_config (id, storage_driver, r2_account_id, r2_bucket_name, r2_access_key_id, r2_secret_access_key, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             storage_driver = excluded.storage_driver,
             r2_account_id = excluded.r2_account_id,
             r2_bucket_name = excluded.r2_bucket_name,
             r2_access_key_id = excluded.r2_access_key_id,
             r2_secret_access_key = excluded.r2_secret_access_key,
             updated_at = excluded.updated_at`
        )
        .run(
          input.storage_driver,
          accountId,
          bucketName,
          accessKeyId,
          secretAccessKey,
          nowIso
        );

      writeAuditLog(deps.db, {
        actorId: actor.id,
        action: "SETTINGS_UPDATED",
        targetType: "storage_config",
        targetId: 1,
        details: {
          storage_driver: input.storage_driver,
          r2_bucket_name: bucketName,
        },
        createdAt: nowIso,
      });

      return reply.code(200).send({
        runtime: getRuntimeInfo(),
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
