# `landing/` — the page behind control.actana.ai

One `index.html`, one stylesheet, one script, the fonts and the images. No
framework, no build step, no dependency on the workspace — `landing/` is a dumb
folder that gets uploaded as-is. The plan behind it, and the reference research
every pattern choice came from, is
[`docs/landing-page.md`](../docs/landing-page.md).

## Preview it

```bash
python3 -m http.server 8000 --directory landing
# then open http://localhost:8000
```

That is the whole toolchain. Both themes are driven by
`prefers-color-scheme`, so switch your OS appearance (or DevTools →
Rendering → Emulate CSS media feature) to see the other one — there is no
toggle on the page by design.

Two things behave differently on a plain-HTTP preview than in production: the
copy buttons fall back to `document.execCommand` because `navigator.clipboard`
only exists on secure origins, and the absolute OG/Twitter image URLs point at
the live host rather than localhost.

## What is in here

| Path | What it is |
| --- | --- |
| `index.html` | The page. Six sections, then the footer. |
| `styles.css` | Every rule. Dark is `:root`; light is the `prefers-color-scheme` override. |
| `main.js` | Install tabs + copy buttons. Nothing else. |
| `fonts/` | JetBrains Mono Regular + Bold as woff2, and `OFL.txt`. |
| `assets/` | Images — see the provenance table below. |

**The colour tokens are copied from `packages/panel/src/styles.css`**, not
imported, so the page the screenshots sit on looks like the product inside
them. If the Studio palette moves, the values in `styles.css` under
`--bg` / `--surface-card` / `--border` / `--text-*` / `--brand-accent` are the
ones to re-sync.

**The fonts are self-hosted** so the page makes zero third-party requests. The
README promises no telemetry; the front door keeps the promise, which means no
Google Fonts, no CDN, no analytics, and no star-count badge that would phone
an API on every visit.

## Asset provenance

Everything here except the Qcentic mark is a **copy** of something in
`docs/assets/` — the CDN serves this folder and only this folder, so
referencing across directories is not an option. Copies drift, so:
**a screenshot retake or a logo change has to be applied twice.** The retake
procedure itself is in [`docs/assets/README.md`](../docs/assets/README.md).

| `landing/assets/…` | Copied from |
| --- | --- |
| `logo-light.png`, `logo-dark.png` | `docs/assets/` — same files |
| `actana-icon.svg`, `icon-256.png` | `docs/assets/` — favicon and apple-touch icon |
| `panel-project-{dark,light}.png` | `docs/assets/` — the hero shot |
| `panel-fleet-{dark,light}.png` | `docs/assets/` — the Fleet shot under the features |
| `og-image.png` | `docs/assets/banner-social.png`, renamed for what it does here |
| `harness/*.png`, `harness/*.svg` | `docs/assets/harness/` — all six marks, unaltered |
| `how-it-works.svg` | **Original.** The README's mermaid flowchart redrawn as a static asset. |
| `qcentic-lockup-pulse-on-dark.svg` | **Not from this repo** — `https://qcentic.com/logo/qcentic-lockup-pulse-on-dark.svg`, vendored rather than hotlinked so the page stays single-origin. |

Two notes on the artwork:

- **The harness lockups are HTML, not baked images.** Each is the existing
  48×48 mark plus its name in text, on a chip whose surface is the same
  `#151b26` the marks are already drawn on — so the mark's own chip dissolves
  into the lockup instead of stacking a second rounded rectangle inside the
  first. The grammar from `docs/assets/README.md` still holds: solid chip means
  shipped, dashed means planned, and the label goes muted with it.
- **`how-it-works.svg` themes itself.** An SVG loaded through `<img>` gets none
  of the page's CSS, so it carries its own `prefers-color-scheme` block and
  uses the generic mono stack — it cannot reach the woff2 in `fonts/` either.

## How it ships

`.github/workflows/landing.yml` uploads this folder to Bunny Edge Storage and
purges the pull zone, on push to `main` under `landing/**` and on
`workflow_dispatch`. Pull requests do not deploy: the CDN serves `main`, and
`main` is only ever released code — the same rule the container tags follow,
where a published tag names something a person approved.

There is no PR-side check, because there is no build to break. If one ever
appears — a link check, an HTML lint — it belongs in that workflow on a
`pull_request` trigger with the same path filter, and it must **never** be
added to the branch ruleset's required checks: a path-filtered workflow that
does not run leaves its check pending forever, blocking every PR that does not
touch `landing/`.
