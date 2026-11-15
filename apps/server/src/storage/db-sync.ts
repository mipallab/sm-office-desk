import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";

export const R2_DB_SNAPSHOT_KEY = "_system/office-db-latest.sqlite";

export interface R2Credentials {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function createR2Client(creds: R2Credentials): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${creds.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
  });
}

function isNoSuchKey(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e.name === "NoSuchKey" ||
    e.Code === "NoSuchKey" ||
    e.name === "NotFound" ||
    e.$metadata?.httpStatusCode === 404
  );
}

/**
 * Restores `/data/office.db` from Cloudflare R2 (`_system/office-db-latest.sqlite`)
 * on container startup if the local SQLite database file does not exist yet.
 */
export async function restoreDatabaseFromR2IfNeeded(
  sqlitePath: string,
  creds: R2Credentials | null
): Promise<boolean> {
  if (!creds) return false;
  if (sqlitePath === ":memory:" || sqlitePath.startsWith("file:")) {
    return false;
  }

  const resolvedPath = path.resolve(sqlitePath);
  if (fs.existsSync(resolvedPath)) {
    try {
      const stat = fs.statSync(resolvedPath);
      if (stat.size > 0) {
        return false;
      }
    } catch {
      // proceed with restore attempt
    }
  }

  const client = createR2Client(creds);
  try {
    const res = await client.send(
      new GetObjectCommand({
        Bucket: creds.bucketName,
        Key: R2_DB_SNAPSHOT_KEY,
      })
    );

    if (!res.Body) return false;
    const bytes = await res.Body.transformToByteArray();
    if (bytes.byteLength < 100) return false;

    await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });
    const tmpPath = `${resolvedPath}.restore-${crypto.randomUUID()}`;
    await fsp.writeFile(tmpPath, Buffer.from(bytes));
    await fsp.rename(tmpPath, resolvedPath);
    return true;
  } catch (err) {
    if (isNoSuchKey(err)) {
      return false;
    }
    throw err;
  }
}

export class R2DatabaseSyncManager {
  private readonly sqlite: Database.Database;
  private readonly config: AppConfig;
  private debounceTimer: NodeJS.Timeout | null = null;
  private syncingPromise: Promise<{
    synced: boolean;
    syncedAt: string | null;
    sizeBytes: number;
  }> | null = null;
  private lastSyncedAt: string | null = null;
  private lastSizeBytes = 0;

  constructor(sqlite: Database.Database, config: AppConfig) {
    this.sqlite = sqlite;
    this.config = config;
  }

  getActiveR2Credentials(): R2Credentials | null {
    try {
      const row = this.sqlite
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

      const accountId = row?.r2_account_id || this.config.r2AccountId || "";
      const bucketName = row?.r2_bucket_name || this.config.r2BucketName || "";
      const accessKeyId = row?.r2_access_key_id || this.config.r2AccessKeyId || "";
      const secretAccessKey =
        row?.r2_secret_access_key || this.config.r2SecretAccessKey || "";

      if (accountId && bucketName && accessKeyId && secretAccessKey) {
        return { accountId, bucketName, accessKeyId, secretAccessKey };
      }
    } catch {
      // ignore if table not ready or db closed
    }
    return null;
  }

  getStatus(): {
    enabled: boolean;
    last_synced_at: string | null;
    last_size_bytes: number;
  } {
    return {
      enabled: Boolean(this.getActiveR2Credentials()),
      last_synced_at: this.lastSyncedAt,
      last_size_bytes: this.lastSizeBytes,
    };
  }

  scheduleDebouncedBackup(delayMs = 2000): void {
    if (!this.getActiveR2Credentials()) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.backupNow().catch(() => {});
    }, delayMs);
  }

  async backupNow(): Promise<{
    synced: boolean;
    syncedAt: string | null;
    sizeBytes: number;
  }> {
    if (this.syncingPromise) {
      return this.syncingPromise;
    }

    const creds = this.getActiveR2Credentials();
    if (!creds) {
      return {
        synced: false,
        syncedAt: this.lastSyncedAt,
        sizeBytes: this.lastSizeBytes,
      };
    }

    const run = async () => {
      const tmpFile = path.join(
        os.tmpdir(),
        `sm-office-backup-${crypto.randomUUID()}.sqlite`
      );
      try {
        await this.sqlite.backup(tmpFile);
        const body = await fsp.readFile(tmpFile);
        const client = createR2Client(creds);
        await client.send(
          new PutObjectCommand({
            Bucket: creds.bucketName,
            Key: R2_DB_SNAPSHOT_KEY,
            Body: body,
            ContentType: "application/x-sqlite3",
          })
        );
        const nowIso = new Date().toISOString();
        this.lastSyncedAt = nowIso;
        this.lastSizeBytes = body.byteLength;
        return {
          synced: true,
          syncedAt: nowIso,
          sizeBytes: body.byteLength,
        };
      } finally {
        await fsp.unlink(tmpFile).catch(() => {});
      }
    };

    this.syncingPromise = run().finally(() => {
      this.syncingPromise = null;
    });
    return this.syncingPromise;
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
