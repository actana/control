// What the skill installer will and will not do to an operator's home.
//
// Every case here is a clause of ADR 0031 rather than a code path for its own
// sake, and the two that matter most are the ones that are *not* installs: a
// harness that is not on this machine gets nothing, and a file that does not
// carry the marker is never touched. Those are what the record had to buy from
// ADR 0006, and a regression in either is a regression in the argument.
//
// Every test runs against a temporary home. Nothing here goes near a real one.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  installOrchestrationSkill,
  type SkillInstallTarget,
} from "../orchestration-skill-install";

const MARKER = "x-actana-managed: true";
const CONTENT = `---\nname: actana-sessions\n${MARKER}\n---\n\n# body\n`;
const SCRIPT = `#!/usr/bin/env bash\n# ${MARKER}\necho hello\n`;
const FILES = { "SKILL.md": CONTENT, "await.sh": SCRIPT };

const TARGETS: SkillInstallTarget[] = [
  { harness: "claude-code", kind: "skill-dir", homeMarkers: [".claude"], skillDir: ".claude/skills" },
  { harness: "codex", kind: "skill-dir", homeMarkers: [".codex"], skillDir: ".agents/skills" },
  { harness: "cursor-cli", kind: "skill-dir", homeMarkers: [".cursor"], skillDir: ".agents/skills" },
];

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "actana-skill-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function run(files: Record<string, string> = FILES) {
  return installOrchestrationSkill({
    home,
    targets: TARGETS,
    skillName: "actana-sessions",
    marker: MARKER,
    files,
  });
}

function outcomes(entries: ReturnType<typeof run>): Record<string, string> {
  return Object.fromEntries(entries.map((entry) => [entry.harness, entry.outcome]));
}

const claudeDir = () => path.join(home, ".claude", "skills", "actana-sessions");
const agentsDir = () => path.join(home, ".agents", "skills", "actana-sessions");
const claudeFile = () => path.join(claudeDir(), "SKILL.md");
const agentsFile = () => path.join(agentsDir(), "SKILL.md");
const claudeScript = () => path.join(claudeDir(), "await.sh");
const agentsScript = () => path.join(agentsDir(), "await.sh");

describe("only where the harness already lives (ADR 0031 D4)", () => {
  it("writes nothing at all into a home with no harness in it", () => {
    expect(outcomes(run())).toEqual({
      "claude-code": "absent",
      codex: "absent",
      "cursor-cli": "absent",
    });
    // Not "wrote nothing useful" — wrote nothing. A product that creates
    // `~/.claude` on a machine that has never run Claude Code is doing the
    // larger act ADR 0006 refused.
    expect(fs.existsSync(path.join(home, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".agents"))).toBe(false);
  });

  it("writes for the harness that is here and not for the one that is not", () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    expect(outcomes(run())).toEqual({
      "claude-code": "written",
      codex: "absent",
      "cursor-cli": "absent",
    });
    expect(fs.readFileSync(claudeFile(), "utf8")).toBe(CONTENT);
    expect(fs.readFileSync(claudeScript(), "utf8")).toBe(SCRIPT);
    expect(fs.existsSync(agentsFile())).toBe(false);
    expect(fs.existsSync(agentsScript())).toBe(false);
  });

  it("takes any one of a harness's markers as evidence", () => {
    const target: SkillInstallTarget = {
      harness: "opencode",
      kind: "skill-dir",
      homeMarkers: [".opencode", ".config/opencode"],
      skillDir: ".agents/skills",
    };
    fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    const entries = installOrchestrationSkill({
      home,
      targets: [target],
      skillName: "actana-sessions",
      marker: MARKER,
      files: FILES,
    });
    expect(entries[0]!.outcome).toBe("written");
  });
});

describe("one write per directory, one row per harness (ADR 0031 D4)", () => {
  it("reports both harnesses that share `.agents/skills`, and writes it once", () => {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
    const entries = run();
    expect(outcomes(entries)).toEqual({
      "claude-code": "absent",
      codex: "written",
      "cursor-cli": "written",
    });
    // The same file, named by both rows — the fan-out is a covering set of
    // directories, not one directory per vendor.
    expect(entries.find((e) => e.harness === "codex")!.path).toBe(agentsDir());
    expect(entries.find((e) => e.harness === "cursor-cli")!.path).toBe(agentsDir());
  });

  it("writes the shared directory when only one of its harnesses is present", () => {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    expect(outcomes(run())).toEqual({
      "claude-code": "absent",
      codex: "written",
      "cursor-cli": "absent",
    });
    expect(fs.readFileSync(agentsFile(), "utf8")).toBe(CONTENT);
  });
});

