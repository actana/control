# A second skill for the sub-agent role, and it is eager

> **Status: PROPOSED.** Not accepted. **This record depends on
> [ADR 0031](0031-the-product-ships-one-skill.md)**, which is itself `PROPOSED`.
> 0031's consequences say *"a second skill is not authorised by this record; it
> argues against D2 on its own"* (`0031-…:396-400`), and this is that argument,
> made for one named skill so it can be accepted or rejected on its own terms.
> **The repository owner ratifies or rejects both at the beta gate**, and the
> order matters: if 0031 is rejected, this record is moot in its shipped form and
> what survives of it is described under *If 0031 is rejected* below. Correcting
> a falsified factual claim inside 0031 — as the same pass that landed this
> record did — is repair and **is not** ratification of either document.

> **On the number.** This record takes **0035**, the next free number:
> `docs/adr/` runs to `0034-short-code-pairing-enrollment.md`, and
> `0033-turn-end-is-the-one-mandatory-harness-signal.md` and 0034 both landed on
> `beta/0.4.0` after [#305](https://github.com/actana/control/issues/305) was
> written against `8aa5b5b`, where 0033 was free.
> [`README.md`](README.md)'s rule is **append a clause, never shift one** —
> nothing is renumbered here, and the two pre-existing 0018s and the two D38s
> inside 0023 stay exactly where they are.

[#303](https://github.com/actana/control/issues/303) proposes splitting the
product's orchestration skill in two: `actana-sessions` keeps the orchestrator
role, and a new `actana-subagent` carries the sub-agent role — how to write the
report file, and one prohibition.
[#304](https://github.com/actana/control/issues/304) makes the installer
multi-file so a skill folder can ship `await.sh` beside `SKILL.md`. Both are
gated on 0031's ratification and on this record; this is where the consequence
of the other verdict is written down.

## Why a second skill needs its own record

0031 carved out **exactly one class** of skill from
[ADR 0006](0006-no-bundled-skills.md): *"a skill whose entire subject is driving
the product's own CLI"*, and then closed the door behind it. A second skill is
not authorised by that carve-out even when it falls inside the class, because
the carve-out was argued for one file with one `description`. So the result-bias
objection D2 answers has to be answered again, on the record, for
`actana-subagent` specifically.

## The argument this record expects to win on, stated so it can be rejected

**D2's cost is discoverability by Sessions that never touch a Core.** 0031
accepts it openly for `actana-sessions` (`0031-…:169-173`): *"a Session that
never touches a Core can still read this skill's description, and that is a real
cost paid for the mandatory-ness D3 chooses."* That cost is paid because the
skill's `description` is **subject-matter** — Cores, Sessions, orchestration —
and subject matter is latent in every Session on the machine, whatever it is
working on.

**`actana-subagent` pays that cost differently, and less.** Its trigger is not a
topic. It is a **declaration in the prompt** that this Session is acting as a
sub-agent of an orchestrating Session. A Session nobody addressed that way never
matches it, however close its work sits to the subject. Contrast the alternative
#303 rejected — widening `actana-sessions`'s own description until it
self-triggers — which would make every unrelated Session on the machine match,
paying D2's cost a second time and in full.

**A skill that fires only when a prompt declares the Session a sub-agent is the
narrowest behaviour injection this repository has shipped.** Narrower than
`actana-sessions`, whose description is subject-matter and therefore latent
everywhere. It should win on that basis, and if that claim is wrong it is wrong
in a way a reviewer can point at.

**The honest form of the counter-question, put here so it is answered rather
than assumed** — the same discipline 0031 D2 applies to itself at
`0031-…:155-167`. `actana-subagent` does carry one instruction that is *about
the operator's work* rather than about the product's CLI: the prohibition on
`actana session start` (D3 below). Three things are true of it — it is a "do not
do this" rather than a "do this", it is confined to one CLI the operator
installed, and its alternative is unbounded recursive provisioning across Cores.
None of those is a proof. **A reviewer who holds that *any* instruction about
what a Session may not do is the diagram skill's argument with better manners
should say so, and this record should then be rejected.**

## The decisions

**D1 — The two roles have opposite trigger requirements, and that asymmetry is
why there are two skills rather than one longer one.** `actana-sessions` is
**invoke-only**: it sits installed and does not volunteer, and a Session uses it
when its operator asks. `actana-subagent` is **eager**: it triggers on a prompt
declaring the Session a sub-agent, and the orchestrator emits that declaration in
every prompt it sends. The orchestrator role is a thing an operator asks for; the
sub-agent role is a thing a Session is *told it already is*, by the prompt that
woke it. A sub-agent that had to be asked to use the skill would need the
operator in a loop that has no operator in it. **One `description` field cannot
hold both**, and that — not length, not tidiness — is the whole of why a second
file is needed.

**D2 — `actana-subagent` composes, and therefore says nothing about how to do
work.** An orchestrator routinely passes other skills in the same prompt: an
implement skill, a planning skill, a review skill. `actana-subagent` covers
**only** the report contract and the prohibition in D3 — not how to plan, not how
to implement, not how to test, not how to report *content*. The mechanism behind
this bound is specific: an eager skill that gave working advice would fight the
invoked skill it was passed alongside, and it would **win**, because it is eager
and the passed skill was invoked. The scope is drawn this tightly for that reason
and not out of taste.

**D3 — A sub-agent must not create Sessions through the `actana` CLI, and the
bound is recursion.** Recursive cross-harness provisioning is unbounded: each
level multiplies, **nothing in `control` caps depth or breadth**, and every
Session is a harness process costing somebody's tokens on somebody's machine. One
orchestrator, one level of sub-agents. **This does not restrict a harness's own
native sub-agent facility** — that is a different mechanism with different
bounds, it provisions nothing on a Core, and it stays available. The prohibition
is about `actana session start` and nothing else. It is stated harness-neutrally
in the skill text, because
`packages/shared/src/__tests__/orchestration-skill-fanout.test.ts` asserts that the
shipped text names none of the four harness ids — and **that assertion was
widened** to cover the new file rather than exempting it. It used to read exactly
one path under a single hardcoded `"actana-sessions"`, so a second skill folder
was invisible to it; #303, landed in the same change as this record, replaced that
constant with `ORCHESTRATION_SKILL_NAMES`
(`packages/shared/src/orchestration-skill-payload.ts`) and made the assertion sweep
every shipped file of both folders.

**D4 — The home-directory footprint grows, and this record is where that is
decided.** 0031's consequences bound it at *"exactly two directories deep in two
roots: `~/.claude/skills/actana-sessions/` and `~/.agents/skills/actana-sessions/`
… Anything larger than that is a new decision"* (`0031-…:416-419`). Two things
here are larger:

- **A second folder in each root** — `~/.claude/skills/actana-subagent/` and
  `~/.agents/skills/actana-subagent/` — written, as 0031 D4 requires, only where
  the harness's own namespace already exists.
- **A folder carrying more than one file**: #304's multi-file installer puts
  `await.sh` beside `SKILL.md`.

Both are that new decision, and both are taken here. The bound is restated rather
than removed: **two folders in two roots, each carrying the files its own record
names.** Anything larger is again a new decision.

**D5 — D8's "authored once" mechanism is unchanged in kind, only in shape.** 0031
D8 authors one `SKILL.md` under `.agents/skills/` and has a generator embed it as
a string constant in both packages, because the daemon and the CLI write the
skill from two different processes on two different machines. That stays exactly
as it is. What changes is arity: **one authored source per skill**, each embedded
into the same two bundles, and all of them **held honest** by the one drift
test at `packages/shared/src/__tests__/orchestration-skill-fanout.test.ts` — which
covers both skills as of #303, landed in the same change as this record, and not a
second test standing beside it. No new mechanism, no second generator, no copy
in `dist/`.

## Consequences

- **0031 remains `PROPOSED` and untouched in its status line**, and
  [`0006-no-bundled-skills.md`](0006-no-bundled-skills.md) remains untouched
  entirely. 0031's own consequences make writing 0006's amendment note part of
  *0031's* ratification; this record adds nothing to 0006 and does not move that
  job.
- **If 0031 is ratified and this record is accepted** → both skills ship,
  installed into the two skill roots by #304's multi-file installer, exactly as
  #303 and #304 specify.
- **If 0031 is rejected at the beta gate** → nothing is installed into an
  operator's home. Both skills become **repo-local files** under
  `.agents/skills/`, the way [`release`](../../.agents/skills/release/SKILL.md)
  already is; the installer, the generator, the embedded payloads and the fan-out
  targets are dead machinery and are removed or left unbuilt. The report
  contract, `await.sh` and the two-role split are **unaffected** — they are a
  document and a shell script, and they work from a checkout.
- **If 0031 is ratified but this record is rejected** → `actana-sessions` is
  rewritten in place with the file report contract (#303 §1 and §6-8) and ships
  as today's single skill; `actana-subagent` does not ship, and the sub-agent
  instructions travel in the orchestrator's prompts instead. That is a materially
  worse product — an eager role delivered as prompt text is re-derived every
  turn — and it is the fallback, not the plan.
- **#303 and #304 do not ship until this record is accepted.** They say so in
  their own headers; this is the other half of that link.
