# 12 — Adopt the Actana Studio look as the sole Panel look

## Problem Statement

Today, the Panel presents an elaborate theming surface to the operator:
painted vs. flat theme styles, fourteen accent-color swatches, a surface
tint slider (off / subtle / vivid / intense), a background-image uploader,
a background-grid toggle, an interface font-family picker, an interface
font scale, a terminal font-family + weight + line-height + letter-spacing
stack, and a first-run "pick your theme" onboarding overlay. The operator
sees a settings-page menu that looks like a wallpaper app.

Two problems fall out of that:

1. **It doesn't match the rest of the Actana product surface.** The
   sibling Actana Studio app has a single canonical look — cyan/blue on a
   near-white ground, JetBrains Mono typography, small radius, quiet
   shadows. An operator moving from Studio into the Panel sees a
   different-feeling product, which reads as "Mission Control is a fork of
   something else." (It is — but that shouldn't leak into the operator's
   eye.)

2. **It's stylization masquerading as configuration.** Per ADR 0007 the
   Panel is a harness remote control, not a lifestyle app. Every extra
   theme knob is one more decision the operator has to make before doing
   real work, one more code path where the app can render differently on
   two machines, and one more surface the fork has to keep working after
   every upstream merge.

## Solution

Replace the entire multi-theme system with a single fixed look — the
Actana Studio default palette (cyan/blue accent on light neutral surfaces)
and JetBrains Mono typography — baked into the Panel as immutable
foundation tokens. Keep exactly one axis of operator choice: **dark / light
mode**, using Studio's own dark palette when set. Delete every other theme
selection surface (accent picker, tint slider, background image, background
grid, painted vs. flat style, interface font picker, interface font scale,
terminal font / weight / line-height / letter-spacing pickers) along with
their DB rows, IPC, cache keys, and CSS attribute selectors.

The operator's first launch of the Panel post-cutover looks exactly like
Actana Studio's default look. There is no theme onboarding overlay. The
Settings surface has an "Appearance" section that contains one control:
dark / light toggle (system-following).

## User Stories

1. As an operator who uses Actana Studio on the web and the Panel on my
   desktop, I want both products to look like the same product, so that
   moving between them doesn't feel like context-switching to a different
   vendor.

2. As an operator opening the Panel for the first time, I want to see the
   Actana look immediately without being asked to configure a theme, so
   that I can start driving my Harnesses in the first minute.

3. As an operator, I want to switch to dark mode when I'm working at
   night, so that the Panel doesn't burn my eyes.

4. As an operator, I want dark / light to follow my OS setting by default,
   so that the Panel matches how the rest of my desktop already looks.

5. As an operator, I do NOT want to be shown a wall of accent colors,
   background images, tint sliders, or theme presets, so that the Settings
   page focuses on things that actually change how the Panel works.

6. As an operator on a fresh install, I do NOT want a "pick your theme"
   overlay to appear before I can start using the app, so that first-run
   time-to-first-action is zero clicks.

7. As an operator, I want the terminal font to be JetBrains Mono at a
   sensible default size, so that terminal output is readable without me
   configuring anything.

8. As an operator running the Panel across two machines, I want the same
   visual output on both, so that a screenshot I take on my laptop looks
   the same as the same view on my desktop — no per-machine theme drift.

9. As an operator upgrading from a version that had a custom accent color
   set, I want the Panel to just render the studio look after the upgrade
   without prompting me or dropping a "your settings were lost" banner, so
   that the transition is silent.

10. As an operator who previously uploaded a background image, I want that
    image to be dropped in the upgrade (no longer stored, no longer
    rendered), so that no orphan data hangs around in my DB.

11. As an operator using a text-selection, hovered button, focused input,
    or active menu item, I want the visual affordances (accent color,
    hover / active surface, focus ring) to look like Studio's affordances,
    so that muscle memory transfers between products.

12. As an operator using notification toasts and error banners, I want the
    success / error / warning colors to match Studio's semantic palette,
    so that a green in the Panel means the same thing as a green in
    Studio.

