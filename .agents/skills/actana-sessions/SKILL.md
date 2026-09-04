---
name: actana-sessions
description: Drive Actana Control Cores and Sessions with the `actana` CLI — register and select a Core, see which Harnesses it can run, start Sessions with a prompt, wait for them to settle, collect the report each one wrote, send follow-up input, and stop them. Use when asked to run work in one or more Sessions, to provision several Sessions at once ("give me three sessions, each on a different thing"), to check on or collect results from Sessions already running, or whenever a task would be done by another agent on a Core rather than here.
x-actana-managed: true
---

# Driving Cores and Sessions with `actana`

`actana` is a client. A **Core** is a machine running the Actana Control daemon;
a **Session** is one Harness process — a vendor's coding agent — running on that
Core inside a **Project**. Sessions belong to the Core, not to this command: a
Session keeps running after `actana` exits, and any later `actana` invocation
can list it, read it, write to it or stop it.

If `actana` is not on this machine, or reports no Core, say so and stop. Do not
install anything and do not guess at a Core's address.

**This skill is invoke-only, and the one installed beside it is not. The
asymmetry is deliberate — do not tidy it into symmetry.** This one sits
installed and does not volunteer: it is for a Session whose operator has asked
for work to be run in other Sessions. Its sibling, the sub-agent skill, is
**eager**: it triggers on a prompt telling a Session that it is acting as a
sub-agent of an orchestrating Session, and this skill is what teaches you to put
that declaration in every prompt you send. The two roles have opposite trigger
requirements — one is a thing an operator asks for, the other is a thing a
Session is *told it already is* by the prompt that woke it — and one
`description` field cannot hold both. That, and nothing about length or
tidiness, is why there are two files.

## Orientation, in the order that answers the questions

```bash
actana core ls                 # Cores this machine can reach; * marks the selected one
actana core use <name>         # select one for subsequent commands
actana harness ls --json       # what the selected Core can actually run, right now
actana project ls --json       # the Projects on that Core; a Session needs one
actana session ls --json       # Sessions already running there
```

`--core <name>` overrides the selection for a single command. Every list verb
takes `--json`, and under `--json` only the JSON document reaches stdout —
diagnostics go to stderr — so parsing is safe.

**On a machine that is itself a Core, that Core is already registered and
already selected.** Installing a Core wires it to the same machine's `actana`,
so `core ls` lists it and it is what every command below means unless `--core`
or `core use` says otherwise. Address it by default; do not ask the operator to
pair the machine you are already standing on.

**Pick the Harness from what `harness ls` reports, every time.** It lists each
Harness with a `status` of `available` or `missing`; only `available` can run.
There is no default and no preference order here on purpose — operators have
their own, this skill has none, and a Harness that was available yesterday may
be missing today. Ask the operator if the choice matters to them and nothing in
the request settles it.

## Starting one Session

```bash
actana session start <project> "<prompt>"            # prints the session id, exits
actana session start <project> "<prompt>" --json     # the same as an object
actana session start <project> - < brief.md          # a prompt of `-` is read from stdin
```

Useful flags: `--harness <id>` (one of the ids `harness ls` printed),
`--title <text>` (what it is called in a listing), `--cwd <path>` (a directory
**on the Core**, inside the Project), `--dangerously-skip-permissions` (run the
Harness without permission prompts — only when the operator has asked for
unattended work).

`start` returns as soon as the Core has the Session running. The prompt is
delivered by the Core, which watches the Harness boot and types when it is
ready; add no delays, no leading newline and no "press enter" of your own.

**`--harness` is how one round spans several Harnesses.** Nothing else is
needed for it: each `session start` takes its own `--harness`, so a round of
lanes on different Harnesses is a round of ordinary starts. Pick every id out of
what `harness ls --json` reported as `available`, and never out of memory.

## Waiting, and reading the result

```bash
actana session start <project> "<prompt>" --wait --json --wait-timeout 900
```

**`--wait --json` blocks until that Session's first turn settles.** That is what
it is for, and it is worth having: it is one call that starts a Session and
returns when the turn it started has ended.

**What it is not is a way to collect a result.** The `screen` field on the
object it prints is a *rendered transcript* — a terminal emulator's picture of a
bounded replay ring. It is wrapped to a fixed width, the oldest lines are
dropped once the ring is full, a Harness that clears its scrollback discards all
of it with no error and no signal, and killing the Session destroys what is
left. A transcript is what a human reads over somebody's shoulder. **A result is
a file**, and the contract below is how you get one.

