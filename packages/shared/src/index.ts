import { z } from "zod";

// ============================================================================
// Core Constants
// ============================================================================

export const MAX_ACTIVE_EMPLOYEES = 10 as const;
export const MAX_ACTIVE_ADMINS = 2 as const;
export const RETENTION_DAYS = 90 as const;
export const HEARTBEAT_INTERVAL_SECONDS = 60 as const;
export const HEARTBEAT_STALE_TIMEOUT_SECONDS = 180 as const;
export const RANDOM_CAPTURE_MIN_SECONDS = 600 as const;
export const RANDOM_CAPTURE_MAX_SECONDS = 1800 as const;
export const CAPTURE_NOW_COOLDOWN_SECONDS = 5 as const;
export const CAPTURE_NOW_TIMEOUT_SECONDS = 15 as const;
export const PRESIGNED_URL_TTL_SECONDS = 300 as const;
export const MAX_SCREENSHOT_WIDTH_PX = 1920 as const;
export const MAX_ULTRAWIDE_SCREENSHOT_WIDTH_PX = 3840 as const;
export const WEBP_QUALITY = 85 as const;
export const MAX_SCREENSHOT_UPLOAD_BYTES = 2_097_152 as const; // 2 MB
export const PURGE_BATCH_SIZE = 500 as const;
export const DEFAULT_COMPANY_TIMEZONE = "Asia/Dhaka" as const;
export const DEFAULT_CURRENCY_CODE = "BDT" as const;
export const DEFAULT_COMPANY_NAME = "SM Office" as const;

// ============================================================================
// Core Enums & Primitive Schemas
// ============================================================================

export const UserRoleSchema = z.enum(["admin", "employee"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const SalaryTypeSchema = z.enum(["monthly", "hourly"]);
export type SalaryType = z.infer<typeof SalaryTypeSchema>;

export const DeviceOsSchema = z.enum(["windows", "macos", "linux"]);
export type DeviceOs = z.infer<typeof DeviceOsSchema>;

export const DeviceArchSchema = z.enum(["x86_64", "arm64"]);
export type DeviceArch = z.infer<typeof DeviceArchSchema>;

export const SessionStatusSchema = z.enum(["active", "stopped"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const CaptureTypeSchema = z.enum(["random", "on_demand"]);
export type CaptureType = z.infer<typeof CaptureTypeSchema>;

export const CaptureStatusSchema = z.enum(["ok", "screen_locked"]);
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>;

export const LocationSourceSchema = z.enum(["os_native", "ip_approx", "disabled"]);
export type LocationSource = z.infer<typeof LocationSourceSchema>;

export const PaymentStatusSchema = z.enum(["pending", "paid"]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const StorageDriverTypeSchema = z.enum(["r2", "local"]);
export type StorageDriverType = z.infer<typeof StorageDriverTypeSchema>;

export const ClientTypeSchema = z.enum(["admin_web", "desktop"]);
export type ClientType = z.infer<typeof ClientTypeSchema>;

export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const DateYmdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
export const HourHhSchema = z.string().regex(/^([01]\d|2[0-3])$/, "Expected 00..23");
export const ReportMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM");

export function isValidIanaTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const TimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidIanaTimeZone, "Invalid IANA timezone identifier");

// ============================================================================
// Error Envelope
// ============================================================================

export const ApiErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "UNSUPPORTED_ARCHITECTURE",
  "LOCATION_CONSENT_VIOLATION",
  "INVALID_SCREENSHOT_PAYLOAD",
  "INVALID_CREDENTIALS",
  "UNAUTHORIZED",
  "TOKEN_REVOKED",
  "FORBIDDEN",
  "ACCOUNT_DISABLED",
  "NOT_FOUND",
  "SCREENSHOT_NO_IMAGE",
  "MAX_EMPLOYEES_EXCEEDED",
  "MAX_ADMINS_EXCEEDED",
  "CANNOT_DISABLE_LAST_ADMIN",
  "SELF_ADMIN_LOCKOUT",
  "EMAIL_ALREADY_EXISTS",
  "ACTIVE_SESSION_CONFLICT",
  "SESSION_NOT_ACTIVE",
  "EMPLOYEE_OFFLINE",
  "CAPTURE_IN_PROGRESS",
  "SALARY_REPORT_EXISTS",
  "SALARY_REPORT_PAID_LOCKED",
  "PAYLOAD_TOO_LARGE",
  "CAPTURE_COOLDOWN",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;

// ============================================================================
// Auth & User Schemas
// ============================================================================

export const PublicUserSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  email: z.string().email(),
  role: UserRoleSchema,
  designation: z.string(),
  salary_type: SalaryTypeSchema,
  base_salary: z.number().nonnegative(),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type PublicUser = z.infer<typeof PublicUserSchema>;

export const QuotaSummarySchema = z.object({
  active_employees: z.number().int().nonnegative(),
  max_active_employees: z.literal(MAX_ACTIVE_EMPLOYEES),
  active_admins: z.number().int().nonnegative(),
  max_active_admins: z.literal(MAX_ACTIVE_ADMINS),
});
export type QuotaSummary = z.infer<typeof QuotaSummarySchema>;

export const LoginRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(160),
    password: z.string().min(1).max(128),
    client_type: ClientTypeSchema.default("admin_web"),
    device_id: z.string().trim().min(4).max(128).optional(),
    device_arch: z.string().trim().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.client_type === "desktop") {
      if (!data.device_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["device_id"],
          message: "device_id is required for desktop login",
        });
      }
      if (!data.device_arch || !DeviceArchSchema.safeParse(data.device_arch).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["device_arch"],
          message: "Desktop tracker only supports 64-bit x86_64 or arm64 architectures",
        });
      }
    }
  });
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RefreshRequestSchema = z.object({
  refresh_token: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const LogoutRequestSchema = z
  .object({
    all_devices: z.boolean().default(true),
    device_id: z.string().trim().min(1).max(128).optional(),
  })
  .default({});
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

export const AuthTokensResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in_seconds: z.number().int().positive(),
  user: PublicUserSchema,
});
export type AuthTokensResponse = z.infer<typeof AuthTokensResponseSchema>;

