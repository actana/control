import { describe, it, expect, beforeEach } from "vitest";
import { HarnessAvailabilityStore } from "../harness-availability-store";
import {
  agentFlagNames,
  agentFromFlagName,
  offerableAgentIds,
  missingAgents,
  offerAgentInstalls,
  resolveAgentId,
  supportedAgentIdsSentence,
  type AgentOfferOptions,
} from "../actana-agents";
import type { ActanaSystem, CommandResult } from "../actana-system";
import type { CoreLinkAgentAvailabilityMap } from "../../../shared/src/core-link-frames";

const ALL_MISSING: CoreLinkAgentAvailabilityMap = {
  "claude-code": { status: "missing", reason: "not-found" },
  codex: { status: "missing", reason: "not-found" },
  "cursor-cli": { status: "missing", reason: "not-found" },
  opencode: { status: "missing", reason: "not-found" },
};

const ALL_PRESENT: CoreLinkAgentAvailabilityMap = {
  "claude-code": { status: "available", path: "/usr/bin/claude" },
  codex: { status: "available", path: "/usr/bin/codex" },
  "cursor-cli": { status: "available", path: "/usr/bin/cursor-agent" },
  opencode: { status: "available", path: "/usr/bin/opencode" },
};

let ran: string[][];
let answers: boolean[];
let asked: string[];
let out: string[];

/** A system port whose `passthrough` records the vendor command it was handed. */
function fakeSystem(exitCodes: Record<string, number> = {}): ActanaSystem {
  return {
    run(): CommandResult {
      return { status: 0, stdout: "", stderr: "" };
    },
    async passthrough(command, args) {
      ran.push([command, ...args]);
      const line = args[args.length - 1] ?? "";
      for (const [needle, code] of Object.entries(exitCodes)) {
        if (line.includes(needle)) return code;
      }
      return 0;
    },
    async waitForPort() {
      return true;
    },
    async confirm(question) {
      asked.push(question);
      return answers.shift() ?? true;
    },
    signal() {
      return true;
    },
  };
}

function options(over: Partial<AgentOfferOptions> = {}): AgentOfferOptions {
  return {
    availability: ALL_MISSING,
    requested: [],
    noAgents: false,
    assumeYes: false,
    interactive: false,
    platform: "linux",
    system: fakeSystem(),
    out: (line) => out.push(line),
    ...over,
  };
}

beforeEach(() => {
  ran = [];
  answers = [];
  asked = [];
  out = [];
});

describe("agent ids", () => {
  it("accepts the canonical id and the CLI command as the same agent", () => {
    expect(resolveAgentId("claude-code")).toBe("claude-code");
    expect(resolveAgentId("claude")).toBe("claude-code");
    expect(resolveAgentId("cursor-cli")).toBe("cursor-cli");
    expect(resolveAgentId("cursor-agent")).toBe("cursor-cli");
    expect(resolveAgentId("OpenCode")).toBe("opencode");
  });

  it("rejects anything else", () => {
    expect(resolveAgentId("gemini")).toBeNull();
    expect(resolveAgentId("")).toBeNull();
  });

  it("offers only agents the Harness's own probe reports on", () => {
    // The offer round reads an availability map and skips anything with no
    // entry in it. If the two sets ever drift, an agent becomes silently
    // uninstallable — no offer, no message, no way to ask for it.
    const store = new HarnessAvailabilityStore({ appendEvent: () => 0 });
    store.runProbe();
    const probed = store.snapshot();
    for (const agent of offerableAgentIds()) {
      expect(probed).toHaveProperty(agent);
    }
  });

  it("round-trips an agent through its --with-<agent> flag name", () => {
    for (const flag of agentFlagNames()) {
      expect(agentFromFlagName(flag)).not.toBeNull();
    }
    expect(agentFromFlagName("with-claude")).toBe("claude-code");
    expect(agentFromFlagName("with-nothing")).toBeNull();
    // Not an agent flag at all — the setup verb has other booleans.
    expect(agentFromFlagName("no-agents")).toBeNull();
  });

  it("names every supported id in the error sentence", () => {
    for (const id of offerableAgentIds()) {
      expect(supportedAgentIdsSentence()).toContain(id);
    }
  });
});

describe("missing detection", () => {
  it("counts only agents the Harness could not find", () => {
    expect(missingAgents(ALL_MISSING)).toEqual([
      "claude-code",
      "codex",
      "cursor-cli",
      "opencode",
    ]);
    expect(missingAgents(ALL_PRESENT)).toEqual([]);
  });

  it("leaves an outdated CLI alone — updating it is the vendor's job", () => {
    expect(
      missingAgents({ ...ALL_MISSING, codex: { status: "outdated", version: "0.1.0" } }),
    ).not.toContain("codex");
  });

  it("skips an agent the registry has disabled", () => {
    expect(
      missingAgents({ ...ALL_MISSING, codex: { status: "missing", reason: "disabled" } }),
    ).not.toContain("codex");
  });
});

