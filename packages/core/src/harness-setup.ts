// The Core sets each Harness up so no first-run dialog can block a Session (#685).
//
// Two steps, run on every availability round (Core start, the install service's
// re-probe, SIGHUP, the periodic tick, and a pairing):
//
//   1. **Pre-trust.** Record trust for the Session workspace in the config of each
//      available Harness that has a writer (`harness-pretrust.ts`). Idempotent and
//      cheap, so a wiped config or a new Harness version is repaired on the next
//      round instead of showing the dialog again.
//   2. **Setup check.** Start each available Harness once in the workspace with no
//      prompt, read what it paints, and match it against the same
//      `BLOCKING_DIALOGS` table prompt delivery uses. A Harness still behind a
//      blocking dialog is reported as needing setup (`harness-needs-setup.ts`)
//      instead of available, so the Panel dispatches no Task into it.
//
// Prompt delivery's folder-trust handling is untouched: this is the first line of
// defence and that stays the last.
//
// A pass is remembered per binary and version, so a healthy Harness is started
// once, not once a minute. A block is never remembered: it is looked at again on
// the next round, which is how a login or a fix made by hand clears it.

import log from "@actana/shared/log";
import type { Harness } from "@actana/shared/domain";
import type { CoreLinkHarnessAvailability, CoreLinkHarnessAvailabilityMap } from "@actana/shared/sdk-link-frames";
import { needsSetupReason } from "@actana/shared/harness-needs-setup";
import { dialogsForHarness, matchBlockingDialog } from "./harness-prompt-delivery";
import { PRETRUST_HARNESSES } from "./harness-pretrust";

/** What it takes to start a Harness once: which one, which binary, where. */
export type SetupRun = { harness: Harness; binary: string; cwd: string };

export type HarnessSetupDeps = {
  /** The directories Sessions start in. Read per round: the home can move between runs. */
  workspaces: () => readonly string[];
  /** Record trust (`pretrustWorkspacesViaCore`). */
  pretrust: (harnesses: readonly string[], dirs: readonly string[]) => Promise<unknown>;
  /**
   * Start the Harness with no prompt and resolve with everything it painted,
   * ANSI intact (the matcher reads highlights from the escapes). Resolves with
   * what there is on a timeout; rejects only when the Harness cannot be started,
   * which is not a dialog and is not reported as one.
   */
  runOnce: (run: SetupRun) => Promise<string>;
};

export class HarnessSetup {
  private readonly passed = new Map<string, string>();

  constructor(private readonly deps: HarnessSetupDeps) {}

  /** `map` with every available-but-blocked Harness turned into its needs-setup entry. */
  async apply(map: CoreLinkHarnessAvailabilityMap): Promise<CoreLinkHarnessAvailabilityMap> {
    const available = Object.entries(map).filter(([, entry]) => entry?.status === "available") as [
      Harness,
      CoreLinkHarnessAvailability,
    ][];
    if (available.length === 0) return map;
    const dirs = this.deps.workspaces();
    if (dirs.length === 0) return map;

    const trustable = available.map(([harness]) => harness).filter((h) => (PRETRUST_HARNESSES as readonly string[]).includes(h));
    if (trustable.length > 0) {
      try {
        await this.deps.pretrust(trustable, dirs);
      } catch (err) {
        log.warn("core-setup.pretrust-failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const next: CoreLinkHarnessAvailabilityMap = { ...map };
    // One at a time: each is a full Harness process, on a VM several Cores share.
    for (const [harness, entry] of available) {
      const key = `${entry.path ?? ""}@${entry.version ?? ""}`;
      if (this.passed.get(harness) === key) continue;
      const dialog = await this.check(harness, entry, dirs[0]!);
      if (dialog === undefined) continue; // could not be started: say nothing new
      if (dialog === null) {
        this.passed.set(harness, key);
        continue;
      }
      this.passed.delete(harness);
      next[harness] = { ...entry, status: "missing", reason: needsSetupReason(dialog) };
    }
    return next;
  }

  /** The id of the blocking dialog on screen, null when there is none, undefined when the run failed. */
  private async check(harness: Harness, entry: CoreLinkHarnessAvailability, cwd: string): Promise<string | null | undefined> {
    let screen: string;
    try {
      screen = await this.deps.runOnce({ harness, binary: entry.path ?? harness, cwd });
    } catch (err) {
      log.warn("core-setup.check-failed", { harness, error: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
    const dialog = matchBlockingDialog(screen, dialogsForHarness(harness));
    if (dialog) log.warn("core-setup.needs-setup", { harness, dialog: dialog.spec.id });
    return dialog ? dialog.spec.id : null;
  }
}