13. As an operator reading long code diffs in a terminal, I want line
    height and letter spacing to be legible at default — no configuration
    required, no per-user tuning window.

14. As an operator using a Harness on a remote Core, I want the toast that
    says "Session finished" to render in the same style as every other
    toast — no theme-per-Core, no drift.

15. As a fork maintainer merging upstream commits, I want a much smaller
    surface where upstream can add theming features that I have to keep
    disabling, so that upstream churn in `src/styles.css`,
    `ThemeSettingsPage.tsx`, or the accent registry stops being a per-
    merge conflict.

16. As a fork maintainer, I want the shipping bundle to be smaller — no
    fourteen tinted PNG sets for each accent, no @fontsource packages for
    fonts the app never uses — so that the Panel builds faster and the
    installer is smaller.

17. As a developer touching the Panel UI, I want ONE source of truth for
    color and font tokens (the CSS variable block copied from Studio), so
    that new components can't accidentally introduce a color that only
    exists in the painted-dark ramp.

18. As a developer writing tests, I want to assert against a fixed color
    palette rather than mocking a theme store, so that visual regressions
    show up as failing snapshots rather than flapping under different
    theme fixtures.

19. As an operator using an OS-level "system dark mode at sunset" schedule,
    I want the Panel to follow that schedule without me clicking anything,
    so that ambient adaptation just works.

20. As an operator who genuinely dislikes dark mode or genuinely dislikes
    light mode, I want to override the system default and pin my choice,
    so that I keep exactly one axis of visual control.

## Implementation Decisions

### Look source of truth

The canonical look is copied verbatim from Actana Studio's
`apps/actana/app/_styles/globals.css`. Two palettes are ported: the
light-mode `:root, .light` block (default) and the dark-mode `.dark` block.
Every color token is copied as-is — no re-tuning, no fork-side tweaks. If
the Studio palette changes later, this spec's follow-up cutover copies
the new values across; there is no ongoing "diff two palettes" workflow.

Tokens ported include, at minimum: `--bg`, `--surface-1` through
`--surface-5`, `--surface-hover`, `--surface-active`, `--border`,
`--border-1`, `--text-primary`, `--text-secondary`, `--text-muted`,
`--text-subtle`, `--brand-accent`, `--brand-secondary`,
`--accent-subtle-bg`, `--accent-subtle-border`, `--selection`, `--success`,
`--error`, `--warning`, `--shadow-subtle`, `--shadow-medium`,
`--shadow-overlay`, and the radius scale (`--radius: 0.5rem` with derived
`xs / sm / md / lg`).

### Typography

Primary UI font: **JetBrains Mono** (variable weight 100–800), mirroring
Studio. Loaded via the existing `@fontsource/jetbrains-mono` package
already present in the Panel's dependencies — no new font source added.
Every other bundled font (Space Grotesk, Geist Mono, Plus Jakarta Sans,
Söhne) is dropped from `src/styles.css` imports and removed from
`package.json` where they exist only for the theming surface.

Sans fallback stack matches Studio's fallback verbatim (system-ui →
Segoe UI → Helvetica → …).

### Dark / light axis

Dark / light is the only preserved operator choice. Implementation:

- The Tailwind `.dark` class strategy stays (Studio uses it too).
- Default is `system` — a `prefers-color-scheme` media listener toggles
  the class on `<html>`.
- Operator override persists to a single localStorage key, `mc:theme`,
  with values `system` / `light` / `dark`.
- The Settings surface exposes one three-way control (system / light /
  dark). Nothing else.

The Electron main-process theme sync (`electron/app-theme.ts` — reads
window background luminance to set `COLORFGBG` for PTY spawns) is kept
because it still needs to distinguish light-vs-dark for terminal env
variables. It only ever sees two possible colors now (studio-light `--bg`
or studio-dark `--bg`), which simplifies its inputs but not its role.

### DB / settings shape

