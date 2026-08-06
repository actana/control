# Landing-page references for control.actana.ai — 2026-08-06

Primary-source research for the marketing/onboarding landing page (dedicated
folder in this repo, deployed to Bunny CDN via a path-filtered GitHub Actions
workflow). All claims cite the URL they were read from; pages were fetched live
on 2026-08-06 unless noted.

---

## 1. Reference sites

### 1.1 Ollama — https://ollama.com

- **Headline:** "The easiest way to build with open models". **Subhead:** "Run
  any app or agent with open models".
- **Primary CTA:** a copyable shell one-liner in a code block —
  `curl -fsSL https://ollama.com/install.sh | sh` — with the escape hatch
  "paste this in terminal, or download Ollama" linking to `/download`.
- **Section order:** hero + install command → app/agent integration showcase
  (Claude Code etc.) → cloud/pricing tier → data-privacy messaging → get-started
  CTA → footer.
- **Style:** light default theme, minimal accent color, monospace only in the
  command block, illustration-led hero (no terminal recording on the homepage).
- **Multi-platform:** single universal curl command; platform-specific options
  live on a separate `/download` page (no tabs, no OS detection on the hero).
- **Nav:** Models, Docs, Pricing, Sign in, Download. **Footer:** Blog,
  Download, Docs, GitHub, Discord, X, Meetups, Careers, Privacy, Terms,
  "© 2026 Ollama Inc."

### 1.2 GitHub CLI — https://cli.github.com

- **Headline:** "Take GitHub to the command line". **Subhead:** "GitHub CLI
  brings GitHub to your terminal. Free and open source."
- **Primary CTA:** copyable code block `brew install gh` with a Copy button and
  an Install button; platform-specific install options listed directly below.
