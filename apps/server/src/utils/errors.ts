import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { ApiErrorCode } from "@sm-office/shared";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly headers?: Record<string, string>
  ) {
    super(message);
    this.name = "AppError";
  }
}

interface SqliteLikeError {
  code?: string;
  message?: string;
}

/**
 * Maps SQLite trigger & unique constraint errors into canonical HTTP AppErrors.
 */
export function mapSqliteError(err: unknown): AppError | null {
  if (!err || typeof err !== "object") return null;
  const sqliteErr = err as SqliteLikeError;
  const msg = sqliteErr.message ?? "";
  const code = sqliteErr.code ?? "";

  if (msg.includes("MAX_EMPLOYEES_EXCEEDED")) {
    return new AppError(
      409,
      "MAX_EMPLOYEES_EXCEEDED",
      "Maximum active employee limit (10) reached"
    );
  }
  if (msg.includes("MAX_ADMINS_EXCEEDED")) {
    return new AppError(
      409,
      "MAX_ADMINS_EXCEEDED",
      "Maximum active administrator limit (2) reached"
    );
  }
  if (msg.includes("CANNOT_DISABLE_LAST_ADMIN")) {
    return new AppError(
      409,
      "CANNOT_DISABLE_LAST_ADMIN",
      "Cannot deactivate, demote, or delete the sole remaining active administrator"
    );
  }

  if (code === "SQLITE_CONSTRAINT_UNIQUE" || msg.includes("UNIQUE constraint failed")) {
    if (msg.includes("users.email")) {
      return new AppError(409, "EMAIL_ALREADY_EXISTS", "Email address is already in use");
    }
    if (
      msg.includes("idx_one_active_session") ||
      msg.includes("work_sessions.employee_id")
    ) {
      return new AppError(
        409,
        "ACTIVE_SESSION_CONFLICT",
        "Employee already has an active session"
      );
    }
    if (
      msg.includes("idx_salary_reports_emp_month") ||
      msg.includes("salary_reports.employee_id")
    ) {
      return new AppError(
        409,
        "SALARY_REPORT_EXISTS",
        "A salary report for this employee and month already exists"
      );
    }
  }

  return null;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof AppError) {
        if (error.headers) {
          for (const [k, v] of Object.entries(error.headers)) {
            reply.header(k, v);
          }
        }
        return reply.code(error.statusCode).send({
          error: {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          },
        });
      }

      if (error instanceof ZodError) {
        const flat = error.flatten();
        return reply.code(400).send({
          error: {
            code: "VALIDATION_ERROR" satisfies ApiErrorCode,
            message: "Request validation failed",
            details: {
              fieldErrors: flat.fieldErrors,
              formErrors: flat.formErrors,
            },
          },
        });
      }

      const fastifyErr = error as FastifyError;
      if (
        fastifyErr.code === "FST_REQ_FILE_TOO_LARGE" ||
        fastifyErr.code === "FST_PARTS_LIMIT" ||
        fastifyErr.code === "FST_FILES_LIMIT" ||
        fastifyErr.code === "FST_FIELDS_LIMIT"
      ) {
        return reply.code(413).send({
          error: {
            code: "PAYLOAD_TOO_LARGE" satisfies ApiErrorCode,
            message: "Uploaded screenshot exceeds the 2 MB maximum limit",
          },
        });
      }

      if (
        fastifyErr.code === "FST_PROTO_VIOLATION" ||
        fastifyErr.code === "FST_INVALID_MULTIPART_CONTENT_TYPE" ||
        fastifyErr.code === "FST_MP_PREMATURE_CLOSE"
      ) {
        return reply.code(400).send({
          error: {
            code: "INVALID_SCREENSHOT_PAYLOAD" satisfies ApiErrorCode,
            message: fastifyErr.message || "Malformed multipart upload payload",
          },
        });
      }

      const mappedSqlite = mapSqliteError(error);
      if (mappedSqlite) {
        return reply.code(mappedSqlite.statusCode).send({
          error: {
            code: mappedSqlite.code,
            message: mappedSqlite.message,
          },
        });
      }

      if (fastifyErr.statusCode && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
        return reply.code(fastifyErr.statusCode).send({
          error: {
            code: "VALIDATION_ERROR" satisfies ApiErrorCode,
            message: fastifyErr.message || "Bad request",
          },
        });
      }

      request.log.error({ err: error }, "Unhandled server error");
      return reply.code(500).send({
        error: {
          code: "INTERNAL_ERROR" satisfies ApiErrorCode,
          message: "Internal server error",
        },
      });
    }
  );
}
