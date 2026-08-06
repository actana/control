# Landing page — control.actana.ai

The plan for the marketing/onboarding page: what it says, how it looks, where
it lives in the repo, and how it ships. Evidence behind every pattern choice is
in [`research/landing-page/landing-page-references-2026-08-06.md`](research/landing-page/landing-page-references-2026-08-06.md)
— ten reference sites (Ollama, GitHub CLI, OpenCode, Starship, Bun, Charm,
Ghostty, Warp, Atuin, mise), the Bunny APIs, the path-filter rules, and
Qcentic's served brand tokens, each claim cited to its primary source.

This document is the plan. The page itself is a follow-up commit on the same
PR.

## 1. What the page is for

One job: a visitor who has never heard of Actana Control understands what it is
in ten seconds and has a working install command on their clipboard in thirty.
Everything else — docs, ADRs, the comparison table — already lives in the repo;
the page links there rather than duplicating it.

Three audiences, in priority order:

1. **The operator-to-be** — runs coding CLIs on several machines, wants one
   view. Gets the pitch and the quickstart.
2. **The evaluator** — comparing against Vibe Kanban / claude-squad / Happy.
   Gets the three differentiators and a link to the README's Related Projects
   table.
3. **The contributor** — gets GitHub, CONTRIBUTING, and the harness-family
   invitation.

## 2. Pattern decisions (from the reference research)

| Decision | Choice | Why (see research §2) |
| --- | --- | --- |
| Primary CTA | Copyable install command above the fold, with a copy button | The dominant pattern on 7 of 10 reference sites (Ollama, OpenCode, Bun, Atuin, mise, Starship, GitHub CLI) |
| Multi-path install | **Two tabs: "Docker Compose" and "Installer"** | Tabs are the standard mechanism (Bun, OpenCode); OS detection is rare (only Warp) and not worth JS. Our two paths mirror the README's "Which one?" — same words, same order |
| Hero demo | **One** asset: `panel-project-*.png`, theme-matched | Every reference site leads with exactly one demo asset; this screenshot is already the README's "shows the product rather than describing it" shot |
| Social proof | GitHub link with star count in nav + harness logo row | OpenCode/Atuin pattern; our stats are young, so the harness marks ("works with the CLIs you already run") carry the proof instead of a stats band |
| Section count | 6 sections, one screen each, then footer — **plus an FAQ, added in implementation** (§3.7) | Reference median; Charm/Warp-length pages exist to sell breadth we don't have yet |
| Closing CTA | Repeat the install block at the bottom | GitHub CLI / Ollama / Atuin / mise all do this |
| Theme | Dual theme via `prefers-color-scheme`, **dark designed first**, no toggle | Light-default dominates the references, but our audience lives in terminals, the product screenshots were designed dark-first, and the Qcentic badge is an on-dark mark. Both themes ship (the asset set already exists in pairs); the media query decides |

## 3. Page structure

Top to bottom. Copy is direction, not final text — final wording is written in
the implementation commit against the README, which is the source of truth for
every product claim.

1. **Nav** — wordmark (logo-light/dark via `<picture>`), then: Docs → GitHub
   `docs/README.md`, Install → `#install`, GitHub (with star badge). Three
   items; the references' minimum-nav pattern.
2. **Hero** — headline + one-line subhead + install tabs + screenshot.
   - Headline direction: the README's own sentence, tightened. Something in
     the family of **"One Panel. Every machine. Real terminals."** with the
     subhead carrying the definition: *"Actana Control is a self-hosted
     control plane for agentic coding — one web Panel drives Cores running
     Claude Code, Codex, Cursor CLI and OpenCode in real PTY sessions against
     your repos."*
   - Install tabs (the two quickstart paths, verbatim from the README):

     ```bash
     # Tab 1 — Docker Compose (the whole product in one command)
     git clone https://github.com/actana/control && cd control
     docker compose -f deploy/docker-compose.yml up -d

     # Tab 2 — Installer (turn this machine into a Core)
     curl -fsSL https://raw.githubusercontent.com/actana/control/main/install.sh | bash
     ```
   - Screenshot: `panel-project-dark.png` / `panel-project-light.png`,
     theme-matched, `loading="eager"`, width-capped like the README's 900px.
