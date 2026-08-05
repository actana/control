// Core-link frame schema — the generalized protocol for Panel ↔ Core
// communication.
//
// A single WebSocket (`ws://127.0.0.1`) carries multiplexed frames keyed by
// `ptyId`/`taskId` where relevant. Loopback-only (trusted) at this stage;
// mTLS + bearer auth is added in a later issue.
//
// Issue 02 generalizes the seed PTY protocol into one that carries task,
// session, and hook operations alongside PTY ops, and adds a monotonic
// per-Core event log with `lastEventId` reconnect replay. The frame shapes:
//
// - Request/response frames carry a client-generated `reqId` for correlation.
// - Unsolicited stream frames (`data`, `exit`) carry only `ptyId` — the Panel
//   routes them via its pty-stream-router (demuxed by `ptyId`).
// - `subscribe` (Panel → Core) carries the Panel's `lastEventId` cursor so
//   the Core can stream the replay tail; `event` frames carry the
//   sequential {@link CoreLinkEvent} envelope for every domain event; the
//   `eventsReplayed` marker signals "caught up, live push resumes".
//
// This file is self-contained (no `~/` imports) so it compiles under both the
// Vite (browser) and the Core's CommonJS tsconfigs.

// ─── Shared payload types ─────────────────────────────────────────────────────

export type CoreLinkPtySpawnHarness = "claude-code" | "codex" | "cursor-cli" | "opencode";

export type CoreLinkBaseSpawnOptions = {
  taskId: string;
  cwd: string;
  command: string;
  args?: string[];
  cols?: number;
  rows?: number;
  mcEnv?: { apiUrl?: string; token?: string };
  missionControlTheme?: "dark" | "light";
  /**
   * Discriminant for the VM Shell Session mode (issue 06). `never` here keeps
   * agent/shell spawns out of that branch; {@link CoreLinkShellSessionSpawnOptions}
   * sets it to `true`. Declared on the base so `opts.shellSession` is readable
   * on the whole {@link CoreLinkPtySpawnOptions} union for a type-safe
   * discriminated narrow (no `as` cast needed at the dispatch site).
   */
  shellSession?: never;
};

export type CoreLinkHarnessSpawnOptions = CoreLinkBaseSpawnOptions & {
  agent: CoreLinkPtySpawnHarness;
  dangerouslySkipPermissions?: boolean;
  shell?: never;
  initialInput?: string;
};

export type CoreLinkShellSpawnOptions = CoreLinkBaseSpawnOptions & {
  shell: true;
  agent?: never;
  dangerouslySkipPermissions?: never;
  home?: boolean;
};

/**
 * A VM Shell Session spawn (issue 06) — a free-form interactive shell on the
 * Core's machine, distinct from agent workspaces. `shellSession: true` is
 * its own spawn mode: no `agent`, no `cwd`/project-root requirement (a VM shell
 * has no project folder). The Core skips the project-root validation it
 * applies to agent spawns and starts a login shell at its own home. Gated by
 * core-link auth (mTLS + bearer), never auto-spawned — opened by an explicit
 * Panel gesture. Streamed back over the same multiplexed core-link; replayable
 * on reconnect like any other PTY.
 */
export type CoreLinkShellSessionSpawnOptions = {
  shellSession: true;
  taskId: string;
  /** Optional starting command; empty (or omitted) → interactive login shell. */
  command?: string;
  cols?: number;
  rows?: number;
  missionControlTheme?: "dark" | "light";
};

export type CoreLinkPtySpawnOptions =
  | CoreLinkHarnessSpawnOptions
  | CoreLinkShellSpawnOptions
  | CoreLinkShellSessionSpawnOptions;

/**
 * A window of a PTY's replay ring — the answer to a `replay` request. `from` is
 * the seq of the first chunk in `data`, absent when `data` is empty; a caller
 * that asked for a `sinceSeq` and is handed a larger `from` has a hole in front
 * of the tail (see the `replayResult` frame).
 */
export type CoreLinkPtyReplay = {
  data: string;
  nextSeq: number;
  from?: number;
};

export type CoreLinkPortKillResult = {
  port: number;
  pids: number[];
  killed: number[];
  errors: string[];
};

