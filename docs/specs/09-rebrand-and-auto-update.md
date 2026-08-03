# 09 — Rebrand & Auto-Update Disable

## Overview

Rename the product from **Mission Control** to **Actana Control** across
package metadata, Electron builder config, main-process constants, all
user-facing strings under `src/`, and the top-level docs. In the same
cutover, disable the auto-update path (periodic check, background download,
update dialog) without deleting `electron/update-manager.ts` — the module
stays in place as a stub so re-enabling against `control.actano.ai` is a
diff, not a rebuild. Hard forward-only: no dual naming, no compatibility
shims, no data-dir migration.

## package.json

Root file: `/Users/mehdiroshanfekr/Projects/opensource/mission-control-updated/package.json`.

| Field | Old | New |
| --- | --- | --- |
| `name` | `"mission-control"` | `"actana-control"` |
| `description` | `"Desktop control surface for managing agentic coding work across many projects."` | `"Actana Control — desktop harness remote control for driving AI coding agents across many projects."` |
| `build.appId` | `"labs.agentsystem.missioncontrol"` | `"ai.actano.control"` (pending domain confirmation — see Open Questions) |
| `build.productName` | `"MissionControl"` | `"Actana Control"` |
| `build.mac.extendInfo.NSMicrophoneUsageDescription` | `"Mission Control uses the microphone…"` | remove entirely — mic entitlement/whisper are being deleted per ADR 0007 (spec 01 Whisper removal) |
| `build.mac.extendInfo.NSScreenCaptureUsageDescription` | `"Mission Control captures a screen region…"` | remove entirely — screenshot capture is being deleted per ADR 0007 |
| `build.publish[0].url` | `"https://agentsystem.dev/downloads/mission-control/auto-update"` | replace the entire `build.publish` array with `"publish": null` (disables generic-provider publishing entirely). Do not point at `control.actano.ai` yet — see Open Questions. |
| `build.win.artifactName` | `"${productName}-${version}-Setup.${ext}"` | keep — resolves via `productName`; will produce `Actana Control-<ver>-Setup.exe` after productName change |

No `author` or `publisher` field is currently set — leave absent (or add
`"author": "Actano"` if the operator wants a signed-installer publisher
string later; flag under Open Questions).

Scripts: no user-facing script name references `mission-control` — the
existing script keys (`dev`, `build`, `dist:*`, `release:local`, etc.) are
generic and require no change.

## Electron / builder config

All builder config is inline under `package.json > build` (no separate
`electron-builder.yml`). Changes:

- `build.appId` — see table above.
- `build.productName` — see table above.
- `build.artifactName` — not set at top level; Win uses `${productName}-…`
  which cascades automatically. macOS DMG/zip and Linux AppImage names
  derive from `productName` by default and will pick up the new name.
- `build.mac.category` — `"public.app-category.developer-tools"` — keep
  as-is.
- Icon paths — `build/icon.icns`, `build/icon.png`, `build/icon.ico` — the
  filenames are already generic. Replace the *pixel content* per Assets
  section; no path change needed in the config.
- `build.mac.entitlements` / `entitlementsInherit` — `build/entitlements.mac.plist`.
  The file does not reference "Mission Control" anywhere. However the
  `com.apple.security.device.audio-input` entitlement should be dropped in
  the same pass (Whisper removal, ADR 0007). Rename not required.
- `build.protocols` — not set. There is no `build.protocols` block in the
  current builder config and no `app.setAsDefaultProtocolClient` call in
  `electron/main.ts`. Confirmed via grep: zero matches for
  `setAsDefaultProtocolClient`, `mission-control://`, `open-url`,
  `will-finish-launching`, `second-instance`, `singleInstanceLock`. No
  deep-link scheme is registered today.

## Deep-link / URI scheme

**No custom URI scheme exists.** Grep of `electron/` and `src/` confirms:
no `mission-control://` string, no `setAsDefaultProtocolClient` call, no
`open-url` handler, no `build.protocols` in the builder config. Only the
custom Electron `protocol.handle("app", …)` in `electron/main.ts:1697` and
`protocol.registerSchemesAsPrivileged([...])` at `electron/main.ts:1445`
exist, and those are for the internal `app://` renderer origin, not an OS
protocol handler.

