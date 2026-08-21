// `actana harness skills`, and the ensure that runs in front of every verb.
//
// ADR 0031 D6 — there is no npm lifecycle hook to install from, so the two
// things asserted here are the whole of "installed with the CLI": an explicit,
// idempotent verb, and a first-run path that reaches the same state one command
// later without being able to break the command it precedes.
//
// Every run is against the fixture's temporary home. Nothing here can touch a
// real `~/.claude`, `~/.codex`, `~/.cursor` or `~/.opencode`, and the tests that
// assert "nothing was written" would be vacuous if it could.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeCliFixture, healthyProbe, type CliFixture } from "./cli-harness.ts";
import { EXIT_OK, EXIT_USAGE } from "../exit-codes.ts";
import { ORCHESTRATION_SKILL_FILES, ORCHESTRATION_SKILL_MARKER } from "../orchestration-skill-payload.ts";

/**
 * The payload is a folder per skill since #304, and two skills since #303.
 *
 * These read the orchestrator's folder, which is the one that carries both
 * files; the sub-agent's is asserted where it matters — that it is written at
 * all, into the same roots, by the same pass.
 */
const SKILL_MD = ORCHESTRATION_SKILL_FILES["actana-sessions"]!["SKILL.md"]!;
const AWAIT_SH = ORCHESTRATION_SKILL_FILES["actana-sessions"]!["await.sh"]!;
const SUBAGENT_MD = ORCHESTRATION_SKILL_FILES["actana-subagent"]!["SKILL.md"]!;

let cli: CliFixture;

beforeEach(() => {
  cli = makeCliFixture();
});
afterEach(() => {
  cli.cleanup();
});

const claudeSkill = () =>
  path.join(cli.home, ".claude", "skills", "actana-sessions", "SKILL.md");
const agentsSkill = () =>
  path.join(cli.home, ".agents", "skills", "actana-sessions", "SKILL.md");
const claudeAwait = () =>
  path.join(cli.home, ".claude", "skills", "actana-sessions", "await.sh");
const claudeSubagent = () =>
  path.join(cli.home, ".claude", "skills", "actana-subagent", "SKILL.md");
const agentsSubagent = () =>
  path.join(cli.home, ".agents", "skills", "actana-subagent", "SKILL.md");

function pretendHarnessIsInstalled(dir: string): void {
  fs.mkdirSync(path.join(cli.home, dir), { recursive: true });
}

