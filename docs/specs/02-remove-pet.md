# Spec 02 — Remove Pet (Tamagotchi mascot + multiplayer relay)

## Overview

Rip out the Mission Pet — the corner Tamagotchi-style companion (species,
XP, prestige/molt, personality drift, chirp sounds, guide modal, settings
page) and the `wss://pets.agentsystem.dev` "multiplayer pets" presence relay
it broadcasts to. Scope-narrowing per ADR 0007: Actana Control is a harness
remote control, not a lifestyle app.

## Files to delete

### Renderer — pet cluster

- `src/components/pet/PetHost.tsx`
- `src/components/pet/PetWidget.tsx`
- `src/components/pet/PetSprite.tsx`
- `src/components/pet/PetStatsCard.tsx`
- `src/components/pet/PetGuideModal.tsx`
- `src/components/pet/RemotePets.tsx`
- (delete the whole `src/components/pet/` directory)
- `src/components/views/PetSettingsPage.tsx`

### Renderer — pet library

- `src/lib/pet/pet-store.ts`
- `src/lib/pet/pet-store.test.ts`
- `src/lib/pet/pet-lines.ts`
- `src/lib/pet/pet-messages.ts`
- `src/lib/pet/pet-messages.test.ts`
- `src/lib/pet/pet-sounds.ts`
- `src/lib/pet/use-pet-controller.ts`
- `src/lib/pet/use-pet-multiplayer.ts`
- `src/lib/pet/use-dock-lift.ts`
- `src/lib/pet/peer-anchors.ts`
- `src/lib/pet/__tests__/peer-anchors.test.ts`
- `src/lib/pet/pet-multiplayer-client.ts`
- `src/lib/pet/pet-multiplayer-messages.ts`
- `src/lib/pet/__tests__/pet-multiplayer-messages.test.ts`
- (delete the whole `src/lib/pet/` directory)

### Shared

- `src/shared/pet.ts`
- `src/shared/__tests__/pet.test.ts`
- `src/shared/pet-remark.ts`
- `src/shared/__tests__/pet-remark.test.ts`
- `src/shared/pet-tool-classify.ts`
- `src/shared/__tests__/pet-tool-classify.test.ts`
- `src/shared/pet-multiplayer-protocol.ts`
- `src/shared/academy.ts` — delete outright; `ACADEMY_BASE_URL`, `academyUrl`,
  and `petsWebSocketUrl` are all academy/pet-only, and no non-pet consumer
  references them (grep-verified).

### Tests

- `src/server/__tests__/pet-tool-hook-api.test.ts`

### Electron / audio assets

- None. `electron/` has no pet-only file. Pet chirps are WebAudio-synthesized
  in `pet-sounds.ts` — no MP3/OGG/WAV to remove from `public/audio/`.

## Files to modify

### `src/routes/__root.tsx`

- Drop `import { DEFAULT_PET_HOME_SIDE } from "~/shared/pet";` (line 33).
- Drop `const PetHost = lazy(() => import("~/components/pet/PetHost"));` and its
  comment block (lines 102–106).
- Delete the `<PetHost />` mount and its wrapping `Suspense` (around line
  260–270; the sibling-of-Shell block).
- Simplify the `<Toaster>` `offset` prop to a plain `16` — remove the
  `settings?.petEnabled` / `settings?.petHomeSide` conditional (lines
  ~994–1002) and the surrounding comment.
- Delete the "PetWidget + RemotePets render via the lazy PetHost" comment.

### `src/lib/api.ts`

- Drop `import type { PetHomeSide, PetPersistentState } from "~/shared/pet";`.
- Delete the `petEnabled` / `petMessagesEnabled` / `petSoundsEnabled` /
  `petMultiplayerEnabled` / `petHomeSide` / `petState` fields from the
  `AppSettings` type and the corresponding entries from the settings-update
  key union (both blocks around lines 251–265 and 783–788).

### `src/components/views/SettingsPanel.tsx`

- Drop `import { PetSettingsPage } from "./PetSettingsPage";`.
- Remove the `{ id: "pet", label: "Pet", icon: "pet" }` entry from the panels
  list (~line 96).
