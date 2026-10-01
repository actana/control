export const PROJECT_PATH_DRAG_MIME = "application/x-mission-control-project-path";

/** Letters, digits, and a small set of path punctuation that needs no shell quoting. */
const PATH_SAFE = /^[A-Za-z0-9/._\-+,:@]+$/;
/** Control bytes and newlines are PTY keystrokes; never paste them. */
const PATH_HAS_CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Quote a filesystem path for paste into a Unix PTY shell.
 * Returns null when the path contains control characters (refuse: write nothing).
 */
export function formatPathForTerminalPaste(path: string): string | null {
  if (PATH_HAS_CONTROL.test(path)) return null;
  if (PATH_SAFE.test(path)) return path;
  // POSIX single-quote: close, escaped quote, reopen — `'\''`
  return `'${path.replace(/'/g, "'\\''")}'`;
}

export function setProjectPathDragData(
  dataTransfer: DataTransfer,
  path: string,
  effectAllowed: DataTransfer["effectAllowed"] = "copy",
): void {
  dataTransfer.setData(PROJECT_PATH_DRAG_MIME, path);
  dataTransfer.setData("text/plain", path);
  dataTransfer.effectAllowed = effectAllowed;
}

export function isProjectPathDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(PROJECT_PATH_DRAG_MIME) ?? false;
}

export function readProjectPathFromDragEvent(event: DragEvent): string | null {
  const raw =
    event.dataTransfer?.getData(PROJECT_PATH_DRAG_MIME) ||
    event.dataTransfer?.getData("text/plain");
  if (!raw) return null;
  const path = raw.trim();
  return path.length > 0 ? path : null;
}