describe("actana harness skills", () => {
  it("writes nothing into a home with no Harness in it, and still exits 0", () => {
    // "You do not use any of the agents I know how to write to" is an answer,
    // not a failure — and it is the common case on a fresh machine.
    return cli.run(["harness", "skills"]).then((run) => {
      expect(run.code).toBe(EXIT_OK);
      expect(run.out.join("\n")).toContain("absent");
      expect(fs.existsSync(path.join(cli.home, ".claude"))).toBe(false);
      expect(fs.existsSync(path.join(cli.home, ".agents"))).toBe(false);
    });
  });

  it("installs into the directory of a Harness that is here", async () => {
    pretendHarnessIsInstalled(".claude");
    const run = await cli.run(["harness", "skills"]);
    expect(run.code).toBe(EXIT_OK);
    expect(fs.readFileSync(claudeSkill(), "utf8")).toBe(SKILL_MD);
  });

  it("installs the whole folder, not just the markdown (#304)", async () => {
    pretendHarnessIsInstalled(".claude");
    await cli.run(["harness", "skills"]);
    expect(fs.readFileSync(claudeAwait(), "utf8")).toBe(AWAIT_SH);
    // Written without an executable bit, on purpose: the skill says
    // `bash await.sh`, and the installer stays a filesystem write and nothing
    // else. A mode assertion is how that decision stops being one silently.
    expect(fs.statSync(claudeAwait()).mode & 0o111).toBe(0);
  });

  it("installs both skills, each into its own folder (#303)", async () => {
    // Two folders in the one root, written by the one pass. The sub-agent skill
    // is not installed on a different trigger or by a different caller: the
    // roles differ in the prose inside the files and nowhere else.
    pretendHarnessIsInstalled(".claude");
    await cli.run(["harness", "skills"]);
    expect(fs.readFileSync(claudeSkill(), "utf8")).toBe(SKILL_MD);
    expect(fs.readFileSync(claudeSubagent(), "utf8")).toBe(SUBAGENT_MD);
  });

  it("installs both into the shared root as well", async () => {
    pretendHarnessIsInstalled(".codex");
    await cli.run(["harness", "skills"]);
    expect(fs.readFileSync(agentsSkill(), "utf8")).toBe(SKILL_MD);
    expect(fs.readFileSync(agentsSubagent(), "utf8")).toBe(SUBAGENT_MD);
  });

  it("reports a row per Harness per skill, told apart by the folder", async () => {
    pretendHarnessIsInstalled(".claude");
    const run = await cli.run(["harness", "skills", "--json"]);
    const report = JSON.parse(run.out.join("\n")) as {
      skills: string[];
      harnesses: Array<{ harness: string; outcome: string; path: string }>;
    };
    expect(report.skills).toEqual(["actana-sessions", "actana-subagent"]);
    const rows = report.harnesses.filter((entry) => entry.harness === "claude-code");
    expect(rows.map((row) => path.basename(row.path)).sort()).toEqual([
      "actana-sessions",
      "actana-subagent",
    ]);
    for (const row of rows) expect(row.outcome).toBe("written");
  });

  it("names the folder to an operator, and the file when one goes wrong", async () => {
    pretendHarnessIsInstalled(".claude");
    // A directory where `await.sh` has to go — one file of two fails.
    fs.mkdirSync(claudeAwait(), { recursive: true });
    const run = await cli.run(["harness", "skills", "--json"]);
    const report = JSON.parse(run.out.join("\n")) as {
      harnesses: Array<{ harness: string; outcome: string; path: string; detail?: string }>;
    };
    const row = report.harnesses.find(
      (entry) => entry.harness === "claude-code" && entry.path === path.dirname(claudeAwait()),
    )!;
    expect(row.outcome).toBe("failed");
    expect(row.path).toBe(path.dirname(claudeAwait()));
    expect(row.detail).toContain("await.sh");
  });

  it("changes nothing the second time", async () => {
    pretendHarnessIsInstalled(".codex");
    await cli.run(["harness", "skills"]);
    const first = fs.statSync(agentsSkill()).mtimeMs;
    const second = await cli.run(["harness", "skills", "--json"]);
    const report = JSON.parse(second.out.join("\n")) as {
      skills: string[];
      harnesses: Array<{ harness: string; outcome: string }>;
    };
    expect(report.skills).toContain("actana-sessions");
    for (const row of report.harnesses.filter((entry) => entry.harness === "codex")) {
      expect(row.outcome).toBe("current");
    }
    expect(fs.statSync(agentsSkill()).mtimeMs).toBe(first);
  });

  it("repairs a deleted copy", async () => {
    pretendHarnessIsInstalled(".claude");
    await cli.run(["harness", "skills"]);
    fs.rmSync(claudeSkill());
    const run = await cli.run(["harness", "skills", "--json"]);
    const report = JSON.parse(run.out.join("\n")) as {
      harnesses: Array<{ harness: string; outcome: string; path: string }>;
    };
    const row = report.harnesses.find(
      (entry) => entry.harness === "claude-code" && entry.path === path.dirname(claudeSkill()),
    )!;
    expect(row.outcome).toBe("written");
    expect(fs.readFileSync(claudeSkill(), "utf8")).toBe(SKILL_MD);
  });

  it("leaves a copy alone once its marker line is gone, and says so", async () => {
    pretendHarnessIsInstalled(".claude");
    await cli.run(["harness", "skills"]);
    const mine = SKILL_MD.replace(`${ORCHESTRATION_SKILL_MARKER}\n`, "");
    fs.writeFileSync(claudeSkill(), mine, "utf8");

    const run = await cli.run(["harness", "skills"]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toContain("skipped");
    expect(fs.readFileSync(claudeSkill(), "utf8")).toBe(mine);
  });

  it("takes no arguments, and says which one it did not want", async () => {
    const run = await cli.run(["harness", "skills", "claude-code"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain('unexpected argument "claude-code"');
  });

  it("is listed by `actana harness --help`", async () => {
    const run = await cli.run(["harness", "--help"]);
    expect(run.out.join("\n")).toContain("actana harness skills");
  });

  it("dials no Core — it is a write to this machine", async () => {
    // No `connect` fake is supplied and none is needed. A verb that reached for
    // a Core here would fail on a laptop that has never registered one, which
    // is exactly the machine the first acceptance criterion is about.
    pretendHarnessIsInstalled(".cursor");
    const run = await cli.run(["harness", "skills"]);
    expect(run.code).toBe(EXIT_OK);
    expect(fs.existsSync(agentsSkill())).toBe(true);
  });
});

describe("no npm lifecycle hook, which is why the ensure exists at all", () => {
  it("declares no postinstall, preinstall or prepare", () => {
    // ADR 0031 D6. An install hook is the only thing npm runs at install time
    // and it is the one thing this package may not have: it breaks `npm ci` in
    // sandboxes and under pnpm's strict mode, and a failed one fails the
    // install of the CLI itself. Removing this assertion is how the ensure
    // path quietly stops being necessary and then quietly stops being correct.
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    for (const hook of ["postinstall", "preinstall", "prepare"]) {
      expect(Object.keys(manifest.scripts), `package.json declares ${hook}`).not.toContain(hook);
    }
  });
});

describe("the ensure that runs in front of every verb (ADR 0031 D6)", () => {
  it("leaves the skill behind after an unrelated command", async () => {
    pretendHarnessIsInstalled(".claude");
    const run = await cli.run(["core", "status"], { probe: healthyProbe() });
    expect(fs.readFileSync(claudeSkill(), "utf8")).toBe(SKILL_MD);
    // And it said nothing about it. stdout under `--json` carries one document,
    // and a line on stderr about a thing nobody asked for is noise on every
    // single invocation.
    expect(run.all).not.toContain("actana-sessions");
  });

  it("does not change the exit code of a command that fails", async () => {
    pretendHarnessIsInstalled(".claude");
    const run = await cli.run(["core", "nonsense"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(fs.existsSync(claudeSkill())).toBe(true);
  });

  it("does not run for --version, which touches nothing", async () => {
    pretendHarnessIsInstalled(".claude");
    const run = await cli.run(["--version"]);
    expect(run.code).toBe(EXIT_OK);
    expect(fs.existsSync(claudeSkill())).toBe(false);
  });

  it("survives a home directory it cannot write into", async () => {
    // The installer reports rather than throws, and the quiet wrapper catches
    // what it cannot report. Either way the operator's command runs.
    pretendHarnessIsInstalled(".claude");
    fs.mkdirSync(path.join(cli.home, ".claude", "skills"), { recursive: true });
    fs.writeFileSync(path.join(cli.home, ".claude", "skills", "actana-sessions"), "in the way");
    const run = await cli.run(["harness", "--help"]);
    expect(run.code).toBe(EXIT_OK);
  });
});
