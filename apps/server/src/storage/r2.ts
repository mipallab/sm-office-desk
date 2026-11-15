import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PRESIGNED_URL_TTL_SECONDS } from "@sm-office/shared";
import type {
  ListedStorageObject,
  PrivateReadResult,
  StorageDriver,
} from "./types.js";

export interface R2StorageDriverOptions {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
  defaultPresignedTtlSeconds?: number;
  client?: S3Client;
  presignFn?: (
    client: S3Client,
    command: GetObjectCommand,
    options: { expiresIn: number }
  ) => Promise<string>;
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === "NoSuchKey" ||
    e.Code === "NoSuchKey" ||
    e.$metadata?.httpStatusCode === 404
  );
}

/**
 * Cloudflare R2 StorageDriver backed by `@aws-sdk/client-s3`.
 */
export class R2StorageDriver implements StorageDriver {
  readonly driverName = "r2" as const;
  private readonly bucket: string;
  private readonly defaultTtl: number;
  private readonly client: S3Client;
  private readonly presignFn: (
    client: S3Client,
    command: GetObjectCommand,
    options: { expiresIn: number }
  ) => Promise<string>;

  constructor(options: R2StorageDriverOptions) {
    if (!options.bucketName) {
      throw new Error("R2 bucketName is required");
    }
    this.bucket = options.bucketName;
    this.defaultTtl = options.defaultPresignedTtlSeconds ?? PRESIGNED_URL_TTL_SECONDS;
    this.client =
      options.client ??
      new S3Client({
        region: "auto",
        endpoint: `https://${options.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
        },
      });
    this.presignFn =
      options.presignFn ??
      ((client, command, opts) => getSignedUrl(client, command, opts));
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: "image/webp"
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
  }

  async getPrivateReadAccess(
    key: string,
    ttlSeconds?: number
  ): Promise<PrivateReadResult> {
    const expiresInSeconds = ttlSeconds ?? this.defaultTtl;
    const url = await this.presignFn(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
      { expiresIn: expiresInSeconds }
    );
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    return {
      mode: "presigned_url",
      url,
      expiresInSeconds,
      expiresAt,
    };
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );
    } catch (err) {
      if (isNotFoundError(err)) {
        return;
      }
      throw err;
    }
  }

  async deleteObjects(keys: string[]): Promise<void> {
    const uniqueKeys = [...new Set(keys)].filter((k) => k.length > 0);
    if (uniqueKeys.length === 0) return;

    const BATCH_LIMIT = 1000;
    for (let i = 0; i < uniqueKeys.length; i += BATCH_LIMIT) {
      const batch = uniqueKeys.slice(i, i + BATCH_LIMIT);
      const res = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: batch.map((Key) => ({ Key })),
            Quiet: true,
          },
        })
      );
      const hardErrors = (res.Errors ?? []).filter(
        (e) => e.Code && e.Code !== "NoSuchKey"
      );
      if (hardErrors.length > 0) {
        const first = hardErrors[0];
        throw new Error(
          `R2 batch delete failed (${first?.Key ?? "unknown"}: ${first?.Code ?? "Error"} ${first?.Message ?? ""})`
        );
      }
    }
  }

  async listObjectsOlderThan(cutoffDate: Date): Promise<ListedStorageObject[]> {
    const results: ListedStorageObject[] = [];
    let continuationToken: string | undefined;

    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          MaxKeys: 1000,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        })
      );

      for (const item of res.Contents ?? []) {
        if (!item.Key || !item.LastModified) continue;
        if (item.Key.startsWith("_system/")) continue;
        if (item.LastModified.getTime() < cutoffDate.getTime()) {
          results.push({
            key: item.Key,
            lastModified: item.LastModified,
            sizeBytes: item.Size ?? 0,
          });
        }
      }

      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    return results;
  }

  async healthCheck(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}