- Delete the `activePanel === "pet" ? <PetSettingsPage />` branch (~line 334).

### `src/components/views/settings-panel-ids.ts`

- Remove `"pet"` from `SETTINGS_PANEL_IDS`.
- Update the file header comment (drop the "and the pet cluster" aside).

### `src/components/views/GeneralSettingsPage.tsx`

- Drop `import { DEFAULT_PET_HOME_SIDE } from "~/shared/pet";`.
- Delete the six `petEnabled` / `petMessagesEnabled` / `petSoundsEnabled` /
  `petMultiplayerEnabled` / `petHomeSide` / `petState` defaults from the
  settings-form initializer (~lines 173–178).

### `src/components/views/ThemeSettingsPage.tsx`

- Drop `import { DEFAULT_PET_HOME_SIDE } from "~/shared/pet";`.
- Delete the same six pet defaults from the form initializer (~lines 177–182).

### `src/components/views/TerminalSettingsPage.tsx`

- Drop `import { DEFAULT_PET_HOME_SIDE } from "~/shared/pet";`.
- Delete the same six pet defaults (~lines 237–242).

### `src/components/ui/Icon.tsx`

- Remove `"pet"` from the icon-name union (~line 38).
- Remove the `case "pet":` branch and its Mochi-blob SVG return (~line 260).

### `src/lib/z-index.ts`

- Delete the `pet: 9500` layer and its comment.
- Trim the "above the pet" phrasing from the neighboring comment on the
  settings/modals layer.

### `src/lib/window-idle.ts`

- Strip the Mission Pet sprite mention from the top-of-file comment.

### `src/lib/user-terminal-store.tsx`

- Trim the pet desktop-overlay-window parenthetical from the comment at
  line ~808.

### `src/lib/accent-colors.ts`

- Rework the comment on `accentCssVars` (line ~97) to describe generic
  accent-tinted subtree usage, not the pet remote-peer scenario.

### `src/lib/keybindings/store.tsx`, `defaults.ts`, `groups.ts`, `types.ts`

- No changes. Grep confirms zero pet keybinding entries.

### `src/queries/git.ts`

- Trim the two "Mission Pet MutationCache" comments (lines ~114, ~179) to
  describe the MutationCache mechanism without the pet reference.

### `src/server/events.ts`

