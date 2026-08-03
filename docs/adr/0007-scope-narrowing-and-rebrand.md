# Narrow scope to a harness remote control; rename to Actana Control

The fork is repositioned as **Actana Control** — a harness remote control and nothing more. Peripheral features accumulated in the upstream (voice/Whisper, Tamagotchi-style pet with multiplayer relay, screenshot capture and annotator, semantic code graph indexing, proactive recall, per-project memory notes, bundled skills, scratch pad, custom scripts / launch commands, prompt search palette, file editor / finder / HTML preview, generic annotations) are removed. The retained surface is: session-finish notifications (cross-core), Focused Session Mode, theme onboarding and accent, the usage panel, keybindings and rebind UI (minus deleted-feature bindings), and the User Terminal panel.

The rebrand from *Mission Control* to *Actana Control* accompanies the scope narrowing so that a slimmer product ships under a distinct name and update channel. The rename cascades through: display name (**Actana Control**), package name (**`actana-control`**), org/repo (**`qcentic/actana-control`**), update host (**`control.actana.ai`** — replaces `agentsystem.dev`), and the agent-bridge npm dependency (**`@qcentic/actana-control-agent`** — replaces `@agentsystemlabs/mission-control-agent`). The auto-update feed at the old host is disabled until `control.actana.ai` is stood up.

The `@qcentic/actana-control-agent` package rename is a hard prerequisite: the Panel imports its type shapes (in `electron/sandbox-agent-client.ts`) and installs it via `npm install -g` inside the sandbox. The rebrand spec is partially deferred until this package is published.

The motivations are (1) *result parity* — see ADR 0006 on skills; the same principle extends to voice and memory features that alter agent behavior or leak Panel state into the user's environment; (2) *operator focus* — a cockpit for driving harnesses, not a gamified companion or a partial IDE; (3) *cross-core reliability* — every retained feature must work uniformly across loopback and remote Cores, which is easier to guarantee against a smaller surface; (4) *maintenance cost* — features tied to platform-specific APIs (macOS `screencapture`, mic entitlements, bundled Whisper model, tree-sitter WASM) carry disproportionate build/packaging cost for niche value.

## Considered Options

- **Feature-flag everything, ship all features off by default (rejected).** Preserves dead code and DB schema forever; the codebase stays as complex as it is today; new maintainers still have to understand every removed subsystem. Doesn't achieve the "cleaner and more robust" goal.
- **Keep everything, rebrand only (rejected).** Rebrand without narrowing keeps the surface area problems; the point is the product identity change *because* the scope changed.
- **Narrow and rebrand together, hard forward-only cutover (chosen).** No users to migrate on a fresh fork; the schema, code, and product name change in one direction and don't look back.

## Consequences

- Nine removal specs land as separate PRs (Whisper, Pet + multiplayer, Screenshot, Recall/Memory, Bundled skills, IDE-adjacent, Convenience, plus cross-core notifications add and the rebrand). See `docs/specs/`.
- The rebrand spec (09) is expanded to cover the npm scope (`@agentsystemlabs` → `@qcentic`), package name (`mission-control` → `actana-control`), update host (`agentsystem.dev` → `control.actana.ai`), and agent bridge dep (`@agentsystemlabs/mission-control-agent` → `@qcentic/actana-control-agent`).
- The `MC_*` env-var prefix used between the Panel and the agent bridge is a wire contract; because we now own both sides, renaming it to `AC_*` lands together with the package rename as a single break. Confirmed 2026-07-30. Detailed in spec 09.
- One consolidated forward-only migration drops every table and `app_settings` field belonging to a removed feature. No feature flags. See ADR 0006 for skill-install specifics.
- `package.json` (`name`, `productName`, `build.appId`, `build.publish`), the window title, deep-link scheme, and all user-facing strings switch to Actana Control. `README.md`, `PRODUCT.md`, `SPEC.md`, `CHANGELOG.md`, and `CONTEXT.md` are updated; `docs/upstream/*` is updated to reflect that many upstream-divergence axes now become NON-EXISTENT (Panel-side) because the entire feature area is gone.
- `electron/update-manager.ts` is disabled: no periodic checks, no update dialog. The module remains as a stub with a TODO pointing at the `control.actano.ai` follow-up so re-enabling later is a small change rather than a rebuild.
- macOS entitlements lose the microphone usage description (came with Whisper). Any other capability that was declared for a removed feature is stripped in the same pass.
- The harness registry stays extensible for new harnesses (`opencode`, `pi`, `hermes`) even though the current skill-install table shape goes away — see the domain model.
- Legacy references to *Mission Control* survive only in `docs/upstream/` porting notes (where they are the correct historical name).
- Once these land, further additions must justify themselves against the narrowed scope. "Nice to have inside the Panel" is not sufficient; the concern must belong to the Panel per the scope-boundaries table in the domain model.
