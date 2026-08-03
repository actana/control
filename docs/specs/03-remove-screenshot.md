# 03 — Remove screenshot capture, annotator, and history

## Overview
Rip out the macOS-only region-capture flow (`screencapture -i`), the in-app markup/annotation canvas, the persistent per-project thumbnail history strip, and the floating capture stack. This is a hard removal — no feature flag, no data-preservation path — as part of the Actana Control scope narrowing (ADR 0007). File transfer to Harnesses will replace the underlying use case in a future spec.

## Files to delete

Screenshot-only source:

- `src/lib/screenshot.ts` (32 LOC — `screenshotSupported`, `screenshotCaptureErrorMessage`, `screenshotFromResult`)
- `src/lib/screenshot-sound.ts` (33 LOC — `playScreenshotCapture`, `playScreenshotDrop`, `SCREENSHOT_CAPTURE_SRC`, `SCREENSHOT_DROP_SRC`)
- `src/components/views/ScreenshotAnnotator.tsx` (1615 LOC — markup canvas)
- `src/components/views/ScreenshotHistory.tsx` (403 LOC — persistent thumbnail strip content)
- `src/components/views/ScreenshotThumbnail.tsx` (538 LOC — floating capture stack)
- `src/lib/__tests__/screenshot.test.ts`

Audio assets (delete both file + generated dist copies via a fresh build):

- `public/audio/screenshot-capture.mp3`
- `public/audio/screenshot-drop.mp3`
- (build artifacts `dist/client/audio/screenshot-*.mp3` and `dist/server/assets/screenshot-sound-*.js` disappear on next build — no manual deletion needed)

Not deleted:

- **No historical migration `0005_screenshots.sql` exists** — the brief was mistaken. `src/db/migrations/0005_claude_session_persistence.sql` is unrelated and stays. There is no `screenshots` table anywhere in `src/db/schema.ts`, `schema-bootstrap.ts`, or any migration; screenshot history is persisted to `window.localStorage` under `mc.screenshots` only.
- `screenshot.mjs` at repo root is a Puppeteer dev-tool for capturing app screenshots during design iteration (unrelated to the in-app feature). Leave in place.
- `chime.mp3`, `notification-ding.wav`, `slide.ogg`, `welcome.mp3` in `public/audio/` stay.
- `saveTerminalNativeImage`, `readTerminalImageForEdit`, `copyTerminalImageToClipboard`, `deleteTerminalImageFile`, `resolveTerminalImageFile`, `terminalImagesDir`, `pruneTerminalImagesDir` in `electron/main.ts` and the entire `terminalImages` IPC group (`terminal:saveDroppedImage`, `terminal:saveClipboardImage`, `terminal:copyImageToClipboard`, `terminal:deleteImage`) stay — they back drag-and-drop / clipboard image attach for CLI paste, which survives the screenshot removal.

## Files to modify

- `src/components/views/UserTerminalPanel.tsx`
  - Delete import `ScreenshotHistoryContent` (line 10).
  - Delete constant `SCREENSHOT_PANEL_HEIGHT` (line 18).
  - Delete `screenshots` destructure from `useTerminals()` (line 68), `screenshotCount` memo (69–72), the `showScreenshots` state (73), the auto-fallback effect (76–78), the `prevScreenshotCount` ref + plus-one animation effect (85–95).
  - In the tab-click callback (~118–148), drop the "returning from Screenshots view" branch (121–133) and remove `showScreenshots` from deps.
  - Delete `screenshotsVisible` (155), `onScreenshotsTabClick` (160–168), the `!screenshotsVisible` gate on panel body render (250), the `showScreenshots ? false :` ternary on tab `active` (324), the `bodyIsScreenshots`/`bodyHeight` special-case (231–232 — panel height becomes just `height`).
  - Delete the "Screenshots" tab button block (389–430) including its `screenshot-count` badge, `screenshot-plusone` animation, and the `<ScreenshotHistoryContent projectId={project.id} />` render (463–464).
  - Remove `setShowScreenshots(false)` call in the resize-drag handler (431).
- `src/routes/__root.tsx`
  - Delete import `screenshotSupported` (line 15) and `ScreenshotThumbnail` (line 43).
  - Delete `screenshotsSupported` memo (~480) and the `{screenshotsSupported && <ScreenshotThumbnail projectId={projectId} />}` render (~875).