describe("non-interactive runs", () => {
  it("never prompts and installs nothing by default", async () => {
    const outcomes = await offerAgentInstalls(options());
    expect(asked).toEqual([]);
    expect(ran).toEqual([]);
    expect(outcomes.every((o) => o.status === "skipped")).toBe(true);
  });

  it("tells the operator how to install the missing ones later", async () => {
    await offerAgentInstalls(options());
    expect(out.join("\n")).toContain("actana agents install");
    expect(out.join("\n")).toContain("claude-code");
  });

  it("installs exactly the requested agents with --with-<agent>", async () => {
    const outcomes = await offerAgentInstalls(
      options({ requested: ["opencode"], system: fakeSystem() }),
    );
    expect(asked).toEqual([]);
    expect(ran).toEqual([["/bin/sh", "-c", "curl -fsSL https://opencode.ai/install | bash"]]);
    expect(outcomes.find((o) => o.agent === "opencode")?.status).toBe("installed");
    expect(outcomes.find((o) => o.agent === "codex")?.status).toBe("skipped");
  });

  it("installs every missing agent under --yes", async () => {
    const outcomes = await offerAgentInstalls(options({ assumeYes: true }));
    expect(asked).toEqual([]);
    expect(ran).toHaveLength(4);
    expect(outcomes.every((o) => o.status === "installed")).toBe(true);
  });

  it("installs nothing under --no-agents, even on a TTY", async () => {
    const outcomes = await offerAgentInstalls(
      options({ noAgents: true, interactive: true, assumeYes: true }),
    );
    expect(asked).toEqual([]);
    expect(ran).toEqual([]);
    expect(outcomes).toEqual([]);
  });

  it("reports a requested agent that is already installed without running anything", async () => {
    const outcomes = await offerAgentInstalls(
      options({ availability: ALL_PRESENT, requested: ["codex"] }),
    );
    expect(ran).toEqual([]);
    expect(outcomes.find((o) => o.agent === "codex")?.status).toBe("already-installed");
  });
});

describe("interactive offers", () => {
  it("asks about each missing agent and installs the accepted ones", async () => {
    answers = [true, false, false, true];
    const outcomes = await offerAgentInstalls(options({ interactive: true }));

    expect(asked).toHaveLength(4);
    expect(asked[0]).toContain("Claude Code");
    expect(ran.map((call) => call[2])).toEqual([
      "curl -fsSL https://claude.ai/install.sh | bash",
      "curl -fsSL https://opencode.ai/install | bash",
    ]);
    expect(outcomes.find((o) => o.agent === "codex")?.status).toBe("declined");
    expect(outcomes.find((o) => o.agent === "opencode")?.status).toBe("installed");
  });

  it("does not ask about an agent already requested with --with-<agent>", async () => {
    answers = [false, false, false];
    await offerAgentInstalls(options({ interactive: true, requested: ["claude-code"] }));
    expect(asked).toHaveLength(3);
    expect(asked.join("\n")).not.toContain("Claude Code");
    expect(ran).toHaveLength(1);
  });

  it("does not ask about an agent that is already there", async () => {
    await offerAgentInstalls(
      options({
        interactive: true,
        availability: { ...ALL_MISSING, opencode: { status: "available" } },
      }),
    );
    expect(asked).toHaveLength(3);
  });
});

describe("vendor installer failures", () => {
  it("reports the failure and keeps going with the other agents", async () => {
    const outcomes = await offerAgentInstalls(
      options({ assumeYes: true, system: fakeSystem({ "claude.ai/install.sh": 1 }) }),
    );

    const failed = outcomes.find((o) => o.agent === "claude-code");
    expect(failed?.status).toBe("failed");
    expect(ran).toHaveLength(4);
    expect(outcomes.filter((o) => o.status === "installed")).toHaveLength(3);
    // The operator is told where to get it by hand rather than left guessing.
    expect(out.join("\n")).toContain("https://docs.anthropic.com/en/docs/claude-code/setup");
  });

  it("does not fail the run when every vendor installer fails", async () => {
    const outcomes = await offerAgentInstalls(
      options({ assumeYes: true, system: fakeSystem({ "": 1 }) }),
    );
    expect(outcomes.every((o) => o.status === "failed")).toBe(true);
  });
});