export type CoreLinkLaunchProcessKillResult = {
  ptyCount: number;
  ports: CoreLinkPortKillResult[];
};

// ─── Event log envelope ─────────────────────────────────────────────────────
//
// A discrete thing that happened on a Core — task status change, hook fired,
// question menu appeared, run finished, PTY spawned/exited. Has a monotonic
// `eventId` per Core, persisted in the Core's SQLite `event_log` table.
// On Panel reconnect the Core streams the tail past the Panel's
// `lastEventId` as `event` frames, then resumes live push. See CONTEXT.md
// "Event" / "Event cursor". PTY byte-stream replay stays in the in-memory ring
// buffer (one category of replay); the structured lifecycle events live here.

export type CoreLinkEvent = {
  /** Sequential, monotonic, per-Core. Never 0. */
  eventId: number;
  /** Wall-clock ms when the event was appended. */
  ts: number;
  /**
   * Stable kind string: `task:created`, `task:updated`, `session:finished`,
   * `task:question`, `pty:spawn`, `pty:exit`, … Mirrors the server's AppEvent
   * type names so the Panel can route by kind without a translation layer.
   */
  kind: string;
  /** The PTY this event belongs to, if any (PTY spawn/exit). */
  ptyId: string | null;
  /** The Task this event belongs to, if any (task status, session finish). */
  taskId: string | null;
  /** JSON-serialized event-specific body. Shape is kind-specific. */
  payload: string;
};

// ─── Task / session / hook operation frames (generalized in issue 02) ───────
//
// The schema carries task/session/hook ops alongside PTY ops, keyed by the
// same `ptyId`/`taskId` model. They use `reqId` correlation like the PTY RPCs.
// Issue 04 (ADR 0004) makes task/project mutations real: the Core process
// owns the write path directly against its SQLite (no sibling stateful server
// on remote VMs), so `projectsMutate` / `tasksMutate` land rows via
// `core-mutation-store` and append `project:created` / `task:updated` etc.
// events to the same monotonic event log the PTY lifecycle events use.

export type CoreLinkTaskStatus = string;

/**
 * A task mutation — `create` (a new task under an existing project), `update`
 * (patch an existing task row), or `delete` (remove one). The discriminant lets
 * the Core dispatch to `createTask` / `updateTask` / `deleteTask` without a
 * nullable-id sniff.
 *
 * On `create`, `projectId`, `title`, and `agent` are required — everything
 * else defaults on the Core (status → `ready`, pinned/archived → false).
 * `taskId` is optional; when omitted the Core generates one.
 *
 * On `update`, `taskId` is required and identifies the row; any of
 * `status`/`title`/`pinned`/`archived` may be set. Fields omitted are left
 * untouched (partial patch, mirroring the Panel server's PATCH shape).
 *
 * On `delete`, `taskId` is required and the row is removed outright — the
 * Core's SQLite cascades the rows hanging off it, mirroring the Panel
 * server's own DELETE. A missing row comes back as `task: null`, the same way
 * a missing row on `update` does; it is not an error frame.
 */
export type CoreLinkTaskMutation =
  | {
      op: "create";
      taskId?: string;
      projectId: string;
      title: string;
      agent: string;
      status?: CoreLinkTaskStatus;
      /** Optional session icon id at creation time; usually null and set later. */
      icon?: string | null;
    }
  | {
      op: "update";
      taskId: string;
      status?: CoreLinkTaskStatus;
      title?: string;
      /**
       * Whether the `title` on this patch is an operator's rename (issue 84).
       * Omitted, a title reads as a rename and pins the row's
       * manually-set-title flag — the shape every Panel-driven rename has
       * always had. The Core's own title generator is the one caller that
       * sends `false`, so a generated name never claims to be a rename and a
       * rename is never overwritten by a generator that finished after it.
       * Meaningless without `title`; ignored there.
       */
      titleManuallySet?: boolean;
      /**
       * The harness's own session id for this Task (issue 84). Captured by the
       * Core when a hook reports one, and by the Panel when a resumed session
       * hands back a fresh id — a Core-owned row's session id is Core state
       * like every other column, and writing it to the Panel's database left
       * the Core's row blank. `null` clears it.
       */
      claudeSessionId?: string | null;
      pinned?: boolean;
      archived?: boolean;
      /**
       * Session icon id (issue 09). `undefined` leaves the row untouched (partial
       * patch); a string sets it; `null` clears it. Icon is Core-owned
       * metadata (ADR 0005) — the Panel never stores it and every icon change
       * routes through this frame.
       */
      icon?: string | null;
    }
  | {
      op: "delete";
      taskId: string;
    };

