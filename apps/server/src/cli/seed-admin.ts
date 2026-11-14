import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { initDatabase } from "../db/client.js";
import { writeAuditLog } from "../db/helpers.js";
import { users } from "../db/schema.js";
import { hashPassword } from "../utils/crypto.js";
import { parseCliArgs, promptMissingValue } from "./helpers.js";

const SeedAdminInputSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
  email: z.string().trim().toLowerCase().email("Valid email required").max(160),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const config = loadConfig({}, { allowIncompleteR2: true });
  const { sqlite, db } = initDatabase({
    sqlitePath: config.sqlitePath,
    companyName: config.companyName,
    companyTimezone: config.companyTimezone,
    currencyCode: config.currencyCode,
    retentionDays: config.retentionDays,
  });

  try {
    const countRow = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(users)
      .where(eq(users.role, "admin"))
      .get();

    if ((countRow?.count ?? 0) > 0) {
      console.error(
        "Abort: An administrator account already exists. Use the Admin Web UI to add a 2nd admin or `npm run reset:password` to reset credentials."
      );
      process.exitCode = 1;
      return;
    }

    const rawName = await promptMissingValue(
      args["name"] ?? process.env["SEED_ADMIN_NAME"],
      "Admin Name"
    );
    const rawEmail = await promptMissingValue(
      args["email"] ?? process.env["SEED_ADMIN_EMAIL"],
      "Admin Email"
    );
    const rawPassword = await promptMissingValue(
      args["password"] ?? process.env["SEED_ADMIN_PASSWORD"],
      "Admin Password (>= 8 chars)"
    );

    const validated = SeedAdminInputSchema.parse({
      name: rawName,
      email: rawEmail,
      password: rawPassword,
    });

    const passwordHash = await hashPassword(validated.password);
    const nowIso = new Date().toISOString();

    const created = db
      .insert(users)
      .values({
        name: validated.name,
        email: validated.email,
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
      details: { email: created.email },
      createdAt: nowIso,
    });

    console.log(
      `Seeded initial admin #${created.id}: ${created.name} <${created.email}>`
    );
  } finally {
    sqlite.close();
  }
}

main().catch((err) => {
  console.error("seed:admin failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
