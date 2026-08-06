# Brand assets

Full inventory, brand tokens, badge set, and the video plan live in
`planning/resource-plan.md` (sibling `planning/` folder, outside this repo).

- `logo-light.png` / `logo-dark.png` — README hero wordmark (1680×360, shown at `width="380"` via `<picture>`)
- `actana-icon.svg` — the Actana mark, verbatim from actana.ai/favicon/actana.svg
- `icon-256.png` — raster icon for avatars / npm
- `banner-social.png` — GitHub social preview (2560×1280, uploaded in repo Settings, not linked from the README)
- `src/` — SVG sources + `build.mjs` (resvg-js) to regenerate every PNG

All text is set in **JetBrains Mono** — the product's primary UI font (Studio
look, spec 12) — so the brand type matches the app everywhere.

Regenerate: `npm i @resvg/resvg-js`, fetch JetBrains Mono 400/500/700/800 TTFs
from Google Fonts into `src/fonts/`, then `node src/build.mjs`.
