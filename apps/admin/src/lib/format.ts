import {
  DEFAULT_COMPANY_TIMEZONE,
  DEFAULT_CURRENCY_CODE,
  formatDatePartsInTimezone,
  type DeviceArch,
  type DeviceOs,
} from "@sm-office/shared";

const CURRENCY_SYMBOLS: Record<string, string> = {
  BDT: "৳",
  USD: "$",
  EUR: "€",
  GBP: "£",
  INR: "₹",
  AUD: "A$",
  CAD: "C$",
  SGD: "S$",
  AED: "AED",
  JPY: "¥",
};

export const COMMON_TIMEZONES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "Asia/Dhaka", label: "Asia/Dhaka (UTC+06:00)" },
  { value: "UTC", label: "UTC (UTC+00:00)" },
  { value: "Asia/Kolkata", label: "Asia/Kolkata (UTC+05:30)" },
  { value: "Asia/Dubai", label: "Asia/Dubai (UTC+04:00)" },
  { value: "Asia/Singapore", label: "Asia/Singapore (UTC+08:00)" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo (UTC+09:00)" },
  { value: "Europe/London", label: "Europe/London (GMT/BST)" },
  { value: "Europe/Berlin", label: "Europe/Berlin (CET/CEST)" },
  { value: "America/New_York", label: "America/New_York (EST/EDT)" },
  { value: "America/Chicago", label: "America/Chicago (CST/CDT)" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles (PST/PDT)" },
  { value: "Australia/Sydney", label: "Australia/Sydney (AEST/AEDT)" },
];

export const COMMON_CURRENCIES: ReadonlyArray<{ code: string; label: string }> = [
  { code: "BDT", label: "BDT — Bangladeshi Taka (৳)" },
  { code: "USD", label: "USD — US Dollar ($)" },
  { code: "EUR", label: "EUR — Euro (€)" },
  { code: "GBP", label: "GBP — British Pound (£)" },
  { code: "INR", label: "INR — Indian Rupee (₹)" },
  { code: "AED", label: "AED — UAE Dirham" },
  { code: "SGD", label: "SGD — Singapore Dollar (S$)" },
  { code: "AUD", label: "AUD — Australian Dollar (A$)" },
  { code: "CAD", label: "CAD — Canadian Dollar (C$)" },
];

export function getCurrencySymbol(currencyCode: string = DEFAULT_CURRENCY_CODE): string {
  const upper = currencyCode.toUpperCase();
  return CURRENCY_SYMBOLS[upper] ?? upper;
}

export function formatCurrency(
  amount: number,
  currencyCode: string = DEFAULT_CURRENCY_CODE,
  decimals: number = 2
): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  const formatted = safe.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const symbol = getCurrencySymbol(currencyCode);
  return symbol === currencyCode.toUpperCase()
    ? `${symbol} ${formatted}`
    : `${symbol} ${formatted}`;
}

export function formatDurationHms(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return [hours, minutes, seconds]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

export function formatDurationHm(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  return `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m`;
}

export function formatBytesKb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

export function getInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}

export function formatDeviceLabel(
  os: DeviceOs | null | undefined,
  arch: DeviceArch | null | undefined
): string {
  if (!os) return "Desktop";
  const osLabel =
    os === "windows" ? "Windows" : os === "macos" ? "macOS" : "Linux";
  if (!arch) return osLabel;
  const archLabel = arch === "x86_64" ? "x64" : "ARM64";
  return `${osLabel} · ${archLabel}`;
}