**Action: none.** If a public `actana-control://` scheme is wanted later
(share-a-session URLs, magic-link auth), file a separate spec — do not
introduce it as part of the rebrand.

## Window title / UI strings

Enumeration of every `Mission Control` / `MissionControl` occurrence that
lands on a user's screen. Test files (`__tests__/`, `*.test.ts`) are out
of scope for the rebrand PR — update alongside their code changes.

### Window / meta

- `electron/main.ts:93` — `const APP_NAME = "MissionControl"` → `"Actana Control"`.
  Feeds `app.setName(APP_NAME)` at `electron/main.ts:113` and the userData
  path builder at `electron/main.ts:95-104`. See "App data dir" section.
- `electron/main.ts:316` — startup-failure HTML `<h1>Mission Control failed to start</h1>` → `Actana Control failed to start`.
- `electron/main.ts:706`, `:831`, `:875`, `:913` — "Remote VM deploy script
  is missing from this Mission Control build." → replace `Mission Control`
  with `Actana Control`.
- `electron/main.ts:1182` — server-exit error message → replace.
- `src/routes/__root.tsx:213` — `{ title: "MissionControl" }` (HTML `<title>`) → `"Actana Control"`.
- `src/routes/__root.tsx:1084` — `aria-label="Mission Control loading"` → `"Actana Control loading"`.

### Top bar / chrome

- `src/components/ui/TopBar.tsx:61` — `aria-label="Mission Control home"` → `"Actana Control home"`.
- `src/components/ui/TopBar.tsx:62` — `title="Mission Control — home"` → `"Actana Control — home"`.
- `src/components/ui/TopBar.tsx:81` — `alt="Mission Control"` → `"Actana Control"`.

### Router / error boundary

- `src/router.tsx:38` — `"Mission Control error report"` → `"Actana Control error report"`.
- `src/router.tsx:110` — "Mission Control hit a rendering issue…" → replace.
- `src/router.tsx:58` — `console.error("[mission-control] render error boundary caught:", …)` → `[actana-control]`.

### Settings pages (user-facing prose)

- `src/components/views/GeneralSettingsPage.tsx:316` — macOS notification-permission copy: "…System Settings → Notifications → Mission Control, allow notifications, then reload Mission Control." Replace both. NOTE: the OS-level "Mission Control" here is Apple's virtual-desktop feature name — the copy is talking about *our* app, not Apple's — so replacing is correct.
- `src/components/views/GeneralSettingsPage.tsx:360, :370, :377` — auto-update descriptions ("Mission Control downloads…", "quit Mission Control", "reload Mission Control"). Replace, but see Auto-update section — the controls themselves are being hidden.
- `src/components/views/GeneralSettingsPage.tsx:549` — About section subtitle: "Version information for Mission Control." → replace.
- `src/components/views/GeneralSettingsPage.tsx:607` — Reload section subtitle: "Refresh the current Mission Control window." → replace.
- `src/components/views/ThemeSettingsPage.tsx:313` — "Pick the chrome Mission Control wears…" → replace.
- `src/components/views/ThemeSettingsPage.tsx:466` — theme card description "…The full Mission Control look." → replace.
- `src/components/views/ThemeOnboardingOverlay.tsx:203, :219` — same phrasing pattern → replace both.
- `src/components/views/DefaultsSettingsPage.tsx:200, :215, :242, :363, :393, :578` — every "Mission Control" occurrence in the Defaults page prose → replace.
- `src/components/views/TermsSettingsPage.tsx:32, :39, :52, :59, :106, :118` — six occurrences in the Terms body. Replace. (Terms language may need legal review under the new name — flag but not blocking for this spec.)
- `src/components/views/TerminalSettingsPage.tsx` — no user-facing MC strings (only the `agentSystemBannerDisabled` setting key, out of scope; see the AgentSystem-banner cleanup in the removal specs).

### Feature panels

