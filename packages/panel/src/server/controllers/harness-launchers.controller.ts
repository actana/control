import type { Harness } from "@actana/shared/domain";
import { MANAGED_HARNESSES } from "@actana/shared/harness-cli-config";
import { readHarnessAccounts } from "../services/harness-accounts";
import { getHarnessLatestVersions } from "../services/harness-latest-versions";
import { json } from "./_helpers";

/** GET /api/harness-launchers/accounts — local sign-in status per managed Harness. */
export function accounts(): Response {
  return json({ accounts: readHarnessAccounts() });
}

/**
 * GET /api/harness-launchers/latest-versions — latest published CLI versions.
 * Optional `?agents=claude-code,codex` filters; `?refresh=1` bypasses the cache.
 */
export async function latestVersions(url: URL): Promise<Response> {
  const raw = url.searchParams.get("harnesses");
  const requested = raw
    ? new Set(
        raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;
  const agents: readonly Harness[] = requested
    ? MANAGED_HARNESSES.filter((agent) => requested.has(agent))
    : MANAGED_HARNESSES;
  const refresh = url.searchParams.get("refresh") === "1";
  return json({ versions: await getHarnessLatestVersions(agents, { refresh }) });
}
