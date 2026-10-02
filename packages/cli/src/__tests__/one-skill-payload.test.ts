// One orchestration skill payload for the whole repository (#580, review R1).
//
// The Core daemon installs the skill at boot, and `actana`'s client nouns install it in front of every
// run. Both carry the same marker, so each repairs the other's copy: with two payloads, a Core's skill
// text depended on which process wrote last. The ruling is one payload — the published one, imported from
// the root of the pinned `@actana/cli` — and these hold it: no second source in the tree, and the same
// bytes on disk whichever writer ran last, with the old `.actana/reports` contract named in none of them.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ORCHESTRATION_SKILL_FILES, ORCHESTRATION_SKILL_NAMES } from "@actana/cli";
import { installOrchestrationSkills } from "@actana/core/orchestration-skill";
import { makeCliFixture, type CliFixture } from "./cli-harness.ts";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const OLD_CONTRACT = ".actana/reports";

const tracked = (): string[] =>
  execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((file) => file !== "" && fs.existsSync(path.join(REPO, file)));

const isTest = (file: string) => /(^|\/)__tests__\//.test(file) || /\.test\.[mc]?[tj]sx?$/.test(file);
const isSource = (file: string) => /\.(?:[mc]?[tj]sx?)$/.test(file) && !isTest(file);

describe("the repository has exactly one orchestration skill payload", () => {
  it("keeps no payload module, generator or authored skill folder of its own", () => {
    const files = tracked();
    expect(files.filter((file) => /orchestration-skill-payload/.test(file))).toEqual([]);
    expect(files.filter((file) => /gen-skill-payload/.test(file))).toEqual([]);
    expect(files.filter((file) => /^\.agents\/skills\/actana-(?:sessions|subagent)\//.test(file))).toEqual([]);
  });

  it("defines the payload nowhere, and imports it from @actana/cli alone", () => {
    const sources = tracked().filter(isSource);
    const definers = sources.filter((file) =>
      /export\s+const\s+ORCHESTRATION_SKILL_(?:FILES|NAMES|MARKER)\b/.test(fs.readFileSync(path.join(REPO, file), "utf8")),
    );
    expect(definers).toEqual([]);
    const importers = sources.filter((file) => /ORCHESTRATION_SKILL_(?:FILES|NAMES)/.test(fs.readFileSync(path.join(REPO, file), "utf8")));
    expect(importers.length).toBeGreaterThan(0);
    for (const file of importers) {
      const text = fs.readFileSync(path.join(REPO, file), "utf8");
      expect(text, `${file} must take the payload from the package root`).toMatch(
        /(?:from\s+|require\()\s*"@actana\/cli"/,
      );
    }
  });

  it("carries no authored copy of the skill text in a source file", () => {
    const offenders = tracked()
      .filter(isSource)
      .filter((file) => /name: actana-(?:sessions|subagent)\b/.test(fs.readFileSync(path.join(REPO, file), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("names the Core's dependency on it exactly, as the client's pinned release", () => {
    const read = (pkg: string) => JSON.parse(fs.readFileSync(path.join(REPO, "packages", pkg, "package.json"), "utf8"));
    const core = read("core").dependencies["@actana/cli"];
    expect(core).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
    expect(core).toBe(read("cli").dependencies["@actana/cli"]);
  });
});

describe("a Core's boot install and a client noun write the same skill", () => {
  let cli: CliFixture;
  const savedPiDir = process.env.PI_CODING_AGENT_DIR;
  beforeEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    cli = makeCliFixture();
    // A home with two Harnesses in it, so the skill lands in `.claude` and in the shared `.agents` root.
    fs.mkdirSync(path.join(cli.home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(cli.home, ".codex"), { recursive: true });
  });
  afterEach(() => {
    cli.cleanup();
    if (savedPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedPiDir;
  });

  /** Every file under the skill roots, home-relative path to bytes. */
  function installed(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const root of [".claude/skills", ".agents/skills"]) {
      const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else out[path.relative(cli.home, full)] = fs.readFileSync(full, "utf8");
        }
      };
      walk(path.join(cli.home, root));
    }
    return out;
  }

  const published = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const root of [".claude/skills", ".agents/skills"]) {
      for (const name of ORCHESTRATION_SKILL_NAMES) {
        for (const [file, text] of Object.entries(ORCHESTRATION_SKILL_FILES[name] ?? {})) {
          out[path.join(root, name, file)] = text;
        }
      }
    }
    return out;
  };

  it("leaves the published bytes after the daemon's boot install, naming .actana/reports in none", () => {
    installOrchestrationSkills(cli.home);
    const boot = installed();
    expect(Object.keys(boot).length).toBeGreaterThan(0);
    expect(boot).toEqual(published());
    for (const [file, text] of Object.entries(boot)) {
      expect(text.split(OLD_CONTRACT).length - 1, `${file} names ${OLD_CONTRACT}`).toBe(0);
    }
  });

  it("leaves the same published bytes when a client noun is the first writer", async () => {
    const run = await cli.run(["core", "ls"]);
    expect(run.code, run.err.join("\n")).toBe(0);
    expect(installed()).toEqual(published());
  });

  it("is byte-identical after a client noun, and again after the daemon installs once more", async () => {
    installOrchestrationSkills(cli.home);
    const boot = installed();
    const run = await cli.run(["core", "ls"]);
    expect(run.code, run.err.join("\n")).toBe(0);
    expect(installed()).toEqual(boot);
    installOrchestrationSkills(cli.home);
    expect(installed()).toEqual(boot);
    for (const text of Object.values(installed())) expect(text).not.toContain(OLD_CONTRACT);
  });
});
