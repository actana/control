// The CLI's half of ADR 0031: put the product's skills where the operator's
// Harnesses will read them, on the machine this CLI is installed on.
//
// Two callers, one function. `actana harness skills` is the explicit verb — the
// thing a support answer or a script can name — and `runActanaCli` calls the
// same function in front of every noun, because there is no npm lifecycle hook
// to install from (ADR 0031 D6: `packages/cli/package.json` has no
// `postinstall`, `preinstall` or `prepare`, and gains none). "Installed with
// the CLI" is therefore delivered one command later, by a path that is a no-op
// when the copies are current.
//
// Nothing here starts a process (#129 D9) and nothing here dials a Core: the
// skill has to land on a laptop that has no Core registered at all, which is
// exactly the machine the first acceptance criterion is about.

import {
  installOrchestrationSkill,
  type SkillInstallEntry,
} from "./orchestration-skill-install.ts";
import {
  ORCHESTRATION_SKILL_MARKER,
  ORCHESTRATION_SKILL_FILES,
  ORCHESTRATION_SKILL_NAMES,
} from "./orchestration-skill-payload.ts";
import { HARNESS_SKILL_TARGETS } from "./harness-skill-targets.ts";

/**
 * Write or repair every copy, and report one row per Harness per skill.
 *
 * A skill is a folder — `SKILL.md`, and `await.sh` for the one that ships it —
 * and there are two of them since #303. The installer is handed one folder at a
 * time and all of its files at once: nothing here knows which file is which, and
 * nothing here knows which folder is which. The two carry opposite trigger
 * requirements (ADR 0035 D1), and that difference is prose inside them rather
 * than a branch out here.
 *
 * Never throws.
 */
export function ensureOrchestrationSkill(home: string): SkillInstallEntry[] {
  return ORCHESTRATION_SKILL_NAMES.flatMap((skillName) =>
    installOrchestrationSkill({
      home,
      targets: HARNESS_SKILL_TARGETS,
      skillName,
      marker: ORCHESTRATION_SKILL_MARKER,
      files: ORCHESTRATION_SKILL_FILES[skillName] ?? {},
    }),
  );
}

/**
 * The same thing, with every failure swallowed.
 *
 * For the path that runs in front of an unrelated verb. A skill that could not
 * be written must not change the exit code of `actana core ls`, and must not
 * print anything: stdout under `--json` carries one document and nothing else,
 * and a warning on stderr for a thing the operator did not ask about is noise
 * on every single invocation. `actana harness skills` is where the report is.
 */
export function ensureOrchestrationSkillQuietly(home: string): void {
  try {
    ensureOrchestrationSkill(home);
  } catch {
    // Deliberately empty. The installer already reports its own failures as
    // entries rather than throwing; this catches the case it cannot — a home
    // directory that is not one.
  }
}
