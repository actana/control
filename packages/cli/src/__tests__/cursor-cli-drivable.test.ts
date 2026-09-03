// cursor-cli, driven from this client, against the machine that has to accept
// it (issue 177 findings 1 and 2).
//
// The issue was filed against a client that lived outside this repository, and
// its first two findings were both the same mistake in two columns of one
// table: the client sent the harness *id* where the Core wanted the canonical
// *binary*, and it set the auto-mode spawn *option* without ever putting the
// matching *flag* in the command. `cursor-cli` is where both bit, and it is
// the only harness where either could — its id and its binary differ
// (`cursor-cli` vs `cursor-agent`), and its flag is `--force` where the
// template the client was built from said `--dangerously-skip-permissions`.
// `codex` and `opencode` survived on a coincidence, which is what kept it
// hidden.
//
// The client half now lives here, in `packages/cli` and the SDK under it, so
// the findings are testable rather than describable. Every assertion below
// runs the command this client would actually send through `resolveSpawnPlan`
// — the same function `packages/core` calls before spawning anything — so a
// pass means the Core would have accepted it, not that two files in this
// repository agree with each other.
//
// Importing `@actana/shared` from a test is the arrangement `tsconfig.json`,
// `vitest.config.ts` and `no-local-escape.test.ts` already describe: test-only,
// never from a shipped module.

import { describe, it, expect, afterEach } from "vitest";
import {
  hookTrustFlagForSpawn,
  resolveSpawnPlan,
  SpawnPolicyError,
  type SpawnPolicyDeps,
  type SpawnRequest,
} from "@actana/shared/pty-spawn-policy";
import {
  HARNESS_LAUNCH_COMMANDS,
  harnessAutoModeFlag,
  harnessLaunchCommand,
} from "@actana/sdk/core-session.ts";
import { KNOWN_HARNESSES } from "../session-gateway.ts";
import { makeCliFixture, type CliFixture } from "./cli-harness.ts";
import { EXIT_OK } from "../exit-codes.ts";
import type { CoreLinkPtySpawnHarness } from "@actana/sdk/core-link-frames.ts";

const PROJECT_ROOT = "/home/core/projects/web";

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

/** The spawn this client would send for `harness`, put to the Core's policy. */
function planFor(harness: CoreLinkPtySpawnHarness, autoMode: boolean) {
  return resolveSpawnPlan(
    {
      taskId: "t1",
      cwd: PROJECT_ROOT,
      command: harnessLaunchCommand(harness, autoMode),
      agent: harness,
      ...(autoMode ? { dangerouslySkipPermissions: true } : {}),
    } as SpawnRequest,
    policyDeps(),
  );
}

describe("finding 1 — argv[0] is the canonical binary, never the harness id", () => {
  it("sends cursor-agent for cursor-cli, which is the whole of the original crash", () => {
    // `core-client: pty:spawn rejected (command-not-on-allowlist)`, verbatim
    // from the issue. The command starting with the id is what produced it.
    expect(HARNESS_LAUNCH_COMMANDS["cursor-cli"].split(" ")[0]).toBe("cursor-agent");
    expect(harnessLaunchCommand("cursor-cli", false).startsWith("cursor-cli")).toBe(false);
  });

  it("carries each harness's hook-trust flag into the SDK's own launch (issue 290)", () => {
    // The SDK deliberately does not import `@actana/shared` — it is a
    // published package and re-declares what it needs — so its copy of a
    // vendor fact can drift from the registry's silently. This is the only
    // place holding both, and the drift it guards is the invisible kind: a
    // Codex launched without the flag spawns cleanly, paints a working TUI,
    // and reports no lifecycle at all, so the first symptom is a `waitForIdle`
    // that timed out on a Session that finished ten minutes ago.
    for (const harness of KNOWN_HARNESSES) {
      const flag = hookTrustFlagForSpawn(harness);
      if (flag === null) continue;
      expect(
        HARNESS_LAUNCH_COMMANDS[harness].split(" "),
        `${harness}'s SDK launch command is missing ${flag}`,
      ).toContain(flag);
      expect(harnessLaunchCommand(harness, true).split(" ")).toContain(flag);
    }
  });

  it("resolves a plan for every harness, so nothing rides on id === binary", () => {
    // The point of sweeping all four rather than testing cursor-cli alone:
    // codex and opencode passed the old client too, by coincidence. A table
    // that is right for the reason rather than by luck is right for all of
    // them.
    for (const harness of KNOWN_HARNESSES) {
      const plan = planFor(harness, false);
      expect(plan.mode, `${harness} was not accepted as an agent spawn`).toBe("agent");
    }
  });

  it("puts the binary the Core resolved on the plan, per harness", () => {
    const binaries: Record<CoreLinkPtySpawnHarness, string> = {
      "claude-code": "/usr/local/bin/claude",
      codex: "/usr/local/bin/codex",
      "cursor-cli": "/usr/local/bin/cursor-agent",
      opencode: "/usr/local/bin/opencode",
    };
    for (const harness of KNOWN_HARNESSES) {
      const plan = planFor(harness, false);
      if (plan.mode !== "agent") throw new Error("wrong mode");
      expect(plan.binary).toBe(binaries[harness]);
    }
  });
});

