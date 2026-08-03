# Tickets — Spec 12 (Adopt the Studio look as the sole Panel look)

Parent spec: [`../specs/12-adopt-studio-look.md`](../specs/12-adopt-studio-look.md).

Four tickets, following the slicing sketched in the spec's Further Notes.
Ordered so each PR leaves `pnpm typecheck` and `pnpm test` green. The chain
is 01 → 02 → { 03, 04 } — the last two are independent of each other and
can land in either order (or in parallel) once 02 is in.

**Naming corrections vs. the spec.** The spec's key lists were written from
memory of the settings surface; the code uses different names in four
places. Tickets below use the *code* names:

| Spec says | Code has |
| --- | --- |
| `launch_intro_enabled` / `mc:launchIntro` | `launch_overlay_enabled` / `mc:launchOverlayEnabled` (toggle lives on `GeneralSettingsPage`, not the theme page) |
| `background_grid_off` | `show_background_grid` (localStorage cache is `mc:backgroundGridOff`) |
| — (missing from spec) | `terminal_font_weight_bold` — a 13th theming key, deleted alongside `terminal_font_weight` |
| — (missing from spec) | `mc:themeOnboardingDone` — the theme-picker-dismissed cache in `src/lib/theme-onboarding.ts`; the server-side gate is the derived `themeChosen` flag in `settings.controller.ts` |

Also: the spec names a `src/db/migrations/0028_adopt_studio_look.sql`, but
the fork does not ship numbered migration files (migrations stop at 0024;
every prior removal spec landed as a guarded `dropLegacy*` helper in
`src/db/schema-bootstrap.ts` — see AC-07-04). AC-12-04 follows the fork
convention, matching the spec's own AC-12-04 sketch ("schema-bootstrap
DELETE block").

---

## AC-12-01 — Port the Studio look: tokens + fonts + pre-hydration + dark/light/system axis

**Depends on:** —

**Summary.** Make the Panel *render* the Studio look end to end without yet
deleting the old theme machinery. Rewrite `src/styles.css` around the
Studio token block (both palettes copied verbatim from Studio's
`apps/actana/app/_styles/globals.css`), keep JetBrains Mono as the only
font import, delete the `[data-minimal]` / `[data-theme]` / `[data-tint]` /
`[data-bg-image]` / `[data-bg-grid]` / `[data-launch-intro]` attribute-selector
tree (the bulk of the file), trim the pre-hydration script to a single job
(read `mc:theme`, toggle `.dark`), and extend the theme axis with the new
`system` value backed by a `prefers-color-scheme` listener. The old
theme-selection UIs and logic modules keep compiling — their CSS hooks are
gone, so they become visually inert — and are deleted in AC-12-02. Ships
the spec's one new test (the DOM-level look assertion).

**Files touched (indicative).**
- Rewrite: `src/styles.css` (4045 lines today) — keep the Tailwind
  `@theme` block, the xterm CSS import, `@fontsource/jetbrains-mono`
  imports, and theme-independent component base styles; add the Studio
  `:root, .light` and `.dark` palette blocks copied verbatim (spec Further
  Notes has the source path); delete the Space Grotesk / Geist Mono /
  Plus Jakarta Sans `@fontsource` imports and the whole attribute-selector
  tree, including the `.launch-overlay` "doors" ramp.
- Modify: `src/routes/__root.tsx` — `PRE_HYDRATION_THEME_SCRIPT` shrinks
  to reading `mc:theme` (values `system` / `light` / `dark`, default
  `system`, resolving `system` via `matchMedia`) and toggling the `.dark`
  class; drop the now-unused cache-key constant imports
  (`THEME_STYLE_CACHE_KEY`, `MINIMAL_CACHE_KEY`, `SURFACE_TINT_CACHE_KEY`,
  `BACKGROUND_IMAGE_CACHE_KEY`, `BACKGROUND_GRID_CACHE_KEY`,
  `LAUNCH_INTRO_CACHE_KEY`, `ACCENT_CACHE_KEY`) — the modules themselves
  stay until AC-12-02.