The object also carries `taskId` (the Session's id — this is what every other
verb takes), `harness`, `project`, `status`, `exited`, and `reportsTurnStart`.
`--wait-timeout <seconds>` bounds the wait; without it `start --wait` has no
deadline of its own (`send --wait` does — see the loop below). A timeout is this
side giving up, not a verdict about the Session: the Session is still running on
the Core and can still be listed, read and stopped.

While a Session is alive — which is what the `live` field on its
`actana session ls --json` row tells you, and the only thing that does — you can
also look at it directly:

```bash
actana session logs <id>          # the transcript, rendered, while the harness is running
actana session send <id> "text"   # write into it; the carriage return that submits goes too
actana session wait <id>          # block until the Core reports it settled
actana session kill <id>          # stop the harness running for it
```

`actana events tail --json` follows the Core's event log as NDJSON if you want
to watch state change rather than poll — `session:finished` is the Core's own
signal that a Session reached a terminal state. Both of these are for **watching
progress**. Neither is what tells you a report is ready; the last line of the
file is.

## The multi-turn loop

A Session is a conversation, not a single question. The whole loop:

```bash
ID=$(actana session start <project> "<first prompt>")   # prints the id, exits
actana session wait "$ID" --json --wait-timeout 1800    # block until it settles
actana session send "$ID" "<follow-up>" --wait --json --wait-timeout 1800
actana session send "$ID" "<next>" --wait --json --wait-timeout 1800
```

Every line carries the same budget on purpose: 1800 seconds is what `await.sh`
gives a round, and a loop whose steps disagree about how long a turn may take
gives up in the middle of one. Pass it explicitly rather than leaning on a
default — `send --wait` has one (1020 seconds) and the other two do not.

**`actana session wait <id>` blocks until the Core reports the Session settled**
— `finished`, `needs-input`, `interrupted`, `terminated` or `disconnected`,
because every one of those is a turn that ended. A Session that is already
settled answers at once, so a wait that starts after the turn ended is not a
wait that hangs.

**`actana session send <id> "<text>" --wait` waits for the turn that text
starts.** The Core stamps the delivery in its event log and the wait resolves on
the first settling status *after* that stamp, so it can never hand you the
status the Session was already parked at. With `--json` it prints the **same
object** `start --wait --json` prints — same keys, same `screen` — so one parser
reads all three verbs. Two of those keys are `null` on a Session you attached to
rather than started: `command` and `reportsTurnStart` are answers to a spawn.

Five things to know before you build on it:

1. **Sending into a turn that is already running resolves on *that* turn's
   end.** A keystroke into a busy Harness is not a new turn. If the Session was
   mid-turn when your text landed, the wait ends when the current turn ends —
   possibly before the Harness has read a character of what you sent. Wait for
   the Session to settle *first*, then send.
2. **A `send` presses Enter for you, and `--no-enter` is how you stop it.** The
   text goes first and the carriage return follows as its own separate write.
   `--no-enter` sends no return, so that send starts no turn — and it **cannot
   be combined with `--wait`**, which is refused as a usage error: a send that
   submits nothing has no turn to await. Type with `--no-enter`, then
   `actana session wait` once a turn is actually running. `--enter` is still
   accepted and does nothing on a send that carries text, so an older script
   that passes it keeps working; on a send with no text it still means a bare
   carriage return and nothing else.
3. **A timeout is this side giving up, not a status.** `--wait-timeout
   <seconds>` bounds the wait. `session wait` has no deadline unless you set
   one, because a turn takes as long as the work takes; **`send --wait` defaults
   to 1020 seconds**, because it is the one wait for a turn that has not started
   yet and a carriage return that lands on a dialog rather than a composer
   starts none at all. `--wait-timeout 0` waits with no deadline. On expiry you
   get a message saying the wait gave up and a non-zero exit — the Session is
   still running on the Core, and `session logs` and `session kill` still work.
   When no turn end was reported since your text went in, the message says so
   and names both readings: the text may have started no turn, or a turn may
   still be running on a Harness that reports nothing until it ends. The text
   was delivered either way — read the screen with `session logs` rather than
   sending it again.