export const WorkSessionSchema = z.object({
  id: z.string().uuid(),
  employee_id: z.number().int().positive(),
  device_id: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  last_heartbeat_at: z.string(),
  duration_seconds: z.number().int().nonnegative(),
  device_os: DeviceOsSchema,
  device_arch: DeviceArchSchema,
  app_version: z.string(),
  status: SessionStatusSchema,
});
export type WorkSession = z.infer<typeof WorkSessionSchema>;

export const AppSettingsSchema = z.object({
  id: z.literal(1),
  company_name: z.string(),
  company_timezone: z.string(),
  currency_code: z.string(),
  retention_days: z.number().int().min(7).max(RETENTION_DAYS),
  updated_at: z.string(),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const MeResponseSchema = z.object({
  user: PublicUserSchema,
  company: z.object({
    company_name: z.string(),
    company_timezone: z.string(),
    currency_code: z.string(),
    retention_days: z.number().int(),
  }),
  active_session: WorkSessionSchema.nullable(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

// ============================================================================
// Admin — Users / Employees Management
// ============================================================================

export const ListUsersQuerySchema = z.object({
  role: z.enum(["employee", "admin", "all"]).default("employee"),
  status: z.enum(["active", "inactive", "all"]).default("all"),
  search: z.string().trim().max(100).optional(),
});
export type ListUsersQuery = z.infer<typeof ListUsersQuerySchema>;

export const CreateUserSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(160),
  password: z.string().min(8).max(128),
  role: UserRoleSchema.default("employee"),
  designation: z.string().trim().max(100).default(""),
  salary_type: SalaryTypeSchema.default("monthly"),
  base_salary: z.number().finite().nonnegative().max(100_000_000).default(0),
  is_active: z.boolean().default(true),
});
export type CreateUserInput = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    email: z.string().trim().toLowerCase().email().max(160).optional(),
    password: z.string().min(8).max(128).optional(),
    role: UserRoleSchema.optional(),
    designation: z.string().trim().max(100).optional(),
    salary_type: SalaryTypeSchema.optional(),
    base_salary: z.number().finite().nonnegative().max(100_000_000).optional(),
    is_active: z.boolean().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "At least one field must be provided for update",
  });
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

export const LiveEmployeeSessionStatusSchema = z.object({
  is_online: z.boolean(),
  ws_connected: z.boolean(),
  session_id: z.string().uuid().nullable(),
  device_id: z.string().nullable(),
  device_os: DeviceOsSchema.nullable(),
  device_arch: DeviceArchSchema.nullable(),
  app_version: z.string().nullable(),
  started_at: z.string().nullable(),
  last_heartbeat_at: z.string().nullable(),
  screen_locked: z.boolean(),
  location_enabled: z.boolean(),
});
export type LiveEmployeeSessionStatus = z.infer<typeof LiveEmployeeSessionStatusSchema>;

export const EmployeeListItemSchema = PublicUserSchema.extend({
  live_status: LiveEmployeeSessionStatusSchema.nullable(),
});
export type EmployeeListItem = z.infer<typeof EmployeeListItemSchema>;

export const ListEmployeesResponseSchema = z.object({
  quotas: QuotaSummarySchema,
  users: z.array(EmployeeListItemSchema),
});
export type ListEmployeesResponse = z.infer<typeof ListEmployeesResponseSchema>;

// ============================================================================
// Desktop Tracker — Sessions, Heartbeats & Location Consent
// ============================================================================

export const StartSessionSchema = z.object({
  device_id: z.string().trim().min(4).max(128),
  device_os: DeviceOsSchema,
  device_arch: DeviceArchSchema,
  app_version: z.string().trim().min(1).max(32),
  override_existing: z.boolean().default(false),
});
export type StartSessionInput = z.infer<typeof StartSessionSchema>;

export const StopSessionSchema = z.object({
  session_id: z.string().uuid(),
  reason: z.enum(["user_stop", "app_quit", "system_shutdown"]).default("user_stop"),
});
export type StopSessionInput = z.infer<typeof StopSessionSchema>;

export const HeartbeatSchema = z
  .object({
    session_id: z.string().uuid(),
    screen_locked: z.boolean().default(false),
    location_enabled: z.boolean(),
    latitude: z.number().finite().min(-90).max(90).nullable().optional(),
    longitude: z.number().finite().min(-180).max(180).nullable().optional(),
    accuracy_meters: z.number().finite().nonnegative().max(1_000_000).nullable().optional(),
    location_source: LocationSourceSchema,
  })
  .superRefine((data, ctx) => {
    const hasLat = data.latitude !== null && data.latitude !== undefined;
    const hasLng = data.longitude !== null && data.longitude !== undefined;
    const hasAcc = data.accuracy_meters !== null && data.accuracy_meters !== undefined;

    if (!data.location_enabled) {
      if (hasLat || hasLng || hasAcc) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["latitude"],
          message: "Coordinates and accuracy must be null when location_enabled is false",
        });
      }
      if (data.location_source !== "disabled") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["location_source"],
          message: "location_source must be 'disabled' when location_enabled is false",
        });
      }
      return;
    }

    if (data.location_source === "disabled") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["location_source"],
        message: "location_source cannot be 'disabled' when location_enabled is true",
      });
    }

    if (hasLat !== hasLng) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasLat ? "longitude" : "latitude"],
        message: "latitude and longitude must both be provided or both be null",
      });
    }
  });