- Modify: `src/lib/use-theme.ts` — `readCachedTheme` / `useTheme` /
  `syncWindowBackground` survive and gain the `system` value +
  `prefers-color-scheme` change listener; leave the accent / theme-style
  branches in place if removing them would break still-alive consumers
  (they die with their callers in AC-12-02).
- New test: DOM-level look assertion beside
  `src/lib/__tests__/use-theme.test.ts`, per the spec's Testing Decisions —
  mounted `<html>` has no `data-minimal` / `data-tint` / `data-bg-image` /
  `data-bg-grid` attribute and no inline `--accent-*` vars; `.dark` is the
  sole surviving axis; computed `--brand-accent` equals the Studio hex;
  `<body>` font-family includes `JetBrains Mono`; boot touches no
  localStorage key other than `mc:theme`.
- Trim: `src/lib/__tests__/use-theme.test.ts` — drop accent / theme-style
  cases, keep and extend dark / light / system cases.

**Acceptance criteria.**
- Cold start on a fresh profile renders the Studio light look (or dark,
  following the OS) with no flash of unstyled content and no theme
  onboarding requirement to reach the app.
- The new boot test passes; `src/styles.css` contains no `[data-minimal]`,
  `[data-tint]`, `[data-bg-image]`, `[data-bg-grid]`, or
  `[data-launch-intro]` selector.
- The only `@fontsource` imports in `src/styles.css` are
  `jetbrains-mono` (packages are removed from `package.json` in AC-12-03).
- `pnpm typecheck` and `pnpm test` green.

**Notes.** This ticket intentionally leaves dead-looking knobs in Settings:
accent swatches, tint slider, etc. still render but no longer change
anything (their CSS hooks are deleted). That interim state is fine — the
knobs are deleted wholesale in AC-12-02, and shipping the look first keeps
both tickets small and green. The current script defaults to *dark* when
`mc:theme` is unset; the new default is *system* — an intentional behavior
change per user stories 4 / 19.

---

## AC-12-02 — Delete every theme-selection surface (UI + modules + settings API + tests)

**Depends on:** AC-12-01

**Summary.** Cut the now-inert theme machinery out. Deletes the theme
onboarding overlay + gate, the accent / style / tint / background /
font-selection UI, the launch "doors" overlay and its GeneralSettingsPage
toggle, every theme logic module, and their tests. `ThemeSettingsPage`
becomes `AppearanceSettingsPage` with exactly one control (system / light /
dark). `terminal-options` is rebuilt as a tiny helper returning one of two
fixed xterm palettes derived from the Studio tokens. The settings HTTP API
drops the thirteen theming keys from its Zod payload so a stale renderer
writing them gets a loud 400.

**Files touched (indicative).**
- Delete: `src/components/views/ThemeOnboardingOverlay.tsx`,
  `src/components/views/ThemeStylePreview.tsx`,
  `src/components/views/AccentColorPicker.tsx`,
  `src/lib/accent-colors.ts`, `src/lib/theme-style.ts`,
  `src/shared/theme-style.ts` (missing from the spec's module list — it
  holds the borders-PNG name mapping), `src/lib/surface-tint.ts`,
  `src/shared/surface-tint.ts`, `src/lib/background-image.ts`,
  `src/shared/background-image.ts`, `src/lib/background-grid.ts`,
  `src/lib/interface-appearance.ts`, `src/lib/terminal-appearance.ts`,
  `src/shared/terminal-appearance.ts`, `src/lib/theme-onboarding.ts`,
  `src/lib/launch-intro.ts`.
- Delete tests: `src/lib/__tests__/theme-style.test.ts`,
  `src/lib/__tests__/surface-tint.test.ts`,
  `src/lib/__tests__/theme-onboarding.test.ts`,
  `src/shared/__tests__/background-image.test.ts`,
  `src/shared/__tests__/terminal-appearance.test.ts`,
  `src/lib/__tests__/terminal-options.test.ts` (its fixed-palette
  assertions fold into the AC-12-01 boot test / a small inline check).
- Rename + slim: `src/components/views/ThemeSettingsPage.tsx` →
  `AppearanceSettingsPage.tsx` — one section, one three-way control bound
  to `mc:theme`; update the settings nav entry.
- Modify: `src/components/views/TerminalSettingsPage.tsx` — drop the
  terminal font / weight / line-height / letter-spacing controls; if
  nothing else remains, delete the page and its nav entry.
