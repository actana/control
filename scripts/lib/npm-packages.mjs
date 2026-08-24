// What this repository publishes to npm, and what a publishable tarball is
// allowed to contain (#129 D12, D13; ADR 0018 as amended by #159).
//
// Until now every registry this repository published to was a container
// registry, and the whole publishing surface was two image names. npm is a
// second kind of registry with a property Docker Hub does not have: **a version
// number is burned the moment it is published.** Unpublishing inside the
// 72-hour window frees the bytes and not the number — `@actana/sdk@0.2.2` can
// never mean anything else, on any future train. There is no `--force`, no
// retag, and no "we'll fix it in the next patch" that gets that number back.
//
// So the checks live here, in a module, run *before* the publish and again in
// `pnpm test` on every pull request — not as a step in a workflow that only
// executes on the one occasion it is too late to be wrong.
//
// ── The two rules that are easy to state and easy to lose ────────────────────
//
// **D12.** A published package declares `engines: ">=22"`, ships compiled
// JavaScript plus `.d.ts`, and carries no `preinstall` guard. The monorepo,
// Core and Panel keep `>=24 <25` and `scripts/require-node-24.mjs` — that guard
// is right for them and catastrophic in a tarball: it is a hard `process.exit(1)`
// on any runtime that is not exactly Node 24, so a consumer on Node 22 (the
// floor D12 chose, and the one #151's spike proved the transport works on)
// would have `npm install @actana/sdk` fail on a repository policy that is
// none of their business. `assertPackedTarball` therefore asserts the guard
// *cannot reach* a tarball rather than merely that nothing currently copies it
// in: the packed file list is a whitelist, so any future `files` entry, any
// `scripts/` helper, and any lifecycle script that would drag one in fails
// here.
//
// **D13.** One version line, published by `release.yml` on the same tag that
// builds the images. Nothing in this module decides the version; it asserts
// that every publishable manifest already carries the one being released, which
// is the property "in lockstep" reduces to at the moment of publishing.
//
// ── The beta path: an asset, not a publish (#320, ADR 0036 D15/D16) ──────────
//
// Everything above is about a *release*, and a release is the only thing this
// module ever sent to a registry. A beta is not sent anywhere. Under ADR 0036
// C1 a beta version string is `x.y.z-beta` exactly — no counter, ever — and a
// beta is designed to be cut repeatedly as the train moves, so the same version
// would have to be published more than once. The paragraph at the top of this
// file is the reason that cannot work: the second cut gets a 403 from the
// registry after the tag has already moved and every asset has already been
// replaced. **So a beta publishes nothing to registry.npmjs.org, under any
// dist-tag** (D15), and the CLI ships instead as a packed tarball attached to
// the beta prerelease, installed from its asset URL (D16).
//
// That is a decision of the repository owner's, recorded in ADR 0036 and in
// #315. It is not weighed here and it is not reopened here.
//
// What it costs this module is one narrowing, and `beta: true` on
// `assertPackedManifest` is the whole of it. `@actana/cli` declares
// `"@actana/sdk": "workspace:*"`, pnpm resolves that to a real version as it
// packs, and under D15 that version is on no registry — so the beta manifest
// drops the dependency rather than pinning it, on the grounds that
// `packages/cli/build.mjs` inlines the SDK into the bundle already.
// `assertBundleInlines` reads the packed bundle to check that the code the
// manifest stopped naming is actually in the tarball.
//
// **What each branch actually holds, stated exactly, because a looser sentence
// was here first.** The dependency check below iterates
// `Object.entries(packed.dependencies)`, so it only ever speaks about a
// dependency that is *present*:
//
//   * on the **release** path it refuses a `@actana/sdk` pinned to anything but
//     the version being published — a CLI on another train's SDK. It says
//     nothing about a release manifest that dropped the SDK altogether, and
//     such a manifest passes here.
//   * on the **beta** path it refuses a `@actana/sdk` at *any* range, correct
//     one included, because under D15 no range of it resolves.
//
// So the beta branch is strictly narrower than the release branch on the
// manifests it sees, and the release-side *presence* of the SDK is held
// somewhere else — `packages/cli/src/__tests__/no-local-escape.test.ts` pins the
// working-tree manifest's dependency set to exactly four names on every pull
// request, and the release packs from that working tree. Two checks, one
// invariant, and this comment names which is which so nobody reads the loop
// below as guaranteeing more than it does.
//
// ── Why the set is discovered rather than listed ─────────────────────────────
//
// `PUBLISHABLE` below is the *intent* — D13's two packages. What actually gets
// published is `discoverPublishable()`: every workspace manifest without
// `private: true`. The two are checked against each other rather than one being
// derived from the other, because each direction catches a different mistake:
//
//   * a package that quietly loses `private: true` — `@actana/panel` is a web
//     service and `@actana/core` a daemon; neither is an npm package, and
//     neither should become one by an unreviewed keystroke — is discovered,
//     is not in `PUBLISHABLE`, and fails.
//   * `@actana/sdk` re-acquiring `private: true` is not discovered, and fails
//     for the opposite reason: a release that silently publishes nothing looks
//     exactly like a release that published.
//
// The one asymmetry the rule allows is a package in `PUBLISHABLE` with **no
// manifest at all** — an intended package that has not been written yet. Its
// absence is reported by the rehearsal rather than passed over, so "that leg
// never ran" cannot read as "that leg passed".
//
// It does **not** allow a manifest that exists and is `private: true`. #157
// landed `packages/cli` private, saying #159 would flip it; #159's discovery
// rule would then have skipped it in silence, published one tarball, and gone
// green while five statements in this repository said two packages had shipped.
// "The package is not written yet" and "the package is written and will never
// ship" are one empty set to a rule that only looks at what it discovered, and
// they are opposite facts. `assertPublishSet` therefore takes the whole
// workspace as well as the discovered set, and the second case is an error.
//
// ── Two kinds of published package ───────────────────────────────────────────
//
// `@actana/sdk` is **imported** and `@actana/cli` is **run**, and the rules
// that can be stated about one cannot be stated about the other. A library
// resolves through an `exports` map and owes a consumer `.d.ts` beside every
// module; a command resolves through `bin`, is an esbuild bundle with no type
// surface at all, and owes a consumer a linked entry point that is actually in
// the tarball and actually starts with a shebang. Everything else — the
// engines floor, the lifecycle refusal, the whitelist, the licence, the
// version lockstep — is common, and applying a library's `.d.ts` rule to a
// bundled command would have exactly one outcome: the CLI kept out of the
// publish set, which is the failure this file just finished describing.

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The packages D13 publishes to npm. Everything else in the workspace is
 * `private: true` and stays that way.
 */
