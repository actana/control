# Changelog

All notable changes to this project, newest first.

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

The core-link protocol moves to 0.15.0 so a Session's manually-set-title flag
and harness session id can cross the wire, so archived Sessions on a Core can be
listed and restored, so a project's remembered session settings can cross, so a
Session that lives on a Core can be deleted at all, so a missing Harness can be
installed from the session picker, and so a project's icon and colour can be
changed after it is created. The Panel and its Cores are version-locked, so
every Core needs updating alongside the Panel — an older one renders as "needs
update" rather than degrading.

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