export type HeartbeatInput = z.infer<typeof HeartbeatSchema>;

// ============================================================================
// Screenshots
// ============================================================================

export const UploadScreenshotMetaSchema = z
  .object({
    session_id: z.string().uuid(),
    capture_type: CaptureTypeSchema,
    capture_status: CaptureStatusSchema,
    request_id: z.string().uuid().nullable().optional(),
    monitor_count: z.coerce.number().int().min(0).max(16),
    width: z.coerce.number().int().min(0).max(5760),
    height: z.coerce.number().int().min(0).max(4320),
    captured_at_client_monotonic_ms: z.coerce.number().int().nonnegative(),
  })
  .superRefine((data, ctx) => {
    if (data.capture_type === "on_demand" && !data.request_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["request_id"],
        message: "request_id is required for on_demand captures",
      });
    }
    if (data.capture_type === "random" && data.request_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["request_id"],
        message: "request_id must not be provided for random captures",
      });
    }
    if (data.capture_status === "ok") {
      if (data.monitor_count < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["monitor_count"],
          message: "monitor_count must be >= 1 when capture_status is ok",
        });
      }
      if (data.width < 1 || data.height < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["width"],
          message: "width and height must be >= 1 when capture_status is ok",
        });
      }
    } else if (data.capture_status === "screen_locked") {
      if (data.width !== 0 || data.height !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["width"],
          message: "width and height must be 0 when capture_status is screen_locked",
        });
      }
    }
  });
