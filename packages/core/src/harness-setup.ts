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
//      instead of available, so the Panel dispatches no Task into it. A Session can
//      still open on it, which is where the operator finishes the setup.
//
// Prompt delivery's folder-trust handling is untouched: this is the first line of
// defence and that stays the last.
//
// A pass is remembered per binary and version, so a healthy Harness is started
// once, not once a minute. A block is not remembered as a pass: it is looked at
// again, which is how a login or a fix made by hand clears it, but with a backoff
// (a minute, doubling to ten) because each look is a full Harness process on a
// VM several Cores share. A new binary or version is looked at at once.
//
// The backoff can hide a fix made by hand: a login done in a Session leaves the Harness
// showing "needs setup" until its next look, up to ten minutes later. SIGHUP (which calls
// {@link HarnessSetup.forgetBlocks}), a restart of the Core, or a new version of the
// binary looks at once. A check is a Harness process that takes seconds, so a SIGHUP can
// land while one runs; the block that check finds is from before the reset and is not
// remembered (#690, #704), or the next look would sit inside a backoff the reset was
// meant to clear.
//
// A Harness the check cannot start at all (the spawn fails: a binary that is on PATH
// but not executable for `core`, a PTY that cannot be opened, a VM out of processes) is
// not announced available either: nothing is known about its dialogs, and a Session
// would most likely not start on it (#700). It is reported as a failed check
// (`setup-check-failed: <error>`), which the Panel shows as "Could not start", and it is
// looked at again with the same backoff as a block, since a start failure on a shared VM
// can be as transient as a dialog is fixable. The same resets apply: SIGHUP, a Core
// restart, or a new binary or version looks at once.

import log from "@actana/shared/log";
import type { Harness } from "@actana/shared/domain";
import type { CoreLinkHarnessAvailability, CoreLinkHarnessAvailabilityMap } from "@actana/shared/sdk-link-frames";
import { needsSetupReason, setupCheckFailedReason } from "@actana/shared/harness-needs-setup";
import { dialogsForHarness, matchBlockingDialog, type BlockingDialogSpec } from "./harness-prompt-delivery";
import { PRETRUST_HARNESSES } from "./harness-pretrust";

/**
 * Dialogs only the setup check looks for. codex's directory-trust dialog, as
 * codex-cli 0.153.0 paints it (captured live,
 * `fixtures/codex-0.153.0-directory-trust.txt`): "Do you trust the contents of this
 * directory? Working with untrusted contents comes with higher risk of prompt
 * injection. Trusting the directory allows project-local config, hooks, and exec
 * policies to load." over "› 1. Yes, continue" / "2. No, quit".
 *
 * It is not in `BLOCKING_DIALOGS` on purpose: prompt delivery's handling of codex
 * (issue 277, 483) is pinned by tests that wait for the dialog to be answered, and
 * #685 leaves that path as it is. codex positions text with cursor moves, so the
 * stripped screen reads `Doyoutrustthecontents…`; the whitespace is optional for
 * that reason. Wording is from 0.153.0 and has not been re-captured on 0.160.0.
 */
export const SETUP_ONLY_DIALOGS: readonly BlockingDialogSpec[] = [
  {
    id: "directory-trust",
    harnesses: ["codex"],
    match: [/do\s*you\s*trust\s*the\s*contents\s*of\s*this\s*directory/i],
    affirmative: /\b(yes|continue)\b/i,
    refuse: /\b(no|quit|exit|cancel)\b/i,
  },
];

/**
 * Dialogs a Harness's own table has that the setup check must not report, because something other than the dialog
 * table answers them in a real Session. Pi's "Trust project folder?" is answered by the global extension (ADR 0040),
 * which acts only with the hook environment a Session sets (`AC_HOOK_URL`, `AC_HOOK_TOKEN`, `AC_HOOK_SESSION_ID`,
 * `AC_HOOK_HARNESS=pi`, `AC_HOOK_CWD`). The setup run has none of it, so it would see the screen and call Pi blocked
 * when a Session would not be.
 */
const SETUP_SKIPPED_DIALOGS: Partial<Record<Harness, readonly string[]>> = { pi: ["folder-trust"] };

/** First wait before a blocked Harness is started again, doubling per round it is still blocked, up to the cap. */
export const SETUP_RECHECK_BASE_MS = 60_000;
export const SETUP_RECHECK_MAX_MS = 600_000;

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
   * which is reported as a failed check (#700), not as a dialog.
   */
  runOnce: (run: SetupRun) => Promise<string>;
  /** The clock, for the recheck backoff. */
  now?: () => number;
};

export class HarnessSetup {
  private readonly passed = new Map<string, string>();
  /**
   * A Harness found blocked, or not startable: the reason it is reported with meanwhile, and when it is started
   * again (a full process each time).
   */
  private readonly blocked = new Map<Harness, { key: string; reason: string; nextAt: number; delayMs: number }>();
  /** Bumped by every {@link forgetBlocks}: a check that started under an older generation records no block. */
  private generation = 0;

  constructor(private readonly deps: HarnessSetupDeps) {}

  /** Look at every blocked Harness again on the next round, whatever its backoff says (SIGHUP). */
  forgetBlocks(): void {
    this.blocked.clear();
    this.generation += 1;
  }

  /** `map` with every available Harness the check did not clear turned into its needs-setup entry. */
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
      const now = (this.deps.now ?? Date.now)();
      const before = this.blocked.get(harness);
      // Still inside the backoff for the same binary and version: say what it showed last time, start nothing.
      if (before && before.key === key && now < before.nextAt) {
        next[harness] = { ...entry, status: "missing", reason: before.reason };
        continue;
      }
      const generation = this.generation;
      const reason = await this.check(harness, entry, dirs[0]!);
      if (reason === null) {
        this.passed.set(harness, key);
        this.blocked.delete(harness);
        continue;
      }
      this.passed.delete(harness);
      next[harness] = { ...entry, status: "missing", reason };
      // forgetBlocks ran while this check did: what it saw is from before the reset. Report it for this round,
      // since the dialog was on screen (or the start failed), but remember no block, so the next round looks again at once.
      if (generation !== this.generation) continue;
      const delayMs = before && before.key === key ? Math.min(before.delayMs * 2, SETUP_RECHECK_MAX_MS) : SETUP_RECHECK_BASE_MS;
      this.blocked.set(harness, { key, reason, nextAt: now + delayMs, delayMs });
    }
    return next;
  }

  /**
   * The needs-setup reason for the Harness: the blocking dialog on screen, or the error when it could not be
   * started (#700). Null when it reached its composer.
   */
  private async check(harness: Harness, entry: CoreLinkHarnessAvailability, cwd: string): Promise<string | null> {
    let screen: string;
    try {
      screen = await this.deps.runOnce({ harness, binary: entry.path ?? harness, cwd });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("core-setup.check-failed", { harness, error });
      return setupCheckFailedReason(error);
    }
    const dialog = matchBlockingDialog(screen, [
      ...dialogsForHarness(harness).filter((spec) => !SETUP_SKIPPED_DIALOGS[harness]?.includes(spec.id)),
      ...SETUP_ONLY_DIALOGS.filter((spec) => spec.harnesses?.includes(harness)),
    ]);
    if (dialog) log.warn("core-setup.needs-setup", { harness, dialog: dialog.spec.id });
    return dialog ? needsSetupReason(dialog.spec.id) : null;
  }
}
