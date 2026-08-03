# Tickets — Spec 03 (Remove screenshot)

Parent spec: [`../specs/03-remove-screenshot.md`](../specs/03-remove-screenshot.md).

Five tickets. Ordered so each PR leaves `typecheck` and `test` green.
Mirrors the shape used by [`01-whisper.md`](./01-whisper.md) and
[`02-pet.md`](./02-pet.md): outward-facing callers first, then the atomic
core (types + controllers + shared), then cleanup, then the boot-time
schema cleanup DELETE.

---

## AC-03-01 — Delete screenshot renderer callers + UI mounts

**Depends on:** —

**Summary.** Unmount the region-capture flow from the renderer without
touching the electron engine or the terminal store. After this ticket
nothing in the Panel calls `window.electron.screenshot.*`, no camera
button is visible in project or focus headers, no `ScreenshotThumbnail`
floating stack renders, and the `UserTerminalPanel` "Screenshots" tab is
gone — but `terminal-store.tsx` still exports the screenshots state,
the `screenshot:*` IPC surface still exists, and the Electron main-side
handlers stay wired (they get torn out in AC-03-02 / AC-03-03).

**Files touched (indicative).**
- Delete: —
- Modify: `src/routes/__root.tsx` (drop `screenshotSupported` import
  and `ScreenshotThumbnail` import; delete the `screenshotsSupported`
  memo and the `{screenshotsSupported && <ScreenshotThumbnail
  projectId={projectId} />}` render),
  `src/routes/projects.$id.tsx` (drop imports
  `screenshotCaptureErrorMessage`, `screenshotFromResult`,
  `screenshotSupported`, `playScreenshotCapture`; delete the
  `screenshotSupported` memo, the `addScreenshot` / `captureScreenshot`
  callback, the `useHotkey("screenshot.capture", …)` binding, and the
  `{screenshotSupported && headerButtons.screenshot && (…)}` header
  camera-button render),
  `src/routes/focus.$taskId.tsx` (drop imports for
  `ScreenshotThumbnail`, `screenshotCaptureErrorMessage`,
  `screenshotFromResult`, `isScreenshotSupported`,
  `playScreenshotCapture`; delete the `screenshotSupported` /
  `captureScreenshot` block and its `useHotkey("screenshot.capture",
  …)`; drop the `showScreenshot` / `onCaptureScreenshot` props from the
  header component signature and its render; delete the
  `{screenshotSupported && <ScreenshotThumbnail … variant="focus" />}`
  render),
  `src/components/views/UserTerminalPanel.tsx` (drop
  `ScreenshotHistoryContent` import, `SCREENSHOT_PANEL_HEIGHT` constant,
  the `screenshots` destructure from `useTerminals()`, the
  `screenshotCount` memo, the `showScreenshots` state, the auto-fallback
  effect, the `prevScreenshotCount` ref + plus-one animation effect, the
  tab-click "returning from Screenshots view" branch, the
  `screenshotsVisible` / `onScreenshotsTabClick` locals, the
  `!screenshotsVisible` panel-body gate, the `showScreenshots ? false :`
  tab-`active` ternary, the `bodyIsScreenshots` / `bodyHeight`
  special-case, the entire "Screenshots" tab button block including its
  `screenshot-count` badge and `screenshot-plusone` animation, the
  `<ScreenshotHistoryContent projectId={project.id} />` render, and the
  `setShowScreenshots(false)` call in the resize-drag handler),
  `src/components/views/SessionDropzone.tsx` (drop `playScreenshotDrop`
  import and the `if (attached) playScreenshotDrop();` call — file-drag
  flow keeps working silently).

**Acceptance criteria.**
- `rg "ScreenshotThumbnail|ScreenshotHistory|ScreenshotHistoryContent|screenshotSupported|isScreenshotSupported|captureScreenshot|screenshotCaptureErrorMessage|screenshotFromResult|playScreenshotCapture|playScreenshotDrop|SCREENSHOT_PANEL_HEIGHT|screenshot\.capture"`
  returns zero hits in `src/routes/`, `src/components/views/`.
- Project header renders without the camera button; focus view renders
  without the camera button; `UserTerminalPanel` opens/closes with no
  dangling "Screenshots" tab and no console errors about missing
  `SCREENSHOT_PANEL_HEIGHT` or `ScreenshotHistoryContent`; drag-drop
  image attach on a session still works silently.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** `ScreenshotAnnotator.tsx`, `ScreenshotHistory.tsx`,
