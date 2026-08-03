# Tickets — Spec 01 (Remove Whisper / voice control)

Parent spec: [`../specs/01-remove-whisper.md`](../specs/01-remove-whisper.md).

Five tickets. Ordered so each PR leaves `typecheck` and `test` green.
Mirrors the shape used by [`02-pet.md`](./02-pet.md): outward-facing
callers first, then the atomic core (types + controllers + shared),
then cleanup and forward-migration boot-time cleanup.

---

## AC-01-01 — Delete voice renderer pipeline + UI callers

**Depends on:** —

**Summary.** Unmount voice from the renderer without touching the
electron engine or the settings API. After this ticket nothing in the
Panel calls `window.electron.voice.*`, no push-to-talk button is
visible, and no voice event listener is wired — but the Whisper server,
IPC surface, `AppSettings.voice*` fields, and the "Voice" settings tab
remain (they get torn out in AC-01-02 / AC-01-03).

**Files touched (indicative).**
- Delete: `src/lib/voice-capture.ts`, `src/lib/voice-intent.ts`,
  `src/lib/voice-events.ts`, `src/lib/voice-session-prompts.ts`,
  `src/lib/voice-sound.ts`, `src/lib/use-push-to-talk.ts`,
  `src/lib/project-match.ts` (only consumer is `voice-intent.ts`),
  `src/components/views/VoiceController.tsx`,
  `src/components/views/VoicePushToTalkButton.tsx`,
  `src/components/views/VoiceDisambiguation.tsx`,
  `src/components/views/RecordingIndicator.tsx`,
  `src/lib/__tests__/voice-capture.test.ts`,
  `src/lib/__tests__/voice-intent.test.ts`,
  `src/lib/__tests__/voice-sound.test.ts`.
- Modify: `src/routes/__root.tsx` (drop `VoiceController` import +
  mount; strip "voice" from the tools-cluster comment can wait —
  covered in AC-01-04),
  `src/components/views/HeaderToolsCluster.tsx` (drop
  `VoicePushToTalkButton` import + `visibility.voice` branch + adjust
  `anyVisible`),
  `src/routes/projects.$id.tsx` (drop imports from
  `~/lib/voice-session-prompts` / `~/lib/voice-events`; delete
  `startVoiceAgent`, the `VOICE_NEW_AGENT_EVENT` /
  `VOICE_RUN_SCRIPT_EVENT` / `VOICE_REMEMBER_EVENT` bus effect, and the
  voice-seeded-prompt discard branches),
  `src/components/views/CommitPushButton.tsx` (drop `VOICE_SHIP_EVENT`
  import + listener effect),
  `src/components/views/TerminalPane.tsx` (drop
  `takePendingInitialInput` + `VOICE_PASTE_TO_FOCUSED_SESSION_EVENT`
  imports, delete the `onVoicePaste` listener and the two
  voice-seeded-starting-prompt branches around lines 1346 / 1374).

**Acceptance criteria.**
- `rg "window\.electron\.voice|useVoiceCapture|VoiceController|VoicePushToTalkButton|VoiceDisambiguation|RecordingIndicator|VOICE_[A-Z_]+_EVENT|voice-events|voice-session-prompts|voice-intent|voice-capture|voice-sound|use-push-to-talk|project-match"`
  returns zero hits in `src/`.
- Settings panel still opens; "Voice" tab still lists (it's removed in
  AC-01-03); tools cluster tooltip no longer references voice.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** `VoiceCommandsPage` is intentionally left in place — it is a
data-only view of the settings API and does not touch
`window.electron.voice.*`. It comes out in AC-01-03.

---

## AC-01-02 — Retire whisper-server engine + Electron voice IPC + mac entitlements

**Depends on:** AC-01-01

**Summary.** Cut the entire engine and its OS-integration surface.
Deletes the bundled whisper.cpp resources, the fetch-whisper script,
the `whisper-server.ts` process, the three `voice:*` IPC channels, the
preload bridge, the electron-contract voice group + `VoiceTranscribeResult`
type, and the macOS mic entitlement / usage-string. Renderer is
already off the bridge (AC-01-01), so the contract-type removal
lands green.

**Files touched (indicative).**
- Delete: `resources/whisper/` (whole directory), `scripts/fetch-whisper.mjs`,
  `electron/whisper-server.ts`, `src/lib/fetch-whisper-script.test.ts`.
