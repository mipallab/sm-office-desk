import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { initDatabase } from "../db/client.js";
import { writeAuditLog } from "../db/helpers.js";
import { users } from "../db/schema.js";
import { hashPassword } from "../utils/crypto.js";
import { parseCliArgs, promptMissingValue } from "./helpers.js";

const ResetPasswordInputSchema = z.object({
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
    const rawEmail = await promptMissingValue(
      args["email"] ?? process.env["RESET_EMAIL"],
      "Account Email"
    );
    const rawPassword = await promptMissingValue(
      args["password"] ?? process.env["RESET_PASSWORD"],
      "New Password (>= 8 chars)"
    );

    const validated = ResetPasswordInputSchema.parse({
      email: rawEmail,
      password: rawPassword,
    });

    const user = db
      .select()
      .from(users)
      .where(eq(users.email, validated.email))
      .get();

    if (!user) {
      console.error(`User with email '${validated.email}' not found.`);
      process.exitCode = 1;
      return;
    }

    const passwordHash = await hashPassword(validated.password);
    const nowIso = new Date().toISOString();

    const updated = db
      .update(users)
      .set({
        passwordHash,
        tokenVersion: sql`${users.tokenVersion} + 1`,
        updatedAt: nowIso,
      })
      .where(eq(users.id, user.id))
      .returning()
      .get();

    writeAuditLog(db, {
      actorId: null,
      action: "CLI_PASSWORD_RESET",
      targetType: "user",
      targetId: updated.id,
      details: {
        email: updated.email,
        new_token_version: updated.tokenVersion,
      },
      createdAt: nowIso,
    });

    console.log(
      `Password reset for ${updated.email} (token_version -> ${updated.tokenVersion})`
    );
  } finally {
    sqlite.close();
  }
}

main().catch((err) => {
  console.error("reset:password failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
