// CodeQL code scanning runs on every pull request and on the integration
// branches, from a workflow of its own, pinned and with minimal permissions
// (#599, part of #552).
//
// A workflow cannot be run from a test, so this pins its shape: the triggers
// (the same `beta/**` and `feat/x.y.z` filters `ci.yml` uses), the one
// permission set CodeQL needs, the action pinned to a full commit SHA, and the
// fact that `ci.yml` stays untouched by it. What a CodeQL run *finds* is only
// visible on GitHub after the workflow has run there.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const workflowDir = path.join(repoRoot, ".github/workflows");
const read = (file) => fs.readFileSync(path.join(workflowDir, file), "utf8");

/** What the runner reads: the file with its comment lines removed. */
const code = (source) =>
  source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

const codeql = () => {
  expect(fs.existsSync(path.join(workflowDir, "codeql.yml")), "no codeql.yml").toBe(true);
  return code(read("codeql.yml"));
};

/** The `uses:` lines of a workflow, as [action, ref, trailing comment]. */
const usesOf = (source) =>
  [...source.matchAll(/^\s*-?\s*uses:\s*(\S+?)@(\S+)(?:\s+#\s*(.*))?$/gm)].map((m) => [m[1], m[2], m[3]]);

describe("the CodeQL workflow (#599)", () => {
  it("runs on pull requests, on beta/**, and on feat/x.y.z — with ci.yml's own filter", () => {
    const source = codeql();
    expect(source).toMatch(/^on:\n {2}pull_request:/m);
    expect(source).toContain('- "beta/**"');
    // Must be the exact glob ci.yml uses, so the two never drift.
    const ciGlob = code(read("ci.yml")).match(/- "(feat\/\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+)"/);
    expect(ciGlob, "ci.yml lost its feat/x.y.z filter").not.toBeNull();
    expect(source).toContain(`- "${ciGlob[1]}"`);
  });

  it("filters nothing out by path, so a required check cannot stay pending", () => {
    const source = codeql();
    expect(source).not.toMatch(/paths(-ignore)?:/);
    expect(source).not.toMatch(/branches-ignore:/);
  });

  it("holds exactly the permissions CodeQL needs, and nothing broader", () => {
    const source = codeql();
    expect(source).toMatch(/^permissions:\n {2}actions: read\n {2}contents: read\n {2}security-events: write\n/m);
    expect(source).not.toContain("write-all");
    expect(source.match(/: write\b/g)).toHaveLength(1);
  });

  it("scans JavaScript and TypeScript, and initialises before it analyses", () => {
    const source = codeql();
    expect(source).toContain("languages: javascript-typescript");
    expect(source.indexOf("codeql-action/init@")).toBeGreaterThan(-1);
    expect(source.indexOf("codeql-action/analyze@")).toBeGreaterThan(source.indexOf("codeql-action/init@"));
  });

  it("pins every action to a full commit SHA with its release in a comment", () => {
    const uses = usesOf(codeql());
    const actions = uses.map(([action]) => action);
    expect(actions).toEqual(expect.arrayContaining(["actions/checkout", "github/codeql-action/init", "github/codeql-action/analyze"]));
    for (const [action, ref, comment] of uses) {
      expect(ref, `${action} is not pinned to a 40-hex SHA`).toMatch(/^[0-9a-f]{40}$/);
      expect(comment, `${action} lacks its release comment`).toMatch(/^v\d+\.\d+\.\d+/);
    }
    // init and analyze must be the same release.
    const refs = new Set(uses.filter(([a]) => a.startsWith("github/codeql-action/")).map(([, r]) => r));
    expect(refs.size).toBe(1);
  });

  it("does not check out credentials it never uses", () => {
    expect(codeql()).toMatch(/persist-credentials: false/);
  });

  it("leaves ci.yml free of CodeQL, so its required checks are untouched", () => {
    expect(read("ci.yml")).not.toMatch(/codeql/i);
  });
});
