// The three things ADR 0031 asks CI to hold, rather than a reviewer.
//
//  1. **Exhaustiveness** — a new member of `HARNESSES` with no skill target
//     fails here, by name. The type system already catches the omission in
//     `HARNESS_CLI_CONFIG` (`as const satisfies Record<Harness, …>`); this is
//     the belt to that pair of braces, and it is the assertion that survives
//     somebody widening the type.
//  2. **No drift between the copies** (D8). The installer module and the fan-out
//     table exist twice because the payload is embedded in two bundles, one per
//     program that writes the skill. The import rule that used to force that is
//     superseded (ADR 0032 D5 — the CLI may import this package now, and D8's own
//     note keeps the arrangement anyway); the copies are unchanged, so this test
//     is still the mechanism that makes "authored once" true rather than
//     intended.
//  3. **The skill is what the record says it is** (D9) — generic, self-contained,
//     and carrying the whole sentinel rule.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { HARNESSES } from "../domain";
import { HARNESS_CLI_CONFIG, HARNESS_SKILL_TARGETS } from "../harness-cli-config";
import { HARNESS_SKILL_TARGETS as CLI_TARGETS } from "../../../cli/src/harness-skill-targets";
import {
  ORCHESTRATION_SKILL_FILES,
  ORCHESTRATION_SKILL_MARKER,
  ORCHESTRATION_SKILL_NAME,
} from "../orchestration-skill-payload";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const read = (relative: string) => readFileSync(path.join(REPO, relative), "utf8");

const SKILL_DIR = `.agents/skills/${ORCHESTRATION_SKILL_NAME}`;

/** Every authored file in the skill folder, folder-relative and `/`-separated. */
function authoredFiles(dir = SKILL_DIR): string[] {
  return readdirSync(path.join(REPO, dir), { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? authoredFiles(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
    )
    .map((file) => file.slice(SKILL_DIR.length + 1))
    .sort();
}

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
        "edit one and copy it across; the payload is embedded in both bundles (ADR 0031 D8)",
    ).toBe(true);
  });
});

describe("the embedded payload is the authored folder (ADR 0031 D8, ADR 0035 D5)", () => {
  const authored = authoredFiles();

  it("carries an entry for every authored file, and no others", () => {
    // A folder, not a file, since #304 — `await.sh` ships beside `SKILL.md`.
    // Asserting the key set in both directions is what catches the two ways
    // this drifts: a file added to the folder and never generated, and a file
    // deleted from the folder that lives on inside the bundle.
    expect(Object.keys(ORCHESTRATION_SKILL_FILES).sort()).toEqual(authored);
    expect(authored.length, "the skill folder is empty").toBeGreaterThan(0);
  });

  it("matches, byte for byte, entry by entry, in this package", () => {
    for (const relative of authored) {
      expect(
        ORCHESTRATION_SKILL_FILES[relative] === read(`${SKILL_DIR}/${relative}`),
        `${relative}: run \`node scripts/gen-skill-payload.mjs\` — the embedded copy is stale`,
      ).toBe(true);
    }
  });

  it("matches in the CLI's copy too", () => {
    const cliCopy = read("packages/cli/src/orchestration-skill-payload.ts");
    const sharedCopy = read("packages/shared/src/orchestration-skill-payload.ts");
    expect(cliCopy).toBe(sharedCopy);
  });

  it("carries the marker that authorises overwriting it, in every file (D1)", () => {
    // Per file, and within the window the installer actually reads. An entry
    // whose marker sat past `MARKER_SCAN_BYTES` would ship a copy the installer
    // could write once and never repair — which is D5's escape hatch fired by
    // accident, on our side, for everybody.
    for (const [relative, content] of Object.entries(ORCHESTRATION_SKILL_FILES)) {
      expect(
        content.slice(0, 4096).includes(ORCHESTRATION_SKILL_MARKER),
        `${relative} carries no ${ORCHESTRATION_SKILL_MARKER} in its first 4096 bytes`,
      ).toBe(true);
    }
  });
});

