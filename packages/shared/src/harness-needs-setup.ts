// How a Harness that is installed but blocked by a first-run dialog is reported (#685).
//
// The availability map's status union belongs to the published SDK and has no
// "needs setup", so the Core says it inside the vocabulary the map already has:
// `status: "missing"` (which no Panel launches into) and a `reason` that starts
// with {@link NEEDS_SETUP_PREFIX} and names the dialog. The Panel reads the reason
// back with {@link needsSetupDialog} and shows "Needs setup: <dialog>".

export const NEEDS_SETUP_PREFIX = "needs-setup:";

/** The `reason` for a Harness stopped by the dialog `dialogId`. */
export function needsSetupReason(dialogId: string): string {
  return `${NEEDS_SETUP_PREFIX} ${dialogId}`;
}

/** The dialog a `reason` names, or null when the reason is not a needs-setup one. */
export function needsSetupDialog(reason: string | undefined | null): string | null {
  if (typeof reason !== "string" || !reason.startsWith(NEEDS_SETUP_PREFIX)) return null;
  return reason.slice(NEEDS_SETUP_PREFIX.length).trim() || "unknown dialog";
}