export type UploadScreenshotMeta = z.infer<typeof UploadScreenshotMetaSchema>;

export const ScreenshotRecordSchema = z.object({
  id: z.number().int().positive(),
  employee_id: z.number().int().positive(),
  session_id: z.string().uuid(),
  capture_type: CaptureTypeSchema,
  capture_status: CaptureStatusSchema,
  request_id: z.string().uuid().nullable(),
  triggered_by_admin_id: z.number().int().positive().nullable(),
  monitor_count: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  file_size_bytes: z.number().int().nonnegative(),
  captured_at: z.string(),
  expires_at: z.string(),
});
export type ScreenshotRecord = z.infer<typeof ScreenshotRecordSchema>;

export const ScreenshotListItemSchema = ScreenshotRecordSchema.extend({
  employee_name: z.string(),
  local_date: DateYmdSchema,
  local_hour: HourHhSchema,
  local_time: z.string(),
  image_endpoint: z.string(),
  presigned_url: z.string().url().nullable(),
  presigned_url_expires_at: z.string().nullable(),
});
export type ScreenshotListItem = z.infer<typeof ScreenshotListItemSchema>;

export const ScreenshotQuerySchema = z
  .object({
    employeeId: z.coerce.number().int().positive().optional(),
    date: DateYmdSchema.optional(),
    hour: HourHhSchema.optional(),
    type: z.enum(["random", "on_demand", "all"]).default("all"),
    status: z.enum(["ok", "screen_locked", "all"]).default("all"),
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce.number().int().min(1).max(60).default(24),
    include_presigned: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
  })
  .superRefine((data, ctx) => {
    if (data.hour && !data.date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hour"],
        message: "date (YYYY-MM-DD) is required when filtering by hour",
      });
    }
  });
export type ScreenshotQuery = z.infer<typeof ScreenshotQuerySchema>;

export const BulkDeleteScreenshotsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});
export type BulkDeleteScreenshotsInput = z.infer<typeof BulkDeleteScreenshotsSchema>;

export const CaptureNowResponseSchema = z.object({
  request_id: z.string().uuid(),
  employee_id: z.number().int().positive(),
  status: z.literal("pending"),
  timeout_seconds: z.literal(CAPTURE_NOW_TIMEOUT_SECONDS),
  cooldown_seconds: z.literal(CAPTURE_NOW_COOLDOWN_SECONDS),
  expires_at: z.string(),
});
export type CaptureNowResponse = z.infer<typeof CaptureNowResponseSchema>;

export const ImagePresignedJsonSchema = z.object({
  mode: z.literal("presigned_url"),
  url: z.string().url(),
  expires_in_seconds: z.number().int().positive(),
  expires_at: z.string(),
});
export type ImagePresignedJson = z.infer<typeof ImagePresignedJsonSchema>;

// ============================================================================
// Live Locations
// ============================================================================

