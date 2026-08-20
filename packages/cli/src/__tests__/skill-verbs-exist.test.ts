// Every verb the `actana-sessions` skill teaches exists on the binary the skill
// lands beside (#288).
//
// This is the complaint the ticket opens with, turned into a test. ADR 0031 D3
// makes installing the skill mandatory, and two different programs installed
// it: `packages/core/src/core-entry.ts` writes it at boot on every Core, and
// the CLI writes it in front of the first noun an operator runs. Until 0.4.0
// the first of those two put a skill teaching `actana core ls`, `actana session
// start` and `actana events tail` onto a machine whose `actana` answered
// `unknown command` to all three. **The skill was dishonest on the machine the
// Core itself put it on**, and nothing failed but the agent reading it.
//
// So the payload and the dispatch are checked against each other. The payload
// is prose with fenced `bash` blocks in it, and what is extracted from it is
// every `actana <name> …` invocation it shows an agent how to type; each name
// has to be one this build dispatches. A skill that documents a verb the binary
// lacks fails CI rather than failing an agent at three in the morning.
//
// **Read off the authored source, not off a generated copy.** The two embedded
// copies are held to the authored file by
// `packages/shared/src/__tests__/orchestration-skill-fanout.test.ts`; this test
// is about a different axis — the skill against the *program* — and reading the
// authored markdown is what makes a failure here point at the sentence somebody
// wrote rather than at a generator's output.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CLIENT_NOUNS, USAGE } from "../actana-cli.ts";

/** The authored skill, at the repository root. */
const SKILL = path.resolve(
  import.meta.dirname,
  "../../../../.agents/skills/actana-sessions/SKILL.md",
);

/**
 * Every `actana <name>` the skill shows an agent how to type.
 *
 * Deliberately over-inclusive: prose mentions in backticks count as well as
 * fenced blocks, because an agent reading "run `actana core use <name>`" will
 * run it. A false positive here is a name the skill should not have printed.
 */
function namesTaughtBySkill(): string[] {
  const text = readFileSync(SKILL, "utf8");
  const names = new Set<string>();
  for (const match of text.matchAll(/\bactana\s+([a-z][a-z-]*)/g)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

/** The names `actana --help` advertises, from both of its command blocks. */
function namesInHelp(): string[] {
  const names = new Set<string>();
  for (const heading of ["Cores this machine can reach", "This machine's own Core"]) {
    const block = USAGE.split(new RegExp(`^${heading}$`, "m"))[1]?.split(/\n\s*\n/)[0] ?? "";
    for (const line of block.split("\n")) {
      const match = /^ {2}([a-z][a-z-]*)/.exec(line);
      if (match) names.add(match[1]!);
    }
  }
  return [...names].sort();
}

describe("the skill only teaches verbs this binary has (#288)", () => {
  it("finds something to check", () => {
    // The guard on the guard. A regex that stopped matching would make every
    // assertion below vacuously true, which is the failure mode a sweep has.
    const taught = namesTaughtBySkill();
    expect(taught.length).toBeGreaterThan(3);
    expect(taught).toContain("core");
    expect(taught).toContain("session");
  });

  it("teaches no name the CLI does not answer to", () => {
    const known = new Set([...namesInHelp(), ...CLIENT_NOUNS, "daemon", "help"]);
    for (const name of namesTaughtBySkill()) {
      expect(known.has(name), `the skill teaches \`actana ${name}\`, which this build has no case for`).toBe(
        true,
      );
    }
  });

  it("teaches the client nouns, which is the point of it on a Core", () => {
    // The other direction, and the one that was actually broken: the skill's
    // whole subject is driving Cores, so it must teach the nouns that do it —
    // and a Core machine's `actana` must have them. Both halves are asserted
    // here because the failure was the gap between them.
    const taught = new Set(namesTaughtBySkill());
    for (const noun of CLIENT_NOUNS) {
      expect(taught.has(noun), `the skill never shows \`actana ${noun}\``).toBe(true);
    }
  });

  it("no longer tells an agent that an empty `core ls` means nobody paired the machine", () => {
    // #288 D9. On a Core machine the local Core is registered by the install
    // itself, so "the operator has not paired this machine with a Core" is
    // false exactly where the Core put the skill.
    const text = readFileSync(SKILL, "utf8");
    expect(text).not.toContain("the operator has not\n  paired this machine with a Core");
    expect(text).toContain("a machine running a Core registers it automatically");
  });
});
