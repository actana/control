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
//  3. **The skills are what the records say they are** (ADR 0031 D9, ADR 0035
//     D1-D3) — generic, self-contained, carrying the whole report-file contract,
//     and asymmetric on purpose: one invoke-only, one eager.

import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HARNESSES } from "../domain";
import { HARNESS_CLI_CONFIG, HARNESS_SKILL_TARGETS } from "../harness-cli-config";
import { HARNESS_SKILL_TARGETS as CLI_TARGETS } from "../../../cli/src/harness-skill-targets";
import {
  ORCHESTRATION_SKILL_FILES,
  ORCHESTRATION_SKILL_MARKER,
  ORCHESTRATION_SKILL_NAMES,
} from "../orchestration-skill-payload";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const read = (relative: string) => readFileSync(path.join(REPO, relative), "utf8");

/** Where one skill is authored, repo-relative. */
const skillDir = (skillName: string) => `.agents/skills/${skillName}`;

/**
 * The two folder names, written out rather than read off the payload.
 *
 * The payload is one of the things under test — a build that shipped one folder,
 * or three, has to fail here rather than quietly assert whatever it happens to
 * carry.
 */
const SESSIONS = "actana-sessions";
const SUBAGENT = "actana-subagent";

/** One skill's authored `SKILL.md`, by folder name. */
const skillText = (skillName: string) => read(`${skillDir(skillName)}/SKILL.md`);

/** Every file of every skill, as `<folder>/<path>` to bytes. Flat, for sweeps. */
function everyShippedFile(): Array<[string, string]> {
  return Object.entries(ORCHESTRATION_SKILL_FILES).flatMap(([skillName, files]) =>
    Object.entries(files).map(([relative, content]): [string, string] => [
      `${skillName}/${relative}`,
      content,
    ]),
  );
}

/**
 * Every authored file in the skill folder, folder-relative and `/`-separated.
 *
 * The prefix is built on the way down and the slice happens at the leaf, so it
 * happens exactly once. Stripping `SKILL_DIR` from the returned list instead
 * stripped it again from paths the recursive call had already made relative,
 * and every nested file collapsed to `""` — which the flat folder of today hid,
 * and which `writeOneFolder`'s split on `/` means is a shape this payload is
 * allowed to take tomorrow.
 */
function authoredFiles(dir: string, prefix = "", root = REPO): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? authoredFiles(`${dir}/${entry.name}`, `${prefix}${entry.name}/`, root)
        : [`${prefix}${entry.name}`],
    )
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

