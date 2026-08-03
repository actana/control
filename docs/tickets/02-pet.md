# Tickets — Spec 02 (Remove Pet + multiplayer relay)

Parent spec: [`../specs/02-remove-pet.md`](../specs/02-remove-pet.md).

Five tickets. Ordered so each PR leaves `typecheck` and `test` green.

---

## AC-02-01 — Retire the `pets.agentsystem.dev` multiplayer relay

**Depends on:** —

**Summary.** Cut the outward wire before the pet is torn out. Delete
the presence-relay client, its protocol module, the `academy.ts` config
that maps to `wss://pets.agentsystem.dev`, and every direct call site.
Leaves the local pet renderable (still driven by `usePetController`) but
solo — `<RemotePets />` is gone and the WebSocket is never opened.

**Files touched (indicative).**
- Delete: `src/lib/pet/pet-multiplayer-client.ts`,
  `src/lib/pet/pet-multiplayer-messages.ts` (+ test),
  `src/lib/pet/use-pet-multiplayer.ts`,
  `src/lib/pet/__tests__/peer-anchors.test.ts` (peer-anchors module goes
  in AC-02-03 with the rest of `src/lib/pet/`; the test is scoped here
  because it exercises multiplayer behavior),
  `src/components/pet/RemotePets.tsx`,
  `src/shared/pet-multiplayer-protocol.ts`,
  `src/shared/academy.ts`.
- Modify: `src/components/pet/PetHost.tsx` — drop `<RemotePets />`
  render and the `usePetMultiplayer` call. `src/lib/pet/pet-store.ts` —
  remove the multiplayer subscribe/publish surface.

**Acceptance criteria.**
- `rg "pets\.agentsystem\.dev|VITE_MC_PETS_WS_URL|academyUrl|ACADEMY_BASE_URL"`
  returns zero hits.
- `rg "RemotePets|usePetMultiplayer|PET_ACCENT_IDS|PetAccentId|PET_WS_HEARTBEAT_MS"`
  returns zero hits.
- Local pet still renders and animates on `pnpm dev`.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** Sibling `../academy` repo hosts the relay service; its
decommission is tracked separately (out of scope here).

---

## AC-02-02 — Delete pet UI mount and settings surface

**Depends on:** AC-02-01

**Summary.** Remove the visible pet: the `PetHost` mount in
`__root.tsx`, the "Pet" settings panel, the `Icon.tsx` pet branch, and
the `z-index.pet` layer. Local pet library and shared modules still
exist after this ticket but are unmounted and unreachable from the UI.

**Files touched (indicative).**
- Delete: `src/components/pet/PetHost.tsx`,
  `src/components/pet/PetWidget.tsx`,
  `src/components/pet/PetSprite.tsx`,
  `src/components/pet/PetStatsCard.tsx`,
  `src/components/pet/PetGuideModal.tsx`,
  (delete `src/components/pet/` folder),
  `src/components/views/PetSettingsPage.tsx`.
- Modify: `src/routes/__root.tsx` (drop PetHost lazy, `<PetHost/>`
  mount, Toaster `offset` conditional, comment),
  `src/components/views/SettingsPanel.tsx` (drop panel entry + branch),
  `src/components/views/settings-panel-ids.ts` (drop `"pet"`),
  `src/components/ui/Icon.tsx` (drop `"pet"` case + union entry),
  `src/lib/z-index.ts` (drop `pet: 9500` + adjust neighbor comment).

**Acceptance criteria.**
- `rg "PetHost|PetWidget|PetSprite|PetGuide|PetStatsCard|PetSettingsPage"`
  returns zero hits.
- Settings panel opens; "Pet" tab absent; General/Theme/Terminal pages
  still render.
- `pnpm typecheck` and `pnpm test` green.

---

## AC-02-03 — Delete pet library, server plumbing, and `AppSettings` fields

**Summary.** The atomic core removal. `src/lib/pet/`, the pet
`AppSettings` fields, the pet code in `settings.controller.ts` and
`hooks.controller.ts`, the two pet `AppEvent` variants
(`agent:tool-used`, `agent:remark`), the pet shared modules, the
`installAgentHooks` `petEnabled` option, and the `pty-manager` bootstrap
flag all land in one ticket — the type surface only reconciles if they
land together.

**Depends on:** AC-02-02

**Files touched (indicative).**
- Delete: remainder of `src/lib/pet/` (`pet-store.ts` + test,
  `pet-lines.ts`, `pet-messages.ts` + test, `pet-sounds.ts`,
  `use-pet-controller.ts`, `use-dock-lift.ts`, `peer-anchors.ts`),
  `src/shared/pet.ts` (+ test), `src/shared/pet-remark.ts` (+ test),
  `src/shared/pet-tool-classify.ts` (+ test),
  `src/server/__tests__/pet-tool-hook-api.test.ts`.
