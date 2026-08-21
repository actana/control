// Core-link frame schema — the generalized protocol for Panel ↔ Core
// communication.
//
// This file is the **one** definition of every frame type in the repository,
// and it lives in `@actana/sdk` because the protocol ships with the client that
// speaks it (ADR 0025). The Core is the server answering these frames and
// imports them from here too — deliberately, so that "the protocol" and "the
// package a third party installs to speak it" are the same artifact rather
// than two that have to be kept in step.
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
    }
  /**
   * Patch a project's icon and icon colour (issue 98). Both live on the Core's
   * project row and already travel in {@link CoreLinkProjectSnapshot}, and
   * `create` accepts them — but until this op nothing could change them
   * afterwards, so the Edit-project dialog PATCHed them at a Panel row a
   * Core-owned project does not have, and 404'd.
   *
   * Follows the `pin` / `settings` precedent rather than widening `rename` into
   * a generic field patch: a dedicated op earns its own
   * `project:appearanceChanged` event kind, so a reconnecting Panel replays an
   * icon change distinctly from a rename. Fields left `undefined` are
   * untouched; a blank string is not an erase (both columns are NOT NULL) and
   * is ignored.
   */
  | { op: "appearance"; projectId: string; icon?: string; iconColor?: string };

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

// ─── Installing a missing Harness (issue 83) ────────────────────────────────
//
// Availability tells the operator a CLI is missing on a Core. The
// `harnessInstall` frame is how they do something about it without leaving the
// Panel: it names one Harness, and the Core that owns the machine runs the same
// non-interactive install `actana harnesses install <id>` runs, then re-probes.
//
// The frame is answered by an *ack*, not by the install's outcome. A vendor
// installer takes minutes and the panel link's request timeout is fixed per
// client (30s), so a response frame held open for the install's duration would
// reject a healthy install and — worse — tie the outcome to one browser tab's
// pending promise. The outcome travels on the event log instead: success is the
// ordinary `agents:availabilityChanged` event flipping the Harness to
// `available`, failure is {@link HARNESS_INSTALL_FAILED_EVENT_KIND}. Both
// outlive the request, a Panel reload, and a link drop — none of which a
// pending promise does. Success is seen by every tab watching that Core; a
// failure is acted on by the ones still waiting on that install, since the tail
// replays and an outcome nobody is waiting for is history rather than news.

/**
 * Answer to a `harnessInstall` request. `accepted` means the Core validated the
 * Harness id and started the install — nothing about whether it succeeded.
 * `accepted: false` is a refusal to start at all (an unknown id, or a Core with
 * no install path wired) and carries the operator-facing reason.
 */
export type CoreLinkHarnessInstallAck = {
  accepted: boolean;
  message?: string;
};

/**
 * The kind appended to the event log when an install ends without the Harness
 * becoming available. Payload is `{harness, message}` — the message is written
 * for the operator, in the same register the `dirCreate` / `dirList` failures
 * use. This is the only definitive failure signal: no failure is ever cached in
 * the availability map, so a Panel that missed the event sees a plain `missing`
 * Harness it can try again, never a permanently disabled one.
 */
export const HARNESS_INSTALL_FAILED_EVENT_KIND = "harness:installFailed";

/** Payload of a {@link HARNESS_INSTALL_FAILED_EVENT_KIND} event. */
export type CoreLinkHarnessInstallFailedPayload = {
  /** The Harness id the install was for. */
  harness: string;
  /** Operator-facing reason, e.g. "Installing Claude Code failed (exit 1)." */
  message: string;
};

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

// ─── Session lock (issue 144, ADR 0024 D3–D7, D10) ──────────────────────────
//
// One Session, at most one writer, and the writer is the **core-link
// connection** (D3). The three frames below are the whole of how a connection
// says so: `claim` takes an unlocked Session, `release` gives it back, and
// `forceTakeover` takes one whoever holds it. All three are ordinary
// reqId-correlated requests, and all three name a Session by its `taskId` —
// the one identifier `tasksMutate` carries directly and `write`/`kill` resolve
// to from their `ptyId`.
//
// A Session starts unlocked and its creator gets no privilege (D5), so the
// window between a Session starting and its first claim is a real race in which
// any connection can take it. That is accepted, not a defect: closing it would
// mean reintroducing creator privilege, which was decided against. An
// automation claims immediately after starting.
//
// Claiming is explicit (D6): no mutation ever acquires the lock. A mutation
// aimed at a Session **another connection holds** is refused with
// {@link SESSION_LOCKED_ERROR_CODE}; a mutation aimed at an **unlocked** Session
// is served, which is what keeps a client that never claims — every client that
// predates this — working exactly as it does today (D11).
//
// There is no idle timeout and there must not be one (D7). A long agent run is
// idle by definition; the hung-client case is what `forceTakeover` is for.
//
// None of this is a security boundary (D10). The Core's only authentication is
// the bearer in the registration blob, and anyone holding it can open a VM Shell
// Session and kill the process directly. This is an accident guard.

/**
 * The `code` on an `error` frame refusing a mutation because another connection
 * holds that Session's lock (ADR 0024 D4/D6).
 *
 * A code rather than a message match, because the client has to tell this apart
 * from the other way a mutation fails to land: "that Session is gone". Those two
 * answers arrive on different frames entirely — a refusal is this `error`, while
 * a Session that no longer exists is the ordinary `writeResult { ok: false }` /
 * `killResult { ok: false }` / `tasksMutateResult { task: null }` the Core has
 * always sent — so a client can distinguish them without parsing prose, and one
 * of them is worth retrying after a claim while the other never is.
 */
export const SESSION_LOCKED_ERROR_CODE = "session-locked";

