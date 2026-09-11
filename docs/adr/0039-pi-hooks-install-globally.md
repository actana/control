# Pi's status hooks install globally, not in the workspace

> **Status: PROPOSED.** Not accepted. Records the placement decision for the Pi hook family
> added by ADO #4985. Depends on [ADR 0033](0033-turn-end-is-the-one-mandatory-harness-signal.md)
> D1 (turn-end reporting is mandatory) and on the open-family rule in
> [ADR 0013](0013-core-is-the-machine-harness-is-the-cli.md).

> **On the number.** This record takes **0039**, the next free number after
> [`0038-a-core-has-several-addresses.md`](0038-a-core-has-several-addresses.md).

## Context

Every other harness family in `HOOK_FAMILIES` writes its hooks into the
**workspace**: `.claude/settings.local.json`, `.codex/hooks.json`,
`.cursor/hooks.json`, `.opencode/plugins/actana-control.js`. That is the
right place for those vendors — their configs load without a trust gate, and
a workspace-scoped file dies with the project.

Pi's extension API is the same shape of work as OpenCode's plugin (a program
the Core writes; `pi.on(event, handler)` rather than a table of shell
commands), but its **project-local** folder `.pi/extensions/` is itself a
resource that trips Pi's project-trust prompt. Until an operator answers that
prompt:

1. the extension does not load, so no `agent_settled` reaches the Core — the
   turn-end signal ADR 0033 D1 requires is missing; and
2. a blocking dialog sits in front of prompt delivery.

Pi loads **global** extensions (`~/.pi/agent/extensions/`, or
`$PI_CODING_AGENT_DIR/extensions/` when that env var is set) *before* the
trust decision.

## Decisions

**D1 — Pi's Actana extension installs into Pi's global extensions folder, never
into the workspace.** `harness-hooks-pi.ts` writes
`actana-control.ts` under `~/.pi/agent/extensions/` (respecting
`PI_CODING_AGENT_DIR`). The workspace `.pi/` tree is not created and not
touched for hooks.

**D2 — The global extension is inert unless Actana spawned the session.** It
does nothing unless `AC_HOOK_URL` is set in the process environment. A
hand-run `pi` outside Actana therefore posts nothing and shows no errors,
even though the file sits in the operator's global folder. It also does
nothing unless `AC_HOOK_HARNESS` is `pi`: a `pi` an agent starts from inside
another harness's Session inherits that Session's hook URL, token and task
id, and a global file would otherwise report it into — and re-key — a task
that is not a Pi Session. A `pi` nested inside a Pi Session is not told
apart; that residue is accepted.

**D3 — The managed-marker and fail-soft rules are unchanged.** The file is
tagged `@actana-control-managed` so the next spawn replaces exactly what the
last one wrote and never an operator's neighbouring extension; it carries no
secret; every POST swallows its own errors and records a miss.

## Consequences

- Pi is the first family whose hook install path is not under `cwd`. The
  `install(cwd, slug)` signature still accepts `cwd` for registry uniformity;
  Pi ignores it.
- An operator who deletes the marker line takes ownership of the file, and
  the next spawn leaves it alone — same contract as OpenCode's plugin.
- Project trust is answered by the same global extension
  ([ADR 0040](0040-pi-project-trust-answered-by-extension.md)); this record
  only removes the hooks family as a *cause* of that prompt.