export function formatTime12h(
  hour24: number | string,
  minute: number | string = "00",
  second?: number | string
): string {
  const h = Number(hour24);
  if (!Number.isFinite(h) || h < 0 || h > 23) {
    return `${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const hh = String(h12).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  if (second !== undefined) {
    const ss = String(second).padStart(2, "0");
    return `${hh}:${mm}:${ss} ${period}`;
  }
  return `${hh}:${mm} ${period}`;
}

export function formatTimeString12h(time24: string | null | undefined): string {
  if (!time24) return "";
  const trimmed = time24.trim();
  if (/\b(AM|PM)\b/i.test(trimmed)) return trimmed;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(trimmed);
  if (!match) return time24;
  return formatTime12h(Number(match[1]), match[2]!, match[3]);
}

export function formatHourRange12h(hour24: string): string {
  const h = Number(hour24);
  if (!Number.isFinite(h) || h < 0 || h > 23) {
    return `${hour24}:00 – ${hour24}:59`;
  }
  return `${formatTime12h(h, "00")} – ${formatTime12h(h, "59")}`;
}

export function safeFormatTimezoneParts(
  date: Date | number | string,
  timeZone: string = DEFAULT_COMPANY_TIMEZONE
) {
  let parts;
  try {
    parts = formatDatePartsInTimezone(date, timeZone);
  } catch {
    parts = formatDatePartsInTimezone(date, "UTC");
  }
  return {
    ...parts,
    timeString24: parts.timeString,
    timeString: formatTime12h(parts.hour, parts.minute, parts.second),
  };
}

export function formatLocalDateTime(
  isoUtc: string,
  timeZone: string = DEFAULT_COMPANY_TIMEZONE
): string {
  const parts = safeFormatTimezoneParts(isoUtc, timeZone);
  return `${parts.dateString} ${parts.timeString}`;
}

export function formatUtcDateTime(isoUtc: string): string {
  const parts = safeFormatTimezoneParts(isoUtc, "UTC");
  return `${parts.dateString} ${parts.timeString} UTC`;
}

export function formatAccuracyDistance(meters: number | null | undefined): string {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) {
    return "±—";
  }
  if (meters >= 1000) {
    return `±${(meters / 1000).toFixed(1)}km`;
  }
  return `±${Math.round(meters)}m`;
}

export function getExpiryInfo(
  expiresAtIso: string,
  timeZone: string = DEFAULT_COMPANY_TIMEZONE
): {
  label: string;
  tone: "normal" | "warning" | "urgent";
  exactDate: string;
} {
  const expMs = Date.parse(expiresAtIso);
  const diffMs = expMs - Date.now();
  const exactDate = Number.isNaN(expMs)
    ? expiresAtIso
    : safeFormatTimezoneParts(expMs, timeZone).dateString;

  if (Number.isNaN(diffMs) || diffMs <= 86_400_000) {
    return {
      label: diffMs <= 0 ? "Expiring now" : "Expires in <24h",
      tone: "urgent",
      exactDate,
    };
  }

  const days = Math.ceil(diffMs / 86_400_000);
  if (days <= 7) {
    return {
      label: `Expires in ${days}d`,
      tone: "warning",
      exactDate,
    };
  }

  return {
    label: `Expires in ${days}d`,
    tone: "normal",
    exactDate,
  };
}

export function getCurrentMonthInTimezone(
  timeZone: string = DEFAULT_COMPANY_TIMEZONE
): string {
  const parts = safeFormatTimezoneParts(Date.now(), timeZone);
  return `${parts.year}-${parts.month}`;
}

export function shiftYearMonth(monthStr: string, deltaMonths: number): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(monthStr);
  if (!match) return monthStr;
  const year = Number(match[1]);
  const monthIdx = Number(match[2]) - 1;
  const d = new Date(Date.UTC(year, monthIdx + deltaMonths, 1));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function formatMonthHeading(monthStr: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(monthStr);
  if (!match) return monthStr;
  const year = Number(match[1]);
  const monthIdx = Number(match[2]) - 1;
  const d = new Date(Date.UTC(year, monthIdx, 15));
  return d.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function generateStrongPassword(length: number = 14): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%&*-_";
  const all = upper + lower + digits + symbols;
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);

  const chars: string[] = [
    upper[(bytes[0] ?? 0) % upper.length] ?? "A",
    lower[(bytes[1] ?? 0) % lower.length] ?? "a",
    digits[(bytes[2] ?? 0) % digits.length] ?? "2",
    symbols[(bytes[3] ?? 0) % symbols.length] ?? "!",
  ];
  for (let i = 4; i < length; i++) {
    chars.push(all[(bytes[i] ?? 0) % all.length] ?? "x");
  }
  // Shuffle deterministically with additional random bytes
  const shuffleBytes = new Uint8Array(length);
  window.crypto.getRandomValues(shuffleBytes);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = (shuffleBytes[i] ?? 0) % (i + 1);
    const tmp = chars[i]!;
    chars[i] = chars[j]!;
    chars[j] = tmp;
  }
  return chars.join("");
}
