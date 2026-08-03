---
spec: 06
title: Remove IDE-adjacent features (file editor, file finder, HTML preview, markdown annotator)
status: draft
part-of: ADR 0007 scope narrowing
---

## Overview

Actana Control is a harness remote control, not a partial IDE — users edit files in their own editor. Rip out the in-app file finder, file editor, HTML preview, markdown annotation editor / refine flow, and the loopback preview server that backs the HTML iframe. `MarkdownPreview` is only used inside `FileEditorDialog` → `MarkdownAnnotator`; it goes with them.

## Files to delete

Renderer components (all standalone-viewer entry points):
- `src/components/views/FileEditorDialog.tsx`
- `src/components/views/FileFinderDialog.tsx`
- `src/components/views/HtmlPreview.tsx`
- `src/components/views/MarkdownPreview.tsx` — checked: only imported by `FileEditorDialog` and `MarkdownAnnotator` (verified via `grep -rn MarkdownPreview src/`). Task descriptions do NOT use it. Safe to delete.
- `src/components/views/MarkdownAnnotator.tsx`
- `src/components/views/AnnotationsPanel.tsx` — checked: only imported by `MarkdownAnnotator`. The screenshot annotator (`ScreenshotHistory.tsx`) uses `ScreenshotAnnotator` + `type Shape as AnnotationShape`, a distinct component tree owned by spec 03. No cross-import.

Renderer lib backing files (only used by the above):
- `src/lib/file-fuzzy.ts` — used by `FileFinderDialog` AND by `src/lib/project-match.ts` (`fuzzyScore`, `FUZZY_SCORE_MAX`). **Keep** if `project-match` survives; only if `project-match` is orphaned by another spec can this go. Flag for verification.
- `src/lib/file-language.ts` — used only by `FileEditorDialog` (CodeMirror language selector). Delete.
- `src/lib/file-tree.ts` — used only by `FileFinderDialog`. Delete.
- `src/lib/file-preview.ts` (`isMarkdownFilename`, `isHtmlFilename`, `buildHtmlPreviewSrcDoc`, `detectUnrenderableTemplate`) — used only by `FileEditorDialog` and `HtmlPreview`. Delete.
- `src/lib/markdown-annotations.ts` — used only by `MarkdownAnnotator` and `AnnotationsPanel`. Delete.
- `src/lib/ui-preference-cache.ts` — DO NOT delete; only remove the `FILE_FINDER_VIEW_STORAGE_KEY`, `fileFinderView`, `readCachedFileFinderView`, `writeCachedFileFinderView` exports (file-modify, not file-delete).

Shared contract:
- `src/shared/markdown-refine.ts` (types + `MARKDOWN_REFINE_MAX_ANNOTATIONS`, `MARKDOWN_REFINE_NOTE_MAX_LEN`, `MarkdownRefineRequest`, `MarkdownRefineResponse`) — used by the deleted components and by server refine flow. Delete once server side goes.

Server-side markdown refine (only the annotator called it):
- `src/server/controllers/markdown.controller.ts`
- `src/server/services/markdown-refiner.ts`

Electron main:
- `electron/preview-server.ts` (loopback HTTP server for `HtmlPreview` — sole caller)
- `electron/file-handlers.ts` — DO NOT delete outright; see "Files to modify". No non-IDE caller of `api.files.*` exists in the renderer (verified: only `src/lib/project-fs.ts` wraps it, only `FileEditorDialog` and `FileFinderDialog` call the wrappers). Server-side `fs.readFileSync` uses in `src/server/services/**` bypass the IPC entirely, so removing `file-handlers.ts` does not touch settings import/export, git, code-graph, provider-usage, etc. Delete `file-handlers.ts` in full.

Tests:
- `electron/__tests__/preview-server.test.ts`
- `electron/__tests__/file-handlers-read-limit.test.ts`
- `electron/__tests__/file-handlers-sensitive.test.ts` — the sensitive-write path exists only for `FileEditorDialog` (`writeProjectFileSensitive` has no other caller). Delete along with the handler.
- `src/lib/__tests__/file-fuzzy.test.ts` — delete unless `project-match` is retained; if retained, keep.
- `src/lib/__tests__/file-language.test.ts`
- `src/lib/__tests__/file-preview.test.ts`
- `src/lib/__tests__/file-tree.test.ts`
- `src/lib/__tests__/markdown-annotations.test.ts`

