import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  Trash2,
  X,
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
  const [zoomMode, setZoomMode] = useState<"fit" | "actual">("fit");

  useEffect(() => {
    setZoomMode("fit");
  }, [screenshot?.id]);

  useEffect(() => {
    if (!screenshot) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" && canPrev && onPrev) {
        event.preventDefault();
        onPrev();
      } else if (event.key === "ArrowRight" && canNext && onNext) {
        event.preventDefault();
        onNext();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [screenshot, canPrev, canNext, onPrev, onNext]);

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
            <div className="flex flex-1 items-center justify-center overflow-auto p-4 sm:p-6">
              {zoomMode === "fit" ? (
                <div className="w-full max-w-4xl overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
                  <SecureScreenshotImage
                    screenshotId={screenshot.id}
                    imageEndpoint={screenshot.image_endpoint}
                    presignedUrl={screenshot.presigned_url}
                    presignedUrlExpiresAt={screenshot.presigned_url_expires_at}
                    alt={`Screenshot of ${screenshot.employee_name} at ${localParts.dateString} ${localParts.timeString}`}
                    aspectClassName="max-h-[68vh] min-h-[240px]"
                    imgClassName="mx-auto max-h-[68vh] w-auto max-w-full object-contain"
                    loading="eager"
                  />
                </div>
              ) : (
                <div className="max-h-[68vh] max-w-full overflow-auto rounded-lg border border-slate-800 bg-slate-900">
                  <SecureScreenshotImage
                    screenshotId={screenshot.id}
                    imageEndpoint={screenshot.image_endpoint}
                    presignedUrl={screenshot.presigned_url}
                    presignedUrlExpiresAt={screenshot.presigned_url_expires_at}
                    alt={`Screenshot of ${screenshot.employee_name} actual pixels`}
                    aspectClassName="min-h-[240px] min-w-[320px]"
                    imgClassName="max-w-none h-auto w-auto"
                    loading="eager"
                  />
                </div>
              )}
            </div>

            <div className="flex items-center justify-center gap-2 border-t border-slate-800 bg-slate-900 px-4 py-2.5">
              <button
                type="button"
                onClick={() => setZoomMode("fit")}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                  zoomMode === "fit"
                    ? "bg-indigo-600 text-white"
                    : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                }`}
              >
                <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Fit Width
              </button>
              <button
                type="button"
                onClick={() => setZoomMode("actual")}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                  zoomMode === "actual"
                    ? "bg-indigo-600 text-white"
                    : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                }`}
              >
                <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Actual Pixels (100%)
              </button>
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
