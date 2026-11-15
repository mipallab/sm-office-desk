import { useEffect, useRef, type ReactNode, type RefObject } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  role?: "dialog" | "alertdialog";
  labelledBy: string;
  describedBy?: string;
  maxWidthClass?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  closeOnBackdropClick?: boolean;
  children: ReactNode;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function Modal({
  open,
  onClose,
  role = "dialog",
  labelledBy,
  describedBy,
  maxWidthClass = "max-w-lg",
  initialFocusRef,
  closeOnBackdropClick,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const initialFocusTargetRef = useRef(initialFocusRef);

  onCloseRef.current = onClose;
  initialFocusTargetRef.current = initialFocusRef;

  const canBackdropClose =
    closeOnBackdropClick ?? role !== "alertdialog";

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = document.activeElement as HTMLElement | null;

    const focusInitial = () => {
      const panel = panelRef.current;
      if (
        panel &&
        panel.contains(document.activeElement) &&
        document.activeElement !== panel
      ) {
        return;
      }
      if (initialFocusTargetRef.current?.current) {
        initialFocusTargetRef.current.current.focus();
        return;
      }
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length > 0 && focusables[0]) {
        focusables[0].focus();
      } else {
        panel.focus();
      }
    };

    const raf = window.requestAnimationFrame(focusInitial);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;

      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

      if (focusables.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (!active || active === first || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (!active || active === last || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = prevOverflow;
      const prevEl = previousFocusRef.current;
      if (prevEl && typeof prevEl.focus === "function" && document.contains(prevEl)) {
        prevEl.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 print:hidden"
      role={role}
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    >
      <div
        className="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-[2px]"
        aria-hidden="true"
        onClick={() => {
          if (canBackdropClose) {
            onClose();
          }
        }}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`relative z-50 w-full ${maxWidthClass} max-h-[92vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-xl focus:outline-none`}
      >
        {children}
      </div>
    </div>
  );
}