4. **Do not answer that timeout with `session wait`.** It is uncursored: it
   answers from the status the Session is parked at, so on a turn that never
   started it returns **at once, with the status from before your text, and
   exits zero** — which reads as a completed turn and is not one. To carry on
   waiting, follow the log from the delivery instead:
   `actana events tail --since <event id>`, the id the timeout message names.
5. **A wait whose link to the Core drops ends as *unknown*.** Every wait listens
   over that link, so a Core that restarts or a connection that is reaped takes
   the report the wait was waiting for with it. Rather than hang — which is what
   it used to do, with no deadline of any kind to end it — the command exits
   non-zero saying **the turn's outcome is unknown**: it may have ended while
   this side was deaf, and it may still be running. That is not a failed turn
   and not a finished one, and it is the one case where the Session's status has
   to be re-read from the Core rather than taken from the wait. Do that once the
   Core is reachable again — `actana session ls` says whether it is still live,
   `actana events tail --since <event id>` follows the log from your delivery —
   and **do not** answer it with `session wait`, for the reason in 4.

**Every turn of that loop gets its own report file**, and the turn number in the
filename is what keeps them apart. See below.

## Asking a Session for a report file

A Session hands work back by **writing a file on its own Core**. You read the
file back over the core link. Nothing in this path goes through a screen, a
renderer, a replay ring or a scrollback limit, and nothing in it can be
truncated by a Harness that decided to repaint.

The contract, in full. Every clause is load-bearing:

- **The path is `.actana/reports/<id>-r<turn>.md`, relative to the Session's own
  `cwd` on its own Core.** Dot-prefixed so it reads as machine state rather than
  as project content, and so it falls under the ignore habits operators already
  have for dot-directories. The Session's `cwd` is the anchor because it is the
  only directory a prompt can name in a sentence: a Session knows where it is
  standing and nothing else.
- **Everything that reads the file back is anchored at the Project root
  instead, and closing that gap is yours.** `actana project cp` takes
  `<project>:<path>` and resolves `<path>` against the **Project**, and so does
  every lane you hand `await.sh`. The two anchors are the same path only when
  the Session runs at the Project root. So:

  - **Start a lane you intend to collect with no `--cwd`, and the question does
    not arise.** A Session with no `--cwd` runs at the Project root, which is
    where the collectors are already anchored, and the prompt's path and the
    lane's path are one string.
  - **If a lane needs a `--cwd`, convert once, when you mint the name.**
    `--cwd` is a directory **on the Core**, so the lane's path is that
    directory *relative to the Project root*, followed by the path you put in
    the prompt. A Project `api` at `/srv/work/api`, started with
    `--cwd /srv/work/api/apps/api` and told `.actana/reports/api-r1.md`, is
    collected as the lane `api:apps/api/.actana/reports/api-r1.md`, and read
    with `core exec --cwd /srv/work/api/apps/api -- tail -n 3 --` and that same
    prompt path. Keep both forms beside the lane, and never derive one from the
    other twice.

  `actana project ls --json` prints each Project's `path`, which is the root
  both of those are relative to.

  Getting this wrong is silent. The sub-agent writes the file it was told to
  write, the collector looks somewhere else, and every lane in the round runs to
  its timeout reporting nothing — with no error anywhere, because nothing failed.
- **You mint the filename; the sub-agent never invents one.** You are the only
  party that knows every lane in the round, so you are the only party that can
  promise no two lanes collide. **Never reuse a name** — not across lanes, not
  across rounds, not across turns.
- **`-r<turn>` is the turn number and it is not decoration.** A round is often
  six turns in **one** Session. Without a per-turn name, turn 2 silently reads
  turn 1's file on any turn that failed to write one — a stale report
  indistinguishable from a fresh one, which is the worst failure available: a
  confident wrong answer.
- **The file's final line must be exactly `ACT-REPORT-END`.** That is the
  completeness proof and **the only thing that settles a Session**. Not a
  status, not an event, not a timeout — the last line of the file.
- **State the full relative path in the prompt, every turn.** Belt and braces:
  the skill at the other end teaches the convention, and your prompt restates
  the exact path. A skill is a document a model may have compressed; a prompt is
  in front of it.

Put it in the prompt in the Session's own words, and open with the declaration
that turns the sub-agent skill on at the other end:

> You are acting as a sub-agent of an orchestrating Session. When you are
> finished, write your complete report to `.actana/reports/api-r1.md` under the
> directory you are working in, creating the `.actana/reports` directory if it
> does not exist. The file's final line must be exactly `ACT-REPORT-END`.

