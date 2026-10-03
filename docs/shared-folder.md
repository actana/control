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
2026-10-01, which amends D25 (it said `core`). So, **in the container, where the daemon and `core` are two users**, no key is ever readable by `core` (see *Where the key is not isolated*). Still no FUSE, no rclone, no AWS
SDK, and the daemon keeps exactly `CAP_SETUID` and `CAP_SETGID`.

```
controller ──sharedAttach / sharedCredentials / sharedDetach──▶ core-link (mTLS + Bearer)
                                                                   │  answered by sharedStatus
                                                                   ▼
daemon (actana) ── shared-sync.ts ── key: <state dir>/shared-key.json (0600, dir 0700, actana's)
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
daemon keeps one file, `shared-key.json`, in its data directory (`AC_USER_DATA_DIR`, `/var/lib/actana/data` in the container, under the state directory of D24), made 0600 and renamed into place, so a reader
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

### Where the key is not isolated

The guarantee that no Session can read the key holds **only where the daemon and `core` are two users**, which is the
container (`deploy/core-entrypoint.sh` sets the `AC_CORE_*` identity). On an install with **one user** (`actana setup` on
metal) the daemon and the Sessions are the same uid, so a Session can read the key file in the daemon's data directory, as it
can everything else the daemon keeps there. Nothing in this PR can change that without a second user. The sync still works
there, with a key valid for an hour and limited to the Core's own prefix, and the Core is plain about it:
`ready.shared` carries `keyIsolated: true` **only** when the users differ, and never otherwise; the daemon logs
`shared-sync.key-not-isolated` when it takes a key; and a client that wants the guarantee must read that field and not
assume it (`shared-sync.test.ts › a Core on one user does not claim a key nobody can read`).

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

A folder the listing could not read (a `chmod 000`, a failed `opendir`) is **unknown, not empty**: nothing under it is
decided in that pass (no upload, download or delete there), a listing that did not reach its closing `done` line stops the
pass, and the rest of the folder syncs as usual. Before a download overwrites a file, or a deletion removes one, the file is
looked at again, and one that changed since the listing waits for the next pass. A download keeps the mode of the file it
replaces.

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
deleted Core is the controller's ([#564](https://github.com/actana/control/issues/564)), described in *The Panel's side* below.

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

## The Panel's side

Issue [#564](https://github.com/actana/control/issues/564), the controller of the frames above. The Panel holds the storage config and the
master key, makes the Shared folder the last step of pairing, and keeps each Core's 1-hour key fresh.

```
Settings › Storage / pairing step 4 ──PUT /api/storage (master key write-only)──▶ storage_config  (key sealed like core_secrets)
Settings › Storage ──POST /api/storage/test──▶ issuer.issue(probe) ──▶ probe own folder ✓, another Core's folder ✗
pairing step 4 ──POST /api/cores/:id/shared/test──▶ issuer.issue(core) ──▶ probe own folder ✓, another Core's folder ✗
               ──POST /api/cores/:id/pairing/finish──▶ sharedAttach ──▶ Core ──▶ core_shared_folders: attached
