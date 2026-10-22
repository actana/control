import { useCallback, useRef, useState, type CSSProperties } from "react";
import { toast } from "sonner";
import { applyCtrl, keySequence, type TerminalKey } from "~/lib/terminal-keys";

/**
 * Sticky Ctrl for the phone key row. The parent owns one instance, passes it to
 * <TerminalKeyRow ctrl={...}/> and ALSO routes keyboard input through
 * `consume(data)` (in the pane's xterm `onData` handler, before writing to the
 * PTY) so Ctrl applies to the next character typed on the on-screen keyboard.
 * Armed state releases after one consume().
 */
export function useStickyCtrl() {
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const set = useCallback((next: boolean) => {
    armedRef.current = next;
    setArmed(next);
  }, []);
  const toggle = useCallback(() => set(!armedRef.current), [set]);
  const consume = useCallback(
    (data: string) => {
      if (!armedRef.current) return data;
      set(false);
      return applyCtrl(data);
    },
    [set],
  );
  return { armed, toggle, consume };
}

export type StickyCtrl = ReturnType<typeof useStickyCtrl>;

const KEYS: Array<{ id: string; label: string; name: string; key?: TerminalKey }> = [
  { id: "esc", label: "Esc", name: "Esc", key: "esc" },
  { id: "tab", label: "Tab", name: "Tab", key: "tab" },
  { id: "ctrl", label: "Ctrl", name: "Ctrl" },
  { id: "up", label: "↑", name: "Up", key: "up" },
  { id: "down", label: "↓", name: "Down", key: "down" },
  { id: "left", label: "←", name: "Left", key: "left" },
  { id: "right", label: "→", name: "Right", key: "right" },
  { id: "paste", label: "paste", name: "Paste" },
];

const rowStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  overflowX: "auto",
  padding: "8px max(8px, env(safe-area-inset-right)) 8px max(8px, env(safe-area-inset-left))",
  background: "var(--surface-1, transparent)",
  borderTop: "1px solid var(--border)",
};

function keyStyle(pressed: boolean): CSSProperties {
  return {
    flex: "1 0 0",
    minWidth: 44,
    minHeight: 44,
    padding: "0 6px",
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    fontSize: 13,
    color: "var(--text-1)",
    background: pressed ? "var(--accent-soft, var(--surface-3, var(--surface-2)))" : "var(--surface-2)",
    border: pressed ? "1px solid var(--accent, var(--border))" : "1px solid var(--border)",
    borderRadius: 6,
    cursor: "pointer",
  };
}

export function TerminalKeyRow({
  onSend,
  onPaste,
  ctrl,
  applicationCursor,
  onPasteError,
}: {
  /** Bytes for the PTY (the pane's `controls.writeToPty`). */
  onSend: (data: string) => void;
  /** Clipboard text, pasted like the desktop shortcut (the pane's `controls.paste`). */
  onPaste: (text: string) => void;
  ctrl: StickyCtrl;
  /** Read `term.modes.applicationCursorKeysMode` at press time if available. */
  applicationCursor?: () => boolean;
  onPasteError?: (err: unknown) => void;
}) {
  const paste = async () => {
    try {
      if (!navigator.clipboard?.readText) throw new Error("Clipboard is not available");
      const text = await navigator.clipboard.readText();
      if (text) onPaste(text);
    } catch (err) {
      if (onPasteError) onPasteError(err);
      else toast.error("Could not read the clipboard");
    }
  };

  return (
    <div className="mc-terminal-keyrow" role="toolbar" aria-label="Terminal keys" style={rowStyle}>
      {KEYS.map((k) => {
        const isCtrl = k.id === "ctrl";
        return (
          <button
            key={k.id}
            type="button"
            aria-label={k.name}
            aria-pressed={isCtrl ? ctrl.armed : undefined}
            style={keyStyle(isCtrl && ctrl.armed)}
            // Keep focus (and the on-screen keyboard) on the terminal.
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (isCtrl) ctrl.toggle();
              else if (k.key) onSend(ctrl.consume(keySequence(k.key, { applicationCursor: applicationCursor?.() })));
              else void paste();
            }}
          >
            {k.label}
          </button>
        );
      })}
    </div>
  );
}