**That first sentence is not a courtesy.** The sub-agent skill installed on that
Core is eager and triggers on exactly that declaration, so a prompt without it
wakes a Session that never learned the contract. Send it in **every** prompt you
send, follow-up turns included, with that turn's own path.

Say nothing else about the mechanism. What the Session should actually *do* is
yours to say, in the same prompt, in whatever detail the work needs — and any
skill you ask it to use travels there too.

## Collecting a report

`actana core exec` runs one command on the Core over the core link: no terminal,
no rendering, stdout as it was written.

```bash
# --cwd here is the directory the Session is running in: the path you gave
# `session start --cwd`, or the Project's own `path` from `project ls --json`
# when you gave none. It is what the prompt's report path is relative to.
actana core exec --cwd <session-cwd> -- tail -n 3 -- .actana/reports/api-r1.md
actana core exec --core <name> --cwd <session-cwd> -- cat .actana/reports/api-r1.md
```

The order below is the whole of it:

1. **Poll for the file.** A non-zero exit is almost always "not there yet",
   which is the ordinary state of a Session that is still working. One exit code
   is not: **125 means the link to the Core dropped mid-command** — the command
   kept running over there and this side has no answer. That is *ask again next
   tick*, never *no report*.
2. **Check the LAST line, not the file.** `ACT-REPORT-END` occurring anywhere
   else — quoted, inside a fenced block, in a diff — is not a finished report,
   and a search that matched it would settle a Session that has not finished.
   Read the tail and compare its last non-blank line.
3. **Save the content locally, first.** `actana project cp <project>:<path>
   ./<local-path>` copies it down. **`<path>` here is Project-relative** — this
   is the step where the anchor changes, so it is the lane's path and not the
   prompt's, and they differ by the Session's `cwd` whenever one was given. Give
   every lane its own local filename, because "three Sessions, each on a
   different thing" naturally gives every sub-agent the same basename inside its
   own Project.
4. **Only then, after roughly 20 seconds, delete the remote file** — with
   `core exec`, against the Session's own directory again, like steps 1 and 2:
   `actana core exec --cwd <session-cwd> -- rm -f .actana/reports/api-r1.md`. **The
   delay is not tidiness.** It exists so that a Session still finishing cannot
   have its file deleted out from under it and write it again, which would
   present as a second, partial report at a path you have already retired.

**Never delete before the local save.** The durable local artifact is the entire
point of reading a file rather than a screen, and deleting first reintroduces
exactly the failure this contract exists to end.

## `await.sh`, which does steps 1-3 of that for a whole round

This skill folder ships `await.sh` beside this file. It watches every lane in
**one** loop — a per-lane wait serialises a round, so a six-lane round runs at
the speed of its worst lane *summed* rather than its worst lane alone — checks
the last line rather than searching the file, treats a dropped link as "not
yet", and saves each report to local disk before it touches the Session.

**It does steps 1, 2 and 3. It never does step 4.** The script has no remote
delete and no ~20 second delay; once a lane's bytes are safely down it either
stops that Session under `--kill` or moves on. Retiring the remote file stays
yours, per lane, after the round. `--kill` is a *different* guard from the
delay, not a substitute for it: a stopped Session cannot rewrite its report, so
a killed lane's file is settled and you may retire it at once, while a lane left
running still wants the ~20 seconds before you delete anything.

```bash
# Both lanes below started with no --cwd, so each Session runs at its Project
# root and the lane path is the prompt's path unchanged. A lane started at
# <project-root>/apps/api would instead read
#   7f3a=api:apps/api/.actana/reports/api-r1.md
bash await.sh --out ./reports --timeout 1800 \
  7f3a=api:.actana/reports/api-r1.md \
  9c1b=web:.actana/reports/web-r1.md
```

A lane is `<session-id>=<project>:<report-path>`, and the report path is the
**Project's**, exactly as `actana project cp` takes it — not the Session's, and
that is the one conversion this whole procedure asks of you. `await.sh` resolves
it against the Project root the Core reports, so a lane carrying a bare
prompt path from a Session started somewhere else inside the Project waits for a
file nobody is writing, and says so only when the round's budget runs out.

`--core <name>` passes through to every call it makes; `--kill` stops each
Session once its report is safely on this disk. It exits 0 when every lane's
report was saved and 1 when any lane's was not, and prints one line per lane
saying which.

