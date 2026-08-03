# Tickets — Spec 09 (Rebrand + auto-update disable)

Parent spec: [`../specs/09-rebrand-and-auto-update.md`](../specs/09-rebrand-and-auto-update.md).

Six tickets (five for the rebrand + auto-update cutover, one follow-up
cleanup pass). Ordered so each PR leaves `typecheck` and `test` green.
This is the **last** spec — it must land AFTER specs 01, 02, 03, 04,
05, 06, 07, 08 have all merged, so the removal noise is out of the
diff and the rename touches only the surface it needs to. In
particular, AC-09-02's `build.mac.extendInfo` prune depends on spec 01
(Whisper) deleting `NSMicrophoneUsageDescription` and spec 03
(Screenshot) deleting `NSScreenCaptureUsageDescription` first, and
AC-09-04's `MC_*` → `AC_*` env rename depends on spec 05 removing
`MC_API_URL` / `MC_API_TOKEN` / `MC_THEME` from the injection surface
first.

---

## AC-09-01 — Stub `electron/update-manager.ts` and hide auto-update UI

**Depends on:** —

**Summary.** Land the auto-update disable first, in isolation, so
downstream rename PRs never accidentally re-arm a shipping app against
the stale `agentsystem.dev` host. Converts `electron/update-manager.ts`
into a stub that short-circuits every entry point behind a single
`AUTO_UPDATE_DISABLED` const, keeps the four IPC handlers alive
(returning `idle` / no-op) so the renderer contract stays stable, and
guards the Settings UI behind an `AUTO_UPDATE_UI_ENABLED = false` flag
so re-enabling is a single-line flip on each side. Does **not** delete
the `electron-updater` dependency — it stays lazy-loaded so the
re-enable diff is just the guards.

**Files touched (indicative).**
- Modify: `electron/update-manager.ts` — prepend the top-of-file
  re-enable comment block (four numbered steps referencing
  `control.actana.ai`, `latest-mac.yml`, `latest.yml`,
  `latest-linux.yml`, `.blockmap`, `.zip`); add
  `const AUTO_UPDATE_DISABLED = true;` and
  `if (AUTO_UPDATE_DISABLED) return;` in `registerUpdateManager`
  (~line 312) after the `safeHandle` registrations and BEFORE the
  `if (!app.isPackaged)` early return (~line 327); add
  `if (AUTO_UPDATE_DISABLED) return { ok: false, error: "auto-update-disabled" };`
  guards at the top of `safeCheck` (~line 229; adjust for its `void`
  return), `safeDownload` (~line 248), and `safeInstall` (~line 293);
  delete the trailing `TODO(academy auto-update infra):` comment
  (~lines 340–345) that references the retired
  `agentsystem.dev/downloads/mission-control/auto-update` URL.
