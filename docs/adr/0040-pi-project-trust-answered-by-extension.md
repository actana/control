# Pi's project-trust prompt is answered by the global extension

> **Status: ACCEPTED.** Records the trust policy for ADO #4987. Depends on
> [ADR 0039](0039-pi-hooks-install-globally.md) (the Actana extension is
> already loaded before Pi decides trust) and on
> [ADR 0026](0026-prompt-delivery-is-a-core-responsibility.md) (prompt delivery
> must not type into a blocking dialog).

> **On the number.** This record takes **0040**, the next free number after
> [`0039-pi-hooks-install-globally.md`](0039-pi-hooks-install-globally.md).

## Context

In a workspace with `.agents/skills` (this repository has one) or any other
trust-requiring project resource, Pi 0.85.x opens on an interactive
"Trust project folder?" prompt before its editor will accept typing. Prompt
delivery that does not know about that screen types the operator's first
prompt into it.

Pi decides trust in this order (`dist/core/project-trust.js`):

1. `--approve` / `--no-approve`
2. a `project_trust` event answered by an already-loaded **global** extension
3. the saved decision in `trust.json`
4. the `defaultProjectTrust` setting (`always` / `never` / `ask`)
5. only then, the interactive prompt

ADR 0039 already puts Actana's extension in the global folder, so step 2 is
available on every Actana spawn. Workspace-local `.pi/extensions/` is out of
scope for this decision: those load only *after* trust and would themselves
trigger the prompt.

## Decisions

**D1 — Actana-spawned Pi Sessions answer `project_trust` with
`{ trusted: "yes" }` from the global extension.** No dialog, no new spawn
flag. The handler lives in the same `@actana-control-managed` file ADR 0039
installs. It is inert unless `AC_HOOK_URL` is set, so a hand-run `pi` still
gets the interactive prompt.

**D2 — The answer is session-only (`remember` is omitted).** Answering yes
lets the Session proceed; writing `trust.json` behind the operator's back is
the larger act ADR 0026 already rejected for "pre-mark the folder trusted in
the vendor's config". A later Actana spawn answers the event again; an
operator who wants a standing decision uses Pi's own `/trust`.

**D3 — `--approve` / `--no-approve` are not added to the spawn path or the
allow-list for this.** Spawning with a trust flag would work, but it spreads
per-harness knowledge into `pty-spawn-policy` when the extension already sits
at the earlier step of Pi's own decision order. The flags remain available to
an operator who types them by hand if a future need appears; this record does
not introduce them.

**D4 — Defence in depth stays in prompt delivery.** `pi` is listed on the
existing `folder-trust` row of `BLOCKING_DIALOGS`, and `HARNESS_READINESS`
gains a Pi composer marker (the footer context line `N%/M`, observed on
0.85.1 and absent from the trust dialog). If the dialog still appears — the
managed extension was deleted or its marker taken — delivery recognises the
screen, cannot read Pi's arrow-keyed menu as a numbered option, abandons, and
the Session reports `needs-input` rather than typing into the dialog or
hanging.

## Consequences

- The preferred path needs no fixture of the trust screen to *answer* it; the
  fixture exists to prove the defence-in-depth path abandons rather than types.
- Hand-run `pi` in a trust-requiring repo is unchanged: no `AC_HOOK_URL`, no
  handler, interactive prompt as before.
- Choosing `trusted: "yes"` rather than `"no"` matches the precedent of
  answering Claude Code's folder-trust affirmatively, and is what lets a Pi
  Session in a repo that has `.agents/skills` actually use those skills.
