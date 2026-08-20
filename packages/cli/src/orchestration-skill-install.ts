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
 */
export type SkillInstallOutcome = "written" | "current" | "absent" | "skipped" | "failed";

export type SkillInstallEntry = {
  harness: string;
  outcome: SkillInstallOutcome;
  /** The `SKILL.md` this harness reads, whether or not it was written. */
  path: string;
  /** Why, for the outcomes where "why" is the whole content. */
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
  /** The `SKILL.md` bytes, exactly as they should sit on disk. */
  content: string;
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
 * Put the skill where every harness present on this machine will read it.
 *
 * Idempotent by construction: a run that finds every copy current writes
 * nothing and reports `current` for each. Never throws — every failure is an
 * entry in the returned list, because this runs in front of unrelated `actana`
 * verbs and a skill that could not be written must not cost the operator the
 * command they actually typed (ADR 0031 D6).
 *
 * **One write per directory, one entry per harness.** Three of the four
 * harnesses read the same global root, so a fan-out that wrote per harness
 * would write the same bytes three times and race itself; the entries still
 * name every harness, because "which of my agents has this?" is the question
 * being answered.
 */
export function installOrchestrationSkill(request: SkillInstallRequest): SkillInstallEntry[] {
  const { home, targets, skillName, marker, content } = request;

  const fileFor = new Map<string, string>();
  const presentByFile = new Map<string, boolean>();

  for (const target of targets) {
    if (target.kind !== "skill-dir") continue;
    const file = path.join(homePath(home, target.skillDir), skillName, "SKILL.md");
    fileFor.set(target.harness, file);
    presentByFile.set(file, (presentByFile.get(file) ?? false) || harnessIsPresent(home, target));
  }

  const doneByFile = new Map<string, { outcome: SkillInstallOutcome; detail?: string }>();
  for (const [file, present] of presentByFile) {
    if (present) doneByFile.set(file, writeOneCopy(file, content, marker));
  }

  return targets.map((target) => {
    const file = fileFor.get(target.harness);
    if (file === undefined) {
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
        path: file,
        detail: "this harness has no directory of its own here",
      };
    }
    const done = doneByFile.get(file) ?? { outcome: "failed" as const, detail: "not attempted" };
    return done.detail === undefined
      ? { harness: target.harness, outcome: done.outcome, path: file }
      : { harness: target.harness, outcome: done.outcome, path: file, detail: done.detail };
  });
}
