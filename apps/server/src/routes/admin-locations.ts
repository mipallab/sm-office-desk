import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import type { LiveEmployeeLocation } from "@sm-office/shared";
import type { AppConfig } from "../config.js";
import type { AppDb } from "../db/client.js";
import { getAppSettingsRow } from "../db/helpers.js";
import { users, workSessions } from "../db/schema.js";
import { createAuthenticateHook, requireAdmin } from "../plugins/auth.js";
import type { WsHub } from "../ws/hub.js";

export interface AdminLocationsRoutesDeps {
  config: AppConfig;
  sqlite: Database.Database;
  db: AppDb;
  wsHub: WsHub;
}

interface LatestLocationRow {
  employee_id: number;
  location_enabled: number;
  latitude: number | null;
  longitude: number | null;
  accuracy_meters: number | null;
  source: "os_native" | "ip_approx" | "disabled";
  recorded_at: string;
}

export function registerAdminLocationsRoutes(
  app: FastifyInstance,
  deps: AdminLocationsRoutesDeps
): void {
  const authenticate = createAuthenticateHook(deps.db, deps.config.jwtSecret);

  app.get(
    "/api/admin/locations/live",
    { preHandler: [authenticate, requireAdmin] },
    async (_request, reply) => {
      const settings = getAppSettingsRow(deps.db);
      const activeEmployees = deps.db
        .select()
        .from(users)
        .where(and(eq(users.role, "employee"), eq(users.isActive, true)))
        .orderBy(asc(users.id))
        .all();

      const activeSessions = deps.db
        .select()
        .from(workSessions)
        .where(eq(workSessions.status, "active"))
        .all();
      const activeSessionByEmp = new Map(
        activeSessions.map((s) => [s.employeeId, s])
      );

      const latestLocRows = deps.sqlite
        .prepare(
          `SELECT employee_id, location_enabled, latitude, longitude,
                  accuracy_meters, source, recorded_at
           FROM (
             SELECT l.*,
                    ROW_NUMBER() OVER (
                      PARTITION BY l.employee_id
                      ORDER BY l.recorded_at DESC, l.id DESC
                    ) AS rn
             FROM location_logs l
           )
           WHERE rn = 1`
        )
        .all() as LatestLocationRow[];

      const latestLocByEmp = new Map(
        latestLocRows.map((row) => [row.employee_id, row])
      );

      const employees: LiveEmployeeLocation[] = activeEmployees.map((emp) => {
        const session = activeSessionByEmp.get(emp.id);
        const latestLoc = latestLocByEmp.get(emp.id);

        if (
          !latestLoc ||
          latestLoc.location_enabled !== 1 ||
          latestLoc.source === "disabled" ||
          latestLoc.latitude === null ||
          latestLoc.longitude === null
        ) {
          return {
            employee_id: emp.id,
            employee_name: emp.name,
            designation: emp.designation,
            is_online: Boolean(session),
            session_id: session?.id ?? null,
            sharing_enabled: false,
            status: "disabled_by_employee",
            label: "Disabled by Employee",
            latitude: null,
            longitude: null,
            accuracy_meters: null,
            source: "disabled",
            recorded_at: latestLoc?.recorded_at ?? null,
          };
        }

        return {
          employee_id: emp.id,
          employee_name: emp.name,
          designation: emp.designation,
          is_online: Boolean(session),
          session_id: session?.id ?? null,
          sharing_enabled: true,
          status: "active",
          label: latestLoc.source === "os_native" ? "OS Native" : "IP Approx",
          latitude: latestLoc.latitude,
          longitude: latestLoc.longitude,
          accuracy_meters: latestLoc.accuracy_meters,
          source: latestLoc.source,
          recorded_at: latestLoc.recorded_at,
        };
      });

      return reply.code(200).send({
        company_timezone: settings.companyTimezone,
        employees,
      });
    }
  );
}