- Modify: `src/components/views/GeneralSettingsPage.tsx` — add
  `const AUTO_UPDATE_UI_ENABLED = false;` near the top of the file and
  guard the auto-update section (the two toggles and the manual "Check
  for updates" CTA around lines 360 / 370 / 377) behind it. Do not
  touch the surrounding "Version information" / "Reload" sections in
  this ticket — their copy is rewritten in AC-09-03.

**Acceptance criteria.**
- `rg "AUTO_UPDATE_DISABLED" electron/update-manager.ts` returns four
  hits (const declaration + three guard sites) plus `safeCheck` /
  `safeDownload` / `safeInstall` early returns.
- Manually invoking the `update.check` IPC returns
  `{ ok: false, error: "auto-update-disabled" }`; the periodic and
  startup timers never fire.
- Auto-update section in Settings → General is hidden; the rest of the
  General page still renders.
- The `electron-updater` dependency remains in `package.json`.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** `applyUpdaterPreferences` already defaults `autoDownload`
and `autoInstallOnAppQuit` to `false` when the setting keys are unset
— no change needed there. The stub deliberately preserves the four
IPC handlers so the renderer contract stays stable even with the UI
hidden.

---

## AC-09-02 — Rebrand `package.json` metadata + electron-builder config

**Depends on:** AC-09-01, AC-01-02 (Whisper — deletes
`NSMicrophoneUsageDescription` + `build.extraResources` whisper entry
+ `scripts.setup:whisper`), spec 03 (Screenshot — deletes
`NSScreenCaptureUsageDescription`)

**Summary.** Flip the package-metadata identity in one atomic ticket:
`name`, `description`, `build.appId`, `build.productName`, and the
`build.publish` block. This is the ticket that renames the packaged
artifact and the macOS bundle identifier. Runs after Whisper +
Screenshot removal so the two `build.mac.extendInfo` usage-string
prunes are already done and this ticket doesn't have to touch that
subtree.

**Files touched (indicative).**
- Modify: `package.json`
  - `name`: `"mission-control"` → `"actana-control"`.
  - `description`: → `"Actana Control — desktop harness remote control for driving AI coding agents across many projects."`.
  - `build.appId`: `"labs.agentsystem.missioncontrol"` → `"ai.actano.control"`.
  - `build.productName`: `"MissionControl"` → `"Actana Control"`.
  - `build.publish`: replace the entire array with `"publish": null`
    (auto-update is stubbed by AC-09-01; do not point at
    `control.actana.ai` until re-enable spec lands).
  - Leave `build.win.artifactName` (`"${productName}-${version}-Setup.${ext}"`) as-is — it cascades through `productName`.
  - Leave `build.mac.category` (`"public.app-category.developer-tools"`) as-is.
  - Leave `author` unset (flagged under Open Questions in the spec).

**Acceptance criteria.**
- `rg "\"mission-control\"" package.json` returns zero hits.
- `rg "MissionControl|missioncontrol" package.json` returns zero hits.
- `rg "agentsystem\.dev" package.json` returns zero hits.
- `pnpm dist:mac` (or dry-run equivalent) produces artifacts named
  `Actana Control-<ver>.dmg` / `-<ver>-mac.zip`.
- macOS bundle identifier reported by `codesign -dv` on the packaged
  build matches `ai.actano.control`.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** The `@agentsystemlabs/mission-control-agent` dependency
stays on its current version and org for now — the npm-scope switch
to `@qcentic/actana-control-agent` is gated on the fork being
published (per spec §"Additional rename scope" and the hard
prerequisite note). Leave a `TODO(actana-agent)` marker on the
dependency line and at each of the seven consumer sites called out in
the spec (`src/shared/sandbox-agent-upgrade.ts`,
`src/shared/__tests__/sandbox-agent-upgrade.test.ts`,
`electron/sandbox-agent-client.ts`, `electron/sandbox-types.ts`,
`src/shared/electron-contract.ts`,
`src/lib/remote-vm-script.test.ts`,
`src/components/views/ConnectSandboxDialog.tsx`) so the switch-over is
a single search-and-replace pass later.

---

## AC-09-03 — Rebrand user-facing strings across `electron/` and `src/`

**Depends on:** AC-09-02

**Summary.** Sweep every "Mission Control" / "MissionControl"
occurrence that reaches a user's screen and replace with "Actana
Control" / "Actana Control" (with the space). Renames `APP_NAME` in
`electron/main.ts`, the startup-failure HTML, remote-VM error strings,
the HTML `<title>`, TopBar aria/title/alt, router error boundary,
every Settings / Defaults / Theme / Terms / Feature-panel string
enumerated in the spec, and the eight `src/routes/projects.$id.tsx`
occurrences. Does **not** touch code identifiers, comments describing
the app conceptually, protocol-contract names (`MC_*` env,
`MissionControlSessionEnded`), the `@agentsystemlabs/mission-control-agent`
npm package name, the `docs/upstream/` porting notes, or ADRs 0001–0005.

**Files touched (indicative).**
- Modify: `electron/main.ts` — `APP_NAME` at line 93 (feeds
  `app.setName(APP_NAME)` at line 113 and the userData path builder at
  lines 95–104); startup-failure `<h1>` at line 316; four remote-VM
  deploy-script error strings at lines 706 / 831 / 875 / 913;
  server-exit error message at line 1182.
- Modify: `src/routes/__root.tsx` — HTML `<title>` at line 213;
  `aria-label="Mission Control loading"` at line 1084.
- Modify: `src/components/ui/TopBar.tsx` — `aria-label` at line 61,
  `title` at line 62, `alt` at line 81.
- Modify: `src/router.tsx` — error-report subject at line 38, error
  boundary console tag at line 58 (`[mission-control]` →
  `[actana-control]`), rendering-issue prose at line 110.
- Modify: `src/components/views/GeneralSettingsPage.tsx` — macOS
  notification-permission copy at line 316; auto-update descriptions
  at lines 360 / 370 / 377 (the section is guarded off by AC-09-01 but
  the copy still updates for the re-enable path); About subtitle at
  line 549; Reload subtitle at line 607.
- Modify: `src/components/views/ThemeSettingsPage.tsx` — lines 313
  and 466.
- Modify: `src/components/views/ThemeOnboardingOverlay.tsx` — lines
  203 and 219.
- Modify: `src/components/views/DefaultsSettingsPage.tsx` — lines 200,
  215, 242, 363, 393, 578.
- Modify: `src/components/views/TermsSettingsPage.tsx` — lines 32, 39,
  52, 59, 106, 118. (Legal review flagged separately; not blocking.)
- Modify: `src/components/views/FleetView.tsx` — line 123.
- Modify: `src/components/views/SandboxProvisioningState.tsx` — line 106.
- Modify: `src/components/views/ScopeDropdown.tsx` — lines 214, 241,
  285, 301, 303, 934, 1214.
- Modify: `src/components/views/ProjectCard.tsx` — line 276.
- Modify: `src/components/views/ProjectSandboxDialog.tsx` — line 166.
- Modify: `src/components/views/ConnectSandboxDialog.tsx` — lines 156
  and 176 (keep the `@agentsystemlabs/mission-control-agent` package
  name in code blocks — out of scope for this spec).
- Modify: `src/components/views/SandboxConfigPanel.tsx` — lines 1125,
  1175, 1533.
- Modify: `src/routes/projects.$id.tsx` — lines 474, 2497, 2724, 3353,
  3594, 3834, 3838, 3900, 4078.
- Modify: `src/lib/project-sandbox-create.ts` — line 177 (thrown error
  surfaced in UI).
- Modify: `src/server/services/projects.ts` — lines 65, 66, 89
  (project-not-found messages surfaced through API errors).
- Modify: `src/server/services/path-security.ts` — line 34
  (`projectPath must be a registered Mission Control project` →
  `Actana Control`).

**Acceptance criteria.**
- `rg -n "Mission Control" src/ electron/` returns zero hits in
  user-facing strings (conceptual comments allowed; identifiers like
  `MissionControlSessionEnded` in `src/shared/agent-hook-events.ts`
  allowed).
- `rg -n "MissionControl" src/routes src/components electron/main.ts`
  returns zero hits.
- Packaged app window title shows "Actana Control".
- Renderer error-boundary logs prefixed `[actana-control]` (not
  `[mission-control]`).
- `pnpm typecheck` and `pnpm test` green.

**Notes.** `RecallPanel.tsx` (line 1028), `InstallShipSkillModal.tsx`
(line 120), `InstallDiagramSkillModal.tsx` (line 147),
`InstallDiagramSkillMenuItem.tsx` (line 8), `VoiceController.tsx`
(line 38), `HtmlPreview.tsx` (line 98), and `src/lib/screenshot.ts`
(line 19) are all deleted by prior specs (04 / 05 / 01 / 06 / 03) —
this ticket does **not** touch them. The `TerminalSettingsPage.tsx`
mention of `agentSystemBannerDisabled` is a settings key, not a
user-facing string — out of scope.

---

## AC-09-04 — Rename `MC_*` env prefix to `AC_*` across Panel and shared code

**Depends on:** AC-09-03, spec 05 (removes `MC_API_URL` /
`MC_API_TOKEN` / `MC_THEME` from the injection surface first — this
ticket only renames the survivors)

**Summary.** Single wire-break rename of the `MC_*` env-var prefix to
`AC_*` across every Panel-side injection site, every shared-code
reader, and every documentation reference. No dual-read window and no
compatibility shim — the fork lands the renamed prefix in one cutover.
Locked 2026-07-30 per spec §"Env-var prefix — confirmed". `MC_TASK_ID`
→ `AC_TASK_ID`, `MC_HARNESS_REMOTE` → `AC_HARNESS_REMOTE`, and the
rest of the surviving `MC_*` set. The `@qcentic/actana-control-agent`
package ships the renamed reader on the same day (out of this repo).

**Files touched (indicative).**
- Modify: every file matched by `rg -l "MC_[A-Z_]+" src/ electron/`
  that references an env var (not a code identifier that happens to
  contain `MC_` — verify each hit by reading it). Expect this to
  include `MC_AGENT_ENV_KEYS`, `MC_TASK_ID`, `MC_HARNESS_REMOTE`, and
  any peer variables the injection layer sets. The exact set is
  whatever survives after spec 05 removes `MC_API_URL` /
  `MC_API_TOKEN` / `MC_THEME`.
- Modify: helper module names / constants that carry the `MC_` prefix
  are OUT OF SCOPE per spec §"Non-user-facing (comments, code
  identifiers) — DO NOT rename" — this ticket touches ONLY env-var
  string literals and their reader/writer call sites. Files like
  `mission-control-hook-env.ts`, `MC_AGENT_ENV_KEYS` (the identifier),
  and `opencode-mission-control-plugin.ts` remain named as they are;
  only the env-var strings they read/write change from `"MC_X"` to
  `"AC_X"`.
