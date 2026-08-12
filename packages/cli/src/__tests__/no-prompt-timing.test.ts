// Prompt delivery is the Core's job, and this is what keeps it that way (#160,
// #129 D3, ADR 0026).
//
// The trap this suite exists for is not hypothetical — it is the 450 ms
// `initialInput` timer #191 deleted from the Core, and the shape it takes in a
// client is always the same: a harness misses a prompt, somebody adds "wait a
// moment, then press Enter again" to whichever program is closest to the
// complaint, and the bug moves from one machine that could fix it to every
// client that could not. So the rule is a property of the package rather than a
// paragraph in a header:
//
//   **Nothing shipped in `packages/cli` schedules anything.** No timer, no
//   sleep, no delay, no retry loop, and no carriage return appended to text on
//   its way to a Session. A prompt that does not arrive is a Core bug, and it
//   must stay visible as one.
//
// The one deadline the CLI does have — `session start --wait --wait-timeout` —
// is a number handed to the SDK's `waitForIdle`, which is watching the Core's
// event log. It cannot make a Session look ready sooner, it cannot re-send
// anything, and its expiry is reported as this side giving up rather than as a
// status. Passing a number is not scheduling; that is why the sweep below looks
// for the scheduling primitives themselves.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "..");

/** Every shipped module — this package's own source at any depth, tests excluded. */
function shippedSources(dir: string = SRC): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      files.push(...shippedSources(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Source with its comments removed.
 *
 * Every file in this package explains the rule it obeys, and those headers name
 * the very things swept for — `setTimeout`, the 450 ms timer, the carriage
 * return the Core sends. Scanning the prose would make documenting a rule
 * indistinguishable from breaking it.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[^\n"'`]*\/\/[^\n]*$/gm, "");
}

/** The ways a program schedules something for later. */
const SCHEDULERS = [
  /\bsetTimeout\s*\(/,
  /\bsetInterval\s*\(/,
  /\bsetImmediate\s*\(/,
  /\bqueueMicrotask\s*\(/,
  /\bnew\s+Promise\s*\([^)]*\)\s*=>\s*setTimeout/,
];

describe("the CLI schedules nothing (#129 D3, ADR 0026)", () => {
  it("has sources to sweep", () => {
    // The guard on the guard: a sweep over an empty list proves nothing.
    expect(shippedSources().length).toBeGreaterThan(5);
  });

  it("contains no timer, anywhere", () => {
    for (const file of shippedSources()) {
      const source = withoutComments(readFileSync(file, "utf8"));
      for (const scheduler of SCHEDULERS) {
        expect(
          scheduler.test(source),
          `${path.relative(SRC, file)} schedules something — prompt delivery is the Core's (ADR 0026)`,
        ).toBe(false);
      }
    }
  });

  it("reads the clock in exactly one place, and only to print an age", () => {
    // `Date.now()` is bound once, in the entry file, and reaches the command
    // tree as an injected `now()` that two lines of formatting call: the
    // bearer-expiry line and `session ls`'s age column. A second reader would
    // be the beginning of something measuring elapsed time, which is what a
    // timing decision looks like before it grows a `setTimeout`.
    const readers = shippedSources().filter((file) =>
      /\bDate\s*\.\s*now\s*\(/.test(withoutComments(readFileSync(file, "utf8"))),
    );
    expect(readers.map((file) => path.relative(SRC, file))).toEqual(["actana-cli-entry.ts"]);
  });

  it("never appends a carriage return to text on its way to a Session", () => {
    // `session send --enter` writes one, as a **separate** write, because the
    // operator asked for it in that invocation. What must not exist is a return
    // glued onto somebody's text — that is the CLI deciding when a prompt is
    // submitted, which is the decision ADR 0026 moved to the Core.
    for (const file of shippedSources()) {
      const source = withoutComments(readFileSync(file, "utf8"));
      expect(source, `${path.relative(SRC, file)} appends a carriage return to text`).not.toMatch(
        /(text|prompt|data|input)\s*\+\s*["'`]\\r/,
      );
      expect(source, `${path.relative(SRC, file)} interpolates a carriage return after text`).not.toMatch(
        /\$\{\s*(text|prompt|data|input)\s*\}\\r/,
      );
    }
  });
});
