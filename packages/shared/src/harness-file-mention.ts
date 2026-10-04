import type { Harness } from "./domain";

/**
 * How a prompt points a harness at a file, per harness, in ONE table (next to `HARNESS_REGISTRY`).
 *
 * `"at"` writes the harness's own mention, `@PATH`, so the harness attaches the file itself; the plain path
 * follows in the same sentence as a fallback (`@PATH (file PATH)`), so a harness that leaves `@PATH` as text
 * still has a path to open. `"plain"` writes the path only.
 *
 * Typing `@` opens a file-picker popup in every one of these TUIs, and a popup that is still open when the Core
 * presses Enter can take the Enter or rewrite the text, which is the lost delivery the prompt file exists to
 * avoid. So `"at"` is allowed only where the form is known to attach the file AND to be safe to type. Nothing
 * below has both, so every harness is `"plain"` today; the reasons are what was found, and the table is where
 * a harness moves to `"at"` once a capture shows it safe. None of this was run live: it is from each
 * harness's docs and issue tracker, and from the prompt-delivery fixtures (which hold no `@`).
 */
export type FileMentionForm = "at" | "plain";

export type FileMentionEntry = { form: FileMentionForm; reason: string };

export const HARNESS_FILE_MENTION: Record<Harness, FileMentionEntry> = {
  "claude-code": {
    form: "plain",
    reason:
      "`@` attaches the file when the prompt is submitted, but the suggester stays open after a space for home-relative and " +
      "absolute forms (`@~/`, `@/`, `@./`, claude-code 2.1.185 to 2.1.233) and Enter then rewrites the last word instead " +
      "of submitting. The Shared folder is only reachable as `~/shared/…`, which is exactly the affected form.",
  },
  codex: {
    form: "plain",
    reason:
      "`@` opens a fuzzy file search over the workspace root, and Tab or Enter replaces the `@` with the chosen path: " +
      "it inserts a path, it attaches nothing, so there is no gain, and the popup can take the Enter. The Shared folder " +
      "is outside the workspace root anyway.",
  },
  "cursor-cli": {
    form: "plain",
    reason:
      "`@` attaches files from the workspace through a suggestion popup. Whether a path outside the workspace " +
      "(`~/shared/…`) resolves, and whether the popup can capture the Enter, is not documented and not captured.",
  },
  opencode: {
    form: "plain",
    reason:
      "`@` does a fuzzy search of the current directory and attaches the chosen file; a typed path that was not picked " +
      "from the popup is not known to attach, the Shared folder is outside the directory, and the popup can take the Enter " +
      "(its composer already needed `textHidesComposerMarker` for a similar reason).",
  },
  pi: {
    form: "plain",
    reason:
      "`@` fuzzy-searches project files (built on `fd`); whether it attaches content or only inserts a path, and how it " +
      "treats a pasted `@path` or a path outside the project, is not documented. Pi 1.0.2 repaints only the editor rows " +
      "that change, so a popup is hard to see in a capture.",
  },
};

/** A file named the way this harness takes it, for use inside a sentence. `path` is the one the agent opens. */
export function fileReference(harness: Harness, path: string): string {
  return HARNESS_FILE_MENTION[harness].form === "at" ? `@${path} (file ${path})` : path;
}