- Modify: any Markdown under `docs/` that documents the env-var
  contract — sweep `rg -n "MC_TASK_ID|MC_HARNESS_REMOTE|MC_AGENT_ENV_KEYS"
  docs/ --exclude-dir=upstream` and rename in prose.

**Acceptance criteria.**
- `rg -n "\"MC_[A-Z_]+\"" src/ electron/` returns zero hits (env-var
  string literals — code identifiers like `MC_AGENT_ENV_KEYS` allowed).
- `rg -n "process\.env\.MC_" src/ electron/` returns zero hits.
- Panel-side spawns propagate `AC_*` env vars only.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** Because the `@qcentic/actana-control-agent` npm package is
not yet published (see spec §"Hard prerequisite"), the agent-side
reader that consumes `AC_*` lives outside this repo and must be
released in lockstep. If the fork slips, the fallback is to hold this
ticket until the agent package is published — do NOT ship
`@agentsystemlabs/mission-control-agent` alongside `AC_*` env vars,
that combination reads no state.

---

## AC-09-05 — Rebrand docs, scripts, and asset filenames

**Depends on:** AC-09-04

**Summary.** Final rename pass. Sweeps the top-level docs prose,
renames the userData-dir-tied scripts, and renames the reference asset
`public/_references/mission-control.png`. Leaves ADRs 0001–0005 alone
(historical), leaves `docs/upstream/*` alone (correct historical name
of the upstream), and leaves code identifiers / npm package names /
`.claude/mission-control` filesystem markers alone (out-of-scope per
spec).