- `src/components/views/FleetView.tsx:123` — "…only available inside Mission Control." → replace.
- `src/components/views/ProjectCard.tsx:276` — remove-project tooltip → replace.
- ~~`SandboxProvisioningState` / `ScopeDropdown` / `ProjectSandboxDialog` / `ConnectSandboxDialog` / `SandboxConfigPanel` sandbox copy~~ — deleted by spec 10 (sandbox removal); no rebrand action.
- `src/components/views/RecallPanel.tsx:1028` — Recall is being deleted per ADR 0007 (spec 04); no rebrand action, the file will be removed.
- `src/components/views/InstallShipSkillModal.tsx:120` — bundled-skills feature is being deleted per ADR 0007 (spec 05); no rebrand action, file will be removed.
- `src/components/views/InstallDiagramSkillModal.tsx:147`, `InstallDiagramSkillMenuItem.tsx:8` — same, deleted per spec 05.
- `src/components/views/VoiceController.tsx:38` — Whisper/voice is being deleted per spec 01; no rebrand action.
- `src/components/views/HtmlPreview.tsx:98` — "Fully quit and restart Mission Control…" — HtmlPreview is being deleted per spec 06 (IDE-adjacent). No rebrand action.

### Route views

- `src/routes/projects.$id.tsx:474, :2497, :2724, :3353, :3594, :3834, :3838, :3900, :4078` — nine occurrences across project detail view (empty states, error copy, worktree-delete confirmation, remove-project tooltip). Replace each.

### Library / utility user-facing strings

- `src/lib/screenshot.ts:19` — screenshot is being deleted per spec 03; no rebrand action.
- `src/lib/project-sandbox-create.ts:177` — thrown error surfaced in UI: "…before Mission Control can clone it…" → replace.

### Server-side error strings that reach the UI

- `src/server/services/projects.ts:65, :66, :89` — project-not-found messages → replace.
- `src/server/services/path-security.ts:34` — `"projectPath must be a registered Mission Control project"` — thrown, surfaced through API errors → replace.

### Non-user-facing (comments, code identifiers) — DO NOT rename

Everything else in `src/server/`, `src/shared/`, and `electron/*.ts`
under the Mission Control name is either:

- A code comment describing the app (safe to update opportunistically —
  not a blocker),
- A code identifier (`MC_API_URL`, `MC_TASK_ID`, `MC_AGENT_ENV_KEYS`,
  `buildLocalMissionControlApiUrl`, `withoutMissionControlHookEnv`,
  `opencode-mission-control-plugin.ts`, `mission-control-hook-env.ts`,
  `mission-control-version.ts`, `MissionControlSessionEnded`, class/CSS
  names) — **out of scope for this spec**. The `MC_*` env-var prefix and
  the `MissionControlSessionEnded` hook event are the Harness ↔ Panel
  core-link / OpenCode-plugin contract; changing them is a coordinated
  protocol change, not a rebrand. Leave alone. (The VM-agent side of
  that contract is gone — spec 10 removed the sandbox subsystem.)
- A `.claude/mission-control` filesystem path or a statusline-tap
  comment written into user projects — these are managed markers with
  compat implications; leave alone in this pass.

The `agentsystem` / `agentsystem.dev` / `@agentsystemlabs/*` names are
GitHub org, domain, and npm-package identifiers of the *upstream*
project. They are not the product name and are out of scope for the
rebrand PR. Any switch of upstream package dependency is a separate
supply-chain change.

## Auto-update

File: `electron/update-manager.ts`.

**Do not delete the module.** Convert it into a stub that short-circuits
every entry point.

1. Prepend a top-of-file comment block:
   ```
   // Auto-update is DISABLED for the initial Actana Control cutover.
   // Re-enable when control.actano.ai (spelling TBC — see docs/specs/09) is
   // live and the generic-provider artifacts (latest-mac.yml, latest.yml,
   // latest-linux.yml, *.blockmap, *.zip) are being served. Re-enabling is:
   //   1. Restore `build.publish` in package.json with the new URL.
   //   2. Remove the `AUTO_UPDATE_DISABLED` short-circuits below.
   //   3. Restore periodic-check + startup-check timers in registerUpdateManager.
   //   4. Re-expose the update dialog in GeneralSettingsPage.
   ```

2. In `registerUpdateManager` (line 312) — after the `safeHandle`
   registrations and BEFORE the `if (!app.isPackaged)` early return
   (line 327), insert:
   ```ts
   const AUTO_UPDATE_DISABLED = true;
   if (AUTO_UPDATE_DISABLED) return;
   ```
   This preserves the four IPC handlers (they return the current
   `unsupported-dev` / `idle` state and no-op on
   `updateCheck`/`updateDownload`/`updateInstall`) so the renderer's IPC
   contract stays stable, but skips the timer setup entirely. The
   startup timer (line 337) and interval timer (line 338) never fire.

