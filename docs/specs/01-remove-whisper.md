# 01 — Remove Whisper / voice control

## Overview

Rip out the entire push-to-talk voice-command subsystem: the bundled whisper.cpp
server + model, the renderer capture/intent pipeline, the settings UI, IPC, DB
key, keybinding, and macOS mic entitlement. Justified by ADR 0007 (scope narrow
to a harness remote control) — voice is a non-harness feature that leaks Panel
state into the OS mic layer and carries an outsized packaging cost.

## Files to delete

Bundled engine + build glue:

- `resources/whisper/README.md` (whole directory `resources/whisper/`)
- `scripts/fetch-whisper.mjs`
- `electron/whisper-server.ts`

Renderer voice pipeline (`src/lib/`):

- `src/lib/voice-capture.ts`
- `src/lib/voice-intent.ts`
- `src/lib/voice-events.ts`
- `src/lib/voice-session-prompts.ts`
- `src/lib/voice-sound.ts`
- `src/lib/use-push-to-talk.ts`
- `src/lib/project-match.ts` (only consumer is `voice-intent.ts` — confirm zero
  other importers before deletion; grep says none)

Renderer voice UI (`src/components/views/`):

- `src/components/views/VoiceController.tsx`
- `src/components/views/VoicePushToTalkButton.tsx`
- `src/components/views/VoiceDisambiguation.tsx`
- `src/components/views/VoiceCommandsPage.tsx`
- `src/components/views/RecordingIndicator.tsx`

Shared:

- `src/shared/voice-command-aliases.ts`

Tests:

- `src/lib/__tests__/voice-capture.test.ts`
- `src/lib/__tests__/voice-intent.test.ts`
- `src/lib/__tests__/voice-sound.test.ts`
- `src/lib/fetch-whisper-script.test.ts`

Audio assets (only if unshared — `chime.mp3` is shared with notifications, keep):

- `public/audio/notification-ding.wav` (only ref is `voice-sound.ts`
  `VOICE_START_CUE_SRC`; delete after voice-sound.ts is gone)

## Files to modify

`package.json`

- Delete `scripts.setup:whisper`.
- Delete `build.extraResources[]` entry `{ from: "resources/whisper", to: "whisper" }`.
- Delete `build.mac.extendInfo.NSMicrophoneUsageDescription`.
- (see Package.json edits section below)

`build/entitlements.mac.plist`

- Delete the `com.apple.security.device.audio-input` key + `<true/>` and its
  comment about push-to-talk voice capture.

`electron/main.ts`

- Remove imports from `./whisper-server` (`isWhisperAvailable`, `prewarmWhisper`,
  `shutdownWhisper`, `transcribeWav`, `WhisperUnavailableError`).
- Remove `safeHandle(IPC.voiceAvailable, …)`, `safeHandle(IPC.voicePrewarm, …)`,
  `safeHandle(IPC.voiceTranscribe, …)` blocks (~lines 2022–2040).
- Remove `shutdownWhisper()` from the shutdown path (~line 2479).
- Remove `MICROPHONE_WEB_PERMISSION` / `shouldAllowAudioCapture` imports from
  `./notification-permissions`.
- In `setPermissionRequestHandler` and `setPermissionCheckHandler` (~lines
  998–1012), drop the `permission === MICROPHONE_WEB_PERMISSION` branches so
  `media` falls through to the default-deny path.

`electron/notification-permissions.ts`

- Delete `MICROPHONE_WEB_PERMISSION` constant.
- Delete `shouldAllowAudioCapture()`.
- Delete the file's header comment about microphone / voice.

`electron/preload.ts`

- Delete the `voice: { available, prewarm, transcribe }` bridge (~lines 322–336).

`electron/ipc-channels.ts`

- Delete `voiceTranscribe`, `voiceAvailable`, `voicePrewarm` entries.

`electron/pty-manager.ts`