- Modify: `src/components/views/GeneralSettingsPage.tsx` — drop the
  launch-overlay toggle (`launchOverlayEnabled` /
  `readCachedLaunchIntroEnabled` / `writeCachedLaunchIntroEnabled`).
- Rebuild: `src/lib/terminal-options.ts` — two-branch dark/light helper
  over the fixed Studio-token xterm palettes.
- Modify: `src/lib/use-theme.ts` — finish the trim started in AC-12-01
  (accent-color and theme-style branches go with their last callers).
- Modify: `src/routes/__root.tsx` — drop the onboarding gate/trigger and
  the launch-overlay mount.
- Modify: `src/server/controllers/settings.controller.ts` — drop the
  thirteen theming keys (`accent_color`, `theme_style`, `minimal_theme`,
  `surface_tint`, `background_image`, `show_background_grid`,
  `interface_font_family`, `interface_font_scale`, `terminal_font_family`,
  `terminal_font_weight`, `terminal_font_weight_bold`,
  `terminal_line_height`, `terminal_letter_spacing`,
  `launch_overlay_enabled`) from the GET payload and the PATCH Zod schema
  (unknown keys must 400, not no-op), and drop the derived `themeChosen`
  flag.
- Trim: `src/lib/api.ts` and `src/queries/index.ts` — drop the client
  fields / query plumbing for the removed settings.
- Trim: `src/server/__tests__/settings-api.test.ts` — drop passing cases
  for the removed keys; add negative cases asserting PATCH with each
  removed key returns 400 (mirrors the spec-07 dropped-key cases already
  in that file).

**Acceptance criteria.**
- `rg -i "accent-colors|AccentColor|theme-style|themeStyle|surface-tint|surfaceTint|background-image|backgroundImage|background-grid|backgroundGrid|interface-appearance|terminal-appearance|theme-onboarding|ThemeOnboarding|launch-intro|launchOverlay|launch_overlay"`
  in `src` and `electron` returns zero hits (excluding the AC-12-04
  bootstrap block once it lands).
- `PATCH /api/settings` returns 400 for every removed key; the negative
  cases are in `settings-api.test.ts`.
- Settings shows an Appearance section with exactly one control; no theme
  onboarding overlay path exists; no launch "doors" overlay path exists.
- The sole surviving localStorage theme key referenced anywhere is
  `mc:theme` (`mc:themeStyle`, `mc:minimal`, `mc:surfaceTint`,
  `mc:backgroundImage`, `mc:backgroundGridOff`, `mc:accent`,
  `mc:launchOverlayEnabled`, `mc:themeOnboardingDone` all gone).
- `pnpm typecheck` and `pnpm test` green.

**Notes.** Per the spec's ordering note, land spec 06 (IDE-adjacent)
first if it is still in flight — both touch `TerminalSettingsPage` /
terminal panes. The launch "doors" overlay is treated as part of the
theming surface (the spec lists its key among the deletions); its CSS
already went in AC-12-01, so this ticket removes the component, toggle,
module, and settings key together.

---

## AC-12-03 — Delete theming build assets: borders PNGs, tint generator, unused font packages

**Depends on:** AC-12-02

**Summary.** Purge the build-asset weight the theme system carried:
`public/borders/` (62 PNGs — the 14-accent tinted sets plus bases),
`scripts/gen-theme-images.mjs` (the offline tinting generator), and the
three `@fontsource` packages that existed only for the interface-font
picker. Depends on AC-12-02 because the borders PNGs are referenced from
`src/shared/theme-style.ts`, `src/lib/accent-colors.ts`, and
`AccentColorPicker.tsx` until that ticket deletes them.

**Files touched (indicative).**
- Delete: `public/borders/` (entire directory),
  `scripts/gen-theme-images.mjs`.
- Modify: `package.json` — remove `@fontsource/space-grotesk`,
  `@fontsource/geist-mono`, `@fontsource/plus-jakarta-sans`; keep
  `@fontsource/jetbrains-mono`. Remove any `gen-theme-images` script
  entry. Refresh `pnpm-lock.yaml`.