- `src/routes/projects.$id.tsx`
  - Delete imports (60–64): `screenshotCaptureErrorMessage`, `screenshotFromResult`, `screenshotSupported`, `playScreenshotCapture`.
  - Delete `screenshotSupported` memo (~803), `addScreenshot`/`captureScreenshot` callback (804–818), `useHotkey("screenshot.capture", …)` (~2271), and the header camera-button render `{screenshotSupported && headerButtons.screenshot && (...)}` (~3443–3460).
- `src/routes/focus.$taskId.tsx`
  - Delete imports (17, 23–27) for `ScreenshotThumbnail`, `screenshotCaptureErrorMessage`, `screenshotFromResult`, `isScreenshotSupported`, `playScreenshotCapture`.
  - Delete `screenshotSupported`/`captureScreenshot` block (228–249) and the `useHotkey("screenshot.capture", …)` (250).
  - Drop `showScreenshot` / `onCaptureScreenshot` props on the header component (354–355) and the `{showScreenshot && (…)}` button in its render (555–566). Remove those props from the component signature/type (478–489).
  - Delete the `{screenshotSupported && <ScreenshotThumbnail … variant="focus" />}` render (395–396).
- `src/lib/terminal-store.tsx`
  - Delete import `screenshotSupported` (line 13) and the `AnnotationShape` type import from `ScreenshotAnnotator` (line 35).
  - Delete `ScreenshotEntry`, `PendingScreenshot` (deprecated alias), `ScreenshotMeta` types (58–86).
  - Remove `screenshots`, `pendingScreenshots`, `addScreenshot`, `updateScreenshot`, `dismissPendingScreenshot`, `removeScreenshot` from the store interface (151–169) and from the `"screenshots"` / `"pendingScreenshots"` entries in the excluded-keys union (223–224).
  - Delete `SCREENSHOTS_KEY = "mc.screenshots"` (414), `loadScreenshotMeta` (417–440), `saveScreenshotMeta` (442–450).
  - Delete state hooks: `screenshots`, `screenshotsRef`, `screenshotSeq`, `pendingScreenshotIds` (721–729); the `saveScreenshotMeta` effect (733–734); the on-mount preview reload effect (736–767 — it calls `electron.screenshot.readImage`).
  - Delete callbacks `addScreenshot` (768–773), `updateScreenshot` (775–780), `dismissPendingScreenshot` (781–784), `removeScreenshot` (785–798), and the `pendingScreenshots` memo (800–804).
  - Delete those six names from context-value objects (1523–1527, 1555–1558, 1617–1618, 1626–1627). Leave `attachImageToSession` — it survives for the drag-drop path.
- `src/components/views/SessionDropzone.tsx`
  - Delete import `playScreenshotDrop` (line 3) and the `if (attached) playScreenshotDrop();` call (line 136). File-drag flow keeps working silently.
- `src/components/views/InterfaceSettingsPage.tsx`
  - Delete the `screenshot` entry (69–74) from the header-button settings map and the `{headerButtonRow("screenshot")}` call (151).
- `src/shared/header-buttons.ts`
  - Remove `"screenshot"` from `HEADER_BUTTON_KEYS` (17) and the `screenshot: true` entry in `DEFAULT_HEADER_BUTTON_VISIBILITY` (31). This changes the persisted `AppSettings.headerButtons` shape.
- `src/lib/hideable-elements.tsx`
  - Delete `screenshot: "screenshot button"` map entry (58) and any label plumbing that references it.
- `src/lib/keybindings/types.ts`
  - Remove `"screenshot.capture"` from the actions union (34) and delete its label/description entry (128–132).
- `src/lib/keybindings/groups.ts`
  - Remove `"screenshot.capture"` from the `session` group's `actions` array (28).
- `src/lib/keybindings/defaults.ts`
  - Delete the `"screenshot.capture": makeBinding({ mod: true, shift: true, key: "s" })` entry (46) and rewrite the mod+Shift+S comment on `project.ship` (~38) to just note the collision with `file.save` (mod+S).
- `src/server/__tests__/settings-api.test.ts`
  - Delete `screenshot: true` (366) and `screenshot: false` (380, 390) entries from the `headerButtons` test payloads. Leave `code-graph-fuzzy.test.ts:57` and `proactive-recall.test.ts:222` — those "screenshot" mentions are inline debug notes about a fuzzy-search bug (not the feature).
