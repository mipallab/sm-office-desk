import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Banknote,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Pencil,
  Plus,
  Printer,
  Trash2,
} from "lucide-react";
import {
  DEFAULT_COMPANY_TIMEZONE,
  DEFAULT_CURRENCY_CODE,
  type PaymentStatus,
  type SalaryReport,
} from "@sm-office/shared";
import { Modal } from "../components/Modal";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { adminApi, ApiClientError } from "../lib/api";
import {
  formatCurrency,
  formatDurationHm,
  formatMonthHeading,
  getCurrentMonthInTimezone,
  safeFormatTimezoneParts,
  shiftYearMonth,
} from "../lib/format";
import type { AdminEmployeeItem, SalaryReportPreviewResponse } from "../types/api";

type StatusFilter = "all" | "paid" | "pending";

export function SalaryPage() {
  const { company } = useAuth();
  const { pushToast } = useToast();

  const companyTimezone = company?.company_timezone ?? DEFAULT_COMPANY_TIMEZONE;
  const companyCurrency = company?.currency_code ?? DEFAULT_CURRENCY_CODE;
  const companyName = company?.company_name ?? "SM Office Desk";

  const [selectedMonth, setSelectedMonth] = useState<string>(() =>
    getCurrentMonthInTimezone(companyTimezone)
  );
  const [filterEmployeeId, setFilterEmployeeId] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const [employees, setEmployees] = useState<AdminEmployeeItem[]>([]);
  const [reports, setReports] = useState<SalaryReport[]>([]);
  const [currencyCode, setCurrencyCode] = useState<string>(companyCurrency);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exportingCsv, setExportingCsv] = useState<boolean>(false);
  const [markingPaidId, setMarkingPaidId] = useState<number | null>(null);

  // Create / Edit Modal state
  const [modalMode, setModalMode] = useState<"create" | "edit" | null>(null);
  const [editingReport, setEditingReport] = useState<SalaryReport | null>(null);
  const [formEmployeeId, setFormEmployeeId] = useState<number>(0);
  const [formMonth, setFormMonth] = useState<string>(selectedMonth);
  const [formBonus, setFormBonus] = useState<string>("0");
  const [formDeductions, setFormDeductions] = useState<string>("0");
  const [formNotes, setFormNotes] = useState<string>("");
  const [formPaymentStatus, setFormPaymentStatus] =
    useState<PaymentStatus>("pending");
  const [preview, setPreview] = useState<SalaryReportPreviewResponse | null>(null);
  const [loadingPreview, setLoadingPreview] = useState<boolean>(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [savingReport, setSavingReport] = useState<boolean>(false);

  // Delete Pending Modal state
  const [deleteTarget, setDeleteTarget] = useState<SalaryReport | null>(null);
  const [deleting, setDeleting] = useState<boolean>(false);
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [empRes, repRes] = await Promise.all([
        adminApi.listEmployees({ role: "employee", status: "all" }),
        adminApi.listSalaryReports({
          month: selectedMonth,
          employeeId: filterEmployeeId ? Number(filterEmployeeId) : undefined,
          paymentStatus: statusFilter,
        }),
      ]);
      setEmployees(empRes.users);
      setReports(repRes.reports);
      setCurrencyCode(repRes.currency_code || companyCurrency);
    } catch (err) {
      setLoadError(
        err instanceof ApiClientError ? err.message : "Failed to load salary reports"
      );
    } finally {
      setLoading(false);
    }
  }, [companyCurrency, filterEmployeeId, selectedMonth, statusFilter]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Fetch preview whenever Create modal employee or month changes
  useEffect(() => {
    if (modalMode !== "create" || !formEmployeeId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(formMonth)) {
      setPreview(null);
      return;
    }

    let active = true;
    setLoadingPreview(true);
    adminApi
      .previewSalaryReport({ employeeId: formEmployeeId, month: formMonth })
      .then((res) => {
        if (!active) return;
        setPreview(res);
      })
      .catch(() => {
        if (!active) return;
        setPreview(null);
      })
      .finally(() => {
        if (active) setLoadingPreview(false);
      });

    return () => {
      active = false;
    };
  }, [modalMode, formEmployeeId, formMonth]);

  const metrics = useMemo(() => {
    let totalPayroll = 0;
    let paidTotal = 0;
    let paidCount = 0;
    let pendingTotal = 0;
    let pendingCount = 0;
    let totalSeconds = 0;

    for (const rep of reports) {
      totalPayroll += rep.net_payable;
      totalSeconds += rep.total_worked_seconds;
      if (rep.payment_status === "paid") {
        paidCount += 1;
        paidTotal += rep.net_payable;
      } else {
        pendingCount += 1;
        pendingTotal += rep.net_payable;
      }
    }

    return {
      totalPayroll,
      paidCount,
      paidTotal,
      pendingCount,
      pendingTotal,
      totalSeconds,
    };
  }, [reports]);

  const openCreateModal = () => {
    const firstEmp = employees.find((e) => e.is_active) ?? employees[0];
    setModalMode("create");
    setEditingReport(null);
    setFormEmployeeId(firstEmp?.id ?? 0);
    setFormMonth(selectedMonth);
    setFormBonus("0");
    setFormDeductions("0");
    setFormNotes("");
    setFormPaymentStatus("pending");
    setModalError(null);
  };

  const openEditModal = (report: SalaryReport) => {
    setModalMode("edit");
    setEditingReport(report);
    setFormEmployeeId(report.employee_id);
    setFormMonth(report.report_month);
    setFormBonus(String(report.overtime_or_bonus));
    setFormDeductions(String(report.deductions));
    setFormNotes(report.notes);
    setFormPaymentStatus(report.payment_status);
    setPreview(null);
    setModalError(null);
  };

  const handleOpenExistingReport = async (existingId: number) => {
    let target = reports.find((r) => r.id === existingId);
    if (!target) {
      try {
        const res = await adminApi.listSalaryReports({
          month: formMonth,
          employeeId: formEmployeeId,
          paymentStatus: "all",
        });
        target = res.reports.find((r) => r.id === existingId);
      } catch {
        target = undefined;
      }
    }
    if (target) {
      openEditModal(target);
    } else {
      pushToast({
        variant: "info",
        title: "Existing report found",
        message: "Adjust your filters to view that report.",
      });
      setModalMode(null);
    }
  };

  const liveCalculation = useMemo(() => {
    const bonusNum = Math.max(0, Number(formBonus) || 0);
    const dedNum = Math.max(0, Number(formDeductions) || 0);

    if (modalMode === "edit" && editingReport) {
      const gross =
        editingReport.salary_type_snapshot === "monthly"
          ? editingReport.base_rate_snapshot
          : (editingReport.total_worked_seconds / 3600) *
            editingReport.base_rate_snapshot;
      const net = Math.max(0, Math.round((gross + bonusNum - dedNum) * 100) / 100);
      return {
        salaryType: editingReport.salary_type_snapshot,
        baseRate: editingReport.base_rate_snapshot,
        workedSeconds: editingReport.total_worked_seconds,
        workedHours: editingReport.total_worked_hours,
        currency: editingReport.currency_code,
        gross: Math.round(gross * 100) / 100,
        bonus: bonusNum,
        deductions: dedNum,
        net,
      };
    }

    if (modalMode === "create" && preview) {
      const gross =
        preview.salary_type === "monthly"
          ? preview.base_salary
          : (preview.total_worked_seconds / 3600) * preview.base_salary;
      const net = Math.max(0, Math.round((gross + bonusNum - dedNum) * 100) / 100);
      return {
        salaryType: preview.salary_type,
        baseRate: preview.base_salary,
        workedSeconds: preview.total_worked_seconds,
        workedHours: preview.total_worked_hours,
        currency: preview.currency_code,
        gross: Math.round(gross * 100) / 100,
        bonus: bonusNum,
        deductions: dedNum,
        net,
      };
    }

    return null;
  }, [modalMode, editingReport, preview, formBonus, formDeductions]);

  const handleSaveModal = async (e: FormEvent) => {
    e.preventDefault();
    if (!modalMode || savingReport) return;
    setModalError(null);

    const bonus = Number(formBonus);
    const deductions = Number(formDeductions);
    if (!Number.isFinite(bonus) || bonus < 0) {
      setModalError("Overtime / Bonus must be >= 0.");
      return;
    }
    if (!Number.isFinite(deductions) || deductions < 0) {
      setModalError("Deductions must be >= 0.");
      return;
    }

    setSavingReport(true);
    try {
      if (modalMode === "create") {
        if (!formEmployeeId) {
          setModalError("Select an employee.");
          setSavingReport(false);
          return;
        }
        const created = await adminApi.createSalaryReport({
          employee_id: formEmployeeId,
          report_month: formMonth,
          overtime_or_bonus: bonus,
          deductions,
          notes: formNotes.trim(),
        });
        if (formPaymentStatus === "paid") {
          await adminApi.updateSalaryReport(created.report.id, {
            payment_status: "paid",
          });
        }
        pushToast({
          variant: "success",
          title: `Salary report created for ${created.report.employee_name}`,
        });
      } else if (editingReport) {
        const isLockedPaid =
          editingReport.payment_status === "paid" &&
          formPaymentStatus === "paid";

        await adminApi.updateSalaryReport(editingReport.id, {
          ...(isLockedPaid
            ? {}
            : {
                overtime_or_bonus: bonus,
                deductions,
              }),
          notes: formNotes.trim(),
          payment_status: formPaymentStatus,
        });
        pushToast({
          variant: "success",
          title: `Salary report updated for ${editingReport.employee_name}`,
        });
      }

      setModalMode(null);
      await loadData();
    } catch (err) {
      setModalError(
        err instanceof ApiClientError ? err.message : "Could not save salary report"
      );
    } finally {
      setSavingReport(false);
    }
  };

  const handleMarkPaid = async (report: SalaryReport) => {
    if (markingPaidId !== null) return;
    setMarkingPaidId(report.id);
    try {
      await adminApi.updateSalaryReport(report.id, { payment_status: "paid" });
      pushToast({
        variant: "success",
        title: `Marked ${report.employee_name} as Paid`,
      });
      await loadData();
    } catch (err) {
      pushToast({
        variant: "error",
        title: "Failed to mark report paid",
        message: err instanceof ApiClientError ? err.message : "Please try again.",
      });
    } finally {
      setMarkingPaidId(null);
    }
  };

  const handleDeletePending = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await adminApi.deleteSalaryReport(deleteTarget.id);
      pushToast({
        variant: "success",
        title: `Deleted pending salary report for ${deleteTarget.employee_name}`,
      });
      setDeleteTarget(null);
      await loadData();
    } catch (err) {
      pushToast({
        variant: "error",
        title: "Delete failed",
        message: err instanceof ApiClientError ? err.message : "Could not delete report",
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleExportCsv = async () => {
    if (exportingCsv) return;
    setExportingCsv(true);
    try {
      const blob = await adminApi.exportSalaryReportsCsv(selectedMonth);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `sm-office-desk-salary-${selectedMonth}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      pushToast({
        variant: "success",
        title: `Exported salary-${selectedMonth}.csv`,
      });
    } catch (err) {
      pushToast({
        variant: "error",
        title: "CSV export failed",
        message: err instanceof ApiClientError ? err.message : "Please try again.",
      });
    } finally {
      setExportingCsv(false);
    }
  };

  const printedAt = useMemo(() => {
    const parts = safeFormatTimezoneParts(Date.now(), companyTimezone);
    return `${parts.dateString} ${parts.timeString} ${companyTimezone}`;
  }, [companyTimezone]);

  const isEditFinancialsLocked =
    modalMode === "edit" &&
    editingReport?.payment_status === "paid" &&
    formPaymentStatus === "paid";

  return (
    <div className="space-y-6">
      {/* Print-only Company Masthead */}
      <div className="hidden border-b-2 border-slate-900 pb-4 print:block">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{companyName}</h1>
            <p className="text-sm font-semibold text-slate-700">
              Salary Report — {formatMonthHeading(selectedMonth)} ({selectedMonth})
            </p>
          </div>
          <div className="text-right text-xs text-slate-600">
            <p>Timezone: {companyTimezone}</p>
            <p>Currency: {currencyCode}</p>
            <p className="tabular-nums">Printed on: {printedAt}</p>
          </div>
        </div>
      </div>

      {/* Screen Header & Month Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-xs sm:p-5 print:hidden">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Salary Reports
          </h1>
          <p className="mt-0.5 text-xs font-medium text-slate-600">
            Monthly payroll snapshots in {companyTimezone} · {currencyCode}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center rounded-lg border border-slate-300 bg-white">
            <button
              type="button"
              onClick={() => setSelectedMonth((m) => shiftYearMonth(m, -1))}
              aria-label="Previous month"
              className="rounded-l-lg px-2.5 py-1.5 text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
            <input
              type="month"
              value={selectedMonth}
              onChange={(e) => {
                if (e.target.value) setSelectedMonth(e.target.value);
              }}
              aria-label="Report month"
              className="border-x border-slate-200 px-2.5 py-1 text-sm font-semibold text-slate-900 tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
            />
            <button
              type="button"
              onClick={() => setSelectedMonth((m) => shiftYearMonth(m, 1))}
              aria-label="Next month"
              className="rounded-r-lg px-2.5 py-1.5 text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
            >
              <ChevronRight className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>

          <button
            type="button"
            disabled={exportingCsv}
            onClick={() => void handleExportCsv()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
          >
            {exportingCsv ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            )}
            Export CSV
          </button>

          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
          >
            <Printer className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Print / Save PDF
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs print:border-slate-400">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Total Payroll
          </p>
          <p className="mt-1.5 text-xl font-bold text-slate-900 tabular-nums">
            {formatCurrency(metrics.totalPayroll, currencyCode)}
          </p>
          <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
            {reports.length} report{reports.length === 1 ? "" : "s"} in {selectedMonth}
          </p>
        </div>

        <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 shadow-xs print:border-slate-400 print:bg-white">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
            Paid ({metrics.paidCount})
          </p>
          <p className="mt-1.5 text-xl font-bold text-emerald-900 tabular-nums">
            {formatCurrency(metrics.paidTotal, currencyCode)}
          </p>
          <p className="mt-0.5 text-xs text-emerald-800/80">Settled payroll</p>
        </div>

        <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-4 shadow-xs print:border-slate-400 print:bg-white">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
            Pending ({metrics.pendingCount})
          </p>
          <p className="mt-1.5 text-xl font-bold text-amber-900 tabular-nums">
            {formatCurrency(metrics.pendingTotal, currencyCode)}
          </p>
          <p className="mt-0.5 text-xs text-amber-800/80">Awaiting disbursement</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs print:border-slate-400">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Total Tracked Hours
          </p>
          <p className="mt-1.5 text-xl font-bold text-slate-900 tabular-nums">
            {formatDurationHm(metrics.totalSeconds)}
          </p>
          <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
            {(metrics.totalSeconds / 3600).toFixed(2)} hrs logged
          </p>
        </div>
      </div>

      {/* Filters + Table Container */}
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs print:border-slate-400 print:shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 print:hidden">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <label htmlFor="salary-emp-filter" className="sr-only">
                Filter by employee
              </label>
              <select
                id="salary-emp-filter"
                value={filterEmployeeId}
                onChange={(e) => setFilterEmployeeId(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
              >
                <option value="">All Employees</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name} {!emp.is_active ? "(Deactivated)" : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1" role="group" aria-label="Payment status filter">
              {(["all", "paid", "pending"] as const).map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setStatusFilter(status)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-semibold capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 ${
                    statusFilter === status
                      ? "border-indigo-200 bg-indigo-50 text-indigo-800"
                      : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  {status}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            disabled={employees.length === 0}
            onClick={openCreateModal}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            Create Salary Report
          </button>
        </div>

        {loadError ? (
          <div className="p-6 text-sm text-rose-800">{loadError}</div>
        ) : loading ? (
          <div className="p-8 text-center text-sm text-slate-500">
            Loading salary reports...
          </div>
        ) : reports.length === 0 ? (
          <div className="p-10 text-center">
            <Banknote
              className="mx-auto h-8 w-8 text-slate-400"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <p className="mt-3 text-sm font-semibold text-slate-800">
              No salary reports for {selectedMonth}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Click &ldquo;Create Salary Report&rdquo; to snapshot worked hours and rates for this month.
            </p>
          </div>
        ) : (
          <>
            {/* Desktop & Print Table */}
            <div className="hidden overflow-x-auto md:block print:block">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-100/80 text-xs font-semibold uppercase tracking-wide text-slate-600 print:border-slate-400">
                  <tr>
                    <th className="px-4 py-3">Employee</th>
                    <th className="px-4 py-3">Tracked Time</th>
                    <th className="px-4 py-3">Snapshot Rate</th>
                    <th className="px-4 py-3">Bonus / Ded.</th>
                    <th className="px-4 py-3">Net Payable</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right print:hidden">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 print:divide-slate-300">
                  {reports.map((rep) => {
                    const grossBase =
                      rep.salary_type_snapshot === "monthly"
                        ? rep.base_rate_snapshot
                        : Math.round(
                            (rep.total_worked_seconds / 3600) *
                              rep.base_rate_snapshot *
                              100
                          ) / 100;

                    return (
                      <tr
                        key={rep.id}
                        className="print-break-inside-avoid hover:bg-slate-50/70"
                      >
                        <td className="px-4 py-3.5">
                          <p className="font-semibold text-slate-900">
                            {rep.employee_name}
                          </p>
                          <p className="text-xs text-slate-500">
                            {rep.employee_designation || rep.employee_email}
                          </p>
                        </td>
                        <td className="px-4 py-3.5 tabular-nums">
                          <p className="font-medium text-slate-900">
                            {formatDurationHm(rep.total_worked_seconds)}
                          </p>
                          <p className="text-xs text-slate-500">
                            {rep.total_worked_hours.toFixed(2)} hrs
                          </p>
                        </td>
                        <td className="px-4 py-3.5 tabular-nums">
                          <p className="font-medium text-slate-900">
                            {rep.salary_type_snapshot === "monthly"
                              ? "Monthly"
                              : "Hourly"}{" "}
                            ·{" "}
                            {formatCurrency(
                              rep.base_rate_snapshot,
                              rep.currency_code
                            )}
                            {rep.salary_type_snapshot === "hourly" ? "/hr" : ""}
                          </p>
                          <p className="text-xs text-slate-500">
                            {rep.salary_type_snapshot === "hourly"
                              ? `Base: ${formatCurrency(grossBase, rep.currency_code)}`
                              : "Snapshotted rate"}
                          </p>
                        </td>
                        <td className="px-4 py-3.5 font-mono text-xs text-slate-700 tabular-nums">
                          +{rep.overtime_or_bonus.toLocaleString("en-US")} / -
                          {rep.deductions.toLocaleString("en-US")}
                        </td>
                        <td className="px-4 py-3.5 font-bold text-slate-900 tabular-nums">
                          {formatCurrency(rep.net_payable, rep.currency_code)}
                        </td>
                        <td className="px-4 py-3.5">
                          {rep.payment_status === "paid" ? (
                            <div>
                              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-800">
                                Paid
                              </span>
                              {rep.paid_at ? (
                                <p className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
                                  {safeFormatTimezoneParts(rep.paid_at, companyTimezone).dateString}
                                </p>
                              ) : null}
                            </div>
                          ) : (
                            <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
                              Pending
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-right print:hidden">
                          <div className="inline-flex items-center gap-1.5">
                            {rep.payment_status === "pending" ? (
                              <button
                                type="button"
                                disabled={markingPaidId === rep.id}
                                onClick={() => void handleMarkPaid(rep)}
                                className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
                              >
                                <CheckCircle2
                                  className="h-3.5 w-3.5"
                                  strokeWidth={1.75}
                                  aria-hidden="true"
                                />
                                Mark Paid
                              </button>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => openEditModal(rep)}
                              aria-label={`Edit report for ${rep.employee_name}`}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                            >
                              <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                              Edit
                            </button>
                            {rep.payment_status === "pending" ? (
                              <button
                                type="button"
                                onClick={() => setDeleteTarget(rep)}
                                aria-label={`Delete pending report for ${rep.employee_name}`}
                                className="rounded-lg border border-rose-200 bg-rose-50 p-1.5 text-rose-700 hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600"
                              >
                                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="border-t-2 border-slate-300 bg-slate-50 font-semibold text-slate-900">
                  <tr>
                    <td className="px-4 py-3">Totals ({reports.length})</td>
                    <td className="px-4 py-3 tabular-nums">
                      {formatDurationHm(metrics.totalSeconds)}
                    </td>
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3 font-bold tabular-nums">
                      {formatCurrency(metrics.totalPayroll, currencyCode)}
                    </td>
                    <td className="px-4 py-3 text-xs tabular-nums">
                      {metrics.paidCount} Paid · {metrics.pendingCount} Pending
                    </td>
                    <td className="px-4 py-3 print:hidden" />
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Mobile Stacked Cards (Hidden on Print & Desktop) */}
            <div className="divide-y divide-slate-200 md:hidden print:hidden">
              {reports.map((rep) => (
                <div key={rep.id} className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-slate-900">
                        {rep.employee_name}
                      </p>
                      <p className="text-xs text-slate-500">
                        {rep.employee_designation || rep.employee_email}
                      </p>
                    </div>
                    <span
                      className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase ${
                        rep.payment_status === "paid"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                          : "border-amber-200 bg-amber-50 text-amber-800"
                      }`}
                    >
                      {rep.payment_status}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-2.5 text-xs tabular-nums">
                    <div>
                      <span className="text-slate-500">Tracked</span>
                      <p className="font-semibold text-slate-900">
                        {formatDurationHm(rep.total_worked_seconds)}
                      </p>
                    </div>
                    <div>
                      <span className="text-slate-500">Net Payable</span>
                      <p className="font-bold text-slate-900">
                        {formatCurrency(rep.net_payable, rep.currency_code)}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {rep.payment_status === "pending" ? (
                      <button
                        type="button"
                        disabled={markingPaidId === rep.id}
                        onClick={() => void handleMarkPaid(rep)}
                        className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800"
                      >
                        Mark Paid
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => openEditModal(rep)}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700"
                    >
                      Edit
                    </button>
                    {rep.payment_status === "pending" ? (
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(rep)}
                        className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-800"
                      >
                        Delete
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* Create / Edit Salary Report Modal */}
      <Modal
        open={modalMode !== null}
        onClose={() => {
          if (!savingReport) setModalMode(null);
        }}
        role="dialog"
        labelledBy="salary-modal-title"
        maxWidthClass="max-w-lg"
      >
        <form onSubmit={(e) => void handleSaveModal(e)} className="p-6">
          <h2 id="salary-modal-title" className="text-lg font-semibold text-slate-900">
            {modalMode === "create"
              ? "Create Salary Report"
              : `Edit Salary Report — ${editingReport?.employee_name}`}
          </h2>

          {modalError ? (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-medium text-rose-800"
            >
              {modalError}
            </div>
          ) : null}

          <div className="mt-4 space-y-4">
            {modalMode === "create" ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="salary-modal-emp"
                    className="block text-sm font-medium text-slate-700"
                  >
                    Employee *
                  </label>
                  <select
                    id="salary-modal-emp"
                    value={formEmployeeId}
                    onChange={(e) => setFormEmployeeId(Number(e.target.value))}
                    className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                  >
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.name} {!emp.is_active ? "(Deactivated)" : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="salary-modal-month"
                    className="block text-sm font-medium text-slate-700"
                  >
                    Report Month *
                  </label>
                  <input
                    id="salary-modal-month"
                    type="month"
                    required
                    value={formMonth}
                    onChange={(e) => setFormMonth(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                  />
                </div>
              </div>
            ) : (
              <div className="text-xs font-medium text-slate-600">
                Billing Month:{" "}
                <span className="font-mono font-semibold text-slate-900">
                  {editingReport?.report_month}
                </span>
              </div>
            )}

            {/* Duplicate Report Guard */}
            {modalMode === "create" && preview?.existing_report_id ? (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
              >
                <span>
                  A report for this employee ({formMonth}) already exists.
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void handleOpenExistingReport(preview.existing_report_id!)
                  }
                  className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 font-semibold text-amber-900 hover:bg-amber-100"
                >
                  Open Existing Report
                </button>
              </div>
            ) : null}

            {/* Rate Snapshot & Tracked Hours Info Box */}
            {loadingPreview ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs text-slate-500">
                Calculating tracked hours in {companyTimezone}...
              </div>
            ) : liveCalculation ? (
              <div className="space-y-1.5 rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs text-slate-700">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-600">
                    Total Tracked Hours:
                  </span>
                  <span className="font-semibold text-slate-900 tabular-nums">
                    {formatDurationHm(liveCalculation.workedSeconds)} (
                    {liveCalculation.workedSeconds.toLocaleString("en-US")}s)
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-600">
                    Rate Snapshot:
                  </span>
                  <span className="font-semibold text-slate-900 tabular-nums">
                    {liveCalculation.salaryType === "monthly" ? "Monthly" : "Hourly"}{" "}
                    ·{" "}
                    {formatCurrency(
                      liveCalculation.baseRate,
                      liveCalculation.currency
                    )}
                    {liveCalculation.salaryType === "hourly" ? "/hr" : ""}
                  </span>
                </div>
                <p className="pt-1 text-[11px] text-slate-500">
                  These rate values are snapshotted onto this report so future salary
                  raises do not alter past payroll records.
                </p>
              </div>
            ) : null}

            {isEditFinancialsLocked ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                <span>
                  Paid reports lock financial edits. Revert to Pending to adjust Bonus or Deductions.
                </span>
                <button
                  type="button"
                  onClick={() => setFormPaymentStatus("pending")}
                  className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 font-semibold text-amber-900 hover:bg-amber-100"
                >
                  Revert to Pending
                </button>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="salary-bonus"
                  className="block text-sm font-medium text-slate-700"
                >
                  Overtime / Bonus ({liveCalculation?.currency ?? currencyCode})
                </label>
                <input
                  id="salary-bonus"
                  type="number"
                  min="0"
                  step="0.01"
                  disabled={isEditFinancialsLocked}
                  value={formBonus}
                  onChange={(e) => setFormBonus(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 tabular-nums disabled:bg-slate-100 disabled:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                />
              </div>

              <div>
                <label
                  htmlFor="salary-deductions"
                  className="block text-sm font-medium text-slate-700"
                >
                  Deductions ({liveCalculation?.currency ?? currencyCode})
                </label>
                <input
                  id="salary-deductions"
                  type="number"
                  min="0"
                  step="0.01"
                  disabled={isEditFinancialsLocked}
                  value={formDeductions}
                  onChange={(e) => setFormDeductions(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 tabular-nums disabled:bg-slate-100 disabled:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="salary-status"
                className="block text-sm font-medium text-slate-700"
              >
                Payment Status
              </label>
              <select
                id="salary-status"
                value={formPaymentStatus}
                onChange={(e) =>
                  setFormPaymentStatus(e.target.value as PaymentStatus)
                }
                className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
              >
                <option value="pending">Pending</option>
                <option value="paid">Paid</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="salary-notes"
                className="block text-sm font-medium text-slate-700"
              >
                Notes
              </label>
              <textarea
                id="salary-notes"
                rows={2}
                maxLength={500}
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                placeholder="Optional payroll notes..."
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
              />
            </div>

            {/* Live Calculation Footer */}
            {liveCalculation ? (
              <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-3 text-xs text-indigo-950 tabular-nums">
                <span className="font-medium">
                  Calculated Base (
                  {formatCurrency(liveCalculation.gross, liveCalculation.currency)})
                  + Bonus (
                  {formatCurrency(liveCalculation.bonus, liveCalculation.currency)})
                  − Deductions (
                  {formatCurrency(
                    liveCalculation.deductions,
                    liveCalculation.currency
                  )}
                  ) ={" "}
                </span>
                <span className="text-sm font-bold text-indigo-900">
                  Net Payable:{" "}
                  {formatCurrency(liveCalculation.net, liveCalculation.currency)}
                </span>
              </div>
            ) : null}
          </div>

          <div className="mt-6 flex justify-end gap-2.5 border-t border-slate-200 pt-4">
            <button
              type="button"
              disabled={savingReport}
              onClick={() => setModalMode(null)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={
                savingReport ||
                (modalMode === "create" && Boolean(preview?.existing_report_id))
              }
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
            >
              {savingReport ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
              ) : null}
              {modalMode === "create" ? "Create Report" : "Save Report"}
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete Pending Report AlertDialog */}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        role="alertdialog"
        labelledBy="delete-salary-title"
        describedBy="delete-salary-desc"
        initialFocusRef={deleteCancelRef}
        maxWidthClass="max-w-md"
      >
        <div className="p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-700">
              <AlertTriangle className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
            </div>
            <div>
              <h2
                id="delete-salary-title"
                className="text-lg font-semibold text-slate-900"
              >
                Delete Pending Salary Report?
              </h2>
              <p id="delete-salary-desc" className="mt-2 text-sm text-slate-600">
                Remove{" "}
                <span className="font-semibold text-slate-900">
                  {deleteTarget?.employee_name}
                </span>
                &apos;s pending salary report for{" "}
                <span className="font-mono font-semibold text-slate-800">
                  {deleteTarget?.report_month}
                </span>
                ? Tracked work sessions are preserved and you can regenerate the report anytime.
              </p>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-2.5">
            <button
              ref={deleteCancelRef}
              type="button"
              disabled={deleting}
              onClick={() => setDeleteTarget(null)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() => void handleDeletePending()}
              className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2"
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
              ) : null}
              Delete Report
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