**Files touched (indicative).**
- Modify: `README.md` — 4 occurrences of "Mission Control"; also line
  74 update-host reference `agentsystem.dev` → `control.actana.ai`.
  Keep the word "Panel" everywhere it appears.
- Modify: `PRODUCT.md` — 1 occurrence.
- Modify: `SPEC.md` — 6 occurrences.
- Modify: `CONTEXT.md` — 1 occurrence.
- Modify: `CHANGELOG.md` — add a top entry for the rebrand +
  auto-update disable.
- Sweep opportunistically (not blocking):
  `AGENTS.md`, `INSTALL.md`, `NOTICE`, `TODO.md`,
  `TERMINAL_FOCUS_BUG.md`, and `docs/*.md` (agent-status-detection,
  digitalocean-sandboxes-plan, local-build-screen-recording,
  project-sandbox-aws-flow, provider-usage, refactor-plan,
  remote-vm-cli, session-orchestrator-brief*,
  worktree-implementation-plan).
- Modify: `scripts/dev-local.mjs` — comment at lines 22–23 referencing
  "MissionControl.app" / "MissionControl path"; verify the derived
  `APP_NAME` matches or hardcode `"Actana Control"`.
- Modify: `scripts/resign-local-macos.mjs` — lines 23, 36, 77
  (`MissionControl.app` → `Actana Control.app`).
