// The CLI's half of ADR 0031: put the product's skill where the operator's
// Harnesses will read it, on the machine this CLI is installed on.
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
  ORCHESTRATION_SKILL_MD,
  ORCHESTRATION_SKILL_NAME,
} from "./orchestration-skill-payload.ts";
import { HARNESS_SKILL_TARGETS } from "./harness-skill-targets.ts";

/** Write or repair every copy, and report one row per Harness. Never throws. */
export function ensureOrchestrationSkill(home: string): SkillInstallEntry[] {
  return installOrchestrationSkill({
    home,
    targets: HARNESS_SKILL_TARGETS,
    skillName: ORCHESTRATION_SKILL_NAME,
    marker: ORCHESTRATION_SKILL_MARKER,
    content: ORCHESTRATION_SKILL_MD,
  });
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
