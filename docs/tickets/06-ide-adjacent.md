# Tickets — Spec 06 (Remove IDE-adjacent features)

Parent spec: [`../specs/06-remove-ide-adjacent.md`](../specs/06-remove-ide-adjacent.md).

Five tickets. Ordered so each PR leaves `typecheck` and `test` green.
Mirrors the shape used by [`01-whisper.md`](./01-whisper.md) and
[`02-pet.md`](./02-pet.md): outward-facing renderer callers first, then
the electron engine + IPC, then the atomic `AppSettings` + shared
contract + server controller reconciliation, then keybindings /
visibility cleanup, and finally styles / comments / schema-bootstrap.

> **Cross-spec conflict.** Spec 06 and [spec 03 (screenshot removal)](../specs/03-remove-screenshot.md)
> both edit `electron/main.ts`, `electron/preload.ts`,
> `electron/ipc-channels.ts`, `src/shared/electron-contract.ts`,
> `src/shared/header-buttons.ts`, `src/lib/hideable-elements.tsx`, and
> `src/lib/keybindings/*`. These two specs **MUST land sequentially**,
> not in parallel — whichever ships second rebases onto the first. Do
> not open PRs from both spec branches at the same time.

---

## AC-06-01 — Unmount file editor / file finder / HTML preview / annotator from the renderer

**Depends on:** —

**Summary.** Take the IDE-adjacent surface off the screen without
touching electron, IPC, or the `AppSettings` schema. After this ticket
the project route no longer mounts `FileFinderDialog` or
`FileEditorDialog`, the "Find file" header button is gone, the
`file.finder` hotkey no-ops (it is unbound in AC-06-04), and the
components + their renderer-only backing libs are deleted — but the
electron `files:*` / `preview:startServer` handlers, the shared
`electron-contract` file types, the settings-controller annotation
keys, and the `/api/markdown/refine` route are all still wired (they
come out in AC-06-02 and AC-06-03).

**Files touched (indicative).**
- Delete: `src/components/views/FileEditorDialog.tsx`,
  `src/components/views/FileFinderDialog.tsx`,
  `src/components/views/HtmlPreview.tsx`,
  `src/components/views/MarkdownPreview.tsx`,
  `src/components/views/MarkdownAnnotator.tsx`,
  `src/components/views/AnnotationsPanel.tsx`,
  `src/lib/file-language.ts`,
  `src/lib/file-tree.ts`,
  `src/lib/file-preview.ts`,
  `src/lib/markdown-annotations.ts`,
  `src/lib/__tests__/file-language.test.ts`,
  `src/lib/__tests__/file-preview.test.ts`,
  `src/lib/__tests__/file-tree.test.ts`,
  `src/lib/__tests__/markdown-annotations.test.ts`.
- Modify: `src/routes/projects.$id.tsx` — drop
  `FileFinderDialog` + lazy `FileEditorDialog` imports; delete the
  `fileFinderOpen` / `setFileFinderOpen` / `fileFinderResetKey` /
  `setFileFinderResetKey` / `openFileFinderFresh` state (~lines
  685–688); delete the header button block guarded by
  `headerButtons.fileFinder` (~lines 3460–3475) and the
  `HotkeyTooltip action="file.finder"` uses (~line 3199); delete the
  `useHotkey("file.finder", …)` binding (~lines 1906–1911); delete the
  `<FileFinderDialog />` and `<FileEditorDialog />` mount points
  (~lines 3966, 3976); drop `fileFinderOpen` from the composite
  "any modal open" gate (~line 2153).
- Modify `src/lib/ui-preference-cache.ts` — remove the
  `FILE_FINDER_VIEW_STORAGE_KEY` constant, the `fileFinderView` type,
  and the `readCachedFileFinderView` / `writeCachedFileFinderView`
  exports (file-modify, not file-delete — the module survives for
  other callers).

**Acceptance criteria.**
- `rg "FileEditorDialog|FileFinderDialog|HtmlPreview|MarkdownAnnotator|AnnotationsPanel|MarkdownPreview"`
  in `src/` returns zero hits.
- `rg "FILE_FINDER_VIEW_STORAGE_KEY|fileFinderView|readCachedFileFinderView|writeCachedFileFinderView|openFileFinderFresh|fileFinderResetKey"`
  in `src/` returns zero hits.
