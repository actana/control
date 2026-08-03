# The Panel does not install skills into the user's harness

Actana Control ships no bundled agent skills and installs nothing into the operator's `.claude/skills/`, `.codex/skills/`, `.cursor/skills/`, or any equivalent harness skill directory. The previous "diagram" and "ship" skills, the recall MCP, and the recall skill are removed. The Panel does not write to any harness config path outside its own registry storage. Skills, MCPs, hooks, and CLAUDE.md-style config are the operator's territory; the Panel is a remote control that observes and drives Sessions but does not modify the harness's own behavior.

The immediate motivations are (1) *result bias* — a Session run through the Panel behaves differently from the same Session run without it, so results are not comparable, and (2) *collision risk* — skills installed by the Panel persist outside the Panel process and can conflict with the operator's own configuration. Git-touching skills (previously "ship") are the sharpest case: a Panel-installed skill can commit or push in ways the operator did not configure.

## Considered Options

- **Install skills but scope to Panel-only sessions (rejected).** Attempted with `MC_API_URL` / `MC_API_TOKEN` env gates on the "diagram" skill. The skill files still live in the user's harness dir permanently and are discoverable by non-Panel sessions; the env gate only stops the network call, not the behavior injection at the model layer.
- **Install skills into a Panel-owned dir added to the harness's skill search path (rejected).** Requires harness support that not every harness offers; equivalent to owning part of the operator's config surface either way.
- **Ship no skills (chosen).** Panel emits no `SKILL.md` files, exposes no `MC_API_*` env vars to Sessions, and offers no in-app skill installer. Any diagram, ship, memory, or similar workflow the operator wants is theirs to install directly into their harness.

## Consequences

- Remove `dist/bundled-skills/` and `bundled-mcp/` entirely.
- Remove `electron/ensure-diagram-skill.ts`, `electron/ensure-recall-skill.ts`, `electron/ensure-recall-mcp.ts`, and their tests.
- Remove `src/shared/diagram-skill-install.ts`, `src/shared/skill-install-shared.ts`, `src/components/views/InstallDiagramSkill*.tsx`, `InstallShipSkill*.tsx`, `ShipFailedDialog.tsx`, `CommitPushButton.tsx`, `DiagramDialog.tsx`.
- Remove the `POST /api/diagram` endpoint, its controller/repository, the `mermaid` dependency, and the `task_diagrams*` tables (migrations 0011/0012 dropped in the consolidated removal migration).
- Stop injecting `MC_API_URL`, `MC_API_TOKEN`, `MC_TASK_ID`, and `MC_THEME` into agent Sessions. Update env injection sites in the Harness.
- The harness registry retains a *label* per harness (used in the UI) but no longer carries a `skillsInstallSegments` capability; the whole `DIAGRAM_SKILL_INSTALL_TARGETS` shape is gone.
- Cross-core diagram delivery (previously an open question) becomes a non-question: there is no diagram delivery.
- Operators who want the previous "diagram in a viewer modal" workflow install the skill themselves into their harness dir. Actana Control does not render inline diagrams.
- Any future capability that would require Panel-installed skills must first justify itself against this ADR.
