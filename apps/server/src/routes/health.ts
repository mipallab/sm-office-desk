import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { StorageDriver } from "../storage/types.js";
import { AppError } from "../utils/errors.js";

export interface HealthRoutesDeps {
  sqlite: Database.Database;
  storageDriver: StorageDriver;
}

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: HealthRoutesDeps
): void {
  app.get("/api/health", async (_request, reply) => {
    try {
      deps.sqlite.prepare("SELECT 1").get();
    } catch {
      throw new AppError(503, "SERVICE_UNAVAILABLE", "Database health check failed");
    }

    try {
      await deps.storageDriver.healthCheck();
    } catch {
      throw new AppError(503, "SERVICE_UNAVAILABLE", "Storage health check failed");
    }

    return reply.code(200).send({
      status: "ok",
      timestamp: new Date().toISOString(),
      version: "1.0.0",
      uptime_seconds: Math.floor(process.uptime()),
      db: "ok",
      storage_driver: deps.storageDriver.driverName,
    });
  });
}
