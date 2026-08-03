import {
  formatPathForTerminalPaste,
  isProjectPathDrag,
  readProjectPathFromDragEvent,
} from "./project-path-drag";
import {
  mapTerminalKey,
  shouldSuppressTerminalKey,
  terminalClipboardAction,
} from "./terminal-keymap";
import type { TaskStatus } from "@actana/shared/domain";

/** Write bytes to the pane's live PTY. Resolves false when there is none. */
type PtyWrite = (data: string) => Promise<boolean> | boolean;

type TerminalLike = {
  focus(): void;
  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  paste(data: string): void;
};

const ANSI_ESCAPE_REGEX =
  /(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[PX^_].*?(?:\x1b\\)|\x1b[@-_])/g;

export function stripTerminalSelectionFormatting(text: string): string {
  return text.replace(ANSI_ESCAPE_REGEX, "");
}

/**
 * True when `el` sits inside an xterm surface (`.xterm`) that is itself inside
 * the container matched by `scopeSelector`. Pure over the passed element so the
 * scope-matching logic stays unit-testable without a DOM environment; the
 * `is*XtermFocused` wrappers feed it `document.activeElement`.
 */
export function isXtermWithinScope(el: Element | null, scopeSelector: string): boolean {
  if (!el) return false;
  if (!el.closest(scopeSelector)) return false;
  return !!el.closest(".xterm");
}

function activeXtermIsWithin(scopeSelector: string): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return isXtermWithinScope(el, scopeSelector);
}

/** True when keyboard focus is inside an xterm surface in the bottom user terminal panel. */
export function isUserTerminalXtermFocused(): boolean {
  return activeXtermIsWithin("[data-user-terminal-panel]");
}

/** True when keyboard focus is inside an xterm surface in the session terminal panel. */
export function isSessionTerminalXtermFocused(): boolean {
  return activeXtermIsWithin("[data-session-terminal-panel]");
}

/** True when keyboard focus is inside an xterm surface in a session grid cell. */
export function isGridTerminalXtermFocused(): boolean {
  return activeXtermIsWithin("[data-grid-cell]");
}

export function isTerminalXtermFocused(): boolean {
  return (
    isUserTerminalXtermFocused() ||
    isSessionTerminalXtermFocused() ||
    isGridTerminalXtermFocused()
  );
}

export function terminalExitTaskStatus(exitCode?: number): TaskStatus {
  return exitCode === 0 ? "finished" : "terminated";
}

export type TerminalZoomIntent = "in" | "out" | "reset";

/**
 * Cmd/Ctrl + =/+ zoom in, Cmd/Ctrl + - zoom out, Cmd/Ctrl + 0 reset to default;
 * null when not a zoom chord.
 */
export function terminalZoomIntentFromKeyboard(e: KeyboardEvent): TerminalZoomIntent | null {
  if (e.type !== "keydown") return null;
  if (!(e.metaKey || e.ctrlKey)) return null;
  if (e.altKey) return null;
  if (e.key === "+" || e.key === "=" || e.code === "Equal") return "in";
  if (e.key === "-" || e.code === "Minus") return "out";
  if (e.key === "0" || e.code === "Digit0") return "reset";
  return null;
}

/**
 * Wire drag-and-drop on `host` so a project path dragged from the Panel's own
 * UI pastes into the active PTY. Returns a cleanup function.
 *
 * Files dragged in from the operator's desktop are deliberately not handled:
 * the browser hands over bytes, not a path, and the path that would matter is
 * one on the *Core's* machine, which the operator's laptop cannot name
 * (ADR 0010). Attach an image through the session's own attach flow instead.
 */
export function wireTerminalFileDrop(opts: {
  host: HTMLElement;
  write: PtyWrite;
  onFocus: () => void;
}): () => void {
  const { host, write, onFocus } = opts;
  const onDragOver = (e: DragEvent) => {
    if (isProjectPathDrag(e)) {
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    }
  };
  const onDrop = (e: DragEvent) => {
    const projectPath = readProjectPathFromDragEvent(e);
    if (!projectPath) return;
    e.preventDefault();
    void write(formatPathForTerminalPaste(projectPath) + " ");
    onFocus();
  };
  host.addEventListener("dragover", onDragOver);
  host.addEventListener("drop", onDrop);
  return () => {
    host.removeEventListener("dragover", onDragOver);
    host.removeEventListener("drop", onDrop);
  };
}

/**
 * Override xterm.js key handling so Shift+Enter, Cmd-key passthroughs, etc.
 * write the right escape sequence to the PTY instead of falling back to
 * xterm's plain-CR for every Enter. Mirrors the iTerm2 / Terminal.app key
 * map that `claude /terminal-setup` registers.
 *
 * preventDefault matters: returning false makes xterm bail before its own
 * preventDefault, so without this the hidden textarea also inserts `\n` and
 * xterm's input handler writes it to the PTY.
 */
export function attachTerminalKeyHandler(opts: {
  term: TerminalLike;
  write: PtyWrite;
}): void {
  const { term, write } = opts;
  term.attachCustomKeyEventHandler((e) => {
    // Copy/paste chords. Windows/Linux need the common Ctrl+C-with-selection and
    // Ctrl+V path; Ctrl+C without a selection still passes through as SIGINT.
    // The async Clipboard API is available because the Panel is served over a
    // secure context (localhost, or HTTPS behind the reverse proxy — ADR 0010).
    // Pasting goes through term.paste(), so xterm keeps bracketed-paste
    // semantics and emits the final bytes through onData.
    const clipboardAction = terminalClipboardAction(e, { hasSelection: term.hasSelection() });
    if (clipboardAction) {
      e.preventDefault();
      if (e.type === "keydown") {
        const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
        if (!clipboard) return false;
        if (clipboardAction === "copy") {
          if (term.hasSelection()) {
            const selection = stripTerminalSelectionFormatting(term.getSelection());
            if (selection) {
              void clipboard
                .writeText(selection)
                .then(() => {
                  term.clearSelection();
                })
                .catch(() => undefined);
            }
          }
        } else {
          void clipboard
            .readText()
            .then((text) => {
              if (text) term.paste(text);
            })
            .catch(() => undefined);
        }
      }
      return false;
    }

    const bytes = mapTerminalKey(e);
    if (bytes === null) {
      if (!shouldSuppressTerminalKey(e)) return true;
      e.preventDefault();
      return false;
    }
    e.preventDefault();
    void write(bytes);
    return false;
  });
}
