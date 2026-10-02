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
// The writer itself is `@actana/shared/orchestration-skill-install`. The payload it
// writes is the published one: imported from the root of the pinned `@actana/cli`, the
// same constants the client nouns install from, so there is one payload source and a
// Core's boot install and its `actana` cannot disagree about the text (#580). This file
// is the Core's side of the seam: it supplies the home directory, reads the fan-out
// table off `HARNESS_CLI_CONFIG`, and turns the result into log lines.

import * as path from "node:path";
import log from "@actana/shared/log";
import { HARNESS_SKILL_TARGETS } from "@actana/shared/harness-cli-config";
import { withPiHomeMarkersResolved } from "@actana/shared/pi-agent-dir";
import { sanitizedProcessEnv } from "@actana/shared/shell-env";
import {
  installOrchestrationSkill,
  type SkillInstallEntry,
} from "@actana/shared/orchestration-skill-install";
import type * as ActanaCli from "@actana/cli";

/**
 * The published payload, loaded the first time something asks for it.
 *
 * The root of `@actana/cli` is the whole client, and it brings `ws` and the Core-link code with it. The
 * `core-home-ops` helper bundle imports this module and is a short-lived process per request, started with
 * no `node_modules` of its own to count on, and most of its operations never touch the skill. A top-level
 * import would load all of that for every one of them (and fail where `ws` is not beside the bundle), so
 * the payload is required at the call that needs it. Still one source: the same root export the client
 * nouns install from, never a copy.
 */
let published: typeof ActanaCli | undefined;
function payload(): typeof ActanaCli {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  published ??= require("@actana/cli") as typeof ActanaCli;
  return published;
}

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
    entries = installOrchestrationSkills(homeDir);
  } catch (err) {
    log.warn("core-skill.install-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  reportSkillEntries(entries);
  return entries;
}

/**
 * Every Harness skill folder `installOrchestrationSkills` may write under
 * `homeDir`, resolved the way it resolves them. The helper confines each through
 * `realpath` first, so a linked `~/.claude/skills` cannot carry the write out of
 * the home.
 */
export function orchestrationSkillFolders(homeDir: string): string[] {
  const targets = withPiHomeMarkersResolved(HARNESS_SKILL_TARGETS, sanitizedProcessEnv(), homeDir);
  return targets.flatMap((target) =>
    payload().ORCHESTRATION_SKILL_NAMES.map((name) =>
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
  const { ORCHESTRATION_SKILL_NAMES, ORCHESTRATION_SKILL_MARKER, ORCHESTRATION_SKILL_FILES } = payload();
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
