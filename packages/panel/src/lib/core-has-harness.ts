import { HARNESS_REGISTRY } from "@actana/shared/harnesses";
import type { Harness } from "@actana/shared/domain";
import { availabilityFor, type CliAvailabilityMap } from "~/lib/cli-availability";

/**
 * Whether this Core already has the harness CLI (issue 560): New Session lists
 * only these. Missing CLIs are installed from Settings › Providers instead.
 */
export function coreHasHarness(availability: CliAvailabilityMap, agent: Harness): boolean {
  if (HARNESS_REGISTRY[agent].disabled) return false;
  const status = availabilityFor(availability, agent).status;
  // available / outdated: the binary is on the Core. checking: still probing —
  // keep the row so the picker does not flicker empty while availability loads.
  // unknown (no entry after a snapshot): the Core did not report it — not has.
  return status === "available" || status === "outdated" || status === "checking";
}
