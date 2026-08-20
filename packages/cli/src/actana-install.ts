// `actana install` — the CLI puts a Core on this machine (#288 D8).
//
// **This is a new capability, not a rename.** Until 0.4.0 `actana setup`
// downloaded nothing: it ran from an already-extracted tarball, and
// `install.sh` did the resolve, the download, the SHA-256 verification and the
// extraction before handing over. That is why `setup`'s own header says
// *turning the extracted tarball into a running, pairable Core* — it starts
// where the shell script stops.
//
// A CLI that arrives by `npm i -g @actana/cli` has no tarball around it, so it
// does that half itself: resolve the release, download it, check it against the
// release's published `SHA256SUMS`, unpack it, and then do exactly what `setup`
// does today. **The direction that matters: a Core always comes with a CLI, and
// a CLI may exist without a Core and be able to install one.**
//
// The ordering property comes with it, unchanged, because the fetch half is
// `actana-fetch-release.ts` and it writes only into a temporary directory:
// **a failed install leaves nothing installed.** A wrong checksum aborts before
// a single byte has been written under `~/.local/share/actana`.
//
// `install.sh` survives untouched and is still the door a bare machine comes
// through: it has no Node, and the tarball carries its own pinned one, so the
// script cannot be replaced by the CLI it installs. Two doors, one
// implementation of the real work.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fetchVerifiedRelease } from "./actana-fetch-release.ts";
import {
  releaseTargetFor,
  resolveReleaseVersion,
  type ReleaseChannel,
  type ReleaseFetcher,
} from "./actana-release.ts";
import { runActanaSetup, type SetupOptions, type SetupResult } from "./actana-setup.ts";
import type { ActanaSystem } from "./actana-system.ts";

/**
 * Everything `setup` needs except the two things only a download can answer:
 * which tree to install from, and what that tree's manifest says.
 */
export type InstallOptions = Omit<SetupOptions, "sourceRoot" | "manifest"> & {
  fetcher: ReleaseFetcher;
  channel: ReleaseChannel;
  /** The version the operator pinned; the latest release when absent. */
  requestedVersion?: string;
  system: ActanaSystem;
};

/** Fetch a release, verify it, and run setup against the tree it unpacked. */
export async function runActanaInstall(opts: InstallOptions): Promise<SetupResult> {
  // The same refusal `actana update` and `install.sh`'s `detect_target` give,
  // at the same point and for the same reason: an Intel Mac has no on-device
  // build and never will, and answering `mac-x64` here would turn a decision
  // into a "release has no build for" two steps later.
  const target = releaseTargetFor(opts.platform, opts.arch);
  if (!target) {
    throw new Error(
      opts.platform === "darwin" && opts.arch === "x64"
        ? "there is no Core build for an Intel Mac — the on-device install is Apple silicon " +
          "only. Run your Core from the container image instead."
        : `there is no Core build for ${opts.platform}/${opts.arch} — Cores run on Linux ` +
          "(WSL counts as Linux) at x64 and arm64, and on Apple-silicon macOS.",
    );
  }

  const version = await resolveReleaseVersion(opts.fetcher, opts.channel, opts.requestedVersion);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-install-work-"));
  try {
    const { root, manifest } = await fetchVerifiedRelease(
      // There is no Core here yet, so nothing can be "still running the version
      // it was" — the honest promise on a failed first install is that the
      // machine is exactly as it was found.
      { ...opts, noChange: "Nothing was installed. Retry the install" },
      version,
      target,
      workDir,
    );
    // Only now does anything outside `workDir` get written. Everything above
    // this line is reversible by deleting one temporary directory, which the
    // `finally` does whether this succeeded or threw.
    return await runActanaSetup({ ...opts, sourceRoot: root, manifest });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