/**
 * A project mutation — `create`, `rename`, or `archive`. The Core validates
 * the VM path on `create` (absolute, resolvable, not a file) and rejects with
 * an `error` frame if invalid — a Project's path is a VM path and only the
 * Core can validate it (CONTEXT.md "Project").
 *
 * `archive` deletes the project row (SQLite cascades tasks under
 * this project via ON DELETE CASCADE — that is the shared-DB shape). The word
 * "archive" is used at the protocol layer to match the ticket's language and
 * to leave room for a future soft-archive column without changing the frame
 * shape; today it is destructive.
 */
export type CoreLinkProjectMutation =
  | {
      op: "create";
      projectId?: string;
      name: string;
      path: string;
      icon?: string;
      iconColor?: string;
      pinned?: boolean;
      /**
       * The remembered session settings the Create Project dialog collected
       * (issue 22). Omitted fields fall back to the column defaults, so a
       * caller that only names the project still creates a valid row.
       */
      rememberHarnessSettings?: boolean;
      savedHarness?: string | null;
      savedSkipPermissions?: boolean;
      savedBareSession?: boolean;
      defaultGridView?: boolean;
    }
  | { op: "rename"; projectId: string; name: string }
  | { op: "archive"; projectId: string }
  /**
   * Pin / unpin a project (issue 10). Pin state is a Core fact stored on
   * the project row; every Panel connected to the same Core sees the same
   * value. Dedicated op (rather than piggy-backing on a generic
   * `updateProject` patch) so the event kind can be `project:pinnedChanged`
   * — a reconnecting Panel replays pin flips distinctly from other project
   * edits.
   */
  | { op: "pin"; projectId: string; pinned: boolean }
  /**
   * Patch a project's remembered session settings (issue 22) — the "Remember
   * settings for this project" checkbox and the grid-view default. These are
   * Core facts on the project row, so every Panel connected to the same Core
   * converges on them, exactly as pin state does.
   *
   * Follows the `pin` precedent rather than becoming a generic field patch: a
   * dedicated op earns its own `project:settingsChanged` event kind, so a
   * reconnecting Panel replays a settings change distinctly from a rename.
   * Fields left `undefined` are untouched; `savedHarness: null` clears it.
   */
  | {
      op: "settings";
      projectId: string;
      rememberHarnessSettings?: boolean;
      savedHarness?: string | null;
      savedSkipPermissions?: boolean;
      savedBareSession?: boolean;
      defaultGridView?: boolean;
    };

export type CoreLinkHookOp =
  | { op: "list"; taskId?: string }
  | { op: "enable"; hookId: string; taskId?: string }
  | { op: "disable"; hookId: string; taskId?: string };

// ─── CLI availability (issue 11) ────────────────────────────────────────────
//
// The Core probes for each managed Harness on PATH — startup, periodic
// tick — and publishes the resulting map as (a) a live snapshot readable via
// the `agentsAvailabilityList` request/response frames and (b) an
// `agents:availabilityChanged` event appended to the monotonic event log
// whenever the probe result changes. A reconnecting Panel catches up through
// the standard `subscribe`/`event`/`eventsReplayed` replay path; a fresh Panel
// hydrates by calling the RPC once. Every Core emits the
// identical shape — the Panel's per-Core availability store is oblivious to
// which Core answered.

/**
 * Availability of one managed Harness on a single Core. `status` mirrors the
 * Panel's `CliAvailability` shape so no translation is needed at the store
 * boundary. `path` / `version` / `label` / `requiredVersion` / `packageUrl` /
 * `updateCommands` are copied from the probe's `CliCheckResult` where known so
 * the update-required and outdated flows keep working across every Core.
 */