- Modify `electron/main.ts` — drop `./whisper-server` imports,
  `safeHandle(IPC.voiceAvailable, …)` / `voicePrewarm` / `voiceTranscribe`
  handler blocks (~lines 2022–2040), `shutdownWhisper()` in the shutdown
  path (~line 2479), `MICROPHONE_WEB_PERMISSION` / `shouldAllowAudioCapture`
  imports and the `permission === MICROPHONE_WEB_PERMISSION` branches in
  `setPermissionRequestHandler` / `setPermissionCheckHandler` (~lines
  998–1012).
- Modify `electron/preload.ts` — delete the `voice: { available, prewarm,
  transcribe }` bridge (~lines 322–336).
- Modify `electron/ipc-channels.ts` — delete `voiceTranscribe`,
  `voiceAvailable`, `voicePrewarm` entries.
- Modify `electron/notification-permissions.ts` — delete
  `MICROPHONE_WEB_PERMISSION`, `shouldAllowAudioCapture()`, and the
  file-header microphone comment.
- Modify `src/shared/electron-contract.ts` — delete `VoiceTranscribeResult`
  and the `voice: { available; prewarm; transcribe }` group (~lines
  527–532). `initialInput?` stays for now (dropped in AC-01-04).
- Modify `package.json` — delete `scripts.setup:whisper`, the
  `build.extraResources` whisper entry, and `build.mac.extendInfo.NSMicrophoneUsageDescription`.
- Modify `build/entitlements.mac.plist` — delete the
  `com.apple.security.device.audio-input` key + `<true/>` and the
  preceding push-to-talk comment.
- Modify `scripts/release-local.mjs` — remove
  `run("pnpm", ["setup:whisper"])` (~line 141).
- Modify `electron/__tests__/packaging-config.test.ts` — delete the
  three cases (whisper bundle, mic usage description, audio-input
  entitlement).
- Modify `electron/__tests__/notification-permissions.test.ts` — delete
  the `shouldAllowAudioCapture` describe block and the "denies bare
  media" case; drop `MICROPHONE_WEB_PERMISSION` /
  `shouldAllowAudioCapture` imports.

**Acceptance criteria.**
- `rg "whisper|Whisper" electron scripts build resources package.json`
  returns zero hits.
- `rg "voice:transcribe|voice:available|voice:prewarm|VoiceTranscribeResult|window\.electron\.voice"`
  returns zero hits.
- `rg "NSMicrophoneUsageDescription|audio-input|MICROPHONE_WEB_PERMISSION|shouldAllowAudioCapture"`
  returns zero hits.
- macOS `pnpm dist:mac` (or `pnpm build`) no longer errors on missing
  `resources/whisper/`.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** `chime.mp3` is retained — it doubles as the notification
ding. `notification-ding.wav` is a voice-only start cue and is deleted
in AC-01-04 once `voice-sound.ts` is gone (it was already deleted in
AC-01-01, so the asset is orphaned; removal deferred to keep this
ticket electron/IPC-only).

---

## AC-01-03 — Retire voice AppSettings + Settings Panel voice surface + shared voice types (atomic)

**Depends on:** AC-01-02

**Summary.** The atomic core removal. `AppSettings.voiceControlEnabled`
+ `voiceCommandAliases`, the settings-controller keys / zod schemas /
reads / PATCH branches, the "Voice" tab in `SettingsPanel`,
`VoiceCommandsPage`, the DefaultsSettingsPage voice feature, the
`voice` entry in `HEADER_BUTTON_KEYS` and `hideable-elements`, and the
shared `voice-command-aliases.ts` module all land in one ticket — the
type surface only reconciles if they land together.

**Files touched (indicative).**
- Delete: `src/components/views/VoiceCommandsPage.tsx`,
  `src/shared/voice-command-aliases.ts`.
- Modify `src/lib/api.ts` — drop the
  `import type { VoiceCommandAliases }` line, `voiceControlEnabled:
  boolean;` and `voiceCommandAliases: VoiceCommandAliases;` from
  `AppSettings`, and `"voiceControlEnabled"` / `"voiceCommandAliases"`
  from the Update payload union.
