import type {
  ApiErrorCode,
  ApiErrorEnvelope,
  AuthTokensResponse,
  CaptureNowResponse,
  CreateSalaryReportInput,
  CreateUserInput,
  ImagePresignedJson,
  LiveLocationsResponse,
  MeResponse,
  SalaryReport,
  UpdateAppSettingsInput,
  UpdateSalaryReportInput,
  UpdateUserInput,
} from "@sm-office/shared";
import type {
  AdminEmployeesListResponse,
  AdminSettingsResponse,
  BulkDeleteScreenshotsResponse,
  MutateUserResponse,
  SalaryReportPreviewResponse,
  SalaryReportsListResponse,
  ScreenshotSummaryResponse,
  ScreenshotsListResponse,
} from "../types/api";

export const AUTH_STORAGE_KEY = "sm_admin_auth";

export interface StoredAuthTokens {
  access_token: string;
  refresh_token: string;
}

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode | "NETWORK_ERROR" | "UNKNOWN_ERROR",
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

type LogoutListener = (reason?: string) => void;
const logoutListeners = new Set<LogoutListener>();

export function subscribeAuthRevoked(listener: LogoutListener): () => void {
  logoutListeners.add(listener);
  return () => {
    logoutListeners.delete(listener);
  };
}

function notifyAuthRevoked(reason?: string): void {
  for (const listener of logoutListeners) {
    listener(reason);
  }
}

export function getStoredTokens(): StoredAuthTokens | null {
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAuthTokens>;
    if (
      typeof parsed.access_token === "string" &&
      parsed.access_token.length > 0 &&
      typeof parsed.refresh_token === "string" &&
      parsed.refresh_token.length > 0
    ) {
      return {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function setStoredTokens(tokens: StoredAuthTokens): void {
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(tokens));
}

export function clearStoredTokens(): void {
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
}

async function parseErrorResponse(response: Response): Promise<ApiClientError> {
  const retryAfterHeader = response.headers.get("Retry-After");
  let retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
  if (retryAfterSeconds !== undefined && !Number.isFinite(retryAfterSeconds)) {
    retryAfterSeconds = undefined;
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object"
  ) {
    const env = (body as ApiErrorEnvelope).error;
    const detailRetry =
      env.details && typeof env.details["retry_after_seconds"] === "number"
        ? (env.details["retry_after_seconds"] as number)
        : undefined;
    return new ApiClientError(
      response.status,
      env.code ?? "UNKNOWN_ERROR",
      env.message || `Request failed (${response.status})`,
      env.details,
      detailRetry ?? retryAfterSeconds
    );
  }

  return new ApiClientError(
    response.status,
    "UNKNOWN_ERROR",
    response.statusText || `Request failed (${response.status})`,
    undefined,
    retryAfterSeconds
  );
}

let inflightRefresh: Promise<string | null> | null = null;

/**
 * Performs a single-flight POST /api/auth/refresh so concurrent 401 responses
 * share one refresh request instead of racing and revoking tokens.
 */
export async function refreshAccessTokenSingleFlight(): Promise<string | null> {
  if (inflightRefresh) {
    return inflightRefresh;
  }

  const current = getStoredTokens();
  if (!current?.refresh_token) {
    clearStoredTokens();
    notifyAuthRevoked("missing_refresh_token");
    return null;
  }

  inflightRefresh = (async () => {
    try {
      const response = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ refresh_token: current.refresh_token }),
      });

      if (!response.ok) {
        const err = await parseErrorResponse(response);
        clearStoredTokens();
        notifyAuthRevoked(err.code);
        return null;
      }

      const data = (await response.json()) as AuthTokensResponse;
      if (data.user.role !== "admin" || !data.user.is_active) {
        clearStoredTokens();
        notifyAuthRevoked("FORBIDDEN");
        return null;
      }

      setStoredTokens({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      });
      return data.access_token;
    } catch {
      return null;
    } finally {
      inflightRefresh = null;
    }
  })();

  return inflightRefresh;
}

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  skipAuth?: boolean;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

