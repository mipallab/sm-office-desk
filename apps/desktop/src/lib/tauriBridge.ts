import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  BootstrapInfo,
  DesktopBridge,
  TrackerSnapshot,
  UiErrorPayload,
} from "../types";

export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

const previewBootstrap: BootstrapInfo = {
  app_version: "0.1.0",
  device_id: "00000000-0000-4000-8000-previewdev01",
  short_device_id: "dev_000000",
  device_os: "linux",
  device_arch: "x86_64",
  default_server_url: null,
  saved_server_url: null,
};

let previewSnapshot: TrackerSnapshot = {
  authenticated: false,
  user: null,
  company: null,
  server_url: "",
  is_tracking: false,
  session_id: null,
  session_started_at: null,
  elapsed_seconds: 0,
  today_total_seconds: 0,
  ws_status: "disconnected",
  offline_queue_count: 0,
  screen_locked: false,
  location: {
    location_enabled: false,
    location_source: "disabled",
    latitude: null,
    longitude: null,
    accuracy_meters: null,
    os_permission_denied: false,
    ip_fallback_opt_in: false,
    prompt_ip_fallback: false,
  },
  permissions: {
    macos_screen_recording_missing: false,
    wayland_portal_needed: false,
    message: null,
  },
  force_stop: null,
  last_error: null,
};

const fallbackBridge: DesktopBridge = {
  async getBootstrapInfo() {
    return previewBootstrap;
  },
  async restoreSession() {
    return previewSnapshot;
  },
  async getTrackerSnapshot() {
    return previewSnapshot;
  },
  async login() {
    throw {
      status: 0,
      code: "NO_TAURI_RUNTIME",
      message: "Run inside Tauri desktop shell (npm run tauri dev) to authenticate.",
      conflict: null,
    } satisfies UiErrorPayload;
  },
  async logout() {
    previewSnapshot = { ...previewSnapshot, authenticated: false, user: null };
    return previewSnapshot;
  },
  async startTimer() {
    return previewSnapshot;
  },
  async stopTimer() {
    return previewSnapshot;
  },
  async setLocationConsent(enabled: boolean) {
    previewSnapshot = {
      ...previewSnapshot,
      location: {
        ...previewSnapshot.location,
        location_enabled: enabled,
        location_source: "disabled",
      },
    };
    return previewSnapshot;
  },
  async setIpFallbackOptIn() {
    return previewSnapshot;
  },
  async dismissForceStop() {
    previewSnapshot = { ...previewSnapshot, force_stop: null };
    return previewSnapshot;
  },
  async openOsPermissionSettings() {},
  async requestWaylandPortalAccess() {
    return previewSnapshot;
  },
  async onStateChange() {
    return () => {};
  },
  async onSessionConflict() {
    return () => {};
  },
};

export const tauriDesktopBridge: DesktopBridge = {
  getBootstrapInfo: () => invoke<BootstrapInfo>("get_bootstrap_info"),
  restoreSession: () => invoke<TrackerSnapshot>("restore_session"),
  getTrackerSnapshot: () => invoke<TrackerSnapshot>("get_tracker_snapshot"),
  login: (serverUrl, email, password) =>
    invoke<TrackerSnapshot>("login", { serverUrl, email, password }),
  logout: () => invoke<TrackerSnapshot>("logout"),
  startTimer: (overrideExisting) =>
    invoke<TrackerSnapshot>("start_timer", { overrideExisting }),
  stopTimer: () => invoke<TrackerSnapshot>("stop_timer"),
  setLocationConsent: (enabled) =>
    invoke<TrackerSnapshot>("set_location_consent", { enabled }),
  setIpFallbackOptIn: (optIn) =>
    invoke<TrackerSnapshot>("set_ip_fallback_opt_in", { optIn }),
  dismissForceStop: () => invoke<TrackerSnapshot>("dismiss_force_stop"),
  openOsPermissionSettings: () => invoke<void>("open_os_permission_settings"),
  requestWaylandPortalAccess: () =>
    invoke<TrackerSnapshot>("request_wayland_portal_access"),
  onStateChange: (cb) =>
    listen<TrackerSnapshot>("tracker-state", (event) => {
      cb(event.payload);
    }),
  onSessionConflict: (cb) =>
    listen<UiErrorPayload>("session-conflict", (event) => {
      cb(event.payload);
    }),
};

export function getDefaultBridge(): DesktopBridge {
  return isTauriRuntime() ? tauriDesktopBridge : fallbackBridge;
}
