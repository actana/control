---
name: actana-sessions
description: Drive Actana Control Cores and Sessions with the `actana` CLI — register and select a Core, see which Harnesses it can run, start Sessions with a prompt, wait for them to settle, read what they produced, send follow-up input, and stop them. Use when asked to run work in one or more Sessions, to provision several Sessions at once ("give me three sessions, each on a different thing"), to check on or collect results from Sessions already running, or whenever a task would be done by another agent on a Core rather than here.
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

## Waiting, and reading the result

```bash
actana session start <project> "<prompt>" --wait --json --wait-timeout 900
```

**`--wait --json` is the reliable way to collect a result, and the reason is
mechanical.** A Session's transcript lives in a replay ring that belongs to the
Harness's terminal, so a Harness that has exited has taken its output with it
and a later `actana session logs` has nothing left to print. The object
`--wait --json` prints carries a `screen` field holding the transcript as it
settled, in the same document as the status — so the result is in hand before
the process it came from can disappear.

The object also carries `taskId` (the Session's id — this is what every other
verb takes), `harness`, `project`, `status`, `exited`, and `reportsTurnStart`.
`--wait-timeout <seconds>` bounds the wait; without it the wait has no deadline
of its own. A timeout is this side giving up, not a verdict about the Session:
the Session is still running on the Core and can still be listed, read and
stopped.

While a Session is alive — which is what the `live` field on its
`actana session ls --json` row tells you, and the only thing that does — you can
also look at it directly:

```bash
actana session logs <id>          # the transcript, rendered, while the harness is running
actana session send <id> "text"   # write into it; --enter follows with a carriage return
actana session kill <id>          # stop the harness running for it
```

`actana events tail --json` follows the Core's event log as NDJSON if you want
to watch state change rather than poll — `session:finished` is the Core's own
signal that a Session reached a terminal state.

## Asking a Session for a machine-readable report

A screen is a transcript, not a result. When you need a Session to hand back
something you can parse, tell it in the prompt to end with its report wrapped in
a sentinel pair, and take the report out of the settled screen.

The sentinel is `<%ACT_REPORT%>` … `<%/ACT_REPORT%>`, and the four rules matter
as much as the token:

1. **The token is deliberately unusual.** Ordinary prose, code samples and test
   fixtures never contain `<%ACT_REPORT%>`, so a match is a report and not a
   coincidence.
2. **It is a pair, not a single marker.** A lone marker is unrecoverable the
   moment the Harness prints anything after its report — there is no way to
   tell where the report ended.
3. **The last complete pair wins.** A conversation runs many turns and may emit
   the sentinel more than once; the pair nearest the end is the final state.
   An incomplete trailing opener is not a report.
4. **Match with whitespace stripped.** What you are reading is a *rendered
   screen*, produced by a terminal emulator with a fixed width, so a tag that
   reaches the right margin is wrapped across two rows and a literal match
   fails. Strip whitespace — newlines included — from both the haystack and the
   tags before searching, and keep the original text for the extracted body.

Put the instruction in the prompt itself, in the Session's own words:

> When you are finished, print your result between `<%ACT_REPORT%>` and
> `<%/ACT_REPORT%>` on their own lines, and print nothing after the closing tag.

**Save the report before you stop the Session.** Killing a Session destroys the
replay ring the report is being read from — collect first, kill second, in that
order, always.

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
3. **Start each Session in its own backgrounded `--wait --json` call, and wait
   for all of them together.** N concurrent Sessions are N `session start
   --wait --json` calls running side by side — that is what makes them
   concurrent, not the absence of `--wait`. Run them one after another and you
   have a queue; run them in the background and you have N settled `screen`
   fields, which is the only thing this CLI hands back that is guaranteed to
   still exist when you read it.

   ```bash
   actana session start "$project" "$prompt_a" --wait --json --wait-timeout 900 > a.json &
   actana session start "$project" "$prompt_b" --wait --json --wait-timeout 900 > b.json &
   actana session start "$project" "$prompt_c" --wait --json --wait-timeout 900 > c.json &
   wait
   ```

   Each file holds one complete object: `taskId`, `status`, `exited` and the
   `screen` as it settled. Take every report out of those, not out of a later
   `logs` call.
4. **Give each one the sentinel instruction** in its prompt.
5. **If you polled instead, check `live` before you read anything.** Starting
   without `--wait` and polling `actana session ls --json` — or following
   `actana events tail --json` — is a legitimate shape when you want to watch
   progress, but a terminal status is not permission to read a transcript.
   Every `session ls --json` row carries a **`live`** field beside its status
   (it is the `LIVE` column in the table). `live: true` means the harness
   process is still up and its replay ring still holds the transcript;
   `live: false` means the harness has exited and took the transcript with it,
   whatever the status says. So: read `actana session logs <id>` only while
   that row says `live: true`, extract the last complete sentinel pair, and
   only then `actana session kill <id>`. A row that reached a terminal status
   with `live: false` before you got to it is a result you did not collect —
   report it as that, and use `--wait --json` for the next run rather than
   trying to recover it. This is the whole reason step 3 is written the way it
   is: polling races the process, and `--wait --json` does not.
6. **Report per Session, by id**, including the ones that produced no parseable
   report. A Session that finished without a report is a fact, not a gap to
   fill in.

**How many to start is the operator's decision, not a rule.** Every Session is a
Harness process on somebody's machine costing somebody's tokens. Start the
number that was asked for; if no number was asked for, ask.

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
  a Session can sit on `ready` through its whole first turn; wait on the
  Session's terminal status rather than on it looking busy.
- **`session logs` says the Session has no harness running** — the Harness has
  exited and its transcript is gone with it. Nothing recovers it. That is what
  `--wait --json` exists to prevent, next time. The same fact is visible before
  you read: the Session's row in `actana session ls --json` says `live: false`.
- **A prompt seems not to have arrived** — do not retype it and do not send a
  bare carriage return. Delivery is the Core's job; a lost prompt is a bug to
  report with the Session's id, not a thing to work around from here.
