# Turn-end reporting is the one mandatory harness signal

A harness family is a row in `HOOK_FAMILIES`
(`packages/core/src/harness-hooks.ts:267`), and the comment above that table
says the table is open: *"Keep this open: adding a family is adding a row."*
What the comment does not say is what a row has to **provide** — so the answer
was being decided one feature at a time, by whichever field the feature reached
for.

`reportsTurnStart` is the field it kept reaching for, and half the table answers
`false`. `claude-code` and `opencode` report a turn's start; `codex` and
`cursor-cli` do not, and cursor's own comment in that table reads *"The turn's
end is reported; its start is not."* A feature keyed on turn-start works on half
the harnesses this project ships today and is a coin flip for every family added
after it.

#289 met this head-on. Awaiting a follow-up turn looks like it needs two
signals — the turn started, then the turn ended — and the obvious design waits
for both. Against `codex` and `cursor-cli` the first signal never comes, so the
obvious design needs a second mechanism to cover the harnesses the first one
misses, and then a rule for which mechanism a new family gets. That is machinery
growing to work around a gap. The design that shipped removes the dependency
instead: the Core stamps a delivery in its own event log, and the wait resolves
on the first settling status after that stamp. Turn *start* is never consulted.

## Decisions

**D1 — Turn-end reporting is mandatory.** A harness family may be added to
`HOOK_FAMILIES` when its hooks move the Session's status on the Core at the end
of a turn — to `finished`, `needs-input`, `interrupted` or `terminated`. That is
the whole obligation, and it is the one every family in the table already meets.

**D2 — Turn-start reporting is an optional refinement, and may never gate a
feature.** `reportsTurnStart` survives as reported information: the
`hooksReportTurnStart` field on the `spawned` frame
(`packages/core/src/pty-core-link-server.ts`), the `reportsTurnStart` field on
`session start --json`, and the Panel's terminal-input fallback
(`packages/panel/src/lib/task-status-sync.ts`). A client may read it to explain
what it cannot show. **No wait consults it**, and no feature may be built such
that a family answering `false` loses the feature rather than losing polish.

**D3 — Auto-mode flags and resume ids are optional on the same terms.** OpenCode
ships no skip-permissions flag (`HARNESS_SKIP_PERMISSION_FLAGS` says so with
`null`) and a harness that never reports a session id has nothing to resume
from. Both degrade a Session; neither makes one unobservable. A feature that
required either would be a feature that quietly excluded a family already in the
table.

**D4 — A family that reports nothing degrades into the caller's timeout, and
says so.** No status is invented, and **nothing infers a turn from the byte
stream**. #191 deleted a flat quiet-output timer that did exactly that and
[ADR 0026](0026-prompt-delivery-is-a-core-responsibility.md) D3 records why. A
wait with no `--wait-timeout` has no deadline; one with a deadline reports, on
expiry, that *this side gave up* — never a status the Core did not send.

**D5 — `send --wait` carries a default deadline; the other waits do not**
(amends D4, #405). `session wait` and `session start --wait` wait for a turn
that is already under way, and the only thing a default deadline could cut short
there is honest work — so they keep D4's "no deadline unless the caller sets
one" exactly. `send --wait` is the one wait for a turn *it* has to start, and a
carriage return that lands on a dialog rather than a composer starts none: the
Core then has nothing to report, the status the Session is parked at was seeded
from the Task row and carries event id 0, and a delivery cursor can never be
satisfied by it. The wait is correct, silent and permanent. **1020 seconds** is
the default and `--wait-timeout 0` removes it. Seventeen minutes rather than
fifteen so that it cannot tie with the Core's own quiet backstop
(`QUIET_SETTLE_MS`, fifteen minutes, swept once a minute): where the Core has an
answer it should be the one to give it, and this deadline should only ever fire
where the Core has none — which is #405's case exactly, because the backstop
skips a Session that is not `running`.

This does not weaken D4 or reintroduce what #191 deleted. Nothing new is
inferred: the deadline is the caller's own clock, and what it reports on expiry
is still that this side gave up. What it adds is a **fact off the event log** in
the message — whether a status was reported for the Session at an event id above
the delivery's — so the operator is told which question is still open. It does
**not** claim to have told a swallowed return apart from a harness that reports
nothing mid-turn: half the families in `HOOK_FAMILIES` look identical in that
silence, and separating them would mean consulting `reportsTurnStart` (D2 forbids
it) or reading the byte stream (D4 forbids it). The message names both readings
and sends the reader to the screen. That comparison is two event ids, not a
reading of the screen.

The remedy the message offers is cursored for the same reason. `session wait` is
**not** it: that verb answers from the status a Session is parked at, so on a
turn that never started it returns at once with the status from before the write
and exits zero — a false completion, which is the failure #405 exists to remove.
`events tail --since <delivery id>` follows the log from the write and can only
report what came after it.

A send that submits nothing at all (`--no-enter`) is refused with `--wait`
rather than bounded: it has no turn to await, so there is nothing for a deadline
to be about.

## Consequences

Adding a family is still adding a row, and now the row has a bar to clear. A
harness whose hooks report a turn's end is drivable by every client: the Panel,
the CLI's `session wait` and `session send --wait`, and any SDK caller.

A harness whose hooks report **nothing** is not excluded from the table — it is
spawnable, attachable and killable — but it is not awaitable, and callers meet
that as a timeout rather than as a wrong answer.

## Out of scope: codex's hook review

Codex refuses to run newly-installed project hooks until an operator reviews
them with its hooks command; the comment sits on the `codex` row itself
(`packages/core/src/harness-hooks.ts:269-272`). In a fresh workspace codex may
therefore report nothing at all, turn-end included — so it can fail D1 for
reasons that have nothing to do with what its hooks say.

**No wait mechanism can close that.** It is an install-time defect, not a
waiting defect, and it is filed as its own issue:
[#290](https://github.com/actana/control/issues/290). It is named here so that
the next reader meeting a silent codex Session knows which of the two problems
they have.