/**
 * The `code` on an `error` frame refusing an {@link CoreLinkRequestFrame}
 * `exec` because the command produced more output than one answer may carry
 * (issue 266).
 *
 * A named refusal rather than a truncated `execResult`, and the distinction is
 * the whole point: a stdout that looks complete and is not ships broken and
 * looks fine. A caller that gets this code knows it asked the wrong question —
 * the command ran, its output is gone, and the fix is to redirect to a file on
 * the Core rather than to retry.
 */
export const EXEC_OUTPUT_TOO_LARGE_ERROR_CODE = "exec-output-too-large";

/**
 * Machine-readable `error` codes. Open by construction (a plain string union)
 * so a later refusal can name itself without every client having to learn the
 * whole set: an unrecognised code reads as a plain error, which is what a
 * client that ignores the field already does.
 */
export type CoreLinkErrorCode =
  | typeof SESSION_LOCKED_ERROR_CODE
  | typeof EXEC_OUTPUT_TOO_LARGE_ERROR_CODE;

/**
 * Who lost a Session to a `forceTakeover`.
 *
 * A takeover always succeeds — that is D7, and a result field saying "yes it
 * worked" would carry no information. What varies is whether anybody was
 * actually evicted, and a client should not report having taken a Session off
 * another client when the Session was sitting unlocked.
 */
export type CoreLinkSessionTakenFrom = "nobody" | "another-connection" | "this-connection";

// ─── Published lock state (issue 145, ADR 0024 D8) ──────────────────────────
//
// Lock state is **published, not discovered by failing**. A Reader has to render
// its terminal non-editable *before* anyone types, `actana session ls` has to
// show it, and the loser of a force takeover has to learn it when it happens
// rather than on its next keystroke — none of which the refusal above can do,
// because a refusal only ever arrives after the mutation it refuses.
//
// Two surfaces carry it and they answer different questions. The **snapshot**
// ({@link CoreLinkSessionLock}, below, on {@link CoreLinkTaskSnapshot} and
// {@link CoreLinkSessionSnapshot}) answers "can I write to this, right now"; the
// **event** ({@link SESSION_LOCK_CHANGED_EVENT_KIND}) answers "something about
// this Session's lock just changed, go look". Neither names a client.

/**
 * How a Session's lock looks **to the one connection this snapshot was sent
 * to** (ADR 0024 D8).
 *
 * This field is *addressed*, not global: two connections listing the same
 * Session are told different things about it, and that is the whole point. A
 * snapshot that reported "locked: true" and left the recipient to work out
 * whether the holder was itself would make every client carry the comparison,
 * and every client would need an identity to compare against — which is exactly
 * the identity D10 says the lock does not have and D3 keeps below the socket.
 *
 * So it says **whether you hold it**, never **who holds it**. `held-by-another`
 * is the whole of what a watcher learns about a holder that is not itself: no
 * client id, no connection id, no label, nothing that a second client could
 * correlate a person or a program with.
 *
 * `writable` is the answer and `state` is why. The two are not redundant: which
 * states are writable is a Core-side rule — an *unlocked* Session is writable by
 * anybody, which is the D11 compatibility promise (see
 * {@link SESSION_LOCKED_ERROR_CODE}) rather than an obvious property of the
 * word "unlocked" — and publishing the answer keeps that rule in the one place
 * that enforces it. A client rendering an editable terminal reads `writable`; a
 * client choosing between a "Claim" and a "Take over" affordance reads `state`.
 */
export type CoreLinkSessionLock = {
  /**
   * May the connection that was sent this snapshot mutate this Session right
   * now? True when the Session is unlocked as well as when this connection
   * holds it — the gate refuses only a Session **another** connection holds.
   */
  writable: boolean;
  /** Which of the three states this Session is in, from that connection's side. */
  state: CoreLinkSessionLockState;
};

/**
 * The three states a Session's lock can be in for one connection.
 *
 * There is no fourth, and deliberately no name for the holder. `unlocked` is a
 * real state (D5) and not an absence: a Session starts there, returns there on
 * release, on the holder's connection dropping, and on a Core restart (D12).
 */
export type CoreLinkSessionLockState = "unlocked" | "held-by-you" | "held-by-another";

/**
 * The kind appended to the event log on every Session-lock change (ADR 0024 D8).
 *
 * A **dedicated kind**, following the precedent ADR 0022 set for
 * `project:appearanceChanged` — and for the same reason both ADR 0017 and ADR
 * 0022 rejected the alternative. Widening an existing mutation event to carry
 * lock state would stop the frame documenting what changed: every client would
 * have to refetch on every `task:updated` to find out whether this one was
 * about the lock, and a reconnecting client replaying a tail could not tell a
 * takeover it needs to react to from a title edit it does not.
 *
 * Payload is {@link CoreLinkSessionLockChangedPayload}. It rides the ordinary
 * event log, so it replays by cursor exactly like every other event: a client
 * that was away comes back, sends `subscribe { lastEventId }`, and reads the
 * lock changes it missed in order, distinctly, alongside everything else.
 */
export const SESSION_LOCK_CHANGED_EVENT_KIND = "session:lockChanged";

/**
 * The kind of the event the Core appends when it accepts a **stamped** write
 * for a Session (#289 A).
 *
 * It exists to be a cursor, not a notification. A client that is about to wait
 * for the turn a write starts needs one fact the event log could not otherwise
 * give it: *where in the log the write landed*. With that id in hand the wait is
 * "the first settling status for this task after event N", which is a question
 * with one answer — and not "is this Session settled?", which answers with the
 * status the Session was already sitting at before the write (the `settledNow`
 * short-circuit in `core-session.ts`, and the reason this event exists).
 *
 * Payload is {@link CoreLinkSessionDeliveredPayload}. Appended only for a write
 * that asked to be stamped and that the PTY accepted, and only when the Core can
 * name the Task behind the PTY — the id is what the cursor is *for*.
 */