timer (refresh point of the SDK: 15 min before the end, at most half its life) ──▶ sharedCredentials ──▶ Core
DELETE /api/cores/:id ──▶ sharedDetach (Core keeps ~/shared) ──▶ Core row forgotten, S3 prefix left
POST /api/cores/:id/delete {confirmPrefix} ──▶ prefix typed exactly ──▶ sharedDetach ──▶ ~/shared emptied (link up) ──▶ Core row removed ──▶ its prefix emptied
```

| File | What it is |
|---|---|
| `packages/panel/src/server/services/storage.ts` | the config, backends (SeaweedFS default, STS, Supabase, R2), and the two places the master key is unsealed: `storageKeyIssuer` (into the SDK issuer) and `storageJwks` (public half only) |
| `packages/panel/src/server/services/shared-folders.ts` | test, finish pairing, push, rotation, detach, delete, Settings per-Core rows |
| `packages/panel/src/server/repositories/{storage,core-shared-folders}.repo.ts` | `storage_config`, `core_shared_folders` (migrations `0006`, `0007`) |
| `packages/panel/src/components/views/SharedFolderStep.tsx` | step 4 of the pairing wizard |
| `packages/panel/src/components/views/StorageSettingsPage.tsx` | Settings › Storage (screen 08) |

- **The master key** is write-only. For SeaweedFS it is an RSA private key PEM; for Generic STS it is JSON `{accessKeyId,secretAccessKey}`; for R2 the Cloudflare API token; for Supabase JSON `{serviceRoleKey,jwtSecret}`. It is written by `PUT /api/storage`, which is write-only: nothing returns it, and the read says only `masterKeySet` and `masterKeyRotatedAt`. It is never logged, never in an error message, never in a frame. Rotating it (a PUT that carries a new master key) re-issues 1-hour keys to every connected attached Core. The SDK issuer returns the four fields of a key; those are all a Core ever receives. There is no public credentials route.
- **SeaweedFS is the default** in Settings › Storage (screen 08, [#566](https://github.com/actana/control/issues/566)). The other backends use the matching `@actana/sdk/shared-key` issuers.
- **Upload size limit** is stored on `storage_config` (default 512 MiB) and shown on the Settings page; the Files tab applies it.
- **Pairing from the Panel** registers the Core with its folder `pending` in the same transaction as the Core row. The finish route repeats the connection
  test, sends `sharedAttach`, and only then marks it `attached`. A refusal (no storage, a Core that is offline or announces no
  `shared`, a key that reaches another folder, a Core that answers with an error) leaves it `pending`. The first-run wizard does not count a
  pending Core as a fleet. The CLI's pairing has no such step, and a Core registered before 0.5.0 has no folder row and is not asked for one.
- **A Core that is already attached when step 4 runs** (it answers `sharedAttach` with `already-attached`) is asked to `sharedDetach`, never
  given a key: a detach only copies S3 into `~/shared`, while a key makes the Core run a deleting pass, which with its S3 folder emptied
  by a delete would empty its own `~/shared`. If it cannot detach (its key has run out) it is left as it is and the Core stays `pending`
  with the reason. The table of every case is in `shared-folders-attach-table.test.ts`.
- **Rotation** pushes `sharedCredentials` at the SDK's refresh point, falling back to `sharedAttach` when the Core says `not-attached`. A push
  that fails is retried (5 s, 15 s, 60 s, then 5 min), the Core's folder goes to `error` with the reason, and the Panel logs it:
  never silently. A reconnecting Core gets a new key at once; at boot every attached Core does. A master-key rotate also re-issues immediately.
- **Unpair** sends `sharedDetach` with `keepLocalCopy`; the Core copies S3 into `~/shared` and stops. A Core that cannot be told is still forgotten, and
  the answer says so.
- **Delete** needs the folder's exact prefix (`<prefix>/<core id>/`) typed back. It first asks the Core to `sharedDetach`, then, while the Core's link is up, empties `~/shared` on the machine through the Core's Files API
  (the children only; a symlinked `~/shared` is left alone and a symlink inside it is removed as a link, never followed). It then removes the Core row and
  empties that prefix with a key issued for that Core, which the role limits to it and which the SDK's S3 mode cannot widen. A Core that is not connected does not
  stop the delete: it finishes on the Panel, the answer carries `machineFolder: { state: "kept", reason }` and the screen says `~/shared` stays on the machine.
  A prefix that could not be emptied is an error that names it.

| Claim | Test |
|---|---|
| the master key is in no response, log line or frame | `storage-config-api.test.ts`, `shared-folders.test.ts`, `shared-folder-pairing-api.test.ts` |
| the key is sealed at rest, rotated by a write, kept by an edit | `storage-config-api.test.ts` |
| Settings › Storage test-connection isolation | `storage-config-api.test.ts` (fake S3), `shared-folders-seaweedfs.test.ts` (real SeaweedFS in CI) |
| rotate PUT re-issues `sharedCredentials`; edit without a key does not | `storage-config-api.test.ts` |
| per-Core folder size and key expiry on GET `/api/storage` | `storage-config-api.test.ts` |
| the Panel refuses to finish pairing without storage, offline, or with a leaking key | `shared-folder-pairing-api.test.ts`, `shared-folders.test.ts` |
| keys rotate 15 minutes early, hourly, with a back-off and a visible error | `shared-folders.test.ts` (fake clock) |
| unpair keeps the Core's folder | `shared-folder-pairing-api.test.ts` |
| delete touches only its own prefix | `shared-folder-pairing-api.test.ts` (fake S3), `shared-folders-seaweedfs.test.ts` (real SeaweedFS in CI) |

## The Panel's Files tab

Issue [#565](https://github.com/actana/control/issues/565), part 1 (the Storage settings page is part 2 of #566). A Core's page has a
**Files** tab that shows its Shared folder as a Drive: a folder tree, folders as tiles and files as cards with previews, breadcrumbs,
Grid and List, search by name, a details pane (Download by a 5-minute signed URL, Copy path, Rename, Move, Delete with a confirmation),
the **New** menu (New folder, Upload files, Upload folder with its tree, New text file), drag-in with a progress row per file, and a
**new** badge on files written since the operator last had the tab open.

It reads S3 directly, **never the Core**, so it works while the Core is offline or paused (a banner says so), and what it writes reaches
the Core through the Core's own sync (*The S3 sync*, above):

```
browser ──/api/cores/:id/shared/files/…──▶ Panel (session owner, path rule) ── SDK CoreShared S3 mode ──▶ S3 prefix of this Core
                                              │   key: 1 hour, from the issuer, this Core's folder only          │
                                              └── master key: read only by storageKeyIssuer, never returned ◀──┘
