import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStorageDriver } from "../src/storage/local.js";
import { R2StorageDriver } from "../src/storage/r2.js";
import { createTestServer, loginAdmin, seedUserDirect, type TestServerContext } from "./helpers.js";

const execFileAsync = promisify(execFile);

describe("R2StorageDriver, LocalStorageDriver Guards, Settings, Audit & CLI", () => {
  let ctx: TestServerContext | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
      ctx = null;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("executes R2StorageDriver commands, 1000-key batch chunking, pagination, and presigned URLs", async () => {
    const sentCommands: unknown[] = [];
    const mockClient = {
      send: async (cmd: unknown) => {
        sentCommands.push(cmd);
        if (cmd instanceof DeleteObjectCommand) {
          const err = new Error("NoSuchKey") as Error & { name: string };
          err.name = "NoSuchKey";
          throw err;
        }
        if (cmd instanceof DeleteObjectsCommand) {
          return { Errors: [] };
        }
        if (cmd instanceof ListObjectsV2Command) {
          if (!cmd.input.ContinuationToken) {
            return {
              IsTruncated: true,
              NextContinuationToken: "page2",
              Contents: [
                {
                  Key: "2026/08/01/emp_1/1000_aaaaaa_random.webp",
                  LastModified: new Date("2026-08-01T00:00:00.000Z"),
                  Size: 1024,
                },
              ],
            };
          }
          return {
            IsTruncated: false,
            Contents: [
              {
                Key: "2026/11/14/emp_1/2000_bbbbbb_random.webp",
                LastModified: new Date("2026-11-14T00:00:00.000Z"),
                Size: 2048,
              },
            ],
          };
        }
        return {};
      },
    } as unknown as S3Client;

    const driver = new R2StorageDriver({
      accountId: "acc123",
      bucketName: "sm-bucket",
      accessKeyId: "key",
      secretAccessKey: "secret",
      defaultPresignedTtlSeconds: 300,
      client: mockClient,
      presignFn: async (_client, cmd, opts) =>
        `https://r2.example.com/${cmd.input.Key}?expires=${opts.expiresIn}`,
    });

    await driver.healthCheck();
    expect(sentCommands.at(-1)).toBeInstanceOf(HeadBucketCommand);

    await driver.putObject(
      "2026/11/14/emp_1/1000_aaaaaa_random.webp",
      Buffer.from("RIFFxxxxWEBP"),
      "image/webp"
    );
    expect(sentCommands.at(-1)).toBeInstanceOf(PutObjectCommand);

    const readAccess = await driver.getPrivateReadAccess(
      "2026/11/14/emp_1/1000_aaaaaa_random.webp"
    );
    expect(readAccess.mode).toBe("presigned_url");
    if (readAccess.mode === "presigned_url") {
      expect(readAccess.url).toContain("expires=300");
    }

    // Idempotent NoSuchKey handling
    await expect(
      driver.deleteObject("2026/11/14/emp_1/missing_aaaaaa_random.webp")
    ).resolves.toBeUndefined();

    // Chunked 1000-key batch deletion for 1,250 keys -> 2 DeleteObjectsCommand calls
    sentCommands.length = 0;
    const manyKeys = Array.from(
      { length: 1250 },
      (_, i) => `2026/11/14/emp_1/${1000 + i}_aaaaaa_random.webp`
    );
    await driver.deleteObjects(manyKeys);
    const deleteCalls = sentCommands.filter((c) => c instanceof DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(2);
    expect((deleteCalls[0] as DeleteObjectsCommand).input.Delete?.Objects).toHaveLength(1000);
    expect((deleteCalls[1] as DeleteObjectsCommand).input.Delete?.Objects).toHaveLength(250);

    // Paginated listObjectsOlderThan
    const older = await driver.listObjectsOlderThan(new Date("2026-10-01T00:00:00.000Z"));
    expect(older).toHaveLength(1);
    expect(older[0]?.key).toBe("2026/08/01/emp_1/1000_aaaaaa_random.webp");
  });

  it("blocks path traversal on LocalStorageDriver", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-local-"));
    tempDirs.push(dir);
    const local = new LocalStorageDriver(dir);

    for (const badKey of [
      "../escape.webp",
      "/abs/path.webp",
      "2026/11/14/emp_1/bad\\key.webp",
      "2026/11/14/emp_1/not-matching.png",
    ]) {
      await expect(
        local.putObject(badKey, Buffer.from("RIFF1234WEBP"), "image/webp")
      ).rejects.toThrow();
    }
  });

  it("serves health, settings updates, and cursor-paginated audit logs", async () => {
    ctx = await createTestServer();
    await seedUserDirect(ctx, {
      name: "Admin",
      email: "admin@sm.test",
      password: "Password123!",
      role: "admin",
    });
    const adminToken = await loginAdmin(ctx, "admin@sm.test", "Password123!");

    const health = await ctx.app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      status: "ok",
      db: "ok",
      storage_driver: "local",
    });

    const patchSettings = await ctx.app.inject({
      method: "PATCH",
      url: "/api/admin/settings",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        company_name: "SM Creative Studio",
        currency_code: "USD",
        retention_days: 60,
      },
    });
    expect(patchSettings.statusCode).toBe(200);
    expect(patchSettings.json().settings).toMatchObject({
      company_name: "SM Creative Studio",
      currency_code: "USD",
      retention_days: 60,
    });

    const auditRes = await ctx.app.inject({
      method: "GET",
      url: "/api/admin/audit-logs?action=SETTINGS_UPDATED",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.json().logs).toHaveLength(1);
    expect(auditRes.json().logs[0].action).toBe("SETTINGS_UPDATED");
  });

  it("runs seed:admin and reset:password CLI scripts cleanly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-cli-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "cli.db");
    const serverRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      ".."
    );
    const tsxBin = path.resolve(serverRoot, "../../node_modules/.bin/tsx");

    const env = {
      ...process.env,
      SQLITE_PATH: dbPath,
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_PATH: path.join(dir, "shots"),
      JWT_SECRET: "cli-test-secret-minimum-32-chars-long-1234",
    };

    // 1. Seed initial admin
    const seedOk = await execFileAsync(
      tsxBin,
      [
        "src/cli/seed-admin.ts",
        "--name",
        "CLI Admin",
        "--email",
        "cli@sm.test",
        "--password",
        "InitialPass123!",
      ],
      { cwd: serverRoot, env }
    );
    expect(seedOk.stdout).toContain("Seeded initial admin");

    // 2. Running seed:admin again must abort with exit code 1
    await expect(
      execFileAsync(
        tsxBin,
        [
          "src/cli/seed-admin.ts",
          "--name",
          "Duplicate",
          "--email",
          "cli2@sm.test",
          "--password",
          "InitialPass123!",
        ],
        { cwd: serverRoot, env }
      )
    ).rejects.toThrow();

    // 3. reset:password updates password and increments token_version -> 2
    const resetOk = await execFileAsync(
      tsxBin,
      [
        "src/cli/reset-password.ts",
        "--email",
        "cli@sm.test",
        "--password",
        "RotatedPass456!",
      ],
      { cwd: serverRoot, env }
    );
    expect(resetOk.stdout).toContain("token_version -> 2");
  });
});
