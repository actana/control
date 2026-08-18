# Harness status detection

How Actana Control knows whether a Session is **working**, **idle**, or
**waiting on a human** — and how that answer reaches the card.

The short version: **the Core detects, the Core writes, the Panel renders.** A
Task lives on the Core that owns it (ADR 0004), the harness runs on that Core's
machine, and its hooks report to that Core. Nothing in this path round-trips
through the Panel; the Panel learns about a status change the same way it learns
about everything else on a Core — as an Event replayed off its cursor.

## Where each piece lives

| Piece | Module |
| --- | --- |
| Hook receiver (loopback HTTP) | `packages/core/src/harness-hook-receiver.ts` |
| Hook file writers, per harness | `packages/core/src/harness-hooks.ts` |
| The decisions (event → status) | `packages/shared/src/harness-hook-pipeline.ts` |
| Subagent bookkeeping | `packages/shared/src/subagent-activity.ts` |
| Status/title writes + events | `packages/core/src/core-task-writer.ts` |
| Title generation | `packages/core/src/core-title-generator.ts` |
| PTY exit settle | `packages/core/src/pty-manager.ts` → `onSessionExit` |
| Hook delivery misses | `packages/core/src/harness-hook-delivery.ts` |
| Quiet-Session backstop | `packages/core/src/core-session-backstop.ts` |
| Boot sweep | `packages/core/src/core-session-sweep.ts` |

The Panel keeps a hook endpoint (`POST /api/hooks/<slug>`) for its own remaining
local task rows, running the same shared pipeline. A Core-owned Session never
reaches it.

## Standard mechanism: harness lifecycle hooks

Claude Code, Codex and Cursor CLI emit lifecycle hooks we can subscribe to from
outside the process. The Core installs them per workspace at spawn time, so each
Session reports its own state.

A new Session starts in `ready` (terminal spawned, prompt waiting). The first
hook flips it.

| Hook event                         | Mapped status   | Meaning                                  |
| ---------------------------------- | --------------- | ---------------------------------------- |
| _(spawn)_                          | `ready`         | Terminal up, operator hasn't typed yet   |
| `UserPromptSubmit`                 | `running`       | Prompt submitted; work began             |
| `Stop`                             | `finished`\*    | Foreground turn ended (see below)        |
| `SubagentStart` / `SubagentStop`   | _(bookkeeping)_ | Tracks still-active subagents            |
| `PermissionRequest`                | `needs-input`   | Permission / tool approval requested     |
| `Notification` `permission_prompt` | `needs-input`   | Claude permission notification fallback  |

\* `Stop` fires when the **foreground** turn ends — including while background
subagents (Task tool harnesses) the turn launched are still running. Treating it
as `finished` unconditionally dinged the operator mid-work. So the pipeline
counts `SubagentStart`/`SubagentStop` per task (paired by the payload's
`agent_id`, whose `session_id` is the parent session's) and downgrades a `Stop`
to `running` while any subagent is still active. A background subagent's
completion re-invokes the main harness, and *that* turn's `Stop` — arriving with
no active subagents left — lands as the real `finished`. Neither subagent event
maps to a status on its own, but one arriving **moments after** a task finished
heals it back to `running` (a `Stop` won the race against the turn's own subagent
lifecycle POST).

That heal is scoped to a 30-second recent-finish window because Claude Code also
runs **post-turn internal helpers** whose subagent events carry the parent
session id: refocusing a finished session generates an *away summary*, firing
`SubagentStart`/`SubagentStop` minutes after the finish, with no `Stop` to
follow. Healing on those wedges tasks on `running` forever (the original
stuck-on-running bug). Beyond the window, helper events are ignored for status
and their starts are not tracked — a lost helper stop would otherwise hold the
next turn's `Stop` for the whole TTL.

Backstops, so a `SubagentStop` that never arrives (lost POST, killed process) —
or a healed `running` that no `Stop` will ever follow — cannot hold a task on
`running` forever. The first three are armed **by a hook that arrived**; the
fourth is armed by nothing, which is the point (issue 243):

- Tracked entries expire after 2 hours (kept long on purpose — a short TTL would
  prematurely finish sessions whose subagents legitimately run long).
- A held `Stop` (and a recent-finish heal) arms a once-a-minute recheck. Once the
  tracked set is idle — drained by real `SubagentStop`s or by expiry — a 3-minute
  drain grace starts: if the re-invoked main harness's own `Stop` lands the finish
  within it (the normal flow), the backstop's promotion is a no-op (it only fires
  on tasks still `running`); if nothing follows, the backstop promotes to
  `finished`. New subagent activity resets the grace; a new `UserPromptSubmit`
  disarms it.
