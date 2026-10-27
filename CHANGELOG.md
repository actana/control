# Changelog

All notable changes to this project, newest first.

## 0.5.2 — unreleased

The Panel now works on a phone. Below 768 px wide the Panel drops the desktop
layout: the page scrolls like any other page, a top bar carries the menu, the
place you are in and the notification bell, and the menu opens a drawer that
lists Fleet, every Core with its status, Settings and Operator. Inside a Core, a
bottom tab bar switches between Sessions, Files and Tasks. Dialogs open as
full-screen sheets with Cancel, the title and the main action in the header and
the same action repeated in the footer, and the sheet follows the on-screen
keyboard so the buttons stay reachable. Small tablets (768 to 1023 px) get the
same shell with wider layouts. Desktop (1024 px and up) is unchanged.

Sign in, first-run setup and Fleet fit a phone. The password fields have a
show/hide eye, long install and pairing commands wrap beside a large copy
button, and the setup wizard's steps scroll sideways instead of overflowing.
Step 4 of the wizard, the Shared folder, opens as a sheet; going back from it
leaves a "paired but not finished" card whose Continue button reopens the sheet
with the test result kept. Fleet and the "Core needs update" notice reflow the
same way, with touch targets of at least 44 px.

A Core's Sessions are cards on a phone, and its terminals are full screen. A
terminal has a Back button, the Session's title and status, and a key row with
Esc, Tab, a sticky Ctrl, the arrow keys and paste, because a phone keyboard has
none of them. When a harness asks a question, you answer by tapping an option in
a sheet. The terminal switcher lists Shells, New Terminal and Sessions, and New
session is a full-screen sheet. Tablets use the same layout for the workspace
and terminals. A separate fix applies everywhere: the first click on Terminals,
the terminal toggle in the header or its hotkey did nothing on a Core whose
terminal panel had never been opened, and now opens it.

A Core's Files work on a phone. A folder is a single column with a scrolling
breadcrumb, search, a Grid/List switch and a **+ New** menu that opens as a
bottom sheet (New folder, Upload files, Upload folder, New text file). Opening a
file shows it full screen with its preview, its details, and Download, Copy
path, Rename, Move and Delete. Rename, Move and the name dialogs are sheets
that keep their action above the keyboard.

Tasks work on a phone. Below 600 px wide the board shows one column at a time
(two from 600 px and on tablets), chosen with a segmented control (Draft,
Assigned, In progress, Finished) that carries the counts; you can swipe between
columns, filter by Core with chips, and start a Task from a floating
**+ New Task** button. Task detail is a full-screen page with the comment box
pinned above the keyboard, **Stop Task?** is a bottom sheet, and New Task is a
full-screen sheet with the time limit presets and a numeric field for a custom
limit. Settings is a list screen on a phone, and each page opens full screen
with a Back button, down to creating an API key; from 600 px wide the list and
the open page sit side by side.

Tasks can be dragged between the board's columns, on the Tasks page and on a
Core's Tasks tab. Dropping a Task on Assigned, back on Draft, or on Assigned
again to re-assign it does exactly what the corresponding button does, so the
REST API, MCP and webhooks see the same status change and the same events. A
drop that is not allowed snaps back with the reason in a message, and columns
light up to show where a card may go. With a mouse or pen you drag; on a touch
screen you press and hold a card for a moment (moving first scrolls instead),
and on a phone you drop it onto the segmented control. From the keyboard, Space
picks a card up, the arrow keys choose a column, Enter or Space drops it and
Escape cancels. A Task re-assigned by dragging carries no comment, so it starts
a new attempt without the comment that **Comment & re-assign** would add.

