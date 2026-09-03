// The resume commands, checked against the machine that has to accept them.
//
// `harnessResumeCommand` builds a launch command per harness, and the Core's
// spawn policy is what decides whether that command may run. A table that
// drifts from the allow-list produces a `session resume` that always fails, and
// it fails on the *Core*, where a CLI unit test would never see it — so this
// suite runs every command it builds through `resolveSpawnPlan`, the same
// function `packages/core` calls before spawning anything.
//
// Importing `@actana/shared` from a test is the arrangement `tsconfig.json` and
// `vitest.config.ts` already describe and `no-local-escape.test.ts` enforces:
// test-only, never from a shipped module.

import { describe, it, expect } from "vitest";
import {
  resolveSpawnPlan,
  type SpawnPolicyDeps,
  type SpawnRequest,
} from "@actana/shared/pty-spawn-policy";
import { harnessResumeCommand } from "../harness-resume.ts";
import { KNOWN_HARNESSES } from "../session-gateway.ts";
import type { CoreLinkPtySpawnHarness } from "@actana/sdk/core-link-frames.ts";

const PROJECT_ROOT = "/home/core/projects/web";

/** Session ids in the shape each harness actually reports one. */
const SESSION_IDS: Record<CoreLinkPtySpawnHarness, string> = {
  "claude-code": "00000000-0000-4000-8000-000000000000",
  // The Core validates a codex resume id against its model-id pattern, which a
  // UUID satisfies; a spelling it rejects is rejected there, not trimmed here.
  codex: "019d7a0f-432a-7fa1-a821-b7841f983967",
  "cursor-cli": "00000000-0000-4000-8000-000000000000",
  // OpenCode ids carry a `ses` prefix and the Core insists on it.
  opencode: "ses_01H8Z0MEXAMPLE",
};

function policyDeps(): SpawnPolicyDeps {
  return {
    cwdExists: () => true,
    realpath: (p) => p,
    projectRoots: () => [PROJECT_ROOT],
    resolveCommand: (name) => `/usr/local/bin/${name}`,
    resolveShell: () => ({ shell: "/bin/zsh", shellArgs: (cmd) => (cmd ? ["-l", "-c", cmd] : ["-l"]) }),
  };
}

function planFor(harness: CoreLinkPtySpawnHarness, command: string, skip: boolean) {
  return resolveSpawnPlan(
    {
      taskId: "t1",
      cwd: PROJECT_ROOT,
      command,
      agent: harness,
      ...(skip ? { dangerouslySkipPermissions: true } : {}),
    } as SpawnRequest,
    policyDeps(),
  );
}

describe("harnessResumeCommand", () => {
  it("spells resumption the way each harness spells it", () => {
    expect(harnessResumeCommand("claude-code", "abc")).toBe("claude --resume abc");
    // A subcommand, so it comes first — and the hooks flag stays on, or the
    // resumed Session never reports its lifecycle and every wait on it hangs.
    expect(harnessResumeCommand("codex", "abc")).toBe(
      "codex resume abc --enable hooks --dangerously-bypass-hook-trust",
    );
    expect(harnessResumeCommand("cursor-cli", "abc")).toBe("cursor-agent --resume abc");
    expect(harnessResumeCommand("opencode", "ses_abc")).toBe("opencode --session ses_abc");
  });

  it("appends each harness's own skip-permissions flag, and none for OpenCode", () => {
    const skip = { dangerouslySkipPermissions: true };
    expect(harnessResumeCommand("claude-code", "abc", skip)).toContain("--dangerously-skip-permissions");
    expect(harnessResumeCommand("codex", "abc", skip)).toContain("--yolo");
    expect(harnessResumeCommand("cursor-cli", "abc", skip)).toContain("--force");
    // OpenCode has no such flag. Inventing one would be a rejected spawn.
    expect(harnessResumeCommand("opencode", "ses_abc", skip)).toBe("opencode --session ses_abc");
  });

  it("builds a command for every harness this build knows", () => {
    // The guard on the guard: a harness added to the SDK with no entry here
    // would otherwise be a `resume` that throws at run time.
    for (const harness of KNOWN_HARNESSES) {
      expect(harnessResumeCommand(harness, SESSION_IDS[harness]).length).toBeGreaterThan(0);
    }
  });
});

describe("the Core's spawn policy accepts what this builds", () => {
  it("resolves a plan for every harness", () => {
    for (const harness of KNOWN_HARNESSES) {
      const plan = planFor(harness, harnessResumeCommand(harness, SESSION_IDS[harness]), false);
      expect(plan.mode, `${harness} resume was not accepted as an agent spawn`).toBe("agent");
    }
  });

  it("resolves a plan with skip-permissions on, which the policy gates on the option", () => {
    for (const harness of KNOWN_HARNESSES) {
      const command = harnessResumeCommand(harness, SESSION_IDS[harness], {
        dangerouslySkipPermissions: true,
      });
      const plan = planFor(harness, command, true);
      expect(plan.mode, `${harness} resume with --dangerously-skip-permissions was refused`).toBe("agent");
    }
  });

  it("refuses the same command when the option did not travel with the flag", () => {
    // Both halves of the gesture or neither — the gateway sends the option
    // whenever it appends the flag, and this is what would catch it if it
    // stopped doing so.
    const command = harnessResumeCommand("claude-code", SESSION_IDS["claude-code"], {
      dangerouslySkipPermissions: true,
    });
    expect(() => planFor("claude-code", command, false)).toThrow();
  });
});
