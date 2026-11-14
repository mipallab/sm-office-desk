import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Lock,
  Pencil,
  Search,
  Shield,
  UserCheck,
  UserPlus,
  UserX,
} from "lucide-react";
import {
  DEFAULT_CURRENCY_CODE,
  MAX_ACTIVE_ADMINS,
  MAX_ACTIVE_EMPLOYEES,
  type QuotaSummary,
  type SalaryType,
  type UserRole,
} from "@sm-office/shared";
import { Modal } from "../components/Modal";
import { useAuth } from "../context/AuthContext";
import { useRealtime } from "../context/RealtimeContext";
import { useToast } from "../context/ToastContext";
import { adminApi, ApiClientError } from "../lib/api";
import {
  formatCurrency,
  generateStrongPassword,
  getInitials,
} from "../lib/format";
import type { AdminEmployeeItem } from "../types/api";

type EmployeeTab = "active" | "inactive" | "all";

interface UserModalState {
  mode: "create" | "edit";
  role: UserRole;
  target: AdminEmployeeItem | null;
}

export function EmployeesPage() {
  const { user: currentAdmin, company } = useAuth();
  const { setQuotas: setGlobalQuotas } = useRealtime();
  const { pushToast } = useToast();

  const currencyCode = company?.currency_code ?? DEFAULT_CURRENCY_CODE;

  const [allUsers, setAllUsers] = useState<AdminEmployeeItem[]>([]);
  const [quotas, setQuotas] = useState<QuotaSummary>({
    active_employees: 0,
    max_active_employees: MAX_ACTIVE_EMPLOYEES,
    active_admins: 0,
    max_active_admins: MAX_ACTIVE_ADMINS,
  });
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [tab, setTab] = useState<EmployeeTab>("active");
  const [search, setSearch] = useState<string>("");

  // Modal states
  const [userModal, setUserModal] = useState<UserModalState | null>(null);
  const [formName, setFormName] = useState("");
  const [formEmail, setFormEmail] = useState("");
  const [formPassword, setFormPassword] = useState("");
  const [changePassword, setChangePassword] = useState(false);
  const [formDesignation, setFormDesignation] = useState("");
  const [formSalaryType, setFormSalaryType] = useState<SalaryType>("monthly");
  const [formBaseSalary, setFormBaseSalary] = useState("0");
  const [formError, setFormError] = useState<string | null>(null);
  const [emailConflictError, setEmailConflictError] = useState<string | null>(null);
  const [copiedPassword, setCopiedPassword] = useState(false);
  const [savingUser, setSavingUser] = useState(false);

  const [deactivateTarget, setDeactivateTarget] =
    useState<AdminEmployeeItem | null>(null);
  const [mutatingActiveId, setMutatingActiveId] = useState<number | null>(null);
  const deactivateCancelRef = useRef<HTMLButtonElement | null>(null);

  const loadRoster = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await adminApi.listEmployees({ role: "all", status: "all" });
      setAllUsers(res.users);
      setQuotas(res.quotas);
      setGlobalQuotas(res.quotas);
    } catch (err) {
      setLoadError(
        err instanceof ApiClientError ? err.message : "Failed to load team roster"
      );
    } finally {
      setLoading(false);
    }
  }, [setGlobalQuotas]);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  const employees = useMemo(
    () => allUsers.filter((u) => u.role === "employee"),
    [allUsers]
  );
  const admins = useMemo(
    () => allUsers.filter((u) => u.role === "admin"),
    [allUsers]
  );

  const employeeCounts = useMemo(() => {
    const active = employees.filter((e) => e.is_active).length;
    const inactive = employees.length - active;
    return { active, inactive, all: employees.length };
  }, [employees]);

  const filteredEmployees = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return employees.filter((emp) => {
      if (tab === "active" && !emp.is_active) return false;
      if (tab === "inactive" && emp.is_active) return false;
      if (!needle) return true;
      return (
        emp.name.toLowerCase().includes(needle) ||
        emp.email.toLowerCase().includes(needle) ||
        emp.designation.toLowerCase().includes(needle)
      );
    });
  }, [employees, tab, search]);

  const openCreateModal = (role: UserRole) => {
    setUserModal({ mode: "create", role, target: null });
    setFormName("");
    setFormEmail("");
    setFormPassword("");
    setChangePassword(true);
    setFormDesignation(role === "admin" ? "Administrator" : "");
    setFormSalaryType("monthly");
    setFormBaseSalary("0");
    setFormError(null);
    setEmailConflictError(null);
    setCopiedPassword(false);
  };

  const openEditModal = (target: AdminEmployeeItem) => {
    setUserModal({ mode: "edit", role: target.role, target });
    setFormName(target.name);
    setFormEmail(target.email);
    setFormPassword("");
    setChangePassword(false);
    setFormDesignation(target.designation);
    setFormSalaryType(target.salary_type);
    setFormBaseSalary(String(target.base_salary));
    setFormError(null);
    setEmailConflictError(null);
    setCopiedPassword(false);
  };

  const handleGeneratePassword = () => {
    const pw = generateStrongPassword(14);
    setFormPassword(pw);
    setCopiedPassword(false);
  };

  const handleCopyPassword = async () => {
    if (!formPassword) return;
    try {
      await navigator.clipboard.writeText(formPassword);
      setCopiedPassword(true);
      window.setTimeout(() => setCopiedPassword(false), 2000);
    } catch {
      pushToast({
        variant: "warning",
        title: "Clipboard unavailable",
        message: "Copy the generated password manually.",
      });
    }
  };

  const handleSaveUser = async (e: FormEvent) => {
    e.preventDefault();
    if (!userModal || savingUser) return;

    setFormError(null);
    setEmailConflictError(null);

    const trimmedName = formName.trim();
    const trimmedEmail = formEmail.trim().toLowerCase();
    const trimmedDesignation = formDesignation.trim();
    const parsedSalary = Number(formBaseSalary);

    if (trimmedName.length < 2) {
      setFormError("Full name must be at least 2 characters.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setEmailConflictError("Enter a valid email address.");
      return;
    }
    if (
      (userModal.mode === "create" || changePassword) &&
      formPassword.length < 8
    ) {
      setFormError("Password must be at least 8 characters.");
      return;
    }
    if (
      userModal.role === "employee" &&
      (!Number.isFinite(parsedSalary) || parsedSalary < 0)
    ) {
      setFormError("Base salary must be a valid non-negative number.");
      return;
    }

    setSavingUser(true);
    try {
      if (userModal.mode === "create") {
        const res = await adminApi.createUser({
          name: trimmedName,
          email: trimmedEmail,
          password: formPassword,
          role: userModal.role,
          designation: trimmedDesignation,
          salary_type: userModal.role === "employee" ? formSalaryType : "monthly",
          base_salary: userModal.role === "employee" ? parsedSalary : 0,
          is_active: true,
        });
        setQuotas(res.quotas);
        setGlobalQuotas(res.quotas);
        pushToast({
          variant: "success",
          title:
            userModal.role === "admin"
              ? `Admin ${res.user.name} added`
              : `Employee ${res.user.name} registered`,
        });
      } else if (userModal.target) {
        const res = await adminApi.updateUser(userModal.target.id, {
          name: trimmedName,
          email: trimmedEmail,
          ...(changePassword ? { password: formPassword } : {}),
          designation: trimmedDesignation,
          ...(userModal.role === "employee"
            ? { salary_type: formSalaryType, base_salary: parsedSalary }
            : {}),
        });
        setQuotas(res.quotas);
        setGlobalQuotas(res.quotas);
        pushToast({
          variant: "success",
          title: `${res.user.name} updated`,
        });
      }

      setUserModal(null);
      await loadRoster();
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === "EMAIL_ALREADY_EXISTS") {
          setEmailConflictError("This email address is already in use.");
        } else if (
          err.code === "MAX_EMPLOYEES_EXCEEDED" ||
          err.code === "MAX_ADMINS_EXCEEDED"
        ) {
          setFormError(err.message);
          await loadRoster();
        } else {
          setFormError(err.message);
        }
      } else {
        setFormError("Could not save account changes.");
      }
    } finally {
      setSavingUser(false);
    }
  };

  const handleConfirmDeactivate = async () => {
    if (!deactivateTarget || mutatingActiveId !== null) return;
    setMutatingActiveId(deactivateTarget.id);
    try {
      const res = await adminApi.updateUser(deactivateTarget.id, {
        is_active: false,
      });
      setQuotas(res.quotas);
      setGlobalQuotas(res.quotas);
      pushToast({
        variant: "success",
        title: `${deactivateTarget.name} deactivated`,
        message: "Active sessions stopped and auth tokens revoked immediately.",
      });
      setDeactivateTarget(null);
      await loadRoster();
    } catch (err) {
      pushToast({
        variant: "error",
        title: "Deactivation failed",
        message: err instanceof ApiClientError ? err.message : "Could not deactivate user",
      });
    } finally {
      setMutatingActiveId(null);
    }
  };

  const handleReactivate = async (target: AdminEmployeeItem) => {
    if (mutatingActiveId !== null) return;
    setMutatingActiveId(target.id);
    try {
      const res = await adminApi.updateUser(target.id, { is_active: true });
      setQuotas(res.quotas);
      setGlobalQuotas(res.quotas);
      pushToast({
        variant: "success",
        title: `${target.name} reactivated`,
      });
      await loadRoster();
    } catch (err) {
      pushToast({
        variant: "error",
        title: "Reactivation blocked",
        message: err instanceof ApiClientError ? err.message : "Could not reactivate user",
      });
      await loadRoster();
    } finally {
      setMutatingActiveId(null);
    }
  };

  const empRemaining = Math.max(
    0,
    quotas.max_active_employees - quotas.active_employees
  );
  const empPct = Math.min(
    100,
    Math.round((quotas.active_employees / quotas.max_active_employees) * 100)
  );
  const empLimitReached = quotas.active_employees >= quotas.max_active_employees;
  const empNearLimit = quotas.active_employees === quotas.max_active_employees - 1;
  const adminLimitReached = quotas.active_admins >= quotas.max_active_admins;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Employees & Admin Access
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Manage your active team quota, salary terms, and administrator accounts.
        </p>
      </div>

      {/* Employee Quota Meter Banner */}
      <section
        aria-label="Active employee slot quota"
        className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Active Employee Slots
              </span>
              <span className="text-lg font-bold text-slate-900 tabular-nums">
                {quotas.active_employees} / {quotas.max_active_employees} Used
              </span>
              <span
                className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold tabular-nums ${
                  empLimitReached
                    ? "border-rose-200 bg-rose-50 text-rose-800"
                    : empNearLimit
                      ? "border-amber-200 bg-amber-50 text-amber-800"
                      : "border-indigo-200 bg-indigo-50 text-indigo-800"
                }`}
              >
                {empLimitReached
                  ? "Limit Reached"
                  : empNearLimit
                    ? "1 slot remaining"
                    : `${empRemaining} slots available`}
              </span>
            </div>
            <p className="text-xs text-slate-500">
              {empLimitReached
                ? "10/10 active limit reached. Deactivate an employee to add someone new."
                : "Hard limit of 10 active employees enforced by database & API."}
            </p>
          </div>

          <button
            type="button"
            disabled={empLimitReached}
            aria-disabled={empLimitReached}
            onClick={() => openCreateModal("employee")}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
          >
            <UserPlus className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            Register Employee
          </button>
        </div>

        <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className={`h-full rounded-full transition-all ${
              empLimitReached
                ? "bg-rose-500"
                : empNearLimit
                  ? "bg-amber-500"
                  : "bg-indigo-600"
            }`}
            style={{ width: `${empPct}%` }}
          />
        </div>
      </section>

      {loadError ? (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
        >
          {loadError}
        </div>
      ) : null}

      {/* Employees Roster */}
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="flex flex-wrap items-center gap-1.5" role="tablist">
            {(
              [
                { id: "active", label: "Active", count: employeeCounts.active },
                {
                  id: "inactive",
                  label: "Deactivated",
                  count: employeeCounts.inactive,
                },
                { id: "all", label: "All", count: employeeCounts.all },
              ] as const
            ).map((t) => {
              const selected = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setTab(t.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 tabular-nums ${
                    selected
                      ? "border-indigo-200 bg-indigo-50 text-indigo-800"
                      : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  <span>{t.label}</span>
                  <span className="rounded bg-white/80 px-1.5 py-0.5 text-[11px]">
                    {t.count}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="relative w-full sm:w-64">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter name, email, role..."
              aria-label="Search employees"
              className="block w-full rounded-lg border border-slate-300 bg-white py-1.5 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
            />
          </div>
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">
            Loading employees...
          </div>
        ) : filteredEmployees.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            No employees match the selected tab or search filter.
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-100/80 text-xs font-semibold uppercase tracking-wide text-slate-600">
                  <tr>
                    <th className="px-5 py-3">Employee</th>
                    <th className="px-5 py-3">Designation</th>
                    <th className="px-5 py-3">Salary Terms</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredEmployees.map((emp) => {
                    const live = emp.live_status;
                    return (
                      <tr key={emp.id} className="hover:bg-slate-50/80">
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-3">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-xs font-bold text-indigo-800">
                              {getInitials(emp.name)}
                            </div>
                            <div className="min-w-0">
                              <p className="font-semibold text-slate-900">
                                {emp.name}
                              </p>
                              <p className="text-xs text-slate-500">{emp.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3.5 text-slate-700">
                          {emp.designation || "—"}
                        </td>
                        <td className="px-5 py-3.5 font-medium text-slate-800 tabular-nums">
                          {emp.salary_type === "monthly" ? "Monthly" : "Hourly"} ·{" "}
                          {formatCurrency(emp.base_salary, currencyCode)}
                          {emp.salary_type === "hourly" ? "/hr" : ""}
                        </td>
                        <td className="px-5 py-3.5">
                          {!emp.is_active ? (
                            <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
                              Deactivated
                            </span>
                          ) : live?.is_online && live.screen_locked ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                              <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                              Screen Locked
                            </span>
                          ) : live?.is_online ? (
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                              <span
                                className="h-2 w-2 rounded-full bg-emerald-500"
                                aria-hidden="true"
                              />
                              Tracking
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
                              Offline
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => openEditModal(emp)}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                            >
                              <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                              Edit
                            </button>
                            {emp.is_active ? (
                              <button
                                type="button"
                                onClick={() => setDeactivateTarget(emp)}
                                className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-800 hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600"
                              >
                                <UserX className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                                Deactivate
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={
                                  empLimitReached || mutatingActiveId === emp.id
                                }
                                title={
                                  empLimitReached
                                    ? "Cannot reactivate: 10/10 active slots are full."
                                    : "Reactivate employee"
                                }
                                onClick={() => void handleReactivate(emp)}
                                className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
                              >
                                <UserCheck className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                                Reactivate
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile Stacked Cards */}
            <div className="divide-y divide-slate-200 md:hidden">
              {filteredEmployees.map((emp) => (
                <div key={emp.id} className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-slate-900">{emp.name}</p>
                      <p className="text-xs text-slate-500">{emp.email}</p>
                      <p className="mt-1 text-xs text-slate-600">
                        {emp.designation || "Employee"}
                      </p>
                    </div>
                    <span
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                        !emp.is_active
                          ? "border-slate-200 bg-slate-100 text-slate-600"
                          : emp.live_status?.is_online
                            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                            : "border-slate-200 bg-slate-100 text-slate-600"
                      }`}
                    >
                      {!emp.is_active
                        ? "Deactivated"
                        : emp.live_status?.is_online
                          ? emp.live_status.screen_locked
                            ? "Screen Locked"
                            : "Tracking"
                          : "Offline"}
                    </span>
                  </div>
                  <p className="text-xs font-medium text-slate-800 tabular-nums">
                    {emp.salary_type === "monthly" ? "Monthly" : "Hourly"} ·{" "}
                    {formatCurrency(emp.base_salary, currencyCode)}
                    {emp.salary_type === "hourly" ? "/hr" : ""}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openEditModal(emp)}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700"
                    >
                      Edit
                    </button>
                    {emp.is_active ? (
                      <button
                        type="button"
                        onClick={() => setDeactivateTarget(emp)}
                        className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-800"
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={empLimitReached || mutatingActiveId === emp.id}
                        title={
                          empLimitReached
                            ? "Cannot reactivate: 10/10 active slots are full."
                            : undefined
                        }
                        onClick={() => void handleReactivate(emp)}
                        className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Reactivate
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* Admin Roster (Max 2, Min 1) */}
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Shield className="h-5 w-5 text-indigo-700" strokeWidth={1.75} aria-hidden="true" />
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Admin Roster{" "}
                <span className="text-sm font-medium text-slate-600 tabular-nums">
                  ({quotas.active_admins} / {quotas.max_active_admins} Active Admins)
                </span>
              </h2>
              <p className="text-xs text-slate-500">
                Maximum 2 active administrators; at least 1 active admin must always remain.
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={adminLimitReached}
            title={adminLimitReached ? "Max 2 active admins allowed" : "Add 2nd Admin"}
            onClick={() => openCreateModal("admin")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
          >
            <UserPlus className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            {adminLimitReached ? "Add Admin (Max 2 Reached)" : "Add Admin"}
          </button>
        </div>

        <div className="divide-y divide-slate-200">
          {admins.map((adm) => {
            const isSelf = adm.id === currentAdmin?.id;
            const isSoleActiveAdmin =
              adm.is_active && quotas.active_admins <= 1;
            const disableDeactivate = isSelf || isSoleActiveAdmin;
            const disableReason = isSelf
              ? "Cannot deactivate your own account"
              : isSoleActiveAdmin
                ? "Cannot disable last active admin"
                : undefined;

            return (
              <div
                key={adm.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900">{adm.name}</span>
                    <span className="text-xs text-slate-500">({adm.email})</span>
                    {isSelf ? (
                      <span className="rounded-md border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-800">
                        You
                      </span>
                    ) : null}
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                        adm.is_active
                          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                          : "border-slate-200 bg-slate-100 text-slate-600"
                      }`}
                    >
                      {adm.is_active ? "Active Admin" : "Deactivated"}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openEditModal(adm)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                  >
                    <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                    Edit
                  </button>

                  {adm.is_active ? (
                    <button
                      type="button"
                      disabled={disableDeactivate}
                      title={disableReason}
                      onClick={() => setDeactivateTarget(adm)}
                      className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-800 hover:bg-rose-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600"
                    >
                      {isSoleActiveAdmin ? (
                        <Lock className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      ) : (
                        <UserX className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      )}
                      Deactivate
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={adminLimitReached || mutatingActiveId === adm.id}
                      title={
                        adminLimitReached
                          ? "Cannot reactivate: 2/2 active admins reached"
                          : undefined
                      }
                      onClick={() => void handleReactivate(adm)}
                      className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
                    >
                      <UserCheck className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      Reactivate
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Register / Edit User Modal */}
      <Modal
        open={Boolean(userModal)}
        onClose={() => {
          if (!savingUser) setUserModal(null);
        }}
        role="dialog"
        labelledBy="user-modal-title"
        maxWidthClass="max-w-lg"
      >
        <form onSubmit={(e) => void handleSaveUser(e)} className="p-6">
          <h2 id="user-modal-title" className="text-lg font-semibold text-slate-900">
            {userModal?.mode === "create"
              ? userModal.role === "admin"
                ? "Add Administrator"
                : "Register Employee"
              : userModal?.role === "admin"
                ? `Edit Admin — ${userModal.target?.name}`
                : `Edit Employee — ${userModal?.target?.name}`}
          </h2>

          {formError ? (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-medium text-rose-800"
            >
              {formError}
            </div>
          ) : null}

          <div className="mt-4 space-y-4">
            <div>
              <label
                htmlFor="user-name"
                className="block text-sm font-medium text-slate-700"
              >
                Full Name *
              </label>
              <input
                id="user-name"
                type="text"
                required
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
              />
            </div>

            <div>
              <label
                htmlFor="user-email"
                className="block text-sm font-medium text-slate-700"
              >
                Email Address *
              </label>
              <input
                id="user-email"
                type="email"
                required
                value={formEmail}
                onChange={(e) => {
                  setFormEmail(e.target.value);
                  setEmailConflictError(null);
                }}
                aria-invalid={emailConflictError ? "true" : "false"}
                className={`mt-1 block w-full rounded-lg border px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 ${
                  emailConflictError ? "border-rose-400 bg-rose-50/40" : "border-slate-300"
                }`}
              />
              {emailConflictError ? (
                <p className="mt-1 text-xs text-rose-700">{emailConflictError}</p>
              ) : null}
            </div>

            {/* Password Section */}
            <div>
              <div className="flex items-center justify-between">
                <label
                  htmlFor="user-password"
                  className="block text-sm font-medium text-slate-700"
                >
                  {userModal?.mode === "create" ? "Initial Password *" : "Password"}
                </label>
                {userModal?.mode === "edit" ? (
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-indigo-700">
                    <input
                      type="checkbox"
                      checked={changePassword}
                      onChange={(e) => {
                        setChangePassword(e.target.checked);
                        if (!e.target.checked) setFormPassword("");
                      }}
                      className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-600"
                    />
                    Set New Password
                  </label>
                ) : null}
              </div>

              {userModal?.mode === "create" || changePassword ? (
                <div className="mt-1.5 space-y-2">
                  <div className="flex gap-2">
                    <input
                      id="user-password"
                      type="text"
                      required
                      minLength={8}
                      value={formPassword}
                      onChange={(e) => setFormPassword(e.target.value)}
                      placeholder="Minimum 8 characters"
                      className="block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                    />
                    <button
                      type="button"
                      onClick={handleGeneratePassword}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                    >
                      <KeyRound className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      Generate
                    </button>
                    <button
                      type="button"
                      disabled={!formPassword}
                      onClick={() => void handleCopyPassword()}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                    >
                      {copiedPassword ? (
                        <Check className="h-3.5 w-3.5 text-emerald-700" strokeWidth={1.75} aria-hidden="true" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      )}
                      {copiedPassword ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Share this password securely with the user. Updating password revokes active tokens.
                  </p>
                </div>
              ) : (
                <p className="mt-1 text-xs text-slate-500">
                  Leave unchecked to keep existing password.
                </p>
              )}
            </div>

            {userModal?.role === "employee" ? (
              <>
                <div>
                  <label
                    htmlFor="user-designation"
                    className="block text-sm font-medium text-slate-700"
                  >
                    Designation
                  </label>
                  <input
                    id="user-designation"
                    type="text"
                    value={formDesignation}
                    onChange={(e) => setFormDesignation(e.target.value)}
                    placeholder="e.g. Senior Designer"
                    className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                  />
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="user-salary-type"
                      className="block text-sm font-medium text-slate-700"
                    >
                      Salary Type *
                    </label>
                    <select
                      id="user-salary-type"
                      value={formSalaryType}
                      onChange={(e) =>
                        setFormSalaryType(e.target.value as SalaryType)
                      }
                      className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                    >
                      <option value="monthly">Monthly</option>
                      <option value="hourly">Hourly</option>
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="user-base-salary"
                      className="block text-sm font-medium text-slate-700"
                    >
                      Base Salary ({currencyCode}) *
                    </label>
                    <input
                      id="user-base-salary"
                      type="number"
                      min="0"
                      step="0.01"
                      required
                      value={formBaseSalary}
                      onChange={(e) => setFormBaseSalary(e.target.value)}
                      className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                    />
                  </div>
                </div>
              </>
            ) : null}
          </div>

          <div className="mt-6 flex justify-end gap-2.5 border-t border-slate-200 pt-4">
            <button
              type="button"
              disabled={savingUser}
              onClick={() => setUserModal(null)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={savingUser}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
            >
              {savingUser ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
              ) : null}
              {userModal?.mode === "create" ? "Create Account" : "Save Changes"}
            </button>
          </div>
        </form>
      </Modal>

      {/* Safe Deactivate Confirmation AlertDialog */}
      <Modal
        open={Boolean(deactivateTarget)}
        onClose={() => {
          if (mutatingActiveId === null) setDeactivateTarget(null);
        }}
        role="alertdialog"
        labelledBy="deactivate-title"
        describedBy="deactivate-desc"
        initialFocusRef={deactivateCancelRef}
        maxWidthClass="max-w-md"
      >
        <div className="p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-700">
              <AlertTriangle className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
            </div>
            <div>
              <h2
                id="deactivate-title"
                className="text-lg font-semibold text-slate-900"
              >
                Deactivate {deactivateTarget?.name}?
              </h2>
              <div id="deactivate-desc" className="mt-2 space-y-2 text-sm text-slate-600">
                <ul className="list-disc space-y-1.5 pl-4 text-xs text-slate-700">
                  <li>
                    <strong className="font-semibold text-slate-900">
                      Immediate Lockout:
                    </strong>{" "}
                    Forces active desktop session to stop (<code>FORCE_STOP</code>) and
                    revokes auth tokens immediately.
                  </li>
                  <li>
                    <strong className="font-semibold text-slate-900">
                      Frees Quota Slot:
                    </strong>{" "}
                    {deactivateTarget?.role === "admin"
                      ? `Active admin count drops (${quotas.active_admins} / ${quotas.max_active_admins} → ${Math.max(1, quotas.active_admins - 1)} / ${quotas.max_active_admins}).`
                      : `Active employee count drops (${quotas.active_employees} / ${quotas.max_active_employees} → ${Math.max(0, quotas.active_employees - 1)} / ${quotas.max_active_employees}).`}
                  </li>
                  <li>
                    <strong className="font-semibold text-slate-900">
                      History Preserved:
                    </strong>{" "}
                    Existing salary reports, work hours, and screenshots remain intact until
                    natural 90-day expiry.
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-2.5">
            <button
              ref={deactivateCancelRef}
              type="button"
              disabled={mutatingActiveId !== null}
              onClick={() => setDeactivateTarget(null)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={mutatingActiveId !== null}
              onClick={() => void handleConfirmDeactivate()}
              className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2"
            >
              {mutatingActiveId !== null ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
              ) : null}
              {deactivateTarget?.role === "admin"
                ? "Deactivate Admin"
                : "Deactivate Employee"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
