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

**Core client id**:
The string a Core client presents on connecting, so a Core can tell that this connection replaces one it is already serving — the same client back after its link died. Used for reaping and for nothing else: the Core closes the predecessor and moves its **Session locks** across in one step, rather than leaving a ghost holding them until the heartbeat reaps it. Never signed, never verified, never authentication, and never a substitute for the bearer; it grants nothing a connection cannot already take with a force takeover. Minted per Core client and never derived from the **Registration blob**, which is shared by every client on the machine. See ADR 0024 D9.
_Avoid_: client identity, credential, session id, token, fingerprint

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

**Prompt delivery** (Core-scoped):
Getting a Session's starting prompt from "a Core client sent a string" to "the Harness has it and has been asked to work on it". Owned entirely by the Core, because it is a sequence of reactions to one Harness's own output — wait for its TUI to stop painting, answer whatever blocking dialog it opened, write the text, then send the carriage return as a separate keystroke — and none of that is knowable, or the same, from outside the machine the Harness runs on. A Core client supplies text and **never** timing: no delay, no ready-signal, no retry. Two of the three things that go wrong here are not timing at all — a Harness folder-trust dialog whose highlighted default *exits*, and text long enough that the Harness treats it as a paste and swallows the carriage return riding behind it — and a client that owned any part of this would get them wrong in its own way, so a Panel, the `actana` CLI and an SDK automation would disagree about a machine none of them is on. See ADR 0026.
_Avoid_: initial input, seeding, auto-typing, priming (those name the mechanism; the concept is that the prompt arrives)

**Session lock** (Core-scoped):
The exclusive right of one Core client to mutate one Session — its writes, its kill, and every task mutation addressed at it. Held by a core-link connection, never by a person or a program; scoped to a single Session, so different Sessions on one Core may be held by different clients. A Session starts unlocked and its creator gets no privilege; claiming is an explicit gesture; the lock ends on release, on connection drop, or on force takeover, and never on idle. It lives in memory and dies with the Core, exactly like the PTYs it guards. **Published, not discovered by failing:** every Session snapshot carries the lock as the client it was sent to must be told it — whether *you* may write, never who holds it — and every change appends a `session:lockChanged` event that replays by cursor. See ADR 0024.
_Avoid_: session owner, mutex, reservation, ownership

**Reader** (Core-scoped):
A Core client attached to a Session it does not hold the **Session lock** on. It sees every byte and can write none of them. Many Readers, one writer, per Session — a Reader is the ordinary state of an attached client, not a degraded one, and a Panel tab rendering a Session it does not hold is read-only *before* the first keystroke rather than on the error that answers it.
_Avoid_: observer, spectator, participant, viewer, watcher

**Session drive** (Panel-scoped):
Which of one Panel's browser tabs holds the keyboard for a Session. **Not the Session lock, and never to be reported as one:** the Panel is a single Core client, it holds a Session's lock once for all of its tabs, and two tabs are one human with two tabs — so which of them drives is the Panel's own business, settled between Panel sessions inside the Panel and never crossing the wire (ADR 0024 D3). It has no core-link frame, appears in no event log, and no Core hears of it. First-come: a pane opened on a Session nobody in that Panel drives takes it, a pane opened on one already driven follows it and may ask for the keyboard, and a tab that goes away hands it to the next tab still watching. A following tab is read-only for a different reason than a **Reader** is, and is told a different sentence — a Session **held** by another client is not a Session **driven** in another tab, and the loser of a handover lost nothing while the loser of a force takeover lost their unsent keystrokes. Arbitrated between **Panel tab id**s and not between sockets, so a tab that reloads is the same tab and keeps what it was driving. A tab that has asked and not been answered is **not** a tab nobody arbitrates: it may type, because the answer is a round trip to its own Panel and a pane that waited for permission would open read-only on every Session, but only inside a short window that says on screen that the write is a guess, and that ends read-only rather than never (issue 393).
_Avoid_: tab lock, focus, ownership, active tab, session lock (that is the Core-scoped one above)

**Panel tab id** (Panel-scoped):
What one browser tab calls itself across its own reload, presented on the panel-link upgrade. The **Session drive** is keyed by it, which is the whole of what it is for: a reload is a new socket for the same operator looking at the same pane, and a register keyed by the socket made that operator queue behind the socket they had just replaced. Minted per tab, parked in `sessionStorage` only while the page is being replaced and claimed back by the page that replaces it, so two live tabs can never present one id. It authenticates nothing and reaches no Core — it decides which of one Operator's own tabs holds a keyboard, and either tab may take that keyboard outright. Counterpart to the core link's **client id** (ADR 0024 D9) at the layer where a browser reload actually happens.
_Avoid_: session id, client id (that is the core-link one), device id, user id

