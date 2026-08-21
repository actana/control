// Embed the authored skill folders into both packages that have to write them.
//
// ADR 0031 D8. The skills are authored once under `.agents/skills/`, following
// the `release` skill's harness-neutral precedent, and this script writes them
// into `packages/shared` (which the Core imports) and `packages/cli`, which
// embeds its own copy so the published bundle carries the payload rather than
// resolving it (ADR 0031 D8).
//
// **A folder, not a file** (#304, ADR 0035 D4 and D5). A skill ships `await.sh`
// beside `SKILL.md`, so what is embedded per skill is a map from folder-relative
// path to bytes rather than one string constant.
//
// **Two folders, not one** (#303, ADR 0035 D1 and D4). `actana-sessions` carries
// the orchestrator role and `actana-subagent` the sub-agent role, and the shape
// the previous pass deliberately left open is settled here, in the change that
// brings the second folder: **one map keyed by folder name**, each value the
// folder's own path-to-bytes map. A folder name stays a string this script is
// handed and the installer is given — never an identifier anything branches on,
// which is what ADR 0035 D1's asymmetry must not become in code.
//
// D5 is explicit that this is a change of *shape* and not of *kind*: one
// authored source per skill, embedded into the same two bundles, held honest by
// the same one drift test. No second generator, no copy in `dist/`.
//
// **Embedded as strings, not copied into `dist/`.** The Core ships as an
// esbuild bundle and the CLI ships as one too, so a `.md` asset read from disk
// at runtime is a file that is not in the bundle — the same reason
// `harness-hooks-opencode.ts` keeps its plugin as a template literal rather
// than an asset beside it. A template literal is in the bundle.
//
// Running this is not what keeps the copies honest; the drift test is, and it
// is one test in one package:
// `packages/shared/src/__tests__/orchestration-skill-fanout.test.ts` re-reads
// the authored folder, fails when either generated copy no longer matches it
// entry for entry, and fails again when the two generated copies disagree with
// each other. This script is how you fix those failures.
//
//   node scripts/gen-skill-payload.mjs

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The authored skill folders, in the order the payload lists them.
 *
 * A list rather than two constants, because everything downstream of here — the
 * generator's loop, the emitted map, both installers — treats them the same
 * way. The roles they carry are a property of the prose inside them (ADR 0035
 * D1), and adding a third folder is a line in this array.
 */
export const SKILL_NAMES = ["actana-sessions", "actana-subagent"];
export const SKILLS_ROOT = join(".agents", "skills");
export const MARKER = "x-actana-managed: true";

const TARGETS = [
  join("packages", "shared", "src", "orchestration-skill-payload.ts"),
  join("packages", "cli", "src", "orchestration-skill-payload.ts"),
];

/**
 * Every file in one skill folder, as `{ relative, content }`, sorted by path.
 *
 * Takes the folder name rather than closing over one, because a second skill
 * folder is a second call and nothing else — a folder name is a string this
 * script is handed, never an identifier it branches on.
 *
 * Sorted, because the emitted map's key order is the diff a reviewer reads, and
 * `readdir` order is the filesystem's business. POSIX separators, because the
 * installer splits these keys on `/` on every platform.
 */
export function readSkillFolder(skillName) {
  const root = join(repoRoot, SKILLS_ROOT, skillName);
  const walk = (dir, prefix) =>
    readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name), posix.join(prefix, entry.name))
          : [{ relative: posix.join(prefix, entry.name), content: readFileSync(join(dir, entry.name), "utf8") }],
      )
      .sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  return walk(root, "");
}

/**
 * Every authored folder as a TypeScript map of maps of template literals.
 *
 * Template literals rather than `JSON.stringify`, because the payload is nine
 * kilobytes of prose and a one-line JSON string turns every edit to it into a
 * one-line diff nobody can review. Only three sequences can end or escape a
 * template literal, and all three are escaped here — per value, unchanged.
 */
export function renderPayload(folders) {
  const escape = (text) =>
    text
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$\{/g, "\\${");

  const entries = folders
    .map(({ skillName, files }) => {
      const inner = files
        .map((file) => `    ${JSON.stringify(file.relative)}: \`${escape(file.content)}\`,`)
        .join("\n");
      return `  ${JSON.stringify(skillName)}: {\n${inner}\n  },`;
    })
    .join("\n");

  return `// GENERATED by scripts/gen-skill-payload.mjs — do not edit.
//
// The sources are the folders under \`${SKILLS_ROOT}/\` named by
// \`ORCHESTRATION_SKILL_NAMES\` below, and
// \`packages/shared/src/__tests__/orchestration-skill-fanout.test.ts\` — the one
// drift test, in the one package that can read both copies — fails when the two
// disagree. Edit the authored files, re-run the generator, commit both.
// ADR 0031 D8 is why this is embedded rather than read off disk.

/**
 * The skill directory names — their addresses in a harness's skills root.
 *
 * Two of them since #303, and the order here is the order an installer reports
 * them in. A name is data: nothing downstream may branch on which one it is
 * holding, because the difference between the two roles is prose inside the
 * files and not behaviour in the writer (ADR 0035 D1).
 */
export const ORCHESTRATION_SKILL_NAMES: readonly string[] = [${SKILL_NAMES.map((name) => JSON.stringify(name)).join(", ")}];

/**
 * The in-band marker that makes a copy ours (ADR 0031 D1).
 *
 * The authorisation to overwrite, and the operator's escape hatch: delete this
 * line from a copy and the installer never touches that file again. It is
 * matched as a substring of a file's first bytes rather than as a parsed key,
 * which is why the same marker works in \`SKILL.md\`'s frontmatter and in a
 * shell script's second line.
 */
export const ORCHESTRATION_SKILL_MARKER = ${JSON.stringify(MARKER)};

/**
 * The authored skill folders, byte for byte: folder name to the folder's own
 * map of folder-relative path to contents.
 *
 * Inner keys are \`/\`-separated on every platform — the installer splits them
 * before joining. Every value carries the marker above; the generator refuses to
 * emit one that does not.
 *
 * Typed as plain records rather than left to infer their literal keys: a folder
 * name or a file name in here is data the installer is handed, never an
 * identifier anything branches on, and a type that made \`"SKILL.md"\` or
 * \`"actana-subagent"\` special would be the first step towards code that treats
 * it that way.
 */
export const ORCHESTRATION_SKILL_FILES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
${entries}
};
`;
}

function main() {
  const folders = SKILL_NAMES.map((skillName) => ({ skillName, files: readSkillFolder(skillName) }));
  for (const { skillName, files } of folders) {
    const source = join(SKILLS_ROOT, skillName);
    if (files.length === 0) {
      throw new Error(`${source} holds no files — there is nothing to install`);
    }
    // The guard is per file, and it is the reason ADR 0031 D5's escape hatch is
    // repairable: an untagged copy on an operator's disk is one the installer
    // can never write again, so shipping one is shipping a file we have given
    // away. Every file this script emits is a managed file, so every file is
    // checked.
    for (const file of files) {
      if (file.content.includes(MARKER)) continue;
      throw new Error(
        `${source}/${file.relative} carries no ${MARKER} — an untagged copy is unrepairable`,
      );
    }
  }
  const rendered = renderPayload(folders);
  const count = folders.reduce((total, folder) => total + folder.files.length, 0);
  for (const target of TARGETS) {
    writeFileSync(join(repoRoot, target), rendered, "utf8");
    process.stdout.write(
      `wrote ${target} (${folders.length} skills, ${count} file${count === 1 ? "" : "s"})\n`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
