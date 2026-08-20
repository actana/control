# There is one `actana`, and it is both the Core manager and the client

Two different programs installed a binary called `actana`.

The Core tarball shipped the operator CLI — `setup`, `status`, `token`,
`update`, `start`, `stop`, `restart`, `logs`, `harnesses`, `uninstall`, and the
`daemon` verb the unit execs. `npm i -g @actana/cli` shipped the client CLI —
`core`, `project`, `harness`, `events`, `session`. Both were named `actana`.
Both were on `PATH` on any machine that had a Core, which is every machine
[ADR 0031](0031-the-product-ships-one-skill.md) installs the `actana-sessions`
skill onto.

The skill teaches `actana core ls`, `actana session start … --wait --json`,
`actana events tail --json`. **Every one of those was `unknown command` to the
binary the Core itself put on that machine's `PATH`.** Installing the npm
package to fix it created a second `actana` whose precedence was a `PATH`
accident: `deploy/core.Dockerfile` sets `NPM_CONFIG_PREFIX=/home/core/.local`
and puts `/home/core/.local/bin` ahead of `/opt/actana/bin`, so the npm shim
would have shadowed the operator binary for every subsequent command in the
container — including `CMD ["actana", "daemon"]`, which would have reached the
client CLI's "wrong package" refusal instead of starting a Core. Reverse the
ordering and the failure inverts. **Which confusing failure an operator got was
decided by an npm prefix and a `PATH` order, not by anything they could see.**

