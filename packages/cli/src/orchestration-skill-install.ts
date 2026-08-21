// Writing the product's own agent skill into an operator's home (ADR 0031).
//
// **This file exists twice, byte for byte**, here and at
// `packages/cli/src/orchestration-skill-install.ts`. The skill is written to
// disk by two different programs on two different machines — the CLI writes to
// the laptop it is installed on, the Core writes to the Core's machine, which
// for a remote Core is somewhere else entirely — so the payload it writes is
// embedded in two bundles either way.
//
// **The copy is a convenience now, not a workaround.** The rule that used to
// force it — *`@actana/cli` may not import `@actana/shared`* (ADR 0025 D4) — was
// superseded by ADR 0032 D5 (#288): the CLI may import this package, because it
// is *inlined* into the published bundle rather than resolved from it, and an
// inlined bundle offers no surface for a stranger to depend on. ADR 0031 D8
// carries a note recording exactly that, and keeping this arrangement anyway:
// one authored source plus a drift test is still the cheapest way to hold two
// embedded payloads together. The other half of the old argument is unchanged —
// `@actana/core` may import only two named modules from `@actana/sdk` (ADR 0025
// D2 as amended by #224), and a skill payload is neither protocol nor client.
//
// So the copies are kept honest by a test rather than by memory. There is one
// such test and it lives in one package:
// `packages/shared/src/__tests__/orchestration-skill-fanout.test.ts` reads both
// files and fails on the first differing byte. One assertion in one place is the
// point — a second copy in `packages/cli` would be another thing to keep in
// step. Edit one file, run the `shared` suite, copy it across. That is the same
// arrangement ADR 0025 D3 permits and `registration-blob-file.ts` already lives
// under.
//
// Everything below is a filesystem write and nothing else. No process is
// started (#129 D9), no vendor CLI is invoked, no network is touched — which is
// what makes it safe to run in front of every `actana` verb.
//
// Three rules, and they are ADR 0031's:
//
//  - **Only where the harness already lives.** A harness whose own home
//    directory does not exist is one this operator does not use here, and
//    creating `~/.claude` on a machine that has never run Claude Code would be
//    a larger act than anything ADR 0006 refused (D4).
//  - **Only what we wrote.** `x-actana-managed: true` in the file's frontmatter
//    is what authorises a write, not the path (D1). A file sitting at our path
//    without the marker is an operator's, and is neither written nor deleted.
//  - **A managed copy is replaced, edits and all** (D5). The escape hatch is
//    deleting the marker line, and the skill's own text says so.
//
// **A skill is a folder of files, not a file** (#304, ADR 0035 D4). The request
// carries a map of folder-relative path to bytes — `SKILL.md` is one entry,
// `await.sh` is another — and every rule above applies per file rather than per
// folder: the marker authorises each write on its own, and an operator who
// deletes the marker line from one file keeps that file and goes on receiving
// the others.
//
// The marker mechanism needed no change to carry a shell script. D1 chose a
// **substring of the file's first bytes** over a YAML parser precisely so that
// recognising our own writes could not be taken away by somebody else's loader
// (`docs/adr/0031-…:127-131`), and `# x-actana-managed: true` on line 2 of a
// script — under the shebang — satisfies that reader exactly as a frontmatter
// key does.
//
// **Nothing here sets an executable bit.** `writeOneCopy` writes with no mode,
// so a script lands non-executable and is invoked as `bash await.sh`. That is a
// decision and not an omission: the safety argument for running this in front
// of every verb is that it is *a filesystem write and nothing else*, and a
// write that also flips a permission bit is a slightly larger act for no gain —
// the shipped script names its own interpreter and costs nothing to invoke that
// way.

import * as fs from "node:fs";
import * as path from "node:path";

/** One harness's answer to "where does a global skill go, and are you here?" */
export type SkillInstallTarget = {
  /** The harness id this row is for. Reported back, never interpreted. */
  harness: string;
  /** Only `skill-dir` exists today; an unknown kind is reported, not guessed at. */
  kind: string;
  /** Home-relative directories, `/`-separated. Any one existing means "here". */
  homeMarkers: readonly string[];
  /** Home-relative directory holding one directory per skill, `/`-separated. */
  skillDir: string;
};

