import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Banknote,
  Clock,
  Download,
  Images,
  LayoutDashboard,
  LogOut,
  Menu,
  RefreshCw,
  Settings,
  ShieldCheck,
  Users,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  DEFAULT_COMPANY_TIMEZONE,
  MAX_ACTIVE_ADMINS,
  MAX_ACTIVE_EMPLOYEES,
  RETENTION_DAYS,
} from "@sm-office/shared";
import { useAuth } from "../context/AuthContext";
import { useRealtime } from "../context/RealtimeContext";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  badgeCount?: number;
}

export function AppShell() {
  const { user, company, logout } = useAuth();
  const { wsStatus, reconnect, quotas } = useRealtime();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawerOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  const activeEmployees = quotas?.active_employees ?? 0;
  const maxEmployees = quotas?.max_active_employees ?? MAX_ACTIVE_EMPLOYEES;
  const activeAdmins = quotas?.active_admins ?? 0;
  const maxAdmins = quotas?.max_active_admins ?? MAX_ACTIVE_ADMINS;
  const timezone = company?.company_timezone ?? DEFAULT_COMPANY_TIMEZONE;
  const retentionDays = company?.retention_days ?? RETENTION_DAYS;
  const quotaPct = Math.min(100, Math.round((activeEmployees / maxEmployees) * 100));

  const quotaBarColor =
    activeEmployees >= maxEmployees
      ? "bg-rose-500"
      : activeEmployees >= maxEmployees - 1
        ? "bg-amber-500"
        : "bg-indigo-600";

  const navItems: NavItem[] = [
    { to: "/monitor", label: "Live Monitor", icon: LayoutDashboard },
    { to: "/screenshots", label: "Screenshots", icon: Images },
    {
      to: "/employees",
      label: "Employees",
      icon: Users,
      badgeCount: quotas ? activeEmployees : undefined,
    },
    { to: "/salary", label: "Salary Reports", icon: Banknote },
    { to: "/settings", label: "Settings", icon: Settings },
  ];

  const sidebarContent = (
    <div className="flex h-full flex-col justify-between bg-white">
      <div>
        <div className="flex h-16 items-center justify-between border-b border-slate-200 px-5">
          <Link
            to="/monitor"
            className="flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white">
              <ShieldCheck className="h-4.5 w-4.5" strokeWidth={1.75} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <span className="block truncate text-sm font-bold tracking-tight text-slate-900">
                {company?.company_name ?? "SM Office Desk"}
              </span>
              <span className="block text-[11px] font-medium text-slate-500">
                Admin Console
              </span>
            </div>
          </Link>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close navigation menu"
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 xl:hidden"
          >
            <X className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        <nav className="space-y-1 px-3 py-4" aria-label="Main navigation">
          <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Navigation
          </p>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 ${
                    isActive
                      ? "bg-indigo-50 text-indigo-800"
                      : "text-slate-700 hover:bg-slate-100 hover:text-slate-900"
                  }`
                }
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                  {item.label}
                </span>
                {item.badgeCount !== undefined ? (
                  <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-slate-700 tabular-nums">
                    {item.badgeCount}
                  </span>
                ) : null}
              </NavLink>
            );
          })}
        </nav>
      </div>

      {/* Quota Snapshot Widget */}
      <div className="border-t border-slate-200 p-4">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Quota Snapshot
          </p>
          <div className="mt-2.5 space-y-2">
            <div>
              <div className="flex items-center justify-between text-xs font-medium text-slate-700">
                <span>Employees</span>
                <span className="font-semibold text-slate-900 tabular-nums">
                  {quotas ? `${activeEmployees} / ${maxEmployees}` : `— / ${maxEmployees}`}
                </span>
              </div>
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className={`h-full rounded-full transition-all ${quotaBarColor}`}
                  style={{ width: `${quotaPct}%` }}
                />
              </div>
            </div>
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>Admins</span>
              <span className="font-semibold text-slate-800 tabular-nums">
                {quotas ? `${activeAdmins} / ${maxAdmins}` : `— / ${maxAdmins}`}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>Retention</span>
              <span className="font-semibold text-slate-800 tabular-nums">
                {retentionDays} days
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Desktop Persistent Sidebar (>=1280px) */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-[232px] border-r border-slate-200 bg-white xl:block print:hidden">
        {sidebarContent}
      </aside>

      {/* Mobile / Tablet Slide-over Drawer (<1280px) */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-40 xl:hidden print:hidden">
          <div
            className="fixed inset-0 bg-slate-950/60 backdrop-blur-[2px]"
            aria-hidden="true"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="fixed inset-y-0 left-0 z-50 w-[232px] border-r border-slate-200 bg-white shadow-xl">
            {sidebarContent}
          </aside>
        </div>
      ) : null}

      {/* Main Content Wrapper */}
      <div className="flex min-h-screen flex-col xl:pl-[232px] print:pl-0">
        {/* Top Bar (64px) */}
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur sm:px-6 print:hidden">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation menu"
              className="rounded-lg border border-slate-200 p-2 text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 xl:hidden"
            >
              <Menu className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
            </button>

            <div className="flex flex-wrap items-center gap-2">
              <Link
                to="/employees"
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 tabular-nums"
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    activeEmployees >= maxEmployees ? "bg-rose-500" : "bg-indigo-600"
                  }`}
                  aria-hidden="true"
                />
                {quotas
                  ? `${activeEmployees} / ${maxEmployees} Active`
                  : `— / ${maxEmployees} Active`}
              </Link>

              {/* WS Health Pill */}
              {wsStatus === "connected" ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">
                  <span
                    className="h-2 w-2 rounded-full bg-emerald-500 motion-safe:animate-pulse"
                    aria-hidden="true"
                  />
                  <Wifi className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  WS: Connected
                </span>
              ) : wsStatus === "reconnecting" ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">
                  <RefreshCw
                    className="h-3.5 w-3.5 motion-safe:animate-spin"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  WS: Reconnecting...
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-800">
                  <WifiOff className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  <span>WS: Disconnected</span>
                  <button
                    type="button"
                    onClick={reconnect}
                    className="ml-1 rounded px-1.5 py-0.5 text-[11px] font-semibold underline hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600"
                  >
                    Reconnect
                  </button>
                </span>
              )}

              <Link
                to="/settings"
                className="hidden items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 sm:inline-flex"
                title="Company Timezone setting"
              >
                <Clock className="h-3.5 w-3.5 text-slate-500" strokeWidth={1.75} aria-hidden="true" />
                TZ: {timezone}
              </Link>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <Link
              to="/download"
              className="hidden items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 sm:inline-flex"
              title="Open employee desktop software download page"
            >
              <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              <span>Desktop App</span>
            </Link>
            <span className="hidden text-sm font-medium text-slate-700 md:inline">
              {user?.name ?? "Admin"}{" "}
              <span className="text-xs font-normal text-slate-500">(Admin)</span>
            </span>
            <button
              type="button"
              onClick={() => void logout()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 sm:text-sm"
            >
              <LogOut className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              <span>Sign Out</span>
            </button>
          </div>
        </header>

        {/* Main Viewport */}
        <main className="mx-auto w-full max-w-[1440px] flex-1 p-4 sm:p-6 print:max-w-none print:p-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
