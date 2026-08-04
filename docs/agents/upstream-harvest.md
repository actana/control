# Upstream harvest

This repo forked AgentSystemLabs/mission-control at tag `v0.49.0` (SHA `8dff848`) and rewrote the PTY/harness layer into a detached Core process (see `CONTEXT.md`). Upstream is now a **read-only scouting target**, not a parent. Never merge, rebase, or blanket-cherry-pick from it.

## Where things live

- `docs/upstream/PROVENANCE.md` — file-level classification of every path vs upstream (UNTOUCHED / MODIFIED / NEW / REWRITTEN / REMOVED). The porting cost model — check this before deciding whether an upstream patch can apply.
- `docs/upstream/DIVERGENCE.md` — architectural axes with IDENTICAL / COMPATIBLE / INCOMPATIBLE verdicts. Names the seams (PTY/IPC files) where upstream patches will never apply.
- `docs/upstream/BACKLOG.md` — per-item decision table for upstream commits since the last review. Sorted by priority.
- `docs/upstream/WATERMARK` — last-reviewed upstream SHA + date. The re-review cursor.

## How to run a re-review

1. Add upstream as a read-only remote if absent: `git remote add upstream https://github.com/AgentSystemLabs/mission-control && git fetch upstream`.
2. `git log $(awk '{print $4}' docs/upstream/WATERMARK)..upstream/main --oneline` — list new upstream commits.
3. For each: check touched files against `PROVENANCE.md` class.
   - UNTOUCHED file → PORT candidate (cherry-pick, expect clean).
   - MODIFIED file → ADAPT (rework against our version).
   - REWRITTEN seam (PTY / IPC — see `DIVERGENCE.md`) → REIMPLEMENT or SKIP.
4. Never cherry-pick `pnpm-lock.yaml` or `src/routeTree.gen.ts` — regenerate.
5. Update `WATERMARK` with the new upstream SHA + today's date.

## Invariants worth preserving for cheap porting

- **Singular UI** (see ADR 0005): keep threading `coreId` into existing upstream components rather than restructuring them. This is what keeps ~906 files in the clean-porting zone.
- **Additive-only schema**: append new tables to `src/db/schema.ts` (like `event_log`), never mutate upstream tables' shape, so their migrations rebase trivially.

## Attribution

Upstream is MIT; we keep MIT (`package.json:5`). ~96% of tracked files are byte-identical upstream code — any relicensing decision must treat everything except `docs/upstream/NEW` files as upstream-derived.
