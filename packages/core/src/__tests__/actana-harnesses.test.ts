import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { HarnessAvailabilityStore } from "../harness-availability-store";
import { MANAGED_BLOCK_BEGIN } from "../operator-login-path";
import { cleanupTempHomes, makeTempHome, readHomeFile } from "./temp-home";
import {
  harnessFlagNames,
  harnessFromFlagName,
  offerableHarnessIds,
  missingHarnesses,
  offerHarnessInstalls,
  resolveHarnessId,
  supportedHarnessIdsSentence,
  type HarnessOfferOptions,
} from "../actana-harnesses";
import type { ActanaSystem, CommandResult } from "../actana-system";
import type { CoreLinkHarnessAvailabilityMap } from "@actana/shared/core-link-frames";

const ALL_MISSING: CoreLinkHarnessAvailabilityMap = {
  "claude-code": { status: "missing", reason: "not-found" },
  codex: { status: "missing", reason: "not-found" },
  "cursor-cli": { status: "missing", reason: "not-found" },
  opencode: { status: "missing", reason: "not-found" },
};

const ALL_PRESENT: CoreLinkHarnessAvailabilityMap = {
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

function options(over: Partial<HarnessOfferOptions> = {}): HarnessOfferOptions {
  return {
    availability: ALL_MISSING,
    requested: [],
    noHarnesses: false,
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
    expect(resolveHarnessId("claude-code")).toBe("claude-code");
    expect(resolveHarnessId("claude")).toBe("claude-code");
    expect(resolveHarnessId("cursor-cli")).toBe("cursor-cli");
    expect(resolveHarnessId("cursor-agent")).toBe("cursor-cli");
    expect(resolveHarnessId("OpenCode")).toBe("opencode");
  });

  it("rejects anything else", () => {
    expect(resolveHarnessId("gemini")).toBeNull();
    expect(resolveHarnessId("")).toBeNull();
  });

  it("offers only agents the Core's own probe reports on", () => {
    // The offer round reads an availability map and skips anything with no
    // entry in it. If the two sets ever drift, an agent becomes silently
    // uninstallable — no offer, no message, no way to ask for it.
    const store = new HarnessAvailabilityStore({ appendEvent: () => 0 });
    store.runProbe();
    const probed = store.snapshot();
    for (const agent of offerableHarnessIds()) {
      expect(probed).toHaveProperty(agent);
    }
  });

  it("round-trips an agent through its --with-<harness> flag name", () => {
    for (const flag of harnessFlagNames()) {
      expect(harnessFromFlagName(flag)).not.toBeNull();
    }
    expect(harnessFromFlagName("with-claude")).toBe("claude-code");
    expect(harnessFromFlagName("with-nothing")).toBeNull();
    // Not an agent flag at all — the setup verb has other booleans.
    expect(harnessFromFlagName("no-harnesses")).toBeNull();
  });

  it("names every supported id in the error sentence", () => {
    for (const id of offerableHarnessIds()) {
      expect(supportedHarnessIdsSentence()).toContain(id);
    }
  });
});

describe("missing detection", () => {
  it("counts only agents the Core could not find", () => {
    expect(missingHarnesses(ALL_MISSING)).toEqual([
      "claude-code",
      "codex",
      "cursor-cli",
      "opencode",
    ]);
    expect(missingHarnesses(ALL_PRESENT)).toEqual([]);
  });

  it("leaves an outdated CLI alone — updating it is the vendor's job", () => {
    expect(
      missingHarnesses({ ...ALL_MISSING, codex: { status: "outdated", version: "0.1.0" } }),
    ).not.toContain("codex");
  });

  it("skips an agent the registry has disabled", () => {
    expect(
      missingHarnesses({ ...ALL_MISSING, codex: { status: "missing", reason: "disabled" } }),
    ).not.toContain("codex");
  });
});

describe("non-interactive runs", () => {
  it("never prompts and installs nothing by default", async () => {
    const outcomes = await offerHarnessInstalls(options());
    expect(asked).toEqual([]);
    expect(ran).toEqual([]);
    expect(outcomes.every((o) => o.status === "skipped")).toBe(true);
  });

  it("tells the operator how to install the missing ones later", async () => {
    await offerHarnessInstalls(options());
    expect(out.join("\n")).toContain("actana harnesses install");
    expect(out.join("\n")).toContain("claude-code");
  });

  it("installs exactly the requested agents with --with-<harness>", async () => {
    const outcomes = await offerHarnessInstalls(
      options({ requested: ["opencode"], system: fakeSystem() }),
    );
    expect(asked).toEqual([]);
    expect(ran).toEqual([["/bin/sh", "-c", "curl -fsSL https://opencode.ai/install | bash"]]);
    expect(outcomes.find((o) => o.agent === "opencode")?.status).toBe("installed");
    expect(outcomes.find((o) => o.agent === "codex")?.status).toBe("skipped");
  });

  it("installs every missing agent under --yes", async () => {
    const outcomes = await offerHarnessInstalls(options({ assumeYes: true }));
    expect(asked).toEqual([]);
    expect(ran).toHaveLength(4);
    expect(outcomes.every((o) => o.status === "installed")).toBe(true);
  });

  it("installs nothing under --no-harnesses, even on a TTY", async () => {
    const outcomes = await offerHarnessInstalls(
      options({ noHarnesses: true, interactive: true, assumeYes: true }),
    );
    expect(asked).toEqual([]);
    expect(ran).toEqual([]);
    expect(outcomes).toEqual([]);
  });

  it("reports a requested agent that is already installed without running anything", async () => {
    const outcomes = await offerHarnessInstalls(
      options({ availability: ALL_PRESENT, requested: ["codex"] }),
    );
    expect(ran).toEqual([]);
    expect(outcomes.find((o) => o.agent === "codex")?.status).toBe("already-installed");
  });
});

