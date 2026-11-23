import React, { createContext, useCallback, useContext, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}

interface ToastContextValue {
  pushToast: (kind: ToastKind, title: string, detail?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let toastSeq = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const reducedMotion = useReducedMotion();

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (kind: ToastKind, title: string, detail?: string) => {
      const id = toastSeq++;
      setToasts((prev) => [...prev.slice(-4), { id, kind, title, detail }]);
      window.setTimeout(() => {
        dismiss(id);
      }, 5200);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={{ pushToast }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-full max-w-sm flex-col gap-2"
      >
        <AnimatePresence initial={false}>
          {toasts.map((toast) => {
            const Icon =
              toast.kind === "success"
                ? CheckCircle2
                : toast.kind === "error"
                ? AlertCircle
                : Info;

            const iconColor =
              toast.kind === "success"
                ? "text-[var(--sage)]"
                : toast.kind === "error"
                ? "text-[var(--coral)]"
                : "text-[var(--accent)]";

            return (
              <motion.div
                key={toast.id}
                layout={!reducedMotion}
                initial={reducedMotion ? false : { opacity: 0, y: 14, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 16, scale: 0.96 }}
                transition={
                  reducedMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 420, damping: 32, mass: 0.7 }
                }
                className="ce-glass ce-float pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-[var(--ink)]"
              >
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${iconColor}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium leading-snug text-[var(--ink)]">
                    {toast.title}
                  </p>
                  {toast.detail && (
                    <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-[var(--muted)]">
                      {toast.detail}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(toast.id)}
                  className="rounded-md p-1 text-[var(--muted)] transition hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]"
                  aria-label="Dismiss notification"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return ctx;
}