- **Section order:** nav (Copilot CLI, Manual, Release notes) → hero +
  Homebrew install → per-platform install options (macOS, Windows, Linux;
  brew/WinGet/apt/dnf/zypper plus binary downloads) → command-example showcase
  (`gh issue list`, `gh pr status`, …) → feature sections ("Your entire GitHub
  workflow", "Script and customize", "Enterprise-ready", "We <3 community") →
  repeated install section → footer.
- **Style:** light page with **dark monospace terminal blocks** as the main
  imagery; GitHub blue links; monospace only for code/terminal content.
- **Multi-platform:** cascading lists of package-manager commands and download
  links, not interactive tabs, no OS detection.
- Notable pattern: the install block is repeated again at the bottom of the
  page so the CTA is present after the pitch.

### 1.3 OpenCode — https://opencode.ai

- **Headline:** "The open source AI coding agent". **Subhead:** "Free models
  included or connect any model from any provider, including Claude, GPT, …".
- **Primary CTA:** copyable install block `curl -fsSL https://opencode.ai/install | bash`
  presented as a **tabbed switcher: `curl`, `npm`, `bun`, `brew`, `paru`**;
  secondary "Download now" buttons to `/download`.
- **Section order:** nav → "New" announcement banner → hero (headline, install
  tabs, demo video) → "What is OpenCode?" feature bullets → docs link →
  **statistics band (160K stars, 900 contributors, 7.5M monthly developers)** →
  privacy statement → FAQ accordion (8 questions) → product promo (Zen) → email
  waitlist → footer.
- **Style:** light default with a dark variant; muted gray/brown palette
  (#656363, #CFCECD, #211E1E); monospace in code blocks, sans-serif body.
- **Footer:** GitHub (with star count), Docs, Changelog, Discord, X,
  "©2026 Anomaly", Brand, Privacy, Terms, language selector.
- Most relevant comp for us: same product category, install-tab pattern, GitHub
  stars as social proof directly in nav/footer.

### 1.4 Starship — https://starship.rs

- **Headline:** "The minimal, blazing-fast, and infinitely customizable prompt
  for any shell!"
- **Primary CTA:** "Get Started →" button into the guide; install section
  offers `curl -sS https://starship.rs/install.sh | sh` plus package managers
  (Homebrew, Winget).
- **Section order:** nav + language selector (11 locales) → hero → three
  feature cards ("Compatibility First", "Rust-Powered", "Customizable") →
  prerequisites (Nerd Font) → quick install → per-shell config instructions
  (Bash, Fish, Zsh, PowerShell, Ion, Elvish, Tcsh, Nushell, Xonsh, Cmd).
- **Style:** VuePress-docs aesthetic; monospace for all commands; the homepage
  doubles as the docs entry (hero → docs guide, not a separate marketing site).

### 1.5 Bun — https://bun.sh

- **Headline:** "Bun is a fast JavaScript all-in-one toolkit". **Subhead:**
  "Bun is a fast, incrementally adoptable all-in-one JavaScript, TypeScript &
  JSX toolkit. … Bun aims for 100% Node.js compatibility."
- **Primary CTA:** section headed "Install Bun v1.3.14" with a **two-tab
  switcher** in copyable blocks: Linux & macOS `curl -fsSL https://bun.sh/install | bash`,
  Windows `powershell -c "irm bun.sh/install.ps1 | iex"`, plus a "View install
  script" link. No brew/npm on the homepage.
- **Section order:** nav → hero + install tabs → "USED BY" logo strip (Lovable,
  CodeRabbit, Replit, Cursor) → benchmark chart ("Bundling 10,000 React
  components") → "Four tools, one toolkit" → "Who uses Bun?" (Claude Code,
  Railway, Midjourney) → comparison tables → feature grid ("Everything you need
  to build & ship") → per-tool sections titled as commands ("$ bun run",
  "$ bun install", "$ bun test") → interactive code examples ("The APIs you
  need. Baked in.") → docs links → Twitter-testimonial carousel → footer.
- **Style:** light default, warm beige/pink brand accents, heavy monospace
  usage including **section headings written as shell commands** ("$ bun run"),
  benchmark bar charts as imagery.
- **Footer attribution:** "Baked with ❤️ in San Francisco"; Resources / Toolkit
  / Project link columns; license link into docs.

### 1.6 Charm — https://charm.sh → redirects 301 to https://charm.land

- **Headline:** "We make the command line glamorous." Crush section: "Your new
  coding bestie, now available in your favourite terminal."
- **Primary CTA:** "Get Crush" button → GitHub repo (no install command on the
  homepage; each tool's README carries install).
- **Section order:** nav (Home, Libs, Apps, Enterprise, Blog) → Crush hero →
  "Build with Charm" 8 library cards (Bubble Tea, Huh, Lip Gloss, Wish,
  Glamour, Bubbles, Log, Harmonica) → "Industrial grade" company logos →
  "More stuff" app cards (Mods, gum, Glow, Skate) → "We love open source" →
  newsletter ("Tail the logs") → Discord CTA ("Let's chat!") → footer.
- **Style:** playful, mascot illustrations per library, violet accents; footer
  tagline "haters > /dev/null™", contact vt100@charm.land, © 2026.
- Note the **charm.sh → charm.land 301** — a live example of a project moving
  apex domains while keeping the old one redirecting.

### 1.7 Ghostty — https://ghostty.org

- Homepage could not be fully fetched (content truncated by the fetch tool);
  hero copy per https://ghostty.org/ as surfaced in search results: "Ghostty is
  a fast, feature-rich, and cross-platform terminal emulator that uses
  platform-native UI and GPU acceleration."
- **Download page** (https://ghostty.org/download): organized **by OS with
  direct links rather than tabs** — macOS "Universal Binary" (Apple Silicon +
  Intel, macOS 13+) or Package Manager; Linux "Package Manager" or "Build From
  Source". Version shown prominently ("Version 1.3.1") with Release Notes
  link. Wordmark + logo SVG at top; light/minimal aesthetic; footer links to
  docs, Discord, GitHub. Package-manager commands live in docs pages, not on
  the download page itself.

### 1.8 Warp — https://www.warp.dev

- **Headline:** "The open platform for automating development". **Subhead:**
  "Infrastructure to build, measure, and interact with agents across your SDLC
  — so you ship more and spend less."
- **Primary CTAs:** dual — "Start Automating" (sales) and "Download Warp
  Terminal". Download section uses **OS detection plus per-platform tabs**
  (macOS DMG + `brew install --cask warp`; Linux .deb/.rpm/.tar.zst/AppImage in
  x64/ARM64; Windows .exe + `winget install Warp.Warp`).
- **Section order:** nav (Products/Solutions/Resources menus) → hero + dual
  CTAs → feature grid → **stats band** (developer count, Fortune-500 %, daily
  agents) → partner/customer logo strip (Anthropic, OpenAI, Docker, Google,
  Microsoft, Stripe, …) → "Why Warp" tabbed product showcases → open-source
  announcement video → testimonial carousel → download section → footer.
- **Style:** **dark default**, blue/cyan accents, modern sans-serif, product
  screenshots + diagrams + video. Footer: Product/Resources/Company/Legal/
  Connect columns, status indicator, "All Rights Reserved © 2026".

### 1.9 Atuin — https://atuin.sh

- **Headline:** "Making your terminal magical". **Subhead:** "Sync, search, and
  back up your shell history with end-to-end encryption. Ask Atuin AI for help
  without leaving your prompt."
- **Primary CTA:** copyable one-liner
  `curl --proto '=https' --tlsv1.2 -LsSf https://setup.atuin.sh | sh`.
- **Section order:** hero + install → **social-proof stats (30K+ stars, 300+
  contributors, 600M+ synced commands)** → company logo grid → feature sections
  with interactive terminal mockups → getting-started steps → FAQ → closing CTA
  → footer.
- **Style:** green accent (logo "horizontal-green"), animated turtle mascot,
  terminal mockups, monospace for commands. Platform support stated as one
  line of text: "Available for macOS, Linux, and Windows · bash, zsh, fish,
  and more" (no tabs).
- **Footer includes a "Brand assets" section with logo/turtle SVG and PNG
  downloads** — a nice pattern for an OSS project.

### 1.10 mise — https://mise.jdx.dev

- **Headline:** "Your dev environment, prepped and ready". **Subhead:** "One
  tool that manages dev tools, env vars, and tasks per project."
- **Primary CTA:** one-liner `curl https://mise.run | sh`; secondary "Getting
  Started" and "Demo" links. "More install methods" deferred to docs.
- **Section order (themed as a menu):** hero → "The Idea" (concept + TOML
  example) → "The Menu" (three core features) → "The Pantry" (1000+ supported
  tools) → "Chef's Special" (related product promo) → "The Recipe"
  (step-by-step with terminal demos) → "Ready When You Are" closing CTA.
- **Style:** light + dark logo variants, monospace terminal output, blue links,
  consistent culinary metaphor giving the page a memorable voice.

---

## 2. Synthesis — what the best onboarding pages share

Across the ten pages above:

1. **Copyable install one-liner above the fold** is the dominant primary CTA
   for CLI/OSS tools (Ollama, OpenCode, Starship, Bun, Atuin, mise, GitHub
   CLI). GUI-first products (Warp, Ghostty) use download buttons instead.
   Charm is the outlier (button → GitHub).
2. **Tabs for platform variants, not OS detection**, is the common mechanism
   when more than one command is shown: Bun (Linux&macOS / Windows), OpenCode
   (curl/npm/bun/brew/paru). Ollama/mise/Atuin instead show **one universal
   curl command** and push alternatives to a download/docs page — the simplest
   credible pattern. Only Warp does true OS detection.
3. **One demo asset in the hero** — a video (OpenCode, Warp), terminal mockup
   (Atuin, GitHub CLI), or product screenshot. Nobody leads with more than one.
4. **GitHub social proof near the top**: star counts in nav/footer (OpenCode
   "GitHub 160K") or a stats band (OpenCode, Atuin, Warp: stars, contributors,
   usage volume).
5. **Minimal nav**: 3–6 items, almost always including Docs and GitHub
   (Ollama, OpenCode, Atuin, Bun, mise).
6. **Monospace is used for commands everywhere, but only Bun pushes it into
   headings** — and there as literal shell commands ("$ bun run"), which reads
   as intentional rather than decorative.
7. **Light default is the norm** (Ollama, GitHub CLI, OpenCode, Bun, Starship,
   Ghostty); Warp is the notable dark-default. Several offer both.
8. **Repeat the install CTA at the bottom** (GitHub CLI, Ollama, Atuin, mise —
   all close with a get-started section after the pitch).
9. **Footers**: docs + GitHub + Discord/community + license/legal + short
   attribution line ("Baked with ❤️ in San Francisco"; "©2026 Anomaly";
   "haters > /dev/null™"). Atuin additionally publishes brand assets in the
   footer.

---

## 3. JetBrains Mono

- **Official page:** https://www.jetbrains.com/lp/mono/ — tagline "A free and
  open source typeface for developers"; positioned as the default editor font
  in JetBrains IDEs; code ligatures; weights from Thin to ExtraBold with
  matching italics.
- **License:** per https://github.com/JetBrains/JetBrainsMono — the typeface is
  under the **OFL-1.1 License** ("the source code is available under Apache 2.0
  License"); "can be used free of charge, for both commercial and
  non-commercial purposes"; no credit required (appreciated). OFL-1.1 permits
  bundling/redistribution, so shipping the font files in this repo and serving
  them from Bunny is fine.
- **Formats:** the GitHub repo ships `.ttf`, `.otf`, **`woff2`**, and a
  variable `.ttf`; 8 styles Thin→ExtraBold each with italics; a "JetBrains
  Mono NL" (no-ligatures) variant exists
  (https://github.com/JetBrains/JetBrainsMono).
- **Google Fonts:** yes, served as a specimen at
  https://fonts.google.com/specimen/JetBrains+Mono (designers Philipp Nurullin
  and Konstantin Bulenkov; 8 weights 100–800 plus variable font). Also
  packaged for self-hosting via npm as `@fontsource/jetbrains-mono`
  (https://www.npmjs.com/package/@fontsource/jetbrains-mono).
- **Best practice for our CDN deploy:** self-host the woff2 (from the GitHub
  release `fonts/webfonts/` set or the fontsource package) rather than linking
  Google Fonts — no third-party request, no consent implications, and Bunny
  serves it from the same pull zone. Subset needed weights (e.g. Regular +
  Bold, or the variable font) and declare with `@font-face` +
  `font-display: swap`.

---

## 4. Bunny CDN deployment mechanics

### 4.1 Storage upload (Edge Storage API)

Per https://bunny.net/docs/reference/put_-storagezonename-path-filename
(docs.bunny.net redirects there):

- **Endpoint:** `PUT https://{storageEndpoint}/{storageZoneName}/{path}/{fileName}`
- **Auth header:** `AccessKey` — "The storage zone password also doubles as
  your API key." (This is the **storage-zone password**, not the account key.)
- **Regional endpoints:** Falkenstein `storage.bunnycdn.com`, New York
  `ny.storage.bunnycdn.com`, Los Angeles `la.storage.bunnycdn.com`, Singapore
  `sg.storage.bunnycdn.com`, Sydney `syd.storage.bunnycdn.com`. Use the
  endpoint of the zone's primary region.
- Body is the raw file (`application/octet-stream`, "without any type of
  encoding"); optional `Checksum` header (SHA256, hex uppercase); **201** on
  success, 400 on failure; "If the directory tree does not exist, it will be
  created automatically."

### 4.2 Pull-zone cache purge

Per https://bunny.net/docs/reference/pullzonepublic_purgecachepostbytag:

- **Endpoint:** `POST https://api.bunny.net/pullzone/{id}/purgeCache`
- **Auth header:** `AccessKey` — here it is the **account API key** (different
  credential from the storage password).
- Path param `{id}` = pull-zone ID (integer); optional JSON body
  `{"CacheTag": "..."}`; responses 204 purged / 401 auth failed / 404 no such
  pull zone.

### 4.3 Secrets/values a workflow needs

| Value | Used for | Where it lives |
|---|---|---|
| Storage zone name | upload URL path | dashboard, not secret |
| Storage zone password | `AccessKey` for storage PUT | secret |
| Storage endpoint hostname | regional upload host | config, not secret |
| Account API key | `AccessKey` for purge | secret |
| Pull zone ID | purge URL | config, not secret |

### 4.4 GitHub Actions options

- **ayeressian/bunnycdn-storage-deploy** — Marketplace "BunnyCDN storage
  deployer", actively maintained (v2.4.0 released 2026-08-02; v2.4.5 current
  on the Marketplace). Runs on Node 24 (`dist/index.js`). Inputs (from
  https://github.com/ayeressian/bunnycdn-storage-deploy/blob/master/action.yml):
  `upload`, `source` (required), `destination`, `storageZoneName` (required),
  `storagePassword`, `storageEndpoint` (default `storage.bunnycdn.com`),
  `accessKey`, `pullZoneId`, `purgePullZone`, `purgePullZoneDelay` (seconds of
  delay before purge "to give storage time to replicate first"), `remove`
  (wipe storage before upload), `maxRetries` (default 5). Covers our whole
  pipeline (upload + optional remove + purge) in one step.
  (https://github.com/ayeressian/bunnycdn-storage-deploy,
  https://github.com/marketplace/actions/bunnycdn-storage-deployer)
- **R-J-dev/bunny-deploy** — had nicer delta-upload (checksum-based "doesn't
  upload unchanged files") but is **"ARCHIVED & DEPRECATED … no longer
  actively maintained"** per its README — do not use.
  (https://github.com/R-J-dev/bunny-deploy)
- **Official BunnyWay CLI** exists at https://github.com/BunnyWay/cli
  (bunny.net CLI with login/deploy commands) — young; the third-party
  own3d/bunny-cli (PHP/Composer) also exists (https://github.com/own3d/bunny-cli).
  For a static folder, plain `curl` PUTs or the ayeressian action are the
  lower-dependency choices.

### 4.5 Custom domain + TLS (control.actana.ai)

Per https://bunny.net/docs/cdn/ssl-setup (support.bunny.net articles return
403 to non-browser fetches; same steps summarized in the Support Hub article
"How to set up a custom CDN hostname",
https://support.bunny.net/hc/en-us/articles/207790279):

1. Pull Zone → **General → Hostnames** → add `control.actana.ai`.
2. Create a **CNAME** from `control.actana.ai` to the zone's
   `{zone}.b-cdn.net` hostname (TTL ≤ 3600; if DNS is behind Cloudflare, the
   proxy/orange-cloud must be off or validation fails).
3. In Linked Hostnames, **Enable** SSL → "Add Free Let's Encrypt Certificate"
   → Continue. "Bunny issues and installs the certificate automatically.
   Renewal is handled for you." A Force SSL toggle on the hostname redirects
   HTTP→HTTPS.

The pull zone's origin is the storage zone (linked at pull-zone creation), so
the flow is: workflow PUTs files → storage zone → pull zone caches → purge.

---

## 5. Path-filtered GitHub Actions workflow

Per https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#onpushpull_requestpull_request_targetpathspaths-ignore:

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'site/**'          # only run when files under site/ change
```

- `*` and `**` glob wildcards; "The `paths` and `paths-ignore` keywords accept
  glob patterns".
- **"You cannot use both the `paths` and `paths-ignore` filters for the same
  event"** — to exclude within an include, use `!` negation inside `paths`,
  where **order matters**: "A matching negative pattern (prefixed with `!`)
  after a positive match will exclude the path", and a later positive match
  re-includes it. Example from the docs:

  ```yaml
  on:
    push:
      paths:
        - 'sub-project/**'
        - '!sub-project/docs/**'
  ```

- **Required-check gotcha (matters for our "Protect main" ruleset, which pins
  CI check names — see memory note `rulesets-pin-check-names`):** "If a
  workflow is skipped due to path filtering … checks associated with that
  workflow will remain in a 'Pending' state. A pull request that requires
  those checks to be successful will be blocked from merging." So the deploy
  workflow's job name must **not** be added to the ruleset's required checks;
  conversely, don't fold the deploy into `ci.yml` under a path filter or it
  will dead-lock unrelated PRs.
- **Large-diff gotcha:** "If the generated diff contains more than 3,000 files
  and the files the workflow filter matches are not in the first 3,000
  returned by the filter, the workflow will not run."

---

## 6. Qcentic branding — https://qcentic.com

- **Company/tagline:** "Qcentic GmbH — From idea to working software" (page
  `<title>` and og:title). Meta description: "Qcentic GmbH runs fixed-price,
  fixed-timeline Sprints that deliver a PoC or MVP in 3 to 10 weeks."
- **Visual identity (from the served HTML/CSS at https://qcentic.com and
  https://qcentic.com/assets/footer-BtJO5LD4.css):** dark site. CSS custom
  properties: `--color-bg: #0a0a0a`, `--color-ink: #f5f5f5`,
  `--color-dim: #8a8a8a`, `--color-line: #2a2a2a`, `--color-accent: #ffffff`
  (the accent is white — Qcentic is deliberately monochrome), `--radius: 2px`.
  `theme-color` meta is `#0a0a0a`. Fonts loaded from Google Fonts:
  **Inter (400/500) for body, Space Grotesk (500/600/700) for display**
  (`--font-display: "Space Grotesk", …`, `--font-body: "Inter", …`).
- **Logo assets (paths on qcentic.com):**
  - `https://qcentic.com/logo/qcentic-lockup-white-4096.png` (white lockup PNG)
  - `https://qcentic.com/logo/qcentic-lockup-pulse-on-dark.svg` (SVG lockup, on-dark)
  - `https://qcentic.com/logo/qcentic-mark-pulse-dark.gif` (animated mark, used in preloader)
  - `https://qcentic.com/logo/qcentic-og-image.png` (1200×630 OG image)
- **Favicons:** `https://qcentic.com/logo/favicon.ico`,
  `/logo/favicon-32x32.png`, `/logo/favicon-16x16.png`,
  `/logo/apple-touch-icon.png`.
- **Footer:** "© 2013–2026 Qcentic GmbH. All rights reserved." with Legal
  Notice and Disclaimer links.
- For a "Built by Qcentic" badge: the on-dark SVG lockup exists; monochrome
  white-on-#0a0a0a treatment matches their own site. All assets are on their
  own origin — copy into our repo (with permission, it's the user's company)
  rather than hotlinking, since the landing page must be served entirely from
  our pull zone.

---

## 7. Existing repo brand assets (for continuity)

From `/home/operator/mission-control-updated/README.md` and `docs/assets/`:

- Logos: `docs/assets/logo-dark.png` / `logo-light.png` (README swaps via
  `<picture>` + `prefers-color-scheme`), `actana-icon.svg`, `icon-256.png`,
  `banner-social.png`.
- Screenshots: `panel-fleet-{dark,light}.png`, `panel-project-{dark,light}.png`
  — the README already leads with `panel-project-*` ("sessions split by status,
  with a live harness terminal alongside"), reusable as the landing hero shot.
- Harness marks in `docs/assets/harness/`: `claude-code.png`, `codex.svg`,
  `cursor-cli.png`, `opencode.svg`, plus planned `soon-hermes.svg`,
  `soon-pi.svg` — README convention: **supported = solid, planned = dashed**
  (comment in README.md); a landing "supported harnesses" row should keep that
  grammar.
- Badge palette already in use on all shields.io badges:
  `labelColor=101723`, `color=279ed6` (flat-square style) — i.e. **#101723
  near-black blue + #279ed6 accent blue** are the de-facto Actana brand
  colors, distinct from Qcentic's monochrome.