export type CoreLinkHarnessAvailability = {
  status: "checking" | "available" | "missing" | "outdated";
  path?: string;
  reason?: string;
  label?: string;
  version?: string;
  requiredVersion?: string;
  packageUrl?: string;
  updateCommands?: readonly string[];
};

/** Per-agent availability map. Keys are the `Harness` id strings. */
export type CoreLinkHarnessAvailabilityMap = Record<string, CoreLinkHarnessAvailability>;

/**
 * The kind string appended to the event log when the availability map changes.
 * Payload is the JSON-serialized full {@link CoreLinkHarnessAvailabilityMap}
 * (self-contained; a Panel that misses N intermediate changes and replays only
 * the tail lands on the latest state without stitching).
 */
export const HARNESSES_AVAILABILITY_EVENT_KIND = "agents:availabilityChanged";

// ─── Directory browsing (web-panel issue 06) ────────────────────────────────
//
// Adding a Project means naming a folder on the Core's machine. The Panel runs
// in a browser now, so it has no filesystem of its own to offer and the
// operator's laptop is the wrong machine to browse — the only process that can
// honestly answer "what folders exist here" is the Core that owns the disk.
// These two frames are that answer: a listing walk (`dirList`) and the one
// write the picker needs (`dirCreate`).
//
// Failures come back as the ordinary `error` frame carrying a message written
// for the operator ("Folder not found", "No permission to create a folder
// here") — the same channel a rejected mutation uses, so the Panel's request
// path rejects rather than handing the UI a result to inspect.

/** One directory inside a listing. `childCount` is 0 for a leaf. */
export type CoreLinkDirEntry = {
  name: string;
  /** Visible (non-hidden) subdirectory count — powers the drill-in affordance. */
  childCount: number;
};

/**
 * One directory's worth of listing, as the Core sees its own disk. `path`
 * is the resolved absolute directory; `parent` is null at the filesystem root.
 * `roots` are shortcut chips (home plus the standard folders that exist on
 * that machine) so the picker opens somewhere useful on a VM whose layout the
 * Panel knows nothing about.
 */
export type CoreLinkDirListing = {
  path: string;
  parent: string | null;
  home: string;
  roots: Array<{ label: string; path: string }>;
  entries: CoreLinkDirEntry[];
  /** True when the listing was capped and some folders are not shown. */
  truncated: boolean;
};

// ─── Client → Server (Panel → Core) ──────────────────────────────────────

export type CoreLinkRequestFrame =
  | { type: "spawn"; reqId: string; opts: CoreLinkPtySpawnOptions }
  | { type: "write"; reqId: string; ptyId: string; data: string }
  | { type: "resize"; reqId: string; ptyId: string; cols: number; rows: number }
  | { type: "kill"; reqId: string; ptyId: string }
  | {
      type: "killLaunchProcesses";
      reqId: string;
      cwd: string;
      commands: string[];
      ports?: number[];
    }
  | { type: "findByTask"; reqId: string; taskId: string }
  // A reattach after a dropped panel link asks for the ring tail past the seq
  // the browser already painted (`sinceSeq`); omitting it asks for the whole
  // scrollback, which is what a first attach wants.
  | { type: "replay"; reqId: string; ptyId: string; sinceSeq?: number }
  // ─── Event-cursor replay (issue 02) ───
  // Sent on (re)connect. The Panel's last-seen eventId per Core. The Core
  // streams the event_log tail past it as `event` frames, then sends
  // `eventsReplayed` and resumes live event push. `lastEventId: 0` requests
  // the full log (used on first connect).
  | { type: "subscribe"; reqId: string; lastEventId: number }
  // ─── Task ops (issue 02 — schema carries task ops keyed by taskId) ───
  | { type: "tasksList"; reqId: string; projectId?: string }
  | { type: "tasksMutate"; reqId: string; mutation: CoreLinkTaskMutation }
  // ─── Project ops (issue 07 — per-Core navigation: list the Core's
  // projects as live snapshots, no Panel-side persistence) ───
  | { type: "projectsList"; reqId: string }
  // ─── Project mutations (issue 04 — write path on remote Cores). The
  // Core owns the write against its SQLite (ADR 0004); path validation
  // happens Core-side because a Project's path is a VM path. ───
  | { type: "projectsMutate"; reqId: string; mutation: CoreLinkProjectMutation }
  // ─── Session ops (observe a session's lifecycle / reattach) ───
  | { type: "sessionsList"; reqId: string; projectId?: string }
  // ─── Hook ops (list / enable / disable hooks for a task) ───
  | { type: "hooksOp"; reqId: string; hook: CoreLinkHookOp }
  // ─── Bearer auth (issue 04) ───
  // Sent by the Panel right after the mTLS handshake, before any other frame.
  // Carries the signed bearer `{coreId, exp, sig}` from the registration blob.
  // The Core verifies the signature + `exp`; on success it replies
  // `authOk`; on expiry or bad signature it sends `authError` and closes — the
  // Panel's existing reconnect path re-handshakes TLS and re-presents a fresh
  // bearer (reissuing is a VM-side op; see ADR 0002/0003). Loopback Cores
  // (`ws://`, trusted) never send `auth`.
  | { type: "auth"; reqId: string; bearer: string }
  // ─── CLI availability snapshot (issue 11) ───
  // Live snapshot query. Complements the `agents:availabilityChanged` event
  // stream so a fresh Panel hydrates without waiting for the next probe tick.
  | { type: "agentsAvailabilityList"; reqId: string }
  // ─── Directory browsing (web-panel issue 06) ───
  // `path` omitted or null means "start at the Core's home directory" —
  // the Panel cannot compute that itself for a machine it has never seen.
  | { type: "dirList"; reqId: string; path?: string | null }
  | { type: "dirCreate"; reqId: string; parent: string; name: string };