- `electron/main.ts`
  - Delete `captureScreenshotRegion` (1641–1691), the `SCREENSHOT_PREVIEW_WIDTH_PX` constant (1633), and the two `safeHandle(IPC.screenshotCaptureRegion, …)` / `safeHandle(IPC.screenshotReadImage, …)` registrations (2019–2020). Keep `readTerminalImageForEdit` — it's still used by clipboard flows. Actually, `readTerminalImageForEdit` was only called from the annotator via `IPC.screenshotReadImage`; grep after edit — if there are no remaining callers, delete it and its helper `resolveTerminalImageFile` becomes only-used-by-copyToClipboard/delete and stays.
  - Drop the `spawn`, `nativeImage`, `systemPreferences` imports if no other consumer remains (verify — `nativeImage` is used by `saveTerminalNativeImage` and stays).
- `electron/preload.ts`
  - Delete the entire `screenshot: { captureRegion, readImage }` group (499–509).
- `electron/ipc-channels.ts`
  - Delete lines 16–17: `screenshotCaptureRegion`, `screenshotReadImage`.
- `src/shared/electron-contract.ts`
  - Delete `ScreenshotCaptureResult` union (324–327) and the `screenshot: { captureRegion, readImage }` group (558–563).
- `package.json` (build → `mac.extendInfo`)
  - Delete the `NSScreenCaptureUsageDescription` string (229). macOS will stop showing the "Actana Control wants to record your screen" prompt because no code path calls `screencapture` anymore.

## Schema changes

**None to the SQLite schema.** There is no `screenshots` table in `src/db/schema.ts`, `src/db/schema-bootstrap.ts`, or any of the 24 migration files. There are no `screenshotSoundEnabled` or `screenshotSaveDir` fields on `app_settings` — nothing to drop.

The only persisted state is:

- `window.localStorage["mc.screenshots"]` — a JSON array of `{ id, path, projectId, capturedAt, cropRect?, annotationShapes? }` (renderer-side only; not in DB).
- Files in the Electron `userData/terminal-images/` dir. These are shared with drag-drop image attach and are pruned by `pruneTerminalImagesDir`; **do not** delete them wholesale — a follow-up cleanup pass on the terminal-images dir can rely on the existing prune policy.
- The `AppSettings.headerButtons.screenshot` boolean, stored via the app-settings key/value store; this is dropped by `normalizeHeaderButtonVisibility` after `"screenshot"` leaves `HEADER_BUTTON_KEYS` (already defensively coded — unknown keys are ignored on read).

## Migration

No SQL migration is required because no table or column exists. A minimal renderer-side one-shot cleanup can live in `terminal-store.tsx` initialization (or an app-boot hook) as:

```ts
// One-shot cleanup for post-removal builds. Safe to run repeatedly.
try {
  window.localStorage.removeItem("mc.screenshots");
} catch {}
```

Optionally, if the file cleanup is desired: add a startup routine in `electron/main.ts` that removes any file matching `terminal-images/*-screenshot.png` older than N days — but the existing `pruneTerminalImagesDir` already caps the dir, so this is optional cosmetic.

If a placeholder SQL migration is preferred for hygiene / audit trail, add `src/db/migrations/0025_remove_screenshot.sql` as a comment-only file:

```sql
-- 0025_remove_screenshot.sql
-- No-op: the removed screenshot feature never had a DB table.
-- Renderer-side localStorage key "mc.screenshots" is cleared on boot
-- by src/lib/terminal-store.tsx.
SELECT 1;
```

(Recommendation: skip this file — an empty migration adds noise.)

## Entitlements / OS integration

- `build/entitlements.mac.plist` — **no screen-recording entitlement to remove**. The plist only lists JIT/dyld/library-validation/debugger entitlements plus `com.apple.security.device.audio-input` (mic). Screen recording on macOS is TCC-gated by usage description, not entitlement. Leave the plist alone.
- `package.json` → `build.mac.extendInfo.NSScreenCaptureUsageDescription` — **delete this key** (see Files to modify). Without it, Info.plist in the signed build will no longer advertise the Screen Recording purpose string.
- No `Info.plist` file is checked in — Info.plist is generated by electron-builder from `package.json`.

