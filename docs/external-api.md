# The HTTP surfaces

Actana Control has three HTTP surfaces, and none is a public integration API.
This page says what they are, so nobody has to guess from a port number.

> **History.** The root README used to document a Core API of
> `POST /api/projects/:id/tasks` and `POST /api/tasks/:id/status`, guarded by a
> token from `actana status`. **That design is retired and those routes do not
> exist.** Task and project writes now travel as core-link mutation frames, not
> HTTP ([ADR 0004](adr/0004-core-owns-write-path.md)); the loopback hook receiver
> below is the Core's only *unversioned* HTTP surface, and its `/v1/…` file
> routes are the only other one. The old text is corrected here rather than
> carried forward.
>
> This page said "the Core's only HTTP surface is the hook receiver" until
> [#165](https://github.com/actana/control/issues/165) added the file routes.
> That sentence is corrected above rather than deleted, because it is the kind
> of claim a reader may have taken a dependency on.

## A Core's hook receiver

Each Core runs a small HTTP server so that the harnesses it spawns can report
what they are doing. It is not an operator-facing API and there is nothing to
configure — the Core writes the hook entries into each harness's own config and
hands the credentials to the process in its environment.

| Property | Value |
| --- | --- |
| Bind address | `127.0.0.1` only — never the Core's public host |
| Port | Ephemeral (`listen(0)`), chosen by the OS at boot |
| Route | `POST /api/hooks/<slug>?taskId=…&hookEvent=…` |
| Auth | `Authorization: Bearer` — 32 random bytes minted **per boot**, held in memory, never persisted |
| Delivered as | `AC_HOOK_URL`, `AC_HOOK_TOKEN`, `AC_HOOK_TASK_ID` in the PTY's environment |

The command the Core writes into a harness's hook config reads the secret from
the environment rather than embedding it, so the config file on disk carries
nothing worth stealing:

```sh
curl -sS -m 3 -X POST \
  -H "Authorization: Bearer $AC_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  "$AC_HOOK_URL/api/hooks/<slug>?taskId=$AC_HOOK_TASK_ID&hookEvent=<event>"
```

A restart mints a fresh token, so a hook from a previous boot's PTY fails
auth — which is correct, because that session's process is gone.

## A Core's file routes

A Core answers `/v1/…` on the **same mTLS HTTPS server its core-link WebSocket
is mounted on** — one port, one certificate, one bearer, two protocols
([ADR 0028](adr/0028-file-bytes-cross-https-not-the-core-link.md)). File bytes
cross here and never over the core link: chunking a multi-gigabyte upload into
JSON frames would stutter every terminal pane sharing that socket, and base64
would cost a third of the wire.

This is not a public integration API either. It is reached with the material a
pairing issued — `CoreConnection.httpsBaseUrl` is the origin, and the same
client certificate and bearer the core link uses — and the surface a third
party is meant to type against is `project.files.*` in `@actana/sdk`.

| Property | Value |
| --- | --- |
| Origin | the Core's public host and core-link port, over `https://` |
| Auth | the pinned client certificate **and** `Authorization: Bearer <bearer>` — mTLS alone is not the gate |
| Announced by | `files: { version: 1 }` on the core-link `ready` frame; absent means this Core has no file surface |

Every route below rides that one capability, listing included: reads, writes and
listing shipped on the same unreleased train, so no Core anywhere announces
version 1 without all three and a client that checks for it is not guessing. A
Core that does not announce `files` is **not asked** — the affordance is
withheld rather than tried, because a 404 from a route that was never there
reads like an outage.

| Route | Does |
| --- | --- |
| `GET /v1/projects/:projectId/files?path=<relative>` | a file's raw bytes, or a directory as one streamed `application/x-tar` |
| `HEAD /v1/projects/:projectId/files?path=<relative>` | the same headers, no body |
| `PUT /v1/projects/:projectId/files?path=<relative>` | write — `Content-Type: application/x-tar` unpacks an archive into that path, anything else writes one file at it |
| `GET /v1/projects/:projectId/files/list?path=<relative>` | the tree under that path, as a chunked `application/x-ndjson` stream — one line per entry, to arbitrary depth |

`PUT` answers `200` with a chunked `application/x-ndjson` progress stream, one
line per entry carrying `{path, size, mtime, mode, sha256}` and a `result` of
`written` or `overwritten`, then a `done` line. A failure part-way through is
the last line rather than a status code, because the status line was spent on
the first entry.

### Listing

`GET …/files/list` streams the same five fields per entry, plus a `kind` of
`file`, `directory` or `symlink`. Paths are relative to the **Project root**,
not to the subtree that was listed, so what comes back is what goes into a
later `?path=`. Nothing is buffered at either end: entries go out as the walk
produces them and a large tree costs the Core the same memory as a small one.

| Parameter | Default | Means |
| --- | --- | --- |
| `path` | the Project root | which subtree to list. Naming a file lists that one file |
| `depth` | `all` | how many levels down to walk. `1` is the immediate children. A value that is neither `all` nor a whole number ≥ 1 is a `400`, never a silent "everything" |
| `sha256` | `0` | compute the digest of every file and symlink. Off by default — see below |

```jsonc
{"type":"entry","path":"src/index.ts","kind":"file","size":184,"mtime":1755000000000,"mode":420,"sha256":null}
{"type":"skipped","path":"vendor/locked","code":"unreadable-directory","message":"could not read this directory: EACCES"}
{"type":"done","entries":812,"skipped":1,"bytes":9433600}
```

A symlink is an entry and is **never followed**: its `size` is the length of
its target and, with `sha256=1`, the digest is of the target string. So a link
pointing out of the Project is reported as a fact about the Project without
anything on the other end of it appearing in the listing. A directory that
cannot be read, or a file that cannot be read to digest it, is a `skipped` line
and the rest of the tree still lists.

**A listing can also end without a `done` line.** A failure the walk cannot
blame on one path — the directory read itself failing part-way, a mount going
away underneath it — arrives as a fourth line type and the stream stops there:

```jsonc
{"type":"entry","path":"src/index.ts","kind":"file","size":184,"mtime":1755000000000,"mode":420,"sha256":null}
{"type":"error","code":"read-failed","message":"EIO: i/o error, scandir '/srv/project/vendor'"}
```

The status line was spent on the first entry, so this is the only place left to
say it — the same shape, and the same reasoning, as a `PUT` that fails
part-way. `error` and `done` are mutually exclusive: a `skipped` line costs one
path and the walk continues, while `error` **is** the walk stopping. So `done`
is the only proof a listing is complete, and a reader that reaches end-of-stream
without one is holding a truncated tree — a valid prefix of the listing, never
the listing. Treating a missing `done` as an empty tail is how a partial tree
gets mistaken for a whole one.

**`sha256` is available on request, not free**
([ADR 0027](adr/0027-the-filesystem-is-the-model.md) D6). On a transfer the
digest is computed eagerly, because the bytes are already in hand; a listing
never has them, so asking for digests means reading every byte under the path.
The field is present in every entry either way — `null` means "no bytes" for a
directory and "nobody asked" for anything else.

Refusals carry a machine-readable `code` beside the prose:

<!-- refusal-codes: start — the `Code` column of the tables between these
     markers is pinned to `CORE_FILES_ERROR_CODES` in `@actana/sdk` by
     `files-error-code-contract.ts`, which runs in both the SDK's and the
     Core's suites. Adding a refusal code goes red here until this table
     names it. Move a marker and you switch the check off. -->

| Status | Code | Means |
| --- | --- | --- |
| 400 | `absolute-path`, `dot-dot-segment`, `outside-project-root`, `malformed-path` | the path does not name anything inside that Project a write can land on. A 400 and not a 403: this is an accident guard, not a permission model ([ADR 0027](adr/0027-the-filesystem-is-the-model.md) D5). `malformed-path` also answers a single-file `PUT` whose path resolves to the Project root itself — see below |
| 401 | `unauthorized` | no bearer, or one this Core refuses |
| 400 | `bad-request` | a query parameter the surface does not understand — a `depth` that is not a number, a `sha256` that is not a yes or a no |
| 404 | `project-not-found`, `not-found` | no such Project on this Core, or no such path in it |
| 405 | `method-not-allowed` | `…/files/list` is a read: `GET` and `HEAD` only |
| 409 | `transfer-in-progress` | another write is already running on this Project. One write at a time per Project; reads are unrestricted and concurrent |
| 409 | `directory-in-the-way` | a **file** write landed on a path holding a non-empty directory. Overwrite-by-default replaces files; it does not delete trees |
| — | `root-entry-path` | a tar entry that is not a directory resolved to the unpack root itself. Reported as an NDJSON `error` line, since a tar `PUT` has already answered `200` by the time an entry is read — see below |
| 507 | `insufficient-storage` | the declared body length does not fit on the Project's filesystem. There is no size cap — only a fit check |

**The rest of the vocabulary has no status line to arrive on.** A tar `PUT` and
a listing both spend their `200` on the first entry, long before either is
finished, so a failure met part-way can only be said in the body: it comes back
as the NDJSON `error` line that ends the progress stream. `root-entry-path` is
one of these and is listed above rather than here, because it is the one an
ordinary `tar -cf - .` produces by accident and a reader looking up a refusal
will look for it beside the others.

| Code | Means |
| --- | --- |
| `corrupt-archive` | the bytes stopped being a tar: a header checksum that does not match, a stream that ended mid-record, a numeric field that is negative |
| `absolute-entry-path` | an entry named `/etc/passwd`. An unpack is always relative to the Project, and an absolute name is refused rather than reinterpreted |
| `dot-dot-entry-path` | an entry whose name carries a `..` segment |
| `entry-outside-root` | an entry whose destination resolved outside the Project — including through a symlink an **earlier entry of the same archive** created. Every entry is resolved through the symlinks that exist at the moment it is written, which is why this is checked after resolution and not on the string |
| `unsupported-entry-type` | a device node, a fifo, or any ustar type this surface does not create. A file transfer moves files, directories and links |
| `hardlink-outside-root` | a hard link whose target resolves outside the Project |
| `symlink-outside-root` | a symlink whose target resolves outside the Project. The link is refused; a symlink *pointing* out of a Project is still listed and still transferred as a link, since it is a fact about the Project rather than a way out of it |
| `directory-in-the-way` | the same refusal as the 409 above, met mid-archive instead of on a single-file `PUT` |
| `read-failed` | a **listing** stopped part-way for a reason no single path can be blamed for — the directory read itself failing, a mount going away underneath the walk. Distinct from a `skipped` line, which costs one path and lets the walk continue |
| `write-failed` | the write failed for a reason no entry can be blamed for — the disk filled mid-transfer, the filesystem returned an error. It is also the `500` this surface answers when a request fails in a way it cannot name |

<!-- refusal-codes: end -->

An `error` line **replaces** the `done` line and the transfer stops there.
Entries already written stay written: this is a stream, not a transaction, so a
client that cares which of them landed reads the `entry` lines it was sent
rather than assuming all or nothing.

A client that sends `Expect: 100-continue` is refused before it uploads a byte,
which is what makes the 409 immediate for a large transfer rather than merely
quick.

**Overwriting replaces a file; it never removes a tree.** A `PUT` of a single
file at a path that currently holds a non-empty directory is refused
`409 directory-in-the-way` rather than performed, and a tar entry that would do
the same is refused mid-archive with the same code. `tar(1)` refuses this case
too. A `PUT ?path=src` meant for `src/x.ts` is a typo, and answering it by
deleting `src` and reporting an ordinary `overwritten` line would make the
damage silent. An **empty** directory is still replaced — there is nothing to
lose, and a stray `mkdir` should not wedge a path forever.

**The Project root is never the target of a single-file write.** A `PUT` of one
file whose `path` resolves to the root — omitted entirely, `?path=`, or
`?path=.` — is refused `400 malformed-path`: a single-file write needs a name,
and "nothing to lose" is true of an empty subfolder and false of the root, which
has its shape to lose even when it holds no bytes. A Project whose root is a
regular file has no listing, no transfers and no working directory for a
harness. A `PUT` of a **tar** with an empty path is unaffected: that is the
legitimate "unpack into the Project root", a write of the root's contents rather
than of the root.

**Nor is it the target of a tar entry.** An archive carries the root's
contents, so an entry that resolves to the root itself — `.`, `./`, `./.`, a
nameless entry, a name that is nothing but slashes, or any of those arriving
through a pax `path` or GNU long-name override — is refused mid-archive with
`root-entry-path`. A *regular file*
entry named `.` reproduces the single-file case exactly: on an empty Project it
would delete the root and put a file at its path, and because a tar `PUT`
answers `200` before it reads a byte, the client would have been told the
transfer succeeded. The one exception is a **directory** entry naming the root,
which is the `./` header every `tar -cf - .` archive opens with: it is skipped,
not refused, and its mode bits are not applied — a dropped archive does not
restyle the Project root's permissions.

A write transfer holds its Project's lease only for as long as the request
lives. A client that aborts mid-upload — including one whose progress stream has
backpressured — releases it, so the 409 above is never permanent.

### `project.files.*` — the surface to type against

The routes above are the wire. What a third party writes against is
`@actana/sdk`, where the same three operations are `list`, `upload` and
`download` on a Project handle:

```js
const project = client.project(projectId);
for await (const entry of project.files.list()) …
for await (const line of project.files.upload({ path, body })) …
const { stream } = await project.files.download({ path });
```

| Property | Why it is that way |
| --- | --- |
| `list` is an async iterable of entries, from `GET …/files/list` | the same `{path, kind, size, mtime, mode, sha256}` lines the route streams, parsed. `path` and `depth` pass through, and `sha256: true` asks for digests — off by default, because a listing has no bytes in hand. `skipped` lines are passed over; an `error` line throws rather than ending the tree early |
| `download` returns a **stream, never a buffer** | a gigabyte file must not be resident. There is no method on the result that hands over bytes, so a caller that wants the whole thing writes that themselves |
| `upload` takes a stream and returns progress as an async iterable | one line per entry, each naming `written` or `overwritten`; a `done` line closes it. A mid-transfer failure is the last line, not a status code |
| all three are **pull-driven** | nothing runs ahead of the consumer. A slow reader becomes backpressure on the socket and then on the Core, rather than a queue filling in the client |
| the capability is checked **before every call** | against a Core that announces no `files`, they throw `CoreFilesUnavailableError` with the reason and send nothing |
| a conflict is an **error, never a retry** | `CoreFilesConflictError` carries the `code`. This package has no retry loop anywhere: a silent one would turn the Core's immediate refusal into a hang |

The client presents its certificate through an undici `Agent` — `fetch` has no
`cert`/`key` option, and the dispatcher is the only seam (#151). It uses
**undici's own `fetch`** rather than the global one, because a dispatcher only
satisfies the undici implementation it came from and Node embeds its own copy.

The client's listing URL and the route above are held together by a contract
test that drives `project.files.list` against the Core's real handler in one
process, registered in **both** packages' suites
([#218](https://github.com/actana/control/issues/218)). They disagreed once —
the client sent `?list=1` on the read route while the Core served
`…/files/list` — and every suite stayed green, because each side was checked
against its own idea of the other. A URL is not a fact either half owns alone.

### `actana project cp` / `actana project files` — the same surface, typed

The CLI is the first consumer of that SDK surface and consumes it as one: it
builds no URL, sets no header and has no `fetch` of its own
([#168](https://github.com/actana/control/issues/168)). Two things live on its
side of the seam because neither is the Core's to do.

**A folder is packed and unpacked locally.** The archive is the Core's format
([ADR 0029](adr/0029-a-folder-crosses-as-one-streamed-tar.md)) but whichever side owns
the disk owns the walk, so the CLI has its own ustar codec for the local half.
That is what carries `mode` across, which is what makes an executable arrive
executable.

**A local path is told apart from `<project>:<path>` by a rule.** A separator
before the colon means local — `./notes:draft.md`, `C:\dist` — and a single
letter followed by a colon and a separator is a Windows drive. Everything else
with a colon splits at the **first** one, so a colon inside a Project-relative
path needs no escaping. The `./` prefix is the escape hatch for a local file
whose name contains one, exactly as it is under `scp`.

The refusals cross intact rather than being reworded. `409
transfer-in-progress` in particular reaches the operator with the Core's own
sentence, which names the transfer holding the Project and when it started —
"busy" without those two facts is not something anybody can act on.

## The Panel's own routes

The Panel's `/api/*` surface exists to serve its own browser tab. It is
authenticated by the Operator's session cookie, which the browser attaches on
its own ([ADR 0011](adr/0011-operator-identity-and-panel-auth.md)) — there is no
bearer-token mode and no versioning promise. Harnesses never call it.

Task, project and session **reads and writes do not appear here**: they travel
over the panel link as core-link frames, because each Core owns that state
(ADR 0004). What is left is the Panel's own concerns:

| Area | Routes |
| --- | --- |
| Liveness | `GET /api/healthz` |
| Operator auth | `/api/auth/state`, `/api/auth/setup`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/password` |
| Core registry | `/api/cores` |
| Panel-side project presentation | `/api/projects`, `/api/projects/pinned-order`, `/api/project-presentation`, `/api/project-presentation/prune`, `/api/groups`, `/api/groups/order` |
| Preferences | `/api/settings`, `/api/keybindings`, `/api/home/user-terminals` |
| Usage and providers | `/api/usage`, `/api/provider-usage`, `/api/claude-usage-limits`, `/api/ai-runtime/models`, `/api/harness-launchers/accounts`, `/api/harness-launchers/latest-versions` |
| Live updates | `GET /api/events` (SSE) |
| Release check | `GET /api/update-check` |

`api-router.ts` is the authority; treat this table as a map, not a contract.

## Skill file for external CLIs

A drop-in skill for Claude Code / Codex / Cursor CLI lives in
[`skills/actana-notify.md`](skills/actana-notify.md). Paste it
into the CLI's instructions or memory so the harness knows to report its
lifecycle events back to Actana Control.

## See also

- [Observability](observability.md) — where a Panel's and a Core's logs land
- [`../DEPLOY.md#configuration`](../DEPLOY.md#configuration) — every environment variable
