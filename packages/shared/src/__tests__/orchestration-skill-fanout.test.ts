// What ADR 0031 asks CI to hold about the fan-out table, rather than a reviewer: **exhaustiveness** — a
// new member of `HARNESSES` with no skill target fails here, by name. The type system already catches
// the omission in `HARNESS_CLI_CONFIG` (`as const satisfies Record<Harness, …>`); this is the belt to
// that pair of braces, and it is the assertion that survives somebody widening the type.
//
// The other two things this file held went with the in-repo payload (#580): the drift between the
// embedded copies and the authored folders, and the prose checks on the skill text. The skill is the
// published `@actana/cli`'s now, imported from its root by the Core's boot install, and its text is
// held where it is authored; `packages/cli/src/__tests__/one-skill-payload.test.ts` is what holds that
// the repository has exactly one payload source.

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { HARNESSES } from "../domain";
import { HARNESS_CLI_CONFIG, HARNESS_SKILL_TARGETS } from "../harness-cli-config";
import { withPiHomeMarkersResolved } from "../pi-agent-dir";

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

  it("writes skills only into home-relative directories; markers may be absolute for Pi", () => {
    // skillDir stays home-relative always. homeMarkers are home-relative for
    // every harness except when Pi's `$PI_CODING_AGENT_DIR` sits outside home
    // (#518 part 3) — Node's path.join then keeps the absolute segment, so the
    // installer still finds it.
    for (const harness of HARNESSES) {
      const { skillDir, homeMarkers } = HARNESS_CLI_CONFIG[harness].skillTarget;
      expect(skillDir.startsWith("/"), `${harness}: skillDir ${skillDir} is absolute`).toBe(false);
      expect(skillDir.includes(".."), `${harness}: skillDir ${skillDir} escapes the home dir`).toBe(
        false,
      );
      for (const segment of homeMarkers) {
        if (path.isAbsolute(segment)) {
          expect(harness, `${harness}: absolute marker ${segment}`).toBe("pi");
          continue;
        }
        expect(segment.includes(".."), `${harness}: ${segment} escapes the home dir`).toBe(false);
      }
    }
  });

  it("keeps a static .pi marker in the table; call sites resolve PI_CODING_AGENT_DIR", () => {
    // Tables stay Node-free (Panel bundle). withPiHomeMarkersResolved at the
    // Core/CLI fan-out entry points applies piHomeMarkers against the call-time
    // env (#518 part 3 gate follow-up).
    expect(HARNESS_CLI_CONFIG.pi.skillTarget.homeMarkers).toEqual([".pi"]);
    expect(withPiHomeMarkersResolved(HARNESS_SKILL_TARGETS, {}, "/home/op").find((r) => r.harness === "pi")!.homeMarkers).toEqual([
      ".pi",
    ]);
    expect(
      withPiHomeMarkersResolved(
        HARNESS_SKILL_TARGETS,
        { PI_CODING_AGENT_DIR: "~/moved/agent" },
        "/home/op",
      ).find((r) => r.harness === "pi")!.homeMarkers,
    ).toEqual(["moved/agent"]);
  });
});