async function rawFetchWithAuth(
  path: string,
  options: ApiRequestOptions = {},
  isRetry: boolean = false
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }

  if (options.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (!options.skipAuth) {
    const tokens = getStoredTokens();
    if (!tokens?.access_token) {
      throw new ApiClientError(401, "UNAUTHORIZED", "Authentication required");
    }
    headers.set("Authorization", `Bearer ${tokens.access_token}`);
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
    throw new ApiClientError(
      0,
      "NETWORK_ERROR",
      "Unable to reach server. Please check your connection."
    );
  }

  if (!options.skipAuth && response.status === 401 && !isRetry) {
    const clonedErr = await parseErrorResponse(response.clone());
    if (clonedErr.code === "TOKEN_REVOKED") {
      clearStoredTokens();
      notifyAuthRevoked("TOKEN_REVOKED");
      throw clonedErr;
    }

    const nextAccessToken = await refreshAccessTokenSingleFlight();
    if (!nextAccessToken) {
      throw clonedErr;
    }
    return rawFetchWithAuth(path, options, true);
  }

  if (!response.ok) {
    const err = await parseErrorResponse(response);
    if (!options.skipAuth && err.status === 401 && err.code === "TOKEN_REVOKED") {
      clearStoredTokens();
      notifyAuthRevoked("TOKEN_REVOKED");
    }
    throw err;
  }

  return response;
}

export async function apiFetch<T>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const response = await rawFetchWithAuth(path, options);
  return (await response.json()) as T;
}

export async function apiFetchBlob(
  path: string,
  signal?: AbortSignal
): Promise<Blob> {
  const response = await rawFetchWithAuth(path, {
    method: "GET",
    signal,
    headers: {
      Accept: "*/*",
    },
  });
  return response.blob();
}

function toQueryString(
  params: Record<string, string | number | boolean | undefined>
): string {
  const sp = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== "") {
      sp.set(key, String(val));
    }
  }
  const str = sp.toString();
  return str ? `?${str}` : "";
}

// ============================================================================
// Typed API Endpoints
// ============================================================================

