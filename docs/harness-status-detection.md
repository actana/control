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
| Redraw vs. real output | `packages/core/src/pty-output-activity.ts` |
| Boot sweep | `packages/core/src/core-session-sweep.ts` |
| Relaunch reset | `packages/core/src/core-session-relaunch.ts` |

The Panel keeps a hook endpoint (`POST /api/hooks/<slug>`) for its own remaining
local task rows, running the same shared pipeline. A Core-owned Session never
reaches it.

## Standard mechanism: harness lifecycle hooks

Claude Code, Codex and Cursor CLI emit lifecycle hooks we can subscribe to from
outside the process. The Core installs them per workspace at spawn time, so each
Session reports its own state.

A new Session starts in `ready` (terminal spawned, prompt waiting). The first
hook flips it — and if no hook ever comes, a dead-process fallback does (see
below): `ready` is not a resting place for a Session whose process is gone.

| Hook event                         | Mapped status   | Meaning                                  |
| ---------------------------------- | --------------- | ---------------------------------------- |
| _(spawn)_                          | `ready`         | Terminal up, operator hasn't typed yet   |
| _(agent respawn)_                  | `ready`         | Harness up again for a Session that never worked |
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

A finished task is healed on **two conditions only**: a subagent tracked from
that turn is still in flight, or the finish is younger than
`FINISH_RACE_WINDOW_MS` (one second, inclusive). Everything else is one of
Claude Code's **post-turn internal helpers**, whose subagent events carry the
parent session id: refocusing a finished session, or clicking its just-finished
pin, generates an *away summary* or a title, firing `SubagentStart`/`SubagentStop`
with no `Stop` to follow. Those are ignored for status, and their starts are not
tracked either — a lost helper stop would otherwise hold the next turn's `Stop`
for the whole TTL.

**Of those two, the clock is what decides the raced-POST case.** Every
hook-driven finish leaves the tracked set empty by construction — the `finished`
mapping is downgraded to `running` whenever `hasActiveSubagents` is true, the
drain's `finishQuietTask` runs only after an idle set, `sessionProcessExited`
clears the set first, and the Core's session backstop clears before it stamps
the finish. The active-set condition therefore guards a `finished` written by one
of the *other* status writers (a core-link task mutation through
`CoreTaskWriter`, which clears nothing), not the race. Worth keeping — just not
what protects in-turn work here.

### What the window measures, and what that costs

The window is sized on **emission**: the `Stop` and the turn's own
`SubagentStart` leave the same harness process microseconds apart. It is
evaluated on **arrival** — the finish is stamped when the `Stop` POST was
*handled*, and compared against when the subagent POST is handled. Delivery is
not microseconds: the hook command is
`curl -sS -f -m 3 --retry 2 --retry-delay 1` (`packages/core/src/harness-hooks.ts`),
whose own comment bounds the worst case at *"about eleven seconds"* and names
the trigger as *"a Core busy serving PTY fan-out and SQLite writes"* — exactly
what a fan-out turn creates.

So a **retry-delayed in-turn `SubagentStart` is knowingly traded away**. One that
eats a `-m 3` timeout lands ~4s after a `Stop` that already wrote `finished`,
finds an empty set and a 4s-old finish, and is dropped *and* never tracked; the
card reads `finished` through a live fan-out, and no backstop corrects it (every
backstop below fixes a task stuck on `running`; none fixes one stuck on
`finished`). That residual is filed as **issue 440**.

The window was 30 seconds until issue 385. That covered the retry tail
incidentally, at the price of every post-turn helper resurrecting the card for
half a minute after *every* finish — the operator watched a completed Session
un-complete itself the moment they clicked it. Widening it back to absorb the
~11s retry budget puts a pin click at +5s inside it again and re-opens 385. A
single scalar clock cannot tell a retry-delayed in-turn event from a post-turn
helper, so one of the two has to lose, and the one visible on every finish is the
one that was fixed. Telling them apart needs evidence rather than elapsed time —
a payload discriminator, an emission timestamp, or the W1 status arbiter; issue
440 sketches those.