describe("the skill folder ships the watcher (#304)", () => {
  const script = read(`${SKILL_DIR}/await.sh`);

  it("is a shell script whose marker sits under the shebang", () => {
    // The marker mechanism is a substring match on the first bytes rather than
    // a YAML parse (ADR 0031 D1), which is the whole reason a `.sh` needed no
    // new code. Line 1 must stay the shebang; line 2 is the marker.
    const [shebang, second] = script.split("\n");
    expect(shebang).toMatch(/^#!/);
    expect(second).toContain(ORCHESTRATION_SKILL_MARKER);
  });

  it("checks the LAST line for the sentinel rather than grepping for it", () => {
    // `ACT-REPORT-END` quoted inside a report must not settle a Session that
    // has not finished. A `grep` here would be the bug; the tail is the proof.
    expect(script).toContain("last_line_is_sentinel");
    expect(script).toMatch(/tail -n \d+/);
    expect(script.includes("grep -q"), "await.sh greps for the sentinel").toBe(false);
  });

  it("treats a lost link as 'not yet' rather than as a missing report", () => {
    // `actana core exec` exits 125 when the link went away mid-command: the
    // command kept running on the Core and this side has no result. Reading it
    // as failure abandons a lane that is fine.
    expect(script).toContain("125");
    expect(script.toLowerCase()).toContain("retrying, not giving up");
  });

  it("saves the report to local disk before killing anything", () => {
    const save = script.indexOf("project cp");
    const kill = script.indexOf("session kill");
    expect(save, "await.sh never copies the report down").toBeGreaterThan(-1);
    expect(kill, "await.sh never kills a Session").toBeGreaterThan(-1);
    expect(save, "await.sh kills before it saves — delete-then-save").toBeLessThan(kill);
  });

  it("is invoked as `bash await.sh`, so it needs no executable bit", () => {
    // `writeOneCopy` writes with no mode, and deliberately: the installer's
    // safety argument is that it is a filesystem write and nothing else.
    expect(script).toContain("bash await.sh");
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

  it("names no project, ticket workflow, train or repository — in any file", () => {
    // Every file, not just the markdown. D9's claim is about what lands in an
    // operator's home, and since #304 that is a folder: a citation of a record
    // this repository keeps is exactly as meaningless inside `await.sh`'s
    // comments as it would be inside the skill's prose.
    for (const [relative, content] of Object.entries(ORCHESTRATION_SKILL_FILES)) {
      for (const forbidden of [
        "actana/control",
        "release train",
        "beta/",
        "promote.yml",
        "gh pr",
        "CONTRIBUTING",
        "ADR 00",
      ]) {
        expect(content.includes(forbidden), `${relative} mentions "${forbidden}"`).toBe(false);
      }
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

  it("collects concurrent Sessions without racing the replay ring", () => {
    // The document's own mechanism section says a Harness that exited took its
    // transcript with it. The several-Sessions recipe is the one place that
    // could quietly contradict it, so the two ways out of that race are the
    // assertion: `--wait --json` run side by side, and `live` named as the
    // thing to check before reading `logs` when polling instead.
    const recipe = skill.slice(skill.indexOf("## Several Sessions at once"));
    expect(recipe, "the several-Sessions recipe is gone or was renamed").not.toBe("");
    expect(recipe).toContain("--wait --json");
    expect(
      recipe.includes("live"),
      "the recipe polls for status without naming the `live` field that says whether the " +
        "transcript still exists",
    ).toBe(true);
  });

  it("has the frontmatter every vendor's loader requires", () => {
    const frontmatter = skill.split("---")[1] ?? "";
    expect(frontmatter).toMatch(/^\s*name: actana-sessions$/m);
    expect(frontmatter).toMatch(/^description: .+/m);
  });
});