export const LiveEmployeeLocationSchema = z.object({
  employee_id: z.number().int().positive(),
  employee_name: z.string(),
  designation: z.string(),
  is_online: z.boolean(),
  session_id: z.string().uuid().nullable(),
  sharing_enabled: z.boolean(),
  status: z.enum(["active", "disabled_by_employee"]),
  label: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  accuracy_meters: z.number().nullable(),
  source: LocationSourceSchema,
  recorded_at: z.string().nullable(),
});
export type LiveEmployeeLocation = z.infer<typeof LiveEmployeeLocationSchema>;

export const LiveLocationsResponseSchema = z.object({
  company_timezone: z.string(),
  employees: z.array(LiveEmployeeLocationSchema),
});
export type LiveLocationsResponse = z.infer<typeof LiveLocationsResponseSchema>;

// ============================================================================
// Salary Reports
// ============================================================================

export const ListSalaryReportsQuerySchema = z.object({
  month: ReportMonthSchema.optional(),
  employeeId: z.coerce.number().int().positive().optional(),
  paymentStatus: z.enum(["pending", "paid", "all"]).default("all"),
});
export type ListSalaryReportsQuery = z.infer<typeof ListSalaryReportsQuerySchema>;

export const CreateSalaryReportSchema = z.object({
  employee_id: z.number().int().positive(),
  report_month: ReportMonthSchema,
  overtime_or_bonus: z.number().finite().nonnegative().max(100_000_000).default(0),
  deductions: z.number().finite().nonnegative().max(100_000_000).default(0),
  notes: z.string().trim().max(500).default(""),
});
export type CreateSalaryReportInput = z.infer<typeof CreateSalaryReportSchema>;

export const UpdateSalaryReportSchema = z
  .object({
    overtime_or_bonus: z.number().finite().nonnegative().max(100_000_000).optional(),
    deductions: z.number().finite().nonnegative().max(100_000_000).optional(),
    notes: z.string().trim().max(500).optional(),
    payment_status: PaymentStatusSchema.optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "At least one field must be provided for update",
  });
export type UpdateSalaryReportInput = z.infer<typeof UpdateSalaryReportSchema>;

export const ExportSalaryReportsQuerySchema = z.object({
  month: ReportMonthSchema,
  format: z.literal("csv").default("csv"),
});
export type ExportSalaryReportsQuery = z.infer<typeof ExportSalaryReportsQuerySchema>;