Backstops, so a `SubagentStop` that never arrives (lost POST, killed process) —
or a healed `running` that no `Stop` will ever follow — cannot hold a task on
`running` forever. The first three are armed **by a hook that arrived**; the
fourth is armed by nothing, which is the point (issue 243):

- Tracked entries expire after 2 hours (kept long on purpose — a short TTL would
  prematurely finish sessions whose subagents legitimately run long).
- A held `Stop` (and a subagent heal) arms a once-a-minute recheck. Once the
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
  gone quiet — or that is still painting a TUI with nothing new on it. Nothing
  arms it, so it covers the case the three above cannot: a turn whose terminal
  `Stop` was the POST that dropped, where nothing was held, nothing was healed
  and no subagent was ever tracked.

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

### Idle redraws are not activity (issue 391)

That rule has a hole in it, and it is the case an operator hits most: the
harness whose hooks are not arriving is usually the harness whose TUI is still
on screen. A Codex whose hooks are held for review (issue 290, fixed), or any
harness whose terminal `Stop` was the POST that dropped, keeps painting a
spinner and a clock for as long as the process lives. Counted as activity,
those bytes mean fifteen minutes of total silence never arrives and the card
claims `running` indefinitely.

So the bytes are read rather than counted. `pty-output-activity.ts` takes each
five-second burst of PTY output and asks three questions in order:

