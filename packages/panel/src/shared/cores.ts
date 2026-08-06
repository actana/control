// The Panel's Core registry, as the browser sees it.
//
// A Core is the Panel's handle for "this Core I can talk to": an endpoint,
// an alias, and a replay cursor. Everything else about a Core — its projects,
// tasks, sessions, events — lives on the Core and is read over the
// core-link. The registry is the only Core state the Panel persists.
//
// The secret half of a registration (CA, client cert/key, bearer) never
// appears in these types: it is sealed at rest and read only by the service's
// dialer. Nothing here crosses the wire that a stolen response would make
// useful.

/** A registered Core, plaintext fields only. */
export type Core = {
  /** Stable Panel-side handle, `core_<hex>`. Not a secret. */
  id: string;
  /** `wss://host:port` — the Core's core-link endpoint (mTLS, ADR 0002). */
  endpoint: string;
  /** Human-friendly alias shown in the UI ("mac-mini", "prod-vm-1"). */
  label: string;
  /**
   * The highest Event id the Panel has seen from this Core. Owned by the Panel
   * *service*, not a browser: the service dials whether or not a tab is open,
   * so the cursor has to advance in the same place (CONTEXT.md "Event cursor").
   */
  lastEventId: number;
  createdAt: number;
  updatedAt: number;
};

/**
 * Where a Core's link stands right now.
 *
 * - `connecting` — dialing, or backing off between attempts.
 * - `connected` — mTLS handshake and bearer both accepted; frames flow.
 * - `unreachable` — the socket is down. `lastSeenAt` says how stale that is.
 * - `auth-error` — the Core rejected the bearer. Reconnecting won't fix it;
 *   the operator has to re-pair.
 * - `needs-update` — the link is up, but the Core speaks a core-link
 *   protocol this Panel does not. There is no degraded mode (ADR 0005): the
 *   Core's data paths are suppressed and the operator is handed the command
 *   that fixes it. It clears itself when the updated Core reconnects.
 */
export type CoreDialState =
  | "connecting"
  | "connected"
  | "unreachable"
  | "auth-error"
  | "needs-update";

export type CoreDialStatus = {
  coreId: string;
  state: CoreDialState;
  /** Epoch ms of the last successful authentication; null if never reached. */
  lastSeenAt: number | null;
  /** Why we're unreachable / which auth failure. Operator-facing, never a secret. */
  detail?: string;
  /** On `needs-update`: the protocol version the Core advertised, if any. */
  coreVersion?: string | null;
  /** On `needs-update`: the protocol version this Panel speaks. */
  panelVersion?: string;
};

/**
 * The command that brings a Core up to date — the same one-liner that installed
 * it. Re-running it on that machine upgrades the Core in place, keeping the
 * pairing (INSTALL.md, "Re-running the one-liner … upgrades it in place"), so
 * "needs update" is one paste on the Core rather than a re-pair in the Panel.
 *
 * The `actana` bundle will eventually own this as an `update` verb (CONTEXT.md);
 * until that verb exists, the installer *is* the update path and this is the
 * only command that actually works.
 */
export const CORE_UPDATE_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/actana/control/main/install.sh | bash";

/**
 * The command that brings a Panel up to date.
 *
 * There is only one, because the Panel ships one way: a container image
 * (ADR 0010). It runs on the host beside `deploy/docker-compose.yml`, never
 * inside the Panel — pulling and recreating the container is the operator's
 * gesture, and a service that could do it to itself would be the in-app updater
 * this project deliberately does not have.
 */
export const PANEL_UPDATE_COMMAND = "docker compose pull && docker compose up -d";

/**
 * Which side of a version mismatch is behind.
 *
 * A gate that always says "update the Core" is wrong half the time: a Panel
 * that has not been upgraded while its fleet has is drift in the other
 * direction, and pasting the Core installer on a machine that is already
 * ahead fixes nothing. Both sides read as `needs-update` — there is still no
 * degraded mode — but the remedy named is the one that closes the gap.
 *
 * An unparseable or absent Core version means an older Core (versions have
 * been in the `ready` frame from the start), so it reads as the Core being
 * behind.
 */
export function coreDriftDirection(dial: {
  coreVersion?: string | null;
  panelVersion?: string;
}): "core-behind" | "panel-behind" {
  const core = parseMinor(dial.coreVersion);
  const panel = parseMinor(dial.panelVersion);
  if (!core || !panel) return "core-behind";
  if (core.major !== panel.major) return core.major > panel.major ? "panel-behind" : "core-behind";
  return core.minor > panel.minor ? "panel-behind" : "core-behind";
}

function parseMinor(version: string | null | undefined): { major: number; minor: number } | null {
  if (typeof version !== "string") return null;
  const m = /^(\d+)\.(\d+)\.\d+$/.exec(version.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** A registry row plus its live link state — one row of the Cores list. */
export type CoreWithDial = Core & { dial: CoreDialStatus };

export type CoreListResponse = { cores: CoreWithDial[] };

/** Sort order for Core lists: by label, stable, so a refresh doesn't reshuffle. */
export function coreOrder(a: Core, b: Core): number {
  return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
}