## Files to modify

`src/routes/projects.$id.tsx`
- Remove imports of `FileFinderDialog`, the lazy `FileEditorDialog`, and the `~/components/views/FileFinderDialog` / `FileEditorDialog` references.
- Delete state: `fileFinderOpen`, `setFileFinderOpen`, `fileFinderResetKey`, `setFileFinderResetKey`, `openFileFinderFresh` (~line 685–688).
- Delete the header button block guarded by `headerButtons.fileFinder` (~line 3460–3475) and the `HotkeyTooltip action="file.finder"` uses (~line 3199).
- Delete the `useHotkey("file.finder", ...)` binding (~line 1906–1911).
- Delete the `<FileFinderDialog />` and `<FileEditorDialog />` mount points (~line 3966, 3976).
- Remove `fileFinderOpen` from any composite "any modal open" gate (~line 2153).

`src/lib/project-fs.ts`
- Drop `listProjectFiles`, `readProjectFile`, `writeProjectFile`, `writeProjectFileSensitive`, `watchProjectFile`, `startHtmlPreviewServer`.
- **Keep** `sandboxContainerRoot` and `isSandboxRuntimeActive` — used by `src/components/views/GitDiffView/index.tsx` and `src/lib/project-git.ts`.
- File retains its purpose (sandbox routing helpers), just no longer routes file IO.

`src/lib/hideable-elements.tsx`
- Remove the `fileFinder: "find file button"` entry from `HEADER_BUTTON_LABELS`.

`src/shared/header-buttons.ts`
- Remove `"fileFinder"` from `HEADER_BUTTON_KEYS`, `HeaderButtonVisibility`, and `DEFAULT_HEADER_BUTTON_VISIBILITY`. `normalizeHeaderButtonVisibility` handles stale values automatically.

`src/components/views/InterfaceSettingsPage.tsx`
- Remove the `fileFinder: {...}` entry from the visibility labels map (~line 81) and the `{headerButtonRow("fileFinder")}` render (~line 153).

`src/lib/keybindings/types.ts`
- Delete `"file.finder"` and `"file.save"` from `HOTKEY_ACTIONS` and their `ACTION_META` entries.

`src/lib/keybindings/defaults.ts`
- Delete `"file.finder": makeBinding({ mod: true, key: "p" })` and `"file.save": makeBinding({ mod: true, key: "s" })` (lines 33–34). Update the neighboring comment (line 37) that references `file.save`.

`src/lib/keybindings/groups.ts`
- Remove `"file.finder"` and `"file.save"` from their group entries (lines 50–51). The `HOTKEY_ACTIONS.length` invariant check at 74–75 stays valid.

`src/server/controllers/settings.controller.ts`
- Delete `ANNOTATION_AGENT_SETTING_KEY` (`"annotation_agent"`) and `ANNOTATION_MODEL_SETTING_KEY` (`"annotation_model"`).
- Delete `getAnnotationAgentSetting`, `getAnnotationModelSetting`, the `annotationAgent`/`annotationModel` fields on the settings schema, on the GET response payload, and the two mutation branches at ~line 852–860.

`src/components/views/DefaultsSettingsPage.tsx`
- Remove all `annotationAgent`/`annotationModel` UI: the currentAnnotationAgent/Model reads (~77–78), the union member in the mutation-key type (~165–166), the "Markdown annotation refine" row (~370–385), and the recovery branch at ~697 that swallows the "Unrecognized key" server error.

`src/components/views/TerminalSettingsPage.tsx`, `src/components/views/ThemeSettingsPage.tsx`
- Drop the passthrough `annotationAgent`/`annotationModel` fields from the local settings echo (both pages just forward them; after the schema drop they must not be sent).

`src/lib/api.ts`
- Delete the `refineMarkdown` client (~line 797–798) and the `MarkdownRefineRequest`/`MarkdownRefineResponse` re-exports (~line 51).

`src/server/api-router.ts`
- Delete the `markdownController` import (~line 37) and the `/api/markdown/refine` route (~line 473–475).

`src/server/services/recall-engine.ts`
- Remove the incidental comment reference to `markdown-refiner.ts` (~line 17).

