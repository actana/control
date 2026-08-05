// The skip-permissions pair (issue 22).
//
// Auto-mode is unconditional: no checkbox, no project field, no task column
// feeds it. Two independent things still have to agree about it — the command
// builder, which puts the argument in the command string, and the spawn
// descriptor, which declares the intent the spawn policy checks that argument
// against. The policy treats the argument as gated on the declared intent, so
// if only one side is switched, `resolveSpawnPlan` rejects and *no session
// spawns at all*.
//
// These tests drive the real policy (not a stand-in) with both sides derived
// the way the app derives them, so changing either side alone fails here.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Task } from "~/db/schema";
import type { Harness } from "@actana/shared/domain";
import {
  HARNESS_REGISTRY,
  harnessLaunchesWithSkipPermissions,
} from "@actana/shared/harnesses";
import {
  resolveSpawnPlan,
  type SpawnPolicyDeps,
  type SpawnRequest,
} from "@actana/shared/pty-spawn-policy";
import { buildFreshHarnessLaunchCommand } from "../harness-command";

const PROJECT_ROOT = "/Users/me/code/myproject";
const SESSION_ID = "00000000-0000-4000-8000-000000000000";

const HARNESSES = Object.keys(HARNESS_REGISTRY) as Harness[];

function policyDeps(): SpawnPolicyDeps {
  return {
    cwdExists: () => true,
    realpath: (p) => p,
    projectRoots: () => [PROJECT_ROOT],
    resolveCommand: (name) => `/usr/local/bin/${name}`,
    resolveShell: () => ({
      shell: "/bin/zsh",
      shellArgs: (cmd) => (cmd ? ["-l", "-c", cmd] : ["-l"]),
    }),
  };
}

function taskFor(agent: Harness): Task {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Task",
    titleManuallySet: false,
    icon: null,
    agent,
    status: "ready",
    branch: "main",
    preview: "",
    lines: 0,
    archived: false,
    pinned: false,
    claudeSessionId: SESSION_ID,
    // Deliberately false — the launch path must not read this column. A Core
    // never writes it (the task mutation frame does not carry it), so every
    // Core-owned session reaches the builder with exactly this value.
    claudeSkipPermissions: false,
    claudeBareSession: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** How the app spawns: the built command plus the descriptor's declared intent. */
function spawnRequestFor(agent: Harness): SpawnRequest {
  const task = taskFor(agent);
  return {
    taskId: task.id,
    cwd: PROJECT_ROOT,
    command: buildFreshHarnessLaunchCommand(task, SESSION_ID),
    agent,
    dangerouslySkipPermissions: harnessLaunchesWithSkipPermissions(agent),
  } as SpawnRequest;
}

describe("skip permissions on a newly created session", () => {
  it.each(HARNESSES.filter((a) => HARNESS_REGISTRY[a].supportsSkipPermissions))(
    "%s launches with its skip-permissions flag with no user action",
    (agent) => {
      const flag = HARNESS_REGISTRY[agent].skipPermissionsFlag!;
      const req = spawnRequestFor(agent) as { command: string };
      expect(req.command).toContain(flag);
    },
  );

  it.each(HARNESSES.filter((a) => !HARNESS_REGISTRY[a].supportsSkipPermissions))(
    "%s launches unchanged, with no unsupported argument",
    (agent) => {
      const req = spawnRequestFor(agent) as {
        command: string;
        dangerouslySkipPermissions?: boolean;
      };
      expect(req.dangerouslySkipPermissions).toBe(false);
      for (const meta of Object.values(HARNESS_REGISTRY)) {
        if (meta.skipPermissionsFlag) expect(req.command).not.toContain(meta.skipPermissionsFlag);
      }
    },
  );

  it.each(HARNESSES)("%s spawn is accepted by the policy — the two sides agree", (agent) => {
    const plan = resolveSpawnPlan(spawnRequestFor(agent), policyDeps());
    if (plan.mode !== "agent") throw new Error("expected an agent spawn plan");
    const flag = HARNESS_REGISTRY[agent].skipPermissionsFlag;
    if (flag) expect(plan.argv).toContain(flag);
  });

  // The pin. Either side moving alone breaks this equality: drop the flag from
  // the builder and the left side goes false while the right stays true; stop
  // declaring it on the descriptor and the reverse. Only changing both together
  // — which is the only safe way to change it — keeps this green.
  it.each(HARNESSES)("%s: argv flag and declared intent move together", (agent) => {
    const req = spawnRequestFor(agent) as {
      command: string;
      dangerouslySkipPermissions?: boolean;
    };
    const flag = HARNESS_REGISTRY[agent].skipPermissionsFlag;
    const argvHasFlag = !!flag && req.command.split(" ").includes(flag);
    expect(argvHasFlag).toBe(!!req.dangerouslySkipPermissions);
  });

  // The equality above proves the two derivations agree, but it builds the
  // descriptor side itself — it cannot see whether the real spawn sites still
  // use the shared helper. This does: every `dangerouslySkipPermissions` a
  // spawn descriptor is built with must come from it. Reverting any one site to
  // the task column (which a Core never writes, so it is permanently false)
  // rejects that spawn at the policy and starts no session — the failure
  // Refinement 2 asked to be pinned, and the one the equality test misses.
  it.each([
    "src/lib/terminal-store.tsx",
    "src/lib/session-warm-pool.ts",
  ])("%s builds every spawn descriptor from the shared helper", (file) => {
    const source = readFileSync(resolve(import.meta.dirname, "../../..", file), "utf8");
    const assignments = [...source.matchAll(/dangerouslySkipPermissions:\s*([^,\n]+)/g)].map(
      (m) => m[1]!.trim(),
    );
    expect(assignments.length).toBeGreaterThan(0);
    let decisions = 0;
    for (const rhs of assignments) {
      // Type positions (`dangerouslySkipPermissions: boolean;`) declare the
      // field rather than fill it.
      if (/^(boolean|never)\b/.test(rhs)) continue;
      // `s.dangerouslySkipPermissions` / `entry.dangerouslySkipPermissions`
      // carry an already-derived value between store records; only the sites
      // that *decide* the value are in scope.
      if (/^[A-Za-z_$][\w$]*\.dangerouslySkipPermissions$/.test(rhs)) continue;
      decisions += 1;
      expect(rhs).toMatch(/^harnessLaunchesWithSkipPermissions\(/);
    }
    expect(decisions).toBeGreaterThan(0);
  });

  it("no launch path reads the task's skip-permissions column", () => {
    // The column stays on the row and on the optimistic/draft task shapes, but
    // nothing that builds a command or a descriptor may read it back.
    for (const file of ["src/lib/harness-command.ts", "src/lib/terminal-store.tsx"]) {
      const source = readFileSync(resolve(import.meta.dirname, "../../..", file), "utf8");
      const reads = [...source.matchAll(/[\w.]*\bclaudeSkipPermissions\b(?!\s*:)/g)];
      expect(reads.map((m) => m[0])).toEqual([]);
    }
  });

  it("would reject a spawn whose argv carries a flag the request never declared", () => {
    // The consistency check the pair depends on is real, not dead code: the
    // policy rejects an argument that was never declared. Kept as a defense
    // against argument injection — auto-mode passes it on its own merits.
    const req = {
      ...(spawnRequestFor("claude-code") as object),
      dangerouslySkipPermissions: false,
    } as SpawnRequest;
    expect(() => resolveSpawnPlan(req, policyDeps())).toThrow(/unsupported/);
  });
});
