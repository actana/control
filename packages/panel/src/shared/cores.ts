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
  /**
   * The `files` capability this Core announced on its last `ready` frame (#129
   * F9), or null for a Core that announced none.
   *
   * It rides the dial status rather than the registry row because it is a fact
   * about the *current connection*, exactly like `coreVersion`: a Core can be
   * downgraded, and a remembered answer would leave a browser drawing a Files
   * view whose every request 404s. The service is the one holding the link, so
   * the service is the one that learns it, and every tab already folds each
   * dial push into its row (`useCores`) — so an upgraded Core grows the
   * affordance and a downgraded one loses it without a reload.
   *
   * Absent and null read the same and both mean *no file surface*, which is
   * every Core that shipped before #165. That is a supported state and **not**
   * `needs-update` (ADR 0024 D11): the UI withholds the view rather than
   * showing a broken one.
   */
  files?: { version: 1 } | null;
};

/**
 * The command that brings a Core up to date: `actana update`, run on that
 * machine. It resolves the latest release, verifies it against the release's
 * own `SHA256SUMS`, swaps `current` onto the new tree and **restarts the
 * daemon**, leaving the pairing material and the data dir untouched — so
 * "needs update" is one paste on the Core rather than a re-pair in the Panel.
 *
 * **This was the installer one-liner, and it stopped working as one** (#316).
 * `install.sh` installs and no longer activates (ADR 0036 C2): pasting it
 * downloads the bundle, writes a new `versions/<v>`, repoints `current` and
 * exits. The daemon keeps executing the version it started on, so the Core
 * still announces the old protocol, the Panel still says "needs update", and
 * the button never fixes anything. The one-liner plus `actana setup` would
 * close the gap, but it is the wrong gesture for a machine that already has a
 * Core: setup is what *activates* a machine, and this one is already active.
 *
 * The verb this docstring used to say did not exist yet does now
 * (`packages/cli/src/actana-update.ts`), and it is the only one of the three
 * that both lands the new tree and leaves the daemon running on it.
 *
 * A Core running as a container refuses `actana update` and names
 * `docker compose pull && docker compose up -d` instead, which is the right
 * answer there and is more than the one-liner ever gave that operator.
 */
export const CORE_UPDATE_COMMAND = "actana update";

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
