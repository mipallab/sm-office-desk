import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  ChevronDown,
  ChevronRight,
  Clock,
  Images,
  Loader2,
  Lock,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  DEFAULT_COMPANY_TIMEZONE,
  type AdminWsOutbound,
  type ScreenshotListItem,
} from "@sm-office/shared";
import { Modal } from "../components/Modal";
import { ScreenshotLightbox } from "../components/ScreenshotLightbox";
import { SecureScreenshotImage } from "../components/SecureScreenshotImage";
import { useAuth } from "../context/AuthContext";
import { useRealtime } from "../context/RealtimeContext";
import { useToast } from "../context/ToastContext";
import { adminApi, ApiClientError } from "../lib/api";
import { formatBytesKb, getExpiryInfo } from "../lib/format";
import type { LightboxScreenshot, ScreenshotSummaryResponse } from "../types/api";

type GalleryFilter = "all" | "random" | "on_demand" | "screen_locked";

function mapFilterToQuery(filter: GalleryFilter): {
  type: "random" | "on_demand" | "all";
  status: "ok" | "screen_locked" | "all";
} {
  switch (filter) {
    case "random":
      return { type: "random", status: "all" };
    case "on_demand":
      return { type: "on_demand", status: "all" };
    case "screen_locked":
      return { type: "all", status: "screen_locked" };
    case "all":
    default:
      return { type: "all", status: "all" };
  }
}