1. **Did the burst erase anything?** A repaint is defined by what it destroys —
   a carriage return, an erase, a cursor jump. A burst that only appends
   scrolled the screen, so it is `output` by construction. This is what keeps
   appended progress (pytest's dots, a log line) from reading as a spinner. The
   exception is a burst with no controls that follows one that repainted: that
   is the tail of a frame, not a new line.
2. **Do the digits belong to a clock?** Every digit is dropped from a line a
   *spinner* is drawing, because the whole line is a frame — clock, token
   count, context percentage. On every other line only the **duration token**
   itself is dropped (`12.3s`, `1m 12s`), never the rest of the line's digits:
   `Compiled 41 files in 3.2s`, `✔ 43 passed in 12.3s` and
   `[1,234 / 5,678] Compiling …; 45s` are what a build actually prints, and
   their counts are their only changing content. Both halves are deliberately
   narrow: the glyph set is the braille, sparkle and circle frames a spinner
   cycles (not ✔ ✗ ❯, which are status marks), and a duration needs its unit
   letter (`\d+:\d{2}` alone is the wall-clock stamp a build prints in front of
   every line).
3. **Is any word new?** What survives — escapes, control bytes and spinner
   glyphs dropped, whitespace collapsed — is the frame's words. The burst is
   `output` when it carries a word the last two bursts (about ten seconds of
   screen) do not already contain, and `redraw` when every word in it was
   already on screen a moment ago. The scan runs from the *end* of the burst,
   where a TUI puts what is new, and as deep as the memory it is compared
   against — deep enough to find a line painted above a static footer, and no
   deeper, since the part that cannot be remembered would otherwise read as
   new. A number is matched whole (`40` is a substring of `(400)`) while a word
   is matched loosely, so a burst boundary inside `Think`/`ing` is not read as
   two new words a second. A burst that erases the display and puts nothing in
   its place empties the memory: the screen is blank, so the next line is new.

The memory is two bursts and not the whole turn on purpose: a harness that
reads the same file twice is working, not repainting. A hook is its own kind of
activity and always counts as progress — nothing a harness bothers to POST is a
repaint.

The backstop therefore has two rules, and a `running` Session settles on
whichever fires first:

| Rule | Fires when | Window |
| --- | --- | --- |
| Quiet | nothing at all — no hook, no byte of any kind | 15 minutes |
| Idle | bytes still arriving (heard within the last 2 minutes), nothing new on screen, no hook, **and** nothing printed since the last hook *within the 15-minute deference bound below* | 8 minutes, confirmed by 2 consecutive sweeps |

The idle rule is the finish-class backstop the quiet rule cannot be: it does not
wait for the redraws to stop, because they never do. Three things narrow it, and
each is there for a failure that was found rather than imagined:

- **It applies only to a Session this Core has heard bytes from.** A row it has
  only ever read from the database is judged by the quiet rule alone, since a
  Core that heard no bytes cannot know whether the ones it missed were redraws.
- **It defers to hooks, for fifteen minutes.** If a Session has printed
  anything real since its last hook, it is mid-turn and the rule stands down: a
  single `Bash` call emits no hook until it completes (Claude Code installs
  `PreToolUse` with an `AskUserQuestion` matcher), so a six-minute build has
  nothing but its TUI to say so. The deference is **bounded**, because
  deferring forever would mean a dropped `Stop` on a harness whose hooks work
  is never settled at all — the other half of #391. Past the bound the screen
  is the only evidence left and the rule reads it, so:

  | harness | settles after its last new output |
  | --- | --- |
  | never sent a hook (a harness whose hooks never ran) | ~9–10 minutes |
  | hooks arrive, `Stop` dropped | ~16–17 minutes |
- **It asks twice.** The condition must hold across two consecutive sweeps, one
  minute apart, before a row moves.

Which rule settled a row is in `session-backstop.settled`'s `rule` field.

### The idle rule takes its own finish back

A `finished` written by the **idle rule** is marked, and the next `output`-class
burst returns the row to `running` inside half an hour
(`session-backstop.reopened`). Three things end that claim, and each of them
ends it for good:

- **Anyone else writing the row.** The settle records the row's `updatedAt` and
  the reopen requires it unchanged. Asking only whether the row still says
  `finished` is not enough: a real `Stop` writes `finished` over a `finished`,
  and the post-turn composer paint that follows would otherwise reopen it.
  This is also the only thing that reads a hook — a hook the pipeline wrote a
  status for moved the row; `SubagentStart`, `SubagentStop` and an unmatched
  `PostToolUse` write nothing, decide nothing, and leave the recovery armed,
  which matters because `PostToolUse` is installed unmatched and fires on every
  ordinary tool call.
- **The PTY exiting**, and the half-hour grace expiring.

No hook of any kind *reopens* a row: only an `output`-class burst does, so a
post-turn helper cannot heal a finished card, which is the bug #385 closed. An
operator's finish and the quiet rule's finish are never marked in the first
place. The marker is spent only once the reopening write has landed, so a
failed write leaves the next burst able to try again.

An idle-rule finish is reopened by **anything new on that screen**, and the
classifier cannot tell the harness's own output from the echo of an operator
typing into the composer — so a correct finish can be taken back by somebody
starting to type and not pressing Enter. Pressing Enter makes it right again (a
`UserPromptSubmit` is a real new turn); the exposed window is "typed but not
submitted", and it is tracked as
[#475](https://github.com/actana/control/issues/475).

This exists because the obvious recovery does not: `harness-hook-events.ts` maps
only `UserPromptSubmit`, `CursorBeforeSubmitPrompt` and `PermissionReplied` to
`running` — `PostToolUse`, `SubagentStart` and `SubagentStop` map to nothing —
and the PTY output path writes no status at all. Without the marker, a row
settled early stays `finished` until the operator's next prompt.

What a wrong idle settle still costs, stated rather than argued away: it emits
`session:finished` (the operator's completion toast, and the signal `actana
session wait` unblocks on) and clears the tracked subagent set. The reopen puts
the status back; it cannot un-send a notification or restore that set, which
expires on its own after two hours.

**A harness parked on a dialog nobody matched is settled too.** Only
`hasClaudeInterruptPrompt` and `hasCodexHookReviewPrompt` turn a screen into
`needs-input`; any other permission or approval box repaints statically, which
is the idle condition exactly, so the Session is settled `finished` at ~9–10
minutes while it waits for a human — and `needs-input` being out of the sweep's
scope does not help, because the row never reached `needs-input`. The reopen
cannot help either until somebody answers. This is the same harness class the
rule targets (the one whose hooks are not arriving is the one whose
`needs-input` hook is also not arriving), and it is tracked as
[#469](https://github.com/actana/control/issues/469) rather than fixed here.

The classifier's own limits, which bound how often that can happen: a turn whose
tool prints nothing at all is indistinguishable from one that ended; a progress
line that is both spinner-prefixed and nothing but numbers has its digits
dropped as a clock; and the rule depends on the spinner phrase being static — a
harness whose spinner rotates its gerund (`✻ Herding… / Simmering… /
Pondering…`) puts a new word on screen every rotation, so the idle rule never
fires for it at all. Before any of this, a lost `Stop` wedged the Session until
a human edited the row by hand — while the Panel said the opposite.

`Notification` is also intentionally narrowed to `permission_prompt`. Claude Code
sends idle input reminders through the same hook event, so treating all
notifications as `needs-input` creates false positives that later flip to
`finished` when the real `Stop` arrives.

These values were tuned against the failure modes above. Do not change them
without a failure that says so.

### The session-id guard, and the one event it does not drop

A hook is addressed by **task id**, read out of the PTY's own environment. The
`session_id` in the payload is a second, weaker fact: the harness's own name for
the conversation. The pipeline stores the first one it sees on a *capture* event
(`UserPromptSubmit`, `SessionStart`, and their Cursor spellings) and, from then
on, drops any non-capture event carrying a different id — a `foreign-session`.
That is what stops a stranger's question, subagent count or permission prompt
from claiming a card it does not own, and a capture event is still free to adopt
a new id, because a new session id means a new harness process.

**A turn end is the exception** (#390). `Stop` — and Cursor's `stop` and
`afterAgentResponse` — claims nothing; it reports that a turn ended, on a PTY
that is this task's whatever the harness calls its session. Two shapes produce
one under an unrecognised id: a **resume**, where the stored id belongs to a
process that is gone and no further capture event is coming, and an **OpenCode
child** whose `session.idle` leaked past the plugin's parent/child filter.
Dropping it was still an *ack* — `{ ok: true, ignored: "foreign-session" }` — so
the harness saw its hook accepted while the card sat on `running` and no
`session:finished` ever fired.

So a foreign turn end settles the task instead, on terms narrower than an owned
one's:

- **The tracked subagents are dropped on entry**, with the recent-finish mark.
  A turn end under an unrecognised id means a new harness process, so the old
  session's subagents died with it — and nothing else can clear them. Their
  `SubagentStop` died with the process, and the new session's own subagent
  events carry the new id, so they are dropped as foreign *before* the
  bookkeeping. The only other route out is the 2-hour `ACTIVE_SUBAGENT_TTL_MS`,
  and waiting on it is how the first cut of this settle reproduced #390 inside
  the fix for it: a fanned-out turn that resumed with a lost `SessionStart` sat
  on `running` for two hours with its `Stop` acked.
- **There is no subagent hold, deliberately.** After the clear the tracked set
  is empty by construction, and it could not have engaged in either shape that
  reaches here anyway: a resumed session's subagent events are dropped as
  foreign before they are ever counted, and opencode — whose child sessions are
  the other shape — posts no subagent lifecycle events at all, so
  `hasActiveSubagents` is structurally false for every opencode Session. **The
  status check below is the only real guard**, and a leaked child *can* finish
  a working parent's `running` card. That is the residual, stated rather than
  papered over; the parent's next `session.status: busy` corrects it.
- **Only `running` is settled** — not `needs-input`. The PTY-exit settle acts on
  both, and it is not a precedent that transfers: there the process is dead, so
  an open question is moot, while here it is alive and may be blocked on exactly
  that question. A leaked child going idle would otherwise write `finished` over
  a parent waiting on a permission prompt, taking the pending-question overlay
  with it. `ready` is out for #387's reason: `CoreTaskWriter` appends
  `session:finished` on that transition, and a Session titled "Waiting for
  initial prompt…" has no turn to end.
- **The session id is not captured.** A `Stop` is not a capture event; adopting
  an OpenCode child's id would hand the rest of that child's lifecycle the
  Session's card.

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
| `codex` | `<cwd>/.codex/hooks.json` (matcher groups; the Core adds `--dangerously-bypass-hook-trust` at spawn, for its own hooks only) |
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
| `codex` | yes | no | fires since #290, but flipping this stands the Panel's fallback down — no ticket yet |
| `cursor-cli` | yes | no | `beforeSubmitPrompt` doesn't fire in cursor-agent |
| `opencode` | yes | yes | plugin; `chat.message` and `session.status` fire |

Only the third column exempts the terminal-input fallback below.

### Codex: a file landing is not a hook running (issue 290)

Codex was the one family where both of those columns lied. Two independent
things were wrong, and each one alone is enough to report nothing.

**The file was the wrong shape.** Codex's hooks file is a table of matcher
*groups*, the same shape Claude Code's is:

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "…" } ] } ] } }
```

We wrote the handler where the group belongs — one level too shallow. Codex
parses such a file, recognises nothing in it, and says nothing about it: the
workspace has a hooks file, the Core believes it installed hooks, and Codex has
zero. It never even reaches the review below.

**A hooks file Codex has not seen before is held for review.** With the right
shape, Codex counts the entries at startup and stops on "Hooks need review — N
hooks are new or changed / Hooks can run outside the sandbox after you trust
them", offering *Review hooks*, *Trust all and continue*, and *Continue without
trusting (hooks won't run)*. Until an operator answers that, neither
`UserPromptSubmit` nor `Stop` reaches the Core, the card sits on whatever it
last said, and the only thing that ends a `--wait` is the caller's timeout.

`--dangerously-bypass-hook-trust` is the vendor's answer, and its own help text
names this caller: *"Intended only for automation that already vets hook
sources."* It is scoped to the invocation — it persists no trust into the
operator's Codex config, and a Codex the operator starts themselves reviews
hooks exactly as before.

#### The Core adds that flag; no launch command carries it

`HARNESS_REGISTRY.codex.startCommand()` is still `codex --enable hooks`, and
the resume builder, the SDK's default command and the Panel's builder are all
unchanged. That is deliberate. A launch command is composed *before* any hooks
file lands, by a client that has not looked at the workspace and — for the
Panel — is not on the same machine. It cannot know whose hooks are about to
run, and a command that carried the bypass unconditionally would be vouching
for hooks nobody vetted.

So the decision is made by the one process that knows: `pty-manager.ts` installs
the hooks, and `reconcileHookTrustFlag` (`pty-spawn-policy.ts`) then adds the
flag to the plan's argv — or takes it back off. `installHarnessHooks` returns
`hookTrustBypassEarned`, which is `true` only when **this Core wrote the file
and nothing it did not write is in it**:

| workspace | earned |
| --- | --- |
| exactly our three groups, and nothing else | **yes** |
| our groups beside a committed `.codex/hooks.json` entry | no |
| any event key we do not write — `SessionStart`, `PreToolUse`, … | no |
| a `.codex/config.toml` in the workspace (may declare hooks; we cannot parse TOML) | no |
| no hook receiver, so the Core wrote nothing at all | no |
| a hooks file that could not be read | no |

The middle rows are the point. `mergeMatchers` preserves an operator's own
entries on purpose — a workspace is theirs, not ours — so a cloned repository's
committed `.codex/hooks.json` survives our write and would run under our bypass.
That is precisely what Codex's review exists to stop, so the bypass is withheld
and the review stands. The foreign entries are **not** deleted; withholding is
the remedy, and editing somebody else's hooks would not be.

**Ownership is decided against what the Core wrote, never against a marker in
the file.** The first version of this audit asked whether each entry carried
`_acManaged`. That key is plain JSON in a file a repository ships, so a
repository can write it. Under the three events in `CODEX_HOOK_EVENTS` the
forgery is harmless — `mergeMatchers` deletes managed entries and replaces them
with ours — but Codex supports `SessionStart`, `PreToolUse`, `PostToolUse`,
`PreCompact`, `PostCompact`, `SubagentStart` and `SubagentStop` too, and this
installer writes none of them. A forged `_acManaged` under `SessionStart` — the
event that fires earliest — survived our write untouched, counted as ours, and
earned the bypass.

So `codexOwnsEveryHook` rebuilds what the writer produced, from
`CODEX_HOOK_EVENTS` and `codexGroup(slug, event)` — deterministic, in this
module, unreachable from a workspace — and requires the file to match it: the
event keys are exactly ours, each holds exactly one group, and each group is
identical to the one we wrote (compared key-order-insensitively, so a formatter
is not mistaken for an edit). An event we do not write is an event we cannot
speak for, so ownership is never inherited by default. A marker inside untrusted
content is not proof that the content is trusted.

The stripping direction matters as much as the adding one: a command that
arrives carrying the flag from anywhere — an operator typing it, a client of
another version, a saved command replayed against a different workspace — has it
removed unless *this* spawn earned it.

What this cannot see is a Codex plugin supplying hooks from outside the
workspace. That is a real edge, stated rather than hidden: the audit narrows the
bypass to the common case and does not claim to enumerate every hook source
Codex has.

#### Version floor

`minimumVersion` for codex is **0.135.0**, raised from 0.132.0 by this work.
`--dangerously-bypass-hook-trust` has parsed since 0.131.0, but
openai/codex#24093 records it being accepted and then *ignored in TUI mode* —
the "Hooks need review" prompt still blocked startup — until openai/codex#24317
(`5fb5e47`). That commit is unreachable from `rust-v0.133.0` and
`rust-v0.134.0` and reachable from `rust-v0.135.0`. This Core launches Codex as
an interactive TUI in a PTY, so on 0.132–0.134 the flag is a silent no-op. A
floor that admitted them would have shipped a `--dangerously-*` flag that does
nothing.

#### What still needs a human on a first-ever workspace

**A workspace Codex has never opened still does not report its first turn, and
this section is the honest statement of that.** The hook-trust review is only
the second of two gates. The first is *project-layer trust*: Codex asks

> You are in `<path>` — Do you trust the contents of this directory? Working
> with untrusted contents comes with higher risk of prompt injection. Trusting
> the directory allows project-local config, **hooks**, and exec policies to
> load.

Until that is answered, `<cwd>/.codex/hooks.json` is not loaded at all, so there
is nothing for the hook-trust bypass to lift. `--dangerously-bypass-hook-trust`
lifts hook trust only; it does not answer this prompt, and the Core does not
answer it either — `BLOCKING_DIALOGS` in `harness-prompt-delivery.ts` scopes
`folder-trust` to `claude-code` and `cursor-cli` (ADR 0026 D7), and codex is not
in that list.

So on a first-ever workspace a Codex Session stops on the trust prompt and stays
there until a human picks "Yes, continue" — with or without this fix, and
whether or not it has hooks. What this work changes is everything *after* that
answer: from the operator's first "Yes, continue" onward, including that very
first turn, `UserPromptSubmit` and `Stop` reach the Core with no `/hooks` review
in the way. On every subsequent Session in that workspace — the overwhelmingly
common case, since project-layer trust persists per directory in
`~/.codex/config.toml` — nothing is in the way at all.

Answering the trust prompt for codex is a separate change in a file this work
does not own; it is not fixed here and is not claimed to be.

#### Verified

Against codex-cli 0.153.0, driven through a PTY with a `CODEX_HOME` created for
the run and a workspace Codex had never reviewed, using the file
`installHarnessHooks("codex", cwd)` writes and a loopback receiver standing in
for the Core:

| hooks file | bypass flag | project layer trusted | `Stop` reaches the Core |
| --- | --- | --- | --- |
| flat (the old writer) | either | yes | no — Codex sees no hooks at all |
| matcher groups | no | yes | no — held at "Hooks need review" |
| matcher groups | yes | no | no — the hooks file is never loaded |
| matcher groups | yes | yes | **yes, on the first turn** |

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

  **`ready` settles here too** (issue 387), and it is the one status in scope
  that describes no work. A *bare* Session — spawned with no prompt, sitting on
  "Waiting for initial prompt…" — never leaves `ready` until its first
  `UserPromptSubmit`, so not one hook ever fires for it and there is no `Stop`
  to wait for. Left out, its row went on claiming to be waiting for a prompt
  for as long as the database existed; one was found alive on a Core hours
  after its PTY died, and still there after the container was recreated.

  It settles on a scale of its own: **`disconnected`, whatever the exit code**.
  `terminated` would say a turn was killed, and `finished` would say work
  completed — `CoreTaskWriter` appends `session:finished` on exactly that
  transition, so a bare Session the operator closes with `/exit` would ring a
  completion ding for a turn that never ran. `disconnected` claims only that
  the process went away, which is the whole of what is known.
- **Boot sweep** — `core-session-sweep.ts` runs once per Core boot, before the
  PTY core, the hook receiver or the core-link server can produce a Session of
  this run. At that moment no PTY of this process exists, so every row still
  claiming `running` / `needs-input` is an orphan of the previous one: a Core's
  PTYs die with it, silently, with no exit callback and no `pty:exit`. Each is
  written to `disconnected` through `CoreTaskWriter`, so the settle appends the
  `task:updated` event a connected Panel re-renders from — a sweep nobody is
  told about leaves the operator looking at the same wrong card.

  **Spawned `ready` rows are orphans too** (issue 387), for the same reason the
  PTY-exit settle covers them: a bare Session's PTY dies with the Core and no
  hook was ever going to report it. They cannot be swept on the status alone,
  because `ready` is also the status of a Session the operator created and has
  not started — flipping a queue of unstarted work to `disconnected` on every
  restart would trade one wrong card for many. The discriminator is whether
  this Core ever spawned a *harness* for the row, read from the `pty:spawn` in
  the event log (`queryStrandedReadyTasks`). The row cannot answer it: there is
  no "was started" column, and the harness session id is no help either, since
  Claude Code's `SessionStart` captures one before any turn. A `ready` row with
  no agent spawn behind it is left alone. The evidence is permanent — nothing
  prunes `event_log` — so the first boot after this shipped settled every
  historical spawned `ready` row in one batch, and every boot since sees only
  what the run before it stranded. That batch also reorders the operator's
  lists: a status patch stamps `updated_at`, which Fleet and Archived both
  order by, so every row it settles floats to the top at the boot time, above
  recent work, and there is no undoing it.

  The quiet-Session backstop deliberately does **not** see these rows: it reads
  the narrow `listActiveTasks`, and a bare Session waiting on its first prompt
  is allowed to sit silent for as long as the operator likes.

  `disconnected` rather than `finished` or `terminated`: it is the status the
  Panel already uses for a process that went away without reporting, and it
  claims nothing about how the work ended. The Panel has had this sweep for its
  own rows all along; what it never had was scope over Core-owned ones, which is
  every Session on a remote Core (issue 243).
- **Relaunch reset** — the mirror of the two above (`core-session-relaunch.ts`).
  Once `ready` is a status a Session can leave, something has to write it back:
  the operator reopens a settled bare Session, the Core spawns a healthy
  harness, it waits at its prompt, and no hook fires until the first prompt —
  so the card would read `disconnected` over a live harness, on every harness
  family. On an **agent** spawn (never a `shell` or `shellSession` one), a row
  sitting on **`disconnected`** that is **proven never to have worked** goes
  back to `ready`.

  Both halves of that are narrower than they look, and deliberately so, because
  this write destroys information when it is wrong.

  `disconnected` rather than "any settled status": before `ready` became a
  status a Session can leave it was one-way, so a Session that never worked
  could only ever *be* `ready`, and the only status the two fallbacks above
  write for one is `disconnected`. `finished`, `terminated` and `interrupted`
  are therefore unreachable for such a Session — every row wearing one worked
  for it — and excluding them here means a real card cannot be overwritten
  even if the history read below is wrong.

  "Never worked" is read from the event log, not the row: every status change
  on a Core-owned row appends a `task:updated` carrying the status that was
  *patched* (`queryTaskProvenNeverWorked`), and any status other than `ready` /
  `disconnected` says a turn happened — including on a harness that goes
  straight from `ready` to `finished` without ever reporting `running`. A
  `finished` Session being reopened is being resumed, and keeps its card.

  That read sees **only status-bearing `task:updated` events, and those start
  at v0.4.0** (`2dd34a8`): before it the payload was `{taskId, projectId}` and
  nothing else. Since `event_log` is never pruned, a Core upgraded from 0.3.x
  still holds status-less rows for Sessions that ran for hours, and their
  silence is indistinguishable from a Session that never ran a turn. So the
  read demands *positive* evidence — a row the fallbacks above settled always
  carries a `"status":"disconnected"` update, so a row with no status-bearing
  update at all is a legacy log, and the answer is "cannot tell, do not reset"
  rather than "never worked".

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
leave their Sessions on `ready` for the whole first turn. Codex's turn *start*
does arrive since #290, but the column is still `no` there — see
[Codex: a file landing is not a hook running](#codex-a-file-landing-is-not-a-hook-running-issue-290).

Note that neither of those failures parks a Session on `ready` forever any more
(issue 387). A Session sitting on `ready` whose PTY then dies is settled by the
PTY-exit path, and one whose Core dies under it is settled by the boot sweep;
what a missing `running` signal costs is a card that under-reports a live turn,
not a row that outlives its process.

### The CLI has no equivalent, and says so

`hooksReportTurnStart` reaches every client, not just the Panel: the SDK carries
it off the `spawned` frame onto `CoreSession.reportsTurnStart`, and the `actana`
CLI reports it on `session start` / `session resume` as both a stderr note and a
`--json` field.

It is a statement rather than a fallback, and that is deliberate. The Panel can
watch the keystrokes going into its pane because it owns the pane; `actana
session start` hands the prompt to the Core and hangs up (#129 D6), so there are
no keystrokes here to watch, and a client that wrote `running` on its own would
be reporting a status the Core never decided. What it can do is stop a quiet
`session ls` from reading as a dead harness:

```
$ actana session start web "refactor the picker" --harness cursor-cli
Started cursor-cli in web — session task_x, pty pty_x.
Note: cursor-cli does not report the start of a turn, so this session will not
show as running until it stops. `--wait` and `session logs` are unaffected.
```

Both named affordances do still work, because turn *end* is reported: `--wait`
is `CoreSession.waitForIdle`, and `session logs` reads the Core's replay ring.

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
- **Posts are queued, not fired in parallel.** Order is meaning here. A
  `chat.message` that overtook the `SessionStart` before it would name the
  Session from a prompt the Core cannot yet attribute, and a `permission.replied`
  that overtook its `permission.asked` would leave the card on `needs-input`
  for a question already answered — #230 again with a new cause. (A `Stop` that
  overtakes the capture event is no longer among the casualties: since #390 it
  settles rather than being discarded. That is a narrowed blast radius, not a
  reason to stop queueing.) Nothing awaits the queue, so a hook still never
  holds up a turn.
- **A child session is a subagent.** `session.created` carries `parentID`, so
  the plugin knows a child by name rather than guessing from ordering, and a
  subagent's `idle` never settles the Session's card. Filtering it at the
  source is the whole guard — one that leaks through, a child created before
  the plugin loaded, reaches the Core as a `Stop` under an unrecognised session
  id and now settles rather than being dropped (see the session-id guard
  above). Nothing downstream can catch it: opencode posts no subagent lifecycle
  events, so the pipeline has no way to see the parent still working. All that
  narrows it is the `running`-only status check, and the parent's next
  `session.status: busy` puts the card back.

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
