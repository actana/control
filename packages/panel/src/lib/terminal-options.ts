import type { ITerminalOptions } from "@xterm/xterm";

// The Studio brand accent (--brand-accent) — cursor + selection wash.
const ACCENT = "#29a9e0";

export const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace';

export const TERMINAL_FONT_SIZE = 12;

export type TerminalColorScheme = "dark" | "light";

type TerminalTheme = NonNullable<ITerminalOptions["theme"]>;

// The two fixed xterm palettes, derived from the Studio tokens: the grounds
// are the two --terminal-bg values (dark --surface-main, light --surface-card)
// and the foregrounds the matching --text-primary. ANSI colors are tuned for
// contrast on each ground; there is no other theme state.
const TERMINAL_THEMES: Record<TerminalColorScheme, TerminalTheme> = {
  dark: {
    background: "#0e1722",
    foreground: "#f9fafb",
    black: "#0f0f11",
    brightBlack: "#6b7280",
    white: "#e5e7eb",
    brightWhite: "#ffffff",
  },
  light: {
    background: "#ffffff",
    foreground: "#111827",
    black: "#111827",
    brightBlack: "#6b7280",
    red: "#b42318",
    brightRed: "#d92d20",
    green: "#087443",
    brightGreen: "#099250",
    yellow: "#a15c07",
    brightYellow: "#c07213",
    blue: "#175cd3",
    brightBlue: "#2e90fa",
    magenta: "#9e165f",
    brightMagenta: "#c11574",
    cyan: "#0e7090",
    brightCyan: "#06aed4",
    white: "#f1f0eb",
    brightWhite: "#ffffff",
  },
};

export function getTerminalColorScheme(): TerminalColorScheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function withAlpha(color: string, alpha: number): string {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const value = hex[1]!;
    const opacity = Math.round(alpha * 255)
      .toString(16)
      .padStart(2, "0");
    return `#${value}${opacity}`;
  }
  return color;
}

export function createTerminalTheme({
  colorScheme = "dark",
  cursorColor = ACCENT,
}: {
  colorScheme?: TerminalColorScheme;
  cursorColor?: string;
} = {}): TerminalTheme {
  return {
    ...TERMINAL_THEMES[colorScheme],
    cursor: cursorColor,
    selectionBackground: withAlpha(ACCENT, colorScheme === "light" ? 0.26 : 0.3),
  };
}

