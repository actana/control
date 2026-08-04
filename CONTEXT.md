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
The persistent bidirectional WebSocket connection between a Panel and a Core. Carries PTY streams, task mutations, hook events, and notifications as framed JSON messages. Long-lived; survives Panel sleep; replays missed events on reconnect via a monotonic event cursor.
_Avoid_: tunnel, channel, pipe, API

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

**CLI availability**:
The Core's own view of which harness binaries (claude, opencode, codex, …) resolve on its PATH. The Core probes at startup, on a periodic tick, and on SIGHUP (which `actana harnesses install` sends after installing a CLI, so a Panel sees a new harness without a daemon restart), then publishes `{harnessId → status}` as part of its state stream. The Panel reads this via `useCliAvailability(coreId)`; `NewHarnessDialog` opens with the availability answer already in hand and blocks submit on `missing`. Every Core publishes the identical shape.
_Avoid_: harness status, tool check, capability

### Install and onboarding

**Core bundle**:
The single distributable placed on a target machine (Linux or macOS) to turn it into a Core — a per-platform tarball carrying a pinned Node runtime, the Core daemon, its native modules, and the `actana` launcher. Four targets: mac-arm64, mac-x64, linux-x64, linux-arm64. Verified against published checksums, extracted under the operator's home, and run without sudo or Docker. Not a single binary: the native modules rule that out.
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
- **One Core link per Core, multiplexed.** All PTY streams, task ops, and events for one Core share a single WebSocket. No per-task channels.
- **VM Shell Sessions are privileged.** Same auth as the core-link; require an explicit open gesture in the Panel; never auto-spawned.
- **Singular UI across Cores.** Every Session (Task), Project, notification, status change, and modal renders through the same Panel components regardless of which Core owns the underlying data. Every Core is remote — a Core on the Panel's own host gets no special path. Transport underneath may differ; the surface may not.
- **Only the Panel dials Cores.** Browsers cannot hold client certificates; every core-link terminates inside the Panel. The Panel UI reaches Cores solely through its panel link.
- **The Panel and its Cores are version-locked.** The core-link handshake exchanges a protocol version; a mismatched Core renders as "needs update" with the command to run — never a degraded or feature-detected mode.
- **Task metadata lives Core-side.** Titles, session icons, pin flags — all owned by the Core. Panel mutations flow over the core-link; two Panels connected to the same Core see identical state.
- **CLI availability is Core-published state, not Panel probing.** The Panel never inspects a remote machine's PATH directly; it reads the Core's own availability snapshot from the core-link state stream.