/**
 * What happened to one harness's copy.
 *
 * `absent` and `skipped` are both successes and are deliberately distinct: the
 * first is "you do not use this harness", the second is "you own that file
 * now", and an operator debugging a missing skill needs to know which.
 *
 * **One outcome for a folder of several files, and it is the worst one.** A
 * folder's files are decided one at a time and then folded, in this order:
 *
 *  - `failed` — **any** file could not be read or written. It wins outright
 *    because it is the only outcome that is a fault, and `detail` names the
 *    file: "one of them broke" is unactionable without knowing which.
 *  - `skipped` — **any** managed-path file is there without the marker. The
 *    operator took that one file; `detail` names it, because the others were
 *    still written and "skipped" alone would read as "you got nothing".
 *  - `written` — at least one file was written and none failed or was skipped.
 *  - `current` — **every** file matched, byte for byte. Deliberately the last
 *    clause rather than the first: an operator reading `current` must not be
 *    reading it because one of two files happened to match.
 *
 * The fold is total on purpose. A folder whose payload carries no files at all
 * is `failed`, not `current` — nothing was checked, and reporting "up to date"
 * for a folder nobody looked in is the failure this ordering exists to rule out.
 */
export type SkillInstallOutcome = "written" | "current" | "absent" | "skipped" | "failed";

export type SkillInstallEntry = {
  harness: string;
  outcome: SkillInstallOutcome;
  /**
   * The skill **folder** this harness reads, whether or not anything was
   * written — not a file inside it.
   *
   * The folder, and not the list of files, because of who reads this. It is
   * printed by `actana harness skills [--json]` to an operator asking "why has
   * my harness not got the skill?", and the next thing that operator does is
   * look: `ls` takes a directory, and a directory is one line whether the skill
   * is one file or three. A list of files would answer a question nobody asked
   * — the payload's contents are ours and change release to release — and would
   * make the common `absent` row, where no file exists to list, the awkward
   * case.
   *
   * Which file went wrong is not lost, it moves: `detail` names it, which is
   * where "why" already lived and is printed beside this row.
   */
  path: string;
  /** Why, for the outcomes where "why" is the whole content. Names the file. */
  detail?: string;
};

export type SkillInstallRequest = {
  /** The operator's home directory. Injected, never read from the environment. */
  home: string;
  targets: readonly SkillInstallTarget[];
  /** The skill's directory name — the address, not the authorisation (D1). */
  skillName: string;
  /** The in-band marker that makes a file ours (D1). Matched as a substring. */
  marker: string;
  /**
   * Every file in the skill folder: folder-relative path to its bytes.
   *
   * Keys are `/`-separated whatever the platform, exactly as the generator
   * emits them, and are split on `/` before being joined — the same idiom
   * `homePath` uses for `skillDir`. `"SKILL.md"` is one entry and `"await.sh"`
   * is another; the installer neither knows nor cares which is which.
   */
  files: Readonly<Record<string, string>>;
};

/** How much of a file is read looking for the marker. Frontmatter is at the top. */
const MARKER_SCAN_BYTES = 4096;

function homePath(home: string, relative: string): string {
  return path.join(home, ...relative.split("/"));
}

function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Is this harness on this machine?
 *
 * A filesystem question because it is the only kind available: the installer
 * starts no process, so it cannot ask a vendor's CLI. The marker directories
 * are the vendor's own (`~/.codex`, `~/.cursor`), never the shared skills root
 * — `~/.agents/skills` existing says somebody uses some agent, which is not the
 * question.
 */
function harnessIsPresent(home: string, target: SkillInstallTarget): boolean {
  return target.homeMarkers.some((marker) => directoryExists(homePath(home, marker)));
}

/**
 * Decide what one file needs, and do it.
 *
 * Split out from the fan-out so the decision — the whole of ADR 0031 D1 and D5
 * — is readable in one screen and testable without a home directory full of
 * harnesses.
 */
function writeOneCopy(
  file: string,
  content: string,
  marker: string,
): { outcome: SkillInstallOutcome; detail?: string } {
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // A file we cannot read is a file we must not clobber — the same rule
      // `readJsonSettingsFile` holds for the workspace hook files, and for the
      // same reason: a permissions error is not permission.
      return { outcome: "failed", detail: `could not be read (${code ?? "unknown error"})` };
    }
  }

  if (existing !== null) {
    if (existing === content) return { outcome: "current" };
    if (!existing.slice(0, MARKER_SCAN_BYTES).includes(marker)) {
      return {
        outcome: "skipped",
        detail: "a file is already there without the managed marker — it is yours, and was left alone",
      };
    }
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { outcome: "failed", detail: `could not be written (${code ?? "unknown error"})` };
  }
  return {
    outcome: "written",
    detail: existing === null ? undefined : "a managed copy had been changed, and was replaced",
  };
}