export const PUBLISHABLE = ["@actana/sdk", "@actana/cli"];

/** D12's floor, quoted. A published package declares exactly this. */
export const PUBLISHED_ENGINES = ">=22";

/**
 * ADR 0036 C1's beta version string, in full. `x.y.z-beta` and **nothing after
 * the word `beta`** — no counter, no `.N`, no run number, no short sha.
 *
 * Anchored at both ends deliberately. The string this rejects is not a typo, it
 * is the shape a workflow reaches for the second time it cuts the same beta and
 * finds the first one already there — and C1 bans that outright rather than
 * leaving it to a reviewer to notice a `.2` in an asset filename.
 */
export const BETA_VERSION = /^\d+\.\d+\.\d+-beta$/;

/** `0.4.1` → `0.4.1-beta`, the only beta string C1 permits for a line. */
export function betaVersion(line) {
  if (!/^\d+\.\d+\.\d+$/.test(line)) {
    throw new Error(
      `${JSON.stringify(line)} is not a release line. A beta is cut for an \`x.y.z\` line and is named ` +
        "`x.y.z-beta` (ADR 0036 C1); there is no counter to append and no prerelease to append one to.",
    );
  }
  return `${line}-beta`;
}

/**
 * The names an esbuild config marks `external`, across every `external:` array
 * in it.
 *
 * The beta install path (#320, ADR 0036 D16) rests entirely on `@actana/sdk`
 * being absent from this list in `packages/cli/build.mjs`: external means the
 * bundle `import`s the name at runtime, and a name imported at runtime has to
 * resolve from the registry — which under D15 will never carry the beta
 * version. Inlined, it resolves from nothing at all.
 *
 * `packages/cli/src/__tests__/no-local-escape.test.ts` reads the same array
 * with its own copy of this regex and asserts the same absence from the other
 * side of the package boundary. Two readers rather than one import, because
 * that test is the CLI package's own and does not reach into `scripts/`.
 */
