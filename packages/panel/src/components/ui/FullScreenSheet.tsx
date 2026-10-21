import type { ReactNode } from "react";
import { useVisualViewport } from "~/lib/use-visual-viewport";

export type SheetPrimaryAction = { label: string; onClick: () => void; disabled?: boolean };

/** Phone form of a dialog (#830): Cancel · title · primary action in a sticky header, scrolling body, footer repeated at the bottom. */
export function FullScreenSheet({
  titleId,
  title,
  onClose,
  cancelLabel = "Cancel",
  primaryAction,
  footer,
  children,
  zIndex,
  panelRef,
}: {
  titleId: string;
  title: ReactNode;
  onClose: () => void;
  cancelLabel?: string;
  primaryAction?: SheetPrimaryAction;
  footer?: ReactNode;
  children: ReactNode;
  zIndex: number;
  panelRef: (node: HTMLElement | null) => void;
}) {
  const { height, offsetTop } = useVisualViewport();
  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-full-screen-sheet
      className="mc-sheet"
      style={{ zIndex, height: height === null ? "100dvh" : `${height}px`, top: offsetTop }}
    >
      <div className="mc-sheet-header">
        <button type="button" className="mc-sheet-action" onClick={onClose}>
          {cancelLabel}
        </button>
        <div id={titleId} className="mc-sheet-title">
          {title}
        </div>
        {primaryAction ? (
          <button
            type="button"
            className="mc-sheet-action mc-sheet-action-primary"
            onClick={primaryAction.onClick}
            disabled={primaryAction.disabled}
          >
            {primaryAction.label}
          </button>
        ) : (
          <span />
        )}
      </div>
      <div className="mc-sheet-body">{children}</div>
      {footer && <div className="mc-sheet-footer">{footer}</div>}
    </section>
  );
}