3. In `safeCheck` (line 229), `safeDownload` (line 248), and
   `safeInstall` (line 293) — add `if (AUTO_UPDATE_DISABLED) return { ok: false, error: "auto-update-disabled" };` at the top of each (adjust
   for `safeCheck`'s `void` return). This defends against future
   IPC-driven calls if the renderer forgets to hide the "Check for
   updates" button.

4. `applyUpdaterPreferences` already defaults `autoDownload` and
   `autoInstallOnAppQuit` to `false` when the setting keys are unset —
   no change needed there.

5. Remove the auto-update section from
   `src/components/views/GeneralSettingsPage.tsx` (lines around 360,
   370, 377 — the two toggles and the manual "Check for updates" CTA).
   Alternatively, hide it behind an `AUTO_UPDATE_UI_ENABLED = false`
   const at the top of the file so re-enabling is a single-line flip.
   Prefer the const-guard approach — it matches update-manager.ts's stub
   pattern and keeps the wiring reviewable.

6. Do not remove the `electron-updater` dependency from `package.json`.
   It is imported dynamically and lazy-loaded; keeping it means the
   re-enable diff is just the guards.

7. Delete the trailing `TODO(academy auto-update infra):` comment at
   `electron/update-manager.ts:340-345` — it points at the retired
   `agentsystem.dev/downloads/mission-control/auto-update` URL and is
   superseded by the top-of-file comment.

Result: packaged Actana Control never contacts any host for updates; no
update dialog appears; no state transitions past `idle` occur; the
module compiles and remains ready to re-enable behind a single const.

## Docs

Rebrand prose only — do NOT bulk-rename file paths or code identifiers
in Markdown snippets.

- `README.md` — 4 occurrences of `Mission Control` → `Actana Control`.
  Keep the word "Panel" everywhere it appears (per Actana Control domain
  vocabulary — see `docs/domain-model.md`).
- `PRODUCT.md` — 1 occurrence → replace.
- `SPEC.md` — 6 occurrences → replace.
- `CHANGELOG.md` — no current occurrences; add a top entry for the
  rebrand + auto-update disable when the PR lands.
- `CONTEXT.md` — 1 occurrence → replace.
- `AGENTS.md`, `INSTALL.md`, `NOTICE`, `TODO.md`, `TERMINAL_FOCUS_BUG.md`
  — sweep opportunistically; not part of the acceptance criteria for
  this spec.
- `docs/adr/*` — leave 0001–0005 alone (they predate the rebrand; the
  historical name is correct in situ). 0006–0008 already use "Actana
  Control".
- `docs/domain-model.md` — already uses Actana Control. No change.
- `docs/upstream/*` — **do NOT rebrand.** These are porting notes
  tracking divergence from `AgentSystemLabs/mission-control` v0.49.0 and
  "Mission Control" is the correct historical name of the upstream.
  Confirmed by ADR 0007 line 23: *"Legacy references to Mission Control
  survive only in `docs/upstream/` porting notes (where they are the
  correct historical name)."*
- Other `docs/*.md` (agent-status-detection, local-build-screen-recording,
  provider-usage, refactor-plan, session-orchestrator-brief*,
  worktree-implementation-plan) — sweep prose replacements
  opportunistically; not blocking. (The sandbox docs — digitalocean-sandboxes-plan,
  project-sandbox-aws-flow, remote-vm-cli — were deleted by spec 10.)

## Assets

Current icon files (already at generic filenames):

- `build/icon.icns` — macOS
- `build/icon.ico` — Windows
- `build/icon.png` — Linux
- `build/icon.transparent.png.bak` — backup

There are no `mission-control-icon.*` or `MissionControl.icns` files —
grep confirms. The icon *filenames* are already brand-neutral; only the
pixel content is currently the Mission Control mark.

`scripts/generate-icons.mjs` regenerates the three from a source image —
review the input path when the Actana Control mark is delivered.

`public/_references/mission-control.png` — reference asset used in the
"references" gallery / theme onboarding. Rename to `actana-control.png`
and update any relative references (grep for the filename before
renaming).

**Action:** if final Actana Control icon artwork does not exist yet,
**keep the current icons in place** and open a design ticket. The
rebrand PR is not blocked on final artwork — packaged builds will
carry the Mission Control mark under the new product name until the
design ticket lands. Flag prominently in the release notes so an
alpha/private build isn't mistaken for the public launch build.

## App data dir

`app.getPath('userData')` on Electron defaults to a directory named
after `productName` (electron-builder-managed). The current bespoke
override at `electron/main.ts:93-113` (`APP_NAME = "MissionControl"` +
`app.setName(APP_NAME)`) pins the userData path to:

- macOS: `~/Library/Application Support/MissionControl`
- Windows: `%APPDATA%/MissionControl`
- Linux: `~/.config/MissionControl`

After the rebrand, changing `APP_NAME` to `"Actana Control"` moves the
userData path to `Actana Control` on all three platforms. Existing
installs will start with a **fresh** userData directory: no projects,
no saved sessions, no cached auth token, no app-settings, no SQLite DB.

Per ADR 0007 this is a hard forward-only cutover and there are no
external users to migrate, so this is acceptable. But **flag for the
operator**: any developer on the team who has a running install with
work in the old userData dir will lose UI state (their DB is in the old
folder). Recommend a one-line migration note in the PR: developers can
manually move (not symlink — the SQLite file is opened exclusively)
the old dir to the new location if they want their state preserved
locally.

Also update:

- `scripts/dev-local.mjs:22-23` — the comment referencing
  "MissionControl.app" and "MissionControl path". The dev isolation
  logic uses `APP_NAME` derived from `productName` — verify the derived
  name is what the script expects, or hardcode the new name.
- `scripts/resign-local-macos.mjs:23, :36, :77` — three references to
  `MissionControl.app` in code (path arg default and log strings). Update
  to `Actana Control.app` (with space, matching new productName).
- `scripts/remote-vm.mjs:133-135` — three platform-specific
  `MissionControl` userData paths. Update to `Actana Control`.
- `scripts/smoke-packaged-harness.mjs:121, :320` — packaged-binary
  candidates array (`["mission-control", "MissionControl", "AppRun"]`)
  and the `.mission-control/data` tmp path. Update to
  `["actana-control", "Actana Control", "AppRun"]` and `.actana-control/data`.

## Verification checklist

- `grep -RIn "Mission Control" src/ electron/` returns zero user-facing
  results (comments in code that describe the app conceptually are
  acceptable; user-facing strings and window title must be zero).
- `grep -RIn "MissionControl" src/routes src/components electron/main.ts`
  returns zero results (identifiers like `MissionControlSessionEnded` in
  `src/shared/agent-hook-events.ts` are protocol-layer contract with the
  agent CLI — allowed).
- `grep -RIn "Mission Control" docs/ --exclude-dir=upstream --exclude-dir=adr` returns zero results (ADR 0001–0005 are historical and stay).
- Packaged app window title shows "Actana Control".
- macOS DMG artifact is named `Actana Control-<ver>.dmg`. Windows
  installer is `Actana Control-<ver>-Setup.exe`. Linux AppImage is
  `Actana Control-<ver>.AppImage`.
- macOS bundle identifier reported by `codesign -dv` matches the new
  `build.appId`.
- Launching the packaged app performs no outbound request to
  `agentsystem.dev`. Verify with `sudo lsof -i -n -P | grep <pid>` or a
  network mock — startup completes without an update check.
- Auto-update UI in Settings → General is hidden (or the section is
  gone). Manually invoking the `update.check` IPC returns
  `{ ok: false, error: "auto-update-disabled" }`.
- `app.getPath('userData')` inside the packaged app resolves to a
  `Actana Control` (space) folder.

## Additional rename scope (confirmed 2026-07-30)

The rebrand covers more than product-string surfaces. All of the following rename in one pass:

- **Package name** (`package.json.name`): `mission-control` → `actana-control`.
- ~~**npm scope for the agent bridge dep**~~ — **dissolved by spec 10.** The sandbox subsystem (the only consumer of `@agentsystemlabs/mission-control-agent`) is removed, and the dependency with it. No `@qcentic/actana-control-agent` fork needs to exist.
- **GitHub org / repo**: `qcentic/actana-control`. Update URLs in `README.md`, `PRODUCT.md`, `CHANGELOG.md`, `docs/*`.
- **Update / download host**: `agentsystem.dev` → `control.actana.ai`. Touches `package.json.build.publish.url`, `README.md` line 74, `electron/update-manager.ts` line 342 comment (module is being stubbed anyway per this spec).
- **`build.appId`**: `ai.actana.control` (domain is `actana.ai`).

**Prerequisites.** ~~The `@qcentic/actana-control-agent` npm package must be published before this spec can fully land~~ — **dissolved by spec 10** (docs/specs/10-remove-sandbox.md, ADR 0009): no VM install path exists anymore, so no agent package needs to be published. This spec now depends on spec 10 having landed first (it has); the env-var rename below is unaffected.

## Env-var prefix — confirmed

`MC_*` → `AC_*` — locked 2026-07-30. The prefix is the Harness ↔ Panel core-link contract (`MC_TASK_ID` → `AC_TASK_ID`, `MC_HARNESS_REMOTE` → `AC_HARNESS_REMOTE`, etc.; the `MC_API_URL/TOKEN/THEME` set is deleted by spec 05 before this even lands, and the VM-agent consumer is gone with spec 10). Single wire break, no dual-read window. All Panel-side injection sites, Harness-side reader code, and any documentation referencing `MC_*` update in the same PR.

## Open questions

- **Domain confirmed.** Product domain is `actana.ai`. Update host is
  `control.actana.ai`. `build.appId` is `ai.actana.control`.
  (Prior confusion between `actano.ai` and `actana.ai` in the grilling
  session is resolved: `actana.ai` is authoritative.)
- **Icon assets.** Does Actana Control have finished icon artwork
  (`.icns`, `.ico`, `.png`) yet? If not, keep the current Mission
  Control marks in `build/` as placeholders and open a design ticket to
  land before public release. Explicit go/no-go from the operator
  requested.
- **Publisher / author string.** `package.json` has no `author` field
  today. If signed installers (macOS notarization, Windows Authenticode)
  require a publisher/company string in metadata, decide now whether
  it's `"Actana"`, `"Actano"`, or a legal-entity name so the value is
  set once and doesn't change between signed builds.
- **Terms & Conditions copy.** `src/components/views/TermsSettingsPage.tsx`
  contains six occurrences of "Mission Control" inside a Terms body
  written for the upstream product. A pure string replace is technically
  fine but the language may need legal review under the new brand.
  Flag to whoever owns legal — do not block the rebrand PR on it, but do
  not ship publicly without a review pass.

## Follow-ups / out of scope

- **Auto-update re-enable spec.** Separate ticket once (a) the domain
  spelling is confirmed, (b) `control.<domain>.ai` is standing up an
  electron-updater generic-provider host serving `latest-mac.yml`,
  `latest.yml`, `latest-linux.yml`, `.blockmap`, and `.zip` artifacts,
  and (c) a release-publish pipeline uploads to that host. Re-enable is
  four lines of edit to `electron/update-manager.ts` + one line to
  `package.json > build.publish` + un-hiding the Settings UI.
- **Icon redesign.** Design ticket. Not blocking the rebrand PR.
- **Website / landing page** at `control.<domain>.ai` (or wherever) —
  not in this repo. Operator-owned.
- **Signing certificate switch.** macOS `codesign` identity and Windows
  Authenticode certificate are currently tied to whatever team ID / cert
  the upstream ships under. Under the new brand these likely need to
  switch to an Actana/Actano-owned Apple Developer Team ID and code-signing
  cert. Signed-release infrastructure change — flag for the operator, out
  of scope here.
- **Renaming code identifiers** (`MC_*` env prefix,
  `MissionControlSessionEnded` hook event, `mission-control-hook-env.ts`,
  `opencode-mission-control-plugin.ts`, `.claude/mission-control`
  statusline tap directory) — these are protocol contracts with external
  processes (the harness agent CLI, the OpenCode plugin, agent hook
  scripts written into user projects). A coordinated migration is
  possible but is a separate spec and requires a matching change in the
  `@agentsystemlabs/mission-control-agent` package (or a fork of it).
- **npm package fork.** `@agentsystemlabs/mission-control-agent`
  dependency remains as-is. Renaming it means forking or republishing
  under a new npm org — out of scope for the rebrand and out of scope
  for the initial cutover.
- **GitHub org / repo rename.** This repo lives at
  `mehdiroshanfekr/mission-control-updated`; renaming or moving is
  outside the code change and operator-driven.