// ─── Server → Client (Core → Panel) ──────────────────────────────────────

/** Unsolicited stream frame — pushed by the Core whenever a PTY emits or exits. */
export type CoreLinkStreamFrame =
  | { type: "data"; ptyId: string; data: string; seq: number }
  | { type: "exit"; ptyId: string; exitCode: number; signal?: number };

/**
 * Unsolicited event frame — pushed by the Core for every domain event in
 * the monotonic event log (task status, hook, session finish, PTY spawn/exit).
 * Carries the sequential {@link CoreLinkEvent} envelope. During a replay the
 * Core streams these back-to-back; live push uses the same frame shape.
 */
export type CoreLinkEventFrame = { type: "event"; event: CoreLinkEvent };

/**
 * End-of-replay marker. Sent once after the `subscribe` tail has been fully
 * streamed as `event` frames. `lastEventId` is the highest eventId the Panel
 * has now seen — it persists it as its new cursor. After this frame the
 * Core resumes live `event` push for any events appended after the cursor.
 */
export type CoreLinkEventsReplayedFrame = { type: "eventsReplayed"; lastEventId: number };

/** Response frame — correlates to a request via `reqId`. */
export type CoreLinkResponseFrame =
  | { type: "ready"; version: string }
  | {
      type: "spawned";
      reqId: string;
      ptyId: string;
      /**
       * Did this spawn install lifecycle hooks that report to this Core's hook
       * receiver (issue 84)? The Panel's terminal-input fallback stands down
       * only for a Session whose hooks are actually reporting — not for a
       * harness family that supports them in principle, which is how a harness
       * with no installed hooks used to end up with no `running` signal at all.
       * Absent from an older Core's answer, which reads as "no hooks".
       */
      hooksInstalled?: boolean;
    }
  | { type: "spawnError"; reqId: string; message: string }
  | { type: "writeResult"; reqId: string; ok: boolean }
  | { type: "resizeResult"; reqId: string; ok: boolean }
  | { type: "killResult"; reqId: string; ok: boolean }
  | {
      type: "killLaunchProcessesResult";
      reqId: string;
      result: CoreLinkLaunchProcessKillResult;
    }
  | { type: "findByTaskResult"; reqId: string; ptyId: string | null }
  // `from` is the seq of the first chunk in `data` (absent when `data` is
  // empty). A caller that asked for `sinceSeq` and is handed `from > sinceSeq`
  // knows the bounded ring rolled past its cursor while it was away: the tail
  // has a hole in front of it and must be painted as a fresh screen, not
  // appended to a stale one.
  | { type: "replayResult"; reqId: string; data: string; nextSeq: number; from?: number }
  // ─── Event-cursor replay responses (issue 02) ───
  // `subscribeAck` acknowledges the subscribe request; the `event` stream and
  // `eventsReplayed` marker follow. (Subscribe is fire-and-forget from the
  // Panel's perspective — the ack is optional but aids debugging.)
  | { type: "subscribeAck"; reqId: string; fromEventId: number }
  // ─── Task / session / hook op responses (issue 02) ───
  | { type: "tasksListResult"; reqId: string; tasks: CoreLinkTaskSnapshot[] }
  | { type: "tasksMutateResult"; reqId: string; task: CoreLinkTaskSnapshot | null }
  // ─── Project op responses (issue 07 — per-Core navigation, issue 04 — writes) ───
  | { type: "projectsListResult"; reqId: string; projects: CoreLinkProjectSnapshot[] }
  | { type: "projectsMutateResult"; reqId: string; project: CoreLinkProjectSnapshot | null }
  | { type: "sessionsListResult"; reqId: string; sessions: CoreLinkSessionSnapshot[] }
  | { type: "hooksOpResult"; reqId: string; hooks: CoreLinkHookEntry[] }
  // ─── Bearer auth responses (issue 04) ───
  // `authOk` acknowledges a verified bearer; `exp` is the expiry so the Panel
  // can show a "session expires at" hint. `authError` rejects it; the server
  // closes the socket right after so the Panel's reconnect path takes over.
  | { type: "authOk"; reqId: string; coreId: string; exp: number }
  | { type: "authError"; reqId?: string; reason: "expired" | "bad-signature" | "malformed" }
  // ─── CLI availability (issue 11) ───
  | {
      type: "agentsAvailabilityListResult";
      reqId: string;
      availability: CoreLinkHarnessAvailabilityMap;
    }
  // ─── Directory browsing (web-panel issue 06) ───
  | { type: "dirListResult"; reqId: string; listing: CoreLinkDirListing }
  | { type: "dirCreateResult"; reqId: string; path: string }
  | { type: "error"; reqId?: string; message: string };