`electron/main.ts`
- Remove `registerFileHandlers`, `disposeAllFileWatchers` import + `registerFileHandlers(ipcMain, () => win)` call (~line 35, 2154) and the `disposeAllFileWatchers()` teardown (~line 2480).
- Remove `startPreviewServer`, `disposeAllPreviewServers` import + `safeHandle(IPC.previewStartServer, ...)` (~line 36, 2161) and the `disposeAllPreviewServers()` teardown (~line 2481).
- The `pickImage` / screenshot-adjacent `previewDataUrl` blocks around lines 1642–1781 are screenshot territory — spec 03. Leave them alone here.

`electron/preload.ts`
- Delete the entire `files: {...}` block (~line 720–790) and the `preview: {...}` block (~line 791–796) from the `electronAPI` object.

`src/shared/electron-contract.ts`
- Delete `FileListResult`, `FileReadResult`, `FileWriteResult` and the surrounding `files:*` documentation comments (~line 20–35, 561). The `screencapture-preview` copy that overloads "preview" belongs to spec 03.

`electron/ipc-channels.ts`
- Delete `filesList`, `filesRead`, `filesWrite`, `filesWriteSensitive`, `filesWatch`, `filesUnwatch`, `filesChanged`, `previewStartServer` (lines 48–55).

`electron/__tests__/preview-server.test.ts` — delete (see "Tests to remove").

## Schema changes

No dedicated `annotations` table exists in `src/db/migrations/*` (`grep -rn annotations src/db` returns nothing). Annotations are in-memory state inside `MarkdownAnnotator` (via `src/lib/markdown-annotations.ts`). Nothing to drop table-wise.

`app_settings` rows to drop by key:
- `annotation_agent`
- `annotation_model`

There are no file-viewer-specific settings rows (`FILE_FINDER_VIEW_STORAGE_KEY = "mc:fileFinderView"` is a localStorage key on the renderer, not an `app_settings` row — cleaned by removing the export; browser storage decays naturally on next release).

There is no keybindings-table row per action; `HOTKEY_ACTIONS` becomes the source of truth so orphan overrides for `file.finder` / `file.save` in `app_settings` under `keybindings:*` keys are ignored automatically by the reader. If the migration wants to be defensive, an explicit delete is possible (see below).

## Migration

`src/db/migrations/0025_remove_ide_adjacent.sql`:

```sql
-- 06-remove-ide-adjacent: drop app_settings rows for the retired markdown
-- annotation refine flow. No annotations table exists (annotations were only
-- ever in-memory state in the file editor's MarkdownAnnotator). Keybindings
-- for the deleted `file.finder` / `file.save` actions are stored inside the
-- serialized `keybindings:*` app_settings blobs owned by `services/keybindings`
-- and are ignored by the reader once the action names are removed from
-- HOTKEY_ACTIONS — no separate delete needed, but we clear them opportunistically
-- so a settings dump doesn't show orphan keys.

DELETE FROM app_settings WHERE key IN (
  'annotation_agent',
  'annotation_model'
);

-- Best-effort scrub: rewrite each keybinding scope blob to drop file.finder /
-- file.save keys. json_remove is a no-op when the path is absent.
UPDATE app_settings
   SET value = json_remove(value, '$."file.finder"', '$."file.save"')
 WHERE key LIKE 'keybindings:%';
```

Consolidated with the other removal specs into the single forward-only migration bundle per ADR 0007.

## IPC channels

Remove from `electron/ipc-channels.ts`:
- `filesList` (`files:list`)
- `filesRead` (`files:read`)
- `filesWrite` (`files:write`)
- `filesWriteSensitive` (`files:writeSensitive`)
- `filesWatch` (`files:watch`)
- `filesUnwatch` (`files:unwatch`)
- `filesChanged` (`files:changed`, push)
- `previewStartServer` (`preview:startServer`) — backing the HtmlPreview loopback HTTP server; ephemeral port picked per-project inside `preview-server.ts` (`IDLE_TIMEOUT_MS = 10 * 60_000`, allow-listed Host header, loopback bind). Entire server + handler + `IPC.previewStartServer` go.

Do NOT touch `remoteFs:*` — that's the sandbox agent RPC channel used by GitDiffView (git.diff/status) and stays.

