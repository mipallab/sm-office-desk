import { z, type ZodTypeAny } from "zod";
import { AppError } from "./errors.js";

export function parseWithSchema<S extends ZodTypeAny>(
  schema: S,
  input: unknown
): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw result.error;
  }
  return result.data as z.output<S>;
}

export function parsePositiveIntId(raw: string, label: string = "id"): number {
  const parsed = z.coerce.number().int().positive().safeParse(raw);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", `Invalid ${label}`, {
      fieldErrors: { [label]: ["Expected a positive integer"] },
    });
  }
  return parsed.data;
}

/**
 * Validates WebP container magic header: `RIFF` at bytes 0..3 and `WEBP` at bytes 8..11.
 */
export function isValidWebpBuffer(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  return (
    buf[0] === 0x52 && // R
    buf[1] === 0x49 && // I
    buf[2] === 0x46 && // F
    buf[3] === 0x46 && // F
    buf[8] === 0x57 && // W
    buf[9] === 0x45 && // E
    buf[10] === 0x42 && // B
    buf[11] === 0x50 // P
  );
}

/**
 * Escapes an RFC 4180 CSV cell and guards against spreadsheet formula injection (`=`, `+`, `-`, `@`).
 */
export function formatCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let str = String(value);

  if (typeof value === "string" && /^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }

  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
