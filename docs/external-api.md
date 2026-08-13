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

This is not a public integration API either. It is reached with the material in
a **registration blob** — `CoreConnection.httpsBaseUrl` is the origin, and the
same client certificate and bearer the core link uses — and the surface a third
party is meant to type against is `project.files.*` in `@actana/sdk`.

| Property | Value |
| --- | --- |
| Origin | the Core's public host and core-link port, over `https://` |
| Auth | the pinned client certificate **and** `Authorization: Bearer <bearer>` — mTLS alone is not the gate |
| Announced by | `files: { version: 1 }` on the core-link `ready` frame; absent means this Core has no file surface |

| Route | Does |
| --- | --- |
| `GET /v1/projects/:projectId/files?path=<relative>` | a file's raw bytes, or a directory as one streamed `application/x-tar` |
| `HEAD /v1/projects/:projectId/files?path=<relative>` | the same headers, no body |
| `PUT /v1/projects/:projectId/files?path=<relative>` | write — `Content-Type: application/x-tar` unpacks an archive into that path, anything else writes one file at it |

`PUT` answers `200` with a chunked `application/x-ndjson` progress stream, one
line per entry carrying `{path, size, mtime, mode, sha256}` and a `result` of
`written` or `overwritten`, then a `done` line. A failure part-way through is
the last line rather than a status code, because the status line was spent on
the first entry.

Refusals carry a machine-readable `code` beside the prose:

| Status | Code | Means |
| --- | --- | --- |
| 400 | `absolute-path`, `dot-dot-segment`, `outside-project-root`, `malformed-path` | the path does not name anything inside that Project. A 400 and not a 403: this is an accident guard, not a permission model ([ADR 0027](adr/0027-the-filesystem-is-the-model.md) D5) |
| 401 | `unauthorized` | no bearer, or one this Core refuses |
| 404 | `project-not-found`, `not-found` | no such Project on this Core, or no such path in it |
| 409 | `transfer-in-progress` | another write is already running on this Project. One write at a time per Project; reads are unrestricted and concurrent |
| 409 | `directory-in-the-way` | a **file** write landed on a path holding a non-empty directory. Overwrite-by-default replaces files; it does not delete trees |
| 507 | `insufficient-storage` | the declared body length does not fit on the Project's filesystem. There is no size cap — only a fit check |

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

A write transfer holds its Project's lease only for as long as the request
lives. A client that aborts mid-upload — including one whose progress stream has
backpressured — releases it, so the 409 above is never permanent.

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