export function ScreenshotsPage() {
  const { company } = useAuth();
  const { subscribeWs } = useRealtime();
  const { pushToast } = useToast();

  const companyTimezone = company?.company_timezone ?? DEFAULT_COMPANY_TIMEZONE;

  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedHour, setSelectedHour] = useState<string>("");
  const [activeFilter, setActiveFilter] = useState<GalleryFilter>("all");
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");
  const [showDeactivated, setShowDeactivated] = useState<boolean>(true);

  const [summary, setSummary] = useState<ScreenshotSummaryResponse | null>(null);
  const [items, setItems] = useState<ScreenshotListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasNewPendingBanner, setHasNewPendingBanner] = useState<boolean>(false);

  const [collapsedHours, setCollapsedHours] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const [lightboxId, setLightboxId] = useState<number | null>(null);
  const [singleDeleteTarget, setSingleDeleteTarget] =
    useState<LightboxScreenshot | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);

  const singleDeleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const bulkDeleteCancelRef = useRef<HTMLButtonElement | null>(null);

  const loadGallery = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setHasNewPendingBanner(false);
    const filterParams = mapFilterToQuery(activeFilter);
    const effectiveDate = selectedDate || undefined;
    const effectiveHour = effectiveDate && selectedHour ? selectedHour : undefined;

    try {
      const [summaryRes, listRes] = await Promise.all([
        adminApi.getScreenshotsSummary({
          employeeId: selectedEmployeeId ?? undefined,
          date: effectiveDate,
          type: filterParams.type,
          status: filterParams.status,
        }),
        adminApi.listScreenshots({
          employeeId: selectedEmployeeId ?? undefined,
          date: effectiveDate,
          hour: effectiveHour,
          type: filterParams.type,
          status: filterParams.status,
          limit: 24,
          include_presigned: true,
        }),
      ]);

      setSummary(summaryRes);
      setItems(listRes.items);
      setNextCursor(listRes.pagination.next_cursor);
      setHasMore(listRes.pagination.has_more);
      setSelectedIds(new Set());
    } catch (err) {
      setLoadError(
        err instanceof ApiClientError ? err.message : "Failed to load screenshots"
      );
    } finally {
      setLoading(false);
    }
  }, [activeFilter, selectedDate, selectedEmployeeId, selectedHour]);

  useEffect(() => {
    void loadGallery();
  }, [loadGallery]);

  useEffect(() => {
    return subscribeWs((event: AdminWsOutbound) => {
      if (event.type === "screenshot_ready") {
        setHasNewPendingBanner(true);
      }
    });
  }, [subscribeWs]);

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const filterParams = mapFilterToQuery(activeFilter);
    const effectiveDate = selectedDate || undefined;
    const effectiveHour = effectiveDate && selectedHour ? selectedHour : undefined;

    try {
      const res = await adminApi.listScreenshots({
        employeeId: selectedEmployeeId ?? undefined,
        date: effectiveDate,
        hour: effectiveHour,
        type: filterParams.type,
        status: filterParams.status,
        cursor: nextCursor,
        limit: 24,
        include_presigned: true,
      });
      setItems((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const merged = [...prev];
        for (const item of res.items) {
          if (!seen.has(item.id)) merged.push(item);
        }
        return merged;
      });
      setNextCursor(res.pagination.next_cursor);
      setHasMore(res.pagination.has_more);
    } catch (err) {
      pushToast({
        variant: "error",
        title: "Could not load more screenshots",
        message: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setLoadingMore(false);
    }
  };

  const activeEmployees = useMemo(
    () => summary?.employees.filter((e) => e.is_active) ?? [],
    [summary]
  );
  const deactivatedEmployees = useMemo(
    () => summary?.employees.filter((e) => !e.is_active) ?? [],
    [summary]
  );
  const totalAllCount = useMemo(
    () =>
      summary?.employees.reduce((sum, emp) => sum + emp.total_count, 0) ?? 0,
    [summary]
  );

  // Build Date -> Hour -> Items timeline respecting sort order
  const timelineGroups = useMemo(() => {
    const orderedItems =
      sortOrder === "desc" ? items : [...items].reverse();

    const dateMap = new Map<
      string,
      Map<string, ScreenshotListItem[]>
    >();

    for (const item of orderedItems) {
      let hourMap = dateMap.get(item.local_date);
      if (!hourMap) {
        hourMap = new Map();
        dateMap.set(item.local_date, hourMap);
      }
      let bucket = hourMap.get(item.local_hour);
      if (!bucket) {
        bucket = [];
        hourMap.set(item.local_hour, bucket);
      }
      bucket.push(item);
    }

    const dates = Array.from(dateMap.entries()).sort(([a], [b]) =>
      sortOrder === "desc" ? b.localeCompare(a) : a.localeCompare(b)
    );

    return dates.map(([date, hourMap]) => {
      const hours = Array.from(hourMap.entries())
        .sort(([a], [b]) =>
          sortOrder === "desc" ? b.localeCompare(a) : a.localeCompare(b)
        )
        .map(([hour, groupItems]) => ({
          key: `${date}_${hour}`,
          date,
          hour,
          items: groupItems,
        }));
      return { date, hours };
    });
  }, [items, sortOrder]);

  const okItems = useMemo(
    () => items.filter((item) => item.capture_status === "ok"),
    [items]
  );

  const lightboxIndex = useMemo(() => {
    if (lightboxId === null) return -1;
    return okItems.findIndex((i) => i.id === lightboxId);
  }, [lightboxId, okItems]);

  const lightboxItem: ScreenshotListItem | null =
    lightboxIndex >= 0 ? (okItems[lightboxIndex] ?? null) : null;

  const toggleSelectId = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (next.size >= 100) {
          pushToast({
            variant: "warning",
            title: "Bulk selection capped at 100 screenshots",
            message: "Delete the current batch first to select more.",
          });
          return prev;
        }
        next.add(id);
      }
      return next;
    });
  };

  const handleSelectAllInView = () => {
    const slice = items.slice(0, 100).map((i) => i.id);
    setSelectedIds(new Set(slice));
    if (items.length > 100) {
      pushToast({
        variant: "info",
        title: "Selected first 100 screenshots in view",
        message: "Bulk delete processes up to 100 screenshots per batch.",
      });
    }
  };

  const selectedTotalBytes = useMemo(() => {
    let total = 0;
    for (const item of items) {
      if (selectedIds.has(item.id)) {
        total += item.file_size_bytes;
      }
    }
    return total;
  }, [items, selectedIds]);

  const handleConfirmSingleDelete = async () => {
    if (!singleDeleteTarget || deleting) return;
    setDeleting(true);
    try {
      await adminApi.deleteScreenshot(singleDeleteTarget.id);
      const deletedId = singleDeleteTarget.id;
      setSingleDeleteTarget(null);
      if (lightboxId === deletedId) {
        setLightboxId(null);
      }
      pushToast({
        variant: "success",
        title: "Screenshot permanently deleted",
      });
      await loadGallery();
    } catch (err) {
      pushToast({
        variant: "error",
        title: "Delete failed",
        message: err instanceof Error ? err.message : "Could not delete screenshot",
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleConfirmBulkDelete = async () => {
    if (selectedIds.size === 0 || deleting) return;
    setDeleting(true);
    try {
      const ids = Array.from(selectedIds);
      const res = await adminApi.bulkDeleteScreenshots(ids);
      setBulkDeleteOpen(false);
      setSelectedIds(new Set());
      pushToast({
        variant: "success",
        title: `${res.deleted_count} screenshot${res.deleted_count === 1 ? "" : "s"} permanently deleted`,
      });
      await loadGallery();
    } catch (err) {
      pushToast({
        variant: "error",
        title: "Bulk delete failed",
        message: err instanceof Error ? err.message : "Could not delete selected screenshots",
      });
    } finally {
      setDeleting(false);
    }
  };

  const toggleHourCollapse = (key: string) => {
    setCollapsedHours((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const tzDisplay = summary?.company_timezone ?? companyTimezone;
  const typeCounts = summary?.type_counts ?? {
    all: 0,
    random: 0,
    on_demand: 0,
    screen_locked: 0,
  };

  return (
    <div className="space-y-5 pb-20">
      {/* Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs sm:p-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Screenshot Gallery
          </h1>
          <p className="mt-0.5 text-xs font-medium text-slate-600">
            Grouped in Company Timezone:{" "}
            <span className="font-semibold text-slate-800">{tzDisplay}</span> ·
            Employee → Date → Time
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            <Clock className="h-3.5 w-3.5 text-slate-500" strokeWidth={1.75} aria-hidden="true" />
            Retention: 90d Policy
          </span>
          <button
            type="button"
            onClick={() => void loadGallery()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </div>

      {hasNewPendingBanner ? (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-xs font-medium text-indigo-900"
        >
          <span>New screenshot activity received in real time.</span>
          <button
            type="button"
            onClick={() => void loadGallery()}
            className="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
          >
            Reload Gallery
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Level 1 & Level 2 Left Navigation (<1024px Dropdowns, >=1024px Sidebar) */}
        <aside className="space-y-4 lg:col-span-3">
          {/* Mobile/Tablet (<1024px) Compact Selectors */}
          <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs sm:grid-cols-2 lg:hidden">
            <div>
              <label
                htmlFor="mobile-emp-select"
                className="block text-xs font-semibold uppercase tracking-wide text-slate-600"
              >
                1. Employee
              </label>
              <select
                id="mobile-emp-select"
                value={selectedEmployeeId ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setSelectedEmployeeId(val ? Number(val) : null);
                  setSelectedDate("");
                  setSelectedHour("");
                }}
                className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
              >
                <option value="">All Employees ({totalAllCount})</option>
                {activeEmployees.map((emp) => (
                  <option key={emp.employee_id} value={emp.employee_id}>
                    {emp.employee_name} ({emp.total_count})
                  </option>
                ))}
                {deactivatedEmployees.length > 0 ? (
                  <optgroup label="Deactivated (Retained ≤90d)">
                    {deactivatedEmployees.map((emp) => (
                      <option key={emp.employee_id} value={emp.employee_id}>
                        {emp.employee_name} ({emp.total_count})
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            </div>

            <div>
              <label
                htmlFor="mobile-date-input"
                className="block text-xs font-semibold uppercase tracking-wide text-slate-600"
              >
                2. Date ({tzDisplay})
              </label>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  id="mobile-date-input"
                  type="date"
                  value={selectedDate}
                  onChange={(e) => {
                    setSelectedDate(e.target.value);
                    setSelectedHour("");
                  }}
                  className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                />
                {selectedDate ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedDate("");
                      setSelectedHour("");
                    }}
                    className="rounded-lg border border-slate-300 px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    All
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          {/* Desktop (>=1024px) Level 1 & Level 2 Hierarchy Lists */}
          <div className="hidden space-y-4 lg:block">
            {/* Level 1: Employees */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                1. Employee
              </h2>
              <div className="mt-2.5 space-y-1">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedEmployeeId(null);
                    setSelectedDate("");
                    setSelectedHour("");
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 ${
                    selectedEmployeeId === null
                      ? "bg-indigo-50 text-indigo-800"
                      : "text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  <span>All Employees</span>
                  <span className="text-xs font-semibold tabular-nums">
                    {totalAllCount}
                  </span>
                </button>

                {activeEmployees.map((emp) => (
                  <button
                    key={emp.employee_id}
                    type="button"
                    onClick={() => {
                      setSelectedEmployeeId(emp.employee_id);
                      setSelectedDate("");
                      setSelectedHour("");
                    }}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 ${
                      selectedEmployeeId === emp.employee_id
                        ? "bg-indigo-50 font-semibold text-indigo-800"
                        : "text-slate-700 hover:bg-slate-100"
                    }`}
                  >
                    <span className="truncate pr-2">{emp.employee_name}</span>
                    <span className="text-xs font-medium text-slate-500 tabular-nums">
                      {emp.total_count}
                    </span>
                  </button>
                ))}

                {deactivatedEmployees.length > 0 ? (
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => setShowDeactivated((v) => !v)}
                      className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                    >
                      {showDeactivated ? (
                        <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      )}
                      Deactivated (Retained ≤90d)
                    </button>
                    {showDeactivated ? (
                      <div className="mt-1 space-y-1 pl-2">
                        {deactivatedEmployees.map((emp) => (
                          <button
                            key={emp.employee_id}
                            type="button"
                            onClick={() => {
                              setSelectedEmployeeId(emp.employee_id);
                              setSelectedDate("");
                              setSelectedHour("");
                            }}
                            className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 ${
                              selectedEmployeeId === emp.employee_id
                                ? "bg-indigo-50 font-semibold text-indigo-800"
                                : "text-slate-600 hover:bg-slate-100"
                            }`}
                          >
                            <span className="truncate pr-2">{emp.employee_name}</span>
                            <span className="text-xs text-slate-500 tabular-nums">
                              {emp.total_count}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            {/* Level 2: Dates in Company Timezone */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  2. Date ({tzDisplay})
                </h2>
                <Calendar className="h-3.5 w-3.5 text-slate-400" strokeWidth={1.75} aria-hidden="true" />
              </div>

              <div className="mt-2.5">
                <label htmlFor="desktop-date-jump" className="sr-only">
                  Jump to date
                </label>
                <input
                  id="desktop-date-jump"
                  type="date"
                  value={selectedDate}
                  onChange={(e) => {
                    setSelectedDate(e.target.value);
                    setSelectedHour("");
                  }}
                  className="block w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                />
              </div>

              <div className="mt-2.5 max-h-72 space-y-1 overflow-y-auto">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedDate("");
                    setSelectedHour("");
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 ${
                    selectedDate === ""
                      ? "bg-indigo-50 text-indigo-800"
                      : "text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  <span>All Dates</span>
                  <span className="tabular-nums">
                    {summary?.dates.reduce((acc, d) => acc + d.count, 0) ?? 0}
                  </span>
                </button>

                {(summary?.dates ?? []).map((d) => (
                  <button
                    key={d.date}
                    type="button"
                    onClick={() => {
                      setSelectedDate(d.date);
                      setSelectedHour("");
                    }}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 ${
                      selectedDate === d.date
                        ? "bg-indigo-50 font-semibold text-indigo-800"
                        : "text-slate-700 hover:bg-slate-100"
                    }`}
                  >
                    <span className="font-mono tabular-nums">{d.date}</span>
                    <span className="text-slate-500 tabular-nums">{d.count}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </aside>

        {/* Level 3: Time Slots, Type Filters & Grid */}
        <section className="space-y-4 lg:col-span-9">
          <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div
                className="flex flex-wrap items-center gap-1.5"
                role="group"
                aria-label="Capture type filter"
              >
                {(
                  [
                    { id: "all", label: "All", count: typeCounts.all },
                    { id: "random", label: "Random", count: typeCounts.random },
                    { id: "on_demand", label: "On-Demand", count: typeCounts.on_demand },
                    {
                      id: "screen_locked",
                      label: "Screen Locked",
                      count: typeCounts.screen_locked,
                    },
                  ] as const
                ).map((pill) => {
                  const active = activeFilter === pill.id;
                  return (
                    <button
                      key={pill.id}
                      type="button"
                      onClick={() => setActiveFilter(pill.id)}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 tabular-nums ${
                        active
                          ? "border-indigo-200 bg-indigo-50 text-indigo-800"
                          : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
                      }`}
                    >
                      <span>{pill.label}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[11px] ${
                          active ? "bg-indigo-100 text-indigo-900" : "bg-white text-slate-600"
                        }`}
                      >
                        {pill.count}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="hour-filter" className="sr-only">
                  Filter by hour
                </label>
                <select
                  id="hour-filter"
                  value={selectedHour}
                  disabled={!selectedDate}
                  onChange={(e) => setSelectedHour(e.target.value)}
                  title={
                    selectedDate
                      ? "Filter captures by hour"
                      : "Select a specific date first to filter by hour"
                  }
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                >
                  <option value="">
                    {selectedDate ? "All Hours" : "Hour (Select date first)"}
                  </option>
                  {(summary?.hours ?? []).map((h) => (
                    <option key={h.hour} value={h.hour}>
                      {h.hour}:00 – {h.hour}:59 ({h.count})
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  onClick={() =>
                    setSortOrder((prev) => (prev === "desc" ? "asc" : "desc"))
                  }
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                >
                  {sortOrder === "desc" ? "Newest First" : "Oldest First"}
                </button>

                <button
                  type="button"
                  disabled={items.length === 0}
                  onClick={handleSelectAllInView}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                >
                  Select All in View
                </button>
              </div>
            </div>
          </div>

          {loadError ? (
            <div
              role="alert"
              className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
            >
              {loadError}
            </div>
          ) : loading ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {[1, 2, 3, 4, 5, 6].map((idx) => (
                <div
                  key={idx}
                  className="h-56 animate-pulse rounded-xl border border-slate-200 bg-white p-3"
                >
                  <div className="aspect-video w-full rounded-lg bg-slate-200" />
                  <div className="mt-3 h-4 w-2/3 rounded bg-slate-200" />
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
              <Images
                className="mx-auto h-8 w-8 text-slate-400"
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <p className="mt-3 text-sm font-semibold text-slate-800">
                No screenshots match the current filters
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Try clearing date or type filters to inspect available captures.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {timelineGroups.map((dateGroup) => (
                <div key={dateGroup.date} className="space-y-4">
                  {!selectedDate ? (
                    <div className="flex items-center gap-2 border-b border-slate-200 pb-1.5">
                      <Calendar
                        className="h-4 w-4 text-slate-500"
                        strokeWidth={1.75}
                        aria-hidden="true"
                      />
                      <h2 className="font-mono text-sm font-semibold text-slate-800 tabular-nums">
                        {dateGroup.date}
                      </h2>
                    </div>
                  ) : null}

                  {dateGroup.hours.map((hourGroup) => {
                    const isCollapsed = collapsedHours.has(hourGroup.key);
                    return (
                      <div key={hourGroup.key} className="space-y-3">
                        <button
                          type="button"
                          onClick={() => toggleHourCollapse(hourGroup.key)}
                          className="flex w-full items-center justify-between rounded-lg bg-slate-100/90 px-3 py-2 text-left text-xs font-semibold text-slate-800 hover:bg-slate-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                        >
                          <span className="flex items-center gap-2 font-mono tabular-nums">
                            {isCollapsed ? (
                              <ChevronRight className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                            ) : (
                              <ChevronDown className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                            )}
                            {hourGroup.hour}:00 – {hourGroup.hour}:59 ({tzDisplay})
                          </span>
                          <span className="text-slate-600 tabular-nums">
                            {hourGroup.items.length} event
                            {hourGroup.items.length === 1 ? "" : "s"}
                          </span>
                        </button>

                        {!isCollapsed ? (
                          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                            {hourGroup.items.map((item) => {
                              const isSelected = selectedIds.has(item.id);
                              const expiry = getExpiryInfo(
                                item.expires_at,
                                tzDisplay
                              );
                              const isLocked = item.capture_status === "screen_locked";

                              return (
                                <article
                                  key={item.id}
                                  className={`overflow-hidden rounded-xl border bg-white shadow-xs transition-all ${
                                    isSelected
                                      ? "border-indigo-500 ring-2 ring-indigo-200"
                                      : "border-slate-200"
                                  }`}
                                >
                                  {/* Top Media Slot */}
                                  <div className="relative">
                                    {/* Checkbox */}
                                    <label className="absolute left-2.5 top-2.5 z-10 inline-flex cursor-pointer items-center rounded-md bg-white/95 p-1 shadow-xs ring-1 ring-slate-200">
                                      <input
                                        type="checkbox"
                                        checked={isSelected}
                                        onChange={() => toggleSelectId(item.id)}
                                        aria-label={`Select screenshot from ${item.employee_name} at ${item.local_time}`}
                                        className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-600"
                                      />
                                    </label>

                                    {/* Capture Type Badge */}
                                    <div className="pointer-events-none absolute right-2.5 top-2.5 z-10 flex items-center gap-1">
                                      {isLocked ? (
                                        <span className="rounded-md border border-amber-200 bg-amber-50/95 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800 shadow-xs">
                                          Locked
                                        </span>
                                      ) : null}
                                      <span
                                        title={
                                          item.capture_type === "on_demand" &&
                                          item.triggered_by_admin_id
                                            ? `Requested by Admin #${item.triggered_by_admin_id}`
                                            : undefined
                                        }
                                        className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide shadow-xs ${
                                          item.capture_type === "on_demand"
                                            ? "border-indigo-200 bg-indigo-50/95 text-indigo-800"
                                            : "border-slate-200 bg-slate-100/95 text-slate-700"
                                        }`}
                                      >
                                        {item.capture_type === "on_demand"
                                          ? "On-Demand"
                                          : "Random"}
                                      </span>
                                    </div>

                                    {isLocked ? (
                                      <div className="flex aspect-video w-full flex-col items-center justify-center gap-1.5 border-b border-dashed border-amber-200 bg-amber-50/50 p-4 text-center">
                                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-100 text-amber-800">
                                          <Lock
                                            className="h-4.5 w-4.5"
                                            strokeWidth={1.75}
                                            aria-hidden="true"
                                          />
                                        </div>
                                        <p className="text-xs font-semibold text-amber-900">
                                          Screen Locked / OS Sleep
                                        </p>
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => setLightboxId(item.id)}
                                        aria-label={`Inspect screenshot of ${item.employee_name} at ${item.local_time}`}
                                        className="block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-600"
                                      >
                                        <SecureScreenshotImage
                                          screenshotId={item.id}
                                          imageEndpoint={item.image_endpoint}
                                          presignedUrl={item.presigned_url}
                                          presignedUrlExpiresAt={
                                            item.presigned_url_expires_at
                                          }
                                          alt={`${item.employee_name} screenshot at ${item.local_date} ${item.local_time}`}
                                          aspectClassName="aspect-video"
                                          loading="lazy"
                                        />
                                      </button>
                                    )}
                                  </div>

                                  {/* Footer Metadata */}
                                  <div className="space-y-1.5 p-3">
                                    <div className="flex items-center justify-between gap-2">
                                      <p className="truncate text-sm font-semibold text-slate-900">
                                        {item.employee_name}
                                      </p>
                                      <button
                                        type="button"
                                        onClick={() => setSingleDeleteTarget(item)}
                                        aria-label={`Delete screenshot from ${item.employee_name} at ${item.local_time}`}
                                        className="rounded-md p-1 text-slate-500 hover:bg-rose-50 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600"
                                      >
                                        <Trash2
                                          className="h-4 w-4"
                                          strokeWidth={1.75}
                                          aria-hidden="true"
                                        />
                                      </button>
                                    </div>

                                    <div className="flex flex-wrap items-center justify-between gap-1 text-xs text-slate-600">
                                      <span className="font-mono font-medium text-slate-800 tabular-nums">
                                        {item.local_time}
                                      </span>
                                      {!isLocked ? (
                                        <span className="tabular-nums">
                                          {item.monitor_count} Mon ·{" "}
                                          {formatBytesKb(item.file_size_bytes)}
                                        </span>
                                      ) : (
                                        <span>Metadata only</span>
                                      )}
                                    </div>

                                    <div className="pt-0.5">
                                      <span
                                        title={`Purges ${expiry.exactDate}`}
                                        className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium tabular-nums ${
                                          expiry.tone === "urgent"
                                            ? "border-rose-200 bg-rose-50 text-rose-800"
                                            : expiry.tone === "warning"
                                              ? "border-orange-200 bg-orange-50 text-orange-800"
                                              : "border-slate-200 bg-slate-50 text-slate-600"
                                        }`}
                                      >
                                        {expiry.label}
                                      </span>
                                    </div>
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}

              {hasMore ? (
                <div className="flex justify-center pt-2">
                  <button
                    type="button"
                    disabled={loadingMore}
                    onClick={() => void handleLoadMore()}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                  >
                    {loadingMore ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
                        Loading...
                      </>
                    ) : (
                      "Load More Screenshots"
                    )}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>

      {/* Sticky Bottom Bulk Delete Bar */}
      {selectedIds.size > 0 ? (
        <div
          role="region"
          aria-label="Bulk selection actions"
          aria-live="polite"
          className="fixed bottom-4 left-1/2 z-20 flex w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-300 bg-white px-4 py-3 shadow-md xl:left-[calc(50%+116px)]"
        >
          <div className="flex items-center gap-3 text-sm">
            <span className="rounded-md bg-indigo-50 px-2.5 py-1 font-semibold text-indigo-800 tabular-nums">
              {selectedIds.size} Selected
            </span>
            <span className="hidden text-xs text-slate-600 tabular-nums sm:inline">
              Total ~{formatBytesKb(selectedTotalBytes)}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleSelectAllInView}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
            >
              Select All ({Math.min(100, items.length)})
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setBulkDeleteOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Delete ({selectedIds.size})
            </button>
          </div>
        </div>
      ) : null}

      {/* Lightbox Modal */}
      <ScreenshotLightbox
        screenshot={lightboxItem}
        companyTimezone={tzDisplay}
        canPrev={lightboxIndex > 0}
        canNext={lightboxIndex >= 0 && lightboxIndex < okItems.length - 1}
        onPrev={() => {
          if (lightboxIndex > 0 && okItems[lightboxIndex - 1]) {
            setLightboxId(okItems[lightboxIndex - 1]!.id);
          }
        }}
        onNext={() => {
          if (lightboxIndex >= 0 && okItems[lightboxIndex + 1]) {
            setLightboxId(okItems[lightboxIndex + 1]!.id);
          }
        }}
        onClose={() => setLightboxId(null)}
        onRequestDelete={(shot) => setSingleDeleteTarget(shot)}
      />

      {/* Single Delete Confirmation AlertDialog */}
      <Modal
        open={Boolean(singleDeleteTarget)}
        onClose={() => {
          if (!deleting) setSingleDeleteTarget(null);
        }}
        role="alertdialog"
        labelledBy="single-delete-title"
        describedBy="single-delete-desc"
        initialFocusRef={singleDeleteCancelRef}
        maxWidthClass="max-w-md"
      >
        <div className="p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-700">
              <AlertTriangle className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
            </div>
            <div>
              <h2
                id="single-delete-title"
                className="text-lg font-semibold text-slate-900"
              >
                Delete Screenshot Permanently?
              </h2>
              <p id="single-delete-desc" className="mt-2 text-sm text-slate-600">
                This removes{" "}
                <span className="font-semibold text-slate-900">
                  {singleDeleteTarget?.employee_name}
                </span>
                &apos;s screenshot from{" "}
                <span className="font-mono text-xs font-semibold text-slate-800 tabular-nums">
                  {singleDeleteTarget?.local_date} {singleDeleteTarget?.local_time}{" "}
                  {tzDisplay}
                </span>{" "}
                from both storage and database logs. This action cannot be undone.
              </p>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-2.5">
            <button
              ref={singleDeleteCancelRef}
              type="button"
              disabled={deleting}
              onClick={() => setSingleDeleteTarget(null)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() => void handleConfirmSingleDelete()}
              className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2"
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
              ) : null}
              Delete Permanently
            </button>
          </div>
        </div>
      </Modal>

      {/* Bulk Delete Confirmation AlertDialog */}
      <Modal
        open={bulkDeleteOpen}
        onClose={() => {
          if (!deleting) setBulkDeleteOpen(false);
        }}
        role="alertdialog"
        labelledBy="bulk-delete-title"
        describedBy="bulk-delete-desc"
        initialFocusRef={bulkDeleteCancelRef}
        maxWidthClass="max-w-md"
      >
        <div className="p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-700">
              <AlertTriangle className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
            </div>
            <div>
              <h2
                id="bulk-delete-title"
                className="text-lg font-semibold text-slate-900"
              >
                Permanently Delete {selectedIds.size} Screenshots?
              </h2>
              <p id="bulk-delete-desc" className="mt-2 text-sm text-slate-600 tabular-nums">
                Permanently delete {selectedIds.size} selected screenshot
                {selectedIds.size === 1 ? "" : "s"} (total ~
                {formatBytesKb(selectedTotalBytes)}) from storage and database logs?
                This action cannot be undone.
              </p>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-2.5">
            <button
              ref={bulkDeleteCancelRef}
              type="button"
              disabled={deleting}
              onClick={() => setBulkDeleteOpen(false)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() => void handleConfirmBulkDelete()}
              className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2"
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
              ) : null}
              Delete Selected
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
