import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp, type BuildAppOptions, type ServerAppContext } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { users } from "../src/db/schema.js";
import { hashPassword } from "../src/utils/crypto.js";

export interface TestServerContext extends ServerAppContext {
  tempDir: string;
  cleanup: () => Promise<void>;
}

export async function createTestServer(
  opts: Partial<BuildAppOptions> & { companyTimezone?: string } = {}
): Promise<TestServerContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-office-test-"));
  const sqlitePath = path.join(tempDir, "office.db");
  const localStoragePath = path.join(tempDir, "screenshots");

  const config = loadConfig(
    {
      NODE_ENV: "test",
      PORT: "3000",
      HOST: "127.0.0.1",
      CORS_ORIGIN: "http://localhost:5173",
      SQLITE_PATH: sqlitePath,
      JWT_SECRET: "test-jwt-secret-key-at-least-32-chars-long-123456",
      JWT_ACCESS_TTL_SECONDS: "900",
      JWT_REFRESH_TTL_SECONDS: "2592000",
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_PATH: localStoragePath,
      COMPANY_NAME: "SM Test Office",
      COMPANY_TIMEZONE: opts.companyTimezone ?? "Asia/Dhaka",
      CURRENCY_CODE: "BDT",
      RETENTION_DAYS: "90",
    },
    { skipDotEnv: true }
  );

  const ctx = await buildApp({
    config,
    disableCrons: true,
    logger: false,
    ...opts,
  });

  return {
    ...ctx,
    tempDir,
    cleanup: async () => {
      await ctx.app.close();
      await fsp.rm(tempDir, { recursive: true, force: true });
    },
  };
}

export async function seedUserDirect(
  ctx: ServerAppContext,
  input: {
    name: string;
    email: string;
    password: string;
    role: "admin" | "employee";
    designation?: string;
    salaryType?: "monthly" | "hourly";
    baseSalary?: number;
    isActive?: boolean;
  }
) {
  const passwordHash = await hashPassword(input.password);
  const nowIso = new Date().toISOString();
  return ctx.db
    .insert(users)
    .values({
      name: input.name,
      email: input.email.toLowerCase(),
      passwordHash,
      role: input.role,
      designation: input.designation ?? (input.role === "admin" ? "Admin" : "Staff"),
      salaryType: input.salaryType ?? "monthly",
      baseSalary: input.baseSalary ?? 30000,
      isActive: input.isActive ?? true,
      tokenVersion: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .returning()
    .get();
}

export async function loginAdmin(
  ctx: ServerAppContext,
  email: string,
  password: string
): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      email,
      password,
      client_type: "admin_web",
    },
  });
  if (res.statusCode !== 200) {
    throw new Error(`Admin login failed (${res.statusCode}): ${res.body}`);
  }
  return (res.json() as { access_token: string }).access_token;
}

export async function loginEmployee(
  ctx: ServerAppContext,
  email: string,
  password: string,
  deviceId = "dev_test_0001"
): Promise<{ accessToken: string; refreshToken: string; userId: number }> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      email,
      password,
      client_type: "desktop",
      device_id: deviceId,
      device_arch: "x86_64",
    },
  });
  if (res.statusCode !== 200) {
    throw new Error(`Employee login failed (${res.statusCode}): ${res.body}`);
  }
  const body = res.json() as {
    access_token: string;
    refresh_token: string;
    user: { id: number };
  };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    userId: body.user.id,
  };
}

export function createFakeWebpBuffer(sizeBytes: number = 128): Buffer {
  const buf = Buffer.alloc(Math.max(12, sizeBytes), 0x41);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write("WEBP", 8, "ascii");
  return buf;
}

export function buildMultipartScreenshotPayload(
  fields: Record<string, string | number>,
  fileBuffer?: Buffer,
  filename: string = "capture.webp"
): { payload: Buffer; contentType: string } {
  const boundary = `----SMTestBoundary${Date.now()}${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];

  for (const [key, val] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(val)}\r\n`,
        "utf8"
      )
    );
  }

  if (fileBuffer !== undefined) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/webp\r\n\r\n`,
        "utf8"
      )
    );
    chunks.push(fileBuffer);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
