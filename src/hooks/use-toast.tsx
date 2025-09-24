// hooks/use-toast.ts
"use client";

import React from "react";
import { toast as sonnerToast } from "sonner";

/**
 * Minimal, Sonner-backed toast helper that keeps the same public API
 * as your previous implementation:
 * - toast(props) -> { id, dismiss, update }
 * - useToast() -> { toasts, toast, dismiss }
 *
 * Notes:
 * - Sonner must have a single <Toaster /> mounted in the app (see example below).
 * - This wrapper enforces TOAST_LIMIT = 1 by dismissing existing toasts before showing a new one.
 */

const TOAST_LIMIT = 1;
const DEFAULT_DURATION = 5000; // fallback duration in ms

type ToastAction = { label: string; onClick?: () => void } | null;

type ToastOptions = {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastAction;
  duration?: number;
  type?: "default" | "success" | "error" | "loading" | "info";
};

function renderContent(title?: React.ReactNode, description?: React.ReactNode) {
  if (title) {
    return (
      <div>
        <div>{title}</div>
        {description ? <div style={{ opacity: 0.9 }}>{description}</div> : null}
      </div>
    );
  }
  return (description ?? "") as any;
}

/**
 * Programmatic toast function — returns { id, dismiss, update }
 */
export function toast({
  title,
  description,
  action = null,
  duration,
  type = "default",
}: ToastOptions) {
  // enforce limit=1 behavior: dismiss all existing toasts first
  if (TOAST_LIMIT === 1) {
    sonnerToast.dismiss();
  }

  const content = renderContent(title, description);
  const opts = {
    duration: typeof duration === "number" ? duration : DEFAULT_DURATION,
    action: action
      ? {
          label: action.label,
          onClick: () => {
            try {
              action.onClick?.();
            } finally {
              /* close after action */
              /* Sonner auto-closes on action by default, but call dismiss to be safe */
              /* eslint-disable-next-line @typescript-eslint/no-floating-promises */
              Promise.resolve().then(() => sonnerToast.dismiss());
            }
          },
        }
      : undefined,
  };

  // create toast, pick style by type
  let id = "";
  switch (type) {
    case "success":
      id = String(sonnerToast.success(content, opts));
      break;
    case "error":
      id = String(sonnerToast.error(content, opts));
      break;
    case "loading":
      id = String(
        sonnerToast.loading(content, {
          ...opts,
          duration: duration ?? Number.POSITIVE_INFINITY,
        }),
      );
      break;
    case "info":
      id = String(sonnerToast(content, opts));
      break;
    default:
      id = String(sonnerToast(content, opts));
  }

  const dismiss = (toastId = id) => {
    sonnerToast.dismiss(toastId);
  };

  const update = (u: ToastOptions) => {
    const newContent = renderContent(u.title, u.description);
    const newOpts: any = {
      id,
      duration: typeof u.duration === "number" ? u.duration : opts.duration,
      action: u.action
        ? {
            label: u.action.label,
            onClick: () => {
              try {
                u.action?.onClick?.();
              } finally {
                sonnerToast.dismiss(id);
              }
            },
          }
        : undefined,
    };

    switch (u.type) {
      case "success":
        sonnerToast.success(newContent, newOpts);
        break;
      case "error":
        sonnerToast.error(newContent, newOpts);
        break;
      case "loading":
        sonnerToast.loading(newContent, {
          ...newOpts,
          duration: u.duration ?? Number.POSITIVE_INFINITY,
        });
        break;
      default:
        sonnerToast(newContent, newOpts);
    }

    return id;
  };

  return { id, dismiss, update };
}

/**
 * useToast hook — returns the same shape your components used previously.
 * Note: We don't mirror Sonner's internal list of toasts; Sonner controls visuals.
 * The `toasts` array is kept for API parity (empty here). If you need the list,
 * we can implement a local memoryState + listener system, but Sonner manages UI.
 */
export function useToast() {
  const api = React.useMemo(() => {
    return {
      toasts: [] as Array<unknown>,
      toast: (props: ToastOptions) => toast(props),
      dismiss: (id?: string) => sonnerToast.dismiss(id),
    };
  }, []);

  return api;
}