**VM Shell Session** (Core-scoped):
A free-form interactive shell on the Core's machine — distinct from harness workspaces. Spawned over the same core-link with `shellSession: true`, gated by core-link auth (not project-root validation), rendered in the Panel like a user terminal. The "SSH-equivalent" escape hatch. First-class concept, not a special case of harness PTY.
_Avoid_: ssh, terminal, console (too overloaded)

### Transport concepts

**Event**:
A discrete thing that happened on a Core — task status change, hook fired, question menu appeared, run finished, shell output. Has a monotonic `eventId` per Core. Persisted in the Core's SQLite; pushed live over the core-link; replayed by `lastEventId` cursor on Panel reconnect. The Panel *service* never misses an event; a browser **tab** carries its own cursor, in memory, starting at zero, so a tab that opens after the fact has missed everything and loads current state through queries instead. The one thing no query re-derives — that a Session *finished* — is replayed to such a tab on purpose, bounded by count and by age (#388).
_Avoid_: message, notification (a notification is one *use* of an Event)

**Event cursor** (`lastEventId`):
The single number the Panel stores per Core — the highest Event id it has seen. Sent on reconnect to request the replay tail. The only per-Core state on the Panel beyond the Core registry.
_Avoid_: offset, sequence number

**PTY subscription** (per Core link):
One Core client's standing request for one PTY's byte stream. A Core sends a PTY's `data` and `exit` to the connections that asked for it and to no others, so a client attached to one Session never receives another's output. Held on the connection, so it dies with the socket and is re-asked for on reconnect. Catch-up is the existing `replay { ptyId, sinceSeq }`, ordered behind the subscription rather than in front of it (ADR 0024 D2).
_Avoid_: channel, stream registration, attach (an attach is the Panel gesture; this is what it asks for)

### Core client entry points

**`CoreClient`**:
The default way a program becomes a **Core client**: connect, authenticate, ask, close. One socket, one Core, mTLS plus the bearer out of a **Registration blob** — the credential a pairing produced. The shape the `actana` CLI and a script want, and the name a third party types against in `@actana/sdk`. It reconnects nothing and remembers nothing between runs; a program that stays up wants the durable entry point below. Frames that only a multi-connection Core understands are withheld until that Core has announced the capability, so one client drives an old Core and a new one without a second code path (ADR 0024 D11, ADR 0025).
_Avoid_: session, socket wrapper, connection object, SDK consumer

**Durable Core client**:
The second entry point on the same transport, for a program that stays connected — the Panel, and anything watching a Core rather than asking it one question. `CoreClient` plus a heartbeat, reconnection with backoff, an **Event cursor**, and subscribe-then-replay. On every connection it re-presents its **Core client id**, re-asks for its **PTY subscriptions**, and replays the gap it was away for, so nothing above it has to know the socket ever dropped. There is no fleet here and there must not be: one client is one Core, and holding several is the Panel's job.
_Avoid_: manager, pool, supervisor, reconnecting socket

**`CoreSession`**:
The SDK's second level, on top of either Core client entry point: start a **Session** in a registered **Project**, let the Core deliver the starting prompt, read the result. Programmatic I/O only — `send(text)` writes exactly those bytes, `onData(…)` streams them, `screen()` returns the rendered screen — and **no TTY, ever**: it never reads `process.stdin`, never sets raw mode, and is usable from a cron job, a CI runner or a web service, which is D11. It owns none of the three things it depends on: **Prompt delivery** is the Core's, so the prompt goes over as text and the Core decides when it lands; the spawn policy is the Core's, so a working directory outside a Project root or a flag off the allow-list is surfaced as a rejection rather than pre-empted; and "the turn is over" is the Core's report on its event log rather than a guess from the byte stream falling quiet. See ADR 0025, ADR 0026.
_Avoid_: terminal, pty wrapper, agent runner, REPL

**Screen**:
What a terminal would be showing for a **Session**, plus every line that has scrolled off the top of it. Produced by a small terminal emulator in the SDK — cursor movement, erase, insert/delete line and character, scroll, the alternate screen — because a Harness positions text with cursor moves rather than spaces, so deleting the escape sequences yields one line of concatenated spinner frames instead of a screen. The scrolled-off half is not an extra: a Harness's conversation left the visible rows long ago, so the transcript *is* the scrollback, and a reader of the viewport alone reads a status bar.
_Avoid_: output, log, buffer, stdout (those name a stream; this is what a stream was painted into)