export const SESSION_DELIVERED_EVENT_KIND = "session:delivered";

/**
 * Payload of a {@link SESSION_DELIVERED_EVENT_KIND} event.
 *
 * The Task, the PTY and how many characters went in — no text. What was typed
 * into a Session is the Session's, and this row goes into a log every connection
 * replays; a length is enough for an operator reading `actana events tail` to
 * tell a prompt from a keystroke, and carries nothing a transcript would not
 * already show to somebody entitled to see it.
 */
export type CoreLinkSessionDeliveredPayload = {
  taskId: string;
  ptyId: string;
  /** Characters accepted, not bytes on the wire. */
  characters: number;
};

/**
 * What happened to a Session's lock, in the vocabulary of the lock rather than
 * of the frame that caused it.
 *
 * A `forceTakeover` against a Session **nobody** held is a `claimed`, not a
 * `taken-over`: the wire says what happened to the lock, so no client reports an
 * eviction that did not occur. The same distinction `CoreLinkSessionTakenFrom`
 * draws for the requester, drawn once more for everybody watching.
 *
 * Open by construction — a reader that meets an unfamiliar transition falls back
 * to `locked` on the payload, which is why that field is there.
 */
export type CoreLinkSessionLockTransition = "claimed" | "released" | "taken-over";

/**
 * Payload of a {@link SESSION_LOCK_CHANGED_EVENT_KIND} event.
 *
 * **It names no client, and it must not.** This row goes into a shared log that
 * every connection replays: anything identifying in it would be broadcast to
 * every watcher of the Core, which is the identity leak D10 (the lock is
 * coordination, not security) and D3 (the holder is a connection, not a person)
 * exist to prevent. A takeover therefore names neither winner nor loser, and
 * needs to name neither: the winner learns it won on its own
 * `forceTakeoverResult`, and every other connection reads `taken-over` as "the
 * holder is now somebody who is not me" — which is the entire fact a loser needs
 * and the only one an identity could have added.
 *
 * "Can *I* write to it now" is deliberately not answered here. It cannot be: one
 * logged row is read by every connection, and the answer differs per connection.
 * That question is the snapshot's ({@link CoreLinkSessionLock}), and this event
 * is what tells a client the answer has moved.
 */
export type CoreLinkSessionLockChangedPayload = {
  /** The Session whose lock changed. Also on the event row's `taskId` column. */
  taskId: string;
  /** What happened to the lock. */
  transition: CoreLinkSessionLockTransition;
  /**
   * Is the Session held by some connection now? Derivable from every transition
   * this build defines, and carried anyway: a client can act on the state
   * without knowing the whole transition vocabulary, which is what keeps a
   * transition added later from silently reading as "no change" to a client that
   * predates it.
   */
  locked: boolean;
};

// ─── Client → Server (Panel → Core) ──────────────────────────────────────

