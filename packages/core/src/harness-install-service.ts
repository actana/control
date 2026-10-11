// Installing a Harness on this Core, asked for from the Panel (issue 83).
//
// The Panel can see that a CLI is missing — availability is Core-published
// state — but until now it could only say so. This is the other half: the
// `harnessInstall` core-link frame lands here, and this service runs exactly
// what `actana harnesses install <id>` runs (`installAgentsNow`, the
// non-interactive path) and then makes the Core re-probe, so the availability
// event that follows is the operator's answer.
//
// Three properties the frame handler depends on:
//
//   • It never throws. Every failure is a `{ ok: false, message }` written for
//     the operator, because the caller's only other option would be to invent
//     one.
//   • It never blocks the link. The frame is acked before this runs; a vendor
//     installer taking minutes is normal and the Core goes on serving frames.
//   • A second request for a Harness already installing joins the first rather
//     than starting a competing installer over the same files.
//
// Success is deliberately defined as "the probe now finds it", not "the vendor
// installer exited 0": an installer that reports success while leaving nothing
// on this Core's PATH is a failure the operator has to hear about, or the
// Panel's row waits for an availability change that is never coming.

import log from "@actana/shared/log";
import { HARNESS_CLI_CONFIG } from "@actana/shared/harness-cli-config";
import type { Harness } from "@actana/shared/domain";
import type { CoreLinkHarnessAvailabilityMap } from "@actana/sdk/core";
import {
  installAgentsNow,
  resolveHarnessId,
  supportedHarnessIdsSentence,
  type HarnessInstallOutcome,
} from "@actana/shared/actana-harnesses";
import type { ActanaSystem } from "@actana/shared/actana-system-port";
import { isContainerMode } from "./core-identity";
import { isNeedsSetup } from "@actana/shared/harness-needs-setup";

/** What one install ended as. `ok` means the Harness is on this Core now. */
export type HarnessInstallResult = { ok: true } | { ok: false; message: string };

export type HarnessInstallServiceOptions = {
  /** This Core's current availability map — what the probe last found. */
  availability: () => CoreLinkHarnessAvailabilityMap;
  /**
   * Re-probe now, publishing an `agents:availabilityChanged` event if the map
   * moved. The Core's own 60s tick would find a new CLI eventually; an operator
   * watching the row they just clicked would not call that "eventually".
   */
  reprobe: () => void | Promise<void>;
  /** Runs the vendor installer. Same port the CLI's install verb uses. */
  system: ActanaSystem;
  platform: NodeJS.Platform;
  /**
   * The home whose login profile gets the managed PATH block after a successful
   * install. Only used where this daemon is the user that owns that home (metal);
   * in the container it is `core`'s, the daemon is `actana`, and the block is not
   * written at all (see {@link profileHomeDir}).
   */
  homeDir?: string;
  /** Injectable installer for tests. Defaults to {@link installAgentsNow}. */
  runInstall?: (
    agents: readonly Harness[],
    context: {
      availability: CoreLinkHarnessAvailabilityMap;
      platform: NodeJS.Platform;
      system: ActanaSystem;
      homeDir?: string;
      out: (line: string) => void;
    },
  ) => Promise<HarnessInstallOutcome[]>;
};

export class HarnessInstallService {
  private readonly opts: HarnessInstallServiceOptions;
  /** Installs in flight, so a double click is one installer, not two. */
  private readonly inFlight = new Map<Harness, Promise<HarnessInstallResult>>();

  constructor(opts: HarnessInstallServiceOptions) {
    this.opts = opts;
  }

  /**
   * Is `harnessId` something this Core can install? Both the canonical id and
   * the CLI command answer (`resolveHarnessId`'s rule), and a registry-disabled
   * Harness answers no — it is not offerable anywhere else either.
   */
  installable(harnessId: string): boolean {
    return resolveHarnessId(harnessId) !== null;
  }

