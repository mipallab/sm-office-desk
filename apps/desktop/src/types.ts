export type LocationSource = "os_native" | "ip_approx" | "disabled";

export type WsConnectionStatus =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "disconnected";

export interface UserProfile {
  id: number;
  name: string;
  email: string;
  role: string;
  designation: string;
  salary_type: string;
  base_salary: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CompanyInfo {
  company_name: string;
  company_timezone: string;
  currency_code: string;
  retention_days: number;
}

export interface LocationStatus {
  location_enabled: boolean;
  location_source: LocationSource;
  latitude: number | null;
  longitude: number | null;
  accuracy_meters: number | null;
  os_permission_denied: boolean;
  ip_fallback_opt_in: boolean;
  prompt_ip_fallback: boolean;
}

export interface PermissionWarning {
  macos_screen_recording_missing: boolean;
  wayland_portal_needed: boolean;
  message: string | null;
}

export interface ForceStopBanner {
  reason: string;
  message: string;
  occurred_at_iso: string;
}

export interface ActiveSessionConflictInfo {
  active_session_id: string;
  active_device_id: string;
  active_device_os: string;
  started_at: string;
}

export interface BootstrapInfo {
  app_version: string;
  device_id: string;
  short_device_id: string;
  device_os: string;
  device_arch: string;
  default_server_url: string | null;
  saved_server_url: string | null;
}

export interface TrackerSnapshot {
  authenticated: boolean;
  user: UserProfile | null;
  company: CompanyInfo | null;
  server_url: string;
  is_tracking: boolean;
  session_id: string | null;
  session_started_at: string | null;
  elapsed_seconds: number;
  today_total_seconds: number;
  ws_status: WsConnectionStatus;
  offline_queue_count: number;
  screen_locked: boolean;
  location: LocationStatus;
  permissions: PermissionWarning;
  force_stop: ForceStopBanner | null;
  last_error: string | null;
}

export interface UiErrorPayload {
  status: number;
  code: string;
  message: string;
  conflict: ActiveSessionConflictInfo | null;
}

export interface DesktopBridge {
  getBootstrapInfo: () => Promise<BootstrapInfo>;
  restoreSession: () => Promise<TrackerSnapshot>;
  getTrackerSnapshot: () => Promise<TrackerSnapshot>;
  login: (
    serverUrl: string,
    email: string,
    password: string
  ) => Promise<TrackerSnapshot>;
  logout: () => Promise<TrackerSnapshot>;
  startTimer: (overrideExisting: boolean) => Promise<TrackerSnapshot>;
  stopTimer: () => Promise<TrackerSnapshot>;
  setLocationConsent: (enabled: boolean) => Promise<TrackerSnapshot>;
  setIpFallbackOptIn: (optIn: boolean) => Promise<TrackerSnapshot>;
  dismissForceStop: () => Promise<TrackerSnapshot>;
  openOsPermissionSettings: () => Promise<void>;
  requestWaylandPortalAccess: () => Promise<TrackerSnapshot>;
  onStateChange: (cb: (snapshot: TrackerSnapshot) => void) => Promise<() => void>;
  onSessionConflict: (cb: (err: UiErrorPayload) => void) => Promise<() => void>;
}