Deleted `app_settings` keys (schema-bootstrap cleanup, following the
pattern from specs 04 / 05 / 07 / 10):

- `accent_color`
- `theme_style` (painted / flat)
- `surface_tint` (off / subtle / vivid / intense)
- `background_image`
- `background_grid_off`
- `minimal_theme` (legacy migration key)
- `interface_font_family`
- `interface_font_scale`
- `terminal_font_family`
- `terminal_font_weight`
- `terminal_line_height`
- `terminal_letter_spacing`
- `launch_intro_enabled` (theme onboarding toggle)

Deleted localStorage cache keys:

- `mc:themeStyle`
- `mc:minimal` (legacy)
- `mc:surfaceTint`
- `mc:backgroundImage`
- `mc:backgroundGridOff`
- `mc:accent`
- `mc:launchIntro`

Preserved: `mc:theme` (dark / light / system).

The settings HTTP API (`PATCH /api/settings`) has its Zod payload trimmed
to reject the removed keys — sending any of them returns a 400. This is
intentional: a stale renderer trying to write them should fail loudly
during the upgrade window, not silently no-op.

### CSS architecture

`src/styles.css` is rewritten around the Studio token block. The tree of
`[data-minimal]` / `[data-theme]` / `[data-tint]` / `[data-bg-image]` /
`[data-bg-grid]` attribute selectors — currently the bulk of the file —
is deleted. What remains: Tailwind `@theme` block, the two `:root` and
`.dark` palette declarations, JetBrains Mono `@fontsource` imports,
xterm CSS import, and per-component base styles that don't depend on the
theme axis.

The pre-hydration `<script>` in `src/routes/__root.tsx` is trimmed to a
single job: read `mc:theme`, apply `.dark` class if resolved dark. Every
other attribute mutation (`data-minimal`, `data-tint`, `data-bg-image`,
`data-bg-grid`, inline `--accent*` var assignments) is deleted.

### Deleted UI surfaces

- Every theme-related settings row in `ThemeSettingsPage.tsx` except the
  dark / light selector — the page is renamed to `AppearanceSettingsPage`
  and slims to one section.
- `ThemeOnboardingOverlay.tsx` and its trigger in `__root.tsx`.
- `ThemeStylePreview.tsx`, `AccentColorPicker.tsx` and any accent grid.
- Terminal font / weight / line-height / letter-spacing controls in
  `TerminalSettingsPage.tsx`. The interface font-family dropdown and font
  scale radio group also go. If nothing else remains on
  `TerminalSettingsPage.tsx`, it is deleted and its nav entry removed.

### Deleted logic modules

`src/lib/accent-colors.ts`, `src/lib/theme-style.ts`,
`src/lib/surface-tint.ts`, `src/shared/surface-tint.ts`,
`src/lib/background-image.ts`, `src/shared/background-image.ts`,
`src/lib/background-grid.ts`, `src/lib/interface-appearance.ts`,
`src/shared/terminal-appearance.ts`, `src/lib/terminal-appearance.ts`,
`src/lib/theme-onboarding.ts`, `src/lib/terminal-options.ts` (rebuilt as a
tiny inline helper returning one of two fixed xterm palettes derived from
the Studio tokens).

`src/lib/use-theme.ts` is trimmed to dark/light/system only —
`readCachedTheme`, `useTheme`, `syncWindowBackground` all survive; the
accent-color and theme-style branches inside them go.

### Deleted build assets

- `public/borders/` — all 56 tinted PNGs (`button_filled_*.png`,
  `panel_focused_*.png`, `square_*.png`, `shell_*.png` × 14 accents).
- `scripts/gen-theme-images.mjs` — the offline tinting generator.
- `@fontsource` packages for fonts other than JetBrains Mono, removed
  from `package.json`.

### Migration