- Modify: `src/lib/api.ts` (drop six pet fields from `AppSettings` +
  settings-update key union),
  `src/components/views/GeneralSettingsPage.tsx`,
  `src/components/views/ThemeSettingsPage.tsx`,
  `src/components/views/TerminalSettingsPage.tsx` (drop pet defaults +
  imports in all three),
  `src/server/events.ts` (drop `PetToolKind` import, drop
  `agent:tool-used` + `agent:remark` variants),
  `src/server/controllers/hooks.controller.ts` (drop pet-tool-classify
  + pet-remark plumbing, PostToolUse pet-only branch, Stop handler
  `emitPetRemark`, SessionStart `petIntro` contribution),
  `src/server/controllers/settings.controller.ts` (drop six pet keys +
  imports + zod schema entries + GET reads + PATCH branches +
  `getPetHomeSideSetting`),
  `src/shared/agent-hooks.ts` (drop `PET_TOOL_HOOK`, `petEnabled` opt,
  branch),
  `electron/pty-manager.ts` (drop `getBooleanAppSetting` pet_enabled
  read + `installAgentHooks` opts argument).

**Acceptance criteria.**
- `rg -w pet src electron` returns only unrelated false positives
  (`snippet`, `carpet`, `competing`).
- `rg "petEnabled|petMessagesEnabled|petSoundsEnabled|petMultiplayerEnabled|petHomeSide|petState|PET_TOOL_HOOK|classifyPetToolUse|extractPetRemark"`
  returns zero hits.
- `AppEvent` union in `src/server/events.ts` has no `agent:tool-used`
  or `agent:remark`.
- `pnpm typecheck` and `pnpm test` green (with pet cases removed from
  `settings-api.test.ts` and `agent-hooks-api.test.ts` per this ticket —
  see the parent spec's list).

**Notes.** The `<!-- pet: … -->` fixture in
`session-transcripts-last-assistant.test.ts` is swapped to a generic
marker in AC-02-04, so this ticket does not touch that file.

---

## AC-02-04 — Purge Mission Pet CSS, comments, and remaining test fixtures

**Depends on:** AC-02-03

**Summary.** Cleanup pass. Strips the `.mc-pet-*` block from
`src/styles.css`, prunes lingering pet mentions from comments across the
tree, updates the last surviving pet test fixture, and rewrites the
`repo-key.ts` file header to describe generic repo identity.

**Files touched (indicative).**
- Modify `src/styles.css` — delete the `Mission Pet` block (~500
  lines), the `data-power-save` / `data-window-idle` freeze rules, and
  the reduced-motion static override.
- Modify (comment prunes only): `src/queries/git.ts`, `src/lib/window-idle.ts`,
  `src/lib/user-terminal-store.tsx`, `src/lib/accent-colors.ts`,
  `src/server/services/projects.ts`, `src/server/services/prompts.ts`,
  `src/server/services/session-transcripts.ts`,
  `src/db/schema-bootstrap.ts`,
  `src/db/__tests__/reconcile-stale-sessions.test.ts`,
  `src/shared/repo-key.ts` (rewrite header),
  `src/shared/projects.ts` (docstring).
- Modify:
  `src/server/services/__tests__/session-transcripts-last-assistant.test.ts`
  — swap `<!-- pet: … -->` fixture for a generic marker.

**Acceptance criteria.**
- `rg "\.mc-pet|@keyframes mc-pet-|data-pet-"` on `src/styles.css`
  returns zero hits.
- `rg -i "mission pet|multiplayer pet|pets\.agentsystem"` returns zero
  hits.
- `pnpm typecheck` and `pnpm test` green.

---

## AC-02-05 — Schema-bootstrap: drop legacy `pet_*` app_settings rows

**Depends on:** AC-02-03

**Summary.** Add a one-shot idempotent boot-time cleanup that removes
the six `pet_*` rows from `app_settings`. Follows the fork convention
("we don't ship migration files to the user") — this is code in
`schema-bootstrap.ts`, not a numbered SQL file.

**Files touched (indicative).**
- Modify `src/db/schema-bootstrap.ts` — add a
  `dropLegacyPetSettings(sqlite)` helper that runs
  `DELETE FROM app_settings WHERE key LIKE 'pet\_%' ESCAPE '\';` and
  call it from `ensureSchema` (or `reconcileStaleSessionsOnBoot`).

**Acceptance criteria.**
- Booting the Panel against a pre-cutover SQLite (with `pet_enabled`,
  `pet_state`, etc. present) leaves zero rows matching
  `key LIKE 'pet\_%' ESCAPE '\'`.
- Booting the Panel against a fresh SQLite runs the DELETE without
  error and produces no rows.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** This cleanup block stays in the tree for one release, then
is removed by a follow-up ticket (tracked as AC-CLEANUP-01 in the
rebrand set).