export const SalaryReportSchema = z.object({
  id: z.number().int().positive(),
  employee_id: z.number().int().positive(),
  employee_name: z.string(),
  employee_email: z.string(),
  employee_designation: z.string(),
  report_month: ReportMonthSchema,
  period_start: z.string(),
  period_end: z.string(),
  total_worked_seconds: z.number().int().nonnegative(),
  total_worked_hours: z.number().nonnegative(),
  salary_type_snapshot: SalaryTypeSchema,
  base_rate_snapshot: z.number().nonnegative(),
  overtime_or_bonus: z.number().nonnegative(),
  deductions: z.number().nonnegative(),
  net_payable: z.number().nonnegative(),
  currency_code: z.string(),
  payment_status: PaymentStatusSchema,
  paid_at: z.string().nullable(),
  notes: z.string(),
  created_by_admin_id: z.number().int().positive().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SalaryReport = z.infer<typeof SalaryReportSchema>;

// ============================================================================
// Settings & Audit Logs
// ============================================================================

export const UpdateAppSettingsSchema = z
  .object({
    company_name: z.string().trim().min(2).max(100).optional(),
    company_timezone: TimeZoneSchema.optional(),
    currency_code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, "Expected 3-letter ISO-4217 currency code")
      .optional(),
    retention_days: z.number().int().min(7).max(RETENTION_DAYS).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "At least one field must be provided for update",
  });
export type UpdateAppSettingsInput = z.infer<typeof UpdateAppSettingsSchema>;

export const AuditLogQuerySchema = z.object({
  actorId: z.coerce.number().int().positive().optional(),
  action: z.string().trim().min(1).max(64).optional(),
  targetType: z.string().trim().min(1).max(64).optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;

export const AuditLogEntrySchema = z.object({
  id: z.number().int().positive(),
  actor_id: z.number().int().positive().nullable(),
  actor_name: z.string().nullable(),
  actor_email: z.string().nullable(),
  action: z.string(),
  target_type: z.string(),
  target_id: z.string().nullable(),
  details_json: z.string(),
  created_at: z.string(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

// ============================================================================
// WebSocket Protocol Schemas
// ============================================================================

export const DesktopWsInboundSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("auth"),
    payload: z.object({
      token: z.string().min(1),
      client_type: z.literal("desktop"),
      device_id: z.string().trim().min(4).max(128),
      device_os: DeviceOsSchema,
      device_arch: DeviceArchSchema,
      app_version: z.string().trim().min(1).max(32),
    }),
  }),
  z.object({
    type: z.literal("heartbeat"),
    payload: HeartbeatSchema,
  }),
  z.object({
    type: z.literal("capture_ack"),
    payload: z.object({
      request_id: z.string().uuid(),
      screenshot_id: z.number().int().positive(),
      capture_status: CaptureStatusSchema,
    }),
  }),
  z.object({
    type: z.literal("capture_failed"),
    payload: z.object({
      request_id: z.string().uuid(),
      reason: z.string().trim().min(1).max(300),
      error_code: z.string().trim().max(64).optional(),
    }),
  }),
  z.object({
    type: z.literal("ping"),
    payload: z.object({
      ts: z.number().int().nonnegative(),
    }),
  }),
]);
export type DesktopWsInbound = z.infer<typeof DesktopWsInboundSchema>;

export const ForceStopReasonSchema = z.enum([
  "account_deactivated",
  "session_overridden",
  "admin_force_stop",
  "token_revoked",
]);
export type ForceStopReason = z.infer<typeof ForceStopReasonSchema>;

export const DesktopWsOutboundSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("auth_ok"),
    payload: z.object({
      user_id: z.number().int().positive(),
      server_time_utc: z.string(),
      active_session_id: z.string().uuid().nullable(),
      heartbeat_interval_seconds: z.literal(HEARTBEAT_INTERVAL_SECONDS),
    }),
  }),
  z.object({
    type: z.literal("auth_error"),
    payload: z.object({
      code: z.string(),
      message: z.string(),
    }),
  }),
  z.object({
    type: z.literal("CAPTURE_NOW"),
    payload: z.object({
      request_id: z.string().uuid(),
      triggered_by_admin_id: z.number().int().positive(),
      requested_at: z.string(),
      timeout_seconds: z.literal(CAPTURE_NOW_TIMEOUT_SECONDS),
    }),
  }),
  z.object({
    type: z.literal("FORCE_STOP"),
    payload: z.object({
      session_id: z.string().uuid().nullable(),
      reason: ForceStopReasonSchema,
      message: z.string(),
    }),
  }),
  z.object({
    type: z.literal("pong"),
    payload: z.object({
      ts: z.number().int().nonnegative(),
      server_time_utc: z.string(),
    }),
  }),
]);
export type DesktopWsOutbound = z.infer<typeof DesktopWsOutboundSchema>;

export const AdminWsInboundSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("auth"),
    payload: z.object({
      token: z.string().min(1),
      client_type: z.literal("admin_web"),
    }),
  }),
  z.object({
    type: z.literal("ping"),
    payload: z.object({
      ts: z.number().int().nonnegative(),
    }),
  }),
]);
export type AdminWsInbound = z.infer<typeof AdminWsInboundSchema>;