- The project route still renders; no "Find file" button in the
  header; clicking a file in `GitDiffView` no longer opens an editor.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** `src/lib/file-fuzzy.ts` and its test are **NOT** deleted
here — `src/lib/project-match.ts` still imports `fuzzyScore` /
`FUZZY_SCORE_MAX`. Removal is deferred to whichever downstream spec
retires `project-match`. `src/lib/project-fs.ts` is trimmed in
AC-06-02 (its file-IO wrappers only reconcile once the electron
handlers go).

---

## AC-06-02 — Delete electron file-handlers + preview server + `files:*` / `preview:*` IPC

**Depends on:** AC-06-01

**Summary.** Cut the electron engine and IPC surface. Deletes
`electron/file-handlers.ts` (including the sensitive-write classifier),
`electron/preview-server.ts` (loopback HTTP server that backed
`HtmlPreview`), the eight `files:*` + `preview:startServer` IPC
channels, the preload `files: {…}` and `preview: {…}` bridges, and the
renderer wrappers in `src/lib/project-fs.ts`. Renderer is already off
the bridge (AC-06-01), so the preload / contract removal lands green.

**Files touched (indicative).**
- Delete: `electron/file-handlers.ts`,
  `electron/preview-server.ts`,
  `electron/__tests__/preview-server.test.ts`,
  `electron/__tests__/file-handlers-read-limit.test.ts`,
  `electron/__tests__/file-handlers-sensitive.test.ts`.
- Modify `electron/main.ts` — drop the `registerFileHandlers` +
  `disposeAllFileWatchers` import and the
  `registerFileHandlers(ipcMain, () => win)` call (~lines 35, 2154);
  drop the `startPreviewServer` + `disposeAllPreviewServers` import
  and the `safeHandle(IPC.previewStartServer, …)` block (~lines 36,
  2161); drop the `disposeAllFileWatchers()` and
  `disposeAllPreviewServers()` shutdown calls (~lines 2480–2481).
  **Leave the `pickImage` / `previewDataUrl` screenshot blocks around
  lines 1642–1781 alone** — spec 03 owns them.
- Modify `electron/preload.ts` — delete the entire `files: {…}` block
  (~lines 720–790) and the `preview: {…}` block (~lines 791–796) from
  the `electronAPI` object.
- Modify `electron/ipc-channels.ts` — delete `filesList`, `filesRead`,
  `filesWrite`, `filesWriteSensitive`, `filesWatch`, `filesUnwatch`,
  `filesChanged`, `previewStartServer` (lines 48–55).
- Modify `src/lib/project-fs.ts` — drop `listProjectFiles`,
  `readProjectFile`, `writeProjectFile`, `writeProjectFileSensitive`,
  `watchProjectFile`, and `startHtmlPreviewServer`. **Keep**
  `sandboxContainerRoot` and `isSandboxRuntimeActive` — consumed by
  `src/components/views/GitDiffView/index.tsx` and
  `src/lib/project-git.ts`.

**Acceptance criteria.**
- `rg "files:list|files:read|files:write|files:watch|files:unwatch|files:changed|files:writeSensitive|preview:startServer"`
  returns zero hits across `src/` and `electron/`.
- `rg "registerFileHandlers|disposeAllFileWatchers|startPreviewServer|disposeAllPreviewServers|startHtmlPreviewServer|writeProjectFileSensitive|listProjectFiles|readProjectFile|writeProjectFile|watchProjectFile"`
  returns zero hits.
- `rg "IPC\.filesRead|IPC\.filesList|IPC\.filesWrite|IPC\.filesWatch|IPC\.filesUnwatch|IPC\.filesChanged|IPC\.filesWriteSensitive|IPC\.previewStartServer"`
  returns zero hits.
- `window.electron.files` and `window.electron.preview` no longer
  exist at runtime; `netstat -an | grep 127.0.0.1` after launch shows
  no `preview-server` loopback port (only Vite + Core-link + main API).
- Sandbox `GitDiffView` still opens and reads files over `remoteFs:*`
  (untouched by this spec).
- `pnpm typecheck` and `pnpm test` green.

**Notes.** `remoteFs:*` and `remoteGit:*` are **NOT** touched — they
back the Docker-sandbox agent RPC and stay. The
`electron-contract` file / preview types are removed in AC-06-03
alongside the atomic annotation-settings reconciliation.

---

