import type { AppConfig } from "../config.js";
import { LocalStorageDriver } from "./local.js";
import { R2StorageDriver } from "./r2.js";
import type {
  ListedStorageObject,
  PrivateReadResult,
  StorageDriver,
} from "./types.js";

export type { ListedStorageObject, PrivateReadResult, StorageDriver } from "./types.js";
export { LocalStorageDriver } from "./local.js";
export { R2StorageDriver } from "./r2.js";

export class DynamicStorageDriver implements StorageDriver {
  private current: StorageDriver;

  constructor(initialDriver: StorageDriver) {
    this.current = initialDriver;
  }

  get driverName(): "r2" | "local" {
    return this.current.driverName;
  }

  setDriver(nextDriver: StorageDriver): void {
    this.current = nextDriver;
  }

  putObject(key: string, body: Buffer, contentType: "image/webp"): Promise<void> {
    return this.current.putObject(key, body, contentType);
  }

  getPrivateReadAccess(key: string, ttlSeconds?: number): Promise<PrivateReadResult> {
    return this.current.getPrivateReadAccess(key, ttlSeconds);
  }

  deleteObject(key: string): Promise<void> {
    return this.current.deleteObject(key);
  }

  deleteObjects(keys: string[]): Promise<void> {
    return this.current.deleteObjects(keys);
  }

  listObjectsOlderThan(cutoffDate: Date): Promise<ListedStorageObject[]> {
    return this.current.listObjectsOlderThan(cutoffDate);
  }

  healthCheck(): Promise<void> {
    return this.current.healthCheck();
  }
}

export function createStorageDriver(config: AppConfig): DynamicStorageDriver {
  if (config.storageDriver === "r2") {
    return new DynamicStorageDriver(
      new R2StorageDriver({
        accountId: config.r2AccountId,
        bucketName: config.r2BucketName,
        accessKeyId: config.r2AccessKeyId,
        secretAccessKey: config.r2SecretAccessKey,
        defaultPresignedTtlSeconds: config.r2PresignedUrlTtlSeconds,
      })
    );
  }
  return new DynamicStorageDriver(new LocalStorageDriver(config.localStoragePath));
}
