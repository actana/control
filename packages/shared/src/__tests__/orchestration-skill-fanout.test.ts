// The three things ADR 0031 asks CI to hold, rather than a reviewer.
//
//  1. **Exhaustiveness** — a new member of `HARNESSES` with no skill target
//     fails here, by name. The type system already catches the omission in
//     `HARNESS_CLI_CONFIG` (`as const satisfies Record<Harness, …>`); this is
//     the belt to that pair of braces, and it is the assertion that survives
//     somebody widening the type.
//  2. **No drift between the copies** (D8). The CLI cannot import this package,
//     so the installer module and the fan-out table exist twice. This test is
//     the mechanism that makes "authored once" true rather than intended.
//  3. **The skill is what the record says it is** (D9) — generic, self-contained,
//     and carrying the whole sentinel rule.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { HARNESSES } from "../domain";
import { HARNESS_CLI_CONFIG, HARNESS_SKILL_TARGETS } from "../harness-cli-config";
import { HARNESS_SKILL_TARGETS as CLI_TARGETS } from "../../../cli/src/harness-skill-targets";
import {
  ORCHESTRATION_SKILL_MARKER,
  ORCHESTRATION_SKILL_MD,
  ORCHESTRATION_SKILL_NAME,
} from "../orchestration-skill-payload";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const read = (relative: string) => readFileSync(path.join(REPO, relative), "utf8");

describe("every Harness has a skill target (#265, ADR 0031 D4)", () => {
  it("names the missing Harness rather than failing on a length", () => {
    for (const harness of HARNESSES) {
      const target = HARNESS_CLI_CONFIG[harness].skillTarget;
      expect(target, `${harness} has no skillTarget on HARNESS_CLI_CONFIG`).toBeDefined();
      expect(target.kind, `${harness}'s skillTarget has no kind`).toBe("skill-dir");
      expect(
        target.skillDir.length,
        `${harness}'s skillTarget has an empty skillDir`,
      ).toBeGreaterThan(0);
      expect(
        target.homeMarkers.length,
        `${harness} has no home marker — the installer could not tell whether it is here`,
      ).toBeGreaterThan(0);
    }
  });

  it("records where each path came from, and when", () => {
    // Nothing in this repository recorded a global skill directory for any
    // Harness before #265. A path with no citation is a path the next reader
    // has to re-derive from the web, which is the failure §2 of the issue
    // describes.
    for (const harness of HARNESSES) {
      const target = HARNESS_CLI_CONFIG[harness].skillTarget;
      expect(target.source, `${harness}'s skill target cites no vendor page`).toMatch(/^https:\/\//);
      expect(target.verifiedOn, `${harness}'s skill target has no read date`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    }
  });

  it("writes only into home-relative directories, never absolute ones", () => {
    for (const harness of HARNESSES) {
      const { skillDir, homeMarkers } = HARNESS_CLI_CONFIG[harness].skillTarget;
      for (const segment of [skillDir, ...homeMarkers]) {
        expect(segment.startsWith("/"), `${harness}: ${segment} is absolute`).toBe(false);
        expect(segment.includes(".."), `${harness}: ${segment} escapes the home dir`).toBe(false);
      }
    }
  });
});

describe("the CLI's copy of the table agrees (ADR 0031 D8, ADR 0025 D3)", () => {
  it("has a row for every Harness", () => {
    expect(CLI_TARGETS.map((row) => row.harness).sort()).toEqual([...HARNESSES].sort());
  });

  it("agrees with this package's row for each, field by field", () => {
    for (const harness of HARNESSES) {
      const mine = HARNESS_SKILL_TARGETS.find((row) => row.harness === harness)!;
      const theirs = CLI_TARGETS.find((row) => row.harness === harness);
      expect(theirs, `packages/cli/src/harness-skill-targets.ts has no row for ${harness}`).toBeDefined();
      expect({ ...theirs }, `${harness} drifted between the two tables`).toEqual({ ...mine });
    }
  });
});

describe("the installer exists twice and is one file (ADR 0031 D8)", () => {
  it("is byte-identical in packages/shared and packages/cli", () => {
    const mine = read("packages/shared/src/orchestration-skill-install.ts");
    const theirs = read("packages/cli/src/orchestration-skill-install.ts");
    expect(
      theirs === mine,
      "packages/cli/src/orchestration-skill-install.ts has drifted from the shared copy — " +
        "edit one and copy it across; the two packages cannot import each other (ADR 0025 D2/D4)",
    ).toBe(true);
  });
});

describe("the embedded payload is the authored file (ADR 0031 D8)", () => {
  const authored = read(`.agents/skills/${ORCHESTRATION_SKILL_NAME}/SKILL.md`);

  it("matches, byte for byte, in this package", () => {
    expect(
      ORCHESTRATION_SKILL_MD === authored,
      "run `node scripts/gen-skill-payload.mjs` — the embedded copy is stale",
    ).toBe(true);
  });

  it("matches in the CLI's copy too", () => {
    const cliCopy = read("packages/cli/src/orchestration-skill-payload.ts");
    const sharedCopy = read("packages/shared/src/orchestration-skill-payload.ts");
    expect(cliCopy).toBe(sharedCopy);
  });

  it("carries the marker that authorises overwriting it (D1)", () => {
    expect(authored).toContain(ORCHESTRATION_SKILL_MARKER);
  });
});

describe("the skill is generic and self-contained (ADR 0031 D9)", () => {
  const skill = read(`.agents/skills/${ORCHESTRATION_SKILL_NAME}/SKILL.md`);

  it("has no repo-relative link and assumes no checkout", () => {
    // The `release` skill next door is full of `../../../docs/…`, and it is
    // allowed to be: it never leaves this repository. A copy installed at a
    // global path has no repository around it.
    expect(skill).not.toMatch(/\]\(\.{1,2}\//);
    expect(skill).not.toMatch(/\bdocs\/[a-z-]+\.md/);
  });

  it("names no project, ticket workflow, train or repository", () => {
    for (const forbidden of [
      "actana/control",
      "release train",
      "beta/",
      "promote.yml",
      "gh pr",
      "CONTRIBUTING",
      "ADR 00",
    ]) {
      expect(skill.includes(forbidden), `the skill mentions "${forbidden}"`).toBe(false);
    }
  });

  it("names no default Harness and no preference order", () => {
    // Harness selection is the operator's. A skill that named one would encode
    // a preference the product has no business having.
    for (const harness of HARNESSES) {
      expect(
        skill.includes(harness),
        `the skill names the harness "${harness}" — selection is the caller's`,
      ).toBe(false);
    }
  });

  it("states all four properties of the sentinel rule", () => {
    expect(skill).toContain("<%ACT_REPORT%>");
    expect(skill).toContain("<%/ACT_REPORT%>");
    expect(skill.toLowerCase()).toContain("pair, not a single marker");
    expect(skill.toLowerCase()).toContain("last complete pair wins");
    expect(skill.toLowerCase()).toContain("whitespace stripped");
    // And the ordering constraint the report depends on: killing a Session
    // destroys the ring the report is read from.
    expect(skill.toLowerCase()).toContain("collect first, kill second");
  });

  it("has the frontmatter every vendor's loader requires", () => {
    const frontmatter = skill.split("---")[1] ?? "";
    expect(frontmatter).toMatch(/^\s*name: actana-sessions$/m);
    expect(frontmatter).toMatch(/^description: .+/m);
  });
});
