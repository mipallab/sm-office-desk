import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  Eye,
  EyeOff,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { ApiClientError } from "../lib/api";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginPage() {
  const { isAuthenticated, isBooting, login } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState<number>(0);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setCooldownSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownSeconds]);

  if (!isBooting && isAuthenticated) {
    return <Navigate to="/monitor" replace />;
  }

  const validateFields = (): boolean => {
    let valid = true;
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !EMAIL_REGEX.test(trimmedEmail)) {
      setEmailError("Enter a valid administrator email address.");
      valid = false;
    } else {
      setEmailError(null);
    }

    if (password.length < 8) {
      setPasswordError("Password must be at least 8 characters.");
      valid = false;
    } else {
      setPasswordError(null);
    }

    return valid;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (cooldownSeconds > 0 || submitting) return;

    setBannerError(null);
    if (!validateFields()) return;

    setSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 429) {
          const seconds = err.retryAfterSeconds ?? 60;
          setCooldownSeconds(seconds);
          setBannerError(null);
        } else if (err.status === 401 && err.code === "INVALID_CREDENTIALS") {
          setBannerError("Invalid email or password.");
        } else if (err.status === 403 && err.code === "FORBIDDEN") {
          setBannerError(
            "This portal is restricted to Admin accounts. Employees must use the SM Office Desk desktop app."
          );
        } else if (err.status === 403 && err.code === "ACCOUNT_DISABLED") {
          setBannerError(
            "Your administrator account has been deactivated. Contact another active admin or server operator."
          );
        } else {
          setBannerError(err.message);
        }
      } else {
        setBannerError("Sign in failed. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-10">
      <div className="mb-4 w-full max-w-md">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 transition-colors hover:text-indigo-600"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          Back to Home &amp; Desktop Downloads
        </Link>
      </div>
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xs sm:p-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-white">
            <ShieldCheck className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">
              SM Office Desk
            </h1>
            <p className="text-xs font-medium text-slate-600">
              Admin Web Console
            </p>
          </div>
        </div>

        <hr className="my-5 border-slate-200" />

        {/* Alert / Rate-Limit Banner */}
        {cooldownSeconds > 0 ? (
          <div
            role="alert"
            aria-live="assertive"
            className="mb-4 flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-sm text-rose-800"
          >
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-rose-700"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <p className="tabular-nums">
              Too many sign-in attempts. Retry allowed in{" "}
              <span className="font-semibold">{cooldownSeconds}s</span>.
            </p>
          </div>
        ) : bannerError ? (
          <div
            role="alert"
            aria-live="assertive"
            className="mb-4 flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-sm text-rose-800"
          >
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-rose-700"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <p>{bannerError}</p>
          </div>
        ) : null}

        <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-4">
          <div>
            <label
              htmlFor="login-email"
              className="block text-sm font-medium text-slate-700"
            >
              Work Email
            </label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (emailError) setEmailError(null);
              }}
              aria-invalid={emailError ? "true" : "false"}
              aria-describedby={emailError ? "login-email-error" : undefined}
              placeholder="admin@company.com"
              className={`mt-1.5 block w-full rounded-lg border px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 ${
                emailError ? "border-rose-400 bg-rose-50/40" : "border-slate-300 bg-white"
              }`}
            />
            {emailError ? (
              <p id="login-email-error" className="mt-1 text-xs text-rose-700">
                {emailError}
              </p>
            ) : null}
          </div>

          <div>
            <label
              htmlFor="login-password"
              className="block text-sm font-medium text-slate-700"
            >
              Password
            </label>
            <div className="relative mt-1.5">
              <input
                id="login-password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (passwordError) setPasswordError(null);
                }}
                aria-invalid={passwordError ? "true" : "false"}
                aria-describedby={passwordError ? "login-password-error" : undefined}
                placeholder="••••••••••••"
                className={`block w-full rounded-lg border py-2.5 pl-3.5 pr-10 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 ${
                  passwordError
                    ? "border-rose-400 bg-rose-50/40"
                    : "border-slate-300 bg-white"
                }`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                )}
              </button>
            </div>
            {passwordError ? (
              <p id="login-password-error" className="mt-1 text-xs text-rose-700">
                {passwordError}
              </p>
            ) : null}
          </div>

          <button
            type="submit"
            disabled={submitting || cooldownSeconds > 0}
            aria-busy={submitting}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
                Signing in...
              </>
            ) : cooldownSeconds > 0 ? (
              <span className="tabular-nums">Retry in {cooldownSeconds}s</span>
            ) : (
              "Sign In to Console"
            )}
          </button>
        </form>

        <div className="mt-6 border-t border-slate-200 pt-4 text-xs text-slate-600">
          <p>Admin accounts only (Max 2 active admins).</p>
          <p className="mt-1">
            Need a password reset? Use CLI:{" "}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-800">
              npm run reset:password
            </code>
          </p>
        </div>

        <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50/70 p-3.5 text-xs text-slate-700">
          <p className="font-semibold text-slate-900">Are you an employee?</p>
          <Link
            to="/download"
            className="mt-1 inline-flex items-center gap-1.5 font-medium text-indigo-700 hover:text-indigo-800 hover:underline"
          >
            <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Download the Desktop Tracker App (Windows &amp; Linux) &rarr;
          </Link>
        </div>
      </div>
    </div>
  );
}
