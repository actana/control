import type { CSSProperties } from "react";

// The three containers of the shell's workspace area. Desktop keeps the fixed,
// clipped layout the app has always had (pages scroll inside their own boxes);
// compact (phone and tablet) lets the document grow so the page scrolls as a whole.

export type ShellLayoutMode = "desktop" | "compact";

export type ShellLayoutOptions = {
  workspaceRoute: boolean;
  sessionExpanded: boolean;
  gridActive: boolean;
};

export type ShellLayout = {
  workspace: CSSProperties;
  row: CSSProperties;
  outlet: CSSProperties;
};

export function shellLayout(mode: ShellLayoutMode, o: ShellLayoutOptions): ShellLayout {
  const display = o.sessionExpanded && !o.gridActive ? "none" : "flex";
  if (mode === "compact") {
    return {
      workspace: { flex: "1 0 auto", display: "flex", flexDirection: "column", minWidth: 0 },
      row: { flex: "1 0 auto", display: "flex", flexDirection: "column", minWidth: 0 },
      outlet: {
        position: "relative",
        flex: "1 0 auto",
        display,
        flexDirection: "column",
        minWidth: 0,
      },
    };
  }
  return {
    workspace: {
      flex: 1,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      minHeight: 0,
    },
    row: { flex: 1, display: "flex", overflow: "hidden", minHeight: 0 },
    outlet: {
      position: "relative",
      flex: 1,
      // Grid view lives inside the Outlet, so the expanded-terminal
      // flag must never hide it — both can be true at once (the
      // expand flag persists per Core, the grid flag globally).
      display,
      flexDirection: "column",
      overflow: "hidden",
      // On the Core workspace the terminal panel sits to the
      // right; floor the left panel so dragging the terminal wider
      // shrinks the terminal instead of wrapping the session columns.
      // In grid view the panel is hidden, so let the Outlet go full width.
      minWidth: o.workspaceRoute && !o.gridActive ? 640 : 0,
      minHeight: 0,
    },
  };
}

export type WorkspaceInsets = { top: number; left: number; right: number; bottom: number };

// Insets for the Settings/Usage overlays, which sit `position: fixed` over the
// workspace. On desktop the workspace is a fixed box, so its rect is the inset.
// On compact the workspace grows with the page (rect.bottom is the content
// height), so there are no insets: null means "overlays cover the screen".
export function workspaceInsets(
  mode: ShellLayoutMode,
  rect: { top: number; left: number; right: number; bottom: number },
  viewport: { width: number; height: number },
): WorkspaceInsets | null {
  if (mode === "compact") return null;
  return {
    top: rect.top,
    left: rect.left,
    right: viewport.width - rect.right,
    bottom: viewport.height - rect.bottom,
  };
}