`ScreenshotThumbnail.tsx`, `screenshot.ts`, `screenshot-sound.ts`, and
the audio assets are deleted in AC-03-02 — leaving them in-tree for one
ticket keeps this PR's diff scoped to caller unwiring.

---

## AC-03-02 — Delete screenshot renderer library, components, audio assets, and terminal-store surface

**Depends on:** AC-03-01

**Summary.** The atomic core removal on the renderer side. Deletes the
now-orphan `screenshot.ts` / `screenshot-sound.ts` helpers, the three
big screenshot components (`ScreenshotAnnotator`, `ScreenshotHistory`,
`ScreenshotThumbnail`), the two audio assets, and the entire
screenshots state surface on `terminal-store.tsx` — its types
(`ScreenshotEntry`, `PendingScreenshot`, `ScreenshotMeta`), state
hooks, callbacks (`addScreenshot`, `updateScreenshot`,
`dismissPendingScreenshot`, `removeScreenshot`), the `SCREENSHOTS_KEY`
+ `loadScreenshotMeta` / `saveScreenshotMeta` localStorage plumbing,
the on-mount preview-reload effect that calls
`electron.screenshot.readImage`, and the six names on the store's
context-value objects. Renderer is already off these surfaces from
AC-03-01, so the type removal lands green.

**Files touched (indicative).**
- Delete: `src/lib/screenshot.ts`,
  `src/lib/screenshot-sound.ts`,
  `src/lib/__tests__/screenshot.test.ts`,
  `src/components/views/ScreenshotAnnotator.tsx`,
  `src/components/views/ScreenshotHistory.tsx`,
  `src/components/views/ScreenshotThumbnail.tsx`,
  `public/audio/screenshot-capture.mp3`,
  `public/audio/screenshot-drop.mp3`.
- Modify: `src/lib/terminal-store.tsx` (drop `screenshotSupported`
  import and the `AnnotationShape` type import from
  `ScreenshotAnnotator`; delete `ScreenshotEntry`, `PendingScreenshot`,
  `ScreenshotMeta` types; remove `screenshots`, `pendingScreenshots`,
  `addScreenshot`, `updateScreenshot`, `dismissPendingScreenshot`,
  `removeScreenshot` from the store interface and from the
  `"screenshots"` / `"pendingScreenshots"` entries of the excluded-keys
  union; delete `SCREENSHOTS_KEY = "mc.screenshots"`,
  `loadScreenshotMeta`, `saveScreenshotMeta`; delete state hooks
  `screenshots`, `screenshotsRef`, `screenshotSeq`,
  `pendingScreenshotIds`, the `saveScreenshotMeta` effect, and the
  on-mount preview-reload effect that calls
  `electron.screenshot.readImage`; delete the `addScreenshot`,
  `updateScreenshot`, `dismissPendingScreenshot`, `removeScreenshot`
  callbacks and the `pendingScreenshots` memo; delete those six names
  from the store's context-value objects — leave `attachImageToSession`
  intact for the drag-drop path).

**Acceptance criteria.**
- `rg "ScreenshotAnnotator|ScreenshotHistory|ScreenshotThumbnail|screenshotSupported|ScreenshotEntry|PendingScreenshot|ScreenshotMeta|AnnotationShape|SCREENSHOTS_KEY|loadScreenshotMeta|saveScreenshotMeta|addScreenshot|removeScreenshot|updateScreenshot|dismissPendingScreenshot|pendingScreenshots"`
  returns zero hits in `src/`.
- `rg "screenshot-capture\.mp3|screenshot-drop\.mp3"` returns zero
  hits in `src/`, `public/`.
- Fresh build produces no `dist/client/audio/screenshot-*.mp3` and no
  `dist/server/assets/screenshot-sound-*.js`.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** `attachImageToSession` on the terminal store stays — it
survives for the drag-drop / clipboard image-attach path. The
`mc.screenshots` localStorage key is not cleared here; the one-shot
renderer-side cleanup lands in AC-03-04 (and the boot-time
schema-side no-op is in AC-03-05 — recorded there for parity with
specs 01 / 02 even though this feature never had a SQLite table).

---

## AC-03-03 — Retire screenshot Electron IPC + contract types + macOS Info.plist string