- Tracking is dropped outright when a new session id is captured, on
  `SessionStart` with `source: "clear"` (same session id, but `/clear` kills
  background work), and when the PTY process exits.
- **The quiet-Session backstop** (`core-session-backstop.ts`) sweeps the
  database once a minute and settles any row still claiming `running` that has
  gone quiet. Nothing arms it, so it covers the case the three above cannot: a
  turn whose terminal `Stop` was the POST that dropped, where nothing was held,
  nothing was healed and no subagent was ever tracked.

Elapsed time is not what "quiet" means, and it could not be — a turn may run for
hours. A working harness never stops talking: every tool call fires the
unmatched `PostToolUse`, and its TUI redraws a spinner and elapsed-time counter
into the PTY about once a second. So **hooks and PTY output both count as
activity** (output throttled to one report per five seconds per PTY), a row's
own `updated_at` is the floor for a Session the process has not heard from yet,
and **fifteen minutes with neither** is read as a turn that ended without anyone
being told. A live PTY makes that settle a `finished`; no live PTY makes it a
`disconnected`, because a process that went away did not finish. `needs-input`
is never swept — a Session waiting on a human may wait silently forever.

The trade is knowingly paid: a harness that works in total silence for longer
than the window gets a card that reads `finished` while it is still going.
Nothing is killed, and the next `UserPromptSubmit` puts the row back on
`running`. Before it, a lost `Stop` wedged the Session until a human edited the
row by hand — while the Panel said the opposite.

`Notification` is also intentionally narrowed to `permission_prompt`. Claude Code
sends idle input reminders through the same hook event, so treating all
notifications as `needs-input` creates false positives that later flip to
`finished` when the real `Stop` arrives.

These values were tuned against the failure modes above. Do not change them
without a failure that says so.

## The hook receiver

The Core exposes a small **loopback HTTP** listener a hook's shell command can
reach from the Core's own machine:

```
POST http://127.0.0.1:<ephemeral>/api/hooks/<harness-slug>?taskId=<id>
Authorization: Bearer <token>
```

Three decisions, and why:

- **HTTP, not a unix socket.** Every vendor's hook config takes a shell command
  and assumes `curl`. A socket would work, but costs a `--unix-socket` flag on
  every hook of every harness, forever. What it would have bought is bought
  instead by binding `127.0.0.1` only and by the bearer below.
- **The Core mints the token, per boot, in memory.** The retired design passed a
  bearer down from the Panel; there is no Panel in this hop any more. It is never
  persisted and never written into a hook file — the spawn path puts it in the
  PTY's environment (`AC_HOOK_TOKEN`) and the hook command reads it from there,
  so a workspace the operator commits carries no secret and a restart that mints
  a fresh token strands nothing that matters.
- **An ephemeral port (`0`), published as protected.** Asking the OS avoids both
  a collision with the core-link port and a guessable target. The chosen port
  joins `getProtectedPorts`, so the Core's own port-kill path can never take the
  receiver down and strand every Session's status.

**This cannot be a route on the core-link listener.** In remote mode that server
is HTTPS with `requestCert: true, rejectUnauthorized: true` — it demands a Panel
client certificate at handshake, which a hook subprocess on the same machine
cannot present — and it binds the Core's public host, not loopback.