3. **Harness row** — six **lockups, not bare icons**: each harness is its
   mark *plus its name as text* ("Claude Code", "Codex", "Cursor CLI",
   "OpenCode", "Hermes", "Pi"), so the row reads without hovering. Built as
   wide chips: the existing 48×48 mark from `docs/assets/harness/` on the
   left, the name set in JetBrains Mono beside it, on the same chip surface
   the square marks already use. Composing our own lockups (rather than
   hunting six vendors' official wordmark assets) keeps one consistent
   typeface across the row, reuses artwork the repo already ships, and stays
   inside the documented grammar (`docs/assets/README.md`): **supported =
   solid chip, planned = dashed muted chip** — the text label inherits it
   (planned names muted, no vendor mark). Implemented as HTML/CSS chips
   (mark `<img>` + text), not baked images — crisp at every DPI and trivially
   restyled per theme.
   Caption: "Claude Code · Codex · Cursor CLI · OpenCode work today — Hermes
   and Pi are next, and the family is open."
4. **Three features** — one card each, taken from the README's Features list,
   in this order because they are the differentiators the Related Projects
   table proves out:
   - *One Panel, many machines* (the fleet claim — pair with
     `panel-fleet-*.png` or fold that shot in here)
   - *Real terminals, not a transcript* (PTY, type into it)
   - *Your code never moves* (Core-owned state, no upload, no telemetry —
     one privacy sentence here, linking to the README's Security section)
5. **How it works** — the README's mermaid diagram redrawn as a small static
   SVG (browser → Panel → Cores → PTYs). One paragraph, link to CONTEXT.md
   and the ADRs.
6. **FAQ** — nine `<details>`, native, no JS, findable by in-page search.
   Added during implementation, not in the original six: the first developer to
   see the page asked *"why not just spin up a container or a VM and SSH into
   it?"*, and a page that cannot answer that in its own words loses the reader
   who asks it. So the first entry answers it directly and is open by default —
   conceding that a multiplexer wins on one machine, then naming what changes
   on the plural: per-box SSH and multiplexer setup you repeat by hand,
   needs-input status across every Core, machines that have no clean SSH story
   at all (the workstation that also runs Blender, the laptop that sleeps), a
   browser instead of a shell holding your keys, no inbound SSH port because
   the Panel dials out, and session history in the Core's SQLite rather than a
   multiplexer's memory. The second entry is its natural follow-up — several
   Cores on one host, one per container, isolated from each other and all in
   one Panel — which is `deploy/README.md`'s documented "Adding a second Core",
   not a new claim.

   The rest are the questions that follow — is it just a web terminal, does my
   code get uploaded, what must I expose, is a Core a sandbox, which CLIs, is
   one machine overkill, what does it cost.

   **Two rules for this section.** Every answer is a README (or
   `deploy/README.md`) claim in its own words, so the FAQ can never drift ahead
   of what ships: **nothing unreleased is named here** — no roadmap components,
   no planned subsystems — because the page's whole credibility is that it
   claims only what you can run today, and the README already holds back a
   release badge for the same reason. And the answers concede where conceding
   is true — "I only have one machine" is answered *probably, yes* — because an
   FAQ that never gives anything up reads as marketing and gets skipped.
7. **Closing install** — the same tabs again, plus links: deploy/README.md,
   DEPLOY.md, INSTALL.md.
8. **Footer** — Docs · GitHub · Issues · License (MIT) · "A derivative work of
   Mission Control by AgentSystem Labs" (the NOTICE attribution — it is on the
   README and belongs here too), © Actana.
9. **The Qcentic badge** — see §5.

## 4. Visual design

**Colors: the Panel's own tokens, not a new palette.** The landing page uses
the Studio token values from `packages/panel/src/styles.css` so the screenshot
sits on a page that looks like it. The subset worth carrying:

| Token | Dark | Light |
| --- | --- | --- |
| canvas `--bg` | `#0e1722` | `#f3f4f6` |
| card `--surface-card` | `#122231` | `#ffffff` |
| border `--border` | `#1c3346` | `#e5e7eb` |
| text `--text-primary` | `#f9fafb` | `#111827` |
| accent `--brand-accent` | `#29a9e0` | `#29a9e0` |
| accent hover | `#1786c2` | `#1786c2` |
| wordmark gradient | `#279ed6 → #6abbe1` | same |

The shields.io badges already standardize `#101723` label / `#279ed6` accent —
the same family. Copy the values into the page's own small CSS variable block;
do **not** import the Panel's stylesheet (it is an app stylesheet, and the
landing page must not grow a dependency on the workspace build).