`src/db/migrations/0028_adopt_studio_look.sql` (next number after spec
11's 0027):

```sql
-- Actana Control: adopt the Studio look as the sole Panel look.
-- Every theming setting other than dark/light collapses to a fixed default.

DELETE FROM app_settings WHERE key IN (
  'accent_color',
  'theme_style',
  'surface_tint',
  'background_image',
  'background_grid_off',
  'minimal_theme',
  'interface_font_family',
  'interface_font_scale',
  'terminal_font_family',
  'terminal_font_weight',
  'terminal_line_height',
  'terminal_letter_spacing',
  'launch_intro_enabled'
);
```

`schema-bootstrap.ts` updated so fresh installs never seed these keys.

### Ordering / prerequisites

No blocking dependency on specs 06 / 08 / 09 / 10 / 11 — this can land
in parallel with any of them. Two soft interactions worth noting:

- **Spec 09 (rebrand)** — if it lands first, the Settings page title
  strings in the Appearance section already say "Actana Control." If it
  lands after, this spec's Appearance surface just has "Mission Control"
  in it until 09 runs its string sweep. Neither ordering breaks the other.
- **Spec 06 (IDE-adjacent)** — `TerminalPanel` / `TerminalPane` edits may
  overlap. Land 06 first (it's the in-progress branch) to avoid conflict.

## Testing Decisions

### What makes a good test here

A good test in this spec asserts **observable operator outcomes**, not
implementation details of the theme system. "Does the mounted Panel look
like Studio?" is the right question; "does `applyAccentColor()` get
called with `blue`?" is the wrong question — that function is deleted.

Most of this spec is deletion, and deletion is best verified by
`pnpm tsc --noEmit`, `pnpm test` (existing tests keep passing after
theme fixtures are trimmed out of them), and `rg` sweeps for the removed
identifiers. Those are covered in the verification checklist rather than
as new tests.

### The one new test — DOM-level look assertion

**Seam:** the mounted `<html>` element at boot.

A single React-Testing-Library / jsdom test asserts that after the app
mounts:

- `document.documentElement` has NO `data-minimal`, `data-tint`,
  `data-bg-image`, or `data-bg-grid` attribute.
- `document.documentElement` MAY have a `.dark` class (if system prefers
  dark or `mc:theme=dark`) — that is the sole surviving axis.
- No inline `--accent-*` CSS variables are set on `document.documentElement`.
- The computed `--brand-accent` CSS variable equals Studio's canonical
  value (`#29a9e0` in light, `#33bef5` or whatever Studio's dark value
  turns out to be — copy the exact hex from the Studio palette port).
- The computed `font-family` on `<body>` includes `JetBrains Mono`.
- No `mc:themeStyle`, `mc:accent`, `mc:surfaceTint`,
  `mc:backgroundImage`, `mc:backgroundGridOff`, or `mc:launchIntro`
  localStorage key is read or written during boot.

This is one test that covers "the multi-theme system is gone AND the
Studio look is what replaced it." It lives beside the existing
`src/lib/__tests__/use-theme.test.ts` (which is trimmed in the same PR
to cover only the dark/light axis).

### Which tests are deleted

- `src/lib/__tests__/theme-style.test.ts`
- `src/lib/__tests__/surface-tint.test.ts`
- `src/lib/__tests__/theme-onboarding.test.ts`
- `src/shared/__tests__/background-image.test.ts`
- `src/lib/__tests__/terminal-options.test.ts` (rewritten as a tiny inline
  fixture check inside the new boot test — the module it tests shrinks
  from a switch statement over four theme states to a single two-branch
  helper for dark vs. light)
- `src/shared/__tests__/terminal-appearance.test.ts`

### Which tests are trimmed

- `src/lib/__tests__/use-theme.test.ts` — drop accent / theme-style cases,
  keep dark / light / system cases.
- `src/server/__tests__/settings-api.test.ts` — drop the passing cases
  for the removed keys; add negative cases asserting that PATCH with
  those keys returns 400.
- `electron/__tests__/app-theme.test.ts` — keep as-is (its luminance
  classification still runs against the two fixed Studio backgrounds).

### Prior art

The deletion-then-DOM-assertion pattern mirrors what `src/lib/__tests__/
terminal-options.test.ts` does today (attribute-driven palette read from
`<html>`), and the negative-API-payload pattern mirrors the payload-
rejection cases already present in `src/server/__tests__/settings-api.test.ts`
for spec 07's dropped keys.

## Out of Scope

- **Per-project or per-Core theme override.** Not planned — a Harness on a
  remote Core does not get its own accent. All Panel windows on all Cores
  render the same look modulo the operator's dark/light choice.
- **Studio-Panel token library.** This spec ports the tokens by copy, not
  by shared package. Extracting a `@actana/tokens` npm package is a
  worthwhile eventual move but doesn't gate the visual cutover.
- **Runtime brand customization (white-label).** Studio has a
  `NEXT_PUBLIC_BRAND_*` hook system for white-label customers. The Panel
  is not white-labeled. That surface is not ported.
- **Vibrancy / macOS translucency / mica.** No native window-material
  changes; the Panel keeps its current opaque frame.
- **Diagram / chart theming.** No Mermaid-color overrides are added by
  this spec — existing default rendering stays.
- **Studio font override via env var.** Studio supports `NEXT_PUBLIC_
  BRAND_FONT`. Panel does not. JetBrains Mono is hardcoded.
- **A "download my previous theme" export.** No data-preservation path —
  hard forward-only, matching every prior removal spec in this series.
- **Terminal font override.** Explicitly out per the user decision — the
  terminal font is JetBrains Mono at the Studio default weight and size,
  no picker.
- **Interface zoom / accessibility scale.** Out for this spec; if a
  future accessibility spec needs it, it re-enters as a system-wide OS
  zoom deferral rather than an in-app font-size stepper.

## Further Notes

- **Copy the palette, don't reinvent it.** When implementing, open
  `/Users/mehdiroshanfekr/Projects/actana.ai/studio/apps/actana/app/
  _styles/globals.css` and copy the `:root, .light` and `.dark` blocks
  verbatim into `src/styles.css`. Deviating from Studio's hex values
  reintroduces the "why do these look different?" problem this spec is
  solving.

- **The pre-hydration script rewrite is load-bearing.** The current
  script reads six localStorage keys before React mounts to prevent a
  flash of unstyled content. The new script reads exactly one
  (`mc:theme`) and toggles the `.dark` class. Getting this wrong causes
  a visible flash on cold start.

- **The Electron `app-theme.ts` COLORFGBG feedback loop still works.**
  It reads the window background color and classifies dark vs. light;
  after this spec, "the window background color" is one of exactly two
  values (Studio light `--bg` or Studio dark `--bg`). No code change in
  `app-theme.ts` is required, but the test fixture there should be
  updated to use the two Studio values.

- **The `docs/upstream/DIVERGENCE.md` note.** Add the theme axes as a
  NON-EXISTENT axis on the fork side: any upstream commit touching the
  accent registry, theme-style painter, surface-tint recipes,
  background-image uploader, or the multi-font settings is permanently
  ignored on the fork. `src/styles.css` moves from a
  "reconcile-carefully" file to a "fork-owned" file.

- **Bundle-size follow-up.** After the cutover, run `pnpm build` and
  compare bundle sizes before / after — the tinted border PNGs alone
  are ~2 MB of assets today, and the four dropped `@fontsource` packages
  are another few hundred KB of Latin-subset font files. The measurement
  isn't a gate on the spec, but worth capturing in the PR description as
  a "here's what this bought us" number.

- **Where a `docs/tickets/12-adopt-studio-look.md` ticket breakdown
  fits.** The delete-heavy shape here mirrors spec 07 (three
  independent surfaces cut in three commits). A reasonable slicing:
  AC-12-01 palette + font copy into `styles.css` + pre-hydration
  rewrite; AC-12-02 delete every theme-selection UI + module + test;
  AC-12-03 delete borders / gen-theme script / unused `@fontsource`
  packages; AC-12-04 schema-bootstrap DELETE block. Ticket file to be
  written separately when this spec is scheduled.