## Keybindings

Remove actions (`src/lib/keybindings/types.ts`, `defaults.ts`, `groups.ts`):
- `file.finder` — default `mod+p`
- `file.save` — default `mod+s`

No annotation-specific hotkey exists (annotations were mouse/selection-driven inside `MarkdownAnnotator`).

## Tests to remove

- `electron/__tests__/preview-server.test.ts`
- `electron/__tests__/file-handlers-read-limit.test.ts`
- `electron/__tests__/file-handlers-sensitive.test.ts` — this suite exists solely because `FileEditorDialog` needed a native-confirm write path for `.claude/settings.local.json`, `.git/hooks/*`, etc. No other renderer or main-process code calls `filesWriteSensitive`. Once the editor is gone, the entire sensitive-abs/rel classifier goes with `file-handlers.ts`.
- `src/lib/__tests__/file-language.test.ts`
- `src/lib/__tests__/file-preview.test.ts`
- `src/lib/__tests__/file-tree.test.ts`
- `src/lib/__tests__/markdown-annotations.test.ts`
- `src/lib/__tests__/file-fuzzy.test.ts` — conditional; keep if `project-match` keeps using `fuzzyScore`.

## Verification checklist

- [ ] `grep -rn "FileEditorDialog\|FileFinderDialog\|HtmlPreview\|MarkdownAnnotator\|AnnotationsPanel\|MarkdownPreview" src electron` returns zero hits after the change.
- [ ] `grep -rn "file\.finder\|file\.save" src` returns zero hits; the keybindings rebind UI does not list the actions.
- [ ] `grep -rn "files:\(list\|read\|write\|watch\|unwatch\|changed\|writeSensitive\)\|preview:startServer" src electron` returns zero hits; `IPC.filesRead` etc. no longer resolve at TypeScript compile.
- [ ] `pnpm typecheck` passes — the deleted preload `files` / `preview` surface is not referenced by any renderer code.
- [ ] `pnpm test` runs green with the removed test files gone; no orphan skipped suites remain in `electron/__tests__/` or `src/lib/__tests__/`.
- [ ] Launching the app shows no "Find file" button in the project header, `Cmd+P` and `Cmd+S` are unbound (Interface Settings → Keybindings page hides both rows), and clicking a file in the git diff view does NOT open an editor.
- [ ] Settings → Defaults page no longer shows the "Markdown annotation refine" harness/model row; the `/api/markdown/refine` route 404s (or the `refineMarkdown` client is gone).
- [ ] `netstat -an | grep 127.0.0.1` after launch does not show an extra loopback port from `preview-server` (only Vite + Core-link + main API).
- [ ] Sandbox mode still opens `GitDiffView` and reads files over `remoteFs:*` — untouched by this spec.

## Follow-ups / out of scope

- **Screenshot annotator** (`ScreenshotAnnotator`, `type Shape as AnnotationShape`, `CropBox`, `ScreenshotHistory`, `saved-screenshot-read` IPC, `previewDataUrl` blocks around `electron/main.ts:1642–1781`) belongs to spec 03 (screenshot removal). Do not touch here.
- **`project-fs.ts` sandbox helpers** (`sandboxContainerRoot`, `isSandboxRuntimeActive`) stay: consumed by `GitDiffView` and `src/lib/project-git.ts`. Only the file-IO wrappers are stripped.
- **`remoteFs:*` and `remoteGit:*` IPC** and the sandbox-agent RPC on the other side of them stay: they power `GitDiffView` in Docker sandbox mode, a retained feature. Do not delete.
- **Server-side `fs.readFileSync` usage** in `src/server/services/**` (settings import/export, git, code-graph, provider-usage, claude-usage-limits, agent-accounts) does NOT go through `files:*` IPC — it runs in-process against the local filesystem. Untouched.
- **`file-fuzzy.ts`** ranking is also imported by `src/lib/project-match.ts` (project name fuzzy match). If a downstream spec kills project-match, delete `file-fuzzy.ts` there.
- **The `mc:fileFinderView` localStorage key** on already-installed clients decays naturally (no reader after this spec). No renderer cleanup needed.
- **Keybindings scrub inside `app_settings.keybindings:*`** is best-effort in the migration — the reader ignores unknown actions, so an untouched row is functionally fine.