- Modify: `scripts/remote-vm.mjs` — lines 133–135 (three
  platform-specific `MissionControl` userData paths → `Actana Control`).
- Modify: `scripts/smoke-packaged-harness.mjs` — line 121
  (`["mission-control", "MissionControl", "AppRun"]` →
  `["actana-control", "Actana Control", "AppRun"]`); line 320
  (`.mission-control/data` → `.actana-control/data`).
- Rename: `public/_references/mission-control.png` →
  `public/_references/actana-control.png`; grep for the filename and
  update any consumers before renaming.

**Acceptance criteria.**
- `rg -n "Mission Control" docs/ --exclude-dir=upstream --exclude-dir=adr`
  returns zero hits.
- `rg -n "Mission Control|MissionControl" README.md PRODUCT.md SPEC.md CONTEXT.md`
  returns zero hits.
- `rg -n "MissionControl" scripts/` returns zero hits (only the derived
  `APP_NAME` reference in `dev-local.mjs`, if kept, remains).
- `rg -n "mission-control\.png" src/ public/` returns zero hits.
- Packaged app on macOS resolves `app.getPath('userData')` to
  `~/Library/Application Support/Actana Control` (with space).
- `pnpm typecheck` and `pnpm test` green.

**Notes.** Icon artwork replacement is deferred per spec §Assets —
the current pixel content in `build/icon.icns` / `build/icon.png` /
`build/icon.ico` stays, wearing the Mission Control mark until the
design ticket lands. Flag prominently in the release notes so an
alpha/private build isn't mistaken for the public launch build. Do
NOT rename `.claude/mission-control` statusline-tap paths or
`opencode-mission-control-plugin.ts` — these are protocol contracts
with external processes and are out of scope per the parent spec.

---

## AC-CLEANUP-01 — Remove one-shot schema-bootstrap DELETE blocks

**Depends on:** AC-09-05, plus one release cycle elapsed since
AC-01-05, AC-02-05, and any equivalent boot-time DELETE blocks landed
by specs 04 / 05 / 07 (recall/memory, bundled skills, convenience)

**Summary.** Follow-up cleanup pass. Per the tickets-README
cross-spec convention ("Cleanup blocks stay in the tree for one
release, then are removed by a separate follow-up ticket"), this
ticket removes the idempotent DELETE helpers added to
`src/db/schema-bootstrap.ts` by prior specs once every install in the
field has booted through them at least once. Non-blocking for the
rebrand PR itself — files after the rest of spec 09 has shipped.

**Files touched (indicative).**
- Modify: `src/db/schema-bootstrap.ts` — remove
  `dropLegacyPetSettings(sqlite)` (added by AC-02-05),
  `dropLegacyVoiceSettings(sqlite)` (added by AC-01-05), and any
  equivalent DELETE helpers added by specs 04 / 05 / 07 boot cleanups;
  remove their call sites in `ensureSchema` (or wherever they are
  invoked); remove the "stays in the tree for one release" comments.

**Acceptance criteria.**
- `rg "dropLegacyPetSettings|dropLegacyVoiceSettings" src/` returns
  zero hits.
- `rg "voice_command_aliases|pet\\\\_%" src/db/schema-bootstrap.ts`
  returns zero hits.
- Booting the Panel against a fresh SQLite still succeeds; booting
  against a database that already had the DELETEs run once is
  unaffected.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** Do not land this ticket in the same release as the rebrand
— a user upgrading directly from a pre-cutover install must have at
least one boot with the DELETE helpers present, otherwise the legacy
rows survive forever. If in doubt, defer another release cycle.
