---
name: actana-subagent
description: Hand work back as a sub-agent of an orchestrating Session — write the report file the orchestrating Session named, ending it with the exact final line that marks it complete, and provision no further Sessions. Use whenever a prompt says this Session is acting as a sub-agent of an orchestrating Session, or names a report file for this Session to write and an end marker to finish it with.
x-actana-managed: true
---

# Reporting back as a sub-agent

A prompt has told this Session that it is acting as a **sub-agent** of an
orchestrating Session. That declaration is what turned this skill on, and it
means one concrete thing: the Session that woke you is waiting on a **file**,
not on your screen, and it cannot see anything you print.

**This skill is eager, and the one installed beside it — the orchestrator skill
— is invoke-only. The asymmetry is deliberate; do not tidy it into symmetry.**
The
orchestrator role is a thing an operator asks for, so that skill waits to be
asked. The sub-agent role is a thing a Session is *told it already is*, by the
prompt that woke it, and there is no operator in that loop to ask. One
`description` field cannot hold both requirements, which is why these are two
files.

**This skill covers two things and nothing else: the report file, and the
prohibition below.** It says nothing about how to do the work — not the
planning, not the implementation, not the testing, not what to put in the
report.
That silence is deliberate and it is a bound, not an omission. An orchestrating
Session routinely passes other skills in the same prompt, and this one is eager
while those were invoked: advice from here would fight them and would win.
Whatever the prompt asked for, and whatever skill it named, is what governs the
work. This governs only how the answer gets back.

## The report file

- **The path is `.actana/reports/<id>-r<turn>.md`, relative to this Session's own
  working directory — its `cwd` on the machine it is running on.** Create
  `.actana/reports` if it is not there. It is dot-prefixed because it is machine state rather than project
  content.
- **The orchestrating Session mints the name, and it states the full relative
  path in its prompt, every turn.** Use exactly the path you were given.
  **Never invent one, never shorten one, and never reuse a path from an earlier
  turn** — the name carries a turn number precisely so that turn 2 cannot be
  read as turn 1's report. If a turn's prompt names no path, say so in the
  Session and write nothing rather than guessing at a name nobody is watching.
- **The file's final line must be exactly `ACT-REPORT-END`**, on its own line,
  with nothing after it.

That last line is the whole settling signal. The Session waiting on you polls
the file and compares its **last** line to that marker: no status, no event and
no timeout tells it you are done, and nothing else will. Two consequences, and
both of them bite:

- **Write the file only when the report is complete.** A file whose last line is
  anything else reads as "still working", which is correct while you are — but a
  half-written file left behind by an abandoned attempt is a lane that never
  settles.
- **Print nothing that matters only to the screen.** Whatever you say in the
  Session is read by a person, if anybody reads it at all. The file is the
  answer.

Do not write to a temporary name and rename it into place. It is better
engineering and worse instruction-following: the second step is the one that
gets skipped, and a temporary file that never lands is a lane that never
settles. One file, written once, ending in the marker.

## Do not create Sessions

**A sub-agent must not start Sessions of its own through the `actana` CLI.** Not
on this Core, not on another one, not for a piece of the work that would divide
neatly. `actana session start` is the orchestrating Session's to call and not
yours. If the work genuinely needs more Sessions, say so in your report and let
the Session that woke you decide.

The bound is recursion. Every level of provisioning multiplies the level below
it, nothing caps the depth or the breadth of that, and every Session is a
harness process costing somebody's tokens on somebody's machine. One
orchestrating Session, one level of sub-agents.

**This does not restrict a harness's own native sub-agent facility.** If the
coding agent you are running inside has an in-process task or sub-agent
mechanism of its own, it stays available and this skill has nothing to say about
it: that is a different mechanism with different bounds, and it provisions
nothing on any Core. The prohibition is about `actana session start`, and about
nothing else.
