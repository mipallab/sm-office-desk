import crypto from "node:crypto";
import type { UserRole } from "@sm-office/shared";
import { AppError } from "./errors.js";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(derivedKey);
    });
  });
}

/**
 * Hashes a password with Node's built-in `crypto.scrypt` (`N=16384, r=8, p=1`).
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Verifies a plaintext password against a stored `scrypt$...` hash in constant time.
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const hashHex = parts[5];

  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n <= 1 ||
    r <= 0 ||
    p <= 0 ||
    !saltHex ||
    !hashHex
  ) {
    return false;
  }

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }

  try {
    const derived = await scryptAsync(password, salt, expected.length, {
      N: n,
      r: r,
      p: p,
      maxmem: 128 * 1024 * 1024,
    });
    if (derived.length !== expected.length) {
      return false;
    }
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export type JwtTokenType = "access" | "refresh";

export interface JwtClaims {
  sub: number;
  role: UserRole;
  tv: number;
  type: JwtTokenType;
  jti: string;
  iat: number;
  exp: number;
}

export interface SignJwtInput {
  sub: number;
  role: UserRole;
  tv: number;
  type: JwtTokenType;
  ttlSeconds: number;
  secret: string;
}

const JWT_HEADER_B64 = Buffer.from(
  JSON.stringify({ alg: "HS256", typ: "JWT" }),
  "utf8"
).toString("base64url");

export function signJwt(input: SignJwtInput): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims: JwtClaims = {
    sub: input.sub,
    role: input.role,
    tv: input.tv,
    type: input.type,
    jti: crypto.randomUUID(),
    iat: nowSec,
    exp: nowSec + input.ttlSeconds,
  };

  const payloadB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = `${JWT_HEADER_B64}.${payloadB64}`;
  const sig = crypto
    .createHmac("sha256", input.secret)
    .update(signingInput)
    .digest("base64url");

  return `${signingInput}.${sig}`;
}

export function verifyJwt(
  token: string,
  secret: string,
  expectedType?: JwtTokenType
): JwtClaims {
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw new AppError(401, "UNAUTHORIZED", "Malformed authentication token");
  }

  const [headerB64, payloadB64, sigB64] = segments as [string, string, string];
  if (!headerB64 || !payloadB64 || !sigB64) {
    throw new AppError(401, "UNAUTHORIZED", "Malformed authentication token");
  }

  let headerJson: { alg?: unknown; typ?: unknown };
  try {
    headerJson = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as {
      alg?: unknown;
      typ?: unknown;
    };
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Invalid token header");
  }

  if (headerJson.alg !== "HS256") {
    throw new AppError(401, "UNAUTHORIZED", "Unsupported token algorithm");
  }

  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest();

  let providedSig: Buffer;
  try {
    providedSig = Buffer.from(sigB64, "base64url");
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Invalid token signature");
  }

  if (
    providedSig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(providedSig, expectedSig)
  ) {
    throw new AppError(401, "UNAUTHORIZED", "Invalid token signature");
  }

  let rawClaims: Record<string, unknown>;
  try {
    rawClaims = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as Record<string, unknown>;
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Invalid token payload");
  }

  const sub = rawClaims["sub"];
  const role = rawClaims["role"];
  const tv = rawClaims["tv"];
  const type = rawClaims["type"];
  const jti = rawClaims["jti"];
  const iat = rawClaims["iat"];
  const exp = rawClaims["exp"];

  if (
    typeof sub !== "number" ||
    !Number.isInteger(sub) ||
    sub <= 0 ||
    (role !== "admin" && role !== "employee") ||
    typeof tv !== "number" ||
    !Number.isInteger(tv) ||
    tv < 1 ||
    (type !== "access" && type !== "refresh") ||
    typeof jti !== "string" ||
    typeof iat !== "number" ||
    typeof exp !== "number"
  ) {
    throw new AppError(401, "UNAUTHORIZED", "Invalid token claims");
  }

  if (expectedType && type !== expectedType) {
    throw new AppError(401, "UNAUTHORIZED", `Expected ${expectedType} token`);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (exp <= nowSec) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication token expired");
  }

  return { sub, role, tv, type, jti, iat, exp };
}
