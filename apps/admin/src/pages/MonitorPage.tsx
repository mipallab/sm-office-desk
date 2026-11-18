import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Camera,
  Check,
  Clock,
  Globe,
  Loader2,
  Lock,
  MapPinOff,
  Monitor,
  Navigation,
  RefreshCw,
  X,
} from "lucide-react";
import { DEFAULT_COMPANY_TIMEZONE, type AdminWsOutbound } from "@sm-office/shared";
import { ScreenshotLightbox } from "../components/ScreenshotLightbox";
import { SecureScreenshotImage } from "../components/SecureScreenshotImage";
import { TeamLiveMap } from "../components/TeamLiveMap";
import { useAuth } from "../context/AuthContext";
import { useRealtime } from "../context/RealtimeContext";
import { adminApi, ApiClientError } from "../lib/api";
import {
  formatAccuracyDistance,
  formatDeviceLabel,
  formatDurationHm,
  formatDurationHms,
  formatTimeString12h,
  getInitials,
  safeFormatTimezoneParts,
} from "../lib/format";
import type {
  AdminEmployeeItem,
  LightboxScreenshot,
  LiveEmployeeLocation,
} from "../types/api";

type MonitorFilter = "all" | "tracking" | "locked" | "offline" | "sharing";

export function MonitorPage() {
  const { company } = useAuth();
  const {
    subscribeWs,
    subscribeRestFallbackPoll,
    captureStates,
    triggerCaptureNow,
    clearCaptureAlert,
    setQuotas,
    registerEmployeeNames,
  } = useRealtime();

  const companyTimezone = company?.company_timezone ?? DEFAULT_COMPANY_TIMEZONE;

  const [employees, setEmployees] = useState<AdminEmployeeItem[]>([]);
  const [locations, setLocations] = useState<LiveEmployeeLocation[]>([]);
  const [fetchedAtMs, setFetchedAtMs] = useState<number>(() => Date.now());
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<MonitorFilter>("all");
  const [focusRequest, setFocusRequest] = useState<{
    employeeId: number;
    nonce: number;
  } | null>(null);
  const [highlightedCardId, setHighlightedCardId] = useState<number | null>(null);
  const [flashedShotEmpId, setFlashedShotEmpId] = useState<number | null>(null);
  const [lightboxShot, setLightboxShot] = useState<LightboxScreenshot | null>(null);

  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const loadSnapshot = useCallback(
    async (silent: boolean = false) => {
      if (!silent) {
        setLoading(true);
      }
      try {
        const [empRes, locRes] = await Promise.all([
          adminApi.listEmployees({ role: "employee", status: "active" }),
          adminApi.getLiveLocations(),
        ]);
        const ts = Date.now();
        setEmployees(empRes.users);
        setQuotas(empRes.quotas);
        registerEmployeeNames(empRes.users.map((u) => ({ id: u.id, name: u.name })));
        setLocations(locRes.employees);
        setFetchedAtMs(ts);
        setNowMs(ts);
        setLoadError(null);
      } catch (err) {
        if (!silent) {
          setLoadError(
            err instanceof ApiClientError ? err.message : "Failed to load live monitor"
          );
        }
      } finally {
        setLoading(false);
      }
    },
    [registerEmployeeNames, setQuotas]
  );

  useEffect(() => {
    void loadSnapshot(false);
  }, [loadSnapshot]);

  // 1-second timer for live session clocks & Today's total
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 15-second REST fallback poll when WS is disconnected/reconnecting
  useEffect(() => {
    return subscribeRestFallbackPoll(() => {
      void loadSnapshot(true);
    });
  }, [loadSnapshot, subscribeRestFallbackPoll]);

  // Real-time WebSocket updates
  useEffect(() => {
    return subscribeWs((event: AdminWsOutbound) => {
      if (event.type === "auth_ok") {
        void loadSnapshot(true);
        return;
      }

      if (event.type === "employee_status") {
        const p = event.payload;
        setEmployees((prev) =>
          prev.map((emp) => {
            if (emp.id !== p.employee_id) return emp;
            return {
              ...emp,
              live_status: {
                is_online: p.is_online,
                ws_connected: p.ws_connected,
                session_id: p.session_id,
                device_id: p.device_id,
                device_os: p.device_os,
                device_arch: p.device_arch,
                app_version: emp.live_status?.app_version ?? null,
                started_at: p.started_at,
                last_heartbeat_at: p.last_heartbeat_at,
                screen_locked: p.screen_locked,
                location_enabled: emp.live_status?.location_enabled ?? false,
              },
            };
          })
        );
        setLocations((prev) =>
          prev.map((loc) =>
            loc.employee_id === p.employee_id
              ? {
                  ...loc,
                  is_online: p.is_online,
                  session_id: p.session_id,
                }
              : loc
          )
        );
        if (!p.is_online) {
          // Refresh today_worked_seconds cleanly when a session closes
          void loadSnapshot(true);
        }
        return;
      }

      if (event.type === "location_update") {
        const p = event.payload;
        setLocations((prev) =>
          prev.map((loc) => {
            if (loc.employee_id !== p.employee_id) return loc;
            const enabled =
              p.sharing_enabled &&
              p.source !== "disabled" &&
              p.latitude !== null &&
              p.longitude !== null;
            return {
              ...loc,
              sharing_enabled: enabled,
              status: enabled ? "active" : "disabled_by_employee",
              label:
                !enabled
                  ? "Disabled by Employee"
                  : p.source === "os_native"
                    ? "OS Native"
                    : "IP Approx",
              latitude: enabled ? p.latitude : null,
              longitude: enabled ? p.longitude : null,
              accuracy_meters: enabled ? p.accuracy_meters : null,
              source: enabled ? p.source : "disabled",
              recorded_at: p.recorded_at,
            };
          })
        );
        setEmployees((prev) =>
          prev.map((emp) =>
            emp.id === p.employee_id && emp.live_status
              ? {
                  ...emp,
                  live_status: {
                    ...emp.live_status,
                    location_enabled: p.sharing_enabled,
                  },
                }
              : emp
          )
        );
        return;
      }

      if (event.type === "screenshot_ready") {
        const shot = event.payload.screenshot;
        const parts = safeFormatTimezoneParts(shot.captured_at, companyTimezone);
        setEmployees((prev) =>
          prev.map((emp) => {
            if (emp.id !== shot.employee_id) return emp;
            return {
              ...emp,
              latest_screenshot: {
                id: shot.id,
                capture_type: shot.capture_type,
                capture_status: shot.capture_status,
                monitor_count: shot.monitor_count,
                width: shot.width,
                height: shot.height,
                file_size_bytes: shot.file_size_bytes,
                captured_at: shot.captured_at,
                local_date: shot.local_date,
                local_hour: shot.local_hour,
                local_time: parts.timeString,
                image_endpoint: shot.image_endpoint,
                presigned_url: shot.presigned_url ?? null,
                presigned_url_expires_at: shot.presigned_url
                  ? new Date(Date.now() + 300_000).toISOString()
                  : null,
              },
            };
          })
        );
        setFlashedShotEmpId(shot.employee_id);
        window.setTimeout(() => {
          setFlashedShotEmpId((curr) => (curr === shot.employee_id ? null : curr));
        }, 1200);
      }
    });
  }, [companyTimezone, loadSnapshot, subscribeWs]);

  const locationByEmployeeId = useMemo(
    () => new Map(locations.map((l) => [l.employee_id, l])),
    [locations]
  );

  const counts = useMemo(() => {
    let tracking = 0;
    let locked = 0;
    let offline = 0;
    let sharing = 0;
    for (const emp of employees) {
      const live = emp.live_status;
      const loc = locationByEmployeeId.get(emp.id);
      if (live?.is_online) {
        if (live.screen_locked) {
          locked += 1;
        } else {
          tracking += 1;
        }
        if (loc?.sharing_enabled && loc.latitude !== null && loc.longitude !== null) {
          sharing += 1;
        }
      } else {
        offline += 1;
      }
    }
    return {
      all: employees.length,
      tracking,
      locked,
      offline,
      sharing,
    };
  }, [employees, locationByEmployeeId]);

  const filteredEmployees = useMemo(() => {
    return employees.filter((emp) => {
      const live = emp.live_status;
      const loc = locationByEmployeeId.get(emp.id);
      switch (filter) {
        case "tracking":
          return Boolean(live?.is_online && !live.screen_locked);
        case "locked":
          return Boolean(live?.is_online && live.screen_locked);
        case "offline":
          return !live?.is_online;
        case "sharing":
          return Boolean(
            live?.is_online &&
              loc?.sharing_enabled &&
              loc.latitude !== null &&
              loc.longitude !== null
          );
        case "all":
        default:
          return true;
      }
    });
  }, [employees, filter, locationByEmployeeId]);

  const handleFocusCard = useCallback((employeeId: number) => {
    setFilter("all");
    window.requestAnimationFrame(() => {
      const el = cardRefs.current.get(employeeId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      setHighlightedCardId(employeeId);
      window.setTimeout(() => {
        setHighlightedCardId((curr) => (curr === employeeId ? null : curr));
      }, 1800);
    });
  }, []);

  const handleFocusMap = useCallback((employeeId: number) => {
    setFocusRequest({ employeeId, nonce: Date.now() });
  }, []);

  const updatedTimeText = useMemo(() => {
    const parts = safeFormatTimezoneParts(fetchedAtMs, companyTimezone);
    return `${parts.timeString} ${companyTimezone}`;
  }, [fetchedAtMs, companyTimezone]);

  const filterChips: Array<{ id: MonitorFilter; label: string; count: number }> = [
    { id: "all", label: "All", count: counts.all },
    { id: "tracking", label: "Tracking", count: counts.tracking },
    { id: "locked", label: "Screen Locked", count: counts.locked },
    { id: "offline", label: "Offline", count: counts.offline },
    { id: "sharing", label: "Sharing Location", count: counts.sharing },
  ];

  return (
    <div className="space-y-5">
      {/* Header & Summary Filter Strip */}
      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Live Monitor
            </h1>
            <p className="mt-0.5 text-xs font-medium text-slate-500 tabular-nums">
              Updated {updatedTimeText} · Active team snapshot ({employees.length} / 10 slots)
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadSnapshot(false)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Refresh
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter monitored employees">
          {filterChips.map((chip) => {
            const active = filter === chip.id;
            return (
              <button
                key={chip.id}
                type="button"
                onClick={() => setFilter(chip.id)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 tabular-nums ${
                  active
                    ? "border-indigo-200 bg-indigo-50 text-indigo-800"
                    : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
                }`}
              >
                <span>{chip.label}</span>
                <span
                  className={`rounded-md px-1.5 py-0.5 text-[11px] ${
                    active ? "bg-indigo-100 text-indigo-900" : "bg-white text-slate-600"
                  }`}
                >
                  {chip.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {loadError ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
        >
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => void loadSnapshot(false)}
            className="rounded-lg border border-rose-300 bg-white px-3 py-1 text-xs font-semibold text-rose-800 hover:bg-rose-100"
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* 7/12 Left Grid + 5/12 Right Map */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <div className="xl:col-span-7">
          {loading ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {[1, 2, 3, 4].map((idx) => (
                <div
                  key={idx}
                  className="h-80 animate-pulse rounded-xl border border-slate-200 bg-white p-5"
                >
                  <div className="h-5 w-2/3 rounded bg-slate-200" />
                  <div className="mt-4 aspect-video w-full rounded-lg bg-slate-200" />
                  <div className="mt-4 h-9 w-full rounded-lg bg-slate-200" />
                </div>
              ))}
            </div>
          ) : filteredEmployees.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
              <p className="text-sm font-semibold text-slate-800">
                {employees.length === 0
                  ? "No active employees registered yet"
                  : "No employees match this filter"}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {employees.length === 0
                  ? "Register employees from the Employees page to begin live monitoring."
                  : "Select 'All' to view your entire team."}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {filteredEmployees.map((emp) => {
                const live = emp.live_status;
                const isOnline = Boolean(live?.is_online);
                const wsConnected = Boolean(live?.ws_connected);
                const isLocked = Boolean(isOnline && live?.screen_locked);
                const loc = locationByEmployeeId.get(emp.id);

                const captureState = captureStates[emp.id] ?? {
                  phase: "idle",
                  requestId: null,
                  remainingSeconds: 0,
                  cooldownKind: "captured",
                  lastAlert: null,
                };

                const sessionElapsedSeconds =
                  isOnline && live?.started_at
                    ? Math.max(
                        0,
                        Math.floor((nowMs - Date.parse(live.started_at)) / 1000)
                      )
                    : 0;
                const todaySeconds =
                  emp.today_worked_seconds +
                  (isOnline
                    ? Math.max(0, Math.floor((nowMs - fetchedAtMs) / 1000))
                    : 0);

                const latest = emp.latest_screenshot;
                const canCaptureNow = isOnline && wsConnected;
                const isPending = captureState.phase === "pending";
                const isCooldown = captureState.phase === "cooldown";
                const isCardHighlighted = highlightedCardId === emp.id;
                const isShotFlashed = flashedShotEmpId === emp.id;

                return (
                  <article
                    key={emp.id}
                    ref={(el) => {
                      if (el) {
                        cardRefs.current.set(emp.id, el as HTMLDivElement);
                      } else {
                        cardRefs.current.delete(emp.id);
                      }
                    }}
                    className={`flex flex-col justify-between rounded-xl border bg-white p-4 shadow-xs transition-all ${
                      isPending
                        ? "border-indigo-400 ring-2 ring-indigo-100"
                        : isCardHighlighted
                          ? "border-indigo-500 ring-2 ring-indigo-200"
                          : "border-slate-200"
                    }`}
                  >
                    <div>
                      {/* Card Header */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-xs font-bold text-indigo-800">
                            {getInitials(emp.name)}
                          </div>
                          <div className="min-w-0">
                            <h2 className="truncate text-[15px] font-semibold text-slate-900">
                              {emp.name}
                            </h2>
                            <p className="truncate text-xs text-slate-500">
                              {emp.designation || "Employee"}
                            </p>
                          </div>
                        </div>

                        {isLocked ? (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
                            <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                            Screen Locked
                          </span>
                        ) : isOnline ? (
                          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-800">
                            <span
                              className="h-2 w-2 rounded-full bg-emerald-500 motion-safe:animate-pulse"
                              aria-hidden="true"
                            />
                            Active
                          </span>
                        ) : (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                            Offline
                          </span>
                        )}
                      </div>

                      {/* Telemetry Row */}
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs">
                        <div className="flex items-center gap-2">
                          <Clock
                            className="h-3.5 w-3.5 text-slate-500"
                            strokeWidth={1.75}
                            aria-hidden="true"
                          />
                          {isOnline ? (
                            <span className="font-mono font-semibold text-slate-900 tabular-nums">
                              {formatDurationHms(sessionElapsedSeconds)}
                            </span>
                          ) : (
                            <span className="font-mono text-slate-500 tabular-nums">
                              00:00:00
                            </span>
                          )}
                          <span className="text-slate-400">·</span>
                          <span className="text-slate-600 tabular-nums">
                            Today: {formatDurationHm(todaySeconds)}
                          </span>
                        </div>

                        <div className="flex items-center gap-1 text-[11px] font-medium text-slate-600">
                          <Monitor className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                          <span>
                            {isOnline
                              ? formatDeviceLabel(live?.device_os, live?.device_arch)
                              : live?.last_heartbeat_at
                                ? `Last: ${safeFormatTimezoneParts(live.last_heartbeat_at, companyTimezone).timeString}`
                                : "Desktop idle"}
                          </span>
                        </div>
                      </div>

                      {/* Latest Screenshot Preview */}
                      <div
                        className={`mt-3 overflow-hidden rounded-lg border transition-all ${
                          isShotFlashed
                            ? "border-emerald-400 ring-2 ring-emerald-200"
                            : "border-slate-200"
                        }`}
                      >
                        {isLocked || latest?.capture_status === "screen_locked" ? (
                          <div className="flex aspect-video w-full flex-col items-center justify-center gap-1.5 bg-amber-50/70 p-4 text-center">
                            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-100 text-amber-800">
                              <Lock className="h-4.5 w-4.5" strokeWidth={1.75} aria-hidden="true" />
                            </div>
                            <p className="text-xs font-semibold text-amber-900">
                              {latest?.capture_status === "screen_locked"
                                ? `Screen locked at ${formatTimeString12h(latest.local_time)}`
                                : "Screen currently locked"}
                            </p>
                            <p className="text-[11px] text-amber-800/80">
                              OS lock / sleep detected — no blank frame stored
                            </p>
                          </div>
                        ) : latest && latest.capture_status === "ok" ? (
                          <button
                            type="button"
                            onClick={() =>
                              setLightboxShot({
                                id: latest.id,
                                employee_id: emp.id,
                                employee_name: emp.name,
                                capture_type: latest.capture_type,
                                capture_status: latest.capture_status,
                                monitor_count: latest.monitor_count,
                                width: latest.width,
                                height: latest.height,
                                file_size_bytes: latest.file_size_bytes,
                                captured_at: latest.captured_at,
                                local_date: latest.local_date,
                                local_hour: latest.local_hour,
                                local_time: formatTimeString12h(latest.local_time),
                                image_endpoint: latest.image_endpoint,
                                presigned_url: latest.presigned_url,
                                presigned_url_expires_at:
                                  latest.presigned_url_expires_at,
                              })
                            }
                            aria-label={`Open latest screenshot of ${emp.name} captured at ${formatTimeString12h(latest.local_time)}`}
                            className="group relative block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
                          >
                            <SecureScreenshotImage
                              screenshotId={latest.id}
                              imageEndpoint={latest.image_endpoint}
                              presignedUrl={latest.presigned_url}
                              presignedUrlExpiresAt={latest.presigned_url_expires_at}
                              alt={`Latest screenshot for ${emp.name}`}
                              aspectClassName="aspect-video"
                              imgClassName="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.01]"
                              loading="lazy"
                            />
                            <div className="flex items-center justify-between bg-slate-900/80 px-2.5 py-1 text-[11px] text-slate-100">
                              <span className="font-mono tabular-nums">
                                {latest.local_date} {formatTimeString12h(latest.local_time)}
                              </span>
                              <span>
                                {latest.capture_type === "on_demand"
                                  ? "On-Demand"
                                  : "Random"}{" "}
                                · {latest.monitor_count} Mon
                              </span>
                            </div>
                          </button>
                        ) : (
                          <div className="flex aspect-video w-full flex-col items-center justify-center gap-1.5 bg-slate-100 p-4 text-center">
                            <Camera
                              className="h-5 w-5 text-slate-400"
                              strokeWidth={1.75}
                              aria-hidden="true"
                            />
                            <p className="text-xs font-medium text-slate-600">
                              Awaiting first capture (10–30m)
                            </p>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Footer: Location + Individual Take Screenshot Now */}
                    <div className="mt-3 space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        {!isOnline ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                            <MapPinOff className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                            Location inactive (offline)
                          </span>
                        ) : loc?.sharing_enabled &&
                          loc.latitude !== null &&
                          loc.longitude !== null ? (
                          <button
                            type="button"
                            onClick={() => handleFocusMap(emp.id)}
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 ${
                              loc.source === "os_native"
                                ? "border-teal-200 bg-teal-50 text-teal-800 hover:bg-teal-100"
                                : "border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-100"
                            }`}
                          >
                            {loc.source === "os_native" ? (
                              <Navigation
                                className="h-3.5 w-3.5"
                                strokeWidth={1.75}
                                aria-hidden="true"
                              />
                            ) : (
                              <Globe
                                className="h-3.5 w-3.5"
                                strokeWidth={1.75}
                                aria-hidden="true"
                              />
                            )}
                            <span className="tabular-nums">
                              {loc.source === "os_native" ? "OS Precise" : "IP Approx"} (
                              {formatAccuracyDistance(loc.accuracy_meters)})
                            </span>
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                            <MapPinOff
                              className="h-3.5 w-3.5"
                              strokeWidth={1.75}
                              aria-hidden="true"
                            />
                            Disabled by Employee
                          </span>
                        )}
                      </div>

                      {/* Inline Timeout / Failure Alert */}
                      {captureState.lastAlert ? (
                        <div
                          role="alert"
                          aria-live="assertive"
                          className={`flex items-start justify-between gap-2 rounded-lg border px-2.5 py-2 text-xs ${
                            captureState.lastAlert.type === "timeout"
                              ? "border-amber-200 bg-amber-50 text-amber-900"
                              : "border-rose-200 bg-rose-50 text-rose-900"
                          }`}
                        >
                          <div className="flex items-start gap-1.5">
                            <AlertTriangle
                              className="mt-0.5 h-3.5 w-3.5 shrink-0"
                              strokeWidth={1.75}
                              aria-hidden="true"
                            />
                            <span>{captureState.lastAlert.message}</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => clearCaptureAlert(emp.id)}
                            aria-label="Dismiss alert"
                            className="rounded p-0.5 hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                          >
                            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                          </button>
                        </div>
                      ) : null}

                      {/* Individual Per-Employee Capture Button (STRICTLY NO GLOBAL CAPTURE ALL) */}
                      <button
                        type="button"
                        disabled={!canCaptureNow || isPending || isCooldown}
                        onClick={() => void triggerCaptureNow(emp.id, emp.name)}
                        className={`inline-flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 ${
                          !canCaptureNow
                            ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-500"
                            : isPending
                              ? "cursor-wait border-indigo-200 bg-indigo-50 text-indigo-800"
                              : isCooldown
                                ? captureState.cooldownKind === "screen_locked"
                                  ? "cursor-not-allowed border-amber-200 bg-amber-50 text-amber-800"
                                  : "cursor-not-allowed border-emerald-200 bg-emerald-50 text-emerald-800"
                                : "border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700"
                        }`}
                      >
                        {!isOnline ? (
                          <>
                            <Camera className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                            Offline — Cannot Capture
                          </>
                        ) : !wsConnected ? (
                          <>
                            <Camera className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                            Device Socket Offline — Cannot Capture
                          </>
                        ) : isPending ? (
                          <>
                            <Loader2
                              className="h-4 w-4 animate-spin"
                              strokeWidth={1.75}
                              aria-hidden="true"
                            />
                            <span className="tabular-nums">
                              Capturing... {captureState.remainingSeconds}s
                            </span>
                          </>
                        ) : isCooldown ? (
                          captureState.cooldownKind === "screen_locked" ? (
                            <>
                              <Lock className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                              <span className="tabular-nums">
                                Screen Locked · Wait {captureState.remainingSeconds}s
                              </span>
                            </>
                          ) : (
                            <>
                              <Check className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                              <span className="tabular-nums">
                                Captured · Wait {captureState.remainingSeconds}s
                              </span>
                            </>
                          )
                        ) : (
                          <>
                            <Camera className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                            Take Screenshot Now
                          </>
                        )}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        {/* 5/12 Right Panel: OpenStreetMap + Leaflet Map */}
        <div className="xl:col-span-5">
          <div className="xl:sticky xl:top-20">
            <TeamLiveMap
              locations={locations}
              companyTimezone={companyTimezone}
              focusRequest={focusRequest}
              onFocusCard={handleFocusCard}
              onTriggerCapture={(id, name) => void triggerCaptureNow(id, name)}
            />
          </div>
        </div>
      </div>

      {/* Lightbox preview from Monitor card */}
      <ScreenshotLightbox
        screenshot={lightboxShot}
        companyTimezone={companyTimezone}
        onClose={() => setLightboxShot(null)}
      />
    </div>
  );
}