describe("finding 2 — auto mode reaches the harness, or the spawn is refused", () => {
  it("puts each harness's own flag in the command, and cursor-cli's is --force", () => {
    expect(harnessAutoModeFlag("cursor-cli")).toBe("--force");
    expect(harnessLaunchCommand("cursor-cli", true)).toBe("cursor-agent --force");
    expect(harnessLaunchCommand("claude-code", true)).toContain(
      "--dangerously-skip-permissions",
    );
    expect(harnessLaunchCommand("codex", true)).toContain("--yolo");
    // OpenCode ships no such flag. `null` is the fact, not a gap.
    expect(harnessAutoModeFlag("opencode")).toBeNull();
    expect(harnessLaunchCommand("opencode", true)).toBe("opencode");
  });

  it("is accepted by the Core for every harness, auto mode on", () => {
    for (const harness of KNOWN_HARNESSES) {
      const plan = planFor(harness, true);
      expect(plan.mode, `${harness} auto-mode launch was refused`).toBe("agent");
    }
  });

  it("carries the flag into argv rather than only into the option", () => {
    for (const harness of KNOWN_HARNESSES) {
      const flag = harnessAutoModeFlag(harness);
      if (flag === null) continue;
      const plan = planFor(harness, true);
      if (plan.mode !== "agent") throw new Error("wrong mode");
      expect(plan.argv, `${harness} auto mode never reached argv`).toContain(flag);
    }
  });

  it("refuses the option with no flag — the silent pass this issue closed", () => {
    // The pre-177 behaviour, reproduced deliberately: set the option, send the
    // command a client that only knew Claude Code would have built. The Core
    // used to accept this and launch an interactive cursor-agent.
    let thrown: unknown;
    try {
      resolveSpawnPlan(
        {
          taskId: "t1",
          cwd: PROJECT_ROOT,
          command: "cursor-agent",
          agent: "cursor-cli",
          dangerouslySkipPermissions: true,
        } as SpawnRequest,
        policyDeps(),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SpawnPolicyError);
    expect((thrown as SpawnPolicyError).code).toBe("auto-mode-flag-missing");
  });

  it("still refuses the flag with no option, in the direction that always worked", () => {
    expect(() =>
      resolveSpawnPlan(
        {
          taskId: "t1",
          cwd: PROJECT_ROOT,
          command: "cursor-agent --force",
          agent: "cursor-cli",
        } as SpawnRequest,
        policyDeps(),
      ),
    ).toThrow(SpawnPolicyError);
  });
});

describe("--model is never dropped silently (issue 177, ticket #211)", () => {
  // The acceptance criterion asks for one of two things, not for the flag:
  // `--model` reaches every harness that supports it, or it is rejected loudly
  // where it is not passed. This build does the second — the flag is not
  // carried at all, and #211 is where carrying it lands. What must never
  // happen in between is the third thing: accepted, and then quietly not sent.
  let fixture: CliFixture | null = null;
  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
  });

  it("is refused as an unknown flag rather than accepted and ignored", async () => {
    fixture = makeCliFixture();
    const run = await fixture.run([
      "session",
      "start",
      "web",
      "go",
      "--model",
      "composer-2.5",
    ]);
    expect(run.code).not.toBe(EXIT_OK);
    expect(run.err.join("\n")).toContain("unknown flag --model");
  });
});
