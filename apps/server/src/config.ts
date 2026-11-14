import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  DEFAULT_COMPANY_NAME,
  DEFAULT_COMPANY_TIMEZONE,
  DEFAULT_CURRENCY_CODE,
  RETENTION_DAYS,
  StorageDriverTypeSchema,
  TimeZoneSchema,
} from "@sm-office/shared";

const EnvConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  CORS_ORIGIN: z.string().trim().min(1).default("http://localhost:5173"),
  SQLITE_PATH: z.string().trim().min(1).default("./data/office.db"),
  JWT_SECRET: z
    .string()
    .min(16, "JWT_SECRET must be at least 16 characters")
    .default("dev-only-jwt-secret-replace-in-production-32chars"),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  STORAGE_DRIVER: StorageDriverTypeSchema.default("r2"),
  R2_ACCOUNT_ID: z.string().trim().default(""),
  R2_BUCKET_NAME: z.string().trim().default("sm-office-desk-screenshots"),
  R2_ACCESS_KEY_ID: z.string().trim().default(""),
  R2_SECRET_ACCESS_KEY: z.string().trim().default(""),
  R2_PRESIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  LOCAL_STORAGE_PATH: z.string().trim().min(1).default("./data/screenshots"),
  COMPANY_NAME: z.string().trim().min(2).max(100).default(DEFAULT_COMPANY_NAME),
  COMPANY_TIMEZONE: TimeZoneSchema.default(DEFAULT_COMPANY_TIMEZONE),
  CURRENCY_CODE: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "CURRENCY_CODE must be a 3-letter ISO-4217 code")
    .default(DEFAULT_CURRENCY_CODE),
  RETENTION_DAYS: z.coerce.number().int().min(7).max(RETENTION_DAYS).default(RETENTION_DAYS),
});

export interface AppConfig {
  nodeEnv: "development" | "production" | "test";
  port: number;
  host: string;
  corsOrigins: string[];
  sqlitePath: string;
  jwtSecret: string;
  jwtAccessTtlSeconds: number;
  jwtRefreshTtlSeconds: number;
  storageDriver: "r2" | "local";
  r2AccountId: string;
  r2BucketName: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2PresignedUrlTtlSeconds: number;
  localStoragePath: string;
  companyName: string;
  companyTimezone: string;
  currencyCode: string;
  retentionDays: number;
}

export interface LoadConfigOptions {
  allowIncompleteR2?: boolean;
  skipDotEnv?: boolean;
}

function parseDotEnvLine(rawLine: string): [string, string] | null {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) return null;

  const eqIdx = line.indexOf("=");
  if (eqIdx <= 0) return null;

  const key = line.slice(0, eqIdx).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = line.slice(eqIdx + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    const quote = value[0];
    value = value.slice(1, -1);
    if (quote === '"') {
      value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    }
  } else {
    const commentIdx = value.indexOf(" #");
    if (commentIdx >= 0) {
      value = value.slice(0, commentIdx).trim();
    }
  }

  return [key, value];
}

/**
 * Loads `.env` values without overriding keys already present in `process.env`.
 */
export function loadDotEnvFiles(): void {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(thisDir, "../../.env"),
    path.resolve(thisDir, "../../../.env"),
  ];

  const seen = new Set<string>();
  for (const filePath of candidates) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseDotEnvLine(line);
      if (!parsed) continue;
      const [key, val] = parsed;
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  }
}

export function loadConfig(
  overrides: Partial<Record<string, string | undefined>> = {},
  options: LoadConfigOptions = {}
): AppConfig {
  if (!options.skipDotEnv) {
    loadDotEnvFiles();
  }

  const mergedEnv: Record<string, string | undefined> = {
    ...process.env,
    ...overrides,
  };

  // Treat empty JWT_SECRET string as omitted only when explicitly unset, not in production
  const parsed = EnvConfigSchema.parse(mergedEnv);

  if (
    parsed.NODE_ENV === "production" &&
    (parsed.JWT_SECRET.startsWith("replace-with") ||
      parsed.JWT_SECRET.startsWith("dev-only") ||
      parsed.JWT_SECRET.length < 32)
  ) {
    throw new Error(
      "Production requires a strong JWT_SECRET (>= 32 characters, not default placeholder)"
    );
  }

  if (parsed.STORAGE_DRIVER === "r2" && !options.allowIncompleteR2) {
    const missing: string[] = [];
    if (!parsed.R2_ACCOUNT_ID) missing.push("R2_ACCOUNT_ID");
    if (!parsed.R2_BUCKET_NAME) missing.push("R2_BUCKET_NAME");
    if (!parsed.R2_ACCESS_KEY_ID) missing.push("R2_ACCESS_KEY_ID");
    if (!parsed.R2_SECRET_ACCESS_KEY) missing.push("R2_SECRET_ACCESS_KEY");
    if (missing.length > 0) {
      throw new Error(
        `STORAGE_DRIVER=r2 requires environment variables: ${missing.join(", ")}`
      );
    }
  }

  const corsOrigins = parsed.CORS_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    host: parsed.HOST,
    corsOrigins,
    sqlitePath: parsed.SQLITE_PATH,
    jwtSecret: parsed.JWT_SECRET,
    jwtAccessTtlSeconds: parsed.JWT_ACCESS_TTL_SECONDS,
    jwtRefreshTtlSeconds: parsed.JWT_REFRESH_TTL_SECONDS,
    storageDriver: parsed.STORAGE_DRIVER,
    r2AccountId: parsed.R2_ACCOUNT_ID,
    r2BucketName: parsed.R2_BUCKET_NAME,
    r2AccessKeyId: parsed.R2_ACCESS_KEY_ID,
    r2SecretAccessKey: parsed.R2_SECRET_ACCESS_KEY,
    r2PresignedUrlTtlSeconds: parsed.R2_PRESIGNED_URL_TTL_SECONDS,
    localStoragePath: parsed.LOCAL_STORAGE_PATH,
    companyName: parsed.COMPANY_NAME,
    companyTimezone: parsed.COMPANY_TIMEZONE,
    currencyCode: parsed.CURRENCY_CODE,
    retentionDays: parsed.RETENTION_DAYS,
  };
}
