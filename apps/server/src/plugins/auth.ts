import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import type { UserRole } from "@sm-office/shared";
import type { AppDb } from "../db/client.js";
import { users } from "../db/schema.js";
import { verifyJwt } from "../utils/crypto.js";
import { AppError } from "../utils/errors.js";

export interface AuthenticatedUser {
  id: number;
  role: UserRole;
  tokenVersion: number;
  name: string;
  email: string;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthenticatedUser;
  }
}

export function createAuthenticateHook(db: AppDb, jwtSecret: string) {
  return async function authenticate(request: FastifyRequest): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new AppError(401, "UNAUTHORIZED", "Missing or invalid Authorization header");
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      throw new AppError(401, "UNAUTHORIZED", "Missing bearer token");
    }

    const claims = verifyJwt(token, jwtSecret, "access");
    const user = db.select().from(users).where(eq(users.id, claims.sub)).get();

    if (!user || !user.isActive || claims.tv !== user.tokenVersion) {
      throw new AppError(
        401,
        "TOKEN_REVOKED",
        "Session revoked; re-authentication required"
      );
    }

    request.authUser = {
      id: user.id,
      role: user.role,
      tokenVersion: user.tokenVersion,
      name: user.name,
      email: user.email,
    };
  };
}

export async function requireAdmin(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  if (!request.authUser) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  if (request.authUser.role !== "admin") {
    throw new AppError(403, "FORBIDDEN", "Administrator role required");
  }
}

export async function requireEmployee(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  if (!request.authUser) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  if (request.authUser.role !== "employee") {
    throw new AppError(403, "FORBIDDEN", "Employee role required");
  }
}
