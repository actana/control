# One fixed look, copied from Actana Studio

> **Status: ACCEPTED.** Written after the fact, by [#54](https://github.com/actana/control/issues/54),
> to record a decision that was taken and implemented before the ADR series reached it. The decision was
> recorded only in `docs/specs/12-adopt-studio-look.md`, which ADR 0016 D46 deletes with the rest of the
> historical record; this file is the promotion of the one fact from that spec that is still true and was
> recorded nowhere else (ADR 0016 D46, K2). It takes **0015** because ADR 0016 D44 settled the number.
> It **amends ADR 0007**: the "theme onboarding and accent" surface that record lists as retained is gone.

The Panel began as a fork of a desktop app that let the operator paint it: painted or flat theme
styles, fourteen accent swatches, a surface-tint slider, a background-image uploader, a background grid
toggle, an interface font picker and scale, a terminal font / weight / line-height / letter-spacing stack,
and a first-run "pick your theme" overlay. The sibling Actana Studio app has one look — cyan/blue on a
near-white ground, JetBrains Mono, small radius, quiet shadows. An operator moving from Studio into the
Panel saw a different-feeling product, and a maintainer merging upstream fought the theme surface on every
merge. Per ADR 0007 the Panel is a remote control for Harnesses, not a lifestyle app: every theme knob was a
decision the operator had to make before doing real work, and a code path on which two machines could
render the same view differently.

All of that was deleted in one cutover, and what replaced it is this record.

## Decisions

**D1 — There is one canonical look, and it is Actana Studio's.** The Panel renders Studio's default
palette (cyan/blue accent on light neutral surfaces, Studio's own dark palette in dark mode) and Studio's
typography (JetBrains Mono for UI and terminal alike, Studio's sans fallback stack). It is baked into
`packages/panel/src/styles.css` as foundation tokens. There is no theme registry, no theme preset, no
per-install variation, and no theme onboarding: the first launch looks like Studio and asks nothing.

**D2 — The only operator axis is dark / light, and it follows the system by default.** One preference,
`mc:theme`, with the values `system` / `light` / `dark`, held in the browser's localStorage and read by a
single pre-hydration script that toggles `.dark` on `<html>` before first paint. `system` resolves through
`prefers-color-scheme`, so an OS schedule ("dark at sunset") is honoured without a click. The Settings
surface has exactly one appearance control, the three-way system / dark / light choice. There is **no**
accent picker, **no** tint slider, **no** background image or grid, **no** font override for the interface
or the terminal, and **no** zoom or font-size stepper. A request for any of these is a request to reverse
this ADR, not a feature ticket.

**D3 — The tokens are copied from Actana Studio, not invented.** The `:root, .light` and `.dark` blocks in
`styles.css` are a verbatim copy of Studio's `apps/actana/app/_styles/globals.css`. No value in them is
re-tuned on this side. **A new colour is therefore a sync question, not a taste question:** when Studio's
palette changes, the blocks are re-copied wholesale; when the Panel needs a colour Studio does not have,
the answer is to use one Studio does have, or to change it in Studio first and then re-copy. The Panel's
own token names (`--text`, `--surface-0`, `--mm-radius`, the session-state and semantic-role vocabularies)
are aliases that re-bind onto a Studio token; no colour literal may appear outside the copied blocks.

**D4 — Two things are explicitly not planned.** *Per-project or per-Core theme override*: a Session on a
remote Core does not get its own accent, and every Panel window on every Core renders the same look, modulo
the operator's dark / light choice (this is the visual half of ADR 0005, singular UI across Cores). *White-
label brand hooks*: Studio has a `NEXT_PUBLIC_BRAND_*` surface (brand colour, brand font) for white-label
customers. The Panel is not white-labeled, and that surface is deliberately not ported — neither the
environment variables nor the runtime indirection that reads them. A shared `@actana/tokens` package is
also not planned; the copy is the mechanism until there is a second consumer that needs more than a copy.

## Considered Options

- **Keep the multi-theme surface and ship Studio as the default preset (rejected).** Keeps every code
  path, every DB row and every upstream-merge conflict the surface already costs, and still lets two
  machines render differently. The default is not the problem; the axis is.
- **Design a Panel palette of our own (rejected).** Reintroduces the "why do these look different?"
  problem the cutover exists to solve, and makes every colour a taste decision with no authority to
  settle it. Copying gives the Panel an authority — Studio — and makes drift detectable by `diff`.
- **Port Studio's `NEXT_PUBLIC_BRAND_*` hooks so the look can be rebranded at deploy time (rejected).**
  A theme surface by another name: one more code path, one more way for two installs to differ, for a
  customer the Panel does not have.
- **Keep a terminal font picker as the one exception (rejected).** The terminal is the surface where the
  Panel most resembles Studio's code views, and the argument for a picker there is the argument for a
  picker everywhere. JetBrains Mono at the Studio weight and size, no picker.

## Consequences

- `packages/panel/src/styles.css` is fork-owned and is **the** file to edit for a colour. The `@theme`
  block at its head carries an anchor comment pointing at this ADR, so the person who opens the file to
  add a colour reads D3 first.
- The cutover deleted the theme modules, their settings rows (`accent_color`, `theme_style`,
  `surface_tint`, `background_image`, `background_grid_off`, `minimal_theme`, the interface and terminal
  font keys, `launch_intro_enabled`), their localStorage caches, the fourteen tinted border PNG sets and
  the unused `@fontsource` packages. That history is in git, not in a doc; this record names it only so
  a reader who finds a stale key in an old database knows it is dead, not missing.
- The multi-theme deletion and the Studio look are asserted together by one boot-level test,
  `packages/panel/src/lib/__tests__/studio-look.test.ts`: the pre-hydration script reads only `mc:theme`
  and writes nothing, `<html>` carries no legacy theme attribute, the stylesheet uses the Studio values
  verbatim, and JetBrains Mono is the only bundled font. The same file checks that this ADR exists and
  that the anchor comment is in place.
- The light / dark classification the Core uses to set `COLORFGBG` for Harness PTYs
  (`packages/core/src/app-theme.ts`) needs no change: the only backgrounds it will ever be handed are
  Studio light and Studio dark.
- Nothing in this ADR is a vocabulary term. `CONTEXT.md` gains no entry; the look is a property of the
  Panel, not a noun in the domain.
