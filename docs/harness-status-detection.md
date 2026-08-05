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
`running` forever:

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

An operator's own hooks are preserved; ours are tagged `_mcManaged: true` so the
next spawn replaces exactly what a previous spawn wrote. The registry is open —
adding a harness family is adding a row, and every per-harness difference stays
inside the Core process, never in the Panel.

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
- **Boot sweep** — the Core's DB bootstrap stamps `disconnected` on rows left
  `running` / `needs-input`, since no PTY of the previous run survived it.

## Terminal-input fallback

A harness with no hooks reporting still needs a `running` signal, so the Panel
treats Enter in the terminal as the start of a turn and writes `running` to the
**owning Core**.

The suppression rule follows **reality, not the harness family**: the Core
answers each spawn with `hooksInstalled`, and only a Session whose hooks actually
went in is exempt. The old rule exempted any harness whose family supports hooks
in principle — which, once hook installation went away with the Electron main
process, meant every hook-capable Session had neither hooks nor a fallback and
never left `ready`.

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

## Interrupt fallback

Claude does not expose `UserInterrupt` as a settings hook event. The `interrupted`
status is reached by a synthetic `UserInterrupt` payload posted to the same
receiver; `hasClaudeInterruptPrompt` in `pty-manager.ts` is what recognizes the
prompt in the PTY's output.

## Other harnesses

`shell` has no hook surface and relies on explicit status updates. OpenCode has
no hook writer in the registry today: its Sessions reach `running` through the
terminal-input fallback (which stays armed for them, because the Core answers
`hooksInstalled: false`) and settle on PTY exit.

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
