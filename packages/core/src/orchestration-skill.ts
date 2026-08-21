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

import log from "@actana/shared/log";
import { HARNESS_SKILL_TARGETS } from "@actana/shared/harness-cli-config";
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
 * Write or repair every copy on this machine, and log what happened.
 *
 * Never throws, and deliberately so: this runs on the boot path, and a Core
 * that refused to start because it could not write a skill folder into a
 * directory it does not own would be trading a documented capability for the
 * whole product.
 *
 * Only the interesting outcomes are logged. `absent` is the ordinary state of a
 * Core with two of the four Harnesses installed and would be three lines of
 * noise on every boot; `current` is the ordinary state of every boot after the
 * first. What gets a line is a write, a refusal and a failure — the three
 * things a "why has my Harness not got the skill?" report is answered from.
 *
 * `entry.path` is the skill **folder**, not a file in it, and `entry.detail`
 * names the file when one of several went wrong — so a log line still says
 * enough to act on without this file learning what the payload contains.
 *
 * **Two skills since #303, so one entry per harness per skill.** The loop is
 * the whole of that: the installer is called once per folder name and the
 * results are concatenated, because the two folders differ in the prose inside
 * them and in nothing a writer can see (ADR 0035 D1). `entry.path` is what tells
 * two rows for one harness apart, and it already named the folder.
 */
export function ensureOrchestrationSkill(homeDir: string): SkillInstallEntry[] {
  let entries: SkillInstallEntry[];
  try {
    entries = ORCHESTRATION_SKILL_NAMES.flatMap((skillName) =>
      installOrchestrationSkill({
        home: homeDir,
        targets: HARNESS_SKILL_TARGETS,
        skillName,
        marker: ORCHESTRATION_SKILL_MARKER,
        files: ORCHESTRATION_SKILL_FILES[skillName] ?? {},
      }),
    );
  } catch (err) {
    log.warn("core-skill.install-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

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
  return entries;
}