It is installed without an executable bit, on purpose — run it as `bash
await.sh`. Read it before you extend it: the reasons for each of those four
behaviours are written at the top of the file, and each one is a failure that
has actually happened.

## Several Sessions at once

There is no batch verb. Provisioning N Sessions is N `session start` calls, and
that is deliberate: each one gets its own prompt, its own Harness and possibly
its own Project, and a Session that fails to start is one failure rather than a
failed batch.

The shape that works:

1. **Ask what is missing before starting anything.** How many Sessions, what
   each one is for, and which Project. If the operator said "three sessions,
   each focusing on three different things", the three things are theirs to
   name — do not invent a split and do not start work on a guess.
2. **Check `harness ls` once**, and use only `available` ids.
3. **Mint one report path per lane before you start anything, and put it in that
   lane's prompt** along with the sub-agent declaration. The paths are what make
   the round collectable, and minting them up front is what makes them unique:
   one `<id>` per lane, `-r1` for the first turn of each. Mint the lane's
   **collection** path in the same breath — the same string when the lane has no
   `--cwd`, and that directory in front of it when it has one.

   ```bash
   actana session start "$project" "$prompt_a" --harness "$h_a" --json > a.json
   actana session start "$project" "$prompt_b" --harness "$h_b" --json > b.json
   actana session start "$project" "$prompt_c" --harness "$h_c" --json > c.json
   ```

   No `--wait` is needed here and none is wanted: `start` returns as soon as the
   Core has the Session running, so three starts in a row are three Sessions
   working side by side. Take each `taskId` out of its object.
4. **Wait for the files, not for the Sessions.** One loop over every
   outstanding lane — `bash await.sh` is that loop — polling each lane's
   **Project-relative** report path until its last line is `ACT-REPORT-END`,
   saving each one down as it lands. A lane that has not finished costs a lane
   that has nothing.
5. **`logs`, `events tail` and `session ls` are for watching progress, and that
   is all they are for.** A row's `live` field says whether the harness process
   is still up and its transcript still exists; a terminal status is not
   permission to treat a transcript as a result, and neither is `live: true`.
   The result is the file. If a Session reached a terminal status and no report
   file ever appeared, that is a lane that produced nothing — report it as
   exactly that.
6. **Report per Session, by id**, including the ones that produced no report. A
   Session that finished without one is a fact, not a gap to fill in.

**How many to start is the operator's decision, not a rule.** Every Session is a
Harness process on somebody's machine costing somebody's tokens. Start the
number that was asked for; if no number was asked for, ask.

**One level, and one only.** The Sessions you start are sub-agents, and the
skill they wake with forbids them starting Sessions of their own. Recursive
provisioning is unbounded — each level multiplies and nothing caps depth or
breadth — so the round you are running is the whole tree.

## When something is wrong

- **`no Core registered` / nothing from `core ls`** — this machine has no Core
  of its own and has not been pointed at a remote one. Pairing a remote Core is
  the operator's to do (`actana core pair`, with a code from `actana pair new`
  on the Core); say so rather than attempting it.
  Note that a machine running a Core registers it automatically, so an empty
  `core ls` means there is no local Core either — not that somebody forgot to
  pair one.
- **`harness ls` shows everything `missing`** — the Core has no coding agent
  installed. `actana harness install <id>` asks the Core to install one and
  waits for its verdict; it takes minutes and can legitimately fail.
- **A Session started but produced nothing** — check `reportsTurnStart` in the
  start object. When it is `false`, the Harness sends no turn-start signal and
  a Session can sit on `ready` through its whole first turn; wait on the report
  file rather than on the Session looking busy.
- **The report file never appears** — read the transcript with
  `actana session logs <id>` while the row still says `live: true` and find out
  what the Session did instead. The usual cause is a prompt that never stated
  the path, or stated one the Session could not create. Send the path again as a
  follow-up turn, with its own `-r<turn>` name; do not reuse the one that failed.
- **A report file is there but its last line is something else** — it is not
  finished. That is not an error and not a reason to read it: keep polling, and
  let the round's timeout be what gives up.
- **`session logs` says the Session has no harness running** — the Harness has
  exited and its transcript is gone with it. Nothing recovers a transcript. A
  report file that was written survives it, which is the point of writing one.
- **A prompt seems not to have arrived** — do not retype it and do not send a
  bare carriage return. Delivery is the Core's job; a lost prompt is a bug to
  report with the Session's id, not a thing to work around from here.