**Depends on:** AC-03-02, [`AC-01-02`](./01-whisper.md#ac-01-02--retire-whisper-server-engine--electron-voice-ipc--mac-entitlements)

**Summary.** Cut the entire Electron surface. Deletes
`captureScreenshotRegion` and the two `safeHandle(IPC.screenshot*, …)`
registrations in `electron/main.ts`, the `screenshot: { captureRegion,
readImage }` bridge in `electron/preload.ts`, the two `screenshot*` IPC
channels, the `ScreenshotCaptureResult` union and the `screenshot`
group on the Electron contract, and the
`NSScreenCaptureUsageDescription` string in `package.json`'s
`build.mac.extendInfo`. Renderer is already off the bridge (AC-03-02),
so the contract-type removal lands green. macOS stops showing the
"Actana Control wants to record your screen" prompt on first launch
because no code path calls `screencapture` anymore.

**Files touched (indicative).**
- Delete: —
- Modify: `electron/main.ts` (delete `captureScreenshotRegion` and the
  `SCREENSHOT_PREVIEW_WIDTH_PX` constant; delete the two
  `safeHandle(IPC.screenshotCaptureRegion, …)` and
  `safeHandle(IPC.screenshotReadImage, …)` registrations; grep for
  remaining callers of `readTerminalImageForEdit` — if none survive,
  delete it too, but keep `resolveTerminalImageFile`,
  `copyTerminalImageToClipboard`, `deleteTerminalImageFile`,
  `saveTerminalNativeImage`, `terminalImagesDir`, and
  `pruneTerminalImagesDir` — they back the drag-drop / clipboard image
  attach for CLI paste; drop the `spawn` and `systemPreferences`
  imports if no other consumer remains; keep `nativeImage` — it is
  used by `saveTerminalNativeImage`),
  `electron/preload.ts` (delete the entire `screenshot: { captureRegion,
  readImage }` bridge group),
  `electron/ipc-channels.ts` (delete `screenshotCaptureRegion` and
  `screenshotReadImage` entries),
  `src/shared/electron-contract.ts` (delete the
  `ScreenshotCaptureResult` union and the `screenshot: { captureRegion;
  readImage }` group on the Electron API type),
  `package.json` (delete `build.mac.extendInfo.NSScreenCaptureUsageDescription`).

**Acceptance criteria.**
- `rg "screencapture|captureScreenshotRegion|SCREENSHOT_PREVIEW_WIDTH_PX|screenshot:captureRegion|screenshot:readImage|screenshotCaptureRegion|screenshotReadImage|ScreenshotCaptureResult|window\.electron\.screenshot"`
  returns zero hits.
- `rg "NSScreenCaptureUsageDescription"` returns zero hits in
  `package.json`, `build/`.
- Signed macOS build's Info.plist has no `NSScreenCaptureUsageDescription`;
  first launch on a clean profile does **not** trigger the Screen
  Recording permission prompt.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** Cross-spec ordering: this ticket depends on
[`AC-01-02`](./01-whisper.md#ac-01-02--retire-whisper-server-engine--electron-voice-ipc--mac-entitlements)
because both edit `build/entitlements.mac.plist` (whisper) and
`package.json` `build.mac.extendInfo` (whisper mic string vs. this
ticket's screen-recording string). Whisper lands first per the
execution order in [`README.md`](./README.md); sequencing this after
AC-01-02 avoids a merge. `build/entitlements.mac.plist` itself is
**not** modified here — the plist has no screen-recording entitlement
(screen recording is TCC-gated by usage description, not entitlement).

---

## AC-03-04 — Retire screenshot AppSettings surface, keybindings, hideable-elements (atomic)

**Depends on:** AC-03-03

**Summary.** Atomic cleanup of the shared / settings surface. Drops
`"screenshot"` from `HEADER_BUTTON_KEYS` and its `screenshot: true`
default-visibility entry, the `screenshot` entry in the
`InterfaceSettingsPage` header-button settings map, the
`screenshot: "screenshot button"` entry in `hideable-elements`, the
`"screenshot.capture"` action from the keybindings union / groups /
defaults (rewriting the adjacent `project.ship` comment on mod+Shift+S
to only reference the `file.save` collision), and the three
`screenshot: …` lines from the header-button payloads in
`settings-api.test.ts`. The type surface only reconciles if these land
together — dropping `"screenshot"` from `HEADER_BUTTON_KEYS` shifts the
persisted `AppSettings.headerButtons` shape, and any stray consumer
would fail typecheck.

**Files touched (indicative).**
- Delete: —
- Modify: `src/shared/header-buttons.ts` (drop `"screenshot"` from
  `HEADER_BUTTON_KEYS` and the `screenshot: true` entry in
  `DEFAULT_HEADER_BUTTON_VISIBILITY`),
  `src/components/views/InterfaceSettingsPage.tsx` (drop the
  `screenshot` entry in the header-button settings map and the
  `{headerButtonRow("screenshot")}` call),
  `src/lib/hideable-elements.tsx` (drop
  `screenshot: "screenshot button"` and any label plumbing that
  references it),
  `src/lib/keybindings/types.ts` (remove `"screenshot.capture"` from
  the actions union and delete its label/description entry),
  `src/lib/keybindings/groups.ts` (remove `"screenshot.capture"` from
  the `session` group `actions`),
  `src/lib/keybindings/defaults.ts` (delete the
  `"screenshot.capture": makeBinding({ mod: true, shift: true, key: "s" })`
  entry; rewrite the adjacent mod+Shift+S comment on `project.ship` to
  only note the collision with `file.save`),
  `src/server/__tests__/settings-api.test.ts` (delete the three
  `screenshot: true` / `screenshot: false` lines in the `headerButtons`
  test payloads — leave `code-graph-fuzzy.test.ts:57` and
  `proactive-recall.test.ts:222` alone; those "screenshot" mentions are
  inline war-story comments about a fuzzy-search bug, not the feature).

**Acceptance criteria.**
- `rg "\"screenshot\"|screenshot\.capture"` under `src/shared/`,
  `src/components/views/`, `src/lib/keybindings/`,
  `src/lib/hideable-elements.tsx`, `src/server/__tests__/` returns
  zero hits.
- Interface Settings page still renders; the screenshot header-button
  row is absent; the keybindings surface still opens and mod+Shift+S is
  free (still shadowed by `file.save`); `settings-api.test.ts` still
  passes.
- Any user's stored override for `"screenshot.capture"` in the
  keybindings-reader flow becomes an unknown action and is dropped by
  the reader's schema check — verify in `electron/keybindings-reader.ts`.
- `pnpm typecheck` and `pnpm test` green.

---

## AC-03-05 — Schema-bootstrap: one-shot cleanup of `mc.screenshots` localStorage key

**Depends on:** AC-03-04

**Summary.** Add a one-shot idempotent boot-time cleanup that removes
the renderer-side `window.localStorage["mc.screenshots"]` key so old
JSON payloads do not linger on upgraded installs. Follows the fork
convention ("we don't ship migration files to the user") — this is
code in the renderer boot path (`terminal-store.tsx` initialization
or an app-boot hook), not a numbered SQL migration file. **No SQL
migration is added**: no `screenshots` table ever existed in
`src/db/schema.ts`, `src/db/schema-bootstrap.ts`, or any of the 24
migration files; there are no `screenshotSoundEnabled` /
`screenshotSaveDir` fields on `app_settings` to drop. The
`terminal-images/` directory is shared with drag-drop image attach and
is already capped by `pruneTerminalImagesDir` — do **not** wipe it.

**Files touched (indicative).**
- Delete: —
- Modify: `src/lib/terminal-store.tsx` (or the app-boot module — pick
  whichever runs exactly once per renderer boot) — add:
  ```ts
  // One-shot cleanup for post-removal builds. Safe to run repeatedly.
  try {
    window.localStorage.removeItem("mc.screenshots");
  } catch {}
  ```
  Document that the block stays in the tree for one release, matching
  the AC-01-05 / AC-02-05 convention.

**Acceptance criteria.**
- Booting the Panel against a pre-cutover profile (with
  `window.localStorage["mc.screenshots"]` present) leaves the key
  absent after first render.
- Booting against a fresh profile runs the `removeItem` without error
  and produces no console warning.
- `rg "mc\.screenshots"` in `src/` returns only the boot-time cleanup
  line.
- `rg -i "screencapture|screenshotSupported|ScreenshotHistory|ScreenshotThumbnail|ScreenshotAnnotator|screenshot-capture\.mp3|screenshot-drop\.mp3|screenshot\.capture|NSScreenCaptureUsageDescription"`
  returns zero hits in `src/`, `electron/`, `public/`, `package.json`,
  `build/` (spec-level verification line).
- `pnpm typecheck` and `pnpm test` green.

**Notes.** Per the parent spec, a placeholder SQL migration
(`0025_remove_screenshot.sql` as a comment-only file) is explicitly
**not** added — an empty migration adds noise. The `screenshot.mjs`
Puppeteer dev-tool at the repo root is unrelated to the in-app feature
and stays. This cleanup block stays in the tree for one release, then
is removed by a follow-up ticket (tracked as AC-CLEANUP-01 in the
rebrand set).
