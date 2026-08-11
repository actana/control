# Actana Control — Detached Core Domain

The domain that results from detaching the harness-running layer ("Core") from the UI layer ("Panel") so a self-hosted web Panel can manage one-or-more stateful Cores installed on any machines over a persistent bidirectional core-link.

## Language

### Topology

**Panel**:
The self-hosted web service the Operator deploys — one container (or Node process), typically behind a reverse proxy. Owns the Core registry — connection endpoints, auth material, aliases — terminates every core-link, and serves the Panel UI to browsers. Holds no task, session, or project state. A connection broker over the fleet, not a data store.
_Avoid_: control surface, frontend, client app, desktop app, backend

**Panel UI**:
The surface running in the Operator's browser tab, served by the Panel. Holds no connections to Cores and no fleet state beyond view preferences; everything live it shows arrives over its panel link.
_Avoid_: frontend, client, webapp

**Operator**:
The human who owns a Panel and every Core registered in it. Exactly one per Panel, created at first boot. A first-class entity — Cores belong to an Operator — so identity stays a thin, replaceable gate rather than an assumption baked into the registry.
_Avoid_: user, account, admin

**Panel session**:
An authenticated browser tab — the result of presenting the Panel password, carried by a session cookie. Owns one panel link while open.
_Avoid_: login, seat

**Panel link**:
The single multiplexed WebSocket between a Panel session and the Panel. Carries `coreId`-tagged frames — PTY streams, events, mutations, dial statuses — for all Cores at once, mirroring core-link framing. Server rendering covers first paint; the panel link carries everything live after it.
_Avoid_: socket, channel, API connection

**Core**:
A machine running the Actana Control daemon. Hosts projects, tasks and sessions; owns its own SQLite; the single source of truth for all work on that machine. A Panel drives zero-or-more Cores over the core-link.
_Avoid_: harness, server, backend, node, agent host

**Harness**:
The agentic coding CLI a session drives — `claude-code`, `codex`, `cursor-cli`, `opencode`. Installed on a Core, spawned into a PTY by it, and never touched by the Panel except as an id and an availability status. A Harness is a vendor's program that Actana runs, not a part of Actana. The family is **open**; any table or dispatch keyed by harness type must be extensible, and differences between harnesses live inside the Core process, never in the Panel.
_Avoid_: agent, task agent, AI runtime, tool, model

**Core link**:
The persistent bidirectional WebSocket connection between a Core client and a Core. Carries PTY streams, task mutations, hook events, and notifications as framed JSON messages. Long-lived; survives Panel sleep; replays missed events on reconnect via a monotonic event cursor.
_Avoid_: tunnel, channel, pipe, API

**Core client**:
Any program terminating a core link — the Panel, the `actana` CLI, an SDK automation. A Core serves many at once, each with its own event cursor, subscriptions and heartbeat, and none of them privileged: the Panel is a Core client like the others. The unit of write authority is the connection, not the human or the program behind it, so a client that reconnects is a new client until it says otherwise. See ADR 0024.
_Avoid_: consumer, subscriber, peer, client session

**Core alias**:
The name one Panel shows for a Core. Panel-local presentation, stored in that Panel's Core registry beside the endpoint and auth material — not a Core fact, and two Panels registering one Core are meant to disagree about it. The Core neither knows nor publishes it.
_Avoid_: core name, label, hostname, display name

### Ownership inside a Core

**Project** (Core-scoped):
A folder on the Core's machine that hosts harness workspaces. Path is a machine path on the VM, validatable only by the Core's OS. Owned by exactly one Core. Stored in that Core's SQLite, never on the Panel.
_Avoid_: workspace, repo (a project may be a repo, but not all repos are projects)

**Task** (Core-scoped):
A unit of harness work inside a Project — a run of opencode/claude/… against the project's files. Owns its session, terminal, and lifecycle state. Lives entirely on its Core.
_Avoid_: run, job, session (a session is a sub-part of a Task)
_UI note_: user-facing strings label a Task as "Session" (e.g. "Start a new session", the grid cells). This is a legacy UI convention retained for continuity — it collides with the domain **Session** below (the conversation stream). Code, types, DB columns, and core-link messages keep the name **Task**; only rendered strings say "Session".

