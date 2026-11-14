export type PrivateReadResult =
  | {
      mode: "presigned_url";
      url: string;
      expiresInSeconds: number;
      expiresAt: string;
    }
  | {
      mode: "stream";
      contentType: string;
      contentLength: number;
      createStream: () => NodeJS.ReadableStream;
    };

export interface ListedStorageObject {
  key: string;
  lastModified: Date;
  sizeBytes: number;
}

export interface StorageDriver {
  readonly driverName: "r2" | "local";

  putObject(key: string, body: Buffer, contentType: "image/webp"): Promise<void>;

  getPrivateReadAccess(key: string, ttlSeconds?: number): Promise<PrivateReadResult>;

  /** Idempotent delete: missing key / ENOENT / NoSuchKey succeeds silently. */
  deleteObject(key: string): Promise<void>;

  /** Batch delete up to 1000 keys per call; missing keys succeed silently. */
  deleteObjects(keys: string[]): Promise<void>;

  /** Used by weekly orphan cleanup cron to discover keys older than cutoffDate. */
  listObjectsOlderThan(cutoffDate: Date): Promise<ListedStorageObject[]>;

  healthCheck(): Promise<void>;
}