/** Re-theme running terminals when the `.dark` class flips on <html>. */
export function watchTerminalColorScheme(
  onChange: (colorScheme: TerminalColorScheme) => void
): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return () => undefined;
  }
  let previous = getTerminalColorScheme();
  const observer = new MutationObserver(() => {
    const next = getTerminalColorScheme();
    if (next === previous) return;
    previous = next;
    onChange(next);
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

export function createTerminalOptions({
  cursorColor = ACCENT,
  colorScheme = "dark",
  fontSize = TERMINAL_FONT_SIZE,
}: {
  cursorColor?: string;
  colorScheme?: TerminalColorScheme;
  fontSize?: number;
} = {}): ITerminalOptions {
  return {
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize,
    fontWeight: 400,
    fontWeightBold: 700,
    // 1.0 (the default) keeps multi-row ANSI art (OpenCode's startup wordmark,
    // box drawing, background fills) flush.
    lineHeight: 1.0,
    letterSpacing: 0,
    cursorBlink: true,
    theme: createTerminalTheme({ colorScheme, cursorColor }),
    allowProposedApi: true,
    // Option must act as Meta on macOS or Claude Code's meta bindings
    // (Option+P model picker, etc.) never arrive: xterm's default composes
    // "π" instead of emitting ESC+p. Tradeoff: Option no longer composes
    // special characters inside terminal panes. Alt+Arrow word-movement is
    // unaffected — attachTerminalKeyHandler intercepts it before xterm.
    macOptionIsMeta: true,
    scrollback: 5000,
  };
}

/** Wait until the terminal monospace face is measured before the first PTY write. */
export async function waitForTerminalFont(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts?.load) return;
  try {
    await Promise.all([
      document.fonts.load(`${TERMINAL_FONT_SIZE}px ${TERMINAL_FONT_FAMILY}`),
      document.fonts.ready,
    ]);
  } catch {
    /* best effort — xterm falls back to system monospace */
  }
}

type TerminalViewportSnapshot = {
  viewportY: number;
  atBottom: boolean;
};

type ScrollPreservingTerminal = {
  buffer?: {
    active?: {
      viewportY: number;
      baseY: number;
    };
  };
  scrollToBottom?: () => void;
  scrollToLine?: (line: number) => void;
};

function captureTerminalViewport(term: ScrollPreservingTerminal): TerminalViewportSnapshot | null {
  const active = term.buffer?.active;
  if (!active) return null;
  return {
    viewportY: active.viewportY,
    atBottom: active.viewportY >= active.baseY,
  };
}

function restoreTerminalViewport(
  term: ScrollPreservingTerminal,
  snapshot: TerminalViewportSnapshot | null,
): void {
  if (!snapshot) return;
  if (snapshot.atBottom) {
    term.scrollToBottom?.();
    return;
  }
  term.scrollToLine?.(snapshot.viewportY);
}

// The terminal fills to the pane edge. xterm's FitAddon always reserves the
// scrollbar width — `overviewRuler?.width || 14` = 14px — on the right when
// scrollback is on, even though xterm 6's scrollbar is an overlay that needs
// no gutter. Recompute cols reserving 0 so the content reaches the edge (the
// overlay scrollbar floats over the last column when it appears). Mirrors
// FitAddon.proposeDimensions via the same internals, with a fallback to the
// addon if those internals shift (e.g. an xterm upgrade).
function fitFillingScrollbarGutter(
  term: { cols: number; rows: number } & ScrollPreservingTerminal,
  fit: { fit: () => void },
): void {
  const t = term as unknown as {
    element?: HTMLElement;
    resize?: (cols: number, rows: number) => void;
    _core?: {
      _renderService?: {
        dimensions?: { css?: { cell?: { width?: number; height?: number } } };
        clear?: () => void;
      };
    };
  };
  const cell = t._core?._renderService?.dimensions?.css?.cell;
  const parent = t.element?.parentElement;
  if (!cell?.width || !cell?.height || !parent || !t.resize) {
    fit.fit();
    return;
  }
  const ps = getComputedStyle(parent);
  const es = getComputedStyle(t.element!);
  const availH =
    parseInt(ps.getPropertyValue("height")) -
    (parseInt(es.getPropertyValue("padding-top")) +
      parseInt(es.getPropertyValue("padding-bottom")));
  const availW =
    Math.max(0, parseInt(ps.getPropertyValue("width"))) -
    (parseInt(es.getPropertyValue("padding-right")) +
      parseInt(es.getPropertyValue("padding-left")));
  const cols = Math.max(2, Math.floor(availW / cell.width));
  const rows = Math.max(1, Math.floor(availH / cell.height));
  if (Number.isNaN(cols) || Number.isNaN(rows)) {
    fit.fit();
    return;
  }
  if (term.cols !== cols || term.rows !== rows) {
    t._core?._renderService?.clear?.();
    t.resize(cols, rows);
  }
}

export function fitTerminalSurface(
  term: {
    cols: number;
    rows: number;
    refresh: (start: number, end: number) => void;
  } & ScrollPreservingTerminal,
  fit: { fit: () => void },
): void {
  const viewport = captureTerminalViewport(term);
  try {
    fitFillingScrollbarGutter(term, fit);
  } catch {
    /* container not measured yet */
  }
  restoreTerminalViewport(term, viewport);
  if (term.rows > 0) {
    term.refresh(0, term.rows - 1);
  }
}

export function applyTerminalFontSize(
  term: {
    options: { fontSize?: number };
    cols: number;
    rows: number;
    refresh: (start: number, end: number) => void;
  } & ScrollPreservingTerminal,
  fit: { fit: () => void },
  fontSize: number,
): void {
  if (term.options.fontSize === fontSize) return;
  term.options.fontSize = fontSize;
  fitTerminalSurface(term, fit);
}
