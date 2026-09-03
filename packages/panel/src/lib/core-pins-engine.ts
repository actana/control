import { api } from "~/lib/api";
import { getPanelBridge } from "~/lib/panel-bridge";
import {
  FLEET_POLL_MS,
  TASK_EVENT_KINDS,
  createCoalescingRunner,
  sameSnapshot,
} from "~/lib/fleet-refresh";
import { isProjectListEventKind } from "~/lib/subscribe-core-project-events";
import { corePinTaskCounts } from "~/shared/core-pin-counts";
import {
  projectPresentationById,
  projectRowFromSnapshot,
  type ProjectTaskCounts,
  type ProjectWithCounts,
} from "~/shared/projects";
import type { CoreWithDial } from "~/shared/cores";
import type { ProjectPresentation } from "~/db/schema";

/**
 * The rail's pinned projects across the fleet — one engine for the whole tab.
 *
 * `useRemotePinnedProjects` is mounted more than once on every route (the shell
 * for its rail chords, `ProjectBar` for the tiles it draws, and a third time on
 * Fleet), and each mount used to run its own per-Core `listProjects` fan-out.
 * Deriving the activity dots (#377) means also reading each Core's tasks, and
 * doing that per mount would have turned one event into two or three fan-outs
 * per Core — the cost PR #456's reviewer called out for whoever owned the dot.
 *
 * So the fan-out moved here: module state, refcounted by its subscribers, with
 * one set of Core watches, one event subscription and one poll no matter how
 * many rails are on screen. Every mount reads the same snapshot through
 * `useSyncExternalStore`, so the reads no longer scale with the mounts —
 * they scale with the Cores, which is the number that should decide them.
 *
 * What this costs: on the Fleet route, `useFleetTasks` still runs its own task
 * fan-out for the grid, so a task event there is two `tasksList` frames per
 * Core (grid and rail) rather than one. Folding the grid onto this engine as
 * well is the obvious next step and is deliberately not done here — that hook
 * is #389's, its coalescing loop is what this shares, and its tests pin exact
 * read counts. What this saves in return, on every route: the per-mount
 * `listProjects` fan-out, which was already 2-3 reads per Core and is now one.
 *
 * Nothing here is a second status authority. A pin's counts are derived from
 * the Core's own `tasksList` answer at the moment it lands, and the only thing
 * remembered between passes is the last answer each Core gave — for the one
 * case where forgetting it would be a lie (see {@link corePinTaskCounts}).
 */

/**
 * What every subscriber renders. Identity is stable while nothing changes, so
 * it can be handed straight to `useSyncExternalStore`.
 */
const EMPTY: ProjectWithCounts[] = [];