export const adminApi = {
  login(email: string, password: string): Promise<AuthTokensResponse> {
    return apiFetch<AuthTokensResponse>("/api/auth/login", {
      method: "POST",
      skipAuth: true,
      body: {
        email: email.trim().toLowerCase(),
        password,
        client_type: "admin_web",
      },
    });
  },

  logout(): Promise<{ logged_out: boolean }> {
    return apiFetch<{ logged_out: boolean }>("/api/auth/logout", {
      method: "POST",
      body: { all_devices: true },
    });
  },

  me(): Promise<MeResponse> {
    return apiFetch<MeResponse>("/api/auth/me");
  },

  listEmployees(params?: {
    role?: "employee" | "admin" | "all";
    status?: "active" | "inactive" | "all";
    search?: string;
  }): Promise<AdminEmployeesListResponse> {
    const qs = toQueryString({
      role: params?.role,
      status: params?.status,
      search: params?.search,
    });
    return apiFetch<AdminEmployeesListResponse>(`/api/admin/employees${qs}`);
  },

  createUser(input: CreateUserInput): Promise<MutateUserResponse> {
    return apiFetch<MutateUserResponse>("/api/admin/employees", {
      method: "POST",
      body: input,
    });
  },

  updateUser(id: number, input: UpdateUserInput): Promise<MutateUserResponse> {
    return apiFetch<MutateUserResponse>(`/api/admin/employees/${id}`, {
      method: "PATCH",
      body: input,
    });
  },

  captureNow(employeeId: number): Promise<CaptureNowResponse> {
    return apiFetch<CaptureNowResponse>(
      `/api/admin/employees/${employeeId}/capture-now`,
      {
        method: "POST",
        body: {},
      }
    );
  },

  getLiveLocations(): Promise<LiveLocationsResponse> {
    return apiFetch<LiveLocationsResponse>("/api/admin/locations/live");
  },

  getScreenshotsSummary(params?: {
    employeeId?: number;
    date?: string;
    type?: "random" | "on_demand" | "all";
    status?: "ok" | "screen_locked" | "all";
  }): Promise<ScreenshotSummaryResponse> {
    const qs = toQueryString({
      employeeId: params?.employeeId,
      date: params?.date,
      type: params?.type,
      status: params?.status,
    });
    return apiFetch<ScreenshotSummaryResponse>(`/api/admin/screenshots/summary${qs}`);
  },

  listScreenshots(params?: {
    employeeId?: number;
    date?: string;
    hour?: string;
    type?: "random" | "on_demand" | "all";
    status?: "ok" | "screen_locked" | "all";
    cursor?: string;
    limit?: number;
    include_presigned?: boolean;
  }): Promise<ScreenshotsListResponse> {
    const qs = toQueryString({
      employeeId: params?.employeeId,
      date: params?.date,
      hour: params?.hour,
      type: params?.type,
      status: params?.status,
      cursor: params?.cursor,
      limit: params?.limit,
      include_presigned: params?.include_presigned,
    });
    return apiFetch<ScreenshotsListResponse>(`/api/admin/screenshots${qs}`);
  },

  getPresignedScreenshotUrl(imageEndpoint: string): Promise<ImagePresignedJson> {
    const sep = imageEndpoint.includes("?") ? "&" : "?";
    return apiFetch<ImagePresignedJson>(`${imageEndpoint}${sep}delivery=json`);
  },

  deleteScreenshot(id: number): Promise<{ deleted_id: number }> {
    return apiFetch<{ deleted_id: number }>(`/api/admin/screenshots/${id}`, {
      method: "DELETE",
    });
  },

  bulkDeleteScreenshots(ids: number[]): Promise<BulkDeleteScreenshotsResponse> {
    return apiFetch<BulkDeleteScreenshotsResponse>(
      "/api/admin/screenshots/bulk-delete",
      {
        method: "POST",
        body: { ids },
      }
    );
  },

  listSalaryReports(params?: {
    month?: string;
    employeeId?: number;
    paymentStatus?: "pending" | "paid" | "all";
  }): Promise<SalaryReportsListResponse> {
    const qs = toQueryString({
      month: params?.month,
      employeeId: params?.employeeId,
      paymentStatus: params?.paymentStatus,
    });
    return apiFetch<SalaryReportsListResponse>(`/api/admin/salary-reports${qs}`);
  },

  previewSalaryReport(params: {
    employeeId: number;
    month: string;
  }): Promise<SalaryReportPreviewResponse> {
    const qs = toQueryString({
      employeeId: params.employeeId,
      month: params.month,
    });
    return apiFetch<SalaryReportPreviewResponse>(
      `/api/admin/salary-reports/preview${qs}`
    );
  },

  createSalaryReport(
    input: CreateSalaryReportInput
  ): Promise<{ report: SalaryReport }> {
    return apiFetch<{ report: SalaryReport }>("/api/admin/salary-reports", {
      method: "POST",
      body: input,
    });
  },

  updateSalaryReport(
    id: number,
    input: UpdateSalaryReportInput
  ): Promise<{ report: SalaryReport }> {
    return apiFetch<{ report: SalaryReport }>(`/api/admin/salary-reports/${id}`, {
      method: "PATCH",
      body: input,
    });
  },

  deleteSalaryReport(id: number): Promise<{ deleted_id: number }> {
    return apiFetch<{ deleted_id: number }>(`/api/admin/salary-reports/${id}`, {
      method: "DELETE",
    });
  },

  exportSalaryReportsCsv(month: string): Promise<Blob> {
    const qs = toQueryString({ month, format: "csv" });
    return apiFetchBlob(`/api/admin/salary-reports/export${qs}`);
  },

  getSettings(): Promise<AdminSettingsResponse> {
    return apiFetch<AdminSettingsResponse>("/api/admin/settings");
  },

  updateSettings(
    input: UpdateAppSettingsInput
  ): Promise<{ settings: AdminSettingsResponse["settings"] }> {
    return apiFetch<{ settings: AdminSettingsResponse["settings"] }>(
      "/api/admin/settings",
      {
        method: "PATCH",
        body: input,
      }
    );
  },

  updateStorageConfig(input: {
    storage_driver: "local" | "r2";
    r2_account_id?: string;
    r2_bucket_name?: string;
    r2_access_key_id?: string;
    r2_secret_access_key?: string;
  }): Promise<{ runtime: AdminSettingsResponse["runtime"] }> {
    return apiFetch<{ runtime: AdminSettingsResponse["runtime"] }>(
      "/api/admin/settings/storage",
      {
        method: "PUT",
        body: input,
      }
    );
  },

  syncDatabaseToR2(): Promise<{ runtime: AdminSettingsResponse["runtime"] }> {
    return apiFetch<{ runtime: AdminSettingsResponse["runtime"] }>(
      "/api/admin/settings/storage/sync-db",
      {
        method: "POST",
        body: {},
      }
    );
  },
};
