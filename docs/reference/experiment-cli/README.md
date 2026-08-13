# experiment

Tooling for running an Actana Core locally in a container and driving it from
the command line — creating projects, launching Claude Code sessions inside it,
reading what they said, and wiring a Panel to visualise the lot.

Two things live here:

- **`run-core-local.sh`** — builds the Core image and runs one instance
- **`core-client.ts`** — talks to that Core over its core-link protocol

## Requirements

- Docker
- Node 24 (`node` must be v24 — the client is TypeScript run directly, and the
  repo's build scripts refuse anything older)
- The `mission-control-updated` checkout beside this folder, for the image build
  and for the `ws` dependency reached through the `node_modules` symlink

## Quick start

```bash
./run-core-local.sh                                  # build and run the Core
docker exec rest-test cat /home/core/.config/actana/registration-blob.txt > blob.txt
node core-client.ts status                           # prove the connection
node core-client.ts project create /home/core/work   # register a directory
node core-client.ts session start <projectId> "summarise the README"
node core-client.ts session logs <taskId>
```

---

# `run-core-local.sh`

Builds the Core tarball and image if they are missing, then creates the
container. Safe to re-run: it reuses what exists and recreates only the
container.

```bash
./run-core-local.sh [--rebuild] [--reset]
```

| Argument | Meaning |
|---|---|
| `--rebuild` | force a fresh tarball and image even if they exist |
| `--reset` | destroy the volume too — **this unpairs the Core** and loses its data |

| Environment | Default | Meaning |
|---|---|---|
| `NAME` | `rest-test` | container name |
| `PORT` | `9443` | host port, and the Core's own port (they must match) |
| `PUBLIC_HOST` | `127.0.0.1` | the address baked into the certificate and pairing token |
| `IMAGE` | `actana-core:$NAME` | image tag |
| `VOLUME` | `$NAME-home` | named volume holding all Core state |
| `REPO` | current directory | path to the mission-control-updated checkout |

On macOS the Core tarball is built inside a Linux container automatically:
native modules are copied from the build host and never cross-compiled, so a
tarball built on macOS cannot go into a Linux image.

---

# `core-client.ts`

```bash
node core-client.ts <resource> <verb> [target] [options]
```

Resource first, then verb. The verbs repeat across resources, so `project ls`,
`session ls` and `harness ls` all behave the same way. `node core-client.ts
help` prints this from the CLI, and `help <resource>` drills into one.

**Targets** are flexible: a project is named by its id, its name or its path; a
session by its task id or its pty id.

**`--core <name>`** picks which Core to run against, the way kubectl picks a
context. It is global — it may appear anywhere in the line, and every resource
honours it.

## core

Each Core is one blob file in `blobs/`, named by the file's basename.

| Command | Arguments | What it does |
|---|---|---|
| `core ls` | — | list them: name, endpoint, label; `*` marks the one in effect |

| Name | Container | Endpoint |
|---|---|---|
| `developer` | `rest-test-2` | `wss://127.0.0.1:9444` |
| `pr` | `rest-test` | `wss://127.0.0.1:9443` |

```bash
node core-client.ts core ls
node core-client.ts --core pr project ls
node core-client.ts project ls --core pr     # identical
AC_CORE=pr node core-client.ts project ls    # for a whole shell
```

Naming them by purpose rather than by container or port is the point: a rebuild
that moves a port leaves `--core pr` working where a memorised
`wss://127.0.0.1:9443` would not.

Cores are separate machines as far as this client is concerned. Projects,
sessions and harness logins on one are invisible to the other, so a task id from
`developer` means nothing to `pr`.

Adding one is copying its blob in:

```bash
docker exec <container> cat /home/core/.config/actana/registration-blob.txt > blobs/<name>.txt
```

**Output** splits by stream — data on stdout, commentary on stderr:

```bash
SID=$(node core-client.ts session start scratch "summarise the README")
```

## project

Directories on the Core that sessions are allowed to run in. Registration is
not bookkeeping: the Core rejects any session whose working directory is not
inside a registered project.

| Command | Arguments | What it does |
|---|---|---|
| `project ls` | — | list projects: id, name, path |
| `project create` | `<path> [name]` | register a directory on the Core; name defaults to the last path segment |
| `project rm` | `<project> --yes` | unregister a project **and every session under it**; the directory on disk is untouched |
| `project browse` | `[path]` | browse the Core's filesystem, to find a path worth registering |
| `project inspect` | `<project>` | full detail as JSON |

## session

| Command | Arguments | What it does |
|---|---|---|
| `session ls` | `[--all]` | sessions with a live PTY; `--all` includes finished ones |
| `session start` | `<project> [prompt]` | launch a session, print its task id, exit |
| `session logs` | `<session>` | what the session has said so far |
| `session attach` | `<session>` | print the scrollback and keep streaming |
| `session send` | `<session> <text>` | wait for the screen to settle, type text, submit |
| `session enter` | `<session>` | press Enter only — unsticks a pending paste |
| `session interrupt` | `<session>` | press Escape — stop the turn, keep the session |
| `session resume` | `<task>` | relaunch a finished session with its conversation intact |
| `session kill` | `<session>` | end the session's process group for good |
| `session inspect` | `<task>` | full detail as JSON |

`interrupt` and `kill` are not the same thing: interrupt stops what Claude is
doing and leaves the session usable, kill ends it.

## harness

The agent CLIs the Core can launch. They are not baked into the image — they
install at runtime into the Core's home, which is the persistent volume.

| Command | Arguments | What it does |
|---|---|---|
| `harness ls` | — | availability, version and install path per harness |
| `harness install` | `<id>` | start installing one; returns immediately |

Ids: `claude-code`, `codex`, `cursor-cli`, `opencode`.

`install` is fire and forget. The install runs on the Core and takes minutes,
and the protocol only acknowledges the start, never the outcome — so the
command returns and `harness ls` is how you check whether it landed. The Core
re-probes when the install finishes; success means the probe now finds it.

Installing gets you the binary, not a login. Harness credentials live in the
Core's home directory, so each Core authenticates separately.

## status and events

| Command | Arguments | What it does |
|---|---|---|
| `status` | — | endpoint, label, protocol version, project and session counts, harness availability |
| `events` | `[--since N] [--kind <prefix>]` | stream the Core's event log |

`status` is also the cheapest proof the credentials work: it opens a real mTLS
connection and authenticates before printing anything.

Event kinds are prefixed `task:`, `session:`, `pty:`, `project:`, `agents:` and
`harness:`.

## Options

| Option | Applies to | Effect |
|---|---|---|
| `--core <name>` | everything | which Core to run against; may go anywhere in the line |
| `--follow` | `session start`, `session logs` | stream instead of returning |
| `--all` | `session ls` | include finished sessions |
| `--lines N` | `session logs` | how many lines to show (40) |
| `--raw` | `session logs` | untouched bytes, no terminal emulation |
| `--cols N` `--rows N` | `session logs` | replay geometry; must match the spawn (120x32) |
| `--harness <id>` | `session start` | which harness to launch (default `claude-code`) |
| `--model <id>` | `session start`, `session resume` | model to launch with |
| `--title <text>` | `session start` | task title instead of one derived from the prompt |
| `--enter` / `--no-enter` | `session send` | press Enter after the text (default), or hold it unsubmitted |
| `--now` | `session send` | skip the settle wait |
| `--ask-permissions` | `session start`, `session resume` | launch **without** auto mode |
| `--yes` | `project rm` | confirm the cascade |
| `--since N` `--kind <prefix>` | `events` | resume point, and filter by prefix |
| `--help` | anywhere | help for that resource |

## Credentials

The pairing blob is resolved in order:

| Source | Notes |
|---|---|
| `--core <name>` | `blobs/<name>.txt` |
| `AC_BLOB` | the base64 blob itself |
| `AC_BLOB_FILE` | a file holding it |
| `AC_CORE` | `blobs/<name>.txt`, the ambient default |
| `./blob.txt` | the unnamed local copy, as before |
| `docker exec` | against `$AC_CONTAINER`, default `rest-test` |

Nothing is cached between runs: each invocation decodes the blob, opens the
mTLS socket, and sends `auth` as its first frame. Each blob carries a client key
and a bearer — **do not commit them**. `blobs/` is mode 700 and its files 600,
and a `.gitignore` beside them excludes the directory.

A `--core` name is a bare identifier, not a path: `--core ../../something` is
rejected as an invalid name rather than read.

---

## Behaviour worth knowing before you rely on it

**Auto mode is the default.** Sessions launch with
`--dangerously-skip-permissions`, so Claude does not ask for tool approvals —
inside the container it reads, writes and executes in the project directory
unattended. `--ask-permissions` opts out.

**Startup dialogs are answered automatically.** Claude opens two blocking
dialogs — the bypass-permissions warning and the folder-trust prompt — once per
project per Core, and they are stored in the Core's home volume, so a new Core
means meeting them again. A session parked on one accepts no input at all, and
the bypass warning's highlighted default is `1. No, exit`, so anything that
presses Enter at it quits Claude instantly. `session start` and `session resume`
watch the screen and answer them, which is what makes auto mode unattended
rather than merely unprompted.

**`start` types the prompt itself** once the TUI stops redrawing. The Core's own
initial-input path fires 450 ms after spawn, before Claude accepts input, and
loses it.

**`send` sends the Enter separately** from the text, after a pause that scales
with length. Claude treats a burst of input as a paste and absorbs a same-frame
carriage return into it, leaving `[Pasted text #1 +1 lines]` unsubmitted.

**`logs` emulates a terminal** rather than stripping escape codes, because a TUI
positions text with cursor moves instead of spaces. It only works while the
session is alive — the scrollback belongs to the PTY.

**`resume` needs the harness session id** to have been recorded on the task. A
session that died early may not have one.

---

## The Panel

A Panel container visualises the same Core in a browser.

| Container | Port | Purpose |
|---|---|---|
| `panel-test` | `127.0.0.1:7420` | the Panel, volume `panel-test-data` |
| `panel-test-link` | — | socat relay inside the Panel's network namespace |

The relay exists because the pairing token points at `wss://127.0.0.1:9443` and
the Core's certificate is issued for that exact address — inside another
container `127.0.0.1` would be that container. It forwards raw TCP to the
Core's published port on the host, so the TLS passes through untouched.

To pair: open http://localhost:7420, create the Operator, and paste `blob.txt`
into **Add Core** (`pbcopy < blob.txt`).

## Other documents

| File | Contents |
|---|---|
| [note.md](note.md) | the requirements, as asked for |
| [action.md](action.md) | what was built and where things stand |
| [client-reference.md](client-reference.md) | the client's internals and module layout |
