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
import { pathLookupCandidates } from "@actana/shared/harness-cli-config";
import { availabilityFromCandidates } from "@actana/shared/harness-availability-store";
import { sanitizedProcessEnv } from "@actana/shared/shell-env";
import type { CoreLinkHarnessAvailability } from "@actana/shared/sdk-link-frames";
import { isContainerMode } from "./core-identity";
import { resolveCommandViaCore, type CoreHomeOpsOptions } from "./core-home-ops-client";

export function coreAvailabilityProbe(
  options: CoreHomeOpsOptions = {},
  /** The env whose PATH is searched. Tests pass one; the daemon's is what a Session gets. */
  searchEnv: () => NodeJS.ProcessEnv = sanitizedProcessEnv,
): ((agent: Harness) => Promise<CoreLinkHarnessAvailability>) | undefined {
  if (!isContainerMode(options.identityEnv)) return undefined;
  return async (agent) => {
    const command = HARNESS_REGISTRY[agent].command;
    // The PATH `core` searches is the one a Session gets: core's Harness
    // directories first (`coreChildEnv`), then the system's.
    const env = searchEnv();
    const candidates: string[] = [];
    for (const name of pathLookupCandidates(command)) {
      for (const found of await resolveCommandViaCore(name, env.PATH ?? null, options)) {
        if (!candidates.includes(found)) candidates.push(found);
      }
    }
    return availabilityFromCandidates(agent, candidates, env);
  };
}