## IPC channels

Delete from `electron/ipc-channels.ts`:

- `screenshotCaptureRegion` (value `"screenshot:captureRegion"`)
- `screenshotReadImage` (value `"screenshot:readImage"`)

Delete handlers in `electron/main.ts`:

- `safeHandle(IPC.screenshotCaptureRegion, …)` → removes `captureScreenshotRegion`
- `safeHandle(IPC.screenshotReadImage, …)` → removes `readTerminalImageForEdit` (if no other caller; verify with grep after edit)

Delete preload exposures in `electron/preload.ts`:

- The whole `screenshot: { captureRegion, readImage }` block on the bridge object.

Delete corresponding contract types in `src/shared/electron-contract.ts`:

- `ScreenshotCaptureResult` union.
- `screenshot` group on the Electron API type.

## Keybindings

- `src/lib/keybindings/types.ts`: remove `"screenshot.capture"` from the `KeybindingAction` union (34) and the label/description map (128–132).
- `src/lib/keybindings/groups.ts`: remove `"screenshot.capture"` from the `session` group's `actions` (28).
- `src/lib/keybindings/defaults.ts`: remove the mod+Shift+S default binding (46); rewrite the adjacent comment on `project.ship` (~38) to drop the "mod+Shift+S is screenshot.capture" clue.

Any user's stored override for `"screenshot.capture"` in the keybindings-reader flow becomes an unknown action and should already be dropped by the reader's schema check — verify in `electron/keybindings-reader.ts`.

## Tests to remove

- `src/lib/__tests__/screenshot.test.ts` — the only dedicated screenshot test file.
- Edit `src/server/__tests__/settings-api.test.ts` to drop the three `screenshot: …` lines in header-button payloads.
- Do **not** touch `src/server/services/__tests__/code-graph-fuzzy.test.ts` or `proactive-recall.test.ts` — their "screenshot" mentions are inline war-story comments about a fuzzy-search regression, unrelated to the feature.
- Verify `electron/__tests__/file-handlers-sensitive.test.ts` still passes — it was returned by the initial grep but appears to reference sensitive-file handling generally; confirm no screenshot-specific assertion.

## Verification checklist

- `rg -i "screencapture|screenshotSupported|ScreenshotHistory|ScreenshotThumbnail|ScreenshotAnnotator|screenshot-capture\.mp3|screenshot-drop\.mp3|screenshot\.capture|NSScreenCaptureUsageDescription"` — zero hits in `src/`, `electron/`, `public/`, `package.json`, `build/`.
- `rg "mc\.screenshots"` returns only the boot-time cleanup line (if kept).
- `rg "addScreenshot|removeScreenshot|updateScreenshot|dismissPendingScreenshot|pendingScreenshots"` — zero hits.
- `UserTerminalPanel` renders: panel opens/closes, tabs switch between shells, no dangling "Screenshots" tab button, no console errors about missing `SCREENSHOT_PANEL_HEIGHT` or `ScreenshotHistoryContent`.
- Global tsc + eslint clean (`ScreenshotCaptureResult`, `PendingScreenshot`, `AnnotationShape` no longer imported anywhere).
- Fresh build produces no `dist/client/audio/screenshot-*.mp3` and no `dist/server/assets/screenshot-sound-*.js`.
- Signed macOS build's Info.plist has no `NSScreenCaptureUsageDescription`; first launch on a clean profile does **not** trigger the Screen Recording permission prompt.
- Drag-drop image attach on a session (`SessionDropzone`) still works (silent — no `playScreenshotDrop`); clipboard image paste into a terminal still works.

## Follow-ups / out of scope

The removed capture-and-attach flow will be replaced by a **Panel → Harness file transfer** primitive so operators on a control Panel can push arbitrary files (screenshots taken by any OS tool, logs, snippets) to a remote Harness's working session. That spec is deliberately **not** written here — it needs its own design pass covering:

- transport (over the existing core-link channel vs. a side channel),
- size caps and streaming,
- destination semantics (session inbox vs. project-scoped vs. one-off),
- OS-native capture is out of scope for Actana Control; users will bring their own screenshot tool.

Do not conflate that spec with this removal. Ship this removal first; the transfer spec lands independently.
