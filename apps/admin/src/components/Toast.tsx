import {
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  XCircle,
} from "lucide-react";
import { useToast, type ToastItem, type ToastVariant } from "../context/ToastContext";

const VARIANT_STYLES: Record<
  ToastVariant,
  { container: string; iconColor: string; titleColor: string }
> = {
  success: {
    container: "bg-white border-emerald-200 shadow-md",
    iconColor: "text-emerald-700",
    titleColor: "text-slate-900",
  },
  info: {
    container: "bg-white border-indigo-200 shadow-md",
    iconColor: "text-indigo-700",
    titleColor: "text-slate-900",
  },
  warning: {
    container: "bg-amber-50 border-amber-200 shadow-md",
    iconColor: "text-amber-800",
    titleColor: "text-amber-950",
  },
  error: {
    container: "bg-rose-50 border-rose-200 shadow-md",
    iconColor: "text-rose-700",
    titleColor: "text-rose-950",
  },
};

function ToastIcon({ variant, className }: { variant: ToastVariant; className: string }) {
  switch (variant) {
    case "success":
      return <CheckCircle2 className={className} strokeWidth={1.75} aria-hidden="true" />;
    case "warning":
      return <AlertTriangle className={className} strokeWidth={1.75} aria-hidden="true" />;
    case "error":
      return <XCircle className={className} strokeWidth={1.75} aria-hidden="true" />;
    case "info":
    default:
      return <Info className={className} strokeWidth={1.75} aria-hidden="true" />;
  }
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const styles = VARIANT_STYLES[toast.variant];
  const isUrgent = toast.variant === "error" || toast.variant === "warning";

  return (
    <div
      role={isUrgent ? "alert" : "status"}
      aria-live={isUrgent ? "assertive" : "polite"}
      className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border p-3.5 transition-opacity ${styles.container}`}
    >
      <ToastIcon variant={toast.variant} className={`mt-0.5 h-5 w-5 shrink-0 ${styles.iconColor}`} />
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-semibold ${styles.titleColor}`}>{toast.title}</p>
        {toast.message ? (
          <p className="mt-0.5 text-xs text-slate-600">{toast.message}</p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
      >
        <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const { toasts, dismissToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed right-4 top-4 z-[60] flex w-full max-w-sm flex-col gap-2.5 print:hidden"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={dismissToast} />
      ))}
    </div>
  );
}
