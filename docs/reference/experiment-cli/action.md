# Where we are

What was built, in the order it happened, and what is running now.

## 1. Building the Core image

The Core image is defined in `mission-control-updated/deploy/core.Dockerfile`:
Ubuntu 24.04 pinned by digest, Node 24 and npm fetched from source and
checksum-verified, the build toolchain in, a `core` user pinned at uid/gid 1000
with passwordless sudo, tini as PID 1 and `actana daemon` as the command.
Harnesses are deliberately not baked in — they install at runtime into `$HOME`,
which is the persistent volume.

The image needs a Core release tarball baked into it, and that tarball is
per-platform: native modules are copied from the build host, never
cross-compiled. On macOS `pnpm core:tarball` therefore produces a `mac-arm64`
tarball the Linux image cannot use. The tarball was built inside a Linux
container instead, which is the path the repo documents in
`docs/core-linux-rehearsal.md`. One deviation was needed: pnpm refused to purge
a `node_modules` tree installed under a different store without a TTY, so the
build runs with `CI=true`.

Result: `actana-core-0.1.0-linux-arm64.tar.gz`, baked into the image
`actana-core:rest-test`.

`run-core-local.sh` reproduces all of this end to end.

## 2. Running the Core

One container, `rest-test`, published on `127.0.0.1:9443`, state on the named
volume `rest-test-home` mounted at `/home/core`.

`ACTANA_PORT` matches the published port deliberately: the pairing token embeds
the Core's own host and port, so a rewritten mapping would hand out a token
pointing at the wrong place.

On first boot the Core minted its identity and printed a pairing token. That
identity lives on the volume, so container restarts keep it — only destroying
the volume mints a new one. Verified: recreating the container produced no
second token.

Claude Code (v2.1.224) ended up installed at `/home/core/.local/bin/claude`,
inside the volume, so it survives image upgrades.

## 3. The client

`core-client.ts` talks to the Core over its core-link protocol. Node 24 runs the
TypeScript directly, so there is no build step; the only dependency is `ws`,
reached through a `node_modules` symlink into the repo.

The protocol, established by reading the Core's source:

- One JSON object per WebSocket message, flat envelope, correlated by `reqId`.
- mTLS is mandatory. The CA, client certificate and client key all come out of
  the pairing blob.
- `auth` must be the **first** frame sent. Anything else first gets
  `not-authenticated` and the socket is closed.
- The Core speaks first, unsolicited, with a `ready` frame carrying the
  protocol version (0.15.0).
- Sessions are spawned against a registered project: the Core validates that
  the working directory sits inside a known project root, that argv[0] is the
  harness's canonical binary, and that every flag is on an allow-list.

The pairing blob was then saved to `blob.txt` beside the script and is read from
there, rather than shelling into the container on every call.

## 4. What had to be fixed along the way

Four things broke in ways that were not obvious, and each needed a real fix
rather than a workaround:

**The prompt never reached Claude.** The Core's `initialInput` types the prompt
450ms after spawn, and Claude's TUI is not accepting input that early — the text
went nowhere and every session came up with an empty input box. The client now
delivers the prompt itself, watching the output stream and waiting for the first
gap in the redraws, which is when the TUI has finished painting.

**Auto mode killed sessions instantly.** Launching with
`--dangerously-skip-permissions` opens a blocking warning screen whose
highlighted default is `1. No, exit`. The prompt's Enter selected it, so Claude
quit before doing anything. Isolated by testing each variable separately: auto
mode alone survived, a prompt alone survived, the two together died in under
three seconds. The acceptance is stored per directory in `$HOME`, so answering
it once fixed it.

**`tail` was unreadable.** It stripped escape codes, which does not work on a
TUI: Claude positions text with cursor moves rather than spaces, so every frame
of every spinner redraw concatenated into one line of soup. `tail` now replays
the output through a small terminal emulator — cursor movement, erases, line
insert and delete, scrolling — and reads back what a terminal would be showing.
Lines that scroll off the top are kept, which is where the conversation
transcript lives.

**Long input sat unsubmitted.** `send` wrote the text and the carriage return in
one frame; Claude treats a burst of input as a paste and absorbed the return
into it, showing `[Pasted text #1 +1 lines]` and waiting. The Enter is now a
separate keystroke sent after a pause that scales with the length of the text.

Proof it works end to end: a session was given "please git clone the actana
control repo here", found `actana/control` through the GitHub org membership,
and cloned it to `/home/core/work/control`.

## 5. The Panel

A second container, `panel-test`, built fresh from `deploy/panel.Dockerfile` and
published on `127.0.0.1:7420`, with its state on the volume `panel-test-data`.

Wiring it to the Core needed one piece of care. The pairing token points at
`wss://127.0.0.1:9443` and the Core's certificate is issued for that exact
address — inside a second container, `127.0.0.1` is that container itself. The
repo's own reference deployment solves this by giving the Core a service name as
its public host, but that would have meant recreating the running Core.

Instead a third container, `panel-test-link`, runs a socat forwarder inside the
Panel's network namespace, relaying `127.0.0.1:9443` to the Core's published
port on the host. It is a raw TCP relay, so the Core's TLS passes through
untouched and the certificate still validates. Nothing about the Core changed.

## Running now

| | |
|---|---|
| `rest-test` | the Core, `127.0.0.1:9443`, volume `rest-test-home` |
| `panel-test` | the Panel, `127.0.0.1:7420`, volume `panel-test-data` |
| `panel-test-link` | socat relay in the Panel's namespace, 9443 → host |
| project `scratch` | `p-msip6kgd-54d3f5` → `/home/core/work` |
| cloned repo | `/home/core/work/control` |

Images: `actana-core:rest-test`, `actana-panel:local`.

## Not done

- **The Panel is not paired yet.** That means opening http://localhost:7420,
  creating the Operator, and pasting `blob.txt` into "Add Core" — account
  creation is yours to do.
- Several idle sessions from the debugging runs are still alive on the Core.
- `resume`, `attach`, `install`, `events`, `ls` and `project delete` are written
  but have not been exercised against the live Core.