## AC-06-03 — Retire markdown-refine server route + annotation `AppSettings` + `electron-contract` file types (atomic)

**Depends on:** AC-06-02

**Summary.** The atomic core removal. The `/api/markdown/refine`
route, the `markdown.controller.ts` + `markdown-refiner.ts` server
pair, the `MarkdownRefineRequest` / `MarkdownRefineResponse` shared
contract, the `annotation_agent` / `annotation_model` settings keys,
the `refineMarkdown` API client, the DefaultsSettingsPage "Markdown
annotation refine" row, the passthrough `annotationAgent` /
`annotationModel` fields on Terminal/Theme settings pages, and the
`FileListResult` / `FileReadResult` / `FileWriteResult` entries in
`electron-contract.ts` all land in one ticket — the type surface only
reconciles if they land together.

**Files touched (indicative).**
- Delete: `src/shared/markdown-refine.ts`,
  `src/server/controllers/markdown.controller.ts`,
  `src/server/services/markdown-refiner.ts`.
- Modify `src/shared/electron-contract.ts` — delete `FileListResult`,
  `FileReadResult`, `FileWriteResult` and the surrounding `files:*`
  doc comments (~lines 20–35, 561). **Leave the
  `screencapture-preview` block alone** — the overloaded "preview"
  name there belongs to spec 03.
- Modify `src/lib/api.ts` — delete the `refineMarkdown` client
  (~lines 797–798) and the `MarkdownRefineRequest` /
  `MarkdownRefineResponse` re-exports (~line 51).
- Modify `src/server/api-router.ts` — delete the `markdownController`
  import (~line 37) and the `/api/markdown/refine` route registration
  (~lines 473–475).
- Modify `src/server/controllers/settings.controller.ts` — delete
  `ANNOTATION_AGENT_SETTING_KEY` (`"annotation_agent"`) and
  `ANNOTATION_MODEL_SETTING_KEY` (`"annotation_model"`); delete
  `getAnnotationAgentSetting` and `getAnnotationModelSetting`; drop
  `annotationAgent` / `annotationModel` from the update-body zod
  schema, from the GET response payload, and from the two PATCH
  mutation branches (~lines 852–860).
- Modify `src/components/views/DefaultsSettingsPage.tsx` — remove the
  `currentAnnotationAgent` / `currentAnnotationModel` reads (~lines
  77–78), the union members in the mutation-key type (~lines 165–166),
  the entire "Markdown annotation refine" row (~lines 370–385), and
  the recovery branch at ~line 697 that swallows the
  "Unrecognized key" server error.
- Modify `src/components/views/TerminalSettingsPage.tsx` and
  `src/components/views/ThemeSettingsPage.tsx` — drop the passthrough
  `annotationAgent` / `annotationModel` fields from each page's
  local settings echo (after the schema drop they must not be sent).
- Modify `src/server/services/recall-engine.ts` — remove the
  incidental comment reference to `markdown-refiner.ts` (~line 17).

**Acceptance criteria.**
- `rg "markdown-refine|MarkdownRefine|refineMarkdown|markdown\.controller|markdown-refiner|/api/markdown/refine"`
  returns zero hits.
- `rg "annotation_agent|annotation_model|ANNOTATION_AGENT_SETTING_KEY|ANNOTATION_MODEL_SETTING_KEY|getAnnotationAgentSetting|getAnnotationModelSetting|annotationAgent|annotationModel"`
  returns zero hits.
- `rg "FileListResult|FileReadResult|FileWriteResult"` returns zero
  hits.
- Settings panel opens; Defaults page no longer shows the "Markdown
  annotation refine" row; General / Terminal / Theme pages still
  render.
- `POST /api/markdown/refine` 404s; existing settings API cases still
  pass with the annotation cases stripped.
- `pnpm typecheck` and `pnpm test` green.

---

## AC-06-04 — Retire `file.finder` / `file.save` keybindings + `fileFinder` header-button visibility

**Depends on:** AC-06-03

**Summary.** Cleanup pass on the discoverability / rebind surface.
Removes the `file.finder` and `file.save` hotkey actions from
`HOTKEY_ACTIONS`, from `defaults`, and from `groups`; drops
`fileFinder` from `HEADER_BUTTON_KEYS` /
`DEFAULT_HEADER_BUTTON_VISIBILITY`, from the interface-settings
visibility labels, and from `HEADER_BUTTON_LABELS`. Stale entries in
`app_settings.keybindings:*` blobs are ignored by the reader once the
action names are gone; a best-effort scrub also runs at boot via
AC-06-05.