describe("idempotence, and what repair means (ADR 0031 D5)", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  });

  it("changes nothing the second time", () => {
    expect(outcomes(run())["claude-code"]).toBe("written");
    const first = fs.statSync(claudeFile()).mtimeMs;
    const second = run();
    expect(outcomes(second)["claude-code"]).toBe("current");
    expect(fs.statSync(claudeFile()).mtimeMs).toBe(first);
  });

  it("repairs a deleted copy", () => {
    run();
    fs.rmSync(claudeFile());
    expect(outcomes(run())["claude-code"]).toBe("written");
    expect(fs.readFileSync(claudeFile(), "utf8")).toBe(CONTENT);
  });

  it("overwrites an edited copy that still carries the marker, and says so", () => {
    run();
    fs.writeFileSync(claudeFile(), CONTENT.replace("# body", "# my own body"), "utf8");
    const entry = run().find((e) => e.harness === "claude-code")!;
    expect(entry.outcome).toBe("written");
    expect(entry.detail).toContain("replaced");
    // This is the promise ADR 0031 D5 makes on the record: an edit to a managed
    // copy is not preserved. It is a decision, not an accident of idempotence.
    expect(fs.readFileSync(claudeFile(), "utf8")).toBe(CONTENT);
  });

  it("never touches a copy whose marker line has been deleted", () => {
    run();
    const mine = CONTENT.replace(`${MARKER}\n`, "") + "\nmine now\n";
    fs.writeFileSync(claudeFile(), mine, "utf8");
    const entry = run().find((e) => e.harness === "claude-code")!;
    expect(entry.outcome).toBe("skipped");
    expect(fs.readFileSync(claudeFile(), "utf8")).toBe(mine);
    // And it keeps not touching it, run after run — the escape hatch is
    // permanent, which is the whole of what makes it an escape hatch.
    expect(run().find((e) => e.harness === "claude-code")!.outcome).toBe("skipped");
    expect(fs.readFileSync(claudeFile(), "utf8")).toBe(mine);
  });

  it("leaves an operator's unrelated skill at the same path alone", () => {
    fs.mkdirSync(path.dirname(claudeFile()), { recursive: true });
    fs.writeFileSync(claudeFile(), "---\nname: actana-sessions\n---\n\nmine\n", "utf8");
    expect(outcomes(run())["claude-code"]).toBe("skipped");
    expect(fs.readFileSync(claudeFile(), "utf8")).toContain("mine");
  });
});

describe("failures are reported, never thrown", () => {
  it("reports a directory it cannot write into", () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    // A file where the skill's directory has to go: mkdir fails, and the run
    // still returns rows for every harness.
    fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "skills", "actana-sessions"), "not a directory");
    const entries = run();
    expect(entries).toHaveLength(3);
    expect(outcomes(entries)["claude-code"]).toBe("failed");
  });

  it("reports an extension point this build has no writer for", () => {
    const entries = installOrchestrationSkill({
      home,
      targets: [{ harness: "future", kind: "manifest-entry", homeMarkers: [], skillDir: "" }],
      skillName: "actana-sessions",
      marker: MARKER,
      files: FILES,
    });
    expect(entries[0]!.outcome).toBe("skipped");
    expect(entries[0]!.detail).toContain("manifest-entry");
  });
});

