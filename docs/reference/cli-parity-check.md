# The prototype CLI, checked against `packages/cli`

This is the parity check [#164][164] asks for, and it is the reason the frozen
tree under `docs/reference/experiment-cli/` may be deleted. **The check is the
ticket; the deletion is its consequence** — it is committed before the deletion
commit in this PR so that the reference still existed when it was read.

What is being compared: the prototype `core-client`, frozen by [#207][207] from
[#158][158], against the shipped `actana` command in `packages/cli` on
`feat/cli-and-publishing`.

## Method, and what "parity" is taken to mean

Every row below was read off the prototype's **implementation**, not its help
text — `src/commands/help.ts` is 257 lines of prose that had already drifted
from `src/args.ts` in two places (it documents `--enter` and `--now`, which
`VALUE_FLAGS` never listed because they are booleans, and it omits `--name`,
which `VALUE_FLAGS` does carry). The verb tables come from the `switch`
statements in `core-client.ts` and `src/commands/*.ts`; the flag table comes
from `VALUE_FLAGS` in `src/args.ts` plus every `ctx.has(…)` and `ctx.flag(…)`
call site.

**Parity is not "the same flags".** The prototype was one process that dialled a
Core and did everything itself, and some of what it did was right for reasons it
did not know about — it discovered, empirically and by breaking, that a TUI has
to be read as a screen and that a carriage return in the same write as a paste
is swallowed. Those behaviours are now the Core's and the SDK's. They are
recorded below as **moved to X**, with the module named, because "the `actana`
CLI does not do this" and "this no longer happens" are different claims and only
the first is true.

Three destinations, and the difference between them is the whole point:

| Destination | What it means |
|---|---|
| **`packages/cli`** | the shipped `actana` command does it |
| **moved to Core** | the Core does it now, for every client — Panel, CLI and SDK alike |
| **moved to SDK** | `@actana/sdk` does it, and `packages/cli` calls it rather than owning it |
| **not carried** | deliberately absent, with the argument in this document |

## 1. Commands

The prototype had 6 resources and 20 verbs. `help` is the seventh resource and
is counted with the flags.

### `core`

| Prototype | Now | Where |
|---|---|---|
| `core ls` | `actana core ls` | `packages/cli/src/core-command.ts` (`coreLs`) |

The prototype had exactly one `core` verb because a Core was a file somebody had
copied into `blobs/` by hand. `actana core` has five — `add`, `ls`, `use`, `rm`,
`status` — and four of them exist because registering a Core is now a thing the
CLI does rather than a thing the operator does with `docker exec` and a
redirect. That is growth, not drift, and it is [#129][129] D9.

### `project`

| Prototype | Now | Where |
|---|---|---|
| `project ls` | `actana project ls` | `packages/cli/src/project-command.ts` (`projectLs`) |
| `project create <path> [name]` | `actana project add <name> <path>` | `packages/cli/src/project-command.ts` (`projectAdd`) |
| `project browse [path]` | `actana project browse [path]` | `packages/cli/src/project-command.ts` (`projectBrowse`) |
| `project inspect <project>` | `actana project ls --json` | `packages/cli/src/project-command.ts` (`projectLs`) |
| `project rm <project> --yes` | **not carried** | see below |

**`create` → `add`, and the arguments swapped.** The prototype took
`create <path> [name]` and derived the name from the path's last segment when
none was given; `actana project add <name> <path>` takes both, name first, and
derives nothing. Both orders are defensible and the shipped one is better for
the reason `project-command.ts`'s header gives: the path is a path *on the
Core*, and putting the name first stops the eye reading the first argument as
something local. The prototype's `--name` flag went with the change — see §2.

**`inspect` folded into `--json`.** The prototype had `project inspect` and
`session inspect` printing `JSON.stringify(…, null, 2)` of one row, because its
list output was a hand-padded table with no machine-readable form at all. The
shipped CLI put `--json` on every list verb ([#205][205]), which answers the same
question for one row and for all of them with one flag instead of a second verb.
`actana project ls --json` is `project inspect` with the filter left to `jq`.

**`project rm` is not carried, deliberately.** It is the one prototype verb whose
absence is a real gap rather than a re-spelling, and the argument for leaving it
out is not that it is unimportant:

- The Core's removal operation is `projectsMutate {op: "archive"}` and it
  **cascades** — every Task recorded under the Project goes with it. The
  prototype guarded that with `--yes` and a sentence. That is the right shape for
  a throwaway tool driven by the person who wrote it, and the wrong one for a
  published command: a destructive cascade behind a flag whose whole safety story
  is "the operator read the error the first time" is exactly the shape that gets
  scripted with `--yes` already in the line.
- `actana project`'s three verbs are the ones [#129][129] D10 scoped, and the
  noun's header states the other constraint plainly: no frame carries a path
  after creation ([ADR 0022][adr0022]), so this noun is deliberately small and
  the verbs it refuses are refused in writing rather than by omission.
- The capability is not lost: the Panel archives Projects over the same frame,
  and the frame is in `@actana/sdk`, so an SDK caller has it today.

**This is the one thing in the prototype that `actana` cannot do**, and it is
recorded here as an argued omission so that whoever wants it has this paragraph
to argue against rather than an empty space. It wants its own ticket, a
confirmation flow that is not a boolean, and a decision about what "archive"
should be called at the CLI — none of which is #164's work.

### `session`

| Prototype | Now | Where |
|---|---|---|
| `session ls [--all]` | `actana session ls [project]` | `packages/cli/src/session-command.ts` (`sessionLs`) |
| `session start <project> [prompt]` | `actana session start <project> [prompt]` | `packages/cli/src/session-command.ts` (`sessionStart`) |
| `session logs <session>` | `actana session logs <session>` | `packages/cli/src/session-command.ts` (`sessionLogs`) |
| `session attach <session>` | `actana session attach <session>` | `packages/cli/src/session-attach.ts` (`runSessionAttach`) |
| `session send <session> <text>` | `actana session send <session> <text>` | `packages/cli/src/session-command.ts` (`sessionSend`) |
| `session enter <session>` | `actana session send <session> --enter` | `packages/cli/src/session-command.ts` (`sessionSend`) |
| `session interrupt <session>` | `actana session attach`, or `send` with the byte | see below |
| `session resume <task>` | `actana session resume <session> [prompt]` | `packages/cli/src/session-command.ts` (`sessionResume`) |
| `session kill` / `session rm` | `actana session kill <session>` | `packages/cli/src/session-command.ts` (`sessionKill`) |
| `session inspect <task>` | `actana session ls --json` | `packages/cli/src/session-command.ts` (`sessionLs`) |

**`enter` folded into `send --enter`.** The prototype needed a separate verb
because its `send` always appended a carriage return unless told not to
(`--no-enter`), so "just the Enter" had nowhere to live. The shipped `send`
inverts the default — it writes exactly the bytes it was given and appends
nothing unless `--enter` says so — and `actana session send <s> --enter` with no
text is a bare carriage return, checked explicitly at
`session-command.ts:463-479`. One verb fewer, and the default is now the safe
one.

**`interrupt` is not carried as a verb, and this is the row most worth reading
carefully.** The prototype's `interrupt` wrote a single byte, `\x1b`, to the PTY.
That is not a protocol operation and never was — it is a keystroke, and the
prototype had a verb for it only because it had no way for an operator to send
one otherwise. `actana` has two:

- `actana session attach` gives the operator the real terminal, where Escape is
  Escape and `Ctrl-C` goes to the harness ([#163][163], `session-attach.ts:41-83`).
  That is the shipped answer.
- `actana session send <s> "$(printf '\033')"` writes the same byte, because
  `send` is verbatim.

A dedicated `interrupt` verb would have to justify why *this* keystroke gets a
name and `Ctrl-C`, `Ctrl-D` and the arrow keys do not. The prototype never had to
answer that; a published noun does. Note also that `interrupted` is a **status**
in the shipped system (`packages/sdk/src/core-session.ts:112`,
`SETTLED_SESSION_STATUSES`), which is the useful half of the concept and is
carried.

**`session rm` was an undocumented alias for `kill`** (`session.ts:624-625`,
`case "kill": case "rm":`) and appears in no help text. Not carried: two
spellings of a destructive verb is a defect, not a feature, and `kill` is the one
the prototype's own documentation used.

**`--all` is not carried because the default changed.** The prototype's
`session ls` showed only Sessions with a live PTY and needed `--all` to include
finished ones. `actana session ls` lists every Session the Core has and puts a
`LIVE` column in the table (`session-command.ts:370-388`) — so the information
`--all` toggled is now a column rather than a mode, and `--json` carries it as a
field. Filtering belongs to the caller.

### `harness`

| Prototype | Now | Where |
|---|---|---|
| `harness ls` | `actana harness ls` | `packages/cli/src/harness-command.ts` (`harnessLs`) |
| `harness install <id>` | `actana harness install <id>` | `packages/cli/src/harness-command.ts` (`harnessInstall`) |

Same two verbs, and one behaviour deliberately reversed. The prototype's
`install` was fire-and-forget and said so — it printed "check with `harness ls`"
because the `harnessInstall` frame is answered by an ack and never by an
outcome. `actana harness install` subscribes to the event log first, asks second,
and waits up to 15 minutes for `agents:availabilityChanged` or
`harness:installFailed` (`harness-command.ts:16-30, 50-58`). The frame shape did
not change; the client stopped treating an ack as a result.

### `status`

| Prototype | Now | Where |
|---|---|---|
| `status` | `actana core status` | `packages/cli/src/core-command.ts` (`coreStatus`) |

The prototype's `status` printed six things in one screen: endpoint, label,
protocol version, project count, session count, and per-harness availability. The
shipped CLI splits them along the noun grammar — `actana core status` for
endpoint, Core id, protocol version, compatibility, multi-connection support and
bearer expiry; `actana project ls`, `actana session ls` and `actana harness ls`
for the three counts. **Nothing is dropped, and two things are added** (bearer
expiry and the compatibility verdict, neither of which the prototype could
compute because its protocol version was a hand-copied constant — see §5).

The counts are the one place the prototype was terser. That is the cost of the
noun grammar and it is accepted knowingly: a status verb that reaches into three
other nouns to build a dashboard is the shape that later has to be kept in step
with all three.

### `events`

| Prototype | Now | Where |
|---|---|---|
| `events [--since N] [--kind prefix]` | `actana events tail` | `packages/cli/src/events-command.ts` (`eventsTail`) |

The verb gained a name (`tail`) and the semantics changed in the operator's
favour. The prototype replayed **from the beginning of the log by default**
(`events.ts:8`, `lastEventId 0`) — the replay storm — and `--since` was the only
way out. `actana events tail` starts at the end of the log like `tail -f`, keeps
a per-Core cursor under the config directory so a second run resumes, and treats
`--since` as a one-off rewind that does not move the stored cursor
(`events-command.ts:5-44`, `packages/cli/src/event-cursor-file.ts`).

### `help`

| Prototype | Now | Where |
|---|---|---|
| `help`, `help <resource>`, `<resource> --help`, `-h` | `actana --help`, `actana <noun> --help`, `-h`, `actana help` | `actana-cli.ts` (`ROOT_HELP`), and a `*_HELP` constant per noun |

Carried, minus the standalone `help <topic>` form's topic argument: `actana help`
prints the root help and each noun carries its own text
(`SESSION_HELP`, `PROJECT_HELP`, `CORE_HELP`, `HARNESS_HELP`, `EVENTS_HELP`).

## 2. Flags

| Prototype flag | Applied to | Now | Where |
|---|---|---|---|
| `--core <name>` | global | `--core <name>`, global | `packages/cli/src/cli-args.ts`, `core-resolution.ts` |
| `--help`, `-h` | global | `--help`, `-h` | `packages/cli/src/cli-args.ts` |
| `--all` | `session ls` | **not carried** — a `LIVE` column | `session-command.ts:370-388` (§1) |
| `--follow` | `session start`, `session logs` | `actana session attach` | `packages/cli/src/session-attach.ts` |
| `--lines N` | `session logs` | **not carried** | see below |
| `--raw` | `session logs` | `--raw` | `session-command.ts` (`sessionLogs`) |
| `--cols N`, `--rows N` | `session logs` | **not carried** — moved to SDK | `packages/sdk/src/terminal-screen.ts` (`DEFAULT_COLS`/`DEFAULT_ROWS`) |
| `--harness <id>` | `session start` | `--harness <name>` | `cli-args.ts`, `session-gateway.ts` (`KNOWN_HARNESSES`) |
| `--model <id>` | `session start`, `session resume` | **not carried** | see below |
| `--title <text>` | `session start` | `--title <text>` | `cli-args.ts`, `session-command.ts` |
| `--ask-permissions` | `session start`, `session resume` | inverted: `--dangerously-skip-permissions` | `cli-args.ts`, `session-gateway.ts` |
| `--enter` | `session send` | `--enter` (default inverted) | `session-command.ts` (`sessionSend`) |
| `--no-enter` | `session send` | **not carried** — it is now the default | `session-command.ts:438-447` |
| `--now` | `session send` | **not carried** — moved to Core | `packages/core/src/harness-prompt-delivery.ts` |
| `--yes` | `project rm` | **not carried** — the verb is not carried | §1 |
| `--name <text>` | `project create` | **not carried** — a positional | `project-command.ts` (`projectAdd`) |
| `--since <n>` | `events` | `--since <id>`, plus `--since start` | `events-command.ts` (`parseSince`) |
| `--kind <prefix>` | `events` | `--kind <kind>`, repeatable | `cli-args.ts:136-139` |

Flags the shipped CLI adds and the prototype had no equivalent of: `--json`,
`--verbose`, `-V`/`--version`, `--wait`, `--wait-timeout`, `--cwd`, `--limit`,
`--read-only`, and `--` as an end-of-flags marker.

**`--lines N` is not carried.** The prototype rendered the replay buffer, dropped
blank rows and printed the last N lines, defaulting to 40 — a pager built into
the verb because a hand-padded terminal dump with no `--json` had no other way to
be manageable. `actana session logs` prints the rendered screen and leaves
truncation to `head`, `tail` and `less`, which every caller already has and which
compose. `--json` carries the whole screen as one field for anything that wants
to slice it programmatically.

**`--cols N` / `--rows N` moved to the SDK rather than being dropped.** The
prototype needed them exposed because its geometry was two module constants
(`session.ts:13-14`, `COLS = 120`, `ROWS = 32`) that had to match the spawn or the
wrapping landed in the wrong columns — the flags existed to repair a mismatch the
tool itself could create. The geometry now lives in one place,
`packages/sdk/src/terminal-screen.ts:94-96` (`DEFAULT_COLS`, `DEFAULT_ROWS`), and
`session-gateway.ts` builds the screen at the same size it spawned the PTY at, so
there is no mismatch for a flag to repair. `CoreSessionOptions.cols`/`.rows`
expose it to an SDK caller that needs a different size.

**`--model <id>` is not carried, and this is the second real gap.** The prototype
put `--model` into the launch command directly (`buildClaudeCommand`,
`session.ts:300-314`) and the Core's allow-list happened to permit it for
`claude`. The shipped path builds launch commands from
`HARNESS_LAUNCH_COMMANDS` in `packages/sdk/src/core-session.ts:76-81`, and the
SDK's `CoreSessionOptions.command` is the seam for overriding one — so the
capability exists one layer down, unexposed at the CLI. Not carried here
because the prototype's spelling only worked for one of four harnesses and a
`--model` that silently does nothing on three of them is worse than no flag;
the honest version needs a per-harness table beside `HARNESS_LAUNCH_COMMANDS`
and the Core's spawn policy extended in step. That is a ticket, not a line.

**`--ask-permissions` inverted to `--dangerously-skip-permissions`, and the
default flipped with it.** The prototype ran every Session with
`--dangerously-skip-permissions` **by default** and `--ask-permissions` opted
out (`session.ts:392`, `!ctx.has("ask-permissions")`). The shipped CLI defaults
to permission prompts on and requires the long, ugly, deliberately unpleasant
flag to disable them. This is the single largest behavioural difference between
the two tools and it is a correction: a throwaway tool driven by its author may
default to unattended, and a published command that a script will run against
somebody else's machine may not.

## 3. Aliases

The prototype carried 17 flat aliases (`core-client.ts:39-60`) — `projects`,
`add-project`, `ls`, `sessions`, `start`, `logs`, `tail`, `attach`, `send`,
`enter`, `stop`, `interrupt`, `resume`, `kill`, `harnesses`, `install`, `cores`
— each expanding to a `<resource> <verb>` pair. **None is carried, and that is
one decision rather than seventeen.**

They existed for compatibility with scripts written against the CLI *before* it
grew resources, and the comment on `stop` says so outright: it is kept meaning
Escape "because anything else silently changes what an old command does". There
are no such scripts for `actana` — it has not shipped yet, which is exactly the
moment at which the alias table costs nothing to not create. The specific harms
avoided: `ls` meaning `project browse` while `session ls` and `project ls` mean
listing is a genuine trap, `install` and `start` are words a shell user has other
meanings for, and `stop` is a deprecated alias for a verb that is itself not
carried. [#129][129] D8's one-binary-split-by-noun grammar is the whole point,
and a flat alias for every leaf undoes it.

## 4. Behaviours the prototype got right, and where they went

This is the section the ticket's second trap is about. Each of these is a
behaviour the prototype discovered by breaking, none of them is a flag, and
every one of them is **still happening** — somewhere else.

| Prototype behaviour | Where in the prototype | Now |
|---|---|---|
| Split the paste and the carriage return into two writes, with a length-scaled pause | `src/commands/session.ts:70-80` (`typeInto`) | **moved to Core** — `packages/core/src/harness-prompt-delivery.ts`, step 3 |
| Wait for the *rendered screen* to stop changing, not for silence | `src/commands/session.ts:188-227` (`RESTLESS`, `normalizeScreen`, `waitForSettled`) | **moved to Core** — `packages/core/src/harness-prompt-delivery.ts`, step 1 (`redrawSignature`) |
| Answer the harness's blocking startup dialogs before delivering anything | `src/commands/session.ts:165-176, 235-264` (`STARTUP_DIALOGS`, `clearStartupDialogs`) | **moved to Core** — `packages/core/src/harness-prompt-delivery.ts`, step 2 (`readDialogOptions`, `chooseDialogOption`, `matchBlockingDialog`, `dialogsForHarness`) |
| Do not use the Core's `initialInput` — it fires 450 ms after spawn and loses the prompt | `src/commands/session.ts:339-341` | **fixed in Core** — `harness-prompt-delivery.ts` header, "What replaced what: a flat 450 ms timer" |
| Replay PTY output through a terminal emulator to read it as text | `src/terminal.ts` (`renderTerminal`, 236 lines) | **moved to SDK** — `packages/sdk/src/terminal-screen.ts` (`TerminalScreen`, 848 lines) |
| Keep scrolled-off lines: the transcript is the scrollback | `src/terminal.ts:36-39, 235` | **moved to SDK** — `terminal-screen.ts:279` (`TerminalScreen.scrollbackLines`) |
| Demultiplex `data`/`exit` frames per PTY, holding early frames until the id arrives | `src/commands/session.ts:114-148` (`PtyStream`, `adopt`) | **moved to SDK** — `packages/sdk/src/core-session.ts:350-370` |
| Correlate requests to differently-named result frames | `src/protocol.ts:73-90` (`RESULT_OF`) | **moved to SDK** — `packages/sdk/src/core-link-transport.ts` |
| Per-harness canonical binary, because the Core matches `argv[0]` exactly | `src/commands/session.ts:24-29` (`HARNESS_COMMAND`, marked "LOCAL STOPGAP for #177") | **moved to SDK** — `packages/sdk/src/core-session.ts:76-81` (`HARNESS_LAUNCH_COMMANDS`) |
| Per-harness auto-mode flag, because the spawn option alone does not disable prompts | `src/commands/session.ts:39-43` (`HARNESS_AUTO_FLAG`, same stopgap note) | **moved to SDK** — `packages/sdk/src/core-session.ts:92-97` (`HARNESS_SKIP_PERMISSION_FLAGS`) |
| Resume by spelling the harness's own session id into the launch command | `src/commands/session.ts:300-314` (`buildClaudeCommand`) | **carried, generalised** — `packages/cli/src/harness-resume.ts` (four harnesses, not one) |
| Warn when the Core's protocol version disagrees | `src/client.ts:142-151` | **carried** — `actana core status` reports `compatible` and exits non-zero |

Four of these deserve a sentence more than a table cell.

**The paste-vs-Enter handling did not merely move — it was correctly
re-attributed.** The prototype had to do it in the client because the client was
the only thing that knew a prompt had been typed. But *which* dialog a harness
opens, *what* it paints while booting and *how* it treats a burst of input are
facts about the harness, and the harness runs on the Core. So the Core does it,
for every client at once ([ADR 0026][adr0026]), and `packages/cli` is explicitly
forbidden from re-adding it: `packages/cli/src/__tests__/no-prompt-timing.test.ts`
fails the build if any timer appears in the package. The prototype's instinct was
right and its address was wrong.

**The dialog handling was made safer in the move.** The prototype pressed the
option's digit and then a carriage return unconditionally
(`session.ts:253-255`). The Core reads the menu off the screen, finds the option
whose label means "go ahead", presses that option's own number, and sends the
confirming Enter **only once the harness has moved its highlight onto it** — and
if it cannot read the menu it presses nothing at all
(`harness-prompt-delivery.ts:22-33`). The prototype's own comment explains why
this matters: the bypass-permissions dialog's highlighted default is "No, exit",
so a mistimed Enter quits the harness.

**The terminal emulator grew by a factor of three and gained the alternate
screen.** `renderTerminal` was a function over a `string[][]` grid handling CSI
movement, erase, insert/delete and scroll. `TerminalScreen` is a class handling
all of that plus two buffers, a scroll region, and a documented rule about what
an erase does *not* put in the scrollback. The prototype's hard-won lesson is
cited in the shipped file's header — `terminal-screen.ts:24` names
`experiment/action.md` §4 as where it was learned.

**`RESULT_OF` was the correlation half of the mirror.** It is not carried as a
table because the shipped transport does not need one: the frame union in
`core-link-frames.ts` types every result, so correlation is a matter of matching
`reqId` and letting the type system say what came back. See §5.

## 5. The protocol mirror

`docs/reference/experiment-cli/src/protocol.ts` is **exactly 90 lines** — the
mirror [#164][164] names and [ADR 0025][adr0025] D3 uses as its worked example of
what a hand-copied schema costs. Its drift was visible and deliberate:

- `PROTOCOL_VERSION = "0.15.0"` as a hand-typed constant (line 7).
- A comment at line 3 naming the pre-rebrand `mission-control-updated` repo.
- `claudeSessionId` on `Task` (line 49), a Claude-specific field on a
  harness-agnostic type.
- `RESULT_OF` (lines 73-90), a hand-maintained request→result-frame table.

**After this PR there is one definition, in `@actana/sdk`.** The sweep that
proves it is in this PR's description; the short form:

- `packages/sdk/src/core-link-frames.ts` is the only file in the repository that
  declares core-link frame types, and it holds
  `CORE_LINK_PROTOCOL_VERSION = "0.15.0"` at line 1257.
- The only other `*_PROTOCOL_VERSION` declarations are
  `PANEL_LINK_PROTOCOL_VERSION` (`packages/panel/src/shared/panel-link.ts:57`
  and its copy in `scripts/lib/panel-e2e.mjs:30`), which is the Panel↔browser
  protocol and a different wire entirely.
- Everything else that names a frame — `scripts/lib/core-smoke.mjs`,
  `scripts/e2e-panel-smoke.mjs`, the Panel's link manager, the test fixtures —
  is a **consumer** of the definition, not a second copy of it.

One honest note, because a sweep for credential-shaped types finds it. The
registration blob shape is declared twice: `packages/sdk/src/core-registration-blob.ts:34`
and `packages/shared/src/registration-blob.ts:20`. That is **not** the mirror
this ticket removes and it is not undeclared drift — it is
[ADR 0025][adr0025] D4 working as written (shared stays private and keeps
everything that is not the protocol, the blob included), and the SDK file argues
its own copy in its header at lines 17-24: a published package cannot import a
type from a private one. The blob is not a core-link frame. Recorded here so that
the next person running this sweep finds the answer instead of the question.

## 6. Credentials and logs, verified against history

[#164][164] asks that no credentials or logs were **ever** committed, in this
branch or the freeze branch, and that this be verified against history rather
than the working tree. It was. The full output is in this PR's description; the
result:

- Exactly three commits ever touched `docs/reference/experiment-cli/` on any
  ref: `6bc4740` (the pristine copy), `0f742bf` (the freeze notice), and
  `8c3d5b2` (the squash on `feat/cli-and-publishing`).
- Every blob in every one of those three trees was read as **raw bytes** and
  scanned for PEM armour, `PRIVATE KEY`, JWTs, long hex and base64 runs, AWS,
  GitHub, Slack and OpenAI token shapes, credentialed URLs, and any literal
  assigned to a credential-shaped key. **Zero findings in all three.**
- No entry is a symlink, a gitlink or an executable; all are mode `100644`.
- No `blob.txt`, no `blobs/`, no `.log`, `.pem`, `.key`, `.env` or database file
  has ever been added anywhere in this repository, on any ref.

Binary-safe on purpose. `scripts/scan-secrets.mjs:88` skips any file containing a
NUL byte, and this repository has two source files that contain one —
`packages/core/src/__tests__/core-link-client-id-reclaim.test.ts` and
`packages/panel/src/components/views/UserTerminalPane.tsx` — so a green
`Secret Scan` is not by itself evidence about a file of that kind. None of the 17
frozen blobs contained a NUL byte, but that is a fact established by the scan
rather than by the green check.

## 7. What the deletion removes, and what nothing loses

`docs/reference/experiment-cli/` — 17 files, 2,643 lines — is deleted in the
commit after this document. **Nothing in the repository referenced it.** Before
the deletion, a binary-safe sweep of all 1,045 tracked files for
`experiment-cli` found zero occurrences outside the tree itself; after it, the
sweep of the remaining 1,029 files finds five, all of them in this document,
all of them prose describing what was removed. A parity check has to name the
thing it checked, and naming it is not depending on it: no import, no path
reference, no build input.

On [#207][207]'s review note about `eslint.config.mjs`: the reviewer observed
that the frozen tree was out of lint's reach only *incidentally* — `pnpm lint`
passes explicit paths (`eslint packages scripts screenshot.mjs eslint.config.mjs`)
and `docs/**` is not among the `ignores` at lines 9-17, so a bare `eslint .`
would have linted a tree that must never be fixed. **The suggested one-line
`"docs/**"` is deliberately not added.** Deleting the tree removes the thing that
needed protecting, and after the deletion the only file under `docs/` that
matches eslint's `files` glob is `docs/assets/src/build.mjs` — a live, maintained
build script that *should* be linted. Adding the ignore now would silence it. The
note is resolved by the deletion, which is the outcome it anticipated
("worth a line either here or in #164's cleanup").

[129]: https://github.com/actana/control/issues/129
[158]: https://github.com/actana/control/issues/158
[163]: https://github.com/actana/control/issues/163
[164]: https://github.com/actana/control/issues/164
[205]: https://github.com/actana/control/pull/205
[207]: https://github.com/actana/control/pull/207
[adr0022]: ../adr/0022-a-core-owned-project-has-a-panel-side-presentation-row.md
[adr0025]: ../adr/0025-the-protocol-ships-with-the-client.md
[adr0026]: ../adr/0026-prompt-delivery-is-a-core-responsibility.md
