// The Core's half of ADR 0031: put the product's skills where this machine's
// Harnesses will read them.
//
// The Core's machine is the one that matters most, because it is where the
// Harnesses actually run — CONTEXT.md's rule is that CLI availability is
// Core-published state, and a remote Core's Harnesses are nowhere near the
// laptop the operator typed on. Two triggers reach here: Core boot, and a
// Harness this Core had not seen before becoming available
// (`harness-skill-watcher.ts`).
//
// The writer itself is `@actana/shared/orchestration-skill-install`, which is a
// byte-identical twin of a file in `packages/cli` because those two packages
// may not share a module (ADR 0031 D8). This file is the Core's side of the
// seam: it supplies the home directory, reads the fan-out table off
// `HARNESS_CLI_CONFIG`, and turns the result into log lines.

import * as path from "node:path";
import log from "@actana/shared/log";
import { HARNESS_SKILL_TARGETS } from "@actana/shared/harness-cli-config";
import { withPiHomeMarkersResolved } from "@actana/shared/pi-agent-dir";
import { sanitizedProcessEnv } from "@actana/shared/shell-env";
import {
  installOrchestrationSkill,
  type SkillInstallEntry,
} from "@actana/shared/orchestration-skill-install";
import {
  ORCHESTRATION_SKILL_MARKER,
  ORCHESTRATION_SKILL_FILES,
  ORCHESTRATION_SKILL_NAMES,
} from "@actana/shared/orchestration-skill-payload";

/**
 * Every Harness skill folder `installOrchestrationSkills` may write under
 * `homeDir`, resolved the way it resolves them. The helper confines each through
 * `realpath` first, so a linked `~/.claude/skills` cannot carry the write out of
 * the home.
 */
export function orchestrationSkillFolders(homeDir: string): string[] {
  const targets = withPiHomeMarkersResolved(HARNESS_SKILL_TARGETS, sanitizedProcessEnv(), homeDir);
  return targets.flatMap((target) =>
    ORCHESTRATION_SKILL_NAMES.map((name) =>
      // An absolute skillDir stays absolute, as the installer's own `homePath` has it.
      path.isAbsolute(target.skillDir)
        ? path.join(target.skillDir, name)
        : path.join(homeDir, ...target.skillDir.split("/"), name),
    ),
  );
}

/**
 * The install itself, with no logging: the half that touches `homeDir`. It is
 * what `core-home-ops` runs as `core` in the container (issue 559), where the
 * daemon reads the entries back and calls {@link reportSkillEntries} itself.
 * Throws when the install cannot run at all.
 */
export function installOrchestrationSkills(homeDir: string): SkillInstallEntry[] {
  // Pi's `$PI_CODING_AGENT_DIR` is resolved here against the sanitized
  // process env (login-shell overlay included), never frozen from
  // `process.env` at module load in the shared table (#518 part 3).
  const targets = withPiHomeMarkersResolved(HARNESS_SKILL_TARGETS, sanitizedProcessEnv(), homeDir);
  return ORCHESTRATION_SKILL_NAMES.flatMap((skillName) =>
    installOrchestrationSkill({
      home: homeDir,
      targets,
      skillName,
      marker: ORCHESTRATION_SKILL_MARKER,
      files: ORCHESTRATION_SKILL_FILES[skillName] ?? {},
    }),
  );
}

/** One log line per write, refusal or failure; `current` is silent (see above). */
export function reportSkillEntries(entries: readonly SkillInstallEntry[]): void {
  for (const entry of entries) {
    if (entry.outcome === "written") {
      log.info("core-skill.written", { harness: entry.harness, path: entry.path });
    } else if (entry.outcome === "skipped") {
      log.info("core-skill.skipped", {
        harness: entry.harness,
        path: entry.path,
        reason: entry.detail ?? "not ours",
      });
    } else if (entry.outcome === "failed") {
      log.warn("core-skill.failed", {
        harness: entry.harness,
        path: entry.path,
        reason: entry.detail ?? "unknown",
      });
    }
  }
}