**Core connection**:
What a **Registration blob** becomes in a client's hands: the core-link endpoint, that machine's HTTPS origin, the mTLS material, and the bearer. One name because it is one authenticated reach into one machine — the core link and the machine's HTTPS surface are two faces of it, not two connections. A Core client is handed this rather than a URL, and the material is exposed rather than only dialed with, so a surface that needs the same credentials over HTTPS needs no new format.
_Avoid_: socket, endpoint, credentials bundle

**Event cursor store**:
Where a **Durable Core client** keeps its **Event cursor** between reconnects and between runs. Always **injected, never imported**: `localStorage` in a browser-shaped Panel, a file for the CLI, memory by default — because the client itself runs in a Node process that has no DOM to reach into. Memory is a real answer rather than a stub: every reconnect still replays its tail, and only a restart starts from the beginning of the log.
_Avoid_: cache, persistence layer, local storage (that is one implementation of it)

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

**Project files** (Core-scoped):
The real files under a Project's root, on the machine that owns it. There is no index, no id and no metadata store: the filesystem *is* the model, and anything the Panel remembered about it would be stale the moment an agent wrote (ADR 0027). They cross over the Core's `/v1/…` HTTPS routes rather than the core link (ADR 0028), a folder crossing as one streamed tar (ADR 0029) — from the CLI; a folder dropped in the browser still crosses file by file, and without its mode bits (ADR 0030) — and a Core announces whether it has the surface at all with an optional `files` capability on `ready`. A Core that announces none has no file view in the Panel — absent, not broken, and never "needs update".
_Avoid_: the volume, project storage, uploads, attachments

**Dumb pipe** (Panel-scoped):
What the Panel is for a Project's file bytes: it streams the browser's body straight through to the Core and the Core's answer straight back, buffering nothing, unpacking nothing and validating no path. One place validates paths — the machine that owns the disk — and one end holds the mTLS credentials for those routes: the Panel service, the same material it dials every core link with, because no browser can present a client certificate. See ADR 0030.
_Avoid_: upload proxy, file gateway, relay

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
The single command that is both a machine's Core manager and the client that drives Cores. **One program, one name (ADR 0032).** Until 0.4.0 two different programs shipped under this name — the tarball's operator CLI and npm's client CLI — and which one answered on a machine that had both was decided by `PATH` ordering; that split was the defect, and it is gone.
The machine-side verbs own a machine's Core lifecycle: `install` (fetch a release, verify it against the published checksums, install and start a Core) and `setup` (the same from an already-extracted tarball — write the auto-start unit, start the daemon, register the Core with this machine's own `actana`), then `status`, `pair` (`new` / `ls` / `revoke`), `token regenerate`, `start`, `stop`, `restart`, `logs`, `harnesses install <id>`, `update`, `uninstall`, plus the undocumented `daemon` the unit execs. **Setup emits no credential and there is no `actana token` to reprint one** — a client enrolls with a **Pairing code**, and `token regenerate` rotates this Core's identity rather than handing anything out (#287). The client nouns talk to a Core, near or far: `core`, `project`, `harness`, `events`, `session`.
`setup` also offers to install any missing harness CLI using the vendor's own installer — a per-harness Y/n on a terminal, `--with-<harness>` / `--yes` / `--no-harnesses` non-interactively, and nothing at all when there is neither a terminal nor a flag. Having installed one, it appends a single marker-delimited block to the operator's login profile putting the harness CLI directories on `PATH` — the one place `actana` writes to a dotfile, because a vendor installer that edits only `~/.bashrc` leaves its CLI invisible to every non-interactive login shell. Runs entirely under the operator's account — the only privilege-adjacent step is `loginctl enable-linger`, which is prompted and explained. The installed launcher is a symlink at `~/.local/bin/actana` pointing through a `current` symlink at the installed version, so an update swaps one link — **unless something else already answers to `actana` there or earlier on `PATH`, in which case setup writes nothing and says so** (ADR 0032 D10). A Core installed on a machine is registered with that machine's own `actana` and becomes its default target, so `actana core ls` lists it with nothing pasted or paired anywhere.
The same command ships inside the Core image, where the lifecycle is Docker's: detected by the baked `ACTANA_CONTAINER=1` (never `/.dockerenv`), `install`, `setup`, `start`, `stop`, `restart`, `update`, `uninstall` and `logs` refuse and name the Docker command that does their job, while `status`, `pair`, `token regenerate`, `harnesses` and `daemon` work — reading `ACTANA_PUBLIC_HOST` (required, never guessed), `ACTANA_PORT` and `ACTANA_LABEL` in place of what `setup` would have recorded (ADR 0016 D13/D15/D16). **The client nouns are never refused there**, which is what makes the `actana-sessions` skill honest on the machine a Core installs it on.
_Avoid_: core CLI, the installer, the harness (a Harness is what a Task runs)