export function externalNames(buildSource) {
  return [...buildSource.matchAll(/external:\s*\[([^\]]*)\]/g)].flatMap(
    (match) => match[1]?.match(/"([^"]+)"/g)?.map((quoted) => quoted.slice(1, -1)) ?? [],
  );
}

/**
 * That a bundle inlines a package rather than importing it — asserted on the
 * bundle's own bytes, out of the tarball, rather than on the config that
 * produced them.
 *
 * This is the assertion the beta route needs and `externalNames` only
 * approximates: `build.mjs` says what was *asked for*, and this says what
 * *came out*. A dependency dropped from the packed manifest is safe exactly
 * when the shipped bundle never names it as a specifier, and nothing short of
 * reading the shipped bundle can tell you that.
 *
 * **Specifier position, not a substring.** The CLI bundle inlines its own
 * `package.json` — that is where `actana --version` gets its answer — so the
 * text `"@actana/sdk": "workspace:*"` appears in the bytes of a bundle that
 * imports nothing of the sort. A `bundle.includes(name)` here would fail every
 * pack for a reason that is not a defect.
 */
export function assertBundleInlines(name, bundle, dependency) {
  const quoted = dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const specifier = new RegExp(
    `(?:from|import|require)\\s*\\(?\\s*["'\`]${quoted}(?:/[^"'\`]*)?["'\`]`,
  );
  if (specifier.test(bundle)) {
    throw new Error(
      `${name}'s bundle imports ${dependency} at runtime rather than inlining it. The beta CLI tarball drops that ` +
        "dependency from its manifest on the grounds that the bundle carries the code (ADR 0036 D16), so an " +
        "external one is an install that resolves a version the registry does not have and never will (D15). " +
        `Either keep ${dependency} out of \`build.mjs\`'s \`external\` array, or the beta route needs re-deciding.`,
    );
  }
}

/** D12's other half: what the monorepo, Core and Panel keep. */
export const MONOREPO_ENGINES = ">=24.0.0 <25";

/** The Node guard that is correct for the monorepo and must never be packed. */
export const NODE_GUARD = "require-node-24.mjs";

/**
 * The manifest and its paperwork — allowed in any published tarball, whichever
 * kind of package it is.
 *
 * These lists are a whitelist, not a blocklist. "No `require-node-24.mjs`" is
 * the criterion #159 names, but asserting only that would pass a tarball
 * carrying the whole of `scripts/` as long as one file had been renamed. What
 * has to hold is that a published package is its own compiled output and its
 * paperwork — nothing from the repository around it.
 */
const PAPERWORK_ENTRIES = [
  /^package\/package\.json$/,
  /^package\/(README|LICENSE|NOTICE|CHANGELOG)(\.md)?$/,
];

/**
 * What a library may ship: compiled JavaScript, its types, and their maps.
 *
 * **`dist/` is deliberately flat.** The pattern permits one level and no more,
 * so the day `src/` grows a subdirectory the rehearsal fails with "outside
 * `dist/` and its paperwork" — which reads as a leak and is not one. That is a
 * fail-closed choice rather than an oversight: the published subpath map is
 * `./*` → `./dist/*.js`, so a nested module would be unreachable to a consumer
 * anyway, and a tarball is the wrong place to discover it. If a nested layout
 * is ever wanted, this pattern and `publishConfig.exports` move together — the
 * failure is telling you they have to.
 */
const LIBRARY_ENTRIES = [/^package\/dist\/[^/]+\.(js|d\.ts|js\.map|d\.ts\.map)$/];

/**
 * What a command may ship: the bundle, its map, and the `bin/` shims npm links.
 *
 * `bin/` is a published path in the strongest sense — it is what npm records
 * when it links the command — so it is in the whitelist rather than swept up
 * as a stray. `.mjs` because a bundle is one file with an unambiguous
 * extension rather than a module map, and no `.d.ts`: nothing imports a
 * command, and requiring types of one would mean either a fake declaration
 * file or a package left unpublished.
 */
const COMMAND_ENTRIES = [
  /^package\/dist\/[^/]+\.(mjs|mjs\.map)$/,
  /^package\/bin\/[^/]+\.mjs$/,
];

