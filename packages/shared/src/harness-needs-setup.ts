// How a Harness that is installed but not cleared by the setup check is reported (#685, #700).
//
// The availability map's status union belongs to the published SDK and has no
// "needs setup", so the Core says it inside the vocabulary the map already has:
// `status: "missing"` (the Panel turns it into its own needs-setup status, which a
// Session can open on, though Agents and Tasks stay available-only) and a `reason`
// that says why. Two reasons exist:
//
//   - {@link NEEDS_SETUP_PREFIX} and the dialog's id: the Harness started and stopped
//     at a first-run dialog. The Panel reads it back with {@link needsSetupDialog}
//     and shows "Needs setup: <dialog>".
//   - {@link SETUP_CHECK_FAILED_PREFIX} and the error: the Core could not start the
//     Harness at all for its check (#700), so nothing is known about its dialogs and
//     it is not announced available. The Panel reads it back with
//     {@link setupCheckFailure} and shows "Could not start: <error>".
//
// Both are "installed, not ready": {@link isNeedsSetup} is true for either, which is
// what the installer (no reinstall), the install service (the install worked) and
// the Panel (a Session may open on it) ask.

export const NEEDS_SETUP_PREFIX = "needs-setup:";
export const SETUP_CHECK_FAILED_PREFIX = "setup-check-failed:";

/** The longest error a check-failed reason carries: it travels in every availability event. */
export const SETUP_CHECK_FAILED_MAX_CHARS = 200;

/** The `reason` for a Harness stopped by the dialog `dialogId`. */
export function needsSetupReason(dialogId: string): string {
  return `${NEEDS_SETUP_PREFIX} ${dialogId}`;
}

/** The `reason` for a Harness the setup check could not start: the error's first line, capped. */
export function setupCheckFailedReason(error: string): string {
  const line = (error.split(/\r?\n/, 1)[0] ?? "").trim() || "unknown error";
  const capped = line.length > SETUP_CHECK_FAILED_MAX_CHARS ? `${line.slice(0, SETUP_CHECK_FAILED_MAX_CHARS - 1)}…` : line;
  return `${SETUP_CHECK_FAILED_PREFIX} ${capped}`;
}

/** The dialog a `reason` names, or null when the reason is not a needs-setup one. */
export function needsSetupDialog(reason: string | undefined | null): string | null {
  if (typeof reason !== "string" || !reason.startsWith(NEEDS_SETUP_PREFIX)) return null;
  return reason.slice(NEEDS_SETUP_PREFIX.length).trim() || "unknown dialog";
}

/** The error a `reason` carries, or null when the reason is not a failed setup check. */
export function setupCheckFailure(reason: string | undefined | null): string | null {
  if (typeof reason !== "string" || !reason.startsWith(SETUP_CHECK_FAILED_PREFIX)) return null;
  return reason.slice(SETUP_CHECK_FAILED_PREFIX.length).trim() || "unknown error";
}

/**
 * True for an availability entry the Core reported as installed but not cleared by the
 * setup check: stopped at a first-run dialog, or not startable for the check at all.
 */
export function isNeedsSetup(entry: { status: string; reason?: string | null } | undefined | null): boolean {
  return entry?.status === "missing" && (needsSetupDialog(entry.reason) !== null || setupCheckFailure(entry.reason) !== null);
}