**Session** (Core-scoped):
The live or replayable conversation backing a Task — the PTY stream plus the harness's own session id. A Core runs many sessions; each session drives exactly one Harness. Replayable after Panel reconnect via the Core's event log.
_Avoid_: conversation, thread

**Session lock** (Core-scoped):
The exclusive right of one Core client to mutate one Session — its writes, its kill, and every task mutation addressed at it. Held by a core-link connection, never by a person or a program; scoped to a single Session, so different Sessions on one Core may be held by different clients. A Session starts unlocked and its creator gets no privilege; claiming is an explicit gesture; the lock ends on release, on connection drop, or on force takeover, and never on idle. It lives in memory and dies with the Core, exactly like the PTYs it guards. **Published, not discovered by failing:** every Session snapshot carries the lock as the client it was sent to must be told it — whether *you* may write, never who holds it — and every change appends a `session:lockChanged` event that replays by cursor. See ADR 0024.
_Avoid_: session owner, mutex, reservation, ownership

**Reader** (Core-scoped):
A Core client attached to a Session it does not hold the **Session lock** on. It sees every byte and can write none of them. Many Readers, one writer, per Session — a Reader is the ordinary state of an attached client, not a degraded one, and a Panel tab rendering a Session it does not hold is read-only *before* the first keystroke rather than on the error that answers it.
_Avoid_: observer, spectator, participant, viewer, watcher

**VM Shell Session** (Core-scoped):
A free-form interactive shell on the Core's machine — distinct from harness workspaces. Spawned over the same core-link with `shellSession: true`, gated by core-link auth (not project-root validation), rendered in the Panel like a user terminal. The "SSH-equivalent" escape hatch. First-class concept, not a special case of harness PTY.
_Avoid_: ssh, terminal, console (too overloaded)

### Transport concepts

**Event**:
A discrete thing that happened on a Core — task status change, hook fired, question menu appeared, run finished, shell output. Has a monotonic `eventId` per Core. Persisted in the Core's SQLite; pushed live over the core-link; replayed by `lastEventId` cursor on Panel reconnect. The Panel never misses an event.
_Avoid_: message, notification (a notification is one *use* of an Event)

**Event cursor** (`lastEventId`):
The single number the Panel stores per Core — the highest Event id it has seen. Sent on reconnect to request the replay tail. The only per-Core state on the Panel beyond the Core registry.
_Avoid_: offset, sequence number

**PTY subscription** (per Core link):
One Core client's standing request for one PTY's byte stream. A Core sends a PTY's `data` and `exit` to the connections that asked for it and to no others, so a client attached to one Session never receives another's output. Held on the connection, so it dies with the socket and is re-asked for on reconnect. Catch-up is the existing `replay { ptyId, sinceSeq }`, ordered behind the subscription rather than in front of it (ADR 0024 D2).
_Avoid_: channel, stream registration, attach (an attach is the Panel gesture; this is what it asks for)

### Panel views

**Fleet view**:
A live, non-persisted Panel view that fans out `tasks.list` calls to every connected Core in parallel and merges results keyed by `coreId/taskId`. Purely an aggregate — scannable rows (status dot + title + harness + time + Core badge) with no session icons, pin toggles, or drill-down affordances. Clicking a Core exits Fleet view and enters **Per-Core navigation** for that Core. Offline Cores show "unreachable + last-seen timestamp" with no task rows.
_Avoid_: dashboard, overview

**Per-Core navigation**:
The Panel's primary work surface, scoped to a single Core: project rail → SessionGrid → TerminalPane. The same components render regardless of which Core is selected — this is the **Singular UI** invariant. Switching between Cores happens by returning to Fleet view and picking a different Core; the shell itself has no Core switcher. Each step is a live query to the chosen Core, no local persistence.
_Avoid_: browsing, explorer

**Session icon** (Core-scoped):
A per-Task glyph choice, stored on the owning Core alongside the Task. Rendered by the SessionGrid cell and the TerminalPane header. Editable by mutation over the core-link.
_Avoid_: avatar, badge

