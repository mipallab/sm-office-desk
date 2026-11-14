import { eq, sql } from "drizzle-orm";
import { buildApp } from "./app.js";
import { writeAuditLog } from "./db/helpers.js";
import { users } from "./db/schema.js";
import { hashPassword } from "./utils/crypto.js";

async function main(): Promise<void> {
  const { app, config, db } = await buildApp();

  // Auto-seed initial admin if credentials are provided in env and no admin exists
  const seedEmail = process.env["SEED_ADMIN_EMAIL"]?.trim().toLowerCase();
  const seedPassword = process.env["SEED_ADMIN_PASSWORD"];
  if (seedEmail && seedPassword) {
    try {
      const adminCountRow = db
        .select({ count: sql<number>`COUNT(*)` })
        .from(users)
        .where(eq(users.role, "admin"))
        .get();

      if ((adminCountRow?.count ?? 0) === 0) {
        const adminName = process.env["SEED_ADMIN_NAME"]?.trim() || "Administrator";
        const passwordHash = await hashPassword(seedPassword);
        const nowIso = new Date().toISOString();

        const created = db
          .insert(users)
          .values({
            name: adminName,
            email: seedEmail,
            passwordHash,
            role: "admin",
            designation: "Administrator",
            salaryType: "monthly",
            baseSalary: 0,
            isActive: true,
            tokenVersion: 1,
            createdAt: nowIso,
            updatedAt: nowIso,
          })
          .returning()
          .get();

        writeAuditLog(db, {
          actorId: created.id,
          action: "ADMIN_SEEDED",
          targetType: "user",
          targetId: created.id,
          details: { email: created.email, source: "env_auto_seed" },
          createdAt: nowIso,
        });

        app.log.info({ email: created.email, id: created.id }, "Auto-seeded initial admin account");
      }
    } catch (err) {
      app.log.warn({ err }, "Could not check or auto-seed admin on startup");
    }
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "Shutting down SM Office Desk server...");
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "Error during graceful shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await app.listen({
    host: config.host,
    port: config.port,
  });

  app.log.info(
    {
      host: config.host,
      port: config.port,
      storageDriver: config.storageDriver,
    },
    "SM Office Desk API server listening"
  );
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