/**
 * A flattened project snapshot carried over the core-link (issue 07). The
 * Core is the source of truth for projects; the Panel holds none. The shape
 * mirrors the server's project row so the Panel can render per-Core navigation
 * without a separate HTTP round-trip per project.
 *
 * `path` is a VM path — only the Core can validate it (CONTEXT.md
 * "Project": "A Project's path is a VM path. Only the Core can validate
 * it."). The Panel renders it as-is and never assumes it exists locally.
 */
export type CoreLinkProjectSnapshot = {
  projectId: string;
  name: string;
  /** Absolute path on the Core's machine (a VM path, not a Panel path). */
  path: string;
  /** 2-letter monogram shown in the Panel (mirrors the projects table). */
  icon: string;
  /** Hex color for the icon background. */
  iconColor: string;
  pinned: boolean;
  /**
   * Remembered session settings (issue 22). Core facts on the project row —
   * the Panel holds no copy, so a second Panel on the same Core reads the
   * same values, the way pin state already behaves.
   *
   * `savedSkipPermissions` is carried for symmetry with the column that
   * already exists; nothing on the launch path reads it. Auto-mode is the
   * unconditional default for every Harness that has such a flag, so wiring
   * this back into a session launch would reintroduce the removed control.
   */
  rememberHarnessSettings: boolean;
  savedHarness: string | null;
  savedSkipPermissions: boolean;
  savedBareSession: boolean;
  defaultGridView: boolean;
  updatedAt: number;
};

/**
 * A flattened task snapshot carried over the core-link. The Core is the
 * source of truth for tasks; the Panel holds none. The shape mirrors the
 * server's task row so the Panel can render a fleet view without a separate
 * HTTP round-trip per task.
 */
