// The Harness availability probe for a Core whose daemon is not the Session user.
//
// `HarnessAvailabilityStore`'s default probe looks the CLIs up on PATH from the
// daemon's own process. In the container the daemon is `actana` and the CLIs live
// in `core`'s home, which is 0750 `core:core`: every `stat` there fails with
// EACCES, so the probe found nothing and a Harness that had installed fine was
// reported "still not on this Core's PATH" (#559). The spawn path has asked `core`
// to do the lookup since PR 3 (`pty-manager`); this is the same question asked by
// the probe, so the two cannot disagree about what is installed.
//
// Outside the container there is one user, the default in-process probe is right,
// and this returns `undefined` so nothing about a metal install changes.

import type { Harness } from "@actana/shared/domain";
import { HARNESS_REGISTRY } from "@actana/shared/harnesses";
import { availabilityFromProbe } from "@actana/shared/harness-availability-store";
import { sanitizedProcessEnv } from "@actana/shared/shell-env";
import type { CoreLinkHarnessAvailability } from "@actana/shared/sdk-link-frames";
import { isContainerMode } from "./core-identity";
import { probeHarnessCliViaCore, type CoreHomeOpsOptions } from "./core-home-ops-client";

export function coreAvailabilityProbe(
  options: CoreHomeOpsOptions = {},
  /** The env whose PATH is searched. Tests pass one; the daemon's is what a Session gets. */
  searchEnv: () => NodeJS.ProcessEnv = sanitizedProcessEnv,
): ((agent: Harness) => Promise<CoreLinkHarnessAvailability>) | undefined {
  if (!isContainerMode(options.identityEnv)) return undefined;
  return async (agent) => {
    // One request: `core` finds the CLI on the PATH a Session gets (core's Harness
    // directories first, `coreChildEnv`) and runs its `--version`. The daemon runs
    // no file out of core's home itself: that wait cannot be bounded from here
    // (see `probeHarnessCliViaCore`), and this probe runs on a timer.
    const answer = await probeHarnessCliViaCore(HARNESS_REGISTRY[agent].command, searchEnv().PATH ?? null, options);
    // The answer is core's, and core runs what a Session wrote: take paths and the
    // check's verdict from it and nothing it can phrase (`availabilityFromProbe`).
    const candidates = answer.candidates.filter((entry) => typeof entry === "string" && entry.length > 0);
    const meeting = answer.meeting;
    const binary = meeting && candidates.includes(meeting.binary) ? meeting.binary : null;
    return availabilityFromProbe(
      agent,
      candidates,
      meeting && binary
        ? {
            binary,
            check: {
              ok: meeting.check?.ok === true,
              version: typeof (meeting.check as { version?: unknown })?.version === "string" ? (meeting.check as { version: string }).version : null,
              reason: (meeting.check as { reason?: string })?.reason,
            },
          }
        : null,
    );
  };
}