- Modify `src/server/controllers/settings.controller.ts` — drop the
  `emptyVoiceCommandAliases` / `normalizeVoiceCommandAliases` /
  `VoiceCommandAliases` imports, `VOICE_COMMAND_ALIASES_KEY`, the
  `voiceCommandAliasesBody` zod, `voiceControlEnabled` on the update
  body, `voiceCommandAliases: voiceCommandAliasesBody` on the update
  body, `getVoiceCommandAliasesSetting()`, both read-response entries,
  the "Voice control and native question popups are also always on"
  comment, and the `voiceCommandAliases` write branch.
- Modify `src/components/views/SettingsPanel.tsx` —
  drop `VoiceCommandsPage` import, the `{ id: "voice", … }` panel
  entry, and the `activePanel === "voice"` branch.
- Modify `src/components/views/settings-panel-ids.ts` — drop `"voice"`.
- Modify `src/components/views/InterfaceSettingsPage.tsx` — drop the
  `voice: { … "microphone button …" }` visibility descriptor and the
  `{headerButtonRow("voice")}` row.
- Modify `src/components/views/DefaultsSettingsPage.tsx` — drop
  `"voice"` from `DefaultsFeatureId`, the voice feature descriptor,
  and the `activeFeature === "voice"` render branch.
- Modify `src/components/views/GeneralSettingsPage.tsx`,
  `TerminalSettingsPage.tsx`, `ThemeSettingsPage.tsx` — drop
  `emptyVoiceCommandAliases` imports and the `voiceCommandAliases:`
  / `voiceControlEnabled:` fields in each page's settings merge
  object.
- Modify `src/shared/header-buttons.ts` — drop `"voice"` from
  `HEADER_BUTTON_KEYS` and `voice: true` from the default visibility
  map.
- Modify `src/lib/hideable-elements.tsx` — drop
  `voice: "push-to-talk button"`.