[#265 §6](https://github.com/actana/control/issues/265) recorded the two-binaries
fact as a constraint and designed around it: the skill payload is authored once
and embedded into both packages by a generator, held honest by a drift test,
because *"the CLI and the Core cannot share a module"*. ADR 0031 D8 records the
same reasoning. **This record rejects the premise.** The duplicated installer,
the duplicated target table, the drift test and the `daemon` refusal message all
existed because one product shipped two programs under one name.

## The decisions

### D1 — One binary, one program

There is one `actana`. The operator verbs and the client nouns live in the same
CLI, dispatched from one `runActanaCli` over one dependency bag, with one help
text and one version answer. The machine-side modules moved out of
`packages/core/src` and into `packages/cli/src`; `packages/core` is the daemon
and nothing else, and emits no `actana-cli.cjs`.

**Context-sensitivity stays.** On a container Core the lifecycle verbs still
refuse and still name their Docker equivalent, driven by `ACTANA_CONTAINER` and
never by sniffing `/.dockerenv` (ADR 0016 D13/D15/D16). What changed is that the
*client nouns are checked before that refusal table*: reaching a Core over the
core link is the one thing that works identically on metal, in a container and
on a laptop with no Core at all, and refusing `actana session ls` inside the
image would be exactly the dishonesty this record exists to end.

### D2 — The rejected alternative: a permitted-module list

The alternative was to leave the machine-side modules in `packages/core` and let
the published CLI import them, rewriting `no-local-escape.test.ts`'s import ban
as a permitted-module list the way
[ADR 0025 D2](0025-the-protocol-ships-with-the-client.md) does for
`@actana/sdk/core-link-frames` and `@actana/sdk/core-files-error-codes`.

**Rejected because it turns a bright line into a judgement call at every future
review.** D2's list works because it is two files that import nothing at all. A
list that admits ten modules which between them reach `child_process`, the
filesystem, systemd and the network is not a list a reviewer can check — it is a
permission to argue. The move keeps the ban readable as "none", and a partial
move shows up as a `@actana/core` import in CI rather than in a stranger's
`npm install`.

### D3 — A module both halves use belongs to `packages/shared`

`core-material-store.ts` and `core-cert-material.ts` moved to
`packages/shared/src`, because the daemon mints material on first run and the
operator verbs mint it at `setup`. Putting them in `packages/cli` would have
left the daemon importing the client package, which is the arrow this record
exists to keep straight.

**The same rule was applied beyond the modules the issue named it for, because
the daemon reaches further than the issue's closure did.** `core-entry.ts` and
`harness-install-service.ts` between them read the container contract, the
update-check paths, the release fetcher, the tarball manifest, the Harness
availability probe and the Harness installer. Every one of those went to
`packages/shared`, split where only half of a module was shared:

| shared | why |
| --- | --- |
| `log.ts`, `login-shell.ts` | leaves both sides read |
| `actana-manifest.ts` | the daemon reads its own manifest; the CLI reads the install's |
| `actana-harnesses.ts`, `operator-login-path.ts` | the daemon runs the same installer when a Panel asks (ADR 0021) |
| `harness-availability-store.ts` + its probe chain | `setup` and `status` need the Core's own PATH probe, not a second one |
| `actana-system-port.ts` | the *type* only — see below |
| `actana-container-contract.ts`, `actana-state-paths.ts`, `actana-release-fetch.ts` | the halves of three modules the daemon reads |

**`nodeActanaSystem()` stayed in `packages/cli/src/actana-system.ts`.** Only the
port's type is shared. The daemon passes its own non-interactive port
(`packages/core/src/core-harness-system.ts`) instead, and that is not a
concession: a Core running under systemd has no terminal, so `confirm` has
nobody to ask, and answering it "yes" by default would let a frame from a Panel
take an answer the operator never gave.

`packages/cli/src/actana-manifest.ts` and `packages/cli/src/actana-harnesses.ts`
remain as the modules the CLI imports and re-export the shared definitions — the
arrangement `actana-release.ts` already used for the release channel.

### D4 — `daemon` reaches the runtime by path, not by import

The `daemon` verb resolves `<install root>/app/core-entry.cjs` — `ACTANA_ROOT`
when the tarball's launcher execed us, else the layout's `current` symlink — and
loads it with `createRequire`. **A path, not an import**, so the daemon's native
dependencies never enter the published dependency graph. That is precisely what
lets `no-local-escape.test.ts`'s daemon ban stand unchanged while one binary
does both jobs.

**In-process rather than spawned, and this must not change.** systemd's
`Type=simple` and launchd both expect the daemon to BE the process they started,
and an extra fork in between would leave the init system supervising a wrapper
that has already exited.

### D5 — `@actana/shared` is inlined into the published bundle, and stays private

esbuild inlines `packages/shared`'s source into `dist/actana-cli.mjs`. The
package itself stays unpublished.

**This is the argument, written where the next reader will look for it.**
[ADR 0025 D4](0025-the-protocol-ships-with-the-client.md) exists so that nobody
can take a dependency on `shared`'s surface; its own words are *"it is not
deleted and it is not published"*. **An inlined bundle offers no surface to
depend on** — no manifest on the registry, no version to range against, no
specifier a third party can resolve. Both halves of D4's sentence stay true, and
an inline is not the arrangement 0025's rejected-alternatives section warns
about, which was a *published* package nobody was meant to use.

**What would make it unsafe again**, which a green test is otherwise silent
about:

1. `@actana/shared` becoming publishable — `"private": true` coming off its
   manifest. The inline then becomes a second copy of something people can also
   install, and the two can skew.
2. `@actana/shared` becoming *external* rather than inlined — a name in
   `build.mjs`'s `external` array or in `packages/cli`'s `dependencies`. The
   published artifact would then resolve a specifier at runtime, and a
   stranger's `npm i -g @actana/cli` would fail on a package that does not
   exist.

`no-local-escape.test.ts`'s "carries no private package" test is **rewritten to
assert exactly those two**, not deleted. It also asserts that something still
imports `@actana/shared`, so the three checks cannot pass by saying nothing.

### D6 — The npm package keeps the name `@actana/cli`

A rename costs every existing install and buys a manifest field we can rewrite.
The `bin` map is unchanged. The `description` — which said *"the `actana`
command's client half"* — is rewritten, because it became false the day this
landed.

### D7 — The image takes the CLI from the tarball, and runs no `npm install`

`deploy/core.Dockerfile` continues to extract the tarball into `/opt/actana`.
What changed is that `app/actana-cli.cjs` is now the unified bundle, staged from
`packages/cli/dist` rather than `packages/core/dist`. There is no `npm install`
at image build time: that would tie image builds to a published version, and an
image whose contents depend on what is on the registry at build time is not
reproducible from this repository.

Once the two are the same program the `NPM_CONFIG_PREFIX` and `PATH` ordering
**stops being able to decide anything**, because installing the published
package puts the same program there. That is what "there is nothing to shadow"
means: not that the collision is prevented, but that its outcome no longer
differs.

### D8 — The CLI can install a Core

`actana install` resolves the release, downloads it, verifies it against the
release's published `SHA256SUMS`, extracts it, and then does what `setup` does.
`actana setup` takes the same path when it is not standing in an extracted
tarball. The fetch half writes only into a temporary directory, so **a failed
install leaves nothing installed** — the same no-op-on-failure property
`actana update` already had, because both go through the same module.

**`install.sh` survives unchanged as the no-Node door.** A bare machine has no
Node and the tarball carries its own pinned one, so the shell script cannot be
replaced by the CLI it installs. Two doors, one implementation of the real work,
which is the argument `install.sh`'s own header already makes for why it stays
thin.

### D9 — A locally installed Core is wired to that machine's CLI

Installing a Core registers it in the same machine's blob registry and makes it
that CLI's default target. No token hand-carried from one half of this command
into the other, on one box. The two sides already met on disk: the registry
lives in the very directory `setup` writes `material.json` into.

A selection the operator already made is kept — the local Core is registered and
named, and `core use` is one command away — following the same "no clobber, no
silent win" rule as D10. A CLI with no local Core behaves exactly as before.

The `actana-sessions` skill gains the corresponding rule, and a test holds the
skill's verb surface against the dispatch. **That is what finally makes the
skill honest on the machine the Core itself installs it on**, which is the whole
complaint this record opens with.

### D10 — One owner for the launcher path

`$HOME/.local/bin/actana` is both the layout's `binLink` and, in the container,
`NPM_CONFIG_PREFIX`'s bin. **Whoever installed the CLI owns it.** If `setup`
finds an `actana` there that is not its own symlink — or one earlier on `PATH` —
it does not write one and says so plainly. Ownership is decided by where a link
points, not by what it is called.

**Version skew is tolerated and reported, never pinned.** The local verbs read
the install's own manifest, and `actana status` and `actana --version` print
both versions and say when they differ. Pinning would let a global `npm update`
break a running Core on a machine where the operator did nothing but update a
client.

## Consequences

- **#265 §6 and ADR 0031 D8's premise is superseded.** *"'Authored once' needs a
  mechanism — the CLI and the Core cannot share a module"* is no longer true:
  `packages/cli` may import `@actana/shared`, under D5. The embedded-payload
  generator and `orchestration-skill-fanout.test.ts` are **kept** rather than
  removed, because the payload is still embedded in two packages — the daemon
  writes the skill at boot from `@actana/shared`, and the CLI writes it in front
  of the first noun — and one authored source with a drift test is still the
  cheapest way to keep those two honest. What changed is that the mechanism is
  now a convenience rather than a workaround, and removing it is a separate
  decision with its own argument to make.
- **Two bans in `no-local-escape.test.ts` are narrowed rather than dropped.** The
  shell-out ban (#129 D9) now sweeps the *client* modules: its own argument — *a
  CLI that shells into a container to fetch its own credentials is not a CLI* —
  is about a client, and driving `systemctl` and `launchctl` is the machine
  half's job rather than that temptation. The exemption is a table with a reason
  per row in `packages/cli/src/__tests__/module-halves.ts`, `actana-cli.ts` and
  `actana-cli-entry.ts` are deliberately not on it, and a further test asserts
  that exactly one machine module imports `node:child_process`. ADR 0026's
  no-scheduling ban is narrowed by the same table, for the same reason: polling
  a TCP port after `systemctl start` is not a timing decision about somebody's
  Session.
- **`selfsigned` joins `@actana/cli`'s dependencies.** A CLI that can run
  `setup` mints certificate material. It is external rather than inlined because
  the Core's own bundle has always treated it that way and the tarball already
  ships one copy. It is none of the three things that list exists to keep out —
  no server, no database driver, no native addon — and `better-sqlite3` and
  `node-pty` still must never appear.
- **`packages/cli` emits two bundles**: the published ESM one and the tarball's
  CJS `actana-cli.cjs`. `scripts/build-core-tarball.mjs` fails the tarball build
  unless both it and `core-entry.cjs` are staged, which is the enforcing line.
  `undici` joins the tarball's runtime closure, because the client nouns now run
  inside the image.
- **`packages/shared/package.json`'s wildcard `exports` is untouched**, so
  modules added there by parallel work do not collide in a manifest.
- #284, #285 and #289 each add behaviour to a client verb whose binary identity
  this record changes, and each notes a dependency on it.
