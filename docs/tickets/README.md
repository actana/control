# Actana Control — Tickets

Each spec in [`../specs/`](../specs) breaks down into a set of tickets in a
per-spec file here. A ticket is a commit-sized unit: one PR, one reviewer
pass, one deploy-safe merge. Tickets carry acceptance criteria and
dependencies, not implementation notes — those live in the parent spec.

## Convention

- File name mirrors the spec: `02-pet.md` implements
  [spec 02](../specs/02-remove-pet.md).
- Ticket IDs are `AC-<spec>-<n>`, zero-padded within the spec
  (e.g. `AC-02-01`).
- Each ticket lists: **Summary**, **Depends on**, **Files touched
  (indicative)**, **Acceptance criteria**, and (optional) **Notes**.
- "Depends on: —" means no in-spec dependency; cross-spec dependencies use
  the fully-qualified ID.

## Execution order (recommended)

1. **Pet** (spec 02) — most self-contained; establishes the removal
   pattern (deletes + schema-bootstrap DELETE + `AppSettings` prune).
2. **Whisper** (spec 01) — voice/STT + macOS entitlements.
3. **Recall + memory** (spec 04) — largest surface; brings the WASM /
   tree-sitter / MCP purge with it.
4. **Screenshot** (spec 03) — depends on Whisper only in that both touch
   Info.plist entitlements; sequencing after Whisper avoids a merge.
5. **Convenience** (spec 07) — ScratchPad, custom scripts, prompt palette.
6. **IDE-adjacent** (spec 06) — file editor/finder, HTML preview,
   annotations.
7. **Bundled skills** (spec 05, ADR 0006) — after the individual features
   that reference the skill dirs are already out.
8. **Cross-core notifications** (spec 08) — the one *add* ticket set.
   Depends only on the retained event-stream surface.
9. **Rebrand + auto-update disable** (spec 09) — last; renames the
   package/host/appId once the removal noise is out of the diff.

## Cross-spec conventions

- **Schema-bootstrap seam.** All `app_settings` cleanup lands as
  idempotent boot-time `DELETE`s in `src/db/schema-bootstrap.ts`. No
  versioned SQL migrations. Cleanup blocks stay in the tree for one
  release, then are removed by a separate follow-up ticket.
- **AppSettings type.** Every removal that drops a field prunes
  `AppSettings` in `src/lib/api.ts` **and** the settings-update key union
  in the same PR — otherwise typecheck fails.
- **Verification.** Every ticket ends with the same three checks:
  - `pnpm typecheck` (or `npm run typecheck`) green
  - `pnpm test` green
  - the spec's `rg` verification lines all return zero hits
