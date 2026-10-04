// A lint-style guard for issue 559, PR 3: the daemon-side modules never touch
// core's home themselves.
//
// Everything the daemon does in core's home is a request to the helper
// (`core-home-ops-client.ts`). One `fs.writeFileSync(path.join(coreHome(), …))`
// added to a daemon-side module later is the same bug PR 3 fixes, and in the
// container it fails with EACCES only after the image switches users. This reads
// the source. The detectors are tried on known-bad text first, so a guard that
// stopped matching anything would fail here rather than pass.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");

/**
 * The daemon's side: the modules that used to call `fs` on core's home, and the
 * client they call the helper through. Not `harness-hooks*.ts`, `orchestration-skill.ts` or
 * `core-home-ops.ts`: those are the helper's code, and run in the helper (or in process
 * outside the container).
 */
const DAEMON_SIDE = ["pty-manager.ts", "core-entry.ts", "core-exec.ts", "core-self-register.ts", "core-home-ops-client.ts"];

/** The writers and readers that belong to the helper. A daemon-side module may not import one. */
const HELPER_ONLY = [
  "installHarnessHooks",
  "installPiHooks",
  "installOpencodeHooks",
  "ensureStatuslineTap",
  "ensureStatuslineTapScript",
  "installManagedStatusLine",
  "ensureOrchestrationSkill",
  "installOrchestrationSkills",
  "resolveAllHarnessCommandsOnPath",
  "wireLocalCore",
  "registryPaths",
  "pretrustWorkspaces",
  "trustClaudeCode",
  "trustCodex",
];

function code(file: string): string {
  return fs
    .readFileSync(path.join(SRC, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every `fs` import and every call through one. */
export function fsUses(text: string): string[] {
  return [
    ...text.matchAll(/from\s+["'](?:node:)?fs(?:\/promises)?["']/g),
    ...text.matchAll(/require\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/g),
    ...text.matchAll(/\b(?:fs|fsp)(?:\.promises)?\.\w+\s*\(/g),
  ].map((m) => m[0]);
}

/** The names a file imports, from any module. */
export function importedNames(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/g)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe("the detectors", () => {
  it("see an fs import and an fs call on a home path", () => {
    expect(fsUses('import * as fs from "node:fs";')).toHaveLength(1);
    expect(fsUses('import { mkdirSync } from "fs";')).toHaveLength(1);
    expect(fsUses('fs.writeFileSync(path.join(coreHome(), ".claude", "s.json"), x); await fsp.readFile(p); fs.promises.stat(p)')).toHaveLength(3);
    expect(fsUses('const fs = require("node:fs")')).toHaveLength(1);
  });

  it("leave a request to the helper alone", () => {
    expect(fsUses("await installHarnessHooksViaCore(agent, cwd, env); offsets.push(x)")).toEqual([]);
  });

  it("read imported names, type imports and aliases included", () => {
    expect(importedNames('import { a, type B, c as d } from "./x"; import type { E } from "./y";')).toEqual(["a", "B", "c", "E"]);
  });
});

describe("the daemon-side modules do not touch core's home", () => {
  it("finds the modules it is meant to guard", () => {
    for (const file of DAEMON_SIDE) expect(fs.existsSync(path.join(SRC, file)), file).toBe(true);
  });

  it.each(DAEMON_SIDE)("%s imports no fs and calls none", (file) => {
    expect(fsUses(code(file))).toEqual([]);
  });

  it.each(DAEMON_SIDE)("%s imports no writer that belongs to the helper", (file) => {
    const imported = importedNames(code(file));
    expect(imported.filter((name) => HELPER_ONLY.includes(name))).toEqual([]);
  });

  it("only the client and the helper's own entry import the helper's operations module", () => {
    const importers = fs
      .readdirSync(SRC)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /from\s+["']\.\/core-home-ops["']/.test(fs.readFileSync(path.join(SRC, f), "utf8")))
      .sort();
    expect(importers).toEqual(["core-home-ops-client.ts", "core-home-ops-main.ts"]);
  });

  it("the client never waits on the helper synchronously: a sync wait cannot be bounded against a process the daemon cannot signal", () => {
    expect(code("core-home-ops-client.ts")).not.toMatch(/spawnSync|execFileSync|execSync|coreHomeOpSync|runSync/);
  });

  it("the daemon still reaches each thing through the client", () => {
    const wired: Record<string, string[]> = {
      "pty-manager.ts": [
        "ensureClaudeShiftEnterBindingViaCore",
        "ensureStatuslineTapViaCore",
        "installHarnessHooksViaCore",
        "resolveCommandViaCore",
        "spawnPathFactsViaCore",
      ],
      "core-entry.ts": ["ensureOrchestrationSkillViaCore"],
      "core-exec.ts": ["resolveExecCwdViaCore"],
      "core-self-register.ts": ["wireLocalCoreViaCore"],
    };
    for (const [file, names] of Object.entries(wired)) {
      expect(importedNames(code(file)).filter((n) => names.includes(n)).sort(), file).toEqual([...names].sort());
    }
  });
});