**Pinned Task / Pinned Project** (Core-scoped):
A pin flag stored on the owning Core against the Task or Project row. Toggled via core-link mutation. Every Panel connected to that Core sees the same pin state — it is a Core fact, not a Panel preference.
_Avoid_: favorite, starred, bookmarked

**Remembered session settings** (Core-scoped):
The Harness a Project starts sessions with, whether to skip the New session dialog and launch it directly, and the Project's default grid view. Stored on the owning Core against the Project row and patched via the core-link `settings` mutation, so — exactly like a pin — every Panel connected to that Core sees the same choice. Not a per-operator preference and not Panel-local. See ADR 0017.
_Avoid_: project preferences, saved agent, sticky settings

**Project presentation** (Panel-scoped):
The Panel operator's own filing over a Project that lives on a Core: its group, its card image and its launch URL. Stored on the Panel, keyed to the Core's project id, and joined onto the Core's snapshot on read — the deliberate mirror image of **Remembered session settings**. Groups exist only in the Panel's database, the card image is bytes on the Panel's disk, and the launch URL names a port only this browser can reach, so none of the three is a Core fact and two Panels on one Core are meant to disagree about them. Everything else the Edit-project dialog produces — name, icon, icon colour — is a Core fact and crosses the core-link. See ADR 0022.
_Avoid_: project metadata, local overrides, project settings (that is the Core-scoped entry above)

**CLI availability**:
The Core's own view of which harness binaries (claude, opencode, codex, …) resolve on its PATH. The Core probes at startup, on a periodic tick, and on SIGHUP (which `actana harnesses install` sends after installing a CLI, so a Panel sees a new harness without a daemon restart), then publishes `{harnessId → status}` as part of its state stream. The Panel reads this via `useCliAvailability(coreId)`; `NewHarnessDialog` opens with the availability answer already in hand and blocks submit on `missing`. Every Core publishes the identical shape.
_Avoid_: harness status, tool check, capability

**Harness install (from the Panel)**:
Asking the Core that owns a machine to put a missing Harness CLI on it, from the "Start a new session" picker. The `harnessInstall` core-link frame names one Harness; the Core runs the same non-interactive install `actana harnesses install <id>` runs, then re-probes. The frame is *acked*, not awaited — a vendor installer outruns the panel link's 30s request timeout — so the outcome arrives on the event log: availability flipping to `available`, or a `harness:installFailed` event carrying the operator-facing reason. The Panel tracks `installing` per (Core, Harness) outside React, and never caches a failure in the availability map. See ADR 0021.
_Avoid_: provisioning, remote install, harness setup

### Install and onboarding

**Core bundle**:
The single distributable placed on a target machine to turn it into a Core — a per-platform tarball carrying a pinned Node runtime, the Core daemon, its native modules, and the `actana` launcher. Two targets, both Linux: linux-x64 and linux-arm64. Verified against published checksums, extracted under the operator's home, and run without sudo or Docker. Not a single binary: the native modules rule that out.
_Avoid_: installer, package, image, binary

**`actana`**:
The single command inside the Core bundle that owns a machine's Core lifecycle: `setup` (install user-level, write the auto-start unit, start the daemon, print the pairing token), then `status`, `token`, `start`, `stop`, `restart`, `logs`, `harnesses install <id>`, `update`, `uninstall`. `setup` also offers to install any missing harness CLI using the vendor's own installer — a per-harness Y/n on a terminal, `--with-<harness>` / `--yes` / `--no-harnesses` non-interactively, and nothing at all when there is neither a terminal nor a flag. Having installed one, it appends a single marker-delimited block to the operator's login profile putting the harness CLI directories on `PATH` — the one place `actana` writes to a dotfile, because a vendor installer that edits only `~/.bashrc` leaves its CLI invisible to every non-interactive login shell. Runs entirely under the operator's account — the only privilege-adjacent step is `loginctl enable-linger`, which is prompted and explained. The installed launcher is a symlink at `~/.local/bin/actana` pointing through a `current` symlink at the installed version, so an update swaps one link.
The same command ships inside the Core image, where the lifecycle is Docker's: detected by the baked `ACTANA_CONTAINER=1` (never `/.dockerenv`), `setup`, `start`, `stop`, `restart`, `update`, `uninstall` and `logs` refuse and name the Docker command that does their job, while `status`, `token`, `token regenerate`, `harnesses` and `daemon` work — reading `ACTANA_PUBLIC_HOST` (required, never guessed), `ACTANA_PORT` and `ACTANA_LABEL` in place of what `setup` would have recorded (ADR 0016 D13/D15/D16).
_Avoid_: core CLI, the installer, the harness (a Harness is what a Task runs)

