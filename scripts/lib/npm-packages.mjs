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
// `@actana/cli` is in `PUBLISHABLE` and does not exist yet — issue #157 creates
// `packages/cli` in parallel with this change. That is the one asymmetry the
// rule allows: an intended package may be absent, and the moment #157 lands a
// non-private manifest it is discovered and published with no edit here and
// none in `release.yml`. Its absence is reported by the rehearsal rather than
// passed over, so "the CLI leg never ran" cannot read as "the CLI leg passed".

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The packages D13 publishes to npm. Everything else in the workspace is
 * `private: true` and stays that way.
 */
export const PUBLISHABLE = ["@actana/sdk", "@actana/cli"];

/** D12's floor, quoted. A published package declares exactly this. */
export const PUBLISHED_ENGINES = ">=22";

/** D12's other half: what the monorepo, Core and Panel keep. */
export const MONOREPO_ENGINES = ">=24.0.0 <25";

/** The Node guard that is correct for the monorepo and must never be packed. */
export const NODE_GUARD = "require-node-24.mjs";

/**
 * Everything a published tarball may contain, as anchored patterns against the
 * `package/`-prefixed paths npm writes.
 *
 * A whitelist, not a blocklist. "No `require-node-24.mjs`" is the criterion
 * #159 names, but asserting only that would pass a tarball carrying the whole
 * of `scripts/` as long as one file had been renamed. What has to hold is that
 * a published package is its own compiled output and its paperwork — nothing
 * from the repository around it.
 *
 * **`dist/` is deliberately flat.** The third pattern permits one level and no
 * more, so the day `src/` grows a subdirectory the rehearsal fails with
 * "outside `dist/` and its paperwork" — which reads as a leak and is not one.
 * That is a fail-closed choice rather than an oversight: the published subpath
 * map is `./*` → `./dist/*.js`, so a nested module would be unreachable to a
 * consumer anyway, and a tarball is the wrong place to discover it. If a
 * nested layout is ever wanted, this pattern and `publishConfig.exports` move
 * together — the failure is telling you they have to.
 */
const ALLOWED_ENTRIES = [
  /^package\/package\.json$/,
  /^package\/(README|LICENSE|NOTICE|CHANGELOG)(\.md)?$/,
  /^package\/dist\/[^/]+\.(js|d\.ts|js\.map|d\.ts\.map)$/,
];

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
 * Check the discovered set against D13's intent, both directions.
 *
 * Returns the names in `PUBLISHABLE` that do not exist yet — `@actana/cli`
 * until #157 lands — so the caller can report them. Throws on anything else.
 */
export function assertPublishSet(found) {
  const names = found.map((pkg) => pkg.name);

  const unexpected = names.filter((name) => !PUBLISHABLE.includes(name));
  if (unexpected.length > 0) {
    throw new Error(
      `${unexpected.join(", ")} would be published to npm and ${unexpected.length === 1 ? "is" : "are"} not one of D13's packages ` +
        `(${PUBLISHABLE.join(", ")}). A workspace package is published exactly when its manifest drops \`private: true\`, ` +
        "so this is one keystroke away from putting the Panel or the Core on a public registry. Restore `private: true`, " +
        "or amend #129 D13 and this list together.",
    );
  }

  if (!names.includes("@actana/sdk")) {
    throw new Error(
      "@actana/sdk is not publishable — its manifest carries `private: true`. A release that publishes nothing " +
        "reports exactly the same green as one that published, which is why this is an error rather than a skip (#129 D13).",
    );
  }

  return PUBLISHABLE.filter((name) => !names.includes(name));
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
 */
export function assertPackedManifest(packed, { version } = {}) {
  const where = `${packed.name}@${packed.version}`;

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

  const exportsMap = packed.exports;
  if (!exportsMap || typeof exportsMap !== "object") {
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
 * `entries` are the paths `tar -tzf` reports, `package/`-prefixed.
 */
export function assertPackedFiles(name, entries) {
  const files = entries.filter((entry) => entry.length > 0 && !entry.endsWith("/"));

  const guard = files.filter((entry) => path.basename(entry) === NODE_GUARD);
  if (guard.length > 0) {
    throw new Error(
      `${name} packs ${guard.join(", ")}. \`${NODE_GUARD}\` exits 1 on every runtime that is not Node 24 — in a ` +
        "published tarball that is an install-time refusal aimed at consumers, on a floor D12 deliberately set to 22.",
    );
  }

  const stray = files.filter((entry) => !ALLOWED_ENTRIES.some((pattern) => pattern.test(entry)));
  if (stray.length > 0) {
    throw new Error(
      `${name} packs ${stray.join(", ")}, which is outside \`dist/\` and its paperwork. A published package is its own ` +
        "compiled output; anything else is this repository leaking into a tarball people install (D12).",
    );
  }

  const js = files.filter((entry) => /^package\/dist\/[^/]+\.js$/.test(entry));
  if (js.length === 0) {
    throw new Error(`${name} packs no compiled JavaScript under \`dist/\` (D12). Did the build run?`);
  }
  const missingTypes = js.filter(
    (entry) => !files.includes(entry.replace(/\.js$/, ".d.ts")),
  );
  if (missingTypes.length > 0) {
    throw new Error(
      `${name} ships ${missingTypes.join(", ")} with no \`.d.ts\` beside it. D12 is compiled JS **plus** types; a module ` +
        "that resolves at runtime and not at compile time is the half-published state nobody notices until a consumer builds.",
    );
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