## Hook installation at spawn

`installHarnessHooks(harness, cwd)` (`harness-hooks.ts`) writes the workspace
file each family reads:

| Harness | File |
| --- | --- |
| `claude-code` | `<cwd>/.claude/settings.local.json` |
| `codex` | `<cwd>/.codex/hooks.json` |
| `cursor-cli` | `<cwd>/.cursor/hooks.json` (needs `"version": 1`, or the CLI ignores it) |

An operator's own hooks are preserved; ours are tagged `_acManaged: true` so the
next spawn replaces exactly what a previous spawn wrote. Entries the retired
Electron app left behind under `_mcManaged` are swept out at the same time,
rather than left POSTing to an endpoint that no longer exists. The registry is
open — adding a harness family is adding a row, and every per-harness difference
stays inside the Core process, never in the Panel.

The registry also records whether a family's hooks announce a turn's **start**,
which is a narrower question than whether they were installed:

| Harness | Hooks installed | Reports turn start | Why |
| --- | --- | --- | --- |
| `claude-code` | yes | yes | `UserPromptSubmit` fires |
| `codex` | yes | no | won't run new hooks until `/hooks` review |
| `cursor-cli` | yes | no | `beforeSubmitPrompt` doesn't fire in cursor-agent |
| `opencode` | yes | yes | plugin; `chat.message` and `session.status` fire |

Only the third column exempts the terminal-input fallback below.

