import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CardFrame } from "~/components/ui/CardFrame";
import { SessionIcon } from "~/components/ui/SessionIcon";
import { mutateTaskForCore } from "~/lib/mutate-task-for-core";
import { useDismissableMenu } from "~/lib/use-dismissable-menu";
import {
  DEFAULT_SESSION_ICON,
  SESSION_ICON_OPTIONS,
  isSessionIcon,
} from "~/lib/session-icons";
import { Z_INDEX } from "~/lib/z-index";

/**
 * A miniature chip that renders the current session icon and, on click, opens
 * a portal-anchored popover for picking a new one. The mutation is routed
 * through the coreId-parameterized {@link mutateTaskForCore} dispatcher so
 * every Core shares one code path (ADR-0005) — the
 * picker itself never conditions on `coreId`.
 *
 * `currentIcon` is the value from the Task snapshot the Core emits. `onPicked`
 * is invoked after the Core confirms the write so the caller can refresh
 * whatever view mirrors the row (e.g. invalidate the tasks query).
 */
export function SessionIconPicker({
  coreId,
  taskId,
  currentIcon,
  size = 24,
  strokeWidth = 1.6,
  animate = false,
  ariaLabel,
  className,
  wrapperStyle,
  onPicked,
}: {
  coreId: string | null;
  taskId: string;
  currentIcon: string | null | undefined;
  size?: number;
  strokeWidth?: number;
  animate?: boolean;
  ariaLabel?: string;
  className?: string;
  wrapperStyle?: React.CSSProperties;
  onPicked?: (icon: string | null) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [busyIcon, setBusyIcon] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useDismissableMenu(anchor !== null, () => setAnchor(null));

  const resolvedIcon = isSessionIcon(currentIcon) ? currentIcon : DEFAULT_SESSION_ICON;

  const open = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Anchor below and left-aligned with the chip; the popover clamps itself
    // into the viewport via the CardFrame's own overflow rules.
    setAnchor({ x: rect.left, y: rect.bottom + 6 });
    setError(null);
  }, []);

  const pick = useCallback(
    async (nextIcon: string) => {
      if (busyIcon) return;
      setBusyIcon(nextIcon);
      setError(null);
      try {
        await mutateTaskForCore(coreId, {
          op: "update",
          taskId,
          icon: nextIcon,
        });
        onPicked?.(nextIcon);
        setAnchor(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyIcon(null);
      }
    },
    [busyIcon, coreId, taskId, onPicked],
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (anchor) setAnchor(null);
          else open();
        }}
        aria-label={ariaLabel ?? "Change session icon"}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        className={className}
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          margin: 0,
          cursor: "pointer",
          color: "inherit",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          ...wrapperStyle,
        }}
      >
        <SessionIcon
          name={resolvedIcon}
          size={size}
          strokeWidth={strokeWidth}
          animate={animate}
        />
      </button>
      {anchor &&
        createPortal(
          <CardFrame
            role="menu"
            aria-label="Pick a session icon"
            solid
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              top: anchor.y,
              left: anchor.x,
              width: 260,
              maxHeight: 320,
              overflow: "auto",
              padding: 8,
              boxShadow: "0 14px 32px rgba(0,0,0,0.42)",
              zIndex: Z_INDEX.popover,
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(8, 1fr)",
                gap: 2,
              }}
            >
              {SESSION_ICON_OPTIONS.map((opt) => {
                const isCurrent = opt.id === resolvedIcon;
                const isBusy = busyIcon === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    title={`${opt.id} — ${opt.hint}`}
                    onClick={() => void pick(opt.id)}
                    disabled={busyIcon !== null}
                    aria-pressed={isCurrent}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: isCurrent
                        ? "var(--accent-faint, var(--accent-dim))"
                        : "transparent",
                      border: isCurrent
                        ? "1px solid var(--accent-border, var(--border))"
                        : "1px solid transparent",
                      color: isCurrent ? "var(--accent)" : "var(--text-dim)",
                      cursor: busyIcon ? "wait" : "pointer",
                      opacity: isBusy ? 0.5 : 1,
                    }}
                  >
                    <SessionIcon name={opt.id} size={16} strokeWidth={1.6} />
                  </button>
                );
              })}
            </div>
            {error && (
              <div
                role="alert"
                style={{
                  marginTop: 8,
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  color: "var(--danger, #e5484d)",
                }}
              >
                {error}
              </div>
            )}
          </CardFrame>,
          document.body,
        )}
    </>
  );
}