export const AdminWsOutboundSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("auth_ok"),
    payload: z.object({
      user_id: z.number().int().positive(),
      server_time_utc: z.string(),
      online_employee_ids: z.array(z.number().int().positive()),
    }),
  }),
  z.object({
    type: z.literal("auth_error"),
    payload: z.object({
      code: z.string(),
      message: z.string(),
    }),
  }),
  z.object({
    type: z.literal("employee_status"),
    payload: z.object({
      employee_id: z.number().int().positive(),
      is_online: z.boolean(),
      ws_connected: z.boolean(),
      session_id: z.string().uuid().nullable(),
      device_id: z.string().nullable(),
      device_os: DeviceOsSchema.nullable(),
      device_arch: DeviceArchSchema.nullable(),
      screen_locked: z.boolean(),
      started_at: z.string().nullable(),
      last_heartbeat_at: z.string().nullable(),
      reason: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("location_update"),
    payload: z.object({
      employee_id: z.number().int().positive(),
      sharing_enabled: z.boolean(),
      latitude: z.number().nullable(),
      longitude: z.number().nullable(),
      accuracy_meters: z.number().nullable(),
      source: LocationSourceSchema,
      recorded_at: z.string(),
    }),
  }),
  z.object({
    type: z.literal("capture_status"),
    payload: z.object({
      request_id: z.string().uuid(),
      employee_id: z.number().int().positive(),
      status: z.enum(["pending", "completed", "timeout", "failed"]),
      screenshot_id: z.number().int().positive().nullable().optional(),
      capture_status: CaptureStatusSchema.nullable().optional(),
      reason: z.string().optional(),
      updated_at: z.string(),
    }),
  }),
  z.object({
    type: z.literal("screenshot_ready"),
    payload: z.object({
      screenshot: z.object({
        id: z.number().int().positive(),
        employee_id: z.number().int().positive(),
        session_id: z.string().uuid(),
        capture_type: CaptureTypeSchema,
        capture_status: CaptureStatusSchema,
        request_id: z.string().uuid().nullable(),
        monitor_count: z.number().int().nonnegative(),
        width: z.number().int().nonnegative(),
        height: z.number().int().nonnegative(),
        file_size_bytes: z.number().int().nonnegative(),
        captured_at: z.string(),
        local_date: DateYmdSchema,
        local_hour: HourHhSchema,
        image_endpoint: z.string(),
        presigned_url: z.string().url().nullable().optional(),
      }),
    }),
  }),
  z.object({
    type: z.literal("pong"),
    payload: z.object({
      ts: z.number().int().nonnegative(),
      server_time_utc: z.string(),
    }),
  }),
]);
export type AdminWsOutbound = z.infer<typeof AdminWsOutboundSchema>;

// ============================================================================
// Timezone & Storage Key Helpers
// ============================================================================

export interface TimezoneDateParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  dateString: string; // YYYY-MM-DD
  timeString: string; // HH:mm:ss
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getTimezoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dtfCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    dtfCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Formats an instant into calendar/time components in the given IANA timezone.
 */
