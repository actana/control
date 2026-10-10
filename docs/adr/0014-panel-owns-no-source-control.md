# The Panel owns no source-control surface

> **Status: ACCEPTED.** Recorded by [ADR 0016](0016-the-0-1-0-shape.md) D44 (the number) and D46 (promotion K1). Tracked in [#53](https://github.com/actana/control/issues/53).

Git and worktrees left the Panel on purpose, and this ADR is the forward constraint that keeps them out. The removal itself was already recorded in code: `dropLegacyWorktreeSchema()` in `packages/shared/src/schema-bootstrap.ts`, with its test `packages/panel/src/db/__tests__/drop-legacy-worktree-schema.test.ts`, drops the worktree and git columns and tables from a pre-removal database. Both files were later deleted with the Panel's own SQLite in 0.5.0 (ADR 0041). The written rationale, a spec on removing worktrees and git, was deleted with the rest of the historical record and is not linked here. What it held, and nothing else did, was the decision that the door stays shut. Without a record, nothing stops the next contributor adding a branch chip.

## Decision

**The Panel owns no source-control surface.** It has no git probe, no worktree concept, no diff view, no branch or commit display, and no field on a Task or Session that models a repository.

- **D1 — Source-control decisions belong to the tool on the machine hosting the Core, not to a remote control.** Which branch, which worktree, when to commit and what to push are decided where the code lives, by the Harness and the operator's own git. The Panel is a remote control (see the non-goals in [`domain-model.md`](../domain-model.md)); a remote control that second-guesses the machine's git is a second, weaker source-control client.
- **D2 — A Harness may run `git` inside a Session, and that is the Harness's concern.** This decision removes the Panel's _visibility_ of git. It does not constrain the Harness, does not forbid a Harness from branching, committing or using worktrees, and does not make the Core filter or rewrite what a Harness does. The Panel simply does not look.

## Re-entry conditions

Exactly two doors remain, D3 and D4, and each has one shape.

- **D3 — A "session is on branch X" pill** may return only as a **session-metadata string reported by the Core over the core-link**, rendered as opaque text like any other Session metadata. It is never a Panel-owned git probe: the Panel does not run git, read a `.git` directory, resolve a ref, or compute a diff.
- **D4 — Branch routing**, if it is ever needed, belongs in the **session-spawn contract** (the request the Panel sends the Core to start a Session), where the Core acts on it. It does not belong on the Panel's Task row, which stays free of repository fields.

Anything beyond these two needs a new ADR that supersedes this one.

## Consequences

- The "Not a source-control UI" non-goal is added to [`domain-model.md`](../domain-model.md), and worktree, git diff and branch join its "What is no longer in the domain" list. If a vocabulary page replaces that file (ADR 0016 D42), both rows carry over.
- A change that adds a git field to a Task or Session row, a Panel-side git call, or a branch chip fed by anything other than a Core-reported string is a violation of this ADR and should be rejected in review.
- Nothing changes for operators: Harnesses keep using git exactly as before.
