import {
  AlertTriangle,
  Lock,
  LogOut,
  MapPin,
  MapPinOff,
  Play,
  ShieldCheck,
  Square,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  formatAccuracy,
  formatHm,
  formatHms,
  formatLocalTime,
  formatShortDeviceId,
} from "../lib/format";
import type {
  ActiveSessionConflictInfo,
  BootstrapInfo,
  TrackerSnapshot,
} from "../types";

export interface TrackerViewProps {
  bootstrap: BootstrapInfo;
  snapshot: TrackerSnapshot;
  busyAction: string | null;
  actionError: string | null;
  conflict: ActiveSessionConflictInfo | null;
  onStartTimer: (overrideExisting: boolean) => void;
  onStopTimer: () => void;
  onDismissConflict: () => void;
  onLogout: () => void;
  onToggleLocation: (enabled: boolean) => void;
  onSetIpFallback: (optIn: boolean) => void;
  onOpenPermissionSettings: () => void;
  onRequestWaylandPortal: () => void;
}

export function TrackerView({
  bootstrap,
  snapshot,
  busyAction,
  actionError,
  conflict,
  onStartTimer,
  onStopTimer,
  onDismissConflict,
  onLogout,
  onToggleLocation,
  onSetIpFallback,
  onOpenPermissionSettings,
  onRequestWaylandPortal,
}: TrackerViewProps) {
  const user = snapshot.user;
  const loc = snapshot.location;
  const perms = snapshot.permissions;

  const isConnected = snapshot.ws_status === "connected";
  const isReconnecting =
    snapshot.ws_status === "reconnecting" ||
    snapshot.ws_status === "connecting";

  let statusPillLabel = "Ready";
  let statusPillClass =
    "bg-slate-100 text-slate-600 border border-slate-200";

  if (snapshot.offline_queue_count > 0 && !isConnected) {
    statusPillLabel = `Offline: ${snapshot.offline_queue_count} queued`;
    statusPillClass = "bg-amber-50 text-amber-800 border border-amber-200";
  } else if (snapshot.offline_queue_count > 0) {
    statusPillLabel = `Syncing ${snapshot.offline_queue_count}`;
    statusPillClass = "bg-amber-50 text-amber-800 border border-amber-200";
  } else if (isConnected) {
    statusPillLabel = "Connected";
    statusPillClass =
      "bg-emerald-50 text-emerald-700 border border-emerald-200";
  } else if (isReconnecting) {
    statusPillLabel = "Reconnecting";
    statusPillClass = "bg-amber-50 text-amber-800 border border-amber-200";
  } else if (snapshot.is_tracking) {
    statusPillLabel = "Offline";
    statusPillClass = "bg-amber-50 text-amber-800 border border-amber-200";
  }

  let locationCopy =
    "Disabled — Zero GPS coordinates or IP location data are collected.";
  if (loc.location_enabled) {
    if (!snapshot.is_tracking) {
      locationCopy =
        "Enabled — Coordinates are transmitted only after you click Start Timer.";
    } else if (loc.prompt_ip_fallback) {
      locationCopy = "Location permission needed";
    } else if (loc.location_source === "os_native") {
      locationCopy = `Sharing active · Source: OS Precise${formatAccuracy(loc.accuracy_meters)}`;
    } else if (loc.location_source === "ip_approx") {
      locationCopy = `Sharing active · Source: IP Approx${formatAccuracy(loc.accuracy_meters)}`;
    } else {
      locationCopy = "Enabled — Resolving OS location...";
    }
  }

  return (
    <div className="relative flex h-full w-full flex-col justify-between overflow-y-auto bg-slate-50 px-3.5 py-2.5 text-slate-900">
      <div className="space-y-2.5">
        {/* Top Employee Header */}
        <header className="flex items-center justify-between gap-2 border-b border-slate-200 pb-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-tight text-slate-900">
              {user?.name ?? "Employee"}
            </p>
            <p className="truncate text-[11px] text-slate-500">
              {user?.designation ?? "Staff"}
              {snapshot.company ? ` · ${snapshot.company.company_name}` : ""}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${statusPillClass}`}
            >
              {isConnected ? (
                <Wifi className="h-3 w-3" aria-hidden="true" />
              ) : (
                <WifiOff className="h-3 w-3" aria-hidden="true" />
              )}
              <span>{statusPillLabel}</span>
            </span>

            <button
              type="button"
              disabled={snapshot.is_tracking || busyAction !== null}
              aria-disabled={snapshot.is_tracking}
              title={
                snapshot.is_tracking
                  ? "Stop timer before signing out"
                  : "Sign out"
              }
              aria-label={
                snapshot.is_tracking
                  ? "Sign out (Stop timer before signing out)"
                  : "Sign out"
              }
              onClick={onLogout}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-[11px] font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <LogOut className="h-3 w-3" aria-hidden="true" />
              <span>Sign Out</span>
            </button>
          </div>
        </header>

        {/* Inline Error Alert */}
        {actionError || snapshot.last_error ? (
          <div
            role="alert"
            aria-live="assertive"
            className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-800"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600" />
            <span>{actionError ?? snapshot.last_error}</span>
          </div>
        ) : null}

        {/* macOS Screen Recording Permission Warning */}
        {perms.macos_screen_recording_missing ? (
          <div
            role="alert"
            className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900"
          >
            <p className="font-semibold">Screen Recording Permission Needed</p>
            <p className="mt-0.5 text-amber-800">
              Grant permission in System Settings &gt; Privacy &amp; Security
              &gt; Screen Recording, then restart tracking.
            </p>
            <button
              type="button"
              onClick={onOpenPermissionSettings}
              className="mt-1.5 rounded bg-amber-700 px-2 py-1 text-[11px] font-medium text-white hover:bg-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
            >
              Open System Settings
            </button>
          </div>
        ) : null}

        {/* Linux Wayland Portal Setup Banner */}
        {perms.wayland_portal_needed ? (
          <div
            role="alert"
            className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900"
          >
            <p className="font-semibold">Wayland Screen Capture Setup</p>
            <p className="mt-0.5 text-amber-800">
              Approve screen sharing in the system prompt so captures continue
              smoothly.
            </p>
            <button
              type="button"
              onClick={onRequestWaylandPortal}
              className="mt-1.5 rounded bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
            >
              Grant Screen Access
            </button>
          </div>
        ) : null}

        {/* Hero Work Timer Card */}
        <section
          aria-label="Work session timer"
          className="rounded-xl border border-slate-200 bg-white px-3.5 py-3 shadow-xs"
        >
          <div className="flex items-center justify-between gap-2">
            <span
              className={`inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${
                snapshot.is_tracking ? "text-emerald-700" : "text-slate-500"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  snapshot.is_tracking
                    ? "bg-emerald-500 motion-safe:animate-pulse"
                    : "bg-slate-400"
                }`}
              />
              {snapshot.is_tracking ? "Tracking Active" : "Timer Stopped"}
            </span>

            <div className="flex items-center gap-1">
              {snapshot.screen_locked ? (
                <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 border border-amber-200">
                  <Lock className="h-2.5 w-2.5" aria-hidden="true" />
                  Screen Locked
                </span>
              ) : null}
              {snapshot.is_tracking ? (
                <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 border border-slate-200">
                  <Lock className="h-2.5 w-2.5" aria-hidden="true" />
                  Device Bound
                </span>
              ) : null}
            </div>
          </div>

          <div className="my-2 text-center">
            <p className="font-mono text-3xl font-bold tracking-tight text-slate-900 tabular-nums">
              {formatHms(snapshot.elapsed_seconds)}
            </p>
            <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
              Today&apos;s Total: {formatHm(snapshot.today_total_seconds)}
            </p>
          </div>

          {snapshot.is_tracking ? (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={onStopTimer}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-rose-600 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2 disabled:opacity-65"
            >
              <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
              <span>
                {busyAction === "stop" ? "Stopping..." : "Stop Timer"}
              </span>
            </button>
          ) : (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => onStartTimer(false)}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:opacity-65"
            >
              <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
              <span>
                {busyAction === "start" ? "Starting..." : "Start Timer"}
              </span>
            </button>
          )}
        </section>

        {/* Mandatory Screenshot Auditing Notice (Zero employee pause/disable/delay/blur/preview/delete UI) */}
        <section
          aria-label="Mandatory screenshot auditing policy"
          className={`rounded-xl border px-3 py-2.5 transition-colors ${
            snapshot.is_tracking
              ? "border-slate-800 bg-slate-900 text-slate-50"
              : "border-slate-200 bg-slate-100 text-slate-700"
          }`}
        >
          <div className="flex items-start gap-2.5">
            <div
              className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                snapshot.is_tracking
                  ? "bg-slate-800 text-emerald-400"
                  : "bg-slate-200 text-slate-600"
              }`}
            >
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold leading-snug">
                {snapshot.is_tracking
                  ? "Screenshot Auditing Active"
                  : "Screenshot Auditing Ready"}
              </p>
              <p
                className={`mt-0.5 text-[11px] leading-snug ${
                  snapshot.is_tracking ? "text-slate-300" : "text-slate-500"
                }`}
              >
                {snapshot.is_tracking
                  ? "Random (10–30m) & Admin on-demand captures run while timer is active."
                  : "Captures run automatically only while your work timer is active."}
              </p>
            </div>
          </div>
        </section>

        {/* Explicit Live Location Consent Card */}
        <section
          aria-label="Live location consent"
          className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-xs"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {loc.location_enabled ? (
                <MapPin
                  className="h-4 w-4 shrink-0 text-teal-700"
                  aria-hidden="true"
                />
              ) : (
                <MapPinOff
                  className="h-4 w-4 shrink-0 text-slate-400"
                  aria-hidden="true"
                />
              )}
              <span className="text-xs font-semibold text-slate-900">
                Share Live Location
              </span>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={loc.location_enabled}
              aria-label="Share Live Location"
              disabled={busyAction !== null}
              onClick={() => onToggleLocation(!loc.location_enabled)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:opacity-60 ${
                loc.location_enabled ? "bg-teal-600" : "bg-slate-300"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  loc.location_enabled ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>

          <p
            aria-live="polite"
            className={`mt-1 text-[11px] leading-snug ${
              loc.location_enabled && snapshot.is_tracking && !loc.prompt_ip_fallback
                ? loc.location_source === "ip_approx"
                  ? "text-sky-800"
                  : "text-teal-800"
                : "text-slate-500"
            }`}
          >
            {locationCopy}
          </p>

          {loc.location_enabled && loc.prompt_ip_fallback ? (
            <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">
              <p>
                OS location denied. Allow access in OS Privacy Settings or use
                IP Approx fallback?
              </p>
              <div className="mt-1.5 flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => onSetIpFallback(true)}
                  className="rounded bg-sky-700 px-2 py-1 text-[11px] font-medium text-white hover:bg-sky-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                >
                  Enable IP Approx
                </button>
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => onSetIpFallback(false)}
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                >
                  Keep Disabled
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </div>

      {/* Subtle Footer */}
      <footer className="mt-2 flex items-center justify-between border-t border-slate-200 pt-1.5 text-[11px] text-slate-500">
        {snapshot.offline_queue_count > 0 ? (
          <span className="truncate font-medium text-amber-800 tabular-nums">
            Offline · {snapshot.offline_queue_count}{" "}
            {snapshot.offline_queue_count === 1 ? "capture" : "captures"}{" "}
            queued — auto-syncs
          </span>
        ) : snapshot.is_tracking ? (
          <span>Closing window minimizes to tray.</span>
        ) : (
          <span className="font-mono">
            v{bootstrap.app_version} · {bootstrap.short_device_id}
          </span>
        )}
      </footer>

      {/* 409 Active Session Conflict Dialog */}
      {conflict ? (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="conflict-dialog-title"
          aria-describedby="conflict-dialog-desc"
          className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/60 p-4"
        >
          <div className="w-full max-w-[320px] rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
            <h2
              id="conflict-dialog-title"
              className="text-sm font-bold text-slate-900"
            >
              Active Session on Another Device
            </h2>
            <p
              id="conflict-dialog-desc"
              className="mt-1.5 text-xs leading-relaxed text-slate-600"
            >
              You already have an active timer running on{" "}
              <span className="font-semibold text-slate-800">
                {conflict.active_device_os} (
                {formatShortDeviceId(conflict.active_device_id)})
              </span>{" "}
              started at {formatLocalTime(conflict.started_at)}. Only 1 active
              session is allowed at a time.
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                autoFocus
                onClick={onDismissConflict}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => onStartTimer(true)}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
              >
                Override &amp; Start Here
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