**Acceptance criteria.**
- `rg "borders/|gen-theme-images|space-grotesk|geist-mono|plus-jakarta-sans"`
  across `src`, `electron`, `scripts`, `package.json` returns zero hits
  (JetBrains Mono references remain).
- `pnpm build` succeeds; before/after bundle + installer sizes captured in
  the PR description (the spec estimates ~2 MB of PNGs and a few hundred
  KB of font files — a "here's what this bought us" number, not a gate).
- `pnpm typecheck` and `pnpm test` green.

**Notes.** Pure asset/dependency removal — no runtime code should need to
change. If `rg` finds a straggler reference, it belongs in AC-12-02's
scope; fix it there rather than letting this ticket grow logic changes.

---

## AC-12-04 — Schema-bootstrap cleanup + divergence note

**Depends on:** AC-12-02 (independent of AC-12-03)

**Summary.** The forward-migration pass. Adds a guarded, idempotent
`dropLegacyThemeSettings(sqlite)` helper to `src/db/schema-bootstrap.ts`
that deletes the fourteen theming rows from `app_settings` on boot,
following the established `dropLegacy*` pattern (specs 02 / 04 / 05 / 07 /
10 / 11). No numbered SQL migration file — the fork does not ship them
(the spec's `0028_adopt_studio_look.sql` sketch predates checking the
convention; its DELETE body moves into the helper, with the corrected key
names). Also updates the Electron `app-theme` test fixtures to the two
Studio backgrounds and records the theme axis as fork-nonexistent in the
upstream divergence doc.

**Files touched (indicative).**
- Modify: `src/db/schema-bootstrap.ts` — add `dropLegacyThemeSettings`
  running `DELETE FROM app_settings WHERE key IN (…)` over:
  `accent_color`, `theme_style`, `minimal_theme`, `surface_tint`,
  `background_image`, `show_background_grid`, `interface_font_family`,
  `interface_font_scale`, `terminal_font_family`, `terminal_font_weight`,
  `terminal_font_weight_bold`, `terminal_line_height`,
  `terminal_letter_spacing`, `launch_overlay_enabled`. Call it from
  `ensureSchema` alongside the other `dropLegacy*` helpers; document that
  the block stays in the tree for one release (AC-CLEANUP-01 convention).
- Verify (audit-only): fresh installs seed none of these keys — today they
  are written lazily on operator change, so `schema-bootstrap.ts` should
  need no seeding edit; confirm and move on.
- New/extend test: `src/db/__tests__/` — booting against a pre-cutover
  SQLite fixture holding all fourteen rows leaves zero after
  `ensureSchema`; booting a fresh DB runs the guarded DELETE without
  error.
- Modify: `electron/__tests__/app-theme.test.ts` — swap fixtures to the
  two Studio `--bg` values; `electron/app-theme.ts` itself needs no code
  change (its luminance classification now just sees exactly two inputs).
- Modify: `docs/upstream/DIVERGENCE.md` — add the theme axes as a
  NON-EXISTENT axis on the fork side: upstream commits touching the
  accent registry, theme-style painter, surface-tint recipes,
  background-image uploader, or multi-font settings are permanently
  ignored; `src/styles.css` moves from "reconcile-carefully" to
  "fork-owned".

**Acceptance criteria.**
- Pre-cutover DB (all fourteen theming rows present) boots to zero of
  them; fresh DB boots without `no such table` / `no such column` errors.
- `rg "accent_color|theme_style|surface_tint|background_image|show_background_grid|minimal_theme|interface_font|terminal_font|terminal_line_height|terminal_letter_spacing|launch_overlay_enabled"`
  in `src` and `electron` hits only the `dropLegacyThemeSettings` block.
- `electron/__tests__/app-theme.test.ts` passes against the two Studio
  backgrounds.
- `DIVERGENCE.md` carries the theme-axis entry.
- `pnpm typecheck` and `pnpm test` green.

**Notes.** `mc:theme` rows are *not* touched — dark/light/system is the
preserved axis and lives in localStorage anyway. Stale localStorage keys
on operator machines (`mc:accent` et al.) are harmless orphans: nothing
reads them post-AC-12-02, and the fork's prior removal specs made the same
call (no localStorage scrubbing pass).
