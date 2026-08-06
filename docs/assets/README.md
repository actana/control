# Brand assets

Everything the README, the docs and the repo's social preview render. Two
kinds, with two different provenances — one generated, one captured by hand.

| Asset | Shown at | Made by |
| --- | --- | --- |
| `logo-light.png` / `logo-dark.png` | README hero wordmark, 1680×360 displayed at `width="380"` via `<picture>` | `src/build.mjs` |
| `actana-icon.svg` | the Actana mark, geometry verbatim from `actana.ai/favicon/actana.svg` | `src/build.mjs` |
| `icon-256.png` | raster icon for avatars / npm | `src/build.mjs` |
| `banner-social.png` | GitHub social preview, 2560×1280 — uploaded in repo Settings, not linked from the README | `src/build.mjs` |
| `panel-project-light.png` / `panel-project-dark.png` | README hero screenshot | a browser, by hand — see below |
| `panel-fleet-light.png` / `panel-fleet-dark.png` | README, "How it works" | a browser, by hand — see below |
| `harness/*.png`, `harness/*.svg` | README, Supported-harnesses table | vendor marks on a chip — see below |

All generated text is set in **JetBrains Mono** — the product's primary UI font
(Studio look, spec 12) — so the brand type matches the app everywhere.

Full inventory, brand tokens, badge set and the video plan live in
`planning/resource-plan.md`, a sibling folder outside this repo.

## Regenerating the brand PNGs

`src/build.mjs` renders every generated row above from the SVG sources beside
it, straight over the committed files. It needs two things a clean checkout
deliberately does not carry, and it says so with these commands rather than
throwing:

```bash
# 1. the renderer — a native module, kept out of the workspace manifests so
#    every `pnpm install` and CI job avoids a prebuild nothing else uses
pnpm add -w -D @resvg/resvg-js

# 2. the fonts — vendor binaries (OFL-1.1), untracked and gitignored
curl -fsSL -o /tmp/jbmono.zip https://github.com/JetBrains/JetBrainsMono/releases/latest/download/JetBrainsMono.zip
unzip -j /tmp/jbmono.zip "fonts/ttf/JetBrainsMono-*.ttf" -d /tmp/jbmono
mkdir -p docs/assets/src/fonts
for w in Regular:400 Medium:500 Bold:700 ExtraBold:800; do
  cp "/tmp/jbmono/JetBrainsMono-${w%%:*}.ttf" "docs/assets/src/fonts/JetBrainsMono-${w##*:}.ttf"
done

node docs/assets/src/build.mjs
git checkout package.json pnpm-lock.yaml   # leave the manifests as they were
git diff --stat docs/assets/               # commit what actually changed
```

The script loads **only** those four files (`loadSystemFonts: false`). That is
on purpose: falling back to whatever face happens to be installed renders the
wordmark wrong and silently, and a wrong logo is worse than a missing one.

## Recapturing the Panel screenshots

These are not generated, and there is no headless pipeline behind them — the
Panel's own e2e (`scripts/e2e-panel-smoke.mjs`) drives the service over HTTP
and a WebSocket, never a browser. They are photographs of a running Panel, and
what makes them worth their ~1.3 MB is that they are the only thing on the
front page that shows the product rather than describing it.

To retake them so the set stays consistent:

1. Bring up the reference deployment and pair a Core —
   [`deploy/README.md`](../../deploy/README.md) is the whole procedure. Give
   the Core two or three real projects with a handful of sessions across
   `needs-input` / `running` / `finished`, or the status columns photograph
   empty and say nothing.
2. Chrome at **1440×900**, device pixel ratio **2** (DevTools → Toggle device
   toolbar → Responsive, 1440×900, DPR 2), zoom 100%. That is what makes the
   committed files 2880×1800.
3. Capture each view in **both themes** — the README pairs them in a
   `<picture>`, so a light shot without its dark twin renders as a hole for
   half of GitHub's readers. Switch in the Panel's own settings rather than at
   the OS, so what you photograph is the app's own tokens.
   - A project's sessions with one terminal live → `panel-project-light.png`,
     `panel-project-dark.png`
   - Fleet view → `panel-fleet-light.png`, `panel-fleet-dark.png`
4. DevTools → Run command → **Capture screenshot** (viewport, not full page).
5. Read every shot before committing it: real repo paths, hostnames, pairing
   tokens, anything in a terminal pane you would not put on the front page.
   These land on a public README, and a screenshot is the easiest place to leak
   a machine name.

Keep the filenames. The README references them by relative path, which is what
keeps the images rendering on forks.

## The harness marks

`harness/` holds one 48×48 mark per supported Harness, shown at 18px in the
README's Supported-harnesses table. Each is the **vendor's own mark**, unaltered,
on an identical dark rounded chip:

| File | Mark from |
| --- | --- |
| `claude-code.png` | `packages/panel/public/claude.png` — the same asset the Panel renders |
| `cursor-cli.png` | `packages/panel/public/cursor.png` — likewise |
| `codex.svg` | the OpenAI mark, path verbatim from Simple Icons (`SiOpenai` in `react-icons`, which `HarnessLogo.tsx` also uses) |
| `opencode.svg` | `packages/panel/public/opencode.svg`, geometry verbatim |

The chip is not decoration. Both raster marks are near-white
(`#FDF3EE`, `#EDECEC`) because they are drawn for the app's dark surface, so on
GitHub's light theme they would be all but invisible. Putting every mark on the
same `#151b26` chip keeps the vendor artwork untouched — no recolouring — and
makes one set that reads identically in both themes.

Adding a Harness means adding a row here, a mark in `harness/`, and a row in the
README table — which is checked against `HARNESS_REGISTRY` in `@actana/shared`.