export type CoreLinkRequestFrame =
  | { type: "spawn"; reqId: string; opts: CoreLinkPtySpawnOptions }
  | {
      type: "write";
      reqId: string;
      ptyId: string;
      data: string;
      /**
       * Ask the Core to **stamp this delivery in its event log** and answer with
       * the id it got (#289 A). Opt-in, and the opt is what keeps the log
       * usable: an attached terminal's keystrokes are `write` frames too, and a
       * log that is append-only for the life of a Core must not carry a row per
       * keypress. A client that is about to wait for the turn this write starts
       * sets it; a client that is typing does not.
       *
       * Absent on a Core too old to stamp, which answers `writeResult` with no
       * {@link CoreLinkResponseFrame} `deliveryEventId` — read as 0, "not
       * stamped", never as a cursor.
       */
      stamp?: boolean;
    }
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
  // ─── PTY output subscription (issue 142, ADR 0024 D2) ───
  // Which PTYs this connection wants the byte stream of. A Core serves many
  // clients now, and `data`/`exit` reach only the connections that asked for
  // that `ptyId` — a CLI attached to one Session must not receive every other
  // Session's output on the machine, continuously.
  //
  // Idempotent in both directions: subscribing twice delivers each chunk once,
  // unsubscribing twice is not an error. Subscriptions are connection state and
  // die with the socket; a reconnecting client re-subscribes.
  //
  // `catchUp` names the ordering contract, and exists because subscribe-then-
  // replay has a gap: between the subscription taking effect and the catch-up
  // being served, the PTY can emit. With `catchUp: true` the Core holds this
  // pty's `data`/`exit` for this connection, serves the client's next
  // {@link CoreLinkRequestFrame} `replay` for it, then drains what it held past
  // that window's `nextSeq` and goes live — so a client never paints live bytes
  // in front of its own scrollback. A client that sets it MUST send that
  // `replay`; nothing else releases the hold. Omitted (the default) the stream
  // goes live immediately, which is what a client with no scrollback to
  // reconcile wants.
  //
  // Catch-up deliberately reuses `replay { ptyId, sinceSeq }` rather than
  // inventing a second cursor: `data` frames already carry `seq`, and this is
  // the same subscribe-then-replay-from-a-cursor shape the event log uses.
  | { type: "ptySubscribe"; reqId: string; ptyId: string; catchUp?: boolean }
  | { type: "ptyUnsubscribe"; reqId: string; ptyId: string }
  // ─── Session lock (issue 144, ADR 0024 D3–D7) ───
  // See the commentary above {@link SESSION_LOCKED_ERROR_CODE}. All three name
  // a Session by `taskId`, and all three are refused by a client that has not
  // seen `multiConnection` on `ready` — a single-connection Core has no lock
  // table to address.
  //
  // `claim` is idempotent for the connection that already holds the Session and
  // denied (changing nothing) when another connection does. Getting past
  // another holder is `forceTakeover` and nothing else, so a retry loop can
  // never take a Session out from under a working client by accident.
  | { type: "claim"; reqId: string; taskId: string }
  // Releasing a Session this connection does not hold changes nothing and is
  // not an error — a stale client saying so is talking about a lock it lost,
  // not instructing the Core to unlock somebody else's Session.
  | { type: "release"; reqId: string; taskId: string }
  // Unconditional, immediate, and unrecoverable by design: the previous
  // holder's in-flight keystrokes are gone and its next mutation is refused.
  // This is the answer to a hung client — the reason D7 needs no idle timeout.
  | { type: "forceTakeover"; reqId: string; taskId: string }
  // ─── Stable client id, for reaping only (issue 146, ADR 0024 D9) ───
  // "I am the same Core client as the connection that last presented this id.
  // Close it and give me its Session locks." That is the whole of it.
  //
  // It exists because D1 took evict-on-connect away. A Core client whose link
  // dies without a TCP close — a laptop lid, a partitioned container — leaves a
  // socket the Core cannot tell from a live one until the heartbeat reaps it
  // 45s later, still holding that client's Sessions. The heartbeat is still the
  // backstop for a client that never comes back; this frame is the answer for
  // the one that does, and it answers in a single round trip rather than in 45
  // seconds.
  //
  // **The id is not identity and not authentication** (D10, and D9 says it
  // twice). Nothing signs it, nothing verifies it, and presenting one buys
  // exactly nothing that a connection did not already have: it is refused
  // before `auth` like every other frame, it never makes an unauthenticated
  // connection authenticated, and the authority it can move — a Session lock —
  // is authority any authenticated connection can already take unconditionally
  // with `forceTakeover`. A client presenting another client's id is the case
  // reviewers reach for; the answer is that whoever opened this link already
  // holds the bearer, and a bearer holder can open a VM Shell Session and kill
  // the process directly. Hardening this string is theatre, and signing it
  // would be building D10's rejected per-client credential by the back door.
  //
  // **Where the id comes from is per Core client, and never the registration
  // blob.** The blob is machine-scoped — every client on that machine dials
  // with the same one — so an id derived from it would make the Panel, the CLI
  // and every automation on the box a single connection, each reconnect
  // reaping the others. The Panel keeps one per link it terminates; the CLI
  // mints one per invocation, which is right for a process that is one client
  // for as long as it runs and nobody afterwards.
  //
  // Multi-connection-only: a Core that evicts every client but one already does
  // this on connect, and has no lock table to transfer out of.
  | { type: "reclaim"; reqId: string; clientId: string }
  // ─── Task ops (issue 02 — schema carries task ops keyed by taskId) ───
  | { type: "tasksList"; reqId: string; projectId?: string }
  // The Archived view's own read path (issue 62, ADR 0019). Deliberately a
  // second frame rather than a flag on `tasksList`: archived rows then cannot
  // ride the active/Fleet answer whatever a caller passes. Sent only while
  // that view is open — the count that gates it rides `tasksListResult`.
  | { type: "archivedTasksList"; reqId: string; projectId?: string }
  | { type: "tasksMutate"; reqId: string; mutation: CoreLinkTaskMutation }
  /**
   * A prompt the operator submitted, for a harness whose hooks do not report
   * one (issue 84).
   *
   * Cursor's `beforeSubmitPrompt` never fires in cursor-agent, so the Panel
   * reads the prompt off the terminal instead — and that is the only copy
   * anyone has. Without a way to hand it to the owning Core, a Core-owned
   * Cursor Session could never be named at all: the Core's title generator
   * had nothing to name it from, and the Panel's names only Panel rows.
   *
   * It patches no column. The Core takes it as the trigger its own hook
   * receiver would otherwise have supplied, and the same rules apply — a
   * Session that already has a real title, or one the operator renamed, is
   * left alone.
   */
  | { type: "harnessPrompt"; reqId: string; taskId: string; prompt: string }
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
  // ─── Install a missing Harness (issue 83) ───
  // Names one Harness for the Core that owns the machine to install. Answered
  // by `harnessInstallAck` the moment the Core has started (or refused) it —
  // the outcome arrives on the event log, never on this request. See the
  // commentary above {@link HARNESS_INSTALL_FAILED_EVENT_KIND}.
  | { type: "harnessInstall"; reqId: string; harness: string }
  // ─── Directory browsing (web-panel issue 06) ───
  // `path` omitted or null means "start at the Core's home directory" —
  // the Panel cannot compute that itself for a machine it has never seen.
  | { type: "dirList"; reqId: string; path?: string | null }
  | { type: "dirCreate"; reqId: string; parent: string; name: string }
  // ─── Run one command on the Core, non-interactively (issue 266) ───
  // The PTY vocabulary above cannot express this and never could: a PTY is one
  // byte stream by construction, so there is no frame here that returns stdout
  // and stderr apart, and no exit status distinguishable from what the shell
  // printed. That is why this pair exists and why the protocol version moves
  // for it — see {@link CORE_LINK_PROTOCOL_VERSION}.
  //
  // `command` and `args` are an argv, never a shell string: the Core spawns
  // the executable directly with no shell in between, so nothing here has
  // quoting or globbing semantics. A caller that wants a shell asks for one by
  // name (`sh`, `-c`, `…`), which is a decision it has made rather than one
  // this frame made for it.
  //
  // `cwd` omitted means the Core's own home directory. A cwd the Core refuses
  // comes back as an `error` frame carrying the Core's own message — one place
  // validates a path, and it is the machine that owns the disk.
  | {
      type: "exec";
      reqId: string;
      command: string;
      args: string[];
      cwd?: string | null;
    };

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