- Drop `import type { PetToolKind } from "~/shared/pet-tool-classify";`.
- Delete both event variants from the `AppEvent` union:
  - `agent:tool-used` (mid-run PostToolUse mirror; pet-only consumer).
  - `agent:remark` (Claude's `<!-- pet: … -->` cue).

### `src/server/controllers/hooks.controller.ts`

- Drop the two shared-module imports (`pet-tool-classify`, `pet-remark`).
- Delete the `PET_ENABLED_KEY` / `PET_STATE_KEY` constants and the
  `petName()` helper.
- Delete the last-remark-per-task map, `emitPetRemark`, `buildPetRemarkIntro`,
  and `petIntroSentSessions` cap.
- In the PostToolUse handler, remove the `classifyPetToolUse` /
  `petToolSentiment` block that emits `events.emit("agent:tool-used", …)`
  along with its rate-limit map.
- In the Stop handler, remove the `emitPetRemark(...)` call.
- In the SessionStart / additionalContext builder, remove the `petIntro`
  contribution to `additionalContext`.
- Rewrite the top-of-file "PostToolUse for the Mission Pet" block comment
  down to the AskUserQuestion-only rationale.

### `src/server/controllers/settings.controller.ts`

- Drop pet imports from `~/shared/pet`
  (`isPetHomeSide`, `mergePetStateWrite`, `normalizePetState`,
  `PET_HOME_SIDE_IDS`, `DEFAULT_PET_HOME_SIDE`, `type PetHomeSide`).
- Delete constants: `PET_ENABLED_KEY`, `PET_MESSAGES_ENABLED_KEY`,
  `PET_SOUNDS_ENABLED_KEY`, `PET_MULTIPLAYER_ENABLED_KEY`, `PET_HOME_SIDE_KEY`,
  `PET_STATE_KEY`.
- Remove the six pet fields from the settings zod schema (~lines 319–327).
- Remove the six pet reads from the GET response builder (~lines 623–628).
- Remove `getPetHomeSideSetting()`.
- Remove all six pet write branches from the PATCH handler (~lines 929–954),
  including the merge-vs-null petState path.

### `src/server/services/projects.ts`

- Update the two comments (~lines 245, 109) to drop the "multiplayer pets"
  justification for the `repoKey` field on the list endpoint. `repoKey` itself
  stays — it's the shared repo identity used elsewhere. Verify no other
  consumer disappears with the pet.

### `src/server/services/prompts.ts`

- Trim the pet reference from the `prompt:submitted` SSE emit comment
  (~line 54).

### `src/server/services/session-transcripts.ts`

- Trim the "not worth scanning for a pet" phrasing from the comment at
  line ~89.

### `src/server/services/__tests__/session-transcripts-last-assistant.test.ts`

- Replace the `<!-- pet: … -->` fixture text with a generic marker so the test
  still exercises the "last assistant text" walker without pretending pet cues
  exist.

### `src/shared/agent-hooks.ts`

- Delete `PET_TOOL_HOOK` (`PostToolUse` Bash|Write|Edit).
- Drop the `opts?: { petEnabled?: boolean }` parameter from
  `installAgentHooks(...)`.
- Drop the `agent === "claude-code" && opts?.petEnabled ? […PET_TOOL_HOOK]`
  branch — hooks now always equal `spec.events`.
- Trim the accompanying block comment.

### `src/shared/repo-key.ts`

- Rewrite the file header ("Repo identity for the multiplayer-pets feature.")
  to describe the generic repoKey mechanism. Keep the module — repoKey is
  broadly useful and appears on task snapshots.

### `src/shared/projects.ts`

- Update the `repoKey` docstring (line ~9) to drop the "used by the
  multiplayer-pets feature" note.

### `src/queries/index.ts`

- Line ~386 comment mentions polling; check that adjacent text does not
  reference the pet — grep clean, no change needed.

### `src/routes/projects.$id.tsx`

- Line 2965 references "Ship" only; false positive on the grep. No change.

### `src/db/schema-bootstrap.ts`

- Trim the pet mention from the `reconcileStaleSessionsOnBoot` docstring
  (line ~232).

### `src/db/__tests__/reconcile-stale-sessions.test.ts`

- Trim the "pet alerting forever" phrasing from the test comment (line 36).

### `electron/pty-manager.ts`

- Drop `const petEnabled = getBooleanAppSetting(userDataDir, "pet_enabled", true);`.
- Change the `installAgentHooks(...)` call from
  `installAgentHooks(opts.agent, plan.cwd, undefined, { petEnabled })` to
  `installAgentHooks(opts.agent, plan.cwd)`.

### `src/styles.css`

- Delete the entire `/* ===================== Mission Pet ===================== */`
  block (starts ~line 4347, roughly 500 lines of `.mc-pet-*` rules, keyframes
  `mc-pet-breathe`, `mc-pet-blink`, `mc-pet-sway`, `mc-pet-sparkle`, `zzz`, and
  the ember/press-and-hold sub-sections).
- Remove the `html[data-power-save] .mc-pet, .mc-pet *` and
  `html[data-window-idle] .mc-pet, .mc-pet *` freeze rules (~lines 1242, 1256).
- Remove the reduced-motion `.mc-pet, .mc-pet *` static override (~line 1264).

### `src/server/__tests__/settings-api.test.ts`

- Drop the eleven `pet*` cases (search for `petEnabled`, `petState`,
  `petHomeSide`, `petMultiplayerEnabled`). Retain the general settings-panel
  round-trip cases that don't reference pet fields.

### `src/server/__tests__/agent-hooks-api.test.ts`

- Drop the four `setBooleanSetting("pet_enabled", …)` setup lines (they
  were preconditioning the pet-tool hook). The `PET_TOOL_HOOK` merge check
  is covered by the deleted `pet-tool-hook-api.test.ts`, so the remaining
  assertions in this file (AskUserQuestion + core matcher merge) don't need
  the flag flip.

## Schema changes

There are no dedicated pet columns or tables. All pet persistence lives as
key/value rows in `app_settings` (`electron/app-settings-store.ts`), keyed by:

- `pet_enabled` (boolean)
- `pet_messages_enabled` (boolean)
- `pet_sounds_enabled` (boolean)
- `pet_multiplayer_enabled` (boolean)
- `pet_home_side` (`'left' | 'right'`)
- `pet_state` (JSON blob — `PetPersistentState`: name, species, size, xp,
  level, prestige, personality[base|drift|effective], lifetime + weekly stats,
  projectXp, createdAt)

No task/settings/project columns to drop. No pet-only tables to drop.

## Migration

Because Actana Control is inline-bootstrapped via `ensureSchema()` (see
`src/db/schema-bootstrap.ts` — "we don't ship migration files to the user"),
the forward migration is a one-shot delete-on-boot, not a versioned SQL file.
Add to schema-bootstrap:

```sql
-- Runs unconditionally on every boot for one release, then removed.
DELETE FROM app_settings WHERE key LIKE 'pet\_%' ESCAPE '\';
```

Wrap it in a small `dropLegacyPetSettings(sqlite)` function called from
`ensureSchema` (or `reconcileStaleSessionsOnBoot`). No ALTER TABLE needed.
If/when a versioned migrations table is added later, this deletion can be
promoted to `NNNN_remove_pet.sql`; for now the idempotent boot-time cleanup
is the mechanism.

## Multiplayer relay

The `wss://pets.agentsystem.dev` presence relay is a first-class casualty of
this removal:

- `src/shared/pet-multiplayer-protocol.ts` — deleted (message shapes,
  `PetPeer`, `PET_ACCENT_IDS`, `PetAccentId`, `PET_WS_HEARTBEAT_MS`,
  `PET_WS_PEER_TTL_MS`).
- `src/lib/pet/pet-multiplayer-client.ts` — deleted (singleton WebSocket
  client, rosters, desired state, presence broadcaster).
- `src/lib/pet/pet-multiplayer-messages.ts` + its test — deleted.
- `src/lib/pet/use-pet-multiplayer.ts` — deleted (React hook wiring the
  local pet + repo rooms into the client).
- `src/components/pet/RemotePets.tsx` — deleted (overlay rendering peer
  sprites via `accentCssVars(peer.accent)`).
- `src/shared/academy.ts` — deleted outright: only exports are
  `ACADEMY_BASE_URL`, `academyUrl`, and `petsWebSocketUrl`; grep confirms no
  non-pet consumer of `academyUrl` or `ACADEMY_BASE_URL` in the source tree.
- `VITE_MC_PETS_WS_URL` env var — no longer read anywhere; remove from any
  `.env.example` (none present in repo today, so nothing to prune).
- `repoKey` on the projects list endpoint (`src/server/services/projects.ts`)
  stays as-is — the field itself is generic repo identity; only the "used by
  multiplayer pets" justification comment goes.

## Package.json edits

- No pet-specific dependencies exist. Pet chirps are pure WebAudio;
  animations are pure CSS. Sprites are inline SVG. Grep confirms no
  `tamagotchi`, no dedicated sprite/animation lib for pet.
- `build.extraResources` — pet does not contribute entries; leave as-is
  (`resources/whisper`, `dist/bundled-mcp`).
- No script entries (`pets:ws` etc.) to remove — that command lives in the
  sibling `../academy` repo, not here.

## Env vars / IPC channels

- `VITE_MC_PETS_WS_URL` — removed (only reader was `academy.ts`).
- No pet-related IPC handlers in `electron/ipc-channels.ts` (grep clean).
- No pet event types on the core-link (`src/shared/core-link-frames.ts`
  grep clean — pet events lived only on the internal in-process SSE bus).
- Delete the two internal `AppEvent` variants (`agent:tool-used`,
  `agent:remark`) from `src/server/events.ts` — see "Files to modify". Any
  SSE consumer on the renderer that subscribed to these must be removed
  alongside the pet controller (all such consumers live in `src/lib/pet/`,
  so they go with the folder).

## Keybindings

- `src/lib/keybindings/defaults.ts` — no pet entries (grep clean).
- `src/lib/keybindings/groups.ts` — no pet entries.
- `src/lib/keybindings/types.ts` — no pet entries.

No keybinding changes required.

## Tests to remove

- `src/server/__tests__/pet-tool-hook-api.test.ts`
- `src/shared/__tests__/pet.test.ts`
- `src/shared/__tests__/pet-remark.test.ts`
- `src/shared/__tests__/pet-tool-classify.test.ts`
- `src/lib/pet/pet-store.test.ts`
- `src/lib/pet/pet-messages.test.ts`
- `src/lib/pet/__tests__/peer-anchors.test.ts`
- `src/lib/pet/__tests__/pet-multiplayer-messages.test.ts`

Also strip pet sections from (kept files):

- `src/server/__tests__/settings-api.test.ts` — eleven pet round-trip cases.
- `src/server/__tests__/agent-hooks-api.test.ts` — four
  `setBooleanSetting("pet_enabled", …)` preconditions.
- `src/server/services/__tests__/session-transcripts-last-assistant.test.ts`
  — swap the `<!-- pet: … -->` fixture text for a generic marker.

## Verification checklist

- `rg -i "pet|tamagotchi|mascot" src electron public` returns only unrelated
  hits (verify: `carpet`, `competing`, `snippet`, `PetName` false positives
  do not exist — grep with `-w` on `pet` for a stricter pass).
- `rg "pets\.agentsystem\.dev|VITE_MC_PETS_WS_URL|academyUrl|ACADEMY_BASE_URL"`
  returns zero hits.
- `rg "petEnabled|petMessagesEnabled|petSoundsEnabled|petMultiplayerEnabled|petHomeSide|petState|petSpecies|petXp|petName|petAccentColorId"`
  returns zero hits.
- `rg "PetHost|PetWidget|PetSprite|PetGuide|PetStatsCard|RemotePets|usePetController|usePetMultiplayer|petTool|petPresence|PET_TOOL_HOOK|classifyPetToolUse|extractPetRemark"`
  returns zero hits.
- `AppSettings` in `src/lib/api.ts` contains no `pet*` field, and the
  settings-update key union has no pet keys.
- `npm run build` and `npm run typecheck` succeed. Vitest passes with the
  test-removal set applied.
- `.mc-pet*` selectors and `@keyframes mc-pet-*` are absent from
  `src/styles.css`; no orphan `data-pet-*` attributes or `z-index.pet`
  references remain.
- Boot cleanup runs: a fresh DB from a pre-cutover install boots without
  error, and `SELECT key FROM app_settings WHERE key LIKE 'pet\_%' ESCAPE '\'`
  returns zero rows after the first launch.
- Settings panel opens without a "Pet" tab; General/Theme/Terminal settings
  pages hydrate without touching pet defaults.

## Follow-ups / out of scope

- **PostToolUse hook mechanism.** The mid-run `Bash|Write|Edit` PostToolUse
  hook is pet-only today. If any future feature (fine-grained agent
  telemetry, budget tracking, per-tool analytics) wants a mid-turn signal,
  it will need to re-introduce a general-purpose hook — do not preserve the
  pet plumbing "just in case."
- **`<!-- pet: … -->` remark channel.** Deleted with `pet-remark.ts`. If a
  future "agent aside" or "sub-line" mechanism is desired, design it
  ubiquitous-language-first rather than resurrecting the pet cue.
- **`repoKey` on projects list endpoint.** Verify no other consumer relies
  on it before the next cleanup pass. If none, `repoKey` becomes a candidate
  for its own removal spec — but not this one.
- **Ephemera in `docs/`.** `docs/refactor-plan.md` and `docs/adr/*.md` may
  reference the pet; audit and prune references in a separate docs pass
  (do not block this spec on it).
- **Sibling `../academy` repo.** The relay service (`academy/pets-ws`) and
  its Railway deployment are out of scope for this repo's spec, but should
  be decommissioned on the Actana Control cutover date so the endpoint stops
  accepting traffic.
- **`accent-colors.ts`.** The `accentCssVars` helper stays. Its only
  documented caller was the pet remote-peer overlay; if no future feature
  needs per-subtree accent scoping, it becomes dead code and a candidate for
  a subsequent cleanup.
