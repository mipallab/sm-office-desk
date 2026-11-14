import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { AppError } from "../utils/errors.js";
import type {
  ListedStorageObject,
  PrivateReadResult,
  StorageDriver,
} from "./types.js";

const VALID_STORAGE_KEY_REGEX =
  /^[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/emp_[0-9]+\/[0-9]+_[a-z0-9]{6}_(random|on_demand)\.webp$/;

const DELETABLE_KEY_REGEX =
  /^[0-9]{4}\/[0-9]{2}\/[0-9]{2}\/emp_[0-9]+\/[0-9]+_[a-z0-9]{6}_(random|on_demand)\.webp(\.tmp-[a-f0-9-]+)?$/;

const ONE_HOUR_MS = 60 * 60 * 1000;

function isEnoent(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && (err as { code?: string }).code === "ENOENT"
  );
}

/**
 * Local disk fallback StorageDriver for dev and single-VPS disk deployments.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly driverName = "local" as const;
  private readonly baseDir: string;

  constructor(localStoragePath: string) {
    this.baseDir = path.resolve(localStoragePath);
  }

  private resolveSafePath(key: string, allowTempForDelete: boolean = false): string {
    if (
      !key ||
      key.includes("..") ||
      key.includes("\\") ||
      key.startsWith("/") ||
      key.includes("\0")
    ) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid storage key format");
    }

    const pattern = allowTempForDelete ? DELETABLE_KEY_REGEX : VALID_STORAGE_KEY_REGEX;
    if (!pattern.test(key)) {
      throw new AppError(400, "VALIDATION_ERROR", "Storage key failed format validation");
    }

    const target = path.resolve(this.baseDir, key);
    if (!target.startsWith(this.baseDir + path.sep)) {
      throw new AppError(400, "VALIDATION_ERROR", "Storage path traversal rejected");
    }

    return target;
  }

  async putObject(
    key: string,
    body: Buffer,
    _contentType: "image/webp"
  ): Promise<void> {
    const target = this.resolveSafePath(key);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmpTarget = `${target}.tmp-${crypto.randomUUID()}`;
    try {
      await fsp.writeFile(tmpTarget, body);
      await fsp.rename(tmpTarget, target);
    } catch (err) {
      await fsp.unlink(tmpTarget).catch(() => {});
      throw err;
    }
  }

  async getPrivateReadAccess(key: string): Promise<PrivateReadResult> {
    const target = this.resolveSafePath(key);
    let stats: fs.Stats;
    try {
      stats = await fsp.stat(target);
    } catch (err) {
      if (isEnoent(err)) {
        throw new AppError(404, "NOT_FOUND", "Screenshot file not found");
      }
      throw err;
    }

    return {
      mode: "stream",
      contentType: "image/webp",
      contentLength: stats.size,
      createStream: () => fs.createReadStream(target),
    };
  }

  async deleteObject(key: string): Promise<void> {
    const target = this.resolveSafePath(key, true);
    try {
      await fsp.unlink(target);
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
  }

  async deleteObjects(keys: string[]): Promise<void> {
    const uniqueKeys = [...new Set(keys)].filter((k) => k.length > 0);
    for (const key of uniqueKeys) {
      await this.deleteObject(key);
    }
  }

  async listObjectsOlderThan(cutoffDate: Date): Promise<ListedStorageObject[]> {
    const results: ListedStorageObject[] = [];
    const nowMs = Date.now();
    const cutoffMs = cutoffDate.getTime();

    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (isEnoent(err)) return;
        throw err;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;

        let stats: fs.Stats;
        try {
          stats = await fsp.stat(fullPath);
        } catch (err) {
          if (isEnoent(err)) continue;
          throw err;
        }

        if (entry.name.includes(".tmp-") && nowMs - stats.mtimeMs < ONE_HOUR_MS) {
          continue;
        }

        if (stats.mtimeMs < cutoffMs) {
          const relKey = path.relative(this.baseDir, fullPath).split(path.sep).join("/");
          results.push({
            key: relKey,
            lastModified: stats.mtime,
            sizeBytes: stats.size,
          });
        }
      }
    };

    await walk(this.baseDir);
    return results;
  }

  async healthCheck(): Promise<void> {
    await fsp.mkdir(this.baseDir, { recursive: true });
    await fsp.access(this.baseDir, fs.constants.R_OK | fs.constants.W_OK);
  }
}