/**
 * The `multiConnection` capability, announced on `ready` (ADR 0024 D11).
 *
 * `version` is the capability's own number, independent of
 * {@link CORE_LINK_PROTOCOL_VERSION} — it moves when the multi-connection
 * surface itself changes shape, and nothing about it marks a Core stale.
 */
export type CoreLinkMultiConnectionCapability = { version: 1 };

/**
 * The `files` capability, announced on `ready` (#165 F9, ADR 0024 D11).
 *
 * Says that this Core answers the `/v1/projects/:projectId/files` routes on its
 * **HTTPS origin** — the same server this WebSocket is mounted on, reachable at
 * {@link CoreConnection.httpsBaseUrl}. Nothing about the capability changes the
 * core link itself: no frame is added, none changes meaning, and not one byte
 * of a file transfer crosses this socket (ADR 0028).
 *
 * `version` is the capability's own number, independent of
 * {@link CORE_LINK_PROTOCOL_VERSION} — it moves when the file surface changes
 * shape, and nothing about it marks a Core stale.
 */
export type CoreLinkFilesCapability = { version: 1 };

/** Response frame — correlates to a request via `reqId`. */
export type CoreLinkResponseFrame =
  | {
      type: "ready";
      version: string;
      /**
       * Present on a Core that serves many core-link connections at once
       * (ADR 0024 D1). Absent means the single-connection Core: it evicts the
       * previous socket on connect, holds no Session locks and has no
       * per-connection subscriptions.
       *
       * Absence is a supported state, not a fault. Every frame that only makes
       * sense against a multi-connection Core is withheld by the client when
       * this is absent (see `MULTI_CONNECTION_ONLY_FRAME_TYPES` in the Panel's
       * core-link client); everything else behaves exactly as it does today, so
       * such a Core is connected and fully usable, never "needs update".
       */
      multiConnection?: CoreLinkMultiConnectionCapability;
      /**
       * Present on a Core that answers the `/v1/…` file routes over HTTPS
       * (#165 F9). Absent means a Core with no file surface — every core-link
       * frame behaves identically, because none of them was ever about files.
       *
       * Absence is a supported state and not a fault, on exactly the terms
       * `multiConnection` set: a newer Panel reads the absence and does not
       * offer the affordance, an older Panel never looks at the field, and
       * neither is "needs update". The gate is a client-side capability check
       * before an HTTPS call, not a withheld frame, because there is no frame
       * to withhold.
       */
      files?: CoreLinkFilesCapability;
    }
  | {
      type: "spawned";
      reqId: string;
      ptyId: string;
      /**
       * Will a hook report the START of a turn for this Session (issue 84)?
       *
       * The Panel's terminal-input fallback stands down on this and nothing
       * else. It is deliberately narrower than "hooks were installed": Cursor
       * takes our hooks file but never fires `beforeSubmitPrompt`, and Codex
       * refuses to run newly-installed hooks until the operator reviews them
       * with `/hooks` — both would report a turn's END and leave its start
       * unannounced. Suppressing the fallback on either is a Session with no
       * `running` signal at all, which is the bug this replaced.
       *
       * Absent from an older Core's answer, which reads as "no" — a redundant
       * `running` write, never a silent card.
       */
      hooksReportTurnStart?: boolean;
    }
  | { type: "spawnError"; reqId: string; message: string }
  | {
      type: "writeResult";
      reqId: string;
      ok: boolean;
      /**
       * The event id of the `session:delivered` this write was stamped with,
       * when the frame asked for a stamp and the write was accepted (#289 A).
       *
       * The cursor a turn-end wait counts from: the wait resolves on the first
       * settling status for that task at an event id **strictly greater** than
       * this one, which is what stops it from answering with the status the
       * Session was already sitting at. 0 or absent means nothing was stamped —
       * a Core that predates this, a write nothing accepted, or a PTY with no
       * Task behind it — and 0 is not a cursor.
       */
      deliveryEventId?: number;
    }
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
  // ─── PTY output subscription responses (issue 142) ───
  // `subscribed` is the connection's state AFTER the frame, not what changed —
  // that is what makes both frames idempotent to act on: a client that has lost
  // track re-sends and reads the answer, rather than having to remember whether
  // it was the first to ask. `holding` is true while the Core is holding this
  // pty's output for a `catchUp` subscription that has not had its `replay`
  // served yet.
  | {
      type: "ptySubscribeAck";
      reqId: string;
      ptyId: string;
      subscribed: true;
      holding: boolean;
    }
  | { type: "ptyUnsubscribeAck"; reqId: string; ptyId: string; subscribed: false }
  // ─── Session lock responses (issue 144, ADR 0024 D3–D7) ───
  // A denied claim is a `claimResult { granted: false }`, not an `error`: the
  // Session being held by another connection is an answer to the question, and
  // the caller's next move (watch it, or force a takeover) is the same whether
  // or not it was expecting one. The `error` frame is reserved for a *mutation*
  // that was refused, which is the case a caller has to be able to tell apart
  // from a Session that is gone.
  | { type: "claimResult"; reqId: string; taskId: string; granted: boolean }
  // `released: false` means this connection did not hold it — idempotent, not
  // an error. A client releasing on teardown does not have to know whether it
  // already lost the lock to a takeover.
  | { type: "releaseResult"; reqId: string; taskId: string; released: boolean }
  | {
      type: "forceTakeoverResult";
      reqId: string;
      taskId: string;
      takenFrom: CoreLinkSessionTakenFrom;
    }
  // ─── Stable client id (issue 146, ADR 0024 D9) ───
  // What the reclaim actually did, which is not something a client can work out
  // for itself: it does not know whether the socket it lost was still open on
  // the Core, nor which Sessions that socket was still holding when it went
  // quiet — a lock can also have been force-taken while the client was away.
  //
  // `replaced` is whether a predecessor connection was found and closed;
  // `taskIds` are the Sessions that came across with it, which is often empty
  // and never implies the id was unknown. Both are reporting, not authority:
  // this frame's answer is the same for a client presenting its own id as for
  // one presenting a string it made up, because nothing verifies it.
  | {
      type: "reclaimResult";
      reqId: string;
      clientId: string;
      replaced: boolean;
      taskIds: string[];
    }
  // ─── Task / session / hook op responses (issue 02) ───
  // `tasks` carries active rows only. `archivedCount` is how many archived rows
  // the same scope holds — unconditional, and never accompanied by the rows
  // themselves. It is what lets the Panel gate and label the Archived tab
  // without an archived row ever crossing this frame (issue 62, ADR 0019); the
  // rows come back on `archivedTasksListResult` when that view opens.
  | {
      type: "tasksListResult";
      reqId: string;
      tasks: CoreLinkTaskSnapshot[];
      archivedCount: number;
    }
  | { type: "archivedTasksListResult"; reqId: string; tasks: CoreLinkTaskSnapshot[] }
  | { type: "tasksMutateResult"; reqId: string; task: CoreLinkTaskSnapshot | null }
  /**
   * Was the prompt taken up? `false` means this Core has no title generator
   * wired — not that the Session was left unnamed for a reason, which is a
   * normal outcome the Core does not report on.
   */
  | { type: "harnessPromptResult"; reqId: string; accepted: boolean }
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
  // ─── Install a missing Harness (issue 83) ───
  // Deliberately an ack: it says the install started, not how it ended.
  | ({ type: "harnessInstallAck"; reqId: string } & CoreLinkHarnessInstallAck)
  // ─── Directory browsing (web-panel issue 06) ───
  | { type: "dirListResult"; reqId: string; listing: CoreLinkDirListing }
  | { type: "dirCreateResult"; reqId: string; path: string }
  /**
   * One finished command (issue 266).
   *
   * **Buffered, and separated.** Both streams are captured whole and handed
   * back apart, which is what makes them parseable and what a PTY cannot do.
   * Neither carries terminal escape sequences, because no terminal was
   * involved: the child is spawned with pipes, so a program that colours its
   * output when it sees a TTY does not see one here.
   *
   * `exitCode` is the command's real status, propagated rather than
   * interpreted. It is null exactly when the command was killed by a signal,
   * in which case `signal` names it — the two are never both null and never
   * both set. A client turns that pair into its own exit status; nothing here
   * assumes the POSIX `128 + n` convention on the client's behalf.
   *
   * Output that exceeds the Core's bound does NOT arrive here truncated. It
   * arrives as an `error` carrying {@link EXEC_OUTPUT_TOO_LARGE_ERROR_CODE}.
   */
  | {
      type: "execResult";
      reqId: string;
      exitCode: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
    }
  /**
   * `code` is optional and additive (issue 144): it exists so a client can act
   * on *why* a request failed without matching on prose. Absent on every error
   * that shipped before it, which is why nothing may require it — a client
   * reads the code when it is there and falls back to the message when it is
   * not. See {@link SESSION_LOCKED_ERROR_CODE}, its first and so far only value.
   */
  | { type: "error"; reqId?: string; message: string; code?: CoreLinkErrorCode };

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
  /**
   * This Session's lock, as it looks to the connection this snapshot was sent
   * to (issue 145, ADR 0024 D8). See {@link CoreLinkSessionLock} — it says
   * whether *you* may write, never who else holds it.
   *
   * Optional, and absent means "this Core does not publish lock state", which
   * is the single-connection Core that shipped before the capability. Absence
   * therefore yields exactly today's behaviour — no read-only rendering,
   * because there is no lock table to be a Reader of — which is what lets this
   * ride the `multiConnection` capability instead of moving
   * {@link CORE_LINK_PROTOCOL_VERSION}, as #142, #143 and #144 did before it.
   * A Core that announces `multiConnection` always sets it.
   *
   * Stamped by the server as the snapshot goes out, not read from a row: the
   * lock table is in memory (D12) and the answer depends on who is asking, so
   * no query port can produce it and no two recipients need get the same value.
   */
  lock?: CoreLinkSessionLock;
};

