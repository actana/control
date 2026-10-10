# One fixed look, copied from Actana Studio

> **Status: ACCEPTED.** Recorded by [ADR 0016](0016-the-0-1-0-shape.md) D44 (the number) and D46 (promotion K2). Tracked in [#54](https://github.com/actana/control/issues/54).

The Panel once had a theming surface that read like a wallpaper app: painted and flat styles, fourteen accent swatches, a surface-tint slider, a background-image uploader, a background grid, an interface font picker and font scale, a stack of terminal font controls, and a "pick your theme" overlay on first run. All of it was deleted and replaced by the Actana Studio look. The code already shows the result: `packages/panel/src/styles.css` carries the Studio palette and JetBrains Mono, `AppearanceSettingsPage.tsx` has one three-way control, and `packages/panel/src/lib/__tests__/studio-look.test.ts` asserts the boot DOM. The decision behind it lived only in a spec that was deleted with the rest of the historical record, so nothing said that the look is _fixed_ or _where the tokens come from_. This ADR is that record.

## Decision

**The Panel has one canonical look, and its only operator axis is dark / light, following the system.**

- **D1 — One look.** Every Panel renders the same palette, radius scale, shadows and typeface on every machine and for every Core. A screenshot on one machine matches the same view on another, apart from dark or light.
- **D2 — Dark / light is the only operator choice, and it follows the system by default.** The Settings → Appearance page has one control with three values: `system` (the default, following `prefers-color-scheme`, so a scheduled OS dark mode just works), `light` and `dark`. The choice lives in the browser's `localStorage` under `mc:theme`. It is not a server setting. The pre-hydration script reads that one key and sets or clears `.dark` on `<html>`. Nothing else is read or written at boot.
- **D3 — There is no other look control.** There is no accent picker, no tint slider, no background image, no font override and no zoom stepper for the interface. JetBrains Mono is the Panel's only face, for the UI and the terminal, and it is hard-coded.
- **D4 — The tokens are copied from Actana Studio, not invented.** The light (`:root, .light`) and dark (`.dark`) blocks in `styles.css` are a verbatim copy of Studio's `apps/actana/app/_styles/globals.css`, and the sans fallback stack is Studio's too. No value is re-tuned on this side. **A new colour is therefore a sync question, not a taste question.** If the Panel needs a colour Studio does not have, the first step is to ask whether Studio should have it. When Studio's palette changes, re-copy the blocks wholesale; don't diff and hand-merge single values. Panel-only tokens built on top (`--accent*`, `--mm-*`) are derived from the copied ones, for example with `color-mix()` over `--brand-accent`, and a new one must be derived the same way rather than bring in a colour of its own.

## Not planned

These are recorded so that the question is answered before it is asked again.

- **Per-project or per-Core theme override.** A Harness on a remote Core does not get its own accent, and neither does a project. Every Panel view renders the same look, apart from the operator's dark / light choice.
- **White-label brand hooks.** Studio has a `NEXT_PUBLIC_BRAND_*` surface (colours and `NEXT_PUBLIC_BRAND_FONT`) for white-label customers. It is deliberately **not** ported. The Panel is not white-labelled, and adding brand env vars would bring back the per-install drift that D1 removes.

## Consequences

- The `@theme` token block in `packages/panel/src/styles.css` carries an anchor comment that points here. That block is the file someone edits when they want to add a colour, so that is where they need to find this ADR.
- A change that adds a theme setting, an accent or tint option, a background image, a font choice, an interface zoom, or a brand env var violates this ADR and should be rejected in review. A change that alters a copied palette value without a matching Studio change does too.
- **The terminal text size is not a look control.** The Terminal settings page and the terminal pane's zoom buttons and shortcuts keep a five-step terminal text size (`terminalZoomLevel`, −2 to +2 around the default). It changes only the size of the terminal's JetBrains Mono. It does not change the face, the palette or any token, and it does not apply to the interface. D3's "no zoom stepper" means the interface. It does not cover this setting.
- Electron-era theme modules, the tinted border PNGs and their generator, and the fonts other than JetBrains Mono were deleted with the old surface. The Core's `app-theme.ts` still tells light from dark for terminal environment variables. It only ever sees the two Studio grounds.
- Nothing changes for operators: the Panel already renders this look.
