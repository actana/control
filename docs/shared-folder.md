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
changes. This Core announces `local`, and `s3` from the moment a controller has attached it (*The S3 sync*, below) until it detaches.
The announcement follows the watcher: it is read each time a connection is made, so it is absent until the
watcher has its baseline, absent while the watcher is down, and present on every connection made after it is up. Boot
waits for the watcher at most 10 s, on metal and in the container alike, and never longer. A Core that omits the field predates the
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

## The S3 sync

Issue [#562](https://github.com/actana/control/issues/562), the second half of the Shared folder.
[ADR 0041](adr/0041-the-0-5-0-core-model.md) D33 says who runs it: **the daemon user `actana`**, by the owner's ruling of
2026-10-01, which amends D25 (it said `core`). So no key is ever readable by `core`. Still no FUSE, no rclone, no AWS
SDK, and the daemon keeps exactly `CAP_SETUID` and `CAP_SETGID`.

```
controller ──sharedAttach / sharedCredentials / sharedDetach──▶ core-link (mTLS + Bearer)
                                                                   │  answered by sharedStatus
                                                                   ▼
daemon (actana) ── shared-sync.ts ── key: /var/lib/actana/shared-key.json (0600, dir 0700, actana's)
      │                │
      │                └── @actana/sdk/shared (S3 mode)  ──▶  S3 prefix of this Core, nothing else
      ▼
asCore ─▶ core-files-op.cjs (as core) ──▶ ~/shared      list / read / write / delete, confined to the home
                                                         the watcher (#561) then emits shared:changed
```

| File | What it is |
|---|---|
| `shared-key-store.ts` | the key and where the Core is attached; one 0600 file in the state directory, replaced atomically |
| `shared-sync.ts` | the passes, the three frames, expiry, unpair |
| `shared-home-io.ts` | `~/shared` through the Files helper started by `asCore` (in process on metal) |
| `pty-core-link-server.ts` | answers `sharedAttach`, `sharedCredentials`, `sharedDetach` with `sharedStatus` |

### The key

The controller pushes a **1-hour** key limited to this Core's prefix, about 15 minutes before the last one ends. The
daemon keeps one file, in `/var/lib/actana` (the state directory of D24), made 0600 and renamed into place, so a reader
never sees half of it. There is **no long-lived key on the Core**, none in a config, an environment variable or an
argument, and none in `core`'s home. The helper that touches `~/shared` is started with an environment `asCore` builds
and is sent a request and file bytes, never the key.

A request signs with whichever key is current when it is made. A push that lands during an upload leaves that upload
alone, and the next request uses the new key.

| Frame | Answer (`sharedStatus`) |
|---|---|
| `sharedAttach` | `attached` once the store accepted the key (a list of the prefix is made first), or `mount-failed` if it did not; `already-attached`; `invalid-frame` for a prefix that is empty or has a `.`, `..` or empty segment, or an `expiresAt` that is not in the future |
| `sharedCredentials` | `attached` with the new `expiresAt`; `not-attached` before an attach |
| `sharedDetach` | `detached` (see Unpair); `not-attached`; `mount-failed` when S3 could not be copied |

An invalid frame is also answered with a `sharedStatus`, not a bare `error`. A frame is never logged, and an error
message never carries any part of one.

### What a pass does

Every 15 s, and at once after an attach or a push, the sync lists `~/shared` (through the helper) and the prefix in S3 and
compares each path with what the last pass left behind.

| Changed here | Changed there | Done |
|---|---|---|
| yes | no | upload |
| no | yes | download, with the object's mtime |
| yes | yes | the newer mtime wins |
| gone, unchanged there | | delete there |
| unchanged here, gone there | | delete here |
| gone here, changed there | | the change wins: it comes back |

A path never seen before is "changed" on each side it exists on, so the first pass copies and never deletes. A download
is written in place, so it is noted in the sync's state first: a crash leaves the path marked, and the next pass takes the
object's version, never uploads half a file. A file over 128 MiB is left alone and logged once, because the SDK's S3 mode
moves a whole file through memory. A folder marker in S3 is not mirrored, and an empty folder is not uploaded: files only.

The sync **never follows a symbolic link**: the helper reports a link and the sync leaves it out, and when `~/shared`
itself is not a directory the pass does nothing. A path it is given is checked again by the helper's confinement (an
absolute path, a `..`, a link that leaves the home are refused).

### When the key has expired

No controller for more than an hour means the key stops working. The sync then sends **nothing** to S3 (it is read-only,
and so is its read side: there is no key to read with) and logs `shared-sync.key-expired` once. What `core` writes stays
in the folder. The next `sharedCredentials` push replaces the key and runs a pass at once, which uploads what was written
meanwhile. A Core paused for more than an hour does the same on waking. After a restart the stored key is loaded, and if it
has expired the sync waits for the push.

### Unpair

`sharedDetach` runs one pass that only **copies S3 into the folder**: a file missing here is written, a file S3 changed and
`core` did not is updated, a file both changed is left as `core` has it, and nothing is deleted. Then the sync stops, the key
and the sync's state are removed, and the folder keeps every file. If the key has expired, or a file could not be copied,
the answer is `mount-failed` and the Core stays attached: push credentials and detach again. Removing the S3 prefix of a
deleted Core is the controller's ([#564](https://github.com/actana/control/issues/564)).

### Events

Nothing here emits an event. What the sync writes into `~/shared` is seen by the watcher of #561, which runs as `core`, and
becomes the same `shared:changed` event as any other write (`shared-sync-events.test.ts` runs the two together).

### Proof

| Claim | Test |
|---|---|
| no key `core` can read | `shared-key-store-uids.test.ts`: the daemon's uid stores the key, `core`'s uid is refused it by the kernel (CI step, needs root) |
| the key file is 0600 in a 0700 directory, and is the key's only copy | `shared-key-store.test.ts`, `shared-sync-as-core.test.ts` |
| the daemon opens nothing in `~`; the helper gets no key | `shared-sync-as-core.test.ts` |
| machine A cannot list, read or write B's prefix | `shared-sync-seaweedfs.test.ts` (real SeaweedFS in CI); `shared-sync.test.ts` (fake S3) |
| a refresh during an upload | `shared-sync-seaweedfs.test.ts`; `shared-sync.test.ts` |
| an expired key, and writing again after a push | `shared-sync.test.ts` (fake clock) |
| unpair keeps the folder's contents | `shared-sync.test.ts`, `shared-sync-seaweedfs.test.ts` |