```

| Route (under `/api/cores/:coreId/shared/files`) | What it does |
|---|---|
| `GET ?path=` | the direct children of a folder, folders first, with item counts |
| `GET /details?path=` | one file: size, time and a text preview (a log from its tail) |
| `GET /media?path=` | an image or PDF inline, streamed by the Panel (never an SVG or a page) |
| `POST /download-url` | `{ url, expiresAt }`: one object's URL, five minutes, minted here |
| `GET /search?q=` · `GET /summary?since=` | names anywhere in the folder · bytes used and the files written after `since` |
| `POST /mkdir` · `PUT /upload?path=` | a folder · one file, counted against the upload limit as it streams in |
| `POST /rename` · `POST /move` · `POST /delete` | the root is refused; a folder moves, renames and deletes with its contents |

- **No key reaches the browser.** The master key has two readers: `storageKeyIssuer`, and `storageJwks`, which returns only the public half for `/.well-known/jwks.json`. A Core's 1-hour key stays in the Panel's memory,
  limited to `<prefix>/<core id>/`, and is replaced six minutes before it ends. The one credential-bearing thing a browser receives is
  the download URL, which the SDK signs for one object and which ends in five minutes.
- **Who may ask** is decided on every call from the database: the session's owner must own the Core and the Core must have a finished
  folder, whatever key is in memory. A stored folder that is not `…/<core id>/` is refused.
- **Paths** from the browser are checked in `shared/shared-files.ts` (`checkSharedPath`) before a key is asked for: no leading `/`, no
  `.` or `..` segment, no empty segment, no backslash or control character. The SDK checks again.
- **The upload limit** is `DEFAULT_UPLOAD_LIMIT_BYTES` (100 MB) until the Storage settings page stores one beside the rest of the
  storage config; the config model of #564 is unchanged. One file is held in memory while it is written, because the SDK's `put`
  takes bytes.
- **Open folder** on a Task opens `?tab=files&path=tasks/<task id>`. Attaching files to a Task is not in this part.
