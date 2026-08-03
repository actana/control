# Upstream Backlog since BASE (8dff848 / v0.49.0) — reviewed 2026-07-30

> **Scope-narrowing note.** Actana Control removal specs
> ([`docs/specs/`](../specs)) affect this backlog only indirectly: none
> of the tracked dependabot bumps touch a feature marked for removal.
> Codemirror bumps remain relevant (editor stays via GitDiffView).
> Once removal PRs land, re-run the per-item file classification against
> the updated PROVENANCE.md before adapting.


**Upstream `main` has 0 commits since BASE.** We forked at the v0.49.0 release (tag `v0.49.0` peels to `8dff848`, which is also `origin/main` — evidence: upstream clone `.git/packed-refs:10,201-202`). No new tags/releases exist. There is therefore no merged upstream work to harvest yet.

The only upstream work-in-flight is **8 open dependabot branches** (unmerged proposals; SHAs from `.git/packed-refs:2-9`). GitHub PR/issue metadata was unavailable in this review (no authenticated `gh`, shell outage) — whether any bump is security-motivated is UNKNOWN; resolve with `gh api repos/AgentSystemLabs/mission-control/dependabot/alerts` or `pnpm audit`.

Class of files each item touches: all DEPS-BUILD; workflows are MODIFIED-additive in OURS (our extra smoke steps don't overlap the pinned `uses:` lines), `package.json`/`pnpm-lock.yaml` are MODIFIED (lockfile has hard-diverged — we added `selfsigned`).

**Why ADAPT everywhere instead of PORT/cherry-pick:**
- npm bumps: a cherry-pick will always conflict on `pnpm-lock.yaml` (generated, diverged). Re-resolve locally instead: `pnpm up <pkg>@<version>` + `pnpm typecheck && pnpm test`.
- Actions bumps: a cherry-pick would update only upstream's jobs; our added jobs (`smoke-crossbuild-linux-*` in release.yml:288-393) pin the same actions and would silently stay stale. Apply as a repo-wide pin replacement across both workflow files instead.

Sorted by priority (P1 high). Current versions cited from OURS package.json / workflow pins.

| P | Item (dependabot branch) | Tip SHA | Change | Files touched | Decision | Effort | Risk to invariants |
|---|---|---|---|---|---|---|---|
| P1 | `npm_and_yarn/ignore-7.0.6` | `b8ba8a9` | ignore 7.0.5 → 7.0.6 (patch) | package.json, lockfile | **ADAPT** — `pnpm up ignore@7.0.6` | S | None (file-ignore util) |
| P1 | `npm_and_yarn/tailwindcss/vite-4.3.2` | `c937fac` | @tailwindcss/vite 4.3.0 → 4.3.2 (patch) | package.json, lockfile | **ADAPT** — bump + visual sanity pass | S | None |
| P1 | `npm_and_yarn/codemirror/state-6.7.1` | `c6510ca` | @codemirror/state 6.7.0 → 6.7.1 (patch) | package.json, lockfile | **ADAPT** — bump both codemirror patches together | S | None (editor untouched by rewrite) |
| P1 | `npm_and_yarn/codemirror/language-6.12.4` | `69a6264` | @codemirror/language 6.12.3 → 6.12.4 (patch) | package.json, lockfile | **ADAPT** — with the above | S | None |
| P2 | `github_actions/actions/checkout-7.0.1` | `40e9a17` | checkout v7.0.0 → v7.0.1 (patch) | ci.yml, release.yml | **ADAPT** — replace pinned SHA `9c091bb2…` everywhere incl. our smoke jobs | S | None (CI-only) |
| P3 | `github_actions/actions/setup-node-7.0.0` | `a4899d7` | setup-node v6.4.0 → v7.0.0 (major) | ci.yml, release.yml | **WATCH** — trigger: upstream merges it (their CI validates the major) | S | Low (CI-only, reversible) |
| P3 | `github_actions/actions/setup-python-7.0.0` | `4b06c8d` | setup-python v6 → v7.0.0 (major) | ci.yml, release.yml | **WATCH** — same trigger; only guards node-gyp distutils pin | S | Low |
| P4 | `npm_and_yarn/tanstack/react-router-1.170.18` | `15687fe` | @tanstack/react-router 1.169.2 → 1.170.18 (minor, big jump) | package.json, lockfile | **WATCH** — trigger: upstream merges it, then ADAPT bumping the whole tanstack set (`react-router-with-query`, `react-start`, `router-plugin`) together, regenerate routes (`pnpm generate:routes`), typecheck | M | Medium: we added `/fleet` route + Core provider in `__root.tsx`; router regressions hit the whole shell |

SECURITY items: **none identified** in the available data. This is a statement about visibility, not safety — see UNKNOWN above. No item was SKIPped.

Categories with zero upstream items since BASE: SECURITY, BUGFIX, UI-VISUAL, FEATURE, DOCS, INTERNAL-REFACTOR.

## Re-review procedure (repeat cheaply)
1. `git -C ../mission-control fetch origin` (or fetch upstream directly from OURS: `git remote add upstream https://github.com/AgentSystemLabs/mission-control && git fetch upstream`).
2. `git log <watermark SHA>..upstream/main --oneline` (currently `git log 8dff848..upstream/main --oneline`).
3. For each new commit: check its touched files against PROVENANCE.md class. UNTOUCHED → PORT candidate (cherry-pick). MODIFIED → ADAPT. PTY/IPC seam files (DIVERGENCE.md) → REIMPLEMENT or SKIP.
4. Never cherry-pick `pnpm-lock.yaml` or `src/routeTree.gen.ts`; regenerate both.
5. Update WATERMARK.
