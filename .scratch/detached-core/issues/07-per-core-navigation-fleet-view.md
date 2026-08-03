# 07 — Per-Core navigation + Fleet view (fan-out dashboard)

**What to build:** The Panel's primary navigation becomes per-Core: pick a Core → it lists its Projects (paths on that VM, returned live by the Harness) → open a Project → see its Tasks/Terminals, every step a live query to the chosen Core with no local persistence. On top of that, a Fleet view fans out `tasks.list` calls to every connected Core in parallel and merges results keyed by `coreId/taskId` for a unified dashboard. An offline Core shows as "unreachable + last-seen timestamp" with no task rows — the Panel caches nothing beyond the Core registry, so a downed Core is honestly blank, not stale. The Fleet view degenerates to per-Core navigation when only one Core is registered.

**Blocked by:** 03 — needs the Core registry to know which Cores to fan out to. 04 — needs remote Cores to be dialable for a real multi-Core fleet.

**Status:** ready-for-agent

- [ ] Per-Core navigation: pick a Core → its Projects → a Project → its Tasks/Terminals, each step a live query with no Panel-side persistence.
- [ ] A Fleet view fans out `tasks.list` to every connected Core in parallel and merges results by `coreId/taskId`.
- [ ] An offline/unreachable Core shows "unreachable + last-seen" with blank task rows (no cached labels or state).
- [ ] With a single registered Core, the Fleet view degenerates to per-Core navigation.
- [ ] Clicking a Fleet row switches the Panel's context to that Core/Project.
