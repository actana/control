# Architecture decisions

Numbered, immutable-once-landed records of why the system is shaped the way it
is. If a change contradicts one, say so in the pull request rather than routing
around it. The index with one-line summaries is in
[`../README.md`](../README.md#architecture-decisions).

New ADRs take the next free number and follow the existing shape — context,
the numbered decisions, consequences.

## Two files claim 0018, and neither is renumbered

```
0018-docker-hub-is-the-only-registry.md
0018-the-task-mutation-frame-carries-delete.md
```

This is a pre-existing collision, not undiscovered breakage, and it is written
down here so the next reader does not spend an afternoon deciding which one is
"real". **Both are.** They landed independently, each took the number that was
free when its author looked, and the clash was noticed afterwards.

**Do not renumber either of them.** Every citation in the CI files and the
workflow comments — `ADR 0018`, "Docker Hub is the only registry", "GHCR was
retired" — points at the *registry* one, and renumbering it would silently
invalidate all of them. The other is cited from the core-link and task-frame
code. Renumbering is the change that looks tidy and breaks every reference at
once; a note is the change that costs nothing.

When you cite 0018, cite it by file name or by title rather than by number
alone.

## Two clauses of ADR 0023 are numbered D38

The same shape, one level down.
[`0023-release-trains-and-digest-promotion.md`](0023-release-trains-and-digest-promotion.md)
has **D38 — the delete-capable credential** (in §E, amended by #112) and
**D38 — One check name, four behaviours** immediately after it. Both are cited
from the workflows, from `scripts/lib/dev-tag-sweep.mjs`, and from open
tickets, so neither moves. Citations inside that ADR name which one they mean
in italics; do the same in new prose.

That ADR's clause list also runs to **D45**, not D44: D45 is the `-dev` tag
sweep, added after the fact because D10 and the sweep's own modules were
citing a sweep clause that had never been written — they pointed at D33, which
as committed is about exempt image jobs. The citations were corrected to name
D45. Nothing was renumbered then either, and the same rule applies next time:
**append a clause, never shift one.** Every ticket in the effort cites these
numbers.
