import type {
  AdminWsOutbound,
  ApiErrorCode,
  AppSettings,
  AuthTokensResponse,
  CaptureNowResponse,
  CaptureStatus,
  CaptureType,
  DeviceArch,
  DeviceOs,
  ImagePresignedJson,
  LiveEmployeeLocation,
  LiveEmployeeSessionStatus,
  LiveLocationsResponse,
  LocationSource,
  MeResponse,
  PaymentStatus,
  PublicUser,
  QuotaSummary,
  SalaryReport,
  SalaryType,
  ScreenshotListItem,
  StorageDriverType,
  UserRole,
} from "@sm-office/shared";

export type {
  AdminWsOutbound,
  ApiErrorCode,
  AppSettings,
  AuthTokensResponse,
  CaptureNowResponse,
  CaptureStatus,
  CaptureType,
  DeviceArch,
  DeviceOs,
  ImagePresignedJson,
  LiveEmployeeLocation,
  LiveEmployeeSessionStatus,
  LiveLocationsResponse,
  LocationSource,
  MeResponse,
  PaymentStatus,
  PublicUser,
  QuotaSummary,
  SalaryReport,
  SalaryType,
  ScreenshotListItem,
  StorageDriverType,
  UserRole,
};

export interface LatestScreenshotSummary {
  id: number;
  capture_type: CaptureType;
  capture_status: CaptureStatus;
  monitor_count: number;
  width: number;
  height: number;
  file_size_bytes: number;
  captured_at: string;
  local_date: string;
  local_hour: string;
  local_time: string;
  image_endpoint: string;
  presigned_url: string | null;
  presigned_url_expires_at: string | null;
}

export interface AdminEmployeeItem extends PublicUser {
  live_status: LiveEmployeeSessionStatus | null;
  today_worked_seconds: number;
  latest_screenshot: LatestScreenshotSummary | null;
}

export interface AdminEmployeesListResponse {
  quotas: QuotaSummary;
  users: AdminEmployeeItem[];
}

export interface MutateUserResponse {
  user: PublicUser;
  quotas: QuotaSummary;
}

export interface ScreenshotSummaryEmployee {
  employee_id: number;
  employee_name: string;
  is_active: boolean;
  total_count: number;
}

export interface ScreenshotSummaryResponse {
  company_timezone: string;
  employees: ScreenshotSummaryEmployee[];
  dates: Array<{ date: string; count: number }>;
  type_counts: {
    all: number;
    random: number;
    on_demand: number;
    screen_locked: number;
  };
  hours: Array<{ hour: string; count: number }>;
}

export interface ScreenshotsListResponse {
  company_timezone: string;
  pagination: {
    limit: number;
    next_cursor: string | null;
    has_more: boolean;
  };
  items: ScreenshotListItem[];
  grouped: Array<{
    employee_id: number;
    employee_name: string;
    dates: Array<{
      date: string;
      hours: Array<{
        hour: string;
        screenshot_ids: number[];
      }>;
    }>;
  }>;
}

export interface BulkDeleteScreenshotsResponse {
  deleted_count: number;
  deleted_ids: number[];
  not_found_ids: number[];
}

export interface SalaryReportsListResponse {
  currency_code: string;
  summary: {
    total_reports: number;
    pending_count: number;
    paid_count: number;
    total_net_payable: number;
  };
  reports: SalaryReport[];
}

export interface SalaryReportPreviewResponse {
  employee_id: number;
  report_month: string;
  period_start: string;
  period_end: string;
  total_worked_seconds: number;
  total_worked_hours: number;
  salary_type: SalaryType;
  base_salary: number;
  currency_code: string;
  existing_report_id: number | null;
}

export interface AdminRuntimeInfo {
  storage_driver: StorageDriverType;
  r2_account_id?: string;
  r2_bucket_name?: string;
  r2_access_key_id?: string;
  r2_has_secret?: boolean;
  db_sync_enabled?: boolean;
  db_last_synced_at?: string | null;
  max_active_employees: number;
  max_active_admins: number;
}

export interface AdminSettingsResponse {
  settings: AppSettings;
  runtime: AdminRuntimeInfo;
}

export type WsConnectionStatus = "connected" | "reconnecting" | "disconnected";

export interface CaptureUiState {
  phase: "idle" | "pending" | "cooldown";
  requestId: string | null;
  remainingSeconds: number;
  cooldownKind: "captured" | "screen_locked";
  lastAlert: {
    type: "timeout" | "failed";
    message: string;
    at: number;
  } | null;
}

export interface LightboxScreenshot {
  id: number;
  employee_id: number;
  employee_name: string;
  capture_type: CaptureType;
  capture_status: CaptureStatus;
  triggered_by_admin_id?: number | null;
  monitor_count: number;
  width: number;
  height: number;
  file_size_bytes: number;
  captured_at: string;
  expires_at?: string;
  local_date: string;
  local_hour: string;
  local_time: string;
  image_endpoint: string;
  presigned_url: string | null;
  presigned_url_expires_at: string | null;
}