describe("a skill is a folder of files (#304, ADR 0035 D4)", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  });

  it("writes every entry in the map, and reports the folder", () => {
    const entry = run().find((e) => e.harness === "claude-code")!;
    expect(entry.outcome).toBe("written");
    // The folder, not a file inside it: `ls` takes a directory, and that is the
    // next thing an operator debugging a missing skill does.
    expect(entry.path).toBe(claudeDir());
    expect(fs.readFileSync(claudeFile(), "utf8")).toBe(CONTENT);
    expect(fs.readFileSync(claudeScript(), "utf8")).toBe(SCRIPT);
  });

  it("writes a nested entry, splitting its key on `/` on any platform", () => {
    const nested = `# ${MARKER}\nnested\n`;
    run({ ...FILES, "lib/helper.sh": nested });
    expect(fs.readFileSync(path.join(claudeDir(), "lib", "helper.sh"), "utf8")).toBe(nested);
  });

  it("writes N files per directory and not N per harness", () => {
    // Three of the four harnesses read the same root. The dedup is on the
    // folder, which is what keeps a two-file payload at two writes rather than
    // six — the arithmetic that has to hold as the payload grows.
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
    run();
    const first = fs.statSync(agentsFile()).mtimeMs;
    const secondScript = fs.statSync(agentsScript()).mtimeMs;
    const entries = run();
    expect(outcomes(entries).codex).toBe("current");
    expect(outcomes(entries)["cursor-cli"]).toBe("current");
    expect(fs.statSync(agentsFile()).mtimeMs).toBe(first);
    expect(fs.statSync(agentsScript()).mtimeMs).toBe(secondScript);
  });

  it("is `current` only when EVERY file matches", () => {
    run();
    // One of two files edited back to a managed-but-different state. A folder
    // reported `current` here would be telling an operator the skill is up to
    // date because the *other* file happened to match.
    fs.writeFileSync(claudeScript(), SCRIPT.replace("echo hello", "echo mine"), "utf8");
    const entry = run().find((e) => e.harness === "claude-code")!;
    expect(entry.outcome).toBe("written");
    expect(entry.detail).toContain("await.sh");
    expect(entry.detail).toContain("replaced");
    expect(fs.readFileSync(claudeScript(), "utf8")).toBe(SCRIPT);
  });

  it("is `skipped` when ANY managed file lost its marker, and names it", () => {
    run();
    const mine = SCRIPT.replace(`# ${MARKER}\n`, "") + "mine now\n";
    fs.writeFileSync(claudeScript(), mine, "utf8");
    const entry = run().find((e) => e.harness === "claude-code")!;
    expect(entry.outcome).toBe("skipped");
    expect(entry.detail).toContain("await.sh");
    // And the file the operator took is still theirs, while the other one is
    // still ours: the escape hatch is per file, not per folder.
    expect(fs.readFileSync(claudeScript(), "utf8")).toBe(mine);
    expect(fs.readFileSync(claudeFile(), "utf8")).toBe(CONTENT);
  });

  it("is `failed` when any file fails, and names which one", () => {
    // A directory where `await.sh` has to go: the write fails for that entry
    // and succeeds for the other. `failed` outranks `written`, because it is
    // the only outcome that is a fault.
    fs.mkdirSync(claudeScript(), { recursive: true });
    const entry = run().find((e) => e.harness === "claude-code")!;
    expect(entry.outcome).toBe("failed");
    expect(entry.detail).toContain("await.sh");
    expect(fs.readFileSync(claudeFile(), "utf8")).toBe(CONTENT);
  });

  it("refuses a key that would write outside the folder, and writes the rest", () => {
    // Ours come from a `readdir` of our own folder and can never look like
    // this. The check is for the caller that is not us: an installer that can
    // be talked into writing outside the directory it names is a different and
    // much worse thing than the one ADR 0031 argued for.
    for (const escape of ["../escaped.md", "/etc/passwd", "a/../../escaped.md", ""]) {
      const entry = run({ ...FILES, [escape]: CONTENT }).find((e) => e.harness === "claude-code")!;
      expect(entry.outcome, `${escape} was not refused`).toBe("failed");
      expect(entry.detail).toContain("inside the skill folder");
    }
    expect(fs.existsSync(path.join(home, ".claude", "skills", "escaped.md"))).toBe(false);
    // The refusal is per file: the honest entries were still written.
    expect(fs.readFileSync(claudeFile(), "utf8")).toBe(CONTENT);
    expect(fs.readFileSync(claudeScript(), "utf8")).toBe(SCRIPT);
  });

  it("is `failed`, never `current`, for a payload carrying no files at all", () => {
    // Nothing was checked. Reporting "up to date" for a folder nobody looked
    // in is the failure the fold's ordering exists to rule out.
    const entry = run({}).find((e) => e.harness === "claude-code")!;
    expect(entry.outcome).toBe("failed");
    expect(entry.detail).toContain("no files");
  });

  it("still never touches a file it did not write, whatever else is in the folder", () => {
    fs.mkdirSync(claudeDir(), { recursive: true });
    const theirs = "#!/bin/sh\nmine, no marker\n";
    fs.writeFileSync(claudeScript(), theirs, "utf8");
    expect(outcomes(run())["claude-code"]).toBe("skipped");
    expect(fs.readFileSync(claudeScript(), "utf8")).toBe(theirs);
  });
});
