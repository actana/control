# core-client — reference

```bash
node core-client.ts <resource> <verb> [target] [options]
```

Node 24 runs the TypeScript directly, so there is no build step. The only
dependency is `ws`, reached through the `node_modules` symlink into the
mission-control-updated repo.

`node core-client.ts help` prints all of this from the CLI itself, and
`help <resource>` drills into one.

## Layout

```
core-client.ts          entry point: routing, connection, error reporting
package.json            makes this a package (and silences Node's module warning)
src/
  protocol.ts           wire types, the request→result table, protocol version
  blob.ts               where the pairing credentials come from
  client.ts             the authenticated connection and its RPC correlation
  args.ts               flag parsing and the command context
  terminal.ts           the terminal emulator behind `session logs`
  commands/
    project.ts  session.ts  harness.ts  status.ts  events.ts  help.ts
```

Each command module exports one `run(client, ctx)`. Adding a resource means
adding a file and one line in `RESOURCES`.

## Grammar

Resource first, then verb, following Docker's shape. The verbs repeat, so
`project ls`, `session ls` and `harness ls` all behave the same way.

| Resource | Verbs |
|---|---|
| `core` | `ls` |
| `project` | `ls` · `create` · `rm` · `browse` · `inspect` |
| `session` | `ls` · `start` · `logs` · `attach` · `send` · `enter` · `interrupt` · `resume` · `kill` · `inspect` |
| `harness` | `ls` · `install` |
| `status` | — |
| `events` | — |

**Targets.** A project is named by its id, its name, or its path. A session is
named by its task id (durable) or its pty id (lives only as long as the
process). Both are accepted anywhere a session is asked for.

**Output.** Data on stdout, commentary on stderr, so ids can be captured:

```bash
SID=$(node core-client.ts session start scratch "summarise the README")
```

**Aliases.** Every flat command from before still works and expands to its
resource form: `projects`, `add-project`, `ls`, `sessions`, `start`, `tail`,
`attach`, `send`, `enter`, `resume`, `kill`, `harnesses`, `install`. `stop`
remains Escape — it maps to `session interrupt`, since changing what an
existing command does silently would be worse than the inconsistency.

## Options

| Option | Effect |
|---|---|
| `--core <name>` | which Core to run against — global, position-independent |
| `--follow` | `session start` / `session logs` stream instead of returning |
| `--all` | `session ls` includes finished sessions |
| `--lines N` | `session logs`: how many lines (40) |
| `--raw` | `session logs`: untouched bytes, no emulation |
| `--cols N` `--rows N` | `session logs`: replay geometry, must match the spawn (120x32) |
| `--harness <id>` | `claude-code` (default), `codex`, `cursor-cli`, `opencode` |
| `--model <id>` | model to launch the harness with |
| `--title <text>` | task title instead of one derived from the prompt |
| `--ask-permissions` | launch without auto mode |
| `--yes` | confirm `project rm` |
| `--since N` `--kind <prefix>` | `events`: resume point and filter |

## Credentials

Resolved in order: `--core <name>` → `AC_BLOB` → `AC_BLOB_FILE` → `AC_CORE` →
`./blob.txt` → `docker exec` against `$AC_CONTAINER` (default `rest-test`). The
last two are what the CLI did before named Cores existed, kept so that commands
already written keep working. Nothing is cached between runs: each invocation
decodes the blob, opens the mTLS socket, and authenticates.

`--core <name>` reads `blobs/<name>.txt`. The name is validated as a bare
identifier, so it cannot be used to read an arbitrary path. `core-client.ts`
strips the flag out of argv before routing, which is what makes it
position-independent and keeps it out of each verb's positionals; `core` is
itself answered from disk without opening a connection.

Each blob carries a client key and a bearer. Do not commit them.

## Behaviour worth knowing

**Projects gate everything.** A session may only run inside a registered project
root — the Core rejects any spawn whose working directory is outside one.

**Cores are isolated.** Ids do not cross: a task or project id from one Core
means nothing to another, and harness logins are per-Core because they live in
that Core's home volume.

**Auto mode is the default.** Sessions launch with
`--dangerously-skip-permissions`. Inside the container Claude will read, write
and execute in the project directory unattended.

**Startup dialogs are answered automatically.** Claude opens a
"Bypass Permissions mode" warning and a folder-trust prompt once per directory
per Core, recorded in that Core's home volume. A session parked on one accepts
no input at all, and the bypass warning's highlighted default is `1. No, exit`,
so anything that presses Enter at it quits Claude. `start` and `resume` render
the screen, match the dialog and answer it before delivering a prompt.

**Output frames are per-connection, not per-session.** The Core sends `data` for
every PTY on the link, so anything watching the stream must filter on `ptyId`.
`start` and `resume` route through `PtyStream`, which holds pre-spawn frames per
PTY and adopts its own once the spawn reply names it — without that, a second
session launched while the first is working never sees a gap in the output and
stalls for the full length of every timeout.

**`start` types the prompt itself.** It waits for the output to go quiet — the
TUI has finished painting — then types and submits. The Core's own
`initialInput` fires 450 ms after spawn, before Claude accepts input, and loses
the prompt.

**`send` splits the Enter from the text.** Claude treats a burst of input as a
paste, and a carriage return in the same frame is absorbed into it: the TUI
shows `[Pasted text #1 +1 lines]` and waits. The pause between the two scales
with length. `enter` sends the keystroke alone, to unstick one.

**`logs` emulates a terminal.** A TUI positions text with cursor moves rather
than spaces, so deleting escape codes yields unreadable soup. The output is
replayed into a screen buffer with scrollback and read back as text. It works
only while the session is alive.

**`interrupt` and `kill` are different.** Interrupt sends Escape: the turn
stops, the session survives with its conversation. Kill ends the process group.

**`harness install` is fire and forget.** The request acknowledges the start,
never the outcome, and the install takes minutes on the Core — so the command
returns immediately and `harness ls` is how you check whether it landed.