/**
 * Which kinds a packed manifest is, from what it offers a consumer: an
 * `exports` map is a library, a `bin` map is a command. A package may be both;
 * a package that is neither is unreachable and refused by
 * {@link assertPackedManifest}.
 */
export function packageKind(packed) {
  return {
    library: packed.exports !== undefined,
    command: packed.bin !== undefined,
  };
}

/** The bin targets a manifest declares, as tarball paths. `{ actana: "bin/actana.mjs" }` → `package/bin/actana.mjs`. */
export function binTargets(packed) {
  const bin = packed.bin;
  if (bin === undefined) return [];
  const targets = typeof bin === "string" ? [bin] : Object.values(bin);
  return targets.map((target) => `package/${target.replace(/^\.\//, "")}`);
}

/** Lifecycle scripts a consumer's `npm install` would execute. D12 forbids all of them. */
const INSTALL_LIFECYCLE = ["preinstall", "install", "postinstall", "prepare"];

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/**
 * Every workspace manifest, as `{ name, dir, relative, manifest }`.
 *
 * Read off `packages/` rather than out of a list, for the reason the
 * five-manifest assertion in `scripts/__tests__/workflows.test.mjs` gives: a
 * number goes stale silently, and a directory listing cannot.
 */
export function workspaceManifests(repoRoot) {
  const dir = path.join(repoRoot, "packages");
  return fs
    .readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((full) => fs.existsSync(path.join(full, "package.json")))
    .map((full) => {
      const manifest = readJson(path.join(full, "package.json"));
      return {
        name: manifest.name,
        dir: full,
        relative: `packages/${path.basename(full)}/package.json`,
        manifest,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The packages a release actually publishes: every workspace manifest without
 * `private: true`.
 *
 * This is what `release.yml` iterates. `assertPublishSet` is what keeps it
 * honest against `PUBLISHABLE`.
 */
export function discoverPublishable(repoRoot) {
  return workspaceManifests(repoRoot).filter((pkg) => pkg.manifest.private !== true);
}

/**
 * The discovered set in publish order: a package after every publishable
 * package it depends on, and alphabetical otherwise.
 *
 * This did not matter while the SDK published alone. It does now: `@actana/cli`
 * depends on `@actana/sdk` at exactly the version being released, and the two
 * are published one after another by a loop. Publishing the CLI first opens a
 * window — seconds if the SDK follows, permanent if the SDK's publish fails —
 * in which `npm i @actana/cli` resolves a dependency that is not on the
 * registry. The CLI's version number is burned by then, so "publish the other
 * one and it fixes itself" is only true on the happy path.
 *
 * Alphabetical would have put `@actana/cli` first, which is how this was found.
 */
export function publishOrder(found) {
  const byName = new Map(found.map((pkg) => [pkg.name, pkg]));
  const state = new Map();
  const ordered = [];

  const visit = (pkg, trail) => {
    const status = state.get(pkg.name);
    if (status === "done") return;
    if (status === "visiting") {
      throw new Error(
        `the published packages depend on each other in a cycle: ${[...trail, pkg.name].join(" → ")}. There is no order ` +
          "that publishes each after the one it needs, so one of these dependencies has to go.",
      );
    }
    state.set(pkg.name, "visiting");
    for (const dependency of Object.keys(pkg.manifest.dependencies ?? {}).sort()) {
      const sibling = byName.get(dependency);
      if (sibling !== undefined) visit(sibling, [...trail, pkg.name]);
    }
    state.set(pkg.name, "done");
    ordered.push(pkg);
  };

  for (const pkg of [...found].sort((a, b) => a.name.localeCompare(b.name))) visit(pkg, []);
  return ordered;
}

/**
 * Check the discovered set against D13's intent, in every direction that has a
 * different failure behind it.
 *
 * `found` is `discoverPublishable(repoRoot)`; `all` is
 * `workspaceManifests(repoRoot)` — the whole workspace, discovered set
 * included. Both are needed because the interesting mistake is invisible in
 * the first alone: a `PUBLISHABLE` name missing from `found` means "no
 * manifest" and "a manifest carrying `private: true`" at the same time, and
 * those are opposite facts about a release. Only `all` can tell them apart.
 *
 * Returns the names in `PUBLISHABLE` with no manifest anywhere, so the caller
 * can report them by name. Throws on everything else.
 */
export function assertPublishSet(found, all) {
  const names = found.map((pkg) => pkg.name);
  const existing = new Set(all.map((pkg) => pkg.name));

  const unexpected = names.filter((name) => !PUBLISHABLE.includes(name));
  if (unexpected.length > 0) {
    throw new Error(
      `${unexpected.join(", ")} would be published to npm and ${unexpected.length === 1 ? "is" : "are"} not one of D13's packages ` +
        `(${PUBLISHABLE.join(", ")}). A workspace package is published exactly when its manifest drops \`private: true\`, ` +
        "so this is one keystroke away from putting the Panel or the Core on a public registry. Restore `private: true`, " +
        "or amend #129 D13 and this list together.",
    );
  }

  // The case #157 and #159 each expected the other to close. A manifest that
  // exists and is private is not an absent package: nothing further is going
  // to land, the release publishes a subset and goes green, and the docs that
  // name the package go on saying it shipped.
  const withheld = PUBLISHABLE.filter((name) => existing.has(name) && !names.includes(name));
  if (withheld.length > 0) {
    throw new Error(
      `${withheld.join(", ")} ${withheld.length === 1 ? "has a manifest in `packages/` and carries" : "have manifests in `packages/` and carry"} ` +
        "`private: true`, so a release would publish the rest and report success. That is not the same thing as a package " +
        "that has not been written yet — this one exists and is being withheld. Drop `private: true` from it, or take it " +
        `out of \`PUBLISHABLE\` and amend #129 D13, which says these ${PUBLISHABLE.length} packages publish together.`,
    );
  }

  const absent = PUBLISHABLE.filter((name) => !existing.has(name));

  if (!names.includes("@actana/sdk")) {
    throw new Error(
      "@actana/sdk is not publishable — no manifest of it was discovered. A release that publishes nothing " +
        "reports exactly the same green as one that published, which is why this is an error rather than a skip (#129 D13).",
    );
  }

  return absent;
}

/**
 * D12 and D13 against one manifest, as it will be published.
 *
 * `packed` is the manifest **from inside the tarball**, not the one in the
 * working tree: `publishConfig` field replacement rewrites `exports` at pack
 * time and `prepack` is stripped from the published `scripts`, so the working
 * copy is not what a consumer installs and is not what this may assert on.
 *
 * `version` is the release being cut, and is optional — the rehearsal runs
 * before any tag exists.
 *
 * `beta` says this manifest is the one ADR 0036 D16 attaches to a beta
 * prerelease as a Release asset rather than publishing to the registry. It
 * **narrows** the rules rather than relaxing them, and it narrows exactly two:
 * the version string has to be C1's `x.y.z-beta` and nothing else, and the
 * sibling-package dependency has to be *absent* rather than pinned. Every other
 * rule below is the same rule, because a beta tarball is installed by the same
 * `npm i -g` on the same operator's machine and can fail in all the same ways.
 * The release path is untouched: `beta` defaults to false and no line under it
 * changed.
 */
export function assertPackedManifest(packed, { version, beta = false } = {}) {
  const where = `${packed.name}@${packed.version}`;

  // C1, on the artifact rather than on the workflow that named it. The beta
  // string is fixed for the life of the line, so this is also what refuses the
  // counter a second cut of the same beta would otherwise want to reach for.
  if (beta && !BETA_VERSION.test(packed.version)) {
    throw new Error(
      `${where} is packed as a beta and its version is not \`x.y.z-beta\`. ADR 0036 C1 fixes that string on every ` +
        "surface — the git tag, the Release, every image tag, every asset filename — with no counter, no dotted " +
        "suffix, no run number and no short sha after the word `beta`. A version this shape reaches an asset " +
        "filename an operator is told to curl, so it is refused here rather than at the download.",
    );
  }

  if (packed.private === true) {
    throw new Error(`${where} is marked private and cannot be published.`);
  }

  if (packed.engines?.node !== PUBLISHED_ENGINES) {
    throw new Error(
      `${where} declares engines.node=${JSON.stringify(packed.engines?.node)}; D12 says exactly "${PUBLISHED_ENGINES}". ` +
        "The monorepo's `>=24.0.0 <25` is a policy about this repository's own tooling; inherited by a published " +
        "package it becomes an install-time refusal on the runtime #151's spike proved the transport works on.",
    );
  }

  for (const lifecycle of INSTALL_LIFECYCLE) {
    if (packed.scripts?.[lifecycle] !== undefined) {
      throw new Error(
        `${where} ships a \`${lifecycle}\` script (${packed.scripts[lifecycle]}). D12 forbids it: a lifecycle script ` +
          "runs on the consumer's machine during `npm install`, which is where this repository's Node-24 guard would " +
          "turn a supported install into a hard exit.",
      );
    }
  }

  const kind = packageKind(packed);
  if (!kind.library && !kind.command) {
    throw new Error(
      `${where} publishes neither an \`exports\` map nor a \`bin\` map, so nothing in it is reachable: a consumer can ` +
        "neither import it nor run it. A published package is one of the two — the SDK is imported, the CLI is run — and " +
        "a tarball that is neither installs cleanly and does nothing at all.",
    );
  }

  if (kind.library) {
    const exportsMap = packed.exports;
    if (typeof exportsMap !== "object" || exportsMap === null) {
      throw new Error(`${where} publishes no \`exports\` map, so no subpath resolves.`);
    }
    const targets = JSON.stringify(exportsMap);
    if (targets.includes("./src/")) {
      throw new Error(
        `${where} exports ${targets} — the published map still points at TypeScript source. Inside the workspace the SDK ` +
          "is consumed as source and that is deliberate (Node strips the types); on npm it is compiled JavaScript, and " +
          "the two are reconciled by `publishConfig.exports`, which pnpm applies when it packs. This manifest was not packed.",
      );
    }
    if (!targets.includes(".d.ts")) {
      throw new Error(`${where} exports ${targets} — no \`types\` condition, so a TypeScript consumer sees \`any\` (D12).`);
    }
  }

  if (kind.command) {
    const targets = binTargets(packed);
    if (targets.length === 0) {
      throw new Error(`${where} declares an empty \`bin\` map, so it installs no command.`);
    }
    // The path npm links, so it is the one path in a command package that
    // cannot point outside the tarball. `assertPackedFiles` is what checks the
    // file is actually in it.
    const escaping = targets.filter((target) => target.includes("/../") || target.endsWith("/.."));
    if (escaping.length > 0) {
      throw new Error(`${where} maps a command to ${escaping.join(", ")}, which is outside the package.`);
    }
  }

  // Provenance needs a `repository` npm can resolve the attestation against: a
  // publish with `--provenance` and no `repository.url` is rejected by the
  // registry. That refusal would land in the `npm` job — last in the graph,
  // after both images and their `:latest` have already moved — so it is
  // asserted on a pull request instead, where being wrong is free.
  if (typeof packed.repository?.url !== "string" || packed.repository.url.length === 0) {
    throw new Error(
      `${where} declares no \`repository.url\`. \`npm publish --provenance\` refuses a package without one — the ` +
        "attestation names the repository and the commit that built it, and there is nothing to name. The failure " +
        "would arrive in the last job of the release, with both images already published.",
    );
  }

  // D13's lockstep, in the one place a consumer meets it: `@actana/cli`
  // depends on `@actana/sdk`, pnpm rewrites `workspace:*` to a real version as
  // it packs, and a tarball that still carries the protocol was not packed by
  // pnpm and is rejected by npm. A resolved-but-wrong version is worse: it
  // installs, and pairs a CLI with an SDK from another train.
  for (const [dependency, range] of Object.entries(packed.dependencies ?? {})) {
    if (range.startsWith("workspace:")) {
      throw new Error(
        `${where} depends on ${dependency}@${range} — the \`workspace:\` protocol reached the packed manifest. pnpm ` +
          "replaces it with a real version at pack time and npm rejects what is left, so this manifest was not packed by pnpm.",
      );
    }
    if (PUBLISHABLE.includes(dependency) && beta) {
      // The beta narrowing, and it is a *stricter* rule than the release one
      // rather than a hole in it. On this path there is no registry publish at
      // all (ADR 0036 D15), so `@actana/sdk@x.y.z-beta` is a version npm will
      // never be able to resolve — pinning it correctly and pinning it to
      // another train fail identically, at the operator's `npm i -g`. What
      // makes the absence honest is that the bundle carries the SDK's code:
      // `assertBundleInlines` is where that is checked, on the packed bytes.
      throw new Error(
        `${where} is packed as a beta and still depends on ${dependency}@${range}. Nothing is published to ` +
          "registry.npmjs.org by a beta cut (ADR 0036 D15), so that range resolves against a registry that has no " +
          `such version and never will, and \`npm i -g <asset-url>\` fails on it. ${dependency} is inlined into the ` +
          "bundle by `packages/cli/build.mjs`, so the beta manifest drops it (D16, route 2).",
      );
    }
    if (PUBLISHABLE.includes(dependency) && range !== packed.version) {
      throw new Error(
        `${where} depends on ${dependency}@${range}, not on ${packed.version}. D13 is one version line, and these two ` +
          "packages are published from the same tag on the same train — a CLI pinned to another train's SDK is the " +
          "mismatch the single version line exists to make impossible.",
      );
    }
  }

  if (packed.publishConfig?.access !== "public") {
    throw new Error(
      `${where} does not set \`publishConfig.access: "public"\`. A scoped package defaults to restricted, and the ` +
        "first publish of a restricted package on a free account fails at the registry.",
    );
  }
  if (packed.publishConfig?.provenance !== true) {
    throw new Error(
      `${where} does not set \`publishConfig.provenance: true\`. \`--provenance\` is passed on the command line too; ` +
        "this is the half that cannot be dropped by editing a workflow line, and an unattested publish is not " +
        "distinguishable from an attested one after the fact.",
    );
  }

  if (version !== undefined && packed.version !== version) {
    throw new Error(
      `${where} is not the version being released (${version}). D13 is one version line across Core, Panel, SDK and CLI, ` +
        "published on the same tag that builds the images — a package that lags by one train is a package nobody can " +
        "pair with the image they are running.",
    );
  }
}

/**
 * The file list of a packed tarball, against the whitelist.
 *
 * `packed` is the manifest from inside the tarball — it decides which rules
 * apply, because a library and a command ship different things — and `entries`
 * are the paths `tar -tzf` reports, `package/`-prefixed.
 */
export function assertPackedFiles(packed, entries) {
  const name = packed.name;
  const kind = packageKind(packed);
  const allowed = [
    ...PAPERWORK_ENTRIES,
    ...(kind.library ? LIBRARY_ENTRIES : []),
    ...(kind.command ? COMMAND_ENTRIES : []),
  ];
  const files = entries.filter((entry) => entry.length > 0 && !entry.endsWith("/"));

  const guard = files.filter((entry) => path.basename(entry) === NODE_GUARD);
  if (guard.length > 0) {
    throw new Error(
      `${name} packs ${guard.join(", ")}. \`${NODE_GUARD}\` exits 1 on every runtime that is not Node 24 — in a ` +
        "published tarball that is an install-time refusal aimed at consumers, on a floor D12 deliberately set to 22.",
    );
  }

  const stray = files.filter((entry) => !allowed.some((pattern) => pattern.test(entry)));
  if (stray.length > 0) {
    throw new Error(
      `${name} packs ${stray.join(", ")}, which is outside \`dist/\` and its paperwork. A published package is its own ` +
        "compiled output; anything else is this repository leaking into a tarball people install (D12).",
    );
  }

  if (kind.library) {
    const js = files.filter((entry) => /^package\/dist\/[^/]+\.js$/.test(entry));
    if (js.length === 0) {
      throw new Error(`${name} packs no compiled JavaScript under \`dist/\` (D12). Did the build run?`);
    }
    const missingTypes = js.filter((entry) => !files.includes(entry.replace(/\.js$/, ".d.ts")));
    if (missingTypes.length > 0) {
      throw new Error(
        `${name} ships ${missingTypes.join(", ")} with no \`.d.ts\` beside it. D12 is compiled JS **plus** types; a module ` +
          "that resolves at runtime and not at compile time is the half-published state nobody notices until a consumer builds.",
      );
    }
  }

  if (kind.command) {
    // The `bin` map is a promise npm keeps by linking a path out of the
    // tarball, and it does not check the path is in there. npm packs a `bin`
    // target whatever `files` says, so what reaches this is the case `files`
    // cannot fix: the map names a file that does not exist — the shim renamed
    // with the manifest not followed, an extension typo, a build writing
    // somewhere else. The install stays green and `actana` is a dangling link.
    const missing = binTargets(packed).filter((target) => !files.includes(target));
    if (missing.length > 0) {
      throw new Error(
        `${name} maps a command to ${missing.join(", ")} and does not pack ${missing.length === 1 ? "it" : "them"}. npm ` +
          "links that path on install without checking it exists, so this publishes a package whose command is a " +
          "dangling link. The `bin` map and the file it names have to move together.",
      );
    }
    const bundle = files.filter((entry) => /^package\/dist\/[^/]+\.mjs$/.test(entry));
    if (bundle.length === 0) {
      throw new Error(
        `${name} packs no bundle under \`dist/\` (D12). The \`bin/\` shim loads one and exits 70 without it. Did \`prepack\` run?`,
      );
    }
  }

  // Asserted rather than inferred from a file count. `packages/sdk/` has no
  // `LICENSE` of its own; the one in the tarball is the workspace root's,
  // copied in by pnpm at pack time. That is pnpm behaviour and not a
  // guarantee — `ALLOWED_ENTRIES` permits a LICENSE and nothing required one —
  // so an MIT package could ship to npm with no licence text in it, which is a
  // real if quiet defect and exactly the kind that a count in a PR description
  // is not evidence about either way.
  if (!files.some((entry) => /^package\/LICENSE(\.md)?$/.test(entry))) {
    throw new Error(
      `${name} packs no LICENSE. The manifest declares a licence and the tarball is what a consumer actually receives; ` +
        "pnpm copies the workspace root's LICENSE in at pack time, so an absent one means that behaviour changed or the " +
        "root file moved — either way the published package would carry a licence claim with no text behind it.",
    );
  }
}

/**
 * A linked command's entry point, read out of the tarball.
 *
 * On a POSIX install npm symlinks `node_modules/.bin/<name>` at this file and
 * the kernel reads its first two bytes; without `#!` the shell runs it as a
 * shell script and the consumer gets a syntax error out of their own `import`
 * statements. Nothing else in the publish path can see this: it is a property
 * of the file's contents, not of its name, its manifest, or the file list.
 */
export function assertPackedBin(name, target, contents) {
  if (!contents.startsWith("#!")) {
    throw new Error(
      `${name} packs ${target} with no shebang. npm links this path as a command, and a linked file without \`#!\` is ` +
        "handed to the shell — the failure a consumer sees is a syntax error inside JavaScript they never wrote.",
    );
  }
  if (!/^#![^\n]*node/.test(contents)) {
    throw new Error(
      `${name} packs ${target} with a shebang that does not name node: ${contents.split("\n")[0]}.`,
    );
  }
}

/**
 * The other half of D12, asserted at the same time and in the same place: the
 * monorepo keeps the floor the published packages drop.
 *
 * These two facts are one decision, and a check that only ever looked at the
 * tarball would pass just as happily if somebody "fixed" the root manifest to
 * `>=22` to make the whole thing consistent — which would silently drop the
 * Core and the Panel onto a runtime neither is built or tested for.
 */
export function assertMonorepoKeepsTheGuard(repoRoot) {
  const root = readJson(path.join(repoRoot, "package.json"));

  if (root.engines?.node !== MONOREPO_ENGINES) {
    throw new Error(
      `the root manifest declares engines.node=${JSON.stringify(root.engines?.node)}; D12 keeps the monorepo, Core and ` +
        `Panel on "${MONOREPO_ENGINES}". The published floor is ">=22" and the two are not in tension: one is what this ` +
        "repository is developed and released on, the other is what a consumer of the SDK needs.",
    );
  }

  if (root.scripts?.preinstall !== `node scripts/${NODE_GUARD}`) {
    throw new Error(
      `the root manifest's \`preinstall\` is ${JSON.stringify(root.scripts?.preinstall)}. The guard is correct here and ` +
        "stays: D12 removes it from what is published, not from the repository.",
    );
  }

  if (!fs.existsSync(path.join(repoRoot, "scripts", NODE_GUARD))) {
    throw new Error(`scripts/${NODE_GUARD} is gone; the monorepo's half of D12 is what it enforces.`);
  }
}
