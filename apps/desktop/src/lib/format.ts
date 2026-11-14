import type { UiErrorPayload } from "../types";

export function formatHms(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
  ].join(":");
}

export function formatHm(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  return `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m`;
}

export function formatAccuracy(accuracyMeters: number | null): string {
  if (accuracyMeters === null || !Number.isFinite(accuracyMeters) || accuracyMeters <= 0) {
    return "";
  }
  if (accuracyMeters >= 1000) {
    const km = Math.round(accuracyMeters / 1000);
    return ` (±${km}km)`;
  }
  return ` (±${Math.round(accuracyMeters)}m)`;
}

export function formatLocalTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function normalizeClientServerUrl(
  raw: string
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "Server URL is required (e.g. https://desk.company.com)",
    };
  }

  const withScheme = trimmed.includes("://")
    ? trimmed
    : /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/i.test(trimmed)
      ? `http://${trimmed}`
      : `https://${trimmed}`;

  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        ok: false,
        error: "Server URL must use http:// or https://",
      };
    }
    if (!parsed.hostname) {
      return { ok: false, error: "Server URL must include a valid host" };
    }
    return { ok: true, url: parsed.toString().replace(/\/+$/, "") };
  } catch {
    return {
      ok: false,
      error: "Enter a valid Server URL (e.g. https://desk.company.com)",
    };
  }
}

export function isUiErrorPayload(err: unknown): err is UiErrorPayload {
  if (!err || typeof err !== "object") return false;
  const candidate = err as Partial<UiErrorPayload>;
  return (
    typeof candidate.code === "string" && typeof candidate.message === "string"
  );
}

export function normalizeUnknownError(err: unknown): UiErrorPayload {
  if (isUiErrorPayload(err)) {
    return {
      status: typeof err.status === "number" ? err.status : 0,
      code: err.code,
      message: err.message,
      conflict: err.conflict ?? null,
    };
  }
  if (err instanceof Error) {
    return {
      status: 0,
      code: "CLIENT_ERROR",
      message: err.message,
      conflict: null,
    };
  }
  if (typeof err === "string") {
    return {
      status: 0,
      code: "CLIENT_ERROR",
      message: err,
      conflict: null,
    };
  }
  return {
    status: 0,
    code: "UNKNOWN_ERROR",
    message: "An unexpected error occurred.",
    conflict: null,
  };
}

export function mapAuthErrorMessage(err: UiErrorPayload): string {
  if (err.status === 403 && err.code === "FORBIDDEN") {
    return "Admin accounts manage the team on the Web Dashboard.";
  }
  if (err.code === "ACCOUNT_DISABLED") {
    return "Account deactivated by admin. Contact your manager.";
  }
  if (err.code === "RATE_LIMITED" || err.status === 429) {
    return "Too many sign-in attempts. Please wait a moment and try again.";
  }
  if (err.code === "NETWORK_ERROR") {
    return "Unable to reach server. Check your Server URL and connection.";
  }
  if (err.status === 401 || err.code === "UNAUTHORIZED") {
    return "Invalid email or password";
  }
  return err.message || "Sign in failed";
}

export function formatShortDeviceId(deviceId: string): string {
  const clean = deviceId.trim();
  if (clean.length <= 8) return clean;
  return `dev_${clean.slice(0, 6)}`;
}
