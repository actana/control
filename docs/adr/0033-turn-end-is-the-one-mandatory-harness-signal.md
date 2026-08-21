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
