# Remembered session settings are Core facts, and auto-mode is unconditional

The New session dialog carried two checkboxes that did nothing. Both were inert for every Core-owned project, which — since ADR 0004 moved the write path onto the Core — is every project. This ADR records the two decisions that fix them, because they pull in opposite directions: one control becomes real by crossing the wire, the other is deleted.

**"Remember settings for this project" becomes a Core fact.** The Panel's persist handler returned early for a Core-owned row because `projectsMutate` covered only create / rename / archive / pin, and the project snapshot mapper hardcoded the fields back to empty on the next refetch — so even the optimistic patch died. The frame now carries them: a dedicated `settings` op, plus the same fields on `create` so the Create Project dialog's "Start with →" pick and grid-view default stop being dropped. `CoreLinkProjectSnapshot` returns them. `CORE_LINK_PROTOCOL_VERSION` → 0.10.0.

A `settings` op rather than a generic field patch, following the precedent `pin` set: the op earns its own `project:settingsChanged` event kind, so a reconnecting Panel replays a settings change distinctly from a rename instead of refetching on an undifferentiated "project changed".

The consequence worth stating out loud rather than discovering: these rows live on the Core, so **remembered settings are shared by every Panel connected to it** — the same semantics pinning already has, and intended. Every column the frame needs already exists in the shared schema bootstrap; the Core simply never wrote them. No migration.

**"Skip permission prompts" is deleted, and auto-mode becomes the default for every Harness that has such a flag.** The checkbox was agent-specific and misleading, and auto-mode intent is where the product is going. There is now no Panel UI for starting a non-auto session; an operator who wants one overrides per session in the terminal, where a CLI is always available. A Harness with no such flag (OpenCode) launches exactly as before — passing it one would be an argument the spawn policy rejects anyway.

**The spawn policy's argument rules do not change.** The rule tying the skip-permissions argument to the request's declared intent is not a permission check but a consistency check between the argv the Panel built and what the request said it wanted, and it is a defense against argument injection. Removing it would buy nothing, since a request that declares the intent passes it. What changed is what feeds it: both the command builder and the spawn descriptor now derive from `harnessLaunchesWithSkipPermissions`, and neither reads the task row.

## Considered Options

- **Plumb the skip-permissions flag through the task frame instead of removing the control (rejected).** The symmetric fix, and what the bug report proposed. Rejected as a product call: the checkbox names a per-vendor flag in a dialog that is otherwise vendor-neutral, and honouring it would have grown the task mutation frame for a control being retired anyway.
- **A generic `updateProject` field patch instead of a `settings` op (rejected).** Fewer ops, but every project edit then replays as one indistinguishable kind, and the frame stops documenting what a Panel is allowed to change. `pin` already chose the other way.
- **Keep the settings Panel-local (rejected).** It would avoid a protocol bump and keep each Panel's remembered agent private. Rejected because the columns are already on the Core's projects table — the decision was made when the shared schema was written — and ADR 0005 leaves no room for a project row that lives in two places.
- **Remove the spawn-policy gate rather than default the request field on (rejected).** Offered as an alternative when the removal was decided. It deletes an argument-injection defense to save setting one boolean.

## Consequences

- **Every Core must be updated alongside the Panel.** The minor moved, so a Core still speaking 0.9.0 is incompatible under the major.minor rule and renders as "needs update" (ADR 0005). There is no partial-compatibility path, and none is wanted.
- **Both sides of the skip-permissions pair must move together, always.** The command builder puts the argument in the command string; the spawn descriptor declares the intent the policy checks it against. Switching one alone does not degrade — the policy rejects, and *every session on every Core fails to start*. `harnessLaunchesWithSkipPermissions` is the single decision point both read, and `session-skip-permissions.test.ts` pins the pair against the real policy, including a source-level guard that fails if any spawn site goes back to reading the task column.
- **`savedSkipPermissions` is carried but inert.** It travels on the frame and the snapshot for symmetry with the column that already exists, and nothing on the launch path reads it. Wiring it back in would partially reintroduce the control this ADR removes.
- **Session resume is untouched.** The missing `claudeSessionId` on the task frame is a distinct, larger behaviour fix; no task-mutation frame or task-snapshot change rides along here.
- **The sudo / root question is now sharper, and belongs to the Core image work.** Nothing on a supported path runs a Harness as root today — the Core installs as a systemd *user* unit and the dev image runs unprivileged. But if a Core is ever built or deployed running as root, a Harness CLI that refuses its skip-permissions flag under root would break **every** session rather than only opted-in ones. That is a constraint on #37 / #39, recorded here so it is not rediscovered.
- The `CONTEXT.md` glossary gains **Remembered Session Settings**, alongside **Pinned Task / Pinned Project**, which it deliberately models itself on.