describe("interactive offers", () => {
  it("asks about each missing agent and installs the accepted ones", async () => {
    answers = [true, false, false, true];
    const outcomes = await offerHarnessInstalls(options({ interactive: true }));

    expect(asked).toHaveLength(4);
    expect(asked[0]).toContain("Claude Code");
    expect(ran.map((call) => call[2])).toEqual([
      "curl -fsSL https://claude.ai/install.sh | bash",
      "curl -fsSL https://opencode.ai/install | bash",
    ]);
    expect(outcomes.find((o) => o.agent === "codex")?.status).toBe("declined");
    expect(outcomes.find((o) => o.agent === "opencode")?.status).toBe("installed");
  });

  it("does not ask about an agent already requested with --with-<harness>", async () => {
    answers = [false, false, false];
    await offerHarnessInstalls(options({ interactive: true, requested: ["claude-code"] }));
    expect(asked).toHaveLength(3);
    expect(asked.join("\n")).not.toContain("Claude Code");
    expect(ran).toHaveLength(1);
  });

  it("does not ask about an agent that is already there", async () => {
    await offerHarnessInstalls(
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
    const outcomes = await offerHarnessInstalls(
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
    const outcomes = await offerHarnessInstalls(
      options({ assumeYes: true, system: fakeSystem({ "": 1 }) }),
    );
    expect(outcomes.every((o) => o.status === "failed")).toBe(true);
  });
});

// A vendor installer decides for itself which dotfile it edits, and OpenCode's
// picks one a non-interactive login shell never reads. After a successful
// install the offer round writes Actana's own block so the CLI it just
// installed is genuinely on the operator's login PATH.
describe("the operator's login PATH", () => {
  afterEach(cleanupTempHomes);

  const profile = (home: string) => readHomeFile(home, ".profile");

  /** An offer round that names a home, with the shell pinned for determinism. */
  const linking = (home: string, over: Partial<HarnessOfferOptions> = {}) =>
    options({ homeDir: home, shell: "/bin/bash", ...over });

  it("links the agent directories after an install that worked", async () => {
    const home = makeTempHome();
    await offerHarnessInstalls(linking(home, { assumeYes: true }));
    expect(profile(home)).toContain(MANAGED_BLOCK_BEGIN);
    expect(profile(home)).toContain('"$HOME/.opencode/bin"');
  });

  it("tells the operator which file it changed", async () => {
    const home = makeTempHome();
    await offerHarnessInstalls(linking(home, { assumeYes: true }));
    expect(out.join("\n")).toContain("~/.profile");
  });

  // The repair path: a CLI the vendor installed directly has the broken login
  // PATH this whole module exists to fix, and re-running the install verb is
  // what an operator would try.
  it("repairs the PATH for an agent that was already installed", async () => {
    const home = makeTempHome();
    await offerHarnessInstalls(
      linking(home, { availability: ALL_PRESENT, requested: ["opencode"] }),
    );
    expect(ran).toEqual([]);
    expect(profile(home)).toContain('"$HOME/.opencode/bin"');
  });

  it("writes nothing when every vendor installer failed", async () => {
    const home = makeTempHome();
    await offerHarnessInstalls(linking(home, { assumeYes: true, system: fakeSystem({ "": 1 }) }));
    expect(profile(home)).toBe("");
  });

  it("writes nothing when nothing was installed or already there", async () => {
    const home = makeTempHome();
    await offerHarnessInstalls(linking(home));
    expect(profile(home)).toBe("");
  });

  // Safe by default: a caller that never names a home directory — every unit
  // test in this file that is not about this behaviour — must not reach the
  // operator's real dotfiles.
  it("does not touch the real home when no home directory was named", async () => {
    const home = makeTempHome();
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const outcomes = await offerHarnessInstalls(options({ assumeYes: true }));
      expect(outcomes.filter((o) => o.status === "installed")).toHaveLength(4);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    }
    expect(fs.readdirSync(home)).toEqual([]);
  });
});
