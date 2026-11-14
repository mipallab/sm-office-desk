import type { AppConfig } from "../config.js";
import { LocalStorageDriver } from "./local.js";
import { R2StorageDriver } from "./r2.js";
import type { StorageDriver } from "./types.js";

export type { ListedStorageObject, PrivateReadResult, StorageDriver } from "./types.js";
export { LocalStorageDriver } from "./local.js";
export { R2StorageDriver } from "./r2.js";

export function createStorageDriver(config: AppConfig): StorageDriver {
  if (config.storageDriver === "r2") {
    return new R2StorageDriver({
      accountId: config.r2AccountId,
      bucketName: config.r2BucketName,
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
      defaultPresignedTtlSeconds: config.r2PresignedUrlTtlSeconds,
    });
  }
  return new LocalStorageDriver(config.localStoragePath);
}
