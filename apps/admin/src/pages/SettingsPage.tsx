import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Check,
  Clock,
  Copy,
  Database,
  HardDrive,
  Loader2,
  Lock,
  Save,
  ShieldCheck,
} from "lucide-react";
import {
  DEFAULT_COMPANY_TIMEZONE,
  DEFAULT_CURRENCY_CODE,
  isValidIanaTimeZone,
  MAX_ACTIVE_ADMINS,
  MAX_ACTIVE_EMPLOYEES,
  RETENTION_DAYS,
} from "@sm-office/shared";
import { useAuth } from "../context/AuthContext";
import { useRealtime } from "../context/RealtimeContext";
import { useToast } from "../context/ToastContext";
import { adminApi, ApiClientError } from "../lib/api";
import {
  COMMON_CURRENCIES,
  COMMON_TIMEZONES,
  safeFormatTimezoneParts,
} from "../lib/format";
import type { AdminSettingsResponse } from "../types/api";

export function SettingsPage() {
  const { user, updateCompany } = useAuth();
  const { quotas, refreshQuotas } = useRealtime();
  const { pushToast } = useToast();

  const [data, setData] = useState<AdminSettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [companyName, setCompanyName] = useState("");
  const [tzMode, setTzMode] = useState<"preset" | "custom">("preset");
  const [companyTimezone, setCompanyTimezone] = useState<string>(
    DEFAULT_COMPANY_TIMEZONE
  );
  const [currencyMode, setCurrencyMode] = useState<"preset" | "custom">("preset");
  const [currencyCode, setCurrencyCode] = useState<string>(DEFAULT_CURRENCY_CODE);

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [copiedCli, setCopiedCli] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [res] = await Promise.all([adminApi.getSettings(), refreshQuotas()]);
      setData(res);
      setCompanyName(res.settings.company_name);

      const isCommonTz = COMMON_TIMEZONES.some(
        (t) => t.value === res.settings.company_timezone
      );
      setTzMode(isCommonTz ? "preset" : "custom");
      setCompanyTimezone(res.settings.company_timezone);

      const isCommonCur = COMMON_CURRENCIES.some(
        (c) => c.code === res.settings.currency_code
      );
      setCurrencyMode(isCommonCur ? "preset" : "custom");
      setCurrencyCode(res.settings.currency_code);
    } catch (err) {
      setLoadError(
        err instanceof ApiClientError ? err.message : "Failed to load settings"
      );
    } finally {
      setLoading(false);
    }
  }, [refreshQuotas]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const tzValid = isValidIanaTimeZone(companyTimezone);
  const liveClockPreview = useMemo(() => {
    const tz = tzValid ? companyTimezone : "UTC";
    const parts = safeFormatTimezoneParts(nowMs, tz);
    return `${parts.dateString} ${parts.timeString}`;
  }, [companyTimezone, nowMs, tzValid]);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setFormError(null);

    const trimmedName = companyName.trim();
    const trimmedTz = companyTimezone.trim();
    const upperCurrency = currencyCode.trim().toUpperCase();

    if (trimmedName.length < 2 || trimmedName.length > 100) {
      setFormError("Company name must be between 2 and 100 characters.");
      return;
    }
    if (!isValidIanaTimeZone(trimmedTz)) {
      setFormError("Enter a valid IANA timezone identifier (e.g. Asia/Dhaka).");
      return;
    }
    if (!/^[A-Z]{3}$/.test(upperCurrency)) {
      setFormError("Currency code must be a 3-letter ISO-4217 code (e.g. BDT, USD).");
      return;
    }

    setSaving(true);
    try {
      const res = await adminApi.updateSettings({
        company_name: trimmedName,
        company_timezone: trimmedTz,
        currency_code: upperCurrency,
      });
      setData((prev) => (prev ? { ...prev, settings: res.settings } : prev));
      updateCompany({
        company_name: res.settings.company_name,
        company_timezone: res.settings.company_timezone,
        currency_code: res.settings.currency_code,
        retention_days: res.settings.retention_days,
      });
      pushToast({
        variant: "success",
        title: "Settings saved",
        message: `Timezone: ${res.settings.company_timezone} · Currency: ${res.settings.currency_code}`,
      });
    } catch (err) {
      setFormError(
        err instanceof ApiClientError ? err.message : "Could not save settings"
      );
    } finally {
      setSaving(false);
    }
  };

  const resetCliCommand = `npm run reset:password -- --email=${user?.email ?? "admin@company.com"}`;

  const handleCopyCli = async () => {
    try {
      await navigator.clipboard.writeText(resetCliCommand);
      setCopiedCli(true);
      window.setTimeout(() => setCopiedCli(false), 2000);
    } catch {
      pushToast({
        variant: "warning",
        title: "Clipboard unavailable",
      });
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Settings
        </h1>
        <div className="h-64 animate-pulse rounded-xl border border-slate-200 bg-white p-6" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Settings
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Configure company identity, timezone partitioning, currency, and inspect retention policies.
        </p>
      </div>

      {loadError ? (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
        >
          {loadError}
        </div>
      ) : null}

      {/* Organization & Locale Form */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">
          Organization & Locale
        </h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Company Timezone controls screenshot date folder partitioning and monthly salary boundaries.
        </p>

        {formError ? (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-medium text-rose-800"
          >
            {formError}
          </div>
        ) : null}

        <form onSubmit={(e) => void handleSave(e)} className="mt-5 space-y-4">
          <div>
            <label
              htmlFor="settings-company-name"
              className="block text-sm font-medium text-slate-700"
            >
              Company Name
            </label>
            <input
              id="settings-company-name"
              type="text"
              required
              minLength={2}
              maxLength={100}
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="mt-1.5 block w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
            />
          </div>

          <div>
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="settings-timezone"
                className="block text-sm font-medium text-slate-700"
              >
                Company Timezone (Default: Asia/Dhaka)
              </label>
              <button
                type="button"
                onClick={() =>
                  setTzMode((prev) => (prev === "preset" ? "custom" : "preset"))
                }
                className="text-xs font-medium text-indigo-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
              >
                {tzMode === "preset" ? "Enter custom IANA TZ" : "Choose from list"}
              </button>
            </div>

            {tzMode === "preset" ? (
              <select
                id="settings-timezone"
                value={
                  COMMON_TIMEZONES.some((t) => t.value === companyTimezone)
                    ? companyTimezone
                    : ""
                }
                onChange={(e) => {
                  if (e.target.value) setCompanyTimezone(e.target.value);
                }}
                className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
              >
                {COMMON_TIMEZONES.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="settings-timezone"
                type="text"
                value={companyTimezone}
                onChange={(e) => setCompanyTimezone(e.target.value)}
                placeholder="e.g. Asia/Dhaka"
                aria-invalid={!tzValid ? "true" : "false"}
                className={`mt-1.5 block w-full rounded-lg border px-3.5 py-2 font-mono text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 ${
                  !tzValid ? "border-rose-400 bg-rose-50/40" : "border-slate-300"
                }`}
              />
            )}

            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <Clock className="h-3.5 w-3.5 text-slate-400" strokeWidth={1.75} aria-hidden="true" />
              <span>Live preview:</span>
              <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono font-semibold text-slate-800 tabular-nums">
                {tzValid ? `${liveClockPreview} (${companyTimezone})` : "Invalid IANA timezone"}
              </span>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="settings-currency"
                className="block text-sm font-medium text-slate-700"
              >
                Currency Code
              </label>
              <button
                type="button"
                onClick={() =>
                  setCurrencyMode((prev) => (prev === "preset" ? "custom" : "preset"))
                }
                className="text-xs font-medium text-indigo-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
              >
                {currencyMode === "preset" ? "Enter custom ISO code" : "Choose from list"}
              </button>
            </div>

            {currencyMode === "preset" ? (
              <select
                id="settings-currency"
                value={
                  COMMON_CURRENCIES.some((c) => c.code === currencyCode)
                    ? currencyCode
                    : ""
                }
                onChange={(e) => {
                  if (e.target.value) setCurrencyCode(e.target.value);
                }}
                className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
              >
                {COMMON_CURRENCIES.map((cur) => (
                  <option key={cur.code} value={cur.code}>
                    {cur.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="settings-currency"
                type="text"
                maxLength={3}
                value={currencyCode}
                onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())}
                placeholder="BDT"
                className="mt-1.5 block w-full rounded-lg border border-slate-300 px-3.5 py-2 font-mono text-sm uppercase text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
              />
            )}
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={saving || !tzValid}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Save className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              )}
              Save Changes
            </button>
          </div>
        </form>
      </section>

      {/* Retention & Infrastructure Policy (Read-Only) */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs sm:p-6">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900">
            Retention & Infrastructure Policy
          </h2>
          <span className="rounded-md border border-slate-200 bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
            Read-Only
          </span>
        </div>

        <dl className="mt-4 divide-y divide-slate-200 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 py-3">
            <dt className="font-medium text-slate-600">Data Retention Limit</dt>
            <dd>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-800">
                <Lock className="h-3.5 w-3.5 text-slate-600" strokeWidth={1.75} aria-hidden="true" />
                {data?.settings.retention_days ?? RETENTION_DAYS} Days Fixed Policy
              </span>
            </dd>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 py-3">
            <dt className="font-medium text-slate-600">Automatic Purge Cron</dt>
            <dd className="text-xs font-medium text-slate-800 sm:text-sm">
              Daily at 02:00 UTC (Screenshots &amp; Location Logs &gt; 90 days deleted)
            </dd>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 py-3">
            <dt className="font-medium text-slate-600">Storage Backend</dt>
            <dd>
              {data?.runtime.storage_driver === "r2" ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
                  <HardDrive className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  Cloudflare R2 (Private Bucket)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-800">
                  <HardDrive className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  Local Disk Fallback
                </span>
              )}
            </dd>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 py-3">
            <dt className="font-medium text-slate-600">Database Engine</dt>
            <dd className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-800 tabular-nums sm:text-sm">
              <Database className="h-4 w-4 text-slate-500" strokeWidth={1.75} aria-hidden="true" />
              SQLite WAL Mode ·{" "}
              {quotas ? `${quotas.active_employees}/${quotas.max_active_employees}` : `—/${MAX_ACTIVE_EMPLOYEES}`}{" "}
              Emp ·{" "}
              {quotas ? `${quotas.active_admins}/${quotas.max_active_admins}` : `—/${MAX_ACTIVE_ADMINS}`}{" "}
              Adm
            </dd>
          </div>
        </dl>
      </section>

      {/* Admin Security & Recovery */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs sm:p-6">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-indigo-700" strokeWidth={1.75} aria-hidden="true" />
          <h2 className="text-base font-semibold text-slate-900">
            Admin Security & Recovery
          </h2>
        </div>

        <p className="mt-2 text-sm text-slate-600">
          Signed in as{" "}
          <span className="font-semibold text-slate-900">{user?.email}</span>{" "}
          (Role: Admin)
        </p>

        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3.5">
          <p className="text-xs font-medium text-slate-700">
            Server CLI administrator password reset (revokes active tokens immediately):
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2">
            <code className="overflow-x-auto font-mono text-xs text-slate-900">
              {resetCliCommand}
            </code>
            <button
              type="button"
              onClick={() => void handleCopyCli()}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-300 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
            >
              {copiedCli ? (
                <Check className="h-3.5 w-3.5 text-emerald-700" strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              )}
              {copiedCli ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
