import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, lt, lte } from "drizzle-orm";
import { AuditLogQuerySchema } from "@sm-office/shared";
import type { AppConfig } from "../config.js";
import type { AppDb } from "../db/client.js";
import { auditLogs, users } from "../db/schema.js";
import { createAuthenticateHook, requireAdmin } from "../plugins/auth.js";
import { parseWithSchema } from "../utils/validation.js";

export interface AdminAuditRoutesDeps {
  config: AppConfig;
  db: AppDb;
}

export function registerAdminAuditRoutes(
  app: FastifyInstance,
  deps: AdminAuditRoutesDeps
): void {
  const authenticate = createAuthenticateHook(deps.db, deps.config.jwtSecret);

  app.get(
    "/api/admin/audit-logs",
    { preHandler: [authenticate, requireAdmin] },
    async (request, reply) => {
      const query = parseWithSchema(AuditLogQuerySchema, request.query);

      const conditions = [];
      if (query.actorId !== undefined) {
        conditions.push(eq(auditLogs.actorId, query.actorId));
      }
      if (query.action !== undefined) {
        conditions.push(eq(auditLogs.action, query.action));
      }
      if (query.targetType !== undefined) {
        conditions.push(eq(auditLogs.targetType, query.targetType));
      }
      if (query.from !== undefined) {
        conditions.push(gte(auditLogs.createdAt, query.from));
      }
      if (query.to !== undefined) {
        conditions.push(lte(auditLogs.createdAt, query.to));
      }
      if (query.cursor !== undefined) {
        conditions.push(lt(auditLogs.id, query.cursor));
      }

      const rows = deps.db
        .select({
          log: auditLogs,
          actorName: users.name,
          actorEmail: users.email,
        })
        .from(auditLogs)
        .leftJoin(users, eq(auditLogs.actorId, users.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(auditLogs.id))
        .limit(query.limit + 1)
        .all();

      const hasMore = rows.length > query.limit;
      const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
      const last = pageRows[pageRows.length - 1];

      return reply.code(200).send({
        pagination: {
          limit: query.limit,
          next_cursor: hasMore && last ? last.log.id : null,
          has_more: hasMore,
        },
        logs: pageRows.map(({ log, actorName, actorEmail }) => ({
          id: log.id,
          actor_id: log.actorId,
          actor_name: actorName ?? null,
          actor_email: actorEmail ?? null,
          action: log.action,
          target_type: log.targetType,
          target_id: log.targetId,
          details_json: log.detailsJson,
          created_at: log.createdAt,
        })),
      });
    }
  );
}
