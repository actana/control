import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";

export type ActionSheetItem = { label: string; icon: IconName; onSelect: () => void; danger?: boolean };

/**
 * A menu as a bottom action sheet (#833, M26): on a phone a menu that drops down from a button lands off screen or under
 * a thumb, so its items come up from the bottom over a dimmed page, each a full-width 52 px row, with Cancel last. A tap
 * on the dim, Escape or Cancel closes it; an item closes it and then runs.
 */
export function ActionSheet({
  open,
  title,
  items,
  onClose,
}: {
  open: boolean;
  title: string;
  items: readonly ActionSheetItem[];
  onClose: () => void;
}) {
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      back?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  const sheet = (
    <div className="mc-action-sheet-backdrop" data-testid="action-sheet-backdrop" onClick={onClose}>
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="mc-action-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <div aria-hidden className="mc-action-sheet-handle" />
        <div id={titleId} className="mc-action-sheet-title">
          {title}
        </div>
        <div role="menu" aria-labelledby={titleId} className="mc-action-sheet-items">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="mc-action-sheet-item"
              data-danger={item.danger ? "" : undefined}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              <Icon name={item.icon} size={18} />
              {item.label}
            </button>
          ))}
        </div>
        <button type="button" className="mc-action-sheet-cancel" onClick={onClose}>
          Cancel
        </button>
      </section>
    </div>
  );
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}
