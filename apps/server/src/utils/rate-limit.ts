import { AppError } from "./errors.js";

interface AttemptBucket {
  failedCount: number;
  windowStartMs: number;
  blockedUntilMs: number;
}

export interface LoginRateLimiterOptions {
  maxFailedAttempts?: number;
  windowMs?: number;
  blockMs?: number;
}

/**
 * In-memory brute-force rate limiter keyed by client IP and normalized email.
 */
export class LoginRateLimiter {
  private readonly buckets = new Map<string, AttemptBucket>();
  private readonly maxFailedAttempts: number;
  private readonly windowMs: number;
  private readonly blockMs: number;

  constructor(options: LoginRateLimiterOptions = {}) {
    this.maxFailedAttempts = options.maxFailedAttempts ?? 5;
    this.windowMs = options.windowMs ?? 60_000;
    this.blockMs = options.blockMs ?? 60_000;
  }

  private keyFor(ip: string, email: string): string {
    return `${ip}::${email.trim().toLowerCase()}`;
  }

  assertAllowed(ip: string, email: string, nowMs: number = Date.now()): void {
    const key = this.keyFor(ip, email);
    const bucket = this.buckets.get(key);
    if (!bucket) return;

    if (bucket.blockedUntilMs > nowMs) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.blockedUntilMs - nowMs) / 1000)
      );
      throw new AppError(
        429,
        "UNAUTHORIZED",
        `Too many failed login attempts. Retry allowed in ${retryAfterSeconds}s.`,
        { retry_after_seconds: retryAfterSeconds },
        { "Retry-After": String(retryAfterSeconds) }
      );
    }

    if (nowMs - bucket.windowStartMs > this.windowMs) {
      this.buckets.delete(key);
    }
  }

  recordFailure(ip: string, email: string, nowMs: number = Date.now()): void {
    const key = this.keyFor(ip, email);
    const existing = this.buckets.get(key);

    if (!existing || nowMs - existing.windowStartMs > this.windowMs) {
      const failedCount = 1;
      const blockedUntilMs =
        failedCount >= this.maxFailedAttempts ? nowMs + this.blockMs : 0;
      this.buckets.set(key, {
        failedCount,
        windowStartMs: nowMs,
        blockedUntilMs,
      });
      return;
    }

    existing.failedCount += 1;
    if (existing.failedCount >= this.maxFailedAttempts) {
      existing.blockedUntilMs = nowMs + this.blockMs;
    }

    // Opportunistic sweep to keep map small on single-VPS RAM budget
    if (this.buckets.size > 1000) {
      for (const [k, b] of this.buckets.entries()) {
        if (b.blockedUntilMs <= nowMs && nowMs - b.windowStartMs > this.windowMs) {
          this.buckets.delete(k);
        }
      }
    }
  }

  clear(ip: string, email: string): void {
    this.buckets.delete(this.keyFor(ip, email));
  }
}