const listeners = new Set<() => void>();
let snapshot: ProjectWithCounts[] = EMPTY;
let cores: CoreWithDial[] = [];
let coreSignature = "";
/** The last rows each Core answered with, so an unreachable one keeps its pins. */
let lastRowsByCore = new Map<string, ProjectWithCounts[]>();
/** The last counts each Core answered with, by project id. See `corePinTaskCounts`. */
let lastCountsByCore = new Map<string, Map<string, ProjectTaskCounts>>();
let teardown: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function publish(next: ProjectWithCounts[]): void {
  // Keep the previous object when the pass settled on the same answer: this
  // array is a dependency of memos in `ProjectBar` and of the shell's rail
  // chords, and a fresh one on every poll tick would tear those down for
  // nothing.
  if (sameSnapshot(snapshot, next)) return;
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

/**
 * One Core's pinned rows, with the counts its tasks say they have.
 *
 * A Core the service cannot reach is not asked at all — the router would only
 * answer with an error — and keeps the rows it last gave. A Core that answers
 * its projects but not its tasks keeps its counts and takes the fresh pins;
 * `corePinTaskCounts` is where that rule lives.
 */
async function readCore(
  core: CoreWithDial,
  presentation: ReadonlyMap<string, ProjectPresentation>,
): Promise<ProjectWithCounts[]> {
  const bridge = getPanelBridge();
  const remembered = lastRowsByCore.get(core.id) ?? [];
  if (!bridge || core.dial.state !== "connected") return remembered;
  let projects;
  try {
    projects = await bridge.listProjects(core.id);
  } catch {
    return remembered;
  }
  const tasks = await bridge
    .listTasks(core.id)
    .then((answer) => answer.tasks)
    .catch(() => null);
  const pinned = projects.filter((p) => p.pinned);
  const counts = corePinTaskCounts(
    pinned.map((p) => p.projectId),
    tasks,
    lastCountsByCore.get(core.id) ?? new Map(),
  );
  if (tasks !== null) lastCountsByCore.set(core.id, counts);
  const rows = pinned.map((p) => ({
    ...projectRowFromSnapshot(p, presentation.get(p.projectId), counts.get(p.projectId)),
    coreId: core.id,
    // Where this pin sits on the rail (issue 382). The core-link snapshot has
    // no answer for it — the rail spans every Core and this Panel's own rows,
    // so the slot belongs to none of them individually — and the mapper reads
    // it as null. It is Panel-local presentation, filed on the same row as the
    // group, and the rail's comparator sorts it against `projects.pinnedOrder`
    // in one numbering space. Without this the reorder wrote a slot nothing
    // read back, and the rail returned to the Core's own list order on reload.
    pinnedOrder: presentation.get(p.projectId)?.pinnedOrder ?? null,
  }));
  lastRowsByCore.set(core.id, rows);
  return rows;
}

const run = createCoalescingRunner(async () => {
  const bridge = getPanelBridge();
  if (!bridge) return false;
  const current = cores;
  if (current.length === 0) {
    publish(EMPTY);
    return true;
  }
  try {
    // The rail clusters by group and draws card images, and both are
    // Panel-local presentation for a Core-owned project (issue 98) — read once
    // for the whole fan-out rather than per Core. A failed read only costs the
    // filing, so the pins still render.
    const presentation = projectPresentationById(
      await api
        .listProjectPresentation()
        .then((r) => r.presentation)
        .catch(() => []),
    );
    const perCore = await Promise.all(current.map((core) => readCore(core, presentation)));
    publish(perCore.flat());
    return true;
  } catch {
    return false;
  }
});

function start(): void {
  const bridge = getPanelBridge();
  if (!bridge || teardown) return;
  const releases = cores.map((core) => bridge.watchCore(core.id));
  // One subscription for both halves of a pin row: a project event moves the
  // pins, a task event moves the dots, and both land in the same pass.
  const offEvent = bridge.onEvent(({ event }) => {
    if (TASK_EVENT_KINDS.test(event.kind) || isProjectListEventKind(event.kind)) void run();
  });
  // A dropped link means a gap the replay may not fully cover; re-read on the
  // way back rather than trusting what is on screen.
  const offConnection = bridge.onConnectionChange((connected) => {
    if (connected) void run();
  });
  pollTimer = setInterval(() => void run(), FLEET_POLL_MS);
  teardown = () => {
    for (const release of releases) release();
    offEvent();
    offConnection();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };
}

function stop(): void {
  teardown?.();
  teardown = null;
}

/**
 * Tell the engine which Cores exist and how each one's link stands.
 *
 * Every subscriber reads the same registry, so they all push the same value;
 * the signature is what decides whether anything has to happen. Dial state is
 * part of it, unlike the fan-out this replaced: a Core going down or coming
 * back is exactly when a pin's dots stop or start meaning anything, and a blink
 * storm costs one coalesced pass rather than one per blink.
 */
export function setCorePinsCores(next: CoreWithDial[]): void {
  cores = next;
  const signature = next.map((c) => `${c.id}:${c.dial.state}`).join(",");
  if (signature === coreSignature) return;
  coreSignature = signature;
  if (listeners.size > 0) {
    // Re-arm the Core watches against the new list before re-reading.
    stop();
    start();
    void run();
  }
}

/** Re-read every Core now — pins and the counts behind their dots together. */
export function refreshCorePins(): void {
  void run();
}

export function getCorePinsSnapshot(): ProjectWithCounts[] {
  return snapshot;
}

/**
 * Subscribe a mount. The first one starts the engine; the last one to leave
 * stops it and forgets what it knew — nothing is on screen to be lied to, and
 * the next mount rebuilds from the Cores themselves.
 */
export function subscribeCorePins(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  // A new rail wants an answer now, not at the next poll. In flight already?
  // The coalescing loop folds this into the pass that is running.
  void run();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stop();
    snapshot = EMPTY;
    cores = [];
    coreSignature = "";
    lastRowsByCore = new Map();
    lastCountsByCore = new Map();
  };
}