- Modify `src/server/__tests__/settings-api.test.ts` — delete the 10
  voice-related cases enumerated in the parent spec (`voice: true`
  header-button default, "defaults voice agents to Claude Code", "has
  no custom voice command aliases", "persists the default harness and
  generic model for voice-started agents", the annotation-independent
  case, the Ship-independent case, "persists normalized custom voice
  command aliases", "rejects invalid custom voice command alias
  payloads", "keeps voice control enabled", "ignores attempts from
  older clients to disable voice control").

**Acceptance criteria.**
- `rg "VoiceCommandAliases|voice-command-aliases|voiceCommandAliases|voiceControlEnabled|VOICE_COMMAND_ALIASES_KEY|emptyVoiceCommandAliases|normalizeVoiceCommandAliases|getVoiceCommandAliasesSetting"`
  returns zero hits.
- `rg "\"voice\""` under `src/components/views/`,
  `src/shared/header-buttons.ts`, `src/lib/hideable-elements.tsx`
  returns zero hits.
- Settings panel opens; "Voice" tab absent; Defaults page lists no
  "Voice Agents" feature; General/Theme/Terminal pages still render.
- `pnpm typecheck` and `pnpm test` green.

---

## AC-01-04 — Delete `initialInput` seed path + voice keybinding + CSS/audio/comment cleanup

**Depends on:** AC-01-03

**Summary.** Cleanup pass. Strips the voice-seeded `initialInput`
plumbing (renderer + electron + shared), removes the `voice.pushToTalk`
keybinding, deletes the recording-indicator CSS keyframe and the
orphan audio asset, updates the divergence note in
`docs/upstream/PROVENANCE.md`, and prunes lingering "voice" mentions
from comments across the tree.

**Files touched (indicative).**
- Modify `electron/pty-manager.ts` — delete `sanitizeInitialInput()`,
  the `initialInputScheduled` / `initialInputTimer` state, and the
  `sendInitialInput` scheduling block (~lines 736–…).
- Modify `src/shared/electron-contract.ts` — delete
  `initialInput?: string` from `AgentPtySpawnOptions` and the
  neighboring comment.
- Modify `src/shared/pty-spawn-policy.ts` — delete `initialInput?` on
  `AgentPtySpawnOptions` and the `initialInput?: never` shell-branch
  guard; strip the "used by voice control to seed a session" comment.
- Modify `src/lib/agent-command.ts` — delete `shouldInjectInitialInput`
  and its comment; drop the Cursor-voice launch case from
  `src/lib/__tests__/agent-command.test.ts`.
- Modify `src/lib/keybindings/defaults.ts` — delete the
  `"voice.pushToTalk"` binding.
- Modify `src/lib/keybindings/groups.ts` — remove `"voice.pushToTalk"`
  from the `general` group `actions`.
- Modify `src/lib/keybindings/types.ts` — remove `"voice.pushToTalk"`
  from `HOTKEY_ACTIONS` and its metadata entry.
- Modify `src/styles.css` — delete `@keyframes mc-voice-pulse` and its
  "Push-to-talk recording indicator pulse." header comment.
- Delete `public/audio/notification-ding.wav` (only consumer was the
  now-deleted `voice-sound.ts`).
- Modify (comment prunes only):
  `src/lib/terminal-store.tsx` (stray "voice" mention),
  `src/routes/__root.tsx` (tools-cluster comment),
  `src/server/controllers/project-memory.controller.ts`
  (agent-write-toggle docstring),
  `src/server/services/code-graph-wasm.ts` (resource-resolution header
  comment references `whisper-server.ts`),
  `src/components/views/RecallPanel.tsx` (source-label map entry
  `voice: "voice"`; note: `RecallPanel.tsx` is otherwise removed by
  the recall/memory spec — edit here if this ticket lands first,
  otherwise delete alongside),
  `src/components/views/GeneralSettingsPage.tsx` ("next time Mission
  Control loads" copy that mentions voice).
- Modify `docs/upstream/PROVENANCE.md` — add a divergence note that
  voice / Whisper is REMOVED from the fork (per ADR 0007); retain
  upstream historical references.

**Acceptance criteria.**
- `rg "initialInput|sanitizeInitialInput|shouldInjectInitialInput|voice\.pushToTalk|mc-voice-pulse|notification-ding\.wav"`
  returns zero hits.
- `rg -i "voice"` in `src/` and `electron/` returns only species-timbre
  matches in unrelated files (grep-verify by reading each hit).
- `pnpm typecheck` and `pnpm test` green.

**Notes.** The `MEMORY_SOURCES` tuple entry `"voice"` in
`src/shared/project-memory.ts` is deliberately **NOT** touched here —
it is removed in AC-01-05 together with the boot-time row cleanup, so
Zod parsing of surviving `source = 'voice'` rows keeps working until
the DELETE runs on next boot.

---

## AC-01-05 — Schema-bootstrap: drop `voice_command_aliases` + voice-tagged memory rows

**Depends on:** AC-01-04

**Summary.** Add a one-shot idempotent boot-time cleanup that removes
the `voice_command_aliases` row from `app_settings` and any
`project_memories` rows tagged `source = 'voice'`, then removes
`"voice"` from `MEMORY_SOURCES` now that no persisted row references
it. Follows the fork convention ("we don't ship migration files to the
user") — this is code in `schema-bootstrap.ts`, not a numbered SQL
file.

**Files touched (indicative).**
- Modify `src/db/schema-bootstrap.ts` — add a
  `dropLegacyVoiceSettings(sqlite)` helper that runs:
    - `DELETE FROM app_settings WHERE key = 'voice_command_aliases';`
    - guarded `DELETE FROM project_memories WHERE source = 'voice';`
      — skip if the `project_memories` table has already been dropped
      by spec 04's recall/memory cleanup (query `sqlite_master` before
      the DELETE).
  Call it from `ensureSchema` alongside `dropLegacyPetSettings` and
  document that the block stays in the tree for one release.
- Modify `src/shared/project-memory.ts` — drop `"voice"` from
  `MEMORY_SOURCES` now that the boot-time cleanup guarantees no
  surviving rows reference it.

**Acceptance criteria.**
- Booting the Panel against a pre-cutover SQLite (with
  `voice_command_aliases` present in `app_settings`, or memory rows
  tagged `source = 'voice'`) leaves zero rows matching either.
- Booting the Panel against a fresh SQLite runs the DELETEs without
  error and produces no rows.
- Booting against a post-spec-04 SQLite (no `project_memories` table)
  skips the memory-row delete cleanly (no `no such table` error).
- `rg "MEMORY_SOURCES.*voice|source = 'voice'|voice_command_aliases"`
  in `src/` returns only the boot-time DELETE in
  `schema-bootstrap.ts`.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** Like AC-02-05, this cleanup block stays in the tree for one
release, then is removed by a follow-up ticket (tracked as
AC-CLEANUP-01 in the rebrand set).
