# The product ships one skill, and installs it into the operator's home

> **Status: PROPOSED.** Not accepted. This record amends
> [ADR 0006](0006-no-bundled-skills.md), which forbids in the words of the
> proposal exactly what is written below, and 0006's last consequence — *"any
> future capability that would require Panel-installed skills must first justify
> itself against this ADR"* — is the instruction that produced it. The
> implementation in [#265](https://github.com/actana/control/issues/265) is
> written against this record and is gated on it. **The repository owner
> ratifies or rejects it at the beta gate.** Until then nothing here is settled,
> and a reviewer who thinks the result-bias argument in D2 fails is disagreeing
> with a proposal rather than routing around a decision.

Orchestrating Cores is currently tribal knowledge in a private, machine-local
skill directory on one operator's laptop. Nothing about driving Cores and
Sessions ships with the product, and a Core cannot orchestrate its own Sessions
at all: *"give me three additional sessions, each focusing on three different
things"* has no answer in this repository today. The `actana` CLI can start a
Session, wait for it, read its screen and stop it — every verb the request needs
already exists — and a Harness standing in front of that CLI has no way to learn
that they do, because the only place that knowledge lives is a file on one
machine.

So the capability is a document, not a feature. What it costs is the thing
0006 refused to pay: a file written into the operator's home directory, in a
vendor's configuration namespace, without being asked.

## What 0006 actually decided, and which half of it survives

0006 gave two motivations and they are not equally answerable.

**Collision risk** — *"skills installed by the Panel persist outside the Panel
process and can conflict with the operator's own configuration"* — is answered,
and the answer already exists in this repository. `harness-hooks.ts:50` tags
everything the Core writes into a workspace with `_acManaged: true`, so *"the
next spawn replaces exactly what a previous spawn wrote and nothing else. A
workspace is the operator's, not ours."* That mechanism is four years of
argument short and it works. It does not port unchanged, because a `SKILL.md`
has no JSON envelope to carry a flag: the file is the unit, so the tag has to be
in-band. D1 decides where.

**Result bias** — *"a Session run through the Panel behaves differently from the
same Session run without it, so results are not comparable"* — is not answered
by the same move, and it is the hard one. 0006 explicitly rejected the scoped
variant: an env gate *"only stops the network call, not the behavior injection
at the model layer."* A globally installed, mandatory skill is the strongest
form of the thing 0006 rejected. It sits in the operator's global config, so it
is discoverable by every Session on that machine, including ones that never
touch a Core. **There is no version of "generic only, no project runbook" that
makes this go away**, and this record does not pretend otherwise. D2 is where
the counter-argument is made, in full, on the record, so that it can be
rejected on the record.

## What the precedent carries, stated precisely so it is not overclaimed

"The product never writes harness config" is already false. The Core writes
`.claude/settings.local.json` (`harness-hooks.ts:194`), `.codex/hooks.json`
(`:214`), `.cursor/hooks.json` (`:230`) and `.opencode/plugins/actana-control.js`
(`harness-hooks-opencode.ts:51`) — the last of which is sitting in this
repository's own root right now, written by a Core into this workspace.

**That precedent does not carry this act, and the difference is four separate
properties.** Every one of those writes is:

- **workspace-scoped** — inside a directory the operator handed to a Session,
  not in their home;
- **spawn-time** — written for a Session that is starting, by the process
  starting it;
- **tagged** — `_acManaged` / `@actana-control-managed`, so it is replaceable
  and identifiable;
- **reversible** — delete the workspace, or the marker, and it is gone.

And 0006's own sentence is about *the Panel* and about *skill* directories, both
of which it names. What this record proposes is **global, mandatory, permanent,
and in the operator's home**. Only the third property — tagged — transfers
without argument. The other three are new, and each is decided below rather
than inherited.

## The decisions

**D1 — What the product wrote is marked in-band, by a frontmatter key, and the
key is what authorises a write.** The managed copy carries
`x-actana-managed: true` in its YAML frontmatter, and **nothing else makes a
file ours**. The installer replaces a file at the managed path when, and only
when, that file's first bytes contain that marker; a file at the same path
without it is an operator's and is never written and never deleted.

The alternative on the table was a path segment nobody else would use — install
under a product-named directory and treat the directory as the tag. The skill
*is* installed under a product-named directory (`actana-sessions/`), because it
has to be addressed somehow and a generic name would be the collision. But the
directory is the **address**, not the authorisation, and conflating the two is
how you delete a file an operator wrote at a path you happened to pick. A tag
inside the file survives being renamed, moved and copied; a path does not. The
file is the unit precisely because there is no envelope, so the tag goes in the
file.

**No vendor page cited in D4's table says what its loader does with a
frontmatter key it does not recognise**, and this record does not claim they
ignore it — every other vendor fact in this change carries a URL and a read date
on `HARNESS_CLI_CONFIG` and is asserted by a test, and this one would carry
neither. What makes the marker safe to ship is narrower, and it does not depend
on the answer: the installer reads the marker as a substring of the file's first
bytes rather than through a YAML parser, so *recognising our own writes* is a
property of our own reader and cannot be taken away by a loader getting
stricter. That is the whole of what the substring match buys. What it does not
buy is the vendor's behaviour: a loader that rejects unknown keys costs the
operator a warning at best and a skill that vendor stops loading at worst, and
that is a visible failure to revisit here, not one the marker prevents.

**D2 — The result-bias objection is answered by what the skill is about, and the
answer is narrower than "skills are fine now".** 0006 was written when the
installed skills were *product features*: diagram rendering, git push, memory.
Each of those changed what a Harness would do **about the operator's own work** —
a `ship` skill that commits and pushes in ways the operator did not configure is
0006's own sharpest example, and it is right. A Session with those skills
installed genuinely is not comparable to one without, because the skill changes
the outcome of the task the operator asked for.

The skill this record admits is a different kind of object. It teaches a Harness
how to drive `actana` — the CLI the operator installed on purpose, whose Cores
they registered by hand, whose Sessions cost them money. It adds no capability
that is not already installed and already reachable; it documents one. A Harness
with this skill and a Harness without it produce the same answer to *"refactor
this module"*, because neither one is being told anything about refactoring.
The behaviour that differs is confined to a tool that is not present unless the
operator put it there. **This is shipping the tool's own documentation, not
injecting behaviour into the operator's work.**

**That is exactly the argument the diagram skill made and lost**, and this
record does not get to pretend it is new. The diagram skill also said it only
described a capability the operator had opted into; it lost because *"only
describes"* was not true — it exported `MC_API_*` into every Session, it changed
what the Harness did when asked for a diagram, and its env gate stopped the
network call and not the injection. The distinction claimed here is that the
orchestration skill has no runtime half at all: it exports no environment
variable, it opens no socket, it names no endpoint, it has no gate to be
criticised for not gating, and the CLI it describes fails with an ordinary
"no Core registered" message on a machine that has none. If a reviewer thinks
that distinction is the diagram skill's argument with better manners, this
record fails and should be rejected — and that is the honest form of the
question, put here so it can be answered rather than assumed.

Two consequences are accepted openly rather than mitigated: a Session that never
touches a Core can still read this skill's description, and that is a real cost
paid for the mandatory-ness D3 chooses; and a benchmark run on a machine with
`@actana/cli` installed is, strictly, not identical to one run on a machine
without it. The second is true of every program on the PATH.

**D3 — Installation is mandatory, and there is no prompt and no opt-in flag.**
Installing the Core installs it; installing the CLI alone installs it. This is
the clause that makes D2's objection sharpest and it is chosen deliberately: a
capability that is present only when an operator has found and enabled it is a
capability the product cannot describe in its own documentation, and an
orchestration skill nobody has is indistinguishable from the tribal knowledge
this record exists to end. The escape hatch is D5's, it is one line long, and it
is documented inside the file itself.

**D4 — The installer writes only into a namespace the harness itself already
created, and only for harnesses that are on the machine.** The presence test is
a filesystem one, because the installer has no other: it starts no process
(#129 D9), so it cannot ask a vendor's CLI whether it is there. A harness whose
own home directory does not exist is a harness the operator does not use here,
and the product creates neither the directory nor the skill inside it.
**Creating `~/.claude` on a machine that has never run Claude Code would be a
larger act than anything 0006 refused.**

**This is deliberately not the same question `harness ls` answers, and the two
can disagree.** Availability is a PATH fact — a binary the probe resolved — and
presence here is a directory fact. A harness that has been installed but never
run is `available` and `absent` at the same time, because several of these
vendors create their home directory on first run rather than at install time.
D4 keeps the directory test anyway: the alternative is writing into a namespace
its owner has not created, which is the act this clause exists to refuse. The
consequence of the two signals disagreeing is D7's, and it is written down
there rather than left to be discovered.

The per-harness targets are recorded on `HARNESS_CLI_CONFIG`
(`packages/shared/src/harness-cli-config.ts`) beside `homePathSuffixes`, typed
`as const satisfies Record<Harness, …>` so a new member of `HARNESSES` with no
target is a compile error rather than a silent gap. Each entry carries the
vendor documentation URL it was read from and the date it was read, because
this repository recorded no global skill directory for any harness before this
change and the next reader must not have to go back to the web to check.

The targets are **two directories, not four**, and that is a decision rather
than an accident. The vendors deliberately read each other's namespaces:
`~/.agents/skills/` is a documented global location for Codex, Cursor CLI and
OpenCode alike, and Claude Code reads only its own. Two writes therefore cover
all four harnesses, where naming each vendor's own directory would be four —
and the value 0006 protects is *how much of the operator's home the product
touches*, so the covering set is the smaller act. The consequence is that Cursor
CLI and OpenCode, which read both roots, see the same skill from two places;
that duplication is the vendors' own consequence of aliasing, and both resolve
skills by name.

**D5 — An operator's edit to a managed copy is overwritten, and saying so is
the point of this clause.** The acceptance criterion this record is written for
asks the repair verb to restore a *deleted or edited* copy. Read against 0006
that is a promise to overwrite an operator's edit, and it must be a stated
decision rather than a side effect of idempotence. It is stated: **the installer
replaces the managed file whenever its content differs from the shipped payload,
whatever changed it.** Edits to a file carrying the marker are not preserved,
not merged, and not backed up.

The reason is that the alternative is worse in the direction that matters. A
skill that half the fleet has edited is a skill whose behaviour the product
cannot describe, cannot debug from a bug report, and cannot fix by shipping a
new version — and an orchestration skill that is subtly wrong about how
`session start --wait --json` settles is worse than no skill, because it fails
by driving a Core incorrectly rather than by being absent.

**The escape hatch is deleting the marker line, and it makes the file yours.**
An operator who wants their own version deletes `x-actana-managed: true` from
the frontmatter, and the installer stops touching that file for good, reporting
it as skipped. That is the same contract `harness-hooks-opencode.ts` already
ships to operators in the plugin's own first lines — *"Delete the marker comment
on the first line to make this file yours and stop that"* — and reusing an
idiom this product has already taught is worth more than inventing a second one.

**D6 — The install runs on an explicit, idempotent code path, and never on an
npm lifecycle hook.** `packages/cli/package.json` has no `postinstall`,
`preinstall` or `prepare`, and gains none: install hooks break `npm ci` in
sandboxes and under pnpm's strict mode, and a failed one fails the install of
the CLI itself. That leaves "runs automatically when the CLI is installed"
with nothing to fire it, so it is **redefined as first-run rather than
install-time**: any `actana <noun>` invocation runs the ensure before dispatch,
where it is a no-op when the copies are current, is wrapped so that no failure
of it can change the verb's exit code, and writes nothing on a machine where no
harness namespace exists. The operator's observable outcome is the same one
command later. The Core runs the same ensure at boot, and again when a harness
it did not previously see becomes available.

**D7 — The Core's re-install is driven by a subscriber that diffs the full map
against its own last-seen one.** `agents:availabilityChanged` carries the whole
availability map and not a transition (`harness-availability-store.ts:13-16`),
so "a harness that was previously missing became available" is not on the wire
and the subscriber has to compute it. It holds its own last-seen map, and it
ignores any event whose id is not greater than the highest it has already
processed, so a replay of the log — which is how the event log is read by
cursor — cannot be mistaken for a fresh transition. The probe, the tick and the
payload shape are untouched.

The promptness this buys is bounded by the probe, not by this subscriber:
`DEFAULT_AVAILABILITY_TICK_MS` is 60 s and there is no filesystem watch
(`harness-availability-store.ts:18-21`), so a harness installed by hand in
another terminal is served **by the first probe that observes it**, which
`SIGHUP` (`core-entry.ts:296`) and the ADR 0021 install path both force sooner.
No clause here promises seconds.

**The trigger and the test are different signals, and that gap is accepted
here rather than closed.** This subscriber fires on availability, which D4 says
plainly is a PATH fact; the installer then decides from `homeMarkers`, which is
a directory fact. For a harness that creates its home directory on first run,
the two are not simultaneous: the probe flips it to `available`, the watcher
calls the ensure, the installer reports `absent` for that target and writes
nothing — and since the availability map does not change again, this subscriber
is not called again either. The criterion "served by the first probe that
observes the harness" is met to the letter and missed in purpose, for exactly
one window: from the moment the binary lands to the moment its home directory
exists.

It is accepted rather than closed because the two candidate fixes both cost
more than the window does. Creating the directory ourselves is the act D4
refuses. Re-checking on every 60 s probe tick means a `readdir` fan-out over
four home markers, forever, on every Core, to catch a state that resolves the
first time the operator runs the harness — and it would have to be driven by
its own timer, because the store appends an event only when the map *changes*
(`harness-availability-store.ts`), so there is no later tick on this
subscriber's own wire to hang it from. Neither is worth it for a gap that
closes on its own.

**The recovery paths, named, because an accepted gap with no recovery is a
bug.** On the machine the CLI is installed on there is nothing to do: the
pre-dispatch ensure in `actana-cli.ts` runs before every `actana <noun>`, so
the next command after the harness's first run repairs it, and `actana harness
skills` is the explicit form. On a Core's machine there is no pre-dispatch
ensure, so the automatic repair is **the next Core boot** — `core-entry.ts:302`
runs the same ensure unconditionally — which an upgrade, a reboot or a
deliberate `actana core exec -- actana restart` all reach. What the operator
sees in the meantime is a harness that runs Sessions normally and does not know
the orchestration skill, which is the state every machine was in before this
record.

**D8 — "Authored once" is a mechanism, not a convention.** The skill has to be
written to disk by two different programs, on two different machines: the CLI
writes to the machine the CLI is on, and the Core writes to the Core's machine,
which for a remote Core is somewhere else entirely. The two cannot share a
module — `@actana/cli` may not import `@actana/shared` (ADR 0025 D4, and the
`no-local-escape` sweep enforces it), and `@actana/core` may import only two
named modules from `@actana/sdk` (ADR 0025 D2 as amended by #224). Neither list
moves for this.

So the `SKILL.md` is authored once at `.agents/skills/actana-sessions/SKILL.md`,
following the `release` skill's harness-neutral precedent, and a generator
embeds it as a string constant in both packages. **Embedded rather than copied
into `dist/`**: the Core ships as an esbuild bundle, and an asset read from disk
at runtime is a file that is not in the bundle — the same reason the OpenCode
plugin is a template literal (`harness-hooks-opencode.ts:12-14`). The installer
module itself, and the CLI's copy of the target table, are duplicated
deliberately, and **one test in one package fails when any copy drifts from its
source**, naming the file: `packages/shared/src/__tests__/orchestration-skill-fanout.test.ts`
asserts the installer copies are byte-identical, the two target tables agree
row for row, and both embedded payloads are the authored `SKILL.md`. It lives in
`packages/shared` and reaches into `packages/cli` by relative path, because the
dependency rule runs one way: shared may read the CLI's source as text, the CLI
may not import shared at all. So there is exactly one such test rather than one
per package, and every comment that points at it says so. That is the
arrangement ADR 0025 D3 permits and `registration-blob-file.ts:11-18` already
lives under: the copies are checked by CI rather than by memory.

**D9 — The skill is generic, and carries nothing about this repository or any
other.** No ticket workflow, no release train, no review flow, no project ids,
no Core names, no default harness and no preference order — the skill surfaces
what the Core reports as available and the caller decides. It is also
**self-contained**: a copy installed at a global path has no repository around
it, so unlike the `release` skill it may carry no repo-relative link and may
assume no checkout. When and how many Sessions to provision is the operator's
decision at the time, not a rule in the skill. There is no extension point for
project runbooks yet; revisit when a second project actually needs one.

## Considered Options

- **Leave 0006 standing and ship nothing (rejected, and it is the honest
  baseline).** Costs nothing, breaks nothing, and leaves the product unable to
  describe how to drive itself. Chosen against because the capability being
  withheld is documentation of verbs the operator already paid for, and because
  0006's own last line invites exactly this record rather than forbidding it.
- **Ship the skill in the repository only, and let operators copy it (rejected).**
  This is what 0006 tells operators to do for diagram and ship, and for those it
  is right: they are optional workflows. It fails here because the whole point is
  that a Harness on an operator's machine, with no checkout of this repository,
  can be asked to provision Sessions. A skill you must first clone a repository
  to obtain is the tribal knowledge again, with an extra step.
- **Install it, but ask first (rejected, D3).** A prompt makes the feature
  undescribable — half the fleet has it — and the prompt itself has nowhere
  honest to appear: the CLI's ensure runs before a verb, and a CLI that opens an
  interactive question before `actana core ls` is a CLI that cannot be scripted.
- **Gate it on an environment variable, so only Core-driven Sessions see it
  (rejected, and 0006 already rejected it).** The file still lives in the
  operator's harness directory permanently and is still discoverable by every
  Session; the gate stops nothing at the model layer. Repeating an experiment
  0006 ran and reported on would be the clearest sign this record had not read
  it.
- **Add a skills payload to `@actana/sdk` so both packages import one module
  (rejected, D8).** #224 amended ADR 0025 D2's import list once and the
  amendment mechanism exists for this. Rejected because that list's value is
  that it is short and its rule is *"what the Core depends on is the protocol,
  not the client"* — and a skill payload is neither protocol nor client. A
  build-time mechanism costs a generator and a drift test; a third entry on that
  list costs the list's meaning.
- **Write each vendor's own global directory, four of them (rejected, D4).**
  Tidier to explain, and it touches twice as much of the operator's home for no
  additional coverage.

## Consequences

- **ADR 0006 is amended, not superseded.** Its rule stands for product-feature
  skills — diagram, ship, memory, and anything that changes what a Harness does
  about the operator's own work — and this record carves out exactly one class:
  a skill whose entire subject is driving the product's own CLI. A second skill
  is not authorised by this record; it argues against D2 on its own.
- **Ratifying this record includes writing the amendment note into 0006 itself,
  and that is part of the ratification rather than a follow-up.** This
  repository puts the note in the amended record — `docs/adr/0025-…:17` carries
  *"Amended 2026-08-18 by #224"* — so whoever moves this record to ACCEPTED adds
  one line in that form to `docs/adr/0006-no-bundled-skills.md`, pointing here.
  0006 is deliberately untouched while this record is PROPOSED: until it is
  ratified 0006 stands unqualified, and a forward pointer to a proposal would
  say otherwise. The note is named here so it is somebody's job at ratification
  rather than nobody's afterwards.
- **`docs/specs/05-remove-bundled-skills.md:210` has been honoured.** *"Any
  future feature that would require Panel-installed skills has to relitigate ADR
  0006 first"* — this is that relitigation, and its verdict is the beta gate's.
- **`docs/upstream/DIVERGENCE.md` line 92 is now wrong.** *"Extension mechanism
  (skills/MCP) — moves from IDENTICAL to NON-EXISTENT"* stops being true for
  skills on the day this is accepted.
- **The product now has a home-directory footprint**, and it is exactly two
  directories deep in two roots: `~/.claude/skills/actana-sessions/` and
  `~/.agents/skills/actana-sessions/`, each written only where the harness's own
  namespace already exists. Anything larger than that is a new decision.
- **[#29](https://github.com/actana/control/issues/29)** — *"Session
  orchestrator: decide whether to build it"* — is answered in the negative for
  an orchestrator and in the affirmative for the capability: **not a service, a
  skill that lets a Harness be one.** #29 is closed by whoever ratifies this
  record, in that direction, and not before.
- **A vendor that moves its global skill directory breaks this quietly.** The
  targets are read from vendor documentation, dated in the table, and there is
  no probe that would notice a move — the failure mode is a skill that installs
  successfully into a directory nobody reads any more. The mitigation is that
  the date is in the table where the next reader will see it, not that the
  problem is solved.