export function formatDatePartsInTimezone(
  date: Date | number | string,
  timeZone: string = DEFAULT_COMPANY_TIMEZONE
): TimezoneDateParts {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date value: ${String(date)}`);
  }

  const parts = getTimezoneFormatter(timeZone).formatToParts(d);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      lookup[part.type] = part.value;
    }
  }

  const year = lookup["year"] ?? "1970";
  const month = (lookup["month"] ?? "01").padStart(2, "0");
  const day = (lookup["day"] ?? "01").padStart(2, "0");
  const rawHour = lookup["hour"] ?? "00";
  const hour = rawHour === "24" ? "00" : rawHour.padStart(2, "0");
  const minute = (lookup["minute"] ?? "00").padStart(2, "0");
  const second = (lookup["second"] ?? "00").padStart(2, "0");

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dateString: `${year}-${month}-${day}`,
    timeString: `${hour}:${minute}:${second}`,
  };
}

function localWallClockToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string
): number {
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, second, ms);

  const wallAsUtcMs = (instantMs: number): number => {
    const p = formatDatePartsInTimezone(instantMs, timeZone);
    return Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
      ms
    );
  };

  const offset1 = wallAsUtcMs(guessMs) - guessMs;
  const candidate1 = guessMs - offset1;
  const offset2 = wallAsUtcMs(candidate1) - candidate1;
  return guessMs - offset2;
}

/**
 * Converts a YYYY-MM-DD (and optional HH hour 00..23) in Company Timezone
 * into inclusive UTC ISO-8601 [startUtcIso, endUtcIso] bounds for indexed SQLite queries.
 */
export function getUtcRangeForLocalDate(
  dateString: string,
  timeZone: string = DEFAULT_COMPANY_TIMEZONE,
  hourString?: string
): { startUtcIso: string; endUtcIso: string } {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!dateMatch) {
    throw new Error(`Invalid date string '${dateString}', expected YYYY-MM-DD`);
  }
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);

  let startHour = 0;
  let endHour = 23;
  if (hourString !== undefined) {
    if (!/^([01]\d|2[0-3])$/.test(hourString)) {
      throw new Error(`Invalid hour string '${hourString}', expected 00..23`);
    }
    startHour = Number(hourString);
    endHour = startHour;
  }

  const startMs = localWallClockToUtcMs(year, month, day, startHour, 0, 0, 0, timeZone);
  const endMs = localWallClockToUtcMs(year, month, day, endHour, 59, 59, 999, timeZone);

  return {
    startUtcIso: new Date(startMs).toISOString(),
    endUtcIso: new Date(endMs).toISOString(),
  };
}

/**
 * Converts a YYYY-MM billing month in Company Timezone
 * into inclusive UTC ISO-8601 [startUtcIso, endUtcIso] bounds.
 */
export function getUtcRangeForLocalMonth(
  monthString: string,
  timeZone: string = DEFAULT_COMPANY_TIMEZONE
): { startUtcIso: string; endUtcIso: string } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(monthString);
  if (!match) {
    throw new Error(`Invalid month string '${monthString}', expected YYYY-MM`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const startMs = localWallClockToUtcMs(year, month, 1, 0, 0, 0, 0, timeZone);
  const endMs = localWallClockToUtcMs(year, month, lastDay, 23, 59, 59, 999, timeZone);

  return {
    startUtcIso: new Date(startMs).toISOString(),
    endUtcIso: new Date(endMs).toISOString(),
  };
}

const RAND_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomAlnum6(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 6; i++) {
    const b = bytes[i] ?? 0;
    out += RAND_ALPHABET[b % RAND_ALPHABET.length] ?? "0";
  }
  return out;
}

export interface GenerateScreenshotStorageKeyInput {
  employeeId: number;
  captureType: CaptureType;
  capturedAt?: Date | number | string;
  companyTimezone?: string;
  randomSuffix?: string;
}

/**
 * Generates private object key partitioned by Company Timezone:
 * `<tz_YYYY>/<MM>/<DD>/emp_<id>/<unix_ms>_<rand6>_<type>.webp`
 */
export function generateScreenshotStorageKey(
  input: GenerateScreenshotStorageKeyInput
): string {
  if (!Number.isInteger(input.employeeId) || input.employeeId <= 0) {
    throw new Error(`Invalid employeeId: ${input.employeeId}`);
  }
  const capturedDate =
    input.capturedAt instanceof Date
      ? input.capturedAt
      : input.capturedAt !== undefined
        ? new Date(input.capturedAt)
        : new Date();
  if (Number.isNaN(capturedDate.getTime())) {
    throw new Error(`Invalid capturedAt: ${String(input.capturedAt)}`);
  }

  const timeZone = input.companyTimezone ?? DEFAULT_COMPANY_TIMEZONE;
  const { year, month, day } = formatDatePartsInTimezone(capturedDate, timeZone);
  const unixMs = capturedDate.getTime();
  const suffix = input.randomSuffix ?? randomAlnum6();
  if (!/^[a-z0-9]{6}$/.test(suffix)) {
    throw new Error("randomSuffix must be exactly 6 lowercase alphanumeric characters");
  }

  return `${year}/${month}/${day}/emp_${input.employeeId}/${unixMs}_${suffix}_${input.captureType}.webp`;
}
