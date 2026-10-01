# The Shared folder and its change feed

Issue [#561](https://github.com/actana/control/issues/561), Layer 1 of [#552](https://github.com/actana/control/issues/552).
Decisions D5 and D6 of [ADR 0041](adr/0041-the-0-5-0-core-model.md) say what the Shared folder is; this page says what
the Core does about it. ADR 0041's Open item "the Shared folder's change feed" (#561) is settled here.

## The folder always exists

`~/shared`, in the home of the user the Sessions run as. With no S3 configured it is a plain local folder and the Core
works fully on its own. It is made in three places, and each one is safe to run again:

| When | By whom | How |
|---|---|---|
| Install on metal | `actana setup`, as the operator | `ensureSharedFolder(home)` (`packages/shared/src/shared-folder.ts`) |
| Install of the container | the image seed, and `core-fs-prep.sh` for a root-owned bind mount | `deploy/core.Dockerfile`, `deploy/core-fs-prep.sh` (unchanged by #561) |
| Every boot, and while running | the Core | the watcher makes it again if it is missing |

The creation never asks for a privilege. In the container the daemon is `actana` and cannot read `/home/core`
(0750 `core:core`, ADR 0041 D24), so the folder is made, and watched, by a process that is already `core`.

A folder that is already there is left alone: its mode, owner and contents stay. A path that is a symbolic link, or a
file, is refused and never replaced: the Core logs it, boots without announcing the folder, and the rest of it works.

## `ready.shared`

The `ready` frame carries `shared: { version: 1, backend: "local" | "s3" }` when the Core keeps the folder and feeds its
changes. This Core announces `local`; `s3` is announced by the mount of #562. A Core that omits the field predates the
Shared folder, and is not "needs update", on the same terms as `files` and `multiConnection`.

The type is declared in the Core (`packages/core/src/shared-capability.ts`) until actana/client#4 (client PR 33)
reaches a published SDK, and is replaced by an import then.

## The change feed

A change is an ordinary event on the Core's existing event log, `kind: "shared:changed"`, with this payload:

```json
{ "path": "reports/r1.md", "size": 1204, "mtime": 1790856000123, "deleted": false }
```

- `path` is relative to the Shared folder, `/` separated. It never starts with `/` and never contains `..`.
- `size` is bytes, `0` when deleted. `mtime` is milliseconds since the epoch: the file's, or when the deletion was seen.
- It has the log's `eventId`, so a client that connected late or was away replays it by cursor with the rules every
  other event has (`subscribe` with `lastEventId`). Connected clients get it through the live push.
- It has no Session and no PTY (`sessionId` and `ptyId` are null).

### What counts as a change

- **Files only.** A new empty folder reports nothing. A removed folder reports each file that was in it as deleted.
- **A burst is one change.** Events from the filesystem only schedule a scan (150 ms after the last, and at most 1 s
  after the first); the scan is diffed against the last one. A hundred writes to a file are one event with its final
  size, and a file written and deleted inside one window is none.
- **Files that were there at boot are not changes.** The first scan is the baseline. A client that wants the current
  state asks the Files API (#557).
- **Nothing outside the folder is reported.** The scan never follows a symbolic link: a link is neither reported nor
  descended into, so `shared/out -> /etc` shows nothing from `/etc`.

### How it watches

Node's `fs.watch` with `recursive: true`, plus a slow safety scan every 30 s in case the watcher drops an event. Where
recursive watching is unavailable the Core logs `shared.watch-unavailable` and scans every 2 s instead. The code is
`shared-folder-watcher.ts`; `shared-folder-feed.ts` appends the events, and in the container starts the watcher as
`core` (`core-shared-watch.cjs`, beside `core-entry.cjs`), reading its answers on stdout and checking every field
before it becomes an event.

### Limits

Each changed file is one row in the event log, so a tree copied in at once (tens of thousands of files) is that many
rows; the log's existing replay limit applies to them like to any event.
