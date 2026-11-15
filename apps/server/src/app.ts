import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { MAX_SCREENSHOT_UPLOAD_BYTES } from "@sm-office/shared";
import { loadConfig, type AppConfig } from "./config.js";
import { initDatabase, type AppDb } from "./db/client.js";
import { startCronJobs } from "./jobs/maintenance.js";
import { registerAdminAuditRoutes } from "./routes/admin-audit-logs.js";
import { registerAdminEmployeesRoutes } from "./routes/admin-employees.js";
import { registerAdminLocationsRoutes } from "./routes/admin-locations.js";
import { registerAdminSalaryRoutes } from "./routes/admin-salary-reports.js";
import { registerAdminScreenshotsRoutes } from "./routes/admin-screenshots.js";
import { registerAdminSettingsRoutes } from "./routes/admin-settings.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTrackerRoutes } from "./routes/tracker.js";
import {
  createStorageDriver,
  LocalStorageDriver,
  R2DatabaseSyncManager,
  R2StorageDriver,
  restoreDatabaseFromR2IfNeeded,
  type StorageDriver,
} from "./storage/index.js";
import { registerErrorHandler } from "./utils/errors.js";
import { LoginRateLimiter } from "./utils/rate-limit.js";
import { WsHub } from "./ws/hub.js";

export interface BuildAppOptions {
  config?: AppConfig;
  storageDriver?: StorageDriver;
  disableCrons?: boolean;
  logger?: boolean;
  wsAuthTimeoutMs?: number;
  captureTimeoutMs?: number;
  captureCooldownMs?: number;
  loginRateLimitMaxAttempts?: number;
}

export interface ServerAppContext {
  app: FastifyInstance;
  config: AppConfig;
  sqlite: Database.Database;
  db: AppDb;
  storageDriver: StorageDriver;
  wsHub: WsHub;
}