export type CoreLinkTaskSnapshot = {
  taskId: string;
  projectId: string;
  title: string;
  /**
   * True once an operator has renamed this Session (issue 84). The Core's
   * title generator refuses to write over a row carrying it, and the flag
   * lives on the row rather than in Panel memory so the protection survives a
   * Panel reload and a generator that finishes after the rename. The Panel
   * renders from this field instead of synthesizing `false`, which made every
   * Core-owned Session look un-renamed.
   */
  titleManuallySet: boolean;
  /**
   * The harness's own session id for this Task, or `null` before one has been
   * observed (issue 84). The Core's hook pipeline reads it to tell a hook from
   * this Session apart from one belonging to a session that has since been
   * replaced.
   */
  claudeSessionId: string | null;
  agent: string;
  status: string;
  pinned: boolean;
  archived: boolean;
  /**
   * Session icon id — a stable string drawn from the {@link SESSION_ICON_OPTIONS}
   * list (issue 09). `null` means the row has no user- or generator-assigned
   * icon and the Panel should fall back to `DEFAULT_SESSION_ICON`. Icon is
   * Core-owned metadata (ADR 0005); the Panel never persists it.
   */
  icon: string | null;
  updatedAt: number;
};

/** A session snapshot — a task's live or replayable conversation. */
export type CoreLinkSessionSnapshot = {
  taskId: string;
  ptyId: string | null;
  status: string;
  updatedAt: number;
};

/** A hook entry returned by `hooksOp`. */
export type CoreLinkHookEntry = {
  hookId: string;
  taskId: string | null;
  enabled: boolean;
};

export type CoreLinkServerFrame =
  | CoreLinkStreamFrame
  | CoreLinkEventFrame
  | CoreLinkEventsReplayedFrame
  | CoreLinkResponseFrame;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Protocol version advertised in the `ready` frame. Bumped on breaking changes.
 * Issue 02 adds the event-cursor replay (`subscribe` / `event` /
 * `eventsReplayed`) and the task/session/hook op frames → 0.2.0. Issue 04 adds
 * the mTLS bearer `auth` / `authOk` / `authError` frames → 0.3.0. Issue 06 adds
 * the `shellSession: true` VM-shell spawn mode (no `agent`, no project-root) →
 * 0.4.0. Issue 07 adds the `projectsList` / `projectsListResult` frames for
 * per-Core navigation (additive — same 0.4.0). Issue 04 lands the write path
 * (`projectsMutate` + real `tasksMutate` handlers + real `sessionsList`) and
 * discriminant-typed mutation shapes → 0.5.0. `tasksMutate`'s payload shape
 * changed from a flat `{taskId, projectId?, status?, ...}` to a discriminated
 * `{op: "create"|"update", ...}` union. `parseCoreLinkRequestFrame` only
 * validates the outer `type`, so a stale-shape mutation payload lands at the
 * mutation store's runtime `op` check and comes back as an actionable `error`
 * frame ("unknown task mutation op: undefined"). No shipped Panel yet routes
 * writes through this frame (the loopback API still owns local writes; remote
 * writes were stubbed as `task: null`), so no live caller regresses. Issue 09
 * adds the `icon` field to {@link CoreLinkTaskSnapshot} and the create/update
 * variants of {@link CoreLinkTaskMutation}, plus a dedicated
 * `task:iconChanged` event kind so replays surface icon-only edits distinctly
 * from other task updates → 0.6.0. Issue 11 adds the `agentsAvailabilityList`
 * request/response + the `agents:availabilityChanged` event kind → 0.7.0.
 * Additive on both sides — a Core that has not been upgraded ignores the
 * new request frame (the outer `parseCoreLinkRequestFrame` rejects unknown
 * types), and a Panel hydrating from an older Core sees an empty
 * availability map and falls back to the same "checking…" affordance a fresh
 * boot shows. Issue 10 adds a dedicated `pin` op to
 * {@link CoreLinkProjectMutation} plus the `project:pinnedChanged` /
 * `task:pinnedChanged` event kinds (task pin-only updates now surface
 * distinctly, mirroring the icon-only path from issue 09) → 0.8.0. Web-panel
 * issue 06 adds the `dirList` / `dirCreate` request frames and their results,
 * so the browser's folder picker browses the Core's disk instead of a
 * machine-local dialog that no longer exists → 0.9.0. Additive: a Core that
 * has not been upgraded rejects the unknown request type, which the Panel
 * surfaces as the same actionable error any other failed listing produces.
 * Issue 22 adds a `settings` op to {@link CoreLinkProjectMutation}, the same
 * remembered-settings fields on its `create` variant, those fields on
 * {@link CoreLinkProjectSnapshot}, and the `project:settingsChanged` event
 * kind → 0.10.0. Every column they land in already exists in the shared
 * schema bootstrap, so no migration rides along. Unlike the additive bumps
 * above, there is no partial-compatibility story to describe here and none is
 * wanted: the minor moved, so a Core still speaking 0.9.0 is incompatible by
 * the major.minor rule below and renders as "needs update" (ADR 0005). It
 * never reaches the mutation store's runtime `op` check.
 * Issue 63 adds a `delete` op to {@link CoreLinkTaskMutation} and the
 * `task:deleted` event kind the Core appends for it → 0.11.0. Deleting a
 * Core-owned Session had no operation to carry, so every delete call site fell
 * through to the Panel's own endpoint and 404'd. Same rule as above: the minor
 * moved, so a Core on 0.10.0 is "needs update" rather than a Core that accepts
 * the frame and silently drops the op.
 * Issue 84 adds `titleManuallySet` and `claudeSessionId` to
 * {@link CoreLinkTaskSnapshot} and to the `update` variant of
 * {@link CoreLinkTaskMutation}, plus `hooksInstalled` on the `spawned`
 * response → 0.12.0. The snapshot field is the load-bearing one:
 * a Core that grew it without this bump would hand a Panel that predates it a
 * snapshot whose rename protection is silently absent, and a Panel that
 * predates the Core would keep synthesizing `false` — both render a Session
 * the generator is free to rename out from under its operator. Same rule as
 * above: the minor moved, so either side on 0.11.0 is "needs update" rather
 * than a partial snapshot nobody notices. No migration rides along — the
 * column (`title_manually_set`) has been in the shared schema bootstrap since
 * the fork; only the wire and the Core's readers/writers of it are new.
 */
