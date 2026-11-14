import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type AppDb = BetterSQLite3Database<typeof schema>;

export interface InitDatabaseOptions {
  sqlitePath: string;
  companyName: string;
  companyTimezone: string;
  currencyCode: string;
  retentionDays: number;
}

export interface DatabaseContext {
  sqlite: Database.Database;
  db: AppDb;
}

function resolveMigrationPath(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(thisDir, "migrations/0001_init.sql"),
    path.resolve(thisDir, "../../src/db/migrations/0001_init.sql"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Could not locate 0001_init.sql migration file. Searched: ${candidates.join(", ")}`
  );
}

/**
 * Opens SQLite in WAL mode, enforces required PRAGMAs, runs 0001_init.sql idempotently,
 * and seeds initial `app_settings` defaults on first database creation.
 */
export function initDatabase(options: InitDatabaseOptions): DatabaseContext {
  if (options.sqlitePath !== ":memory:" && !options.sqlitePath.startsWith("file:")) {
    fs.mkdirSync(path.dirname(path.resolve(options.sqlitePath)), { recursive: true });
  }

  const sqlite = new Database(options.sqlitePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");

  const existingSettingsTable = sqlite
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'"
    )
    .get();

  const migrationSql = fs.readFileSync(resolveMigrationPath(), "utf8");
  sqlite.exec(migrationSql);

  const db = drizzle(sqlite, { schema });

  if (!existingSettingsTable) {
    db.update(schema.appSettings)
      .set({
        companyName: options.companyName,
        companyTimezone: options.companyTimezone,
        currencyCode: options.currencyCode,
        retentionDays: options.retentionDays,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.appSettings.id, 1))
      .run();
  }

  return { sqlite, db };
}
