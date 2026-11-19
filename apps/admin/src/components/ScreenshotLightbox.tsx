import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  RotateCcw,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { RETENTION_DAYS } from "@sm-office/shared";
import {
  formatBytesKb,
  formatUtcDateTime,
  getExpiryInfo,
  safeFormatTimezoneParts,
} from "../lib/format";
import type { LightboxScreenshot } from "../types/api";
import { Modal } from "./Modal";
import { SecureScreenshotImage } from "./SecureScreenshotImage";

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.5;

interface PanOffset {
  x: number;
  y: number;
}

interface DragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPanX: number;
  startPanY: number;
}

interface ScreenshotLightboxProps {
  screenshot: LightboxScreenshot | null;
  companyTimezone: string;
  canPrev?: boolean;
  canNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
  onRequestDelete?: (screenshot: LightboxScreenshot) => void;
}

export function ScreenshotLightbox({
  screenshot,
  companyTimezone,
  canPrev = false,
  canNext = false,
  onPrev,
  onNext,
  onClose,
  onRequestDelete,
}: ScreenshotLightboxProps) {
  const [zoom, setZoom] = useState<number>(MIN_ZOOM);
  const [pan, setPan] = useState<PanOffset>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const zoomRef = useRef<number>(MIN_ZOOM);
  const panRef = useRef<PanOffset>({ x: 0, y: 0 });

  zoomRef.current = zoom;
  panRef.current = pan;

  const clampZoom = (value: number): number =>
    Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));

  const clampPan = useCallback(
    (nextX: number, nextY: number, targetZoom: number): PanOffset => {
      if (targetZoom <= MIN_ZOOM) {
        return { x: 0, y: 0 };
      }
      const viewport = viewportRef.current;
      if (!viewport) {
        return { x: nextX, y: nextY };
      }
      const vpRect = viewport.getBoundingClientRect();
      const imgEl = viewport.querySelector("img");
      const baseW = imgEl && imgEl.offsetWidth > 0 ? imgEl.offsetWidth : vpRect.width;
      const baseH = imgEl && imgEl.offsetHeight > 0 ? imgEl.offsetHeight : vpRect.height;

      const maxPanX = Math.max(0, (baseW * targetZoom - vpRect.width) / 2);
      const maxPanY = Math.max(0, (baseH * targetZoom - vpRect.height) / 2);

      return {
        x: Math.min(maxPanX, Math.max(-maxPanX, nextX)),
        y: Math.min(maxPanY, Math.max(-maxPanY, nextY)),
      };
    },
    []
  );

  const applyZoomAtPoint = useCallback(
    (nextZoomRaw: number, clientX?: number, clientY?: number) => {
      const nextZoom = clampZoom(nextZoomRaw);
      const prevZoom = zoomRef.current;
      const prevPan = panRef.current;

      if (nextZoom <= MIN_ZOOM) {
        setZoom(MIN_ZOOM);
        setPan({ x: 0, y: 0 });
        return;
      }

      const viewport = viewportRef.current;
      if (viewport && clientX !== undefined && clientY !== undefined) {
        const vpRect = viewport.getBoundingClientRect();
        const cursorX = clientX - (vpRect.left + vpRect.width / 2);
        const cursorY = clientY - (vpRect.top + vpRect.height / 2);
        const ratio = nextZoom / prevZoom;
        const nextPanX = cursorX - (cursorX - prevPan.x) * ratio;
        const nextPanY = cursorY - (cursorY - prevPan.y) * ratio;
        setZoom(nextZoom);
        setPan(clampPan(nextPanX, nextPanY, nextZoom));
      } else {
        const ratio = nextZoom / prevZoom;
        setZoom(nextZoom);
        setPan(clampPan(prevPan.x * ratio, prevPan.y * ratio, nextZoom));
      }
    },
    [clampPan]
  );

  const resetView = useCallback(() => {
    dragRef.current = null;
    setIsDragging(false);
    setZoom(MIN_ZOOM);
    setPan({ x: 0, y: 0 });
  }, []);

  const zoomToActualPixels = useCallback(() => {
    const viewport = viewportRef.current;
    const imgEl = viewport?.querySelector("img");
    if (screenshot && imgEl && imgEl.offsetWidth > 0 && screenshot.width > 0) {
      const ratio = screenshot.width / imgEl.offsetWidth;
      const targetZoom = clampZoom(Math.max(ratio, 1.25));
      setZoom(targetZoom);
      setPan({ x: 0, y: 0 });
      return;
    }
    setZoom(2);
    setPan({ x: 0, y: 0 });
  }, [screenshot]);

  useEffect(() => {
    resetView();
  }, [screenshot?.id, resetView]);

  useEffect(() => {
    if (!screenshot) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" && canPrev && onPrev) {
        event.preventDefault();
        onPrev();
      } else if (event.key === "ArrowRight" && canNext && onNext) {
        event.preventDefault();
        onNext();
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        applyZoomAtPoint(zoomRef.current + ZOOM_STEP);
      } else if (event.key === "-") {
        event.preventDefault();
        applyZoomAtPoint(zoomRef.current - ZOOM_STEP);
      } else if (event.key === "0") {
        event.preventDefault();
        resetView();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [screenshot, canPrev, canNext, onPrev, onNext, applyZoomAtPoint, resetView]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !screenshot) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0018);
      applyZoomAtPoint(zoomRef.current * factor, event.clientX, event.clientY);
    };

    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [screenshot, applyZoomAtPoint]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || zoomRef.current <= MIN_ZOOM) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: panRef.current.x,
      startPanY: panRef.current.y,
    };
    setIsDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    setPan(clampPan(drag.startPanX + dx, drag.startPanY + dy, zoomRef.current));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setIsDragging(false);
  };

  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest("button")) {
      return;
    }
    if (zoomRef.current > MIN_ZOOM) {
      resetView();
    } else {
      applyZoomAtPoint(2.5, event.clientX, event.clientY);
    }
  };

  if (!screenshot) return null;

  const fallbackExpiresAt =
    screenshot.expires_at ??
    new Date(
      Date.parse(screenshot.captured_at) + RETENTION_DAYS * 86_400_000
    ).toISOString();
  const expiry = getExpiryInfo(fallbackExpiresAt, companyTimezone);
  const localParts = safeFormatTimezoneParts(
    screenshot.captured_at,
    companyTimezone
  );

  return (
    <Modal
      open={Boolean(screenshot)}
      onClose={onClose}
      role="dialog"
      labelledBy="lightbox-title"
      maxWidthClass="max-w-6xl"
    >
      <div className="flex flex-col">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
            >
              <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              Close (Esc)
            </button>
            <h2
              id="lightbox-title"
              className="text-sm font-semibold text-slate-900 sm:text-[15px]"
            >
              {screenshot.employee_name}
              <span className="mx-2 text-slate-400">·</span>
              <span className="font-mono text-xs font-medium text-slate-600 tabular-nums sm:text-sm">
                {localParts.dateString} {localParts.timeString} {companyTimezone}
              </span>
            </h2>
          </div>

          <div className="flex items-center gap-2">
            {onPrev ? (
              <button
                type="button"
                disabled={!canPrev}
                onClick={onPrev}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
              >
                <ChevronLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                Prev
              </button>
            ) : null}
            {onNext ? (
              <button
                type="button"
                disabled={!canNext}
                onClick={onNext}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
              >
                Next
                <ChevronRight className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>

        {/* Body */}
        <div className="grid grid-cols-1 lg:grid-cols-12">
          {/* Image Canvas */}
          <div className="flex flex-col bg-slate-950/95 lg:col-span-9">
            <div
              ref={viewportRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onDoubleClick={handleDoubleClick}
              className={`relative flex h-[68vh] min-h-[300px] w-full items-center justify-center overflow-hidden p-4 select-none touch-none sm:p-6 ${
                zoom > MIN_ZOOM
                  ? isDragging
                    ? "cursor-grabbing"
                    : "cursor-grab"
                  : "cursor-zoom-in"
              }`}
              title={
                zoom > MIN_ZOOM
                  ? "Drag to move around · Scroll to zoom · Double-click to reset"
                  : "Scroll or double-click to zoom in"
              }
            >
              <div
                className="flex h-full w-full items-center justify-center will-change-transform"
                style={{
                  transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
                  transformOrigin: "center center",
                  transition: isDragging ? "none" : "transform 120ms ease-out",
                }}
              >
                <div className="w-full max-w-4xl overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
                  <SecureScreenshotImage
                    screenshotId={screenshot.id}
                    imageEndpoint={screenshot.image_endpoint}
                    presignedUrl={screenshot.presigned_url}
                    presignedUrlExpiresAt={screenshot.presigned_url_expires_at}
                    alt={`Screenshot of ${screenshot.employee_name} at ${localParts.dateString} ${localParts.timeString}`}
                    containerBgClassName="bg-slate-900"
                    aspectClassName="max-h-[62vh] min-h-[240px]"
                    imgClassName="mx-auto max-h-[62vh] w-auto max-w-full object-contain select-none"
                    imgDraggable={false}
                    loading="eager"
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 bg-slate-900 px-4 py-2.5">
              <p className="hidden text-xs text-slate-400 sm:block">
                Scroll or <kbd className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-200">+</kbd>/<kbd className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-200">-</kbd> to zoom · Drag mouse to pan
              </p>

              <div className="mx-auto flex flex-wrap items-center justify-center gap-1.5 sm:mx-0">
                <button
                  type="button"
                  disabled={zoom <= MIN_ZOOM}
                  onClick={() => applyZoomAtPoint(zoom - ZOOM_STEP)}
                  aria-label="Zoom out"
                  title="Zoom out (-)"
                  className="inline-flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  <ZoomOut className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  Out
                </button>

                <span
                  className="min-w-[54px] text-center font-mono text-xs font-semibold text-slate-100 tabular-nums"
                  aria-live="polite"
                >
                  {Math.round(zoom * 100)}%
                </span>

                <button
                  type="button"
                  disabled={zoom >= MAX_ZOOM}
                  onClick={() => applyZoomAtPoint(zoom + ZOOM_STEP)}
                  aria-label="Zoom in"
                  title="Zoom in (+)"
                  className="inline-flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  <ZoomIn className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  In
                </button>

                <button
                  type="button"
                  onClick={resetView}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                    zoom <= MIN_ZOOM
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                  }`}
                >
                  <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  Fit
                </button>

                <button
                  type="button"
                  onClick={zoomToActualPixels}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                    zoom > MIN_ZOOM
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                  }`}
                >
                  <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  1:1 Pixels
                </button>

                {zoom > MIN_ZOOM || pan.x !== 0 || pan.y !== 0 ? (
                  <button
                    type="button"
                    onClick={resetView}
                    aria-label="Reset zoom and pan"
                    title="Reset view (0)"
                    className="inline-flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                  >
                    <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                    Reset
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          {/* Metadata Sidebar */}
          <aside className="flex flex-col justify-between border-t border-slate-200 bg-white p-5 lg:col-span-3 lg:border-l lg:border-t-0">
            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Capture Metadata
              </h3>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-xs font-medium text-slate-500">Employee</dt>
                  <dd className="mt-0.5 font-semibold text-slate-900">
                    {screenshot.employee_name}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-slate-500">
                    Local Time ({companyTimezone})
                  </dt>
                  <dd className="mt-0.5 font-mono text-xs font-medium text-slate-800 tabular-nums">
                    {localParts.dateString} {localParts.timeString}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-slate-500">UTC Time</dt>
                  <dd className="mt-0.5 font-mono text-xs text-slate-600 tabular-nums">
                    {formatUtcDateTime(screenshot.captured_at)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-slate-500">Capture Type</dt>
                  <dd className="mt-1">
                    {screenshot.capture_type === "on_demand" ? (
                      <span className="inline-flex items-center rounded-md border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-800">
                        On-Demand
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-md border border-slate-200 bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-700">
                        Random
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-slate-500">
                    Dimensions & Size
                  </dt>
                  <dd className="mt-0.5 font-mono text-xs text-slate-800 tabular-nums">
                    {screenshot.width} × {screenshot.height} ·{" "}
                    {formatBytesKb(screenshot.file_size_bytes)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-slate-500">Displays</dt>
                  <dd className="mt-0.5 text-sm text-slate-800 tabular-nums">
                    {screenshot.monitor_count}{" "}
                    {screenshot.monitor_count === 1 ? "Monitor" : "Monitors"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-slate-500">Retention</dt>
                  <dd className="mt-1 space-y-1">
                    <span
                      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium tabular-nums ${
                        expiry.tone === "urgent"
                          ? "border-rose-200 bg-rose-50 text-rose-800"
                          : expiry.tone === "warning"
                            ? "border-orange-200 bg-orange-50 text-orange-800"
                            : "border-slate-200 bg-slate-100 text-slate-700"
                      }`}
                    >
                      {expiry.label}
                    </span>
                    <p className="text-xs text-slate-500 tabular-nums">
                      Purges {expiry.exactDate}
                    </p>
                  </dd>
                </div>
              </dl>
            </div>

            {onRequestDelete ? (
              <div className="mt-6 border-t border-slate-200 pt-4">
                <button
                  type="button"
                  onClick={() => onRequestDelete(screenshot)}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-rose-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2"
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  Delete Screenshot
                </button>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </Modal>
  );
}
