# Actana Control — Domain Model

Terminology baseline: [`CONTEXT.md`](../CONTEXT.md). This file records the
deltas that apply under Actana Control's narrowed scope. Where `CONTEXT.md`
and this file conflict, this file wins.

## Positioning

**Actana Control** is a core remote control. One self-hosted Panel service
drives zero-or-more Cores over the core-link, from a browser. Nothing else.
The Panel bundles no Core of its own (ADR 0010).

Explicit non-goals:

- **Not an IDE.** No file browsing, editing, or preview inside the Panel.
- **Not a prompt manager.** No saved-prompt library or fuzzy search.
- **Not a scripts runner.** No user-defined shell scripts or launch
  commands live inside the Panel — that belongs in the environment the
  user already owns.
- **Not a memory system.** No semantic code indexing, no per-project fact
  store, no recall panel. The Panel holds no knowledge about project
  contents.
- **Not a skill installer.** The Panel never writes into the user's
  `.claude/`, `.codex/`, `.cursor/`, or any other harness skill directory.
  Injecting behavior into the user's harness biases results and collides
  with their own setup, especially for git operations. See ADR 0006.
- **Not a voice interface.** Speech-to-text belongs in the operator's own
  toolchain, not the remote control.
- **Not a screen capture tool.** File transfer to a Core will be a
  separate first-class feature designed later; the existing `screencapture`
  path is removed.

## Product name and identifiers

- Product name (display): **Actana Control**.
- Package name (npm): **`actana-control`** (lowercase-hyphenated).
- GitHub org / repo: `actana/control`.
- The Panel updates with its image; there is no in-app updater (ADR 0010).
- Prior identifiers: **Mission Control** (display), `mission-control` (package),
  `AgentSystemLabs/mission-control` (repo), `agentsystem.dev` (download host).
  Retained only as legacy references in upstream porting notes.

## Harness bridge package

**Removed** (spec 10, ADR 0009). The managed-sandbox subsystem that
installed `@agentsystemlabs/mission-control-harness` on VMs is gone, and
the dependency with it — no `@qcentic/actana-control-harness` fork needs
to be published, and spec 09's package-rename prerequisite is dissolved.
Remote work is the detached Core (ADR 0001–0004).

Env-var prefix — landed with spec 09 (AC-09-04): the `MC_*` prefix is now
`AC_*` (`AC_CORE_REMOTE`, `AC_USER_DATA_DIR`, `AC_CORE_LINK_HOST`, etc.).
The prefix is the Core ↔ Panel core-link contract; it was a single wire
break with no dual-read window. `MC_TASK_ID` / `MC_API_URL` / `MC_API_TOKEN` /
`MC_THEME` never made the rename — spec 05 deleted the harness-injection
surface first.

## Harness

Definition per `CONTEXT.md`; the family is open per ADR 0013, which
carries the two rules that follow from it. The delta this file records is
only the roster: `claude-code`, `codex`, `cursor-cli` and `opencode` are
current; `pi` and `hermes` are planned additions.

## Core

Definition per `CONTEXT.md`. Under Actana Control:

- Every Core is reached the same way — there is no local mode and no
  in-process transport (ADR 0010). A Core on the operator's own machine is
  installed and paired like any other.
- Adding a new Core does not require any Panel-side per-Core code.

## Session finish (notification)

The Panel raises **exactly one** notification kind for background
attention: a *session-finished* signal.

- **Trigger:** a `session:finished` event on core-link from any Core.
- **Granularity:** per Session, not per Task. A Task that runs multiple
  Sessions raises one signal per Session.
- **Delivery:** in-app toast (default on) + native OS notification
  (default off, user-toggleable). No sound coupling required — sound is
  a separate toggle.
- **Cross-core:** the notification body identifies which Core the Session
  belongs to (Core alias or id) so the operator knows where to look.

Removed: diagram-ready notifications, task-completion-with-diagram-body,
recall-brief-ready notifications, and anything else that was a
notification of a removed feature.

## Focused Session Mode

Retained per `CONTEXT.md`. Behavior unchanged: the main window transforms
into a small always-on-top card showing one Session and back.

## User Terminal

A free-form user-owned terminal rendered inside the Panel, next to harness
Sessions. Retained. Distinct from **VM Shell Session** (which runs on a
Core's machine over core-link). A User Terminal runs on the operator's
own box.

## What is no longer in the domain

The following are removed from Actana Control's vocabulary. If you find
one in code, it is dead:

- Voice command, PTT, voice intent, voice controller, Whisper (STT).
- Pet, pet species, pet mood, pet XP, pet multiplayer, pet relay.
- Screenshot, screenshot history, screenshot annotator.
- Code graph, recall, recall brief, recall MCP, recall skill, proactive
  recall, project memory (as a first-class store).
- Diagram skill install target, ship skill install target, MC_API_URL /
  MC_API_TOKEN / MC_THEME injected into harness Sessions.
- Scratch pad, custom scripts, launch commands, prompt search palette.
- File editor dialog, file finder dialog, HTML preview, annotations panel,
  markdown annotator.

## Scope boundaries — cheat sheet

| Concern                        | Belongs to           |
| ------------------------------ | -------------------- |
| Which harness runs, with what    | The Core          |
| Skills, MCPs, hooks config     | The user's harness   |
| Where code executes            | The Core machine  |
| Editing / previewing files     | The user's editor    |
| Saved prompts                  | The user's toolchain |
| Notifying the operator         | The Panel            |
| Showing task/session state     | The Panel            |
| Registering & auth to Core  | The Panel            |
| Persistent per-Core state   | The Core's SQLite |