Three of the four families take a table of shell commands. OpenCode takes a
JavaScript plugin instead, and its writer is `harness-hooks-opencode.ts` — see
[OpenCode](#opencode) below.

Each managed entry runs:

```sh
sh -c 'curl -sS -m 3 -X POST \
  -H "Authorization: Bearer $AC_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  "$AC_HOOK_URL/api/hooks/claude?taskId=$AC_HOOK_TASK_ID" || true'
```

The harness pipes the hook payload (`hook_event_name`, `session_id`, `cwd`,
`transcript_path`, …) on stdin; the command forwards it as the request body.
`|| true` is load-bearing: a hook must never block or fail an operator's session.

### Delivery, and what happens when there is none

Fail-soft is not the same as silent, and until issue 243 this path was both. A
`-m 3` POST against a Core whose event loop is also serving PTY fan-out, SQLite
writes and file transfers is reachable under load, and `|| true` swallowed a
timeout, a connection refused, a 401 and a 500 identically. Nothing on either
side recorded the attempt, so a lost hook left no trace anywhere — and a lost
terminal `Stop` wedged its Session on `running` with nothing to say why.

Both ends now account for it:

- The command adds `-f`, so a non-2xx answer is a failure rather than a silent
  success, and `--retry 2 --retry-delay 1`, which retries what curl calls a
  transient error — the timeout, above all. Three attempts bound the worst case
  at about eleven seconds, well inside a harness's own hook timeout, and only on
  the path where the Session's status is already wrong. `--retry-connrefused` is
  deliberately absent: it would raise the curl version the command needs, and a
  refused connection means the Core is down.
- What still could not be delivered is appended to `$AC_HOOK_MISS_LOG`
  (`<user-data-dir>/hook-misses.log`) as one tab-separated
  `<iso8601> <taskId> <event> <curl exit>` line. Unset, the record goes to
  `/dev/null` — a workspace opened by hand writes nowhere rather than failing.
- The receiver counts the hooks it accepts and answers with that delivery
  number, so an ack is a fact rather than an empty 200.
- `HookDeliveryMonitor` drains the miss log into the Core's log with a running
  total, starting at boot: a hook refused during a restart is exactly the drop
  nobody would otherwise hear about.
- OpenCode's plugin does the same in its own idiom — it checks `res.ok`, retries
  once, and writes the same line.

`-o /dev/null` rides along and is not cosmetic: Claude Code reads a hook's
stdout as control JSON, so the receiver's answer had no business being printed
there.

The command still ends in `|| true`, and still means it: a delivered hook
short-circuits the chain, a dropped one records itself first, and a record that
cannot be written falls through to it.

## How a status change reaches the card

1. The receiver hands the payload to `CoreHarnessStatus`.
2. That runs the shared pipeline, which decides the status.
3. The write goes through `CoreTaskWriter` — the **one** seam every task-row
   change uses, the Panel's `tasksMutate` frame included. It writes the Core's own
   SQLite and appends the matching event (`task:updated`, plus `session:finished`
   on a transition into `finished`, which is what #20's notification routes on).
4. A subscribed Panel receives that event live; a Panel that was away replays it
   off its `lastEventId` cursor. Either way the card re-renders with no manual
   refresh, and the Panel's own database is untouched.

Cache invalidation on the Panel targets the **`coreId`-tagged** task bucket
(`tasksCacheKey(projectId, coreId)`). A write path that invalidates the untagged
key leaves a Core-owned card exactly as stale as before.

## Dead-process fallbacks

Hooks only fire while the harness process lives, so out-of-band signals settle
Sessions whose process is gone:

- **PTY exit** — `pty-manager.ts` calls `onSessionExit` on every agent PTY exit,
  for any reason: the operator closed the pane, the process crashed, it was
  killed. It runs whether or not a Panel is connected, because the Core's PTY
  lifecycle is not the Panel's to observe. The Core moves Sessions still in an
  **active** status (`running` / `needs-input`) to `finished` (exit 0) or
  `terminated`, drops their tracked subagents, and leaves settled Sessions
  untouched — which keeps respawn flows and finished sessions unaffected.
  The Panel's own exit patch no longer fires for a Core-owned row: it was
  unconditional, so it would overwrite an `interrupted` Session with `finished`
  and raise a spurious `session:finished` besides.
- **Boot sweep** — `core-session-sweep.ts` runs once per Core boot, before the
  PTY core, the hook receiver or the core-link server can produce a Session of
  this run. At that moment no PTY of this process exists, so every row still
  claiming `running` / `needs-input` is an orphan of the previous one: a Core's
  PTYs die with it, silently, with no exit callback and no `pty:exit`. Each is
  written to `disconnected` through `CoreTaskWriter`, so the settle appends the
  `task:updated` event a connected Panel re-renders from — a sweep nobody is
  told about leaves the operator looking at the same wrong card.

  `disconnected` rather than `finished` or `terminated`: it is the status the
  Panel already uses for a process that went away without reporting, and it
  claims nothing about how the work ended. The Panel has had this sweep for its
  own rows all along; what it never had was scope over Core-owned ones, which is
  every Session on a remote Core (issue 243).

## Terminal-input fallback

A harness with no hooks reporting still needs a `running` signal, so the Panel
treats Enter in the terminal as the start of a turn and writes `running` to the
**owning Core**.

The suppression rule follows **reality, not the harness family**: the Core
answers each spawn with `hooksReportTurnStart`, and only a Session that will
actually be told about its own turn starting is exempt. The old rule exempted
any harness whose family supports hooks in principle — which, once hook
installation went away with the Electron main process, meant every hook-capable
Session had neither hooks nor a fallback and never left `ready`.

The narrower question matters: Cursor and Codex both take our hooks file and
report a turn's *end*, so "hooks were installed" would suppress the fallback and
leave their Sessions on `ready` for the whole first turn.

## Title generation

Runs on the Core, for Core-owned rows. Task metadata is Core-owned, the harness
binaries the generator shells out to in print mode exist only on the Core, and
the prompt that triggers it arrives at the Core's own hook receiver — routing it
back to the Panel and the title back again buys nothing.

A generated title is written with `titleManuallySet: false`; an operator's rename
sets the column to `1`, and every check before a generated write re-reads the
row. So a rename that lands while the print-mode CLI is still thinking wins, and
— because the flag is on the row rather than in Panel memory — that protection
survives a Panel reload.

The trigger is normally the `UserPromptSubmit` hook. Cursor never fires one, so
for it the Panel reads the prompt off the terminal and hands it to the owning
Core over the `harnessPrompt` frame — the Panel holds the only copy, and without
that hop a Core-owned Cursor Session could never be named at all.

## Interrupt fallback

Claude does not expose `UserInterrupt` as a settings hook event. The `interrupted`
status is reached by a synthetic `UserInterrupt` payload posted to the same
receiver; `hasClaudeInterruptPrompt` in `pty-manager.ts` is what recognizes the
prompt in the PTY's output.

## Other harnesses

`shell` has no hook surface and relies on explicit status updates.

### OpenCode

OpenCode's extension point is a plugin, not a JSON hooks file, which is why it
went without status reporting through issues 84 and 101 and into
[#230](https://github.com/actana/control/issues/230): a Session showed `ready`
from spawn through a whole turn, every `--wait` timed out "unreported", and the
SDK's wait-for-idle did the same.

`packages/core/src/harness-hooks-opencode.ts` writes that plugin at spawn time
to `<workspace>/.opencode/plugins/actana-control.js`, where opencode
auto-discovers it with no config entry needed. It is a plain ES module using
only `process.env` and `fetch`, so it needs no dependency and no build step, and
it follows the same three rules as the JSON writers: tagged
`@actana-control-managed` so the next spawn replaces exactly what the last one
wrote and never an operator's own plugin, carrying no secret (the URL, token and
task id are read from the PTY's environment), and fail-soft in every direction —
no environment means it does nothing, every POST swallows its own errors, and
nothing it does is awaited by the harness.

What it maps, and where each name came from — all of it read out of opencode
1.18.18 itself, because the shipped binary and the published SDK types disagree:

| OpenCode signal | Posted as | Effect |
| --- | --- | --- |
| `chat.message` hook | `UserPromptSubmit` (+ prompt text) | `running`; captures the session id; names an unnamed Session |
| `session.created` (no `parentID`) | `SessionStart` | captures the session id, no status change |
| `session.status` → `busy` | `UserPromptSubmit` | `running` |
| `session.status` → `idle` | `Stop` | `finished` |
| `session.idle` | `Stop` | `finished` |
| `permission.asked` / `permission.updated` | `PermissionRequest` | `needs-input` |
| `permission.replied` | `PermissionReplied` | back to `running` |

Three details are load-bearing and none of them is guessable from the docs:

- **`permission.asked` is the event the binary emits.** The `@opencode-ai/sdk`
  type union calls it `permission.updated`, and that string does not appear in
  the 1.18.18 binary at all. The plugin listens for both.
- **Posts are queued, not fired in parallel.** A `Stop` that overtook the
  `SessionStart` carrying the session id would be discarded by the Core as
  belonging to a session it has never heard of — #230 again with a new cause.
  Nothing awaits the queue, so a hook still never holds up a turn.
- **A child session is a subagent.** `session.created` carries `parentID`, so
  the plugin knows a child by name rather than guessing from ordering, and a
  subagent's `idle` never settles the Session's card.

`permission.replied` is also why opencode needs no unmatched `PostToolUse`
subscription: Claude Code fires nothing when a permission is *granted* and has
to be healed by "some tool ran", while opencode says so directly.

One side effect to know about: the first time opencode sees a plugin in a
workspace it installs `@opencode-ai/plugin` into `<workspace>/.opencode/
node_modules` and writes a `package.json` beside it. That is opencode's
behaviour, not the Core's, and it happens even though this plugin imports
nothing.

## What about a custom MCP?

We considered exposing a `mc-status` MCP server with a `set_status` tool the
harness could call. It works, but:

- It depends on the model voluntarily calling the tool, which is unreliable for
  *finished* and *needs-input* states (the model isn't running when it's waiting
  on you).
- Hooks already cover all three states deterministically, from outside the model
  loop.

If we ever need harness-driven state (e.g. "I'm running tests, ETA 2 min"),
that's the case where an MCP tool would add value — but that's **additive** to
hooks, not a replacement.