export async function buildApp(
  options: BuildAppOptions = {}
): Promise<ServerAppContext> {
  const config =
    options.config ??
    loadConfig(
      {},
      { allowIncompleteR2: Boolean(options.storageDriver) }
    );

  if (
    !options.storageDriver &&
    config.r2AccountId &&
    config.r2BucketName &&
    config.r2AccessKeyId &&
    config.r2SecretAccessKey
  ) {
    try {
      await restoreDatabaseFromR2IfNeeded(config.sqlitePath, {
        accountId: config.r2AccountId,
        bucketName: config.r2BucketName,
        accessKeyId: config.r2AccessKeyId,
        secretAccessKey: config.r2SecretAccessKey,
      });
    } catch {
      // Proceed with clean database initialization if R2 snapshot restore fails
    }
  }

  const { sqlite, db } = initDatabase({
    sqlitePath: config.sqlitePath,
    companyName: config.companyName,
    companyTimezone: config.companyTimezone,
    currencyCode: config.currencyCode,
    retentionDays: config.retentionDays,
  });

  const dbSync = new R2DatabaseSyncManager(sqlite, config);

  let storageDriver: StorageDriver;
  if (options.storageDriver) {
    storageDriver = options.storageDriver;
  } else {
    const dynamicDriver = createStorageDriver(config);
    const savedStorage = sqlite
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

    if (savedStorage) {
      if (
        savedStorage.storage_driver === "r2" &&
        savedStorage.r2_account_id &&
        savedStorage.r2_bucket_name &&
        savedStorage.r2_access_key_id &&
        savedStorage.r2_secret_access_key
      ) {
        dynamicDriver.setDriver(
          new R2StorageDriver({
            accountId: savedStorage.r2_account_id,
            bucketName: savedStorage.r2_bucket_name,
            accessKeyId: savedStorage.r2_access_key_id,
            secretAccessKey: savedStorage.r2_secret_access_key,
            defaultPresignedTtlSeconds: config.r2PresignedUrlTtlSeconds,
          })
        );
      } else if (savedStorage.storage_driver === "local") {
        dynamicDriver.setDriver(new LocalStorageDriver(config.localStoragePath));
      }
    }
    storageDriver = dynamicDriver;
  }

  const app = Fastify({
    logger:
      options.logger ??
      (config.nodeEnv === "test"
        ? false
        : {
            level: config.nodeEnv === "production" ? "info" : "debug",
          }),
    trustProxy: true,
  });

  await app.register(cors, {
    origin: config.corsOrigins.includes("*")
      ? true
      : (origin, cb) => {
          if (!origin || config.corsOrigins.includes(origin)) {
            cb(null, true);
            return;
          }
          cb(null, false);
        },
    credentials: true,
  });

  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: {
      fileSize: MAX_SCREENSHOT_UPLOAD_BYTES,
      files: 1,
      fields: 16,
      fieldSize: 8192,
    },
  });

  await app.register(websocket, {
    options: {
      maxPayload: 64 * 1024,
    },
  });

  registerErrorHandler(app);

  const wsHub = new WsHub({
    db,
    jwtSecret: config.jwtSecret,
    logger: app.log,
    authTimeoutMs: options.wsAuthTimeoutMs,
    captureTimeoutMs: options.captureTimeoutMs,
    captureCooldownMs: options.captureCooldownMs,
  });

  const rateLimiter = new LoginRateLimiter({
    maxFailedAttempts: options.loginRateLimitMaxAttempts ?? 5,
  });

  app.get("/ws", { websocket: true }, (socket, request) => {
    wsHub.handleConnection(socket, request);
  });

  registerHealthRoutes(app, { sqlite, storageDriver });
  registerAuthRoutes(app, { config, db, wsHub, rateLimiter });
  registerAdminEmployeesRoutes(app, {
    config,
    sqlite,
    db,
    wsHub,
    storageDriver,
  });
  registerTrackerRoutes(app, {
    config,
    sqlite,
    db,
    wsHub,
    storageDriver,
  });
  registerAdminScreenshotsRoutes(app, {
    config,
    sqlite,
    db,
    wsHub,
    storageDriver,
  });
  registerAdminLocationsRoutes(app, { config, sqlite, db, wsHub });
  registerAdminSalaryRoutes(app, { config, sqlite, db });
  registerAdminSettingsRoutes(app, {
    config,
    sqlite,
    db,
    storageDriver,
    dbSync,
  });
  registerAdminAuditRoutes(app, { config, db });

  if (!options.storageDriver) {
    app.addHook("onResponse", (request, reply, done) => {
      if (
        request.url.startsWith("/api/") &&
        (request.method === "POST" ||
          request.method === "PUT" ||
          request.method === "PATCH" ||
          request.method === "DELETE") &&
        reply.statusCode >= 200 &&
        reply.statusCode < 300
      ) {
        dbSync.scheduleDebouncedBackup(2000);
      }
      done();
    });
  }

  // Serve static assets for Admin Web SPA if apps/admin/dist exists
  const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
  const candidateAdminPaths = [
    path.resolve(process.cwd(), "apps/admin/dist"),
    path.resolve(process.cwd(), "admin/dist"),
    path.resolve(process.cwd(), "../admin/dist"),
    path.resolve(currentFileDir, "../../../apps/admin/dist"),
    path.resolve(currentFileDir, "../../admin/dist"),
  ];
  const adminDistDir = candidateAdminPaths.find((p) => fs.existsSync(p));

  if (adminDistDir) {
    await app.register(fastifyStatic, {
      root: adminDistDir,
      prefix: "/",
      decorateReply: true,
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api") || request.url.startsWith("/ws")) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: `Route ${request.method} ${request.url} not found`,
          },
        });
      }
      return reply.sendFile("index.html");
    });
  }

  const cronHandle = options.disableCrons
    ? null
    : startCronJobs({
        sqlite,
        db,
        storageDriver,
        wsHub,
        logger: app.log,
      });

  app.addHook("onClose", async () => {
    dbSync.stop();
    if (!options.storageDriver) {
      await dbSync.backupNow().catch(() => {});
    }
    cronHandle?.stop();
    wsHub.closeAll();
    sqlite.close();
  });

  return {
    app,
    config,
    sqlite,
    db,
    storageDriver,
    wsHub,
  };
}
