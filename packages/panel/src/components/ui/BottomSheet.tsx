import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVisualViewport } from "~/lib/use-visual-viewport";

const FOCUSABLE = "button:not([disabled]), textarea:not([disabled]), input:not([disabled])";

/**
 * A titled bottom sheet for a short form or confirmation on a phone (#834, M43): it comes up from the bottom over a dimmed
 * page with a drag-handle bar. A tap on the dim or Escape closes it; Tab stays inside and focus returns to the opener.
 * Looks like `ActionSheet`, but holds any content instead of a menu.
 */
export function BottomSheet({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const { height, offsetTop } = useVisualViewport();
  const panel = useRef<HTMLElement>(null);
  // Callers pass inline arrows; the effect below must not re-run (and move focus) on every render of theirs.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const panelEl = panel.current;
        if (!panelEl) return;
        const focusable = panelEl.querySelectorAll<HTMLElement>(FOCUSABLE);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === panelEl)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      back?.focus();
    };
  }, [open]);

  if (!open) return null;
  const sheet = (
    <div className="mc-action-sheet-backdrop" data-testid="bottom-sheet-backdrop" onClick={onClose}
      style={{ top: offsetTop, bottom: "auto", height: height === null ? "100dvh" : `${height}px` }}
    >
      <section
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="mc-action-sheet mc-bottom-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <div aria-hidden className="mc-action-sheet-handle" />
        <div id={titleId} className="mc-action-sheet-title">
          {title}
        </div>
        {children}
      </section>
    </div>
  );
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}