**Registration blob**:
The single base64 artifact emitted by `actana setup` — `{endpoint, caCert, clientCert, clientKey, bearer}`. Pasted once into the Panel's "Add Core" to register a Core. Secrets are encrypted into the Panel's data store; endpoint/label go to the Core registry. Reissuing is a machine-side operation.
_Avoid_: token, invite code, join key
_UI note_: user-facing strings call this the "pairing token" (e.g. "Paste your pairing token"). Code, docs, and frames keep the name **Registration blob**; "bearer" names only the field inside it.

**Auto-start unit**:
The systemd *user* unit (Linux, paired with `loginctl enable-linger`) or launchd LaunchAgent (macOS) written by `actana setup` so the Core daemon comes back on its own and resumes running harnesses without an operator SSHing in. Required by the unattended-operation property of a stateful Core. How far "on its own" reaches differs by platform and `actana status` says which you have: a lingering Linux unit survives logout and reboot; a sudo-less macOS LaunchAgent starts at login and stops at logout; a containerised Core has neither, and the thing that brings it back is the container's restart policy — a fact of the host, so `actana status` names where to read it rather than pretending to know it.
_Avoid_: service, daemon config, when you mean the concept — those are implementation, and the concept is "it comes back on its own". The exception is deliberate and narrow: the Core code's port over the two init systems is named `ActanaServiceManager` / `createServiceManager`, because there it IS the implementation being named and neither "unit" (systemd's word) nor "agent" (launchd's, and retired everywhere else here) is honest across both. Operator-facing output keeps the concept's name — `actana status` labels the row `Auto-start`.

## Rules

- **Nothing task-shaped lives on the Panel.** Tasks, sessions, terminal logs, hook events, project folders — all on the Core. The Panel stores Cores + one `lastEventId` per Core.
- **A Project's path is a VM path.** Only the Core can validate it. The Panel never stores or assumes folder paths on a Core.
- **One Core link per Core client, multiplexed.** All PTY streams, task ops, and events between one Core client and one Core share a single WebSocket. No per-task channels. A Core serves many such links at once, and a new one never evicts an existing one (ADR 0024 D1).
- **Many Readers, one writer, per Session.** Any number of Core clients may attach to a Session and watch it; at most one holds its **Session lock** and may mutate it. A PTY has no notion of who typed, so concurrent writers are not a feature to be added later — they are the thing the lock exists to prevent (ADR 0024 D3–D7).
- **VM Shell Sessions are privileged.** Same auth as the core-link; require an explicit open gesture in the Panel; never auto-spawned.
- **Singular UI across Cores.** Every Session (Task), Project, notification, status change, and modal renders through the same Panel components regardless of which Core owns the underlying data. Every Core is remote — a Core on the Panel's own host gets no special path. Transport underneath may differ; the surface may not.
- **Only the Panel dials Cores.** Browsers cannot hold client certificates; every core-link terminates inside the Panel. The Panel UI reaches Cores solely through its panel link.
- **The Panel and its Cores are version-locked, except for additive capabilities announced on `ready`.** The core-link handshake exchanges a protocol version; a mismatched Core renders as "needs update" with the command to run — never a degraded mode. The one narrow exception: a purely additive surface may announce itself on the `ready` frame, and only where its absence yields today's behaviour *exactly*, not a lesser one. A capability that changes what an existing frame means is not additive and still moves the version (ADR 0024 D11).
- **Task metadata lives Core-side.** Titles, session icons, pin flags — all owned by the Core. Panel mutations flow over the core-link; two Panels connected to the same Core see identical state.
- **CLI availability is Core-published state, not Panel probing.** The Panel never inspects a remote machine's PATH directly; it reads the Core's own availability snapshot from the core-link state stream.