**Files touched (indicative).**
- Modify `src/lib/keybindings/types.ts` — delete `"file.finder"` and
  `"file.save"` from `HOTKEY_ACTIONS` and their `ACTION_META` entries.
- Modify `src/lib/keybindings/defaults.ts` — delete
  `"file.finder": makeBinding({ mod: true, key: "p" })` and
  `"file.save": makeBinding({ mod: true, key: "s" })` (lines 33–34);
  update the neighboring comment at line 37 that references
  `file.save`.
- Modify `src/lib/keybindings/groups.ts` — remove `"file.finder"` and
  `"file.save"` from their group entries (lines 50–51). The
  `HOTKEY_ACTIONS.length` invariant check at 74–75 stays valid.
- Modify `src/shared/header-buttons.ts` — remove `"fileFinder"` from
  `HEADER_BUTTON_KEYS`, `HeaderButtonVisibility`, and
  `DEFAULT_HEADER_BUTTON_VISIBILITY`.
  `normalizeHeaderButtonVisibility` handles stale persisted values
  automatically.
- Modify `src/lib/hideable-elements.tsx` — remove the
  `fileFinder: "find file button"` entry from `HEADER_BUTTON_LABELS`.
- Modify `src/components/views/InterfaceSettingsPage.tsx` — remove
  the `fileFinder: {…}` entry from the visibility labels map (~line
  81) and the `{headerButtonRow("fileFinder")}` render (~line 153).

**Acceptance criteria.**
- `rg "file\.finder|file\.save"` in `src/` returns zero hits.
- `rg "fileFinder"` in `src/` returns zero hits.
- The keybindings rebind page no longer lists "file.finder" or
  "file.save"; Interface Settings shows no "Find file button" toggle.
- `Cmd+P` and `Cmd+S` are unbound in the app.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** The `mc:fileFinderView` localStorage key on already-installed
clients decays naturally once the reader in
`src/lib/ui-preference-cache.ts` is removed (AC-06-01) — no renderer
migration needed.

---

## AC-06-05 — Schema-bootstrap: drop `annotation_*` app_settings rows + scrub keybinding blobs

**Depends on:** AC-06-04

**Summary.** Add a one-shot idempotent boot-time cleanup that removes
the two `annotation_*` rows from `app_settings` and opportunistically
scrubs `file.finder` / `file.save` keys from every
`keybindings:%` app_settings blob. Follows the fork convention ("we
don't ship migration files to the user") — this is code in
`schema-bootstrap.ts`, not a numbered SQL file. The parent spec
sketches the equivalent as `0025_remove_ide_adjacent.sql`; per ADR
0007 and the ticket README, that lands as a boot-time helper instead.

**Files touched (indicative).**
- Modify `src/db/schema-bootstrap.ts` — add a
  `dropLegacyIdeAdjacentSettings(sqlite)` helper that runs:
    - `DELETE FROM app_settings WHERE key IN ('annotation_agent', 'annotation_model');`
    - `UPDATE app_settings SET value = json_remove(value, '$."file.finder"', '$."file.save"') WHERE key LIKE 'keybindings:%';`
      (`json_remove` is a no-op when the path is absent, so this is
      safe on fresh SQLite too).
  Call it from `ensureSchema` alongside `dropLegacyPetSettings` /
  `dropLegacyVoiceSettings` and document that the block stays in the
  tree for one release.

**Acceptance criteria.**
- Booting the Panel against a pre-cutover SQLite (with
  `annotation_agent` / `annotation_model` present, or
  `keybindings:%` blobs containing `file.finder` / `file.save`)
  leaves zero rows matching `key IN ('annotation_agent', 'annotation_model')`
  and no surviving `file.finder` / `file.save` keys inside any
  `keybindings:%` blob.
- Booting the Panel against a fresh SQLite runs both statements
  without error and produces no rows.
- `rg "annotation_agent|annotation_model|file\.finder|file\.save"` in
  `src/` returns only the boot-time DELETE / UPDATE in
  `schema-bootstrap.ts`.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** Like AC-02-05 and AC-01-05, this cleanup block stays in
the tree for one release, then is removed by a follow-up ticket
(tracked as AC-CLEANUP-01 in the rebrand set).