export const CORE_LINK_PROTOCOL_VERSION = "0.12.0";

/**
 * Does a Core advertising `reported` speak this build's core-link?
 *
 * The rule is major.minor equality, and it is deliberately blunt: ADR 0005 says
 * the Panel carries no feature detection, so there is no "mostly compatible"
 * state to describe. A Core is either speaking this vocabulary or it is a chore
 * — one command on that machine — and the Panel says so rather than degrading.
 * Patch is ignored because the version above only moves on wire changes;
 * reserving the patch segment for fixes that touch no frame keeps a
 * behaviour-only release from grounding a fleet.
 *
 * A missing or unparseable version is incompatible: every Core that speaks
 * a version the Panel could accept says so in its `ready` frame, so silence is
 * evidence of something older than the frame that carries it.
 */
export function coreLinkProtocolCompatible(reported: string | null | undefined): boolean {
  const theirs = parseMajorMinor(reported);
  if (!theirs) return false;
  const ours = parseMajorMinor(CORE_LINK_PROTOCOL_VERSION);
  if (!ours) return false;
  return theirs.major === ours.major && theirs.minor === ours.minor;
}

function parseMajorMinor(version: string | null | undefined): { major: number; minor: number } | null {
  if (typeof version !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

const REQUEST_FRAME_TYPES: ReadonlySet<string> = new Set<CoreLinkRequestFrame["type"]>([
  "spawn",
  "write",
  "resize",
  "kill",
  "killLaunchProcesses",
  "findByTask",
  "replay",
  "subscribe",
  "tasksList",
  "tasksMutate",
  "projectsList",
  "projectsMutate",
  "sessionsList",
  "hooksOp",
  "auth",
  "agentsAvailabilityList",
  "dirList",
  "dirCreate",
]);

/** Parse and validate a raw WS message into a known request frame, or null. */
export function parseCoreLinkRequestFrame(raw: string): CoreLinkRequestFrame | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const type = (msg as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  return REQUEST_FRAME_TYPES.has(type) ? (msg as CoreLinkRequestFrame) : null;
}

/** Serialize a server frame for sending over the WebSocket. */
export function serializeCoreLinkFrame(frame: CoreLinkServerFrame): string {
  return JSON.stringify(frame);
}