**Typography: JetBrains Mono, self-hosted.** It is already the product's
primary UI font (Studio look, spec 12) and the brand-asset font
(`docs/assets/README.md`), so the page uses it for everything — headings,
body, code — the way the app does, not just for code blocks. (Among the
references only Bun pushes mono into headings; for us it is not a stunt, it is
the product's actual face.) Mechanics:

- OFL-1.1 — free commercial use, redistribution allowed, no attribution
  required (research §3). Commit the woff2 files plus the OFL license text.
- Self-host from the pull zone: two static weights (Regular 400, Bold 700)
  as woff2 from the JetBrains release's `fonts/webfonts/` set, declared with
  `@font-face` + `font-display: swap`. No Google Fonts request — the page
  makes zero third-party requests, which keeps the README's "no telemetry"
  posture true of the front door too.

**Imagery: what the repo already has.** Logos, icon, both screenshot pairs,
harness marks — all committed under `docs/assets/`. The landing folder gets
its own copies (see §6) because the CDN serves only that folder; copying
rather than referencing keeps the deploy a dumb folder upload.

**No framework, no build step.** One `index.html`, one `styles.css`, a few KB
of vanilla JS (tab switcher, copy buttons) — nothing else. Every reference
page's value is in its first screen, not its stack; a static folder deploys to
Bunny with a PUT loop, previews with `python3 -m http.server`, and can never
break the workspace build. If the page ever needs more, that is its own ADR.

## 5. The "Built by Qcentic" badge

A small fixed chip, bottom-right corner, present on all scroll positions:

- **Content:** "Built by" in small text + the Qcentic mark, the whole chip a
  link to `https://qcentic.com` (`rel="noopener"`).
- **Treatment:** Qcentic's identity is deliberately monochrome — served tokens
  are `#0a0a0a` bg / `#f5f5f5` ink / white accent (research §6). So the badge
  is a **dark chip in both themes**: `#0a0a0a` background, `#2a2a2a` border
  (their `--color-line`), white lockup. This is the same move as the harness
  marks — vendor artwork untouched, on a chip that carries its own surface —
  and it keeps Qcentic's mark out of Actana's blue.
- **Asset:** `qcentic-lockup-pulse-on-dark.svg` from qcentic.com, **copied
  into the repo** — the page is served entirely from our pull zone, so no
  hotlinking (asset URLs recorded in research §6; it is our own company's
  mark, so redistribution is ours to grant).
- **Size:** unobtrusive — roughly 28–32px tall, generous padding, small
  radius (Qcentic's `--radius: 2px`), no animation, no dismiss button (a
  dismiss implies it is in the way; keep it small enough not to be).

## 6. The folder

A dedicated top-level folder, **`landing/`** (folder names with spaces fight
every glob and URL they ever meet):

```
landing/
├── README.md          # what this is, how to preview, how it deploys
├── index.html
├── styles.css
├── main.js            # tabs + copy buttons; a few KB, no dependencies
├── fonts/
│   ├── JetBrainsMono-Regular.woff2
│   ├── JetBrainsMono-Bold.woff2
│   └── OFL.txt
└── assets/            # copied from docs/assets/ + the Qcentic mark
    ├── logo-light.png / logo-dark.png / actana-icon.svg
    ├── panel-project-{dark,light}.png / panel-fleet-{dark,light}.png
    ├── harness/…      # the six marks
    ├── how-it-works.svg
    ├── og-image.png   # banner-social.png reused
    └── qcentic-lockup-on-dark.svg
```

Head extras: `<meta name="description">`, OG/Twitter tags reusing
`banner-social.png`, favicon from `actana-icon.svg` + `icon-256.png`,
`<meta name="theme-color">` per scheme. No analytics of any kind.

`landing/README.md` records the docs/assets provenance of each copied asset so
a screenshot retake (the procedure in `docs/assets/README.md`) knows to refresh
both copies.

## 7. CI/CD — `landing.yml`

A fourth entry-point workflow, `.github/workflows/landing.yml`:

```yaml
on:
  push:
    branches: [main]
    paths: ['landing/**']
  workflow_dispatch: {}      # redeploy without a commit; also the first deploy
```

- PRs do **not** deploy — the CDN serves `main`, the same rule the container
  `:edge` tags follow. There is no PR-side check at all: the page has no
  build, so there is nothing to gate that `git` doesn't already do. (If a
  validation step ever appears — link check, HTML lint — it goes in this
  workflow on a `pull_request` + same-paths trigger, and **must never** join
  the ruleset's required checks; see the gotcha below.)
- One job, two steps after checkout: **upload** the `landing/` folder to Bunny
  Edge Storage, then **purge** the pull zone. Preferred implementation:
  `ayeressian/bunnycdn-storage-deploy` (Marketplace-current, v2.4.x,
  maintained as of 2026-08; the nicer `R-J-dev/bunny-deploy` is archived —
  research §4.4), pinned by commit SHA like every third-party action in
  `ci.yml`. It does upload + optional `remove` + purge in one step, with a
  `purgePullZoneDelay` to let storage replicate before the purge. Fallback if
  we'd rather own the loop: a ~20-line `curl` script PUT-ing each file —
  the API is one header (research §4.1–4.2).

**Secrets and variables** (Settings → Secrets and variables → Actions; you set
these after creating the Bunny zones):

| Name | Kind | What it is |
| --- | --- | --- |
| `BUNNY_STORAGE_PASSWORD` | secret | the storage zone's password — the `AccessKey` for uploads |
| `BUNNY_API_KEY` | secret | the account API key — the `AccessKey` for the purge call |
| `BUNNY_STORAGE_ZONE` | variable | storage zone name |
| `BUNNY_STORAGE_ENDPOINT` | variable | regional host, e.g. `storage.bunnycdn.com` |
| `BUNNY_PULL_ZONE_ID` | variable | integer pull-zone id |

The two keys are different credentials with different blast radii — do not
"simplify" them into one.

`BUNNY_STORAGE_ENDPOINT` is optional in practice: the workflow falls back to
`storage.bunnycdn.com` when the variable is unset, so only a non-default region
needs it.

**These five are deliberately not written up in `REPO_SETUP.md`.** They are
account setup on a third-party dashboard, done once by whoever holds the Bunny
account, and the workflow file already names every one of them at its point of
use. A second copy in a doc is a second thing to keep true.

**Repo-convention consequences** — the parts that go red if forgotten:

1. `scripts/__tests__/workflows.test.mjs` asserted the workflows directory was
   *exactly* three entry points + `container-image.yml` (ADR 0016 D34). It now
   asserts four, and its comment says why — the workflow-count decision is
   deliberately revised, not drifted. D34 carries the amendment.
2. `docs/ci-cd.md`'s "At a glance" table gets a `landing.yml` row.
   `ci.yml`'s `paths-ignore` gets `landing/**` on the same grounds as
   `docs/**`: the page ships no code into either image, so a copy fix on the
   front door must not rebuild and republish two containers.
3. **Never add this workflow to the "Protect main" ruleset's required
   checks.** A path-filtered workflow that doesn't run leaves its check
   **Pending forever, blocking every PR that doesn't touch `landing/`**
   (GitHub's documented behavior, research §5 — and our ruleset pins check
   names, see `REPO_SETUP.md`). Same reason the deploy must not be folded
   into `ci.yml` behind a path filter.
4. `paths` and `paths-ignore` cannot be combined on one event; exclusions use
   `!` negation inside `paths`, order-sensitive (research §5).

**Bunny-side setup (yours, manual, once):** create a storage zone, create a
pull zone with that storage zone as origin, add hostname `control.actana.ai`,
CNAME it to `{zone}.b-cdn.net`, enable the free Let's Encrypt cert + Force
SSL (research §4.5). Then set the five values above and run the workflow once
via `workflow_dispatch`.

## 8. Implementation checklist (the follow-up commit(s) on this PR)

- [x] `landing/` — page, styles, JS, fonts (with OFL.txt), copied assets,
      folder README
- [x] `landing/assets/how-it-works.svg` — the redrawn diagram
- [x] `.github/workflows/landing.yml`
- [x] Amend `scripts/__tests__/workflows.test.mjs` (entry-point list + comment),
      and `ci.yml`'s `paths-ignore`
- [x] `docs/ci-cd.md` — At-a-glance row, and the note on why it is its own file
- [x] Amend ADR 0016 D34 — the count is four entry points
- [ ] After merge, manual: Bunny zones, DNS CNAME, cert, secrets/vars,
      `gh workflow run landing.yml --repo actana/control`, verify
      `https://control.actana.ai`, purge once

Not done, deliberately: the five Bunny values are **not** written into
`REPO_SETUP.md` — see §7.

Out of scope, deliberately: a docs site (docs stay in-repo), analytics (the
README promises none, the front door keeps the promise), a demo video (the
README holds a slot for one; the page inherits it when it exists), OS
detection, newsletter/waitlist forms.
