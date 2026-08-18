import { isValidTcpPort } from "./tcp-port";

export type PtyHookEnv = {
  apiUrl: string;
  token: string;
  /**
   * Where a hook records a POST the Core never acked (issue 243). Optional: a
   * host that wires no miss log still installs working hooks, and the command
   * they run falls back to `/dev/null` rather than failing.
   */
  missLogPath?: string;
};

/** Hostname a Core uses to reach its own loopback Actana Control API. */
export const LOCAL_HOOK_API_HOST = "127.0.0.1";

/** Hostname agent hooks POST to — the agent's own loopback HTTP server. */
export const HARNESS_LOCAL_HOOK_API_HOST = LOCAL_HOOK_API_HOST;

const ALLOWED_HOOK_HOSTS = new Set<string>([LOCAL_HOOK_API_HOST]);

/**
 * Build the Actana Control API base URL an agent's hooks should POST to
 * (loopback only — hooks never leave the host machine).
 */
export function buildMissionControlApiUrl(
  host: string,
  port: number | null | undefined,
): string | null {
  if (!ALLOWED_HOOK_HOSTS.has(host)) return null;
  if (!isValidTcpPort(port)) return null;
  return `http://${host}:${port}`;
}

/** Host-side loopback API URL, as seen from the Core itself. */
export function buildLocalMissionControlApiUrl(port: number | null | undefined): string | null {
  return buildMissionControlApiUrl(LOCAL_HOOK_API_HOST, port);
}

/** Loopback URL for the agent's own hook HTTP endpoint. */
export function buildHarnessLocalHookApiUrl(port: number | null | undefined): string | null {
  return buildMissionControlApiUrl(HARNESS_LOCAL_HOOK_API_HOST, port);
}

export function hookEndpointSlug(agent: string | undefined): string {
  if (agent === "codex") return "codex";
  if (agent === "cursor-cli") return "cursor";
  if (agent === "opencode") return "opencode";
  return "claude";
}

export function buildSyntheticHookUrl(
  mcEnv: PtyHookEnv,
  agent: string | undefined,
  taskId: string,
): string | null {
  let base: URL;
  try {
    base = new URL(mcEnv.apiUrl);
  } catch {
    return null;
  }

  if (base.protocol !== "http:" || !ALLOWED_HOOK_HOSTS.has(base.hostname) || !base.port) {
    return null;
  }

  const url = new URL(`/api/hooks/${hookEndpointSlug(agent)}`, base);
  url.searchParams.set("taskId", taskId);
  return url.toString();
}