  /**
   * Install one Harness and report whether it is available afterwards. Resolves
   * only when the vendor installer has finished and the Core has re-probed.
   */
  install(harnessId: string): Promise<HarnessInstallResult> {
    const harness = resolveHarnessId(harnessId);
    if (!harness) {
      return Promise.resolve({
        ok: false,
        message: `Actana does not know how to install \`${harnessId}\`. ${supportedHarnessIdsSentence()}`,
      });
    }
    const existing = this.inFlight.get(harness);
    if (existing) return existing;

    const run = this.runOnce(harness).finally(() => this.inFlight.delete(harness));
    this.inFlight.set(harness, run);
    return run;
  }

  private async runOnce(harness: Harness): Promise<HarnessInstallResult> {
    const config = HARNESS_CLI_CONFIG[harness];
    const run = this.opts.runInstall ?? installAgentsNow;
    let outcome: HarnessInstallOutcome | undefined;
    try {
      const outcomes = await run([harness], {
        availability: this.opts.availability(),
        platform: this.opts.platform,
        system: this.opts.system,
        homeDir: profileHomeDir(this.opts.homeDir),
        out: (line) => log.info("core-harness-install.progress", { harness, line }),
      });
      outcome = outcomes.find((entry) => entry.agent === harness);
    } catch (err) {
      // `installAgentsNow` documents that it never throws, so this is the
      // Core's own machinery failing rather than the vendor's. Still an
      // outcome, still the operator's to read.
      const message = err instanceof Error ? err.message : String(err);
      log.warn("core-harness-install.threw", { harness, error: message });
      return { ok: false, message: `Installing ${config.label} failed: ${message}` };
    }

    // Re-probe before judging: the probe, not the installer's exit code, is what
    // the Panel's row is waiting on, and it is the only honest answer about
    // this machine's PATH.
    try {
      await this.opts.reprobe();
    } catch (err) {
      log.warn("core-harness-install.reprobe-failed", {
        harness,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const after = this.opts.availability()[harness];
    // needs-setup is reported as `missing` with a needs-setup reason, but the CLI
    // is on PATH and the install worked: the first-run dialog is set up in a Session.
    // The same holds when the Core could not start it for its setup check (#700):
    // that is reported on the availability row, not as a failed install.
    if (after?.status === "available" || isNeedsSetup(after)) return { ok: true };
    return { ok: false, message: failureMessage(harness, outcome) };
  }
}

/**
 * The home to write the managed login-PATH block into, or `undefined` for none.
 *
 * Never in the container (#559): the daemon is `actana`, `core`'s home is 0750
 * `core:core`, so the write could only fail, and it did, on every install, with
 * "could not write ~/.profile". It is also not needed there. A Session's PATH is
 * built by `asCore` from the registry's directories, the daemon's own probe asks
 * `core` to look in them, and a login shell gets them from the image's
 * `/etc/profile.d/actana-harness-path.sh`, which is root-owned and written at build.
 * Writing core's dotfiles from the daemon, even through a helper, would be a
 * privileged edit of a file a Session's own login shell runs.
 */
export function profileHomeDir(homeDir: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return isContainerMode(env) ? undefined : homeDir;
}

/**
 * What the operator reads when the Harness is still not available. Written in
 * the register the folder-picker failures use — a sentence about their machine,
 * never a stack trace — and always ending somewhere they can go next.
 */
function failureMessage(harness: Harness, outcome: HarnessInstallOutcome | undefined): string {
  const config = HARNESS_CLI_CONFIG[harness];
  switch (outcome?.status) {
    case "unsupported":
      return `${config.label} has no scripted installer for this Core's platform. Install it from ${config.packageUrl}.`;
    case "installed":
    case "already-installed":
      // The installer is happy and the probe is not. Almost always a CLI that
      // landed somewhere this daemon's PATH does not reach — worth saying so,
      // because "failed" would send the operator looking for the wrong thing.
      return `${config.label} was installed, but \`${config.command}\` is still not on this Core's PATH.`;
    default:
      return `Installing ${config.label} on this Core failed. Install it from ${config.packageUrl}, or run \`actana harnesses install ${harness}\` on that machine.`;
  }
}