- Delete `sanitizeInitialInput()` and every use of `opts.initialInput` (write to
  stdin after TUI ready). This is voice-only wiring (see comment "voice-seeded
  starting prompt").
- Remove the `initialInputScheduled` / `initialInputTimer` state and the
  `sendInitialInput` scheduling block (~lines 736–…).

`src/shared/electron-contract.ts`

- Delete `VoiceTranscribeResult` type.
- Delete the `voice: { available; prewarm; transcribe }` group from the electron
  API contract (~lines 527–532).
- Delete `initialInput?: string` from `AgentPtySpawnOptions` and update the
  neighboring comment.

`src/shared/pty-spawn-policy.ts`

- Delete `initialInput?: string` from `AgentPtySpawnOptions` (~line 40) and the
  `initialInput?: never` guard on the shell branch (~line 92).
- Remove the "used by voice control to seed a session" comment near line 37.

`src/shared/header-buttons.ts`

- Remove `"voice"` from the `HEADER_BUTTON_KEYS` union.
- Remove `voice: true` from the default visibility map.

`src/shared/project-memory.ts`

- Remove `"voice"` from `MEMORY_SOURCES` tuple (~line 32). Any DB rows already
  tagged `source = 'voice'` are dropped by the consolidated memory-removal spec;
  if that runs after this one, keep the tuple entry with a TODO — otherwise
  Zod-parse of existing rows fails.

`src/lib/api.ts`

- Delete `import type { VoiceCommandAliases } from "~/shared/voice-command-aliases";`.
- Delete `voiceControlEnabled: boolean;` from `AppSettings`.
- Delete `voiceCommandAliases: VoiceCommandAliases;` from `AppSettings`.
- Delete `"voiceControlEnabled"` and `"voiceCommandAliases"` from the Update
  payload union (~lines 734, 766).
- Update comments on `defaultAgent` / `defaultModel` that describe them as the
  voice-agent default; keep the fields (they're used by other paths — verify at
  callsite; see Follow-ups).

`src/lib/keybindings/defaults.ts`

- Delete the `"voice.pushToTalk": makeBinding({ mod: true, shift: true, key: "v" })`
  line (~line 42).

`src/lib/keybindings/groups.ts`

- In the `general` group, remove `"voice.pushToTalk"` from `actions` (~line 68).

`src/lib/keybindings/types.ts`

- Remove `"voice.pushToTalk"` from `HOTKEY_ACTIONS` (~line 31).
- Remove the `"voice.pushToTalk": { label, description }` entry (~lines 113–117).

`src/lib/hideable-elements.tsx`

- Remove `voice: "push-to-talk button"` from `HEADER_BUTTON_LABELS` (~line 56).

`src/lib/agent-command.ts`

- Remove the "Cursor voice launches" comment on `shouldInjectInitialInput`
  (~lines 56–61). The function itself is only called from the voice-seeded-input
  path in `pty-manager.ts`; verify it's dead after that path is removed and
  delete it plus its test (`src/lib/__tests__/agent-command.test.ts` "still
  seeds Cursor voice launches" case).

`src/lib/terminal-store.tsx`

- Grep confirms only a stray comment; strip any "voice" mention. No functional
  change expected.

`src/routes/__root.tsx`

- Remove `import { VoiceController } from "~/components/views/VoiceController";`.
- Remove the `<VoiceController />` mount (~line 1013).
- Update the tools-cluster comment (~line 916) to drop "voice".

`src/routes/projects.$id.tsx`

- Remove imports from `~/lib/voice-session-prompts` and `~/lib/voice-events`
  (setPendingInitialInput, takePendingInitialInput, VoiceNewAgentDetail,
  VoiceRememberDetail, VoiceRunScriptDetail).
- Delete `startVoiceAgent` (~line 1916) and its dependency in the callback
  memo list (~line 2138).
- Delete the voice command-bus effect block (~lines 2059–2138) that listens on
  `VOICE_NEW_AGENT_EVENT`, `VOICE_RUN_SCRIPT_EVENT`, `VOICE_REMEMBER_EVENT`.
- Delete the voice-seeded-prompt discard branch (~lines 1543, 1726) and update
  surrounding comments.

`src/components/views/HeaderToolsCluster.tsx`

- Remove `import { VoicePushToTalkButton } from ...`.
- Remove the `visibility.voice && <VoicePushToTalkButton …/>` branch (~lines
  63–68).
- Drop `visibility.voice` from `anyVisible` and update the tools tooltip
  ("scratch pads, prompt search" — no voice).

`src/components/views/SettingsPanel.tsx`

- Remove `import { VoiceCommandsPage }`.
- Remove `{ id: "voice", label: "Voice", icon: "play" }` from the panel list
  (~line 97).
- Remove the `activePanel === "voice"` branch that renders `<VoiceCommandsPage />`.

`src/components/views/settings-panel-ids.ts`

- Remove `"voice"` from the ids union.

`src/components/views/InterfaceSettingsPage.tsx`

- Remove the `voice: { … "microphone button in the top-bar tools tray" }` entry
  from the header-button visibility descriptor map (~lines 57–61).
- Remove `{headerButtonRow("voice")}` (~line 138).

`src/components/views/DefaultsSettingsPage.tsx`

- Remove `"voice"` from the `DefaultsFeatureId` union (~line 32).
- Remove the `{ id: "voice", label: "Voice Agents", … }` feature descriptor
  (~lines 45–48).
- Remove the `activeFeature === "voice"` render branch (~line 329).

`src/components/views/GeneralSettingsPage.tsx`

- Remove `emptyVoiceCommandAliases` import.
- Remove `voiceCommandAliases:` and `voiceControlEnabled:` fields from the
  settings payload/merge object (~lines 154–155).
- Update the "next time Mission Control loads" copy that mentions voice (~line
  360).

`src/components/views/TerminalSettingsPage.tsx`

- Remove `emptyVoiceCommandAliases` import.
- Remove `voiceCommandAliases:` and `voiceControlEnabled:` fields from the
  settings merge object (~lines 218–219).

`src/components/views/ThemeSettingsPage.tsx`

- Remove `emptyVoiceCommandAliases` import.
- Remove `voiceCommandAliases:` and `voiceControlEnabled:` fields from the
  settings merge object (~lines 158–159).

`src/components/views/CommitPushButton.tsx`

- Remove `import { VOICE_SHIP_EVENT } from "~/lib/voice-events";`.
- Remove the `onVoiceShip` listener effect (~lines 50–55).

`src/components/views/TerminalPane.tsx`

- Remove `takePendingInitialInput` import from `~/lib/voice-session-prompts`.
- Remove `VOICE_PASTE_TO_FOCUSED_SESSION_EVENT` / `VoicePasteToFocusedSessionDetail`
  imports.
- Remove the `onVoicePaste` listener block (~lines 994–1005).
- Remove both voice-seeded-starting-prompt branches (~lines 1346, 1374) and the
  `takePendingInitialInput()` call sites.

`src/components/views/RecallPanel.tsx`

- Remove the `voice: "voice"` entry from the source-label map (~line 38). Note:
  this file is otherwise removed by the recall/memory removal spec; if this
  spec lands first, edit here — otherwise delete-alongside.

`src/server/controllers/settings.controller.ts`

- Remove `emptyVoiceCommandAliases`, `normalizeVoiceCommandAliases`,
  `VoiceCommandAliases` imports (~lines 86–89).
- Delete `VOICE_COMMAND_ALIASES_KEY` constant (~line 143).
- Delete `voiceCommandAliasesBody` zod schema (~lines 167–176).
- Delete `voiceControlEnabled: z.boolean()` from the update body (~line 222).
- Delete `voiceCommandAliases: voiceCommandAliasesBody` from the update body
  (~line 300).
- Delete `getVoiceCommandAliasesSetting()` (~lines 514–520).
- Delete `voiceControlEnabled: true` from the read response (~line 581).
- Delete `voiceCommandAliases: getVoiceCommandAliasesSetting()` from the read
  response (~line 613).
- Delete the "Voice control and native question popups are also always on"
  comment (~line 750).
- Delete the `if (body.voiceCommandAliases !== undefined) { setSetting(...) }`
  write branch (~lines 901–903).

`src/server/controllers/project-memory.controller.ts`

- Update the "Agent-written memories obey the agent-write toggle; user/voice
  writes don't" comment (~line 119) to drop voice.

`src/server/services/code-graph-wasm.ts`

- Remove the passing reference to `whisper-server.ts` in the resource-resolution
  header comment.

`src/styles.css`

- Delete `@keyframes mc-voice-pulse` (~line 4214) and its "Push-to-talk recording
  indicator pulse." header comment.

`scripts/release-local.mjs`

- Remove `run("pnpm", ["setup:whisper"])` (~line 141).

`electron/__tests__/packaging-config.test.ts`

- Delete the "bundles the whisper voice-control resources" test.
- Delete the "declares the macOS microphone usage string" test.
- Delete the "grants the hardened-runtime audio-input entitlement" test.

`electron/__tests__/notification-permissions.test.ts`

- Delete the `shouldAllowAudioCapture` describe block.
- Delete the "denies bare media (microphone is gated separately by media type)"
  case.
- Drop `MICROPHONE_WEB_PERMISSION` / `shouldAllowAudioCapture` imports.

`src/server/__tests__/settings-api.test.ts`

- Delete `emptyVoiceCommandAliases` import.
- Delete tests: `voice: true` header-button default (~line 364), "defaults voice
  agents to Claude Code" (~445), "has no custom voice command aliases by
  default" (~453), "persists the default harness and generic model for
  voice-started agents" (~460), "persists the annotation harness and model
  independently of the voice default" (~510), "persists the Ship harness, model,
  and prompt independently of voice defaults" (~550), "persists normalized
  custom voice command aliases" (~590), "rejects invalid custom voice command
  alias payloads" (~625), "keeps voice control enabled" (~831), "ignores
  attempts from older clients to disable voice control" (~836).

`src/lib/__tests__/agent-command.test.ts`

- Delete the "still seeds Cursor voice launches even though they use --resume"
  case (~line 276).

`docs/upstream/PROVENANCE.md`

- Add a divergence note that voice / Whisper is REMOVED from the fork (per ADR
  0007). Do not remove upstream historical references.

## Schema changes

No dedicated tables. All voice state lives in `app_settings` as a KV row:

- Drop key: `voice_command_aliases`
- (No `voice_control_enabled` row exists — `voiceControlEnabled` in the API is a
  legacy always-true compatibility field, not stored.)

No indexes / triggers to drop. Nothing in `src/db/migrations/*.sql` references
voice.

## Migration

`src/db/migrations/NNNN_remove_whisper.sql` (renumbered at consolidation):

```sql
-- ADR 0007: voice control removed.
DELETE FROM app_settings WHERE key = 'voice_command_aliases';
-- Clean up any memory rows tagged with voice as their source. If the
-- memory/recall removal spec runs before this one, this row set is already
-- gone via table drop and the DELETE is a no-op.
DELETE FROM project_memories WHERE source = 'voice';
```

## Package.json edits

- Remove dependency: none (whisper is an OS-level binary, not an npm package).
- Remove scripts: `setup:whisper`.
- Remove from `build.extraResources`: `{ "from": "resources/whisper", "to":
  "whisper", "filter": ["**/*"] }`.
- Remove from `build.mac.extendInfo`: `NSMicrophoneUsageDescription`.
- Leave `NSScreenCaptureUsageDescription` — owned by the screenshot removal
  spec.

## Entitlements / OS integration

- `build/entitlements.mac.plist`: delete `com.apple.security.device.audio-input`
  key + `<true/>` value and the preceding comment about push-to-talk voice
  capture. Both `entitlements` and `entitlementsInherit` point at this file, so
  a single edit covers both.
- macOS Info.plist: `NSMicrophoneUsageDescription` is delivered via
  `package.json > build.mac.extendInfo` (see above). No standalone Info.plist to
  edit.
- Windows / Linux: no voice-specific manifest entries. `dist:win` uses NSIS
  defaults; `dist:linux` uses AppImage — neither declares mic.

## Env vars / IPC channels

- No `MC_VOICE_*` / `MC_WHISPER_*` env vars in the codebase — grep confirms
  zero.
- IPC channels to remove from `electron/ipc-channels.ts`:
  - `voice:transcribe` (`voiceTranscribe`)
  - `voice:available` (`voiceAvailable`)
  - `voice:prewarm` (`voicePrewarm`)
- Preload exposure to remove: `window.electron.voice.{ available, prewarm,
  transcribe }` (see `electron/preload.ts` and the contract in
  `src/shared/electron-contract.ts`).
- No `mic:*` channels exist.

## Keybindings

Strip everywhere `voice.pushToTalk` appears:

- `src/lib/keybindings/defaults.ts` — line 42 binding entry (`mod+shift+v`).
- `src/lib/keybindings/groups.ts` — line 68 `general` group `actions` list.
- `src/lib/keybindings/types.ts` — line 31 (union) and lines 113–117 (metadata
  entry).

## Tests to remove

- `src/lib/__tests__/voice-capture.test.ts` (whole file).
- `src/lib/__tests__/voice-intent.test.ts` (whole file).
- `src/lib/__tests__/voice-sound.test.ts` (whole file).
- `src/lib/fetch-whisper-script.test.ts` (whole file).
- Test *cases* removed in-place from otherwise-surviving files: see the
  "Files to modify" entries for `electron/__tests__/packaging-config.test.ts`,
  `electron/__tests__/notification-permissions.test.ts`,
  `src/server/__tests__/settings-api.test.ts`,
  `src/lib/__tests__/agent-command.test.ts`.

## Verification checklist

- `rg -n -i 'whisper|push[- ]to[- ]talk|voice(?!less)' src electron scripts
  build docs/specs docs/upstream package.json build/entitlements.mac.plist`
  returns zero non-history hits (allow matches in `docs/adr/0007-…`, ADR/plan
  history, `docs/upstream/PROVENANCE.md`, and the `pet-*` files whose "voice"
  is species-timbre, not speech).
- `rg -n 'MediaRecorder|getUserMedia|SpeechRecognition' src electron` returns
  zero hits. `AudioContext` should only remain in `src/lib/pet/pet-sounds.ts`
  (pet chirp synth — verified unshared with voice).
- `rg -n 'voice_command_aliases|voiceCommandAliases|voiceControlEnabled|
  voice\.pushToTalk|VOICE_[A-Z_]+_EVENT|initialInput'` returns zero.
- `pnpm typecheck` clean, `pnpm lint` clean, `pnpm test` green.
- `pnpm build` succeeds (electron-builder no longer looks for
  `resources/whisper/`).
- App launches on macOS without triggering the mic permission prompt on first
  run; System Settings > Privacy > Microphone does not list the app.
- Settings panel has no "Voice" tab; the `…` tools tray shows no push-to-talk
  button; Defaults page has no "Voice Agents" entry.
- `rg -n 'mc-voice-pulse|/audio/notification-ding\.wav'` returns zero — no
  orphan CSS keyframes or audio asset references.

## Follow-ups / out of scope

- `defaultAgent` / `defaultModel` in `AppSettings` were introduced *for* voice-
  started agents but are consumed elsewhere (spawn defaulting, header pickers).
  Keep the fields; only edit the doc-comments in this spec. A future cleanup can
  rename them once the rebrand spec lands.
- `AudioContext` in `src/lib/pet/pet-sounds.ts` is retained by the pet subsystem
  — its removal is owned by the pet removal spec.
- `MEMORY_SOURCES` includes `"voice"`; the full memories removal spec drops the
  table. Coordinate ordering: if memories removal lands first, this spec's
  migration `DELETE FROM project_memories …` becomes a no-op against a missing
  table — guard with `DROP TABLE IF EXISTS` semantics or move the row-delete
  into the memories spec.
- `chime.mp3` was the voice end-cue AND the generic notification ding; do NOT
  delete — `notification-sound.ts` still points at it.
- Cursor `--resume` seeding (`shouldInjectInitialInput` in
  `src/lib/agent-command.ts`) is only reachable via voice. It's likely fully
  dead after `initialInput` removal; a follow-up should confirm and delete the
  function + its non-voice test.
- `docs/upstream/*` — ADR 0007 already flags that voice-related divergence
  axes become NON-EXISTENT. Update the specific axis rows during the rebrand
  pass, not here.