/** A session snapshot — a task's live or replayable conversation. */
export type CoreLinkSessionSnapshot = {
  taskId: string;
  ptyId: string | null;
  status: string;
  updatedAt: number;
  /**
   * This Session's lock, as it looks to the connection this snapshot was sent
   * to (issue 145, ADR 0024 D8) — the same field, on the same terms, as the one
   * on {@link CoreLinkTaskSnapshot}, because a client reading either of them is
   * asking the same question about the same Session.
   *
   * This is the one `actana session ls` reads: it lists Sessions, and "can I
   * write to this" is what it has to show about each. Optional for the reason
   * given above — absent is the Core that does not publish lock state.
   */
  lock?: CoreLinkSessionLock;
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
 * Issue 62 adds the `archivedTasksList` / `archivedTasksListResult` frames and
 * an unconditional `archivedCount` on {@link CoreLinkServerFrame}'s
 * `tasksListResult` → 0.12.0 (ADR 0019). Archived rows had no way across the
 * link at all, so the Panel's Archived view was permanently empty for a Core
 * and restore could not be invoked. The count is required rather than
 * optional: a Core on 0.11.0 would answer without it and the Archived tab
 * would silently never appear, which is exactly the bug — so the minor moves
 * and such a Core renders as "needs update".
 * Issue 84 adds `titleManuallySet` and `claudeSessionId` to
 * {@link CoreLinkTaskSnapshot} and to the `update` variant of
 * {@link CoreLinkTaskMutation}, plus `hooksReportTurnStart` on the `spawned`
 * response, and the `harnessPrompt` frame that carries a terminal-captured
 * prompt to the Core that can act on it → 0.13.0 (ADR 0020). The snapshot
 * fields are the load-bearing part: a Core that grew them without this bump
 * would hand a Panel that predates it a snapshot whose rename protection is
 * silently absent, and a Panel that predates the Core would keep synthesizing
 * `false` — both render a Session the generator is free to rename out from
 * under its operator. Same rule as above: the minor moved, so either side on
 * 0.12.0 is "needs update" rather than a partial snapshot nobody notices. No
 * migration rides along — the columns (`title_manually_set`,
 * `claude_session_id`) have been in the shared schema bootstrap since the
 * fork; only the wire and the Core's readers/writers of them are new.
 * Issue 83 adds the `harnessInstall` request frame, its `harnessInstallAck`
 * response, and the `harness:installFailed` event kind → 0.14.0 (ADR 0021).
 * Availability crossed the link Core→Panel only, so a missing CLI was a wall:
 * the picker greyed the row out and told the operator to go run a command on
 * another machine. This is the trigger that was absent — the Core still owns
 * probing and installing, and still publishes availability as the one source of
 * truth. Same rule as the bumps above: the minor moved, so a Core on 0.13.0
 * renders as "needs update" rather than one that silently drops the frame.
 * Issue 98 adds an `appearance` op to {@link CoreLinkProjectMutation} and the
 * `project:appearanceChanged` event kind the Core appends for it → 0.15.0
 * (ADR 0022). A project's icon and icon colour are Core facts that `create`
 * could set and nothing could change afterwards, so the Edit-project dialog
 * PATCHed them at a Panel row a Core-owned project does not have, and 404'd with
 * the rename already applied. Same rule as above: the minor moved, so a Core on
 * 0.14.0 is "needs update" rather than one that takes the frame and drops the
 * op. The columns (`icon`, `icon_color`) have been in the shared schema
 * bootstrap since the fork, so no migration rides along on the Core's side.
 *
 * Issue 142 adds the `ptySubscribe` / `ptyUnsubscribe` frames and their acks —
 * and deliberately **does not move this version** (ADR 0024 D11). Every bump
 * above marks every Core in every fleet needs-update, and multi-connection is a
 * capability a one-Panel fleet never exercises. It is announced on `ready`
 * instead, by #143 below, which also gates the Panel's sends on it, so these
 * frames are never put on the wire to a Core that cannot answer them.
 *
 * Issue 143 adds the optional `multiConnection` capability to the `ready`
 * frame and deliberately does NOT move this version (ADR 0024 D11). It is the
 * first entry in this log that does not: the field is additive and its absence
 * is the single-connection Core that shipped before it, which is exactly
 * today's behaviour rather than a lesser one. Moving the minor would mark every
 * Core in every fleet "needs update" to buy a capability a one-Panel fleet
 * never exercises. A capability that changed what an existing frame means
 * would not qualify, and the minor would move as it does above.
 *
 * Issue 144 adds the Session lock's `claim` / `release` / `forceTakeover`
 * frames, their results, and the optional `code` on `error` — and does NOT move
 * this version either (ADR 0024 D11), for the same reason #142 and #143 did not.
 * The three frames are gated by the `multiConnection` capability, so they are
 * never put on the wire to a Core that has no lock table to address. The gating
 * of `write` / `kill` / `tasksMutate` is additive in the sense the rule
 * requires: it can only refuse a Session that some connection has explicitly
 * claimed, and a client that never claims — every client that predates this —
 * meets an unlocked Session and is served exactly as it is today. `code` is
 * optional and absent from every error frame that shipped before it, so a client
 * that has never heard of it reads the same `message` it always did.
 *
 * Issue 145 publishes that lock state — the optional `lock` on
 * {@link CoreLinkTaskSnapshot} and {@link CoreLinkSessionSnapshot}, and the
 * {@link SESSION_LOCK_CHANGED_EVENT_KIND} event — and does NOT move this version
 * either (ADR 0024 D11), for the fourth time and the same reason. Note that
 * issue 84 *did* bump for snapshot fields, and the difference is the rule
 * itself: a Panel that predated `titleManuallySet` synthesized `false` and
 * rendered a Session its Core's generator could rename out from under the
 * operator — the absence yielded something *lesser* than today. A Panel that
 * predates `lock` ignores an unknown field and renders exactly what it renders
 * today, because read-only rendering is new surface (#147) rather than a
 * protection quietly going missing; a new Panel against a Core that omits the
 * field reads "no lock table here", which is that Core, truthfully. The event
 * kind is additive in the way every kind before it was: a client routes on kinds
 * it knows and ignores the rest.
 *
 * Issue 146 adds the `reclaim` frame and its `reclaimResult` — and does NOT
 * move this version either (ADR 0024 D11), for the fifth time and the same
 * reason. The frame is gated by the `multiConnection` capability, as #142 and
 * #144 are, so it is never put on the wire to a Core with no lock table to
 * transfer out of — and a Core that predates the capability evicts every client
 * but one on connect, which is the reclaim the frame would have asked it for.
 * The client that presents no id — every client that shipped before this — is
 * served exactly as it is today: its lost socket is reaped by the heartbeat 45s
 * later, still the backstop for a client that never comes back. What the frame
 * buys is those 45 seconds for the client that does come back, so its absence
 * is slower rather than lesser, which is the rule. `clientId` is not identity
 * and carries no authority a connection did not already have (D10), so there is
 * nothing here for an older client to be missing.
 *
 * Issue 165 adds the optional `files` capability to the `ready` frame — and
 * does NOT move this version either (ADR 0024 D11), for the sixth time and, for
 * the first time, on a surface that is not the core link at all. The file
 * routes live on the Core's HTTPS origin (ADR 0028), so there is no frame here
 * to add, none to gate, and no existing frame whose meaning changes: the
 * capability is a pointer at a second protocol on the same socket's server.
 * That makes the "absence yields exactly today's behaviour" test trivially
 * true — a Core without it is a Core that has no file surface, which is every
 * Core that has ever shipped, and its core link is byte-for-byte what it was.
 * Both mismatch directions are therefore ordinary: an older Panel against a
 * Core that announces `files` never reads the field and drives that Core
 * exactly as it does today, and a newer Panel against a Core that omits it
 * reads the absence and withholds the affordance rather than calling a route
 * that would 404. Neither is "needs update", which is the whole point of D11 —
 * and it is why `CORE_LINK_PROTOCOL_VERSION` staying at 0.15.0 through all six
 * of those was a decision rather than an oversight.
 *
 * **Issue 266 moves it to 0.16.0, and that is a decision too.** `actana core
 * exec` adds the `exec` request frame and its `execResult`, and it is the
 * first addition since 0.15.0 that the narrow additive exception does not
 * cover. The two options, weighed the way the six above were:
 *
 *   - *Announce a capability on `ready` and leave the version alone.* The
 *     exception is only available where the capability's absence yields
 *     today's behaviour **exactly**. It does here in the strict sense — a Core
 *     with no `exec` frame behaves precisely as it does today, and the CLI
 *     could refuse cleanly. But absence would not be a *supported state* the
 *     way `multiConnection` and `files` absence is. Those describe a Core that
 *     is fully usable without them, and no verb exists whose whole purpose is
 *     the missing surface. `actana core exec` against a Core that cannot exec
 *     is not a withheld affordance; it is the command not working. ADR 0005's
 *     answer to that is *one chore on that machine*, said once and early —
 *     never a per-verb refusal the operator meets later.
 *   - *Move the minor.* The Panel and its Cores are version-locked, a
 *     mismatched Core renders as "needs update" with the command to run, and
 *     `core status` already reports both versions and exits non-zero on a
 *     mismatch. Every client learns the same fact in the same place, and the
 *     CLI's own connect gate (`core-connection.ts`) refuses before a frame
 *     goes out rather than after an `error` comes back.
 *
 * The second is what ADR 0024 D11 means by an addition that is not the
 * additive case, so the minor moves and no capability is announced for `exec`.
 * A Core on 0.15.0 still answers every frame it always did; a client on 0.16.0
 * tells its operator to update one of the two, in one sentence, before the
 * first `exec` rather than after it.
 *
 * **Issue 289 moves it to 0.17.0, on the same reasoning and a stronger case.**
 * The stamped `write` — {@link CoreLinkRequestFrame} `stamp`, answered with
 * `deliveryEventId` — looks like the additive exception and is not it. The
 * exception is available only where the capability's absence yields today's
 * behaviour **exactly**, and here absence yields something worse than today:
 * `actana session send X --wait` is a clean usage refusal on a Core built
 * before this, and a client that shipped the flag against an unstamping Core
 * would send, get no cursor back, and fall through to an uncursored wait that
 * answers instantly with the status the Session was already parked at — last
 * turn's answer printed as this turn's, with a zero exit. A silent wrong
 * answer replacing a hard error is the one degradation the exception exists to
 * forbid, so the minor moves and no capability is announced for the stamp.
 *
 * The cursor is refused rather than approximated in the client as well
 * ({@link CoreLinkResponseFrame} `deliveryEventId`, and the CLI's session
 * gateway): the version gate is what an operator meets first, and the refusal
 * is what covers a Core that is on this version and still could not stamp —
 * one with no event-log port, or whose append failed.
 *
 * Patch stays 0 — see {@link coreLinkProtocolCompatible}, which compares
 * major.minor only.
 */
export const CORE_LINK_PROTOCOL_VERSION = "0.17.0";

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

/**
 * Read the `multiConnection` capability off a raw `ready` frame, or null.
 *
 * Null for every shape that is not exactly `{ version: 1 }` — absent, a
 * non-object, or a version this build does not know. An unrecognised future
 * version reads as absent on purpose: the safe fallback is the single-connection
 * behaviour that predates the capability, never a guess at what a higher version
 * means. Unlike {@link coreLinkProtocolCompatible}, nothing here can mark a Core
 * incompatible — a null answer withholds frames, it does not fail a Core.
 */
export function readMultiConnectionCapability(
  raw: unknown,
): CoreLinkMultiConnectionCapability | null {
  if (!raw || typeof raw !== "object") return null;
  const version = (raw as { version?: unknown }).version;
  return version === 1 ? { version: 1 } : null;
}

/**
 * Read the `files` capability off a raw `ready` frame, or null (#165 F9).
 *
 * The same rule as {@link readMultiConnectionCapability}, for the same reason:
 * null for every shape that is not exactly `{ version: 1 }` — absent, a
 * non-object, or a version this build does not know. **An unrecognised future
 * version reads as absent on purpose.** A Core announcing `{ version: 2 }` is
 * telling a client built against version 1 that its file surface is a shape
 * this client has never seen, and the safe answer is the no-file-surface
 * behaviour that predates the capability, never a guess that version 2 is a
 * superset. Nothing here can mark a Core incompatible.
 */
export function readFilesCapability(raw: unknown): CoreLinkFilesCapability | null {
  if (!raw || typeof raw !== "object") return null;
  const version = (raw as { version?: unknown }).version;
  return version === 1 ? { version: 1 } : null;
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
  "ptySubscribe",
  "ptyUnsubscribe",
  "claim",
  "release",
  "forceTakeover",
  "reclaim",
  "tasksList",
  "archivedTasksList",
  "tasksMutate",
  "harnessPrompt",
  "projectsList",
  "projectsMutate",
  "sessionsList",
  "hooksOp",
  "auth",
  "agentsAvailabilityList",
  "harnessInstall",
  "dirList",
  "dirCreate",
  "exec",
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