/**
 * Is this map key a name inside the skill folder, and only inside it?
 *
 * The old installer joined the literal `"SKILL.md"` and could not address
 * anything else. A map of keys can, so the constraint that used to be a
 * property of the code is now a check: no absolute path, no `..` segment, no
 * empty segment, no backslash — the keys are `/`-separated by contract, and a
 * backslash in one would mean something different on each platform.
 *
 * Ours are generated from a `readdir` of our own folder and can never fail
 * this. It is here for the caller that is not us: an installer that can be
 * talked into writing outside the directory it names is a different and much
 * worse thing than the one ADR 0031 argued for.
 */
function isInsideFolder(relative: string): boolean {
  if (relative.length === 0 || relative.includes("\\")) return false;
  return relative.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

/**
 * Decide what one folder needs, file by file, and fold the answers into one.
 *
 * The loop is the whole of the multi-file change: `writeOneCopy` is unchanged
 * and is called once per entry, so every clause of D1 and D5 is still decided
 * per file. What is new is the fold, and it is written out rather than reduced
 * to a `Math.max` over a rank because the ordering is a documented promise —
 * see {@link SkillInstallOutcome}.
 *
 * Entries are sorted by path so a report is stable run to run. The generator
 * already emits them sorted; a caller that builds the map by hand should not
 * have to know that.
 */
function writeOneFolder(
  folder: string,
  files: Readonly<Record<string, string>>,
  marker: string,
): { outcome: SkillInstallOutcome; detail?: string } {
  const results = Object.keys(files)
    .sort()
    .map((relative) =>
      isInsideFolder(relative)
        ? {
            relative,
            ...writeOneCopy(path.join(folder, ...relative.split("/")), files[relative]!, marker),
          }
        : {
            relative,
            outcome: "failed" as SkillInstallOutcome,
            detail: "is not a path inside the skill folder, and was not written",
          },
    );

  if (results.length === 0) {
    return { outcome: "failed", detail: "this build carried no files for this skill" };
  }

  for (const outcome of ["failed", "skipped", "written"] as const) {
    const hit = results.filter((result) => result.outcome === outcome);
    if (hit.length === 0) continue;
    // Only the files that had something to say. A fresh write has no detail,
    // and a folder of three fresh writes should not print two empty clauses.
    const said = hit.filter((result) => result.detail !== undefined);
    if (said.length === 0) return { outcome };
    return {
      outcome,
      detail: said.map((result) => `${result.relative} ${result.detail}`).join("; "),
    };
  }
  return { outcome: "current" };
}

/**
 * Put the skill where every harness present on this machine will read it.
 *
 * Idempotent by construction: a run that finds every copy current writes
 * nothing and reports `current` for each. Never throws — every failure is an
 * entry in the returned list, because this runs in front of unrelated `actana`
 * verbs and a skill that could not be written must not cost the operator the
 * command they actually typed (ADR 0031 D6).
 *
 * **One pass per directory, one entry per harness.** Three of the four
 * harnesses read the same global root, so a fan-out that wrote per harness
 * would write the same bytes three times and race itself; the entries still
 * name every harness, because "which of my agents has this?" is the question
 * being answered. The dedup is on the **folder**, which is what makes a
 * multi-file payload cost N writes per directory and not N×3 — the arithmetic
 * the folder key holds down as the payload grows.
 */
export function installOrchestrationSkill(request: SkillInstallRequest): SkillInstallEntry[] {
  const { home, targets, skillName, marker, files } = request;

  const folderFor = new Map<string, string>();
  const presentByFolder = new Map<string, boolean>();

  for (const target of targets) {
    if (target.kind !== "skill-dir") continue;
    const folder = path.join(homePath(home, target.skillDir), skillName);
    folderFor.set(target.harness, folder);
    presentByFolder.set(folder, (presentByFolder.get(folder) ?? false) || harnessIsPresent(home, target));
  }

  const doneByFolder = new Map<string, { outcome: SkillInstallOutcome; detail?: string }>();
  for (const [folder, present] of presentByFolder) {
    if (present) doneByFolder.set(folder, writeOneFolder(folder, files, marker));
  }

  return targets.map((target) => {
    const folder = folderFor.get(target.harness);
    if (folder === undefined) {
      return {
        harness: target.harness,
        outcome: "skipped" as const,
        path: "",
        detail: `this build has no writer for a "${target.kind}" extension point`,
      };
    }
    if (!harnessIsPresent(home, target)) {
      return {
        harness: target.harness,
        outcome: "absent" as const,
        path: folder,
        detail: "this harness has no directory of its own here",
      };
    }
    const done = doneByFolder.get(folder) ?? { outcome: "failed" as const, detail: "not attempted" };
    return done.detail === undefined
      ? { harness: target.harness, outcome: done.outcome, path: folder }
      : { harness: target.harness, outcome: done.outcome, path: folder, detail: done.detail };
  });
}