describe("the walker this file compares against (#308 review)", () => {
  it("keeps a nested file's path instead of collapsing it to an empty key", () => {
    // The folder is flat today, so nothing downstream would notice: a nested
    // file came back as `""`, the key-set comparison below became nonsense and
    // the byte comparison read a directory. `writeOneFolder` splits keys on
    // `/`, so nesting is a shape the payload is allowed to take — this is the
    // assertion that makes the drift test survive the first one.
    const root = mkdtempSync(path.join(os.tmpdir(), "actana-walk-"));
    try {
      mkdirSync(path.join(root, "skill", "lib"), { recursive: true });
      for (const file of ["skill/SKILL.md", "skill/await.sh", "skill/lib/helper.sh"]) {
        writeFileSync(path.join(root, ...file.split("/")), "x", "utf8");
      }
      expect(authoredFiles("skill", "", root)).toEqual([
        "SKILL.md",
        "await.sh",
        "lib/helper.sh",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a usable key for every file actually in either skill folder", () => {
    for (const skillName of ORCHESTRATION_SKILL_NAMES) {
      for (const relative of authoredFiles(skillDir(skillName))) {
        expect(relative.length, "a file collapsed to an empty key").toBeGreaterThan(0);
        expect(relative.startsWith("/"), `${relative} is not folder-relative`).toBe(false);
      }
    }
  });
});

describe("the embedded payload is the authored folders (ADR 0031 D8, ADR 0035 D5)", () => {
  it("ships both skills, and only those (#303, ADR 0035 D1 and D4)", () => {
    // The bound ADR 0035 D4 restates: two folders in two roots. A third folder
    // is a new decision and has to be taken in a record before it is taken here.
    expect([...ORCHESTRATION_SKILL_NAMES].sort()).toEqual([SESSIONS, SUBAGENT]);
    expect(Object.keys(ORCHESTRATION_SKILL_FILES).sort()).toEqual([SESSIONS, SUBAGENT]);
  });

  it("carries an entry for every authored file, and no others", () => {
    // A folder, not a file, since #304 — `await.sh` ships beside `SKILL.md`;
    // two folders, not one, since #303. Asserting the key set in both
    // directions is what catches the two ways this drifts: a file added to a
    // folder and never generated, and a file deleted from a folder that lives
    // on inside the bundle.
    for (const skillName of ORCHESTRATION_SKILL_NAMES) {
      const authored = authoredFiles(skillDir(skillName));
      expect(authored.length, `${skillName} is empty`).toBeGreaterThan(0);
      expect(Object.keys(ORCHESTRATION_SKILL_FILES[skillName] ?? {}).sort()).toEqual(authored);
    }
  });

  it("matches, byte for byte, entry by entry, in this package", () => {
    for (const skillName of ORCHESTRATION_SKILL_NAMES) {
      for (const relative of authoredFiles(skillDir(skillName))) {
        expect(
          ORCHESTRATION_SKILL_FILES[skillName]?.[relative] ===
            read(`${skillDir(skillName)}/${relative}`),
          `${skillName}/${relative}: run \`node scripts/gen-skill-payload.mjs\` — the embedded copy is stale`,
        ).toBe(true);
      }
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
    for (const [name, content] of everyShippedFile()) {
      expect(
        content.slice(0, 4096).includes(ORCHESTRATION_SKILL_MARKER),
        `${name} carries no ${ORCHESTRATION_SKILL_MARKER} in its first 4096 bytes`,
      ).toBe(true);
    }
  });
});

describe("the skill folder ships the watcher (#304)", () => {
  const script = read(`${skillDir(SESSIONS)}/await.sh`);

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

describe("both skills are generic and self-contained (ADR 0031 D9)", () => {
  it("has no repo-relative link and assumes no checkout", () => {
    // The `release` skill next door is full of `../../../docs/…`, and it is
    // allowed to be: it never leaves this repository. A copy installed at a
    // global path has no repository around it.
    for (const skillName of ORCHESTRATION_SKILL_NAMES) {
      const skill = skillText(skillName);
      expect(skill, `${skillName} carries a repo-relative link`).not.toMatch(/\]\(\.{1,2}\//);
      expect(skill, `${skillName} cites a file in this repository`).not.toMatch(
        /\bdocs\/[a-z-]+\.md/,
      );
    }
  });

  it("names no project, ticket workflow, train or repository — in any file", () => {
    // Every file of every folder, not just the markdown. D9's claim is about
    // what lands in an operator's home, and since #304 that is a folder and
    // since #303 it is two of them: a citation of a record this repository
    // keeps is exactly as meaningless inside `await.sh`'s comments as it would
    // be inside either skill's prose.
    for (const [name, content] of everyShippedFile()) {
      for (const forbidden of [
        "actana/control",
        "release train",
        "beta/",
        "promote.yml",
        "gh pr",
        "CONTRIBUTING",
        "ADR 00",
      ]) {
        expect(content.includes(forbidden), `${name} mentions "${forbidden}"`).toBe(false);
      }
    }
  });

  it("names no default Harness and no preference order, in either skill", () => {
    // Harness selection is the operator's. A skill that named one would encode
    // a preference the product has no business having — and the sub-agent
    // skill's prohibition has to be written harness-neutrally for the same
    // reason (ADR 0035 D3), which is why this sweeps both files rather than
    // exempting the new one.
    for (const [name, content] of everyShippedFile()) {
      for (const harness of HARNESSES) {
        expect(
          content.includes(harness),
          `${name} names the harness "${harness}" — selection is the caller's`,
        ).toBe(false);
      }
    }
  });

  it("has the frontmatter every vendor's loader requires, in both", () => {
    for (const skillName of ORCHESTRATION_SKILL_NAMES) {
      const frontmatter = skillText(skillName).split("---")[1] ?? "";
      expect(frontmatter, `${skillName} has no name key`).toMatch(
        new RegExp(`^\\s*name: ${skillName}$`, "m"),
      );
      expect(frontmatter, `${skillName} has no description`).toMatch(/^description: .+/m);
      expect(frontmatter, `${skillName} is not marked managed`).toContain(
        ORCHESTRATION_SKILL_MARKER,
      );
    }
  });
});

describe("the two skills are asymmetric on purpose (#303 §3, ADR 0035 D1)", () => {
  it("triggers the sub-agent skill on a prompt declaring the Session one", () => {
    // Eager, and this is the whole of what eager means here: the description a
    // vendor's loader matches on says the trigger is the declaration, not the
    // subject matter. A Session nobody addressed that way never matches it.
    const frontmatter = skillText(SUBAGENT).split("---")[1] ?? "";
    expect(frontmatter.toLowerCase()).toContain("sub-agent of an orchestrating session");
  });

  it("leaves the orchestrator skill asking to be invoked", () => {
    // Invoke-only: its description stays subject-matter plus "use when asked",
    // which is what #303 rejected widening. A description that self-triggered
    // would make every unrelated Session on the machine match it.
    const frontmatter = skillText(SESSIONS).split("---")[1] ?? "";
    expect(frontmatter.toLowerCase()).toContain("use when asked");
    expect(
      frontmatter.toLowerCase().includes("sub-agent of an orchestrating session"),
      "the orchestrator skill's description now triggers on the sub-agent declaration too",
    ).toBe(false);
  });

  it("says out loud in both files that the asymmetry is deliberate", () => {
    // Stated in both, so that a reviewer meeting one of them does not "fix" it
    // into symmetry with the other.
    for (const skillName of ORCHESTRATION_SKILL_NAMES) {
      const skill = skillText(skillName).toLowerCase();
      expect(skill, `${skillName} does not say the asymmetry is deliberate`).toContain(
        "asymmetry is deliberate",
      );
      expect(skill).toContain("invoke-only");
      expect(skill).toContain("eager");
    }
  });
});

describe("the report file contract, stated in both skills (#303 §6)", () => {
  it("names the path shape, anchored at the Session's own cwd", () => {
    for (const skillName of ORCHESTRATION_SKILL_NAMES) {
      const skill = skillText(skillName);
      expect(skill, `${skillName} does not name the report path shape`).toContain(
        ".actana/reports/<id>-r<turn>.md",
      );
      expect(skill.toLowerCase(), `${skillName} does not anchor the path`).toContain("cwd");
    }
  });

  it("makes the file's last line the completeness proof", () => {
    for (const skillName of ORCHESTRATION_SKILL_NAMES) {
      const skill = skillText(skillName);
      expect(skill, `${skillName} never names the end marker`).toContain("ACT-REPORT-END");
      expect(
        skill.toLowerCase().includes("final line") || skill.toLowerCase().includes("last line"),
        `${skillName} does not say the marker has to be the last line`,
      ).toBe(true);
    }
  });

  it("says the orchestrator mints the name, never reuses one, and restates it every turn", () => {
    // The three clauses that keep a stale report from being read as a fresh
    // one. They are stated on both sides because each side can break them
    // alone: the orchestrator by reusing a path, the sub-agent by inventing one.
    for (const skillName of ORCHESTRATION_SKILL_NAMES) {
      const skill = skillText(skillName).toLowerCase();
      expect(skill, `${skillName} does not say who mints the filename`).toContain("mint");
      expect(skill, `${skillName} does not forbid reusing a name`).toContain("reuse");
      expect(skill, `${skillName} does not tie the path to the prompt`).toContain("every turn");
    }
  });
});

describe("the orchestrator collects a file, not a screen (#303 §1 and §7)", () => {
  const skill = skillText(SESSIONS);

  it("keeps no trace of the screen mechanism it replaced, in either skill", () => {
    // Deleted, not reworded. The mechanism failed for reasons no rule could
    // patch — interleaved frames, a bounded ring, a scrollback a harness may
    // discard outright — so a document that still described it would be
    // teaching a model to try it.
    //
    // Both markdown bodies, and deliberately not `everyShippedFile()`:
    // `await.sh` says "sentinel" throughout and means `ACT-REPORT-END` by it,
    // which is the replacement rather than the thing replaced.
    for (const skillName of ORCHESTRATION_SKILL_NAMES) {
      const body = skillText(skillName).toLowerCase();
      for (const gone of [
        "<%ACT_REPORT%>",
        "<%/ACT_REPORT%>",
        "sentinel",
        "last complete pair",
        "collect first, kill second",
      ]) {
        expect(
          body.includes(gone.toLowerCase()),
          `${skillName} still mentions "${gone}"`,
        ).toBe(false);
      }
    }
  });

  it("is honest that `--wait --json`'s screen is a transcript and not a result", () => {
    expect(skill).toContain("--wait --json");
    expect(skill.toLowerCase()).toContain("rendered transcript");
  });

  it("reads the report back with `core exec`", () => {
    expect(skill).toContain("core exec");
    expect(skill).toContain(".actana/reports/");
  });

  it("saves locally, waits, and only then deletes the remote file", () => {
    // The order is the whole of the lifecycle, and getting it backwards
    // reintroduces exactly the loss this contract exists to end. The delay has
    // to carry its reason with it, because a delay with no reason is the first
    // thing an optimiser deletes.
    const lower = skill.toLowerCase();
    const save = lower.indexOf("save the content locally");
    const del = lower.indexOf("delete the remote file");
    expect(save, "the orchestrator skill never says to save the report locally").toBeGreaterThan(-1);
    expect(del, "the orchestrator skill never says to delete the remote file").toBeGreaterThan(-1);
    expect(save, "the skill deletes before it saves").toBeLessThan(del);
    expect(lower).toContain("20 seconds");
    expect(lower).toContain("never delete before the local save");
  });

  it("collects concurrent Sessions from files rather than from the replay ring", () => {
    // The several-Sessions recipe is the one place that could quietly
    // contradict the mechanism section above it, so what it collects is the
    // assertion: a report path per lane, minted before anything starts, and a
    // single loop waiting on files.
    const recipe = skill.slice(skill.indexOf("## Several Sessions at once"));
    expect(recipe, "the several-Sessions recipe is gone or was renamed").not.toBe("");
    expect(recipe).toContain("report path");
    expect(recipe).toContain("ACT-REPORT-END");
    expect(
      recipe.toLowerCase().includes("watching progress"),
      "the recipe does not say what `logs`, `events tail` and `session ls` are for",
    ).toBe(true);
  });

  it("ships the watcher and tells the reader how to run it", () => {
    expect(skill).toContain("await.sh");
    expect(skill).toContain("bash await.sh");
  });

  it("reconciles the two anchors the report path is read against (#309 review)", () => {
    // The defect this asserts against: the contract anchors the report path at
    // the Session's own `cwd`, and everything that reads it back — `project cp`
    // and every lane handed to `await.sh` — anchors at the **Project root**.
    // They coincide only when the Session runs at the Project root, and this
    // same document teaches `--cwd` as a directory inside the Project.
    //
    // A lane started with `--cwd apps/api` then has its report written exactly
    // where the contract said, collected from somewhere else, and the round
    // runs to its timeout reporting nothing — the sub-agent having done
    // everything right, and nothing having failed loudly enough to say so.
    // That is the failure class this whole contract exists to end, so the
    // conversion has to be in the document rather than in a reader's head.
    expect(skill.toLowerCase()).toContain("project-relative");
    expect(
      skill.includes("`--cwd` unset"),
      "the skill never names the case where the two anchors coincide",
    ).toBe(true);
    expect(
      skill.includes("apps/api/.actana/reports/"),
      "the skill never shows the converted path for a lane that has a --cwd",
    ).toBe(true);

    // And the conversion is stated where the reader meets each anchor: in the
    // contract, and again at the lane syntax `await.sh` takes.
    const contract = skill.slice(
      skill.indexOf("## Asking a Session for a report file"),
      skill.indexOf("## Collecting a report"),
    );
    expect(contract, "the contract section is gone or was renamed").not.toBe("");
    expect(contract).toContain("Project root");
    const watcher = skill.slice(skill.indexOf("## `await.sh`"));
    expect(watcher, "the await.sh section is gone or was renamed").not.toBe("");
    expect(watcher).toContain("--cwd");
  });
});

describe("the sub-agent skill is narrow and forbids provisioning (#303 §4 and §5)", () => {
  const skill = skillText(SUBAGENT);

  it("forbids starting Sessions through the CLI", () => {
    expect(skill).toContain("actana session start");
    expect(skill.toLowerCase()).toContain("must not start sessions");
  });

  it("leaves a harness's own sub-agent facility alone, naming no harness", () => {
    // ADR 0035 D3. The prohibition is about one CLI verb; a vendor's in-process
    // task mechanism is a different thing with different bounds. The "naming no
    // harness" half is asserted by the D9 sweep above, over both files.
    expect(skill.toLowerCase()).toContain("native sub-agent facility");
    expect(skill.toLowerCase()).toContain("stays available");
  });

  it("says nothing about how to do the work", () => {
    // ADR 0035 D2, and the mechanism is specific: this skill is eager and the
    // skills an orchestrator passes alongside it were invoked, so working
    // advice from here would fight them and win. The list is small on purpose —
    // it catches the drift that starts a "how to write a good report" section.
    const lower = skill.toLowerCase();
    for (const outOfScope of [
      "how to plan",
      "write tests",
      "run the tests",
      "commit",
      "pull request",
      "step by step",
    ]) {
      expect(lower.includes(outOfScope), `the sub-agent skill advises on "${outOfScope}"`).toBe(
        false,
      );
    }
    expect(lower).toContain("says nothing about how to do the work");
  });
});