The time limit now explains itself. New Task says what the limit means ("how
long one attempt may run without writing a result"), that the default is one
hour, and that when it runs out the Panel stops the Session and fails the
attempt. A custom limit shows how it will read on the Task (90 becomes `90
min`). Task detail shows the limit with the time left and when the attempt
started, who last changed the limit and from what, and, while an attempt runs,
that a change applies within a minute and that lowering it below the time
already run fails the attempt. The picker opens with **Change** and closes with
**Done**. The limit itself, its presets and its range of 1 to 43200 minutes are
unchanged.

A Session waiting on a dialog is no longer marked finished. When a harness sat
on an approval dialog the Core did not recognise and kept repainting it
unchanged, the quiet-Session backstop settled the Session as `finished` after
about ten minutes, which sent a completion toast and let `actana session wait`
return while a person was still needed. The Core now tells a dialog that
repaints unchanged from a spinner that is still ticking, and leaves the first
one `running`. A dialog that sends nothing at all is still settled by the 15
minute quiet rule.

Pressing Esc mid-turn now marks the Session `interrupted` on every harness, not
only Claude Code. Before, Codex stayed `running`, and Cursor, OpenCode and Pi
reported a normal end of turn, so a cancelled turn looked like a finished one:
the completion toast appeared and `actana session wait` returned. Each harness
is now read from the signal it actually sends (a screen line on Codex, an
aborted stop on Cursor and Pi, an abort error on OpenCode). Update the Core as
well as the Panel to get this.

Cursor's folder-trust dialog is answered. The Core recognised the dialog that
asks to trust a workspace (`[a] Trust this workspace`, `[q] Quit`) but could not
read letter-keyed menus, so it left it unanswered and the Session waited. It now
reads `[a]` and `a)` menus as well as numbered ones and answers a clear
trust-or-quit choice. A menu that mixes notations is still left alone, as is
anything with no single affirmative option.

Task dispatch comments take only plain ids. The comment the Panel adds when it
starts a Task, which gives the **Open session** button its Core and Session, now
accepts a Core or Session id only of letters, digits, underscores and hyphens,
and the reader no longer lets text inside a crafted comment pose as the Core and
Session. Real ids are unaffected and existing Tasks keep their button. If a Core
ever returned an id outside that set, the Task still runs, the Panel logs
"could not add the dispatch comment", and the button is absent.

## 0.5.1 — 2026-10-21

This entry covers 0.5.0 and 0.5.1, which shipped together in v0.5.1: 0.5.0 was
built and tested as a beta train and never tagged on its own, so there is no
separate 0.5.0 entry. **There is no upgrade path from 0.4.x.** The Core's model
and wire protocol changed, a 0.5.0 Core refuses a database from 0.4.x, and the
Panel moved to Postgres. Install fresh Cores and a new Panel with its bundled
Postgres, and re-pair. The decisions are in
[ADR 0041](docs/adr/0041-the-0-5-0-core-model.md).

A Core is now a workspace plus Sessions, and Projects are gone. A Session always
starts in the workspace, which is the `core` user's home (`~`); New session has
no path field, and the Panel has no Projects page, so a Core opens to Sessions,
Files and Tasks with the terminal as a drawer at the bottom. **Task is renamed
Session everywhere on the wire**, in frames, events, the database, the SDK and
the CLI, with no alias, and the protocol version is bumped: **a 0.5.0 Core and a
0.4.x Panel, SDK or CLI do not talk to each other, so update every Core and
every client together.** A Core refuses a `spawn` that carries a `cwd` or a
`projectId` and names the field. Sessions can be renamed.

The Core is locked down. `core` has no sudo, and root is used only by the
container's own startup. The daemon runs as its own user, `actana`, with its
state in `/var/lib/actana`, outside the workspace, so in a container `docker
exec` now needs `-u`, and `actana pair` and `actana status` refuse anyone but
the daemon's user. Harnesses are found in the core home by the daemon.

Every Core has a Shared folder at `~/shared`. Without a Panel it is a local
folder; paired to a Panel it is synced from S3 with short-lived keys, with a
change feed behind it. **Pairing from the Panel now requires a Shared folder**,
the Panel holds the master key, and a pairing is not finished until the folder
is attached. Reports and all communication between a Session and the Panel go
through it, and every prompt the system sends ends with a standard block naming
the report file to write. Settings gains a Storage page for SeaweedFS (the
bundled default, which creates its own bucket), Cloudflare R2, STS and Supabase.
Deleting a Core empties its Shared folder and the machine's `~/shared`;
unpairing removes only the S3 link. With SeaweedFS the Panel signs each
Core's token with the master key and publishes its public half as a JWKS at
`/.well-known/jwks.json`.

Files is a drive. The Files API is rooted at `~` and gained delete, create
folder and move; the Panel's tab shows recursive folders, details, previews,
rename and move, folder upload, and a badge on files that are new in the change
feed. The old per-Project file routes are removed and answer 404.

Tasks are the Panel's unit of work. A Task has a title, a description with
attached files, comments and a status (`draft`, `assigned`, `in_progress`, or
once finished `done`, `failed` or `partial`), and is given to an Agent, which is
a harness plus a model and flags on one Core. Assigning a Task starts a Session;
the Task's prompt reaches the harness as a file and a one-line pointer, and the
result is read back from the Shared folder and turned into a status and a
comment. Task Sessions launch in auto mode on every harness that has one, and an
Agent can no longer opt out; Agents list only the harnesses the Core can run
now. A Task's Session can be opened from the Task detail, per attempt, and the
Task drawer closes from the keyboard, a backdrop click or a visible X.
Dispatch uses the Core's Files API as well as the link: a Core reachable only
over the link fails every Task. A Task that is still waiting for a harness that
the Core is checking after a restart stays assigned instead of failing.

Tasks can be edited, deleted and stopped. A Task's title and description can be
changed and the Task deleted, in the Panel, in the REST API (`PATCH` and
`DELETE /api/v1/tasks/:id`) and over MCP (`update_task`, `delete_task`), but not
while it is in progress. A Task that is in progress with a hung Session can be
stopped (`POST /api/v1/tasks/:id/stop`, MCP `stop_task`, the Stop button); it
stops the Session and fails the attempt, after which it can be re-assigned.

Each Task has a time limit, in minutes or No limit. The default is one hour, the
range is 1 to 43200 minutes, and it can be changed even while a Task runs. When
it runs out, the Panel stops the Session and fails the attempt.

The public API, MCP server and webhooks are new in this release. `/api/v1`
covers Cores, Agents, Tasks and comments and is described, with its OpenAPI 3
document, in [docs/external-api.md](docs/external-api.md);
`POST /mcp` serves the same operations as MCP tools, including `list_shared` and
`get_shared` to read a Core's Shared folder; and webhooks are signed
(HMAC-SHA256) for `task.created`, `task.updated`, `task.status_changed`,
`task.deleted` and `comment.created`, over https only. All of them authenticate
with an API key, shown once when created. A key can be limited to chosen Cores
and, new in 0.5.1, to chosen permissions, so a key can read Tasks without being
able to delete them, and can be given an expiry date, after which it gets a 401.
Existing keys keep all permissions and never expire. A key can only ask a Task
for the statuses `assigned` and `draft`.

Harness setup and trust are sturdier. The Core now pre-trusts a harness's
workspace so a Session does not stop on a folder-trust dialog, including Codex
hooks and Cursor project folders, and a harness that needs setup can still be
opened. A blocked harness is no longer restarted by every setup check, a setup
run that cannot start is reported instead of leaving the harness `available`,
and a hang-up during a check is no longer undone when it finishes. Writes to
`~/.claude.json` take Claude Code's own lock. The Codex hook trust is known to
match Codex 0.162.0; the Core asks each Codex version it finds whether it
agrees and logs the answer, and on a mismatch Codex only asks again at its own
hook review. Note that the Codex pre-trust marks the home directory trusted even
if you had set it untrusted.

Session status is more truthful. A turn that is killed settles the Session as
`terminated` and never `ready`, and the kill is recorded with its reason. A
nested `claude` can no longer take over or settle another Session's card, since
hooks are now held to the harness process the Core spawned. A very long Task
prompt that Codex or Pi receives in pieces is recognised as delivered, so it is
submitted. The session terminal opens again from the Core page and from Tasks,
and the Core page shows a loading state until the Core list is known.

Compose Cores pair on an address the Panel can reach. The Panel now keeps the
address it dialled instead of one the Core reported about itself, so the stored
address works. The "needs update" notice offers the compose command `docker
compose pull core && docker compose up -d core` next to the installer command,
instead of telling a compose Core to run `actana update`, which it refuses. The
Core and Panel container images move to current base image digests.

The Settings page for the Terms of Service is removed, and old links to it fall
back to General. Two decisions are recorded as ADRs: the Panel owns no
source-control surface ([ADR
0014](docs/adr/0014-panel-owns-no-source-control.md)) and the Panel has one
fixed look copied from Actana Studio ([ADR
0015](docs/adr/0015-one-fixed-look-from-actana-studio.md)).

## 0.1.0 — unreleased

Actana now tells you when a newer release exists. Once a day the Panel and each
Core ask GitHub for the newest published release; if it is newer than what they
are running, the Panel shows a dismissible banner, `actana status` gains an
availability line, and the Core's daemon writes the same fact to its log once.
Each component answers for its own version, so a deployment whose Panel and Core
have drifted is told the truth about both. Nothing here updates anything: the
remedy is named, never offered as a button, and stays `actana update` on metal
and `docker compose pull && docker compose up -d` in a container. The answer is
cached for 24 hours, every failure — no network, no releases published, a rate
limit — is silent, and `ACTANA_UPDATE_CHECK=0` turns the whole thing off.

A Session card now tracks what its harness is actually doing. Until now nothing
on a Core ever changed a Session's status or title after the row was created:
the Core spawned harnesses without installing their lifecycle hooks and had
nowhere for a hook to report to, so a Core-owned Session sat on "ready" until
something else moved it, and a generated title never arrived at all.

The Core now detects, writes, and tells the Panel. It installs each harness's
hooks at spawn, pointed at a loopback receiver of its own; it settles a Session
whose process exited; it names an unnamed Session using the harness binaries
only it has. Each of those lands on the Core's own row and appends an event, so
the card re-renders live and a Panel that was away replays what it missed —
with the Panel's database untouched throughout. An operator's rename is now
protected on the row rather than in Panel memory, so a generated title can no
longer overwrite it after a reload. And the terminal-input fallback stands down
only for a Session whose hooks really report the start of a turn, rather than
for any harness whose family supports hooks in principle.

Archiving a Session on a Core used to be a one-way hide. The row was archived
correctly and nothing was lost, but archived rows never crossed the link, so the
Archived tab never appeared for that project and there was nothing to restore
from. Archived Sessions on a Core now appear under Archived with a count on the
tab, Restore returns one to the active list, and "Delete all archived" works.
They travel on a read path of their own, used only while that view is open — the
Fleet and active lists still carry none of them.

Editing and removing a project that lives on a Core both work now. Removing one
never did: every remove path asked the Panel to delete a row only its Core has,
and the confirm dialog closed without a word while the project stayed put.
Editing half-worked — the name was saved, and the icon, colour, group and card
image were thrown away with an error nobody saw. Renames, re-icons and
re-colours now travel to the Core that owns the project, so every Panel watching
it converges on them. The group, card image and launch URL stay with the Panel:
they are your own filing over someone else's project, and two Panels on one Core
are meant to disagree about them. A failed save now says so, instead of leaving
half of one behind.

A project's folder is fixed when the project is created on a Core, and the Edit
dialog now says so rather than accepting a new path and discarding it on save.

The core-link protocol moves to 0.16.0 so a Session's manually-set-title flag
and harness session id can cross the wire, so archived Sessions on a Core can be
listed and restored, so a project's remembered session settings can cross, so a
Session that lives on a Core can be deleted at all, so a missing Harness can be
installed from the session picker, so a project's icon and colour can be changed
after it is created, and so `actana core exec` can run a command on a Core at
all. The Panel and its Cores are version-locked, so every Core needs updating
alongside the Panel — an older one renders as "needs update" rather than
degrading. That applies to every Core in the fleet, including one that is
otherwise working: a Core left on the previous protocol is grounded until it is
updated, and the Panel says so rather than half-working.

`actana core exec` runs one command on a Core and comes back. It is the verb the
`core` noun was missing: `actana core shell` hands a person a terminal, and a
maintenance script needs neither a terminal nor a person. The command's own exit
code becomes the CLI's, stdout and stderr stay apart, and no PTY is involved, so
nothing colours itself on the way back — which is what makes the output safe to
pipe into another program. `--json` returns one document on stdout for every
outcome, the failures included. Until now the only way to run something on a
Core was `docker exec`, which works solely because a Core happens to be a local
container and bypasses the Core's own authentication; this crosses the
authenticated link and works against a remote Core unchanged.

The New Terminal control in a project's terminal panel now opens a shell on the
Core's machine. It used to offer two controls that looked alike, one of which
opened a shell in the project folder, and navigating to a project quietly
started a terminal process before anybody asked for one. That pre-spawn is gone:
a terminal starts when you open one and not before.

Deleting a Session on a Core used to fail. The task-mutation frame carried no
delete operation, so every delete fell through to the Panel's own endpoint,
which cannot see a row that lives in the Core's database. Deleting from the
Session card menu and from the open session's terminal panel both work now, on
every Core.

Two New session dialog changes come with it. "Remember settings for this
project" now persists on the Core that owns the project, so it survives a
reload and a Panel restart, and is shared by every Panel connected to that Core
— the same semantics project pinning already has. The "Skip permission prompts"
checkbox is gone: every session now launches in auto-mode for the harnesses
that have such a flag (`--dangerously-skip-permissions`, `--yolo`, `--force`).
OpenCode, which has no such flag, launches unchanged. **There is no longer a way
to start a non-auto session from the Panel UI** — override per session in the
terminal.

Actana now ships one agent skill of its own, and installs it. `actana-sessions`
teaches a coding agent how to drive Cores and Sessions with the `actana` CLI —
how to start a Session with a prompt, wait for it, collect a report out of it and
stop it, and how to provision several at once. It is generic: no project runbook,
no default Harness, no preference order, and nothing about any repository.

It goes into the global skills directory of every Harness that is already on the
machine — `~/.claude/skills/actana-sessions/` for Claude Code and
`~/.agents/skills/actana-sessions/` for Codex, Cursor CLI and OpenCode — and only
into a directory the Harness itself created. Installing the Core installs it on
the Core's machine; installing `@actana/cli` installs it the first time you run
any `actana` command, since this package still has no npm install hook.
`actana harness skills` does it on demand and prints what it wrote. A copy you
have made your own — by deleting its `x-actana-managed: true` line — is left
alone from then on; a copy that still carries that line is replaced, edits
included.

**This one is provisional.** [ADR 0006](docs/adr/0006-no-bundled-skills.md) said
the product installs no skills, and it is amended by
[ADR 0031](docs/adr/0031-the-product-ships-one-skill.md), which is **proposed and
not yet accepted**. The code is here so the decision can be judged against
something real; the decision itself lands at the beta gate.

Core tarballs are published as `actana-core-<version>-<target>.tar.gz`. This is
the first published release of the Core tarball; no earlier asset name was ever
released, so no download URL changes.

If you installed a Harness from a locally built tarball before this release, run
`actana setup` once — it removes the old `actana-harness.service` user unit and
installs `actana-core.service`. Your data in `~/.local/share/actana` and
`~/.config/actana` is untouched; those paths do not change. Re-pairing with the
Panel is not required.

## Before 0.1.0

This repository was forked from
[AgentSystemLabs/mission-control](https://github.com/AgentSystemLabs/mission-control)
at `v0.49.0` — see [`NOTICE`](NOTICE) for the attribution.

Its own history starts at 0.1.0. Everything before that tag is the fork
parent's Electron desktop app, which this repository no longer is
([ADR 0010](docs/adr/0010-panel-becomes-a-self-hosted-web-service.md)).
