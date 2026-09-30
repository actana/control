# The 0.5.0 Core model: no Projects, one workspace, a Shared folder, Tasks on the Panel

> **On the number.** This record takes **0041**, the next free number after
> [`0040-pi-project-trust-answered-by-extension.md`](0040-pi-project-trust-answered-by-extension.md).
> It does not repeat the 0018 collision described in [`README.md`](README.md).

## Context

[#552](https://github.com/actana/control/issues/552) tracks the 0.5.0 release
and [#554](https://github.com/actana/control/issues/554) is this record: the
model that every later ticket in the train builds on, written before any code
changes. Until 0.4.x a Core hosts **Projects**, each holding **Tasks**, each
Task backed by a **Session**; the Panel keeps a presentation row for every
Project; the filesystem under a Project is the model; and `core` has passwordless
sudo. 0.5.0 replaces that shape. There is no port from 0.4.x: Cores are
installed fresh on 0.5.0 (#552).

## Decisions

**D1 — There are no Projects.** A Core is a workspace plus Sessions. The
workspace is `~`, the home of the `core` user.

**D2 — A Session always starts in the workspace.** There is no custom path. To
focus a Session on a folder, say so in the prompt.

**D3 — Session is the name everywhere.** The row that the code, the DB and the
wire call *Task* becomes **Session**, and `taskId` becomes `sessionId`.

**D4 — Task is the Panel-side work item.** The word is freed by D3 and now names
the unit of work that lives on the Panel (D9), not a row on a Core.

**D5 — `~/shared` always exists.** It is the **Shared folder** of the Core.

**D6 — Without S3 the Shared folder is a local folder.** With a Panel it is
mounted from S3 using short-lived keys, one folder per Core.

**D7 — All reports and communication go through the Shared folder.**

**D8 — The layers above a Core live in the controller, not on the Core.**
Tasks, comments, agents, the REST API, MCP, API keys and webhooks live in the
Panel (Postgres).

**D9 — The Panel uses only the public SDK.** Any other controller, for example
Studio, can therefore do the same.

**D10 — `core` has no sudo.** Root is used only by the container's own startup.

**D11 — The Core daemon runs as its own user, with its state outside `~`.**

**D12 — Deleting a Core removes the Core, its Shared folder and its S3 folder.**

**D13 — Unpairing a Core from a Panel removes only the S3 link.** `~/shared`
stays and keeps its contents.

## What this supersedes

Each older record is marked with a pointer to this one. Its text is not
rewritten.

| Earlier decision | Effect | Because |
|---|---|---|
| [ADR 0022](0022-a-core-owned-project-has-a-panel-side-presentation-row.md), in full, with its two amendments (ADR 0030 and #382) | **Superseded** | D1: with no Projects there is no Project for the Panel to keep a presentation row for. |
| [ADR 0027](0027-the-filesystem-is-the-model.md) **D1** ("a Project's files are the directory. There is no index") | **Superseded** | D1 and D5: the files are no longer a Project's, and the Shared folder is the place files are communicated through, with a change feed (#561). |
| [ADR 0028](0028-file-bytes-cross-https-not-the-core-link.md), the parts that address a Project: the `/v1/projects/:projectId/…` routes and **D6** (one write transfer per Project) | **Amended** | D1: the Files API is re-rooted at the workspace (#557). The rest of 0028 stands. |
| [ADR 0030](0030-the-panel-is-a-dumb-pipe-for-file-bytes.md) **D5** ("a file view is not presentation") and every place it says Project | **Amended** | D1, and 0022 above. D5 argues from 0022's `project_presentation` row, which no longer exists. |
| [ADR 0016](0016-the-0-1-0-shape.md) **D12**, the sentence keeping `NOPASSWD` sudo for `core` | **Superseded** | D10. The rest of D12 stands: `core`, uid 1000, gid 1000. |
| `CONTEXT.md` rule "Nothing task-shaped lives on the Panel" | **Replaced** | D4 and D8. |
| `CONTEXT.md` avoided terms "uploads" and "project storage" (under **Project files**) | **Removed** | D1 removes the Project, and D5 to D7 name the Shared folder. |

`CONTEXT.md` changes with it. It removes **Project**, and its Project-scoped
entries and rules follow from D1: **Project presentation**, **Project files**,
**Pinned Project** and "A Project's path is a VM path". It defines Core,
workspace, Session, Harness, Shared folder, Task, Agent and Report.

## Definitions this record fixes

- **Agent** is a Harness with its settings on a Core (#569).
- **Report** is what goes through the Shared folder (D7). Its contract is
  actana/client#8, and the Panel turns result files into Task status and
  comments (#570).

Neither definition says more than the tickets say. The rest is open, below.

## Open

These are not decided here. Each is the named ticket's to settle.

- **The shape of an Agent's settings**, and how a Task is dispatched to one
  (#569, #570).
- **The Report contract** through the Shared folder: file names, layout and
  fields (actana/client#8).
- **The wire form of the rename** in D3, and what happens to core-link frames
  and the protocol version (#556).
- **The new Files API address and its delete and create-folder routes** (#557).
- **The Shared folder's change feed** and the mount mechanism (#561, #562).
- **How the Panel's Files tab reaches Shared-folder bytes**, and so whether the
  Panel remains a "dumb pipe" (ADR 0030) for them (#565).
- **Where Remembered session settings live** (ADR 0017) now that the Project row
  they were stored against is gone. No ticket in #552 says.
- **Which directory holds the daemon's state**, outside `~` (#559).

## Consequences

- **#555 and #556 change the code to match** and #560 the Panel. Until they land,
  the code, the DB and the wire still say Project and Task, and `CONTEXT.md`
  says what they will say.
- **Every later ticket in #552 cites this record** for the model, and a ticket
  that needs a decision changed amends it rather than settling it in a comment.
