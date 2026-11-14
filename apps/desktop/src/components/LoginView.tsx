import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Clock3,
  Eye,
  EyeOff,
  Loader2,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  mapAuthErrorMessage,
  normalizeClientServerUrl,
  normalizeUnknownError,
} from "../lib/format";
import type { BootstrapInfo } from "../types";

export interface LoginViewProps {
  bootstrap: BootstrapInfo;
  initialServerUrl: string;
  onLogin: (
    serverUrl: string,
    email: string,
    password: string
  ) => Promise<void>;
}

export function LoginView({
  bootstrap,
  initialServerUrl,
  onLogin,
}: LoginViewProps) {
  const preconfiguredUrl =
    initialServerUrl ||
    bootstrap.saved_server_url ||
    bootstrap.default_server_url ||
    "";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [serverUrl, setServerUrl] = useState(preconfiguredUrl);
  const [showServerUrl, setShowServerUrl] = useState(!preconfiguredUrl);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMessage(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setErrorMessage("Work email is required.");
      return;
    }
    if (!password) {
      setErrorMessage("Password is required.");
      return;
    }

    const normalized = normalizeClientServerUrl(serverUrl);
    if (!normalized.ok) {
      setShowServerUrl(true);
      setErrorMessage(normalized.error);
      return;
    }

    setSubmitting(true);
    try {
      await onLogin(normalized.url, trimmedEmail, password);
    } catch (err) {
      const uiErr = normalizeUnknownError(err);
      if (uiErr.code === "NETWORK_ERROR") {
        setShowServerUrl(true);
      }
      setErrorMessage(mapAuthErrorMessage(uiErr));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full w-full flex-col justify-between bg-slate-50 px-5 py-4 text-slate-900">
      <div className="flex flex-1 flex-col justify-center">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm">
            <Clock3 className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-base font-bold leading-tight text-slate-900">
              SM Office Desk
            </h1>
            <p className="text-xs text-slate-500">Employee Work Tracker</p>
          </div>
        </div>

        {errorMessage ? (
          <div
            role="alert"
            aria-live="assertive"
            className="mb-3 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600" />
            <span>{errorMessage}</span>
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-3" noValidate>
          <div>
            <label
              htmlFor="desktop-email"
              className="mb-1 block text-xs font-medium text-slate-700"
            >
              Work Email
            </label>
            <input
              id="desktop-email"
              type="email"
              autoComplete="email"
              placeholder="nadia@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              className="h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:border-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600/20 disabled:bg-slate-100"
            />
          </div>

          <div>
            <label
              htmlFor="desktop-password"
              className="mb-1 block text-xs font-medium text-slate-700"
            >
              Password
            </label>
            <div className="relative">
              <input
                id="desktop-password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-3 pr-9 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:border-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600/20 disabled:bg-slate-100"
              />
              <button
                type="button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((prev) => !prev)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          <div className="pt-0.5">
            <button
              type="button"
              aria-expanded={showServerUrl}
              onClick={() => setShowServerUrl((prev) => !prev)}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
            >
              {showServerUrl ? (
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>Server URL (Advanced)</span>
            </button>

            {showServerUrl ? (
              <div className="mt-1.5">
                <label htmlFor="desktop-server-url" className="sr-only">
                  Server URL
                </label>
                <input
                  id="desktop-server-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://desk.company.com"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  disabled={submitting}
                  className="h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus-visible:border-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600/20 disabled:bg-slate-100"
                />
              </div>
            ) : null}
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="mt-1 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-65"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Signing In...</span>
              </>
            ) : (
              <span>Sign In</span>
            )}
          </button>
        </form>
      </div>

      <footer className="border-t border-slate-200 pt-2.5 text-center font-mono text-[11px] text-slate-500">
        v{bootstrap.app_version} · {bootstrap.device_os}-{bootstrap.device_arch} ·
        Device: {bootstrap.short_device_id}
      </footer>
    </div>
  );
}