**Pairing code**:
The one-time secret a human carries: eight characters from an unambiguous alphabet (no `0`, `O`, `1`, `I`, `L`), grouped `XXXX-XXXX`, minted by `actana pair new` on the Core and spent once on the client — in the Panel's "Add Core" or by `actana core pair`. **It is the only thing a human moves between the two machines**, alongside the CA fingerprint they read out beside it, and it grants nothing on its own: what it buys is one certificate signed for a key that was generated on the client and never left it. Single-use, TTL'd, attempt-capped, and unrecoverable — `pair ls` cannot print one, because what the Core stores is a keyed digest. A lost code is re-minted, never looked up.
_Avoid_: pairing token, registration blob, invite code, join key, password
_UI note_: user-facing strings say "pairing code". The phrase "pairing token" is retired — it named the hand-carried blob, which no longer exists (#287).

**Pairing session**:
One pending enrollment on a Core: the **Pairing code**'s digest, its expiry, its attempt count and cap, and the label the operator gave the machine being paired. It lives beside the Core's identity in `pairing.json`, so the operator's `actana pair new` and the daemon that redeems the code both read one file. A redemption names its session and cannot be replayed against another; `actana pair revoke` cancels one that has not been spent, which is a different fact from having spent it and is recorded as such.
_Avoid_: invite, ticket, enrollment record, handshake

**Registration blob**:
The credential a paired client holds — `{endpoint, label, caCert, clientCert, clientKey, bearer}`. A client assembles one from what a redemption returns plus the `clientKey` it generated locally, and everything downstream takes it as-is: `coreConnectionFromBlob`, the mTLS handshake, the bearer `auth` frame. **It is not something a human carries.** Until #287 the same shape was also a single base64 artifact printed by `actana setup` and pasted into the Panel; that hand-carry is gone with no deprecation and no dual path (#280), and the base64 encoding survives only as how the CLI's blob registry keeps an entry on disk. In the Panel the secrets are sealed into its data store and the endpoint and label go to the Core registry. Reissuing is a machine-side operation: `actana token regenerate` rotates the Core's identity and locks every paired client out, and `actana pair revoke` takes back one.
_Avoid_: token, pairing token, invite code, join key, paste

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
- **Only the Panel dials Cores.** Browsers cannot hold client certificates; every core-link terminates inside the Panel. The Panel UI reaches Cores solely through its panel link — and, for file bytes alone, through the Panel's own `/api/*` routes, which forward to the Core's HTTPS surface over the same pinned material (ADR 0030). Either way the browser's transport ends at the Panel.
- **One place validates a path: the machine that owns the disk.** The Panel forwards `..`, an absolute path and a symlink escape exactly as written and lets the Core refuse them with the Core's own code. Half a validator on the Panel would be guessing about a filesystem it cannot see, and would be wrong in precisely the interesting cases (ADR 0027 D5, ADR 0030 D2).
- **The Panel and its Cores are version-locked, except for additive capabilities announced on `ready`.** The core-link handshake exchanges a protocol version; a mismatched Core renders as "needs update" with the command to run — never a degraded mode. The one narrow exception: a purely additive surface may announce itself on the `ready` frame, and only where its absence yields today's behaviour *exactly*, not a lesser one. A capability that changes what an existing frame means is not additive and still moves the version (ADR 0024 D11).
- **Task metadata lives Core-side.** Titles, session icons, pin flags — all owned by the Core. Panel mutations flow over the core-link; two Panels connected to the same Core see identical state.
- **CLI availability is Core-published state, not Panel probing.** The Panel never inspects a remote machine's PATH directly; it reads the Core's own availability snapshot from the core-link state stream.
- **A Core client sends a starting prompt as text, and sends no timing with it.** **Prompt delivery** is the Core's, end to end: when to write, which dialog is in the way and how it is answered, and when the carriage return goes out. There is no frame, field or option through which a client can express an opinion about any of it, so every client behaves identically on the same Harness without knowing that Harnesses differ (ADR 0026).
