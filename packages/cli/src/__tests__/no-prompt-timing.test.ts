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
//
// **Two files are allowed to hold a timer, and both are named here rather than
// waved through** (#161, merged into #160's rule; #402 added the second). Each
// buys the same thing and is admitted on the same three properties — the ones
// `--wait-timeout` already has. A listed timer **re-sends nothing**, it
// **cannot make the thing it waits for happen any sooner**, and its expiry is
// **reported as this side giving up** rather than as an outcome. A timer with
// all three is a limit on patience. A timer missing any of them is the 450 ms
// nudge wearing a table row as cover, and no reason admits it.
//
//   • `harness-command.ts` waits for a verdict a vendor installer takes minutes
//     to produce, so it carries a deadline and a progress tick of its own. It
//     re-sends no install, it cannot make a Harness look installed sooner, and
//     it expires saying "the Core reported no outcome within 15 minutes. The
//     install may still be running there." — this side giving up, never an
//     outcome. The difference from `--wait-timeout` is only which package the
//     timer object sits in, which is not the thing ADR 0026 moved.
//
//   • `events-command.ts` waits for a Core to answer `subscribe` at all (#402).
//     A contended Core that never replays sends no `event` and no
//     `eventsReplayed`, so an `events tail --limit` has neither its ceiling nor
//     the end of the log left to end on and waits for ever — which is what an
//     operator reported against a live Core, with the event they were waiting
//     for already in its database. The deadline re-sends no `subscribe`, it
//     cannot make an event arrive sooner, and it expires **non-zero**, saying
//     the Core stopped answering and that the read did not finish. It is
//     disarmed the moment the Core says where its log ends, and it is cleared
//     while the link is down, so it can only ever fire at a Core that is
//     connected and silent.
//
//     And note what it is not: this rule is about the path from an operator's
//     text to a Harness's stdin, and `events tail` is a read of a log with
//     nothing on that path at all. Being listed here does not exempt it from
//     `TOUCHES_A_SESSION` below, which is what would catch it if that ever
//     changed.
//
// The allowance is a table with a reason per row, so it stays a rule: a new
// timer in any other file still fails, a timer in a file that writes to a
// Session fails even if it is listed, and a row for a file that no longer
// exists fails rather than quietly widening. Growing the table is meant to cost
// a paragraph up here, argued the way the two above are — that cost is the rule
// working, not friction to route around.
//
// **Scoped to the client half since #288**, for the same reason and by the same
// table as the shell-out ban one file over (`module-halves.ts`). This package
// now also installs and operates the Core on the machine it runs on, and two of
// those verbs genuinely wait on a clock: `setup` and `update` poll the daemon's
// TCP port after `systemctl start`, because "the unit started" and "something
// is listening" are different facts and an operator who is told the first while
// the second is false has been told a lie. That is not the decision ADR 0026
// moved. Nothing on the path from an operator's text to a Harness's stdin is
// exempt — that path is entirely client-half, `TOUCHES_A_SESSION` bars a listed
// file from it anyway, and `actana-cli.ts` and `actana-cli-entry.ts` are
// deliberately left in the swept set.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SRC, clientSources, shippedSources, withoutComments } from "./module-halves.ts";

/** The ways a program schedules something for later. */
const SCHEDULERS = [
  /\bsetTimeout\s*\(/,
  /\bsetInterval\s*\(/,
  /\bsetImmediate\s*\(/,
  /\bqueueMicrotask\s*\(/,
  /\bnew\s+Promise\s*\([^)]*\)\s*=>\s*setTimeout/,
];

/**
 * The files allowed to schedule, and the reason each is.
 *
 * Two rows, and each buys a wait on a Core's own answer rather than a nudge at
 * a harness. Anything that writes to a Session is barred from this table by the
 * test below it — that is the boundary the rule is actually about.
 */
const SCHEDULING_ALLOWED: Record<string, string> = {
  "harness-command.ts":
    "waits for the Core's install verdict: a deadline on this side's patience and a progress tick, neither of which re-sends anything (#161)",
  "events-command.ts":
    "a deadline on a subscribe the Core never answers, so `--limit` cannot be wedged by a contended Core (#402). It re-sends nothing, it cannot make an event arrive sooner, and its expiry is reported as this side giving up",
};

/** Modules that put text or keystrokes into a Session. Never allowed a timer. */
const TOUCHES_A_SESSION = /session|prompt|pty|harness-resume/;

describe("the CLI schedules nothing (#129 D3, ADR 0026)", () => {
  it("has sources to sweep", () => {
    // The guard on the guard: a sweep over an empty list proves nothing.
    expect(shippedSources().length).toBeGreaterThan(5);
  });

  it("contains no timer, anywhere it is not named and argued for", () => {
    for (const file of clientSources()) {
      const name = path.relative(SRC, file);
      if (SCHEDULING_ALLOWED[name]) continue;
      const source = withoutComments(readFileSync(file, "utf8"));
      for (const scheduler of SCHEDULERS) {
        expect(
          scheduler.test(source),
          `${name} schedules something — prompt delivery is the Core's (ADR 0026)`,
        ).toBe(false);
      }
    }
  });

  it("keeps the allowance narrow: every row is a real file, and none writes to a Session", () => {
    // Two ways an allowlist stops meaning anything, both closed here. A row for
    // a deleted file is a hole left open for whatever takes that name next; a
    // row for a module that delivers input is the exact thing ADR 0026 forbids,
    // wearing the exception as cover.
    const shipped = new Set(shippedSources().map((file) => path.relative(SRC, file)));
    for (const [name, why] of Object.entries(SCHEDULING_ALLOWED)) {
      expect(shipped.has(name), `${name} is allowed to schedule but is not a shipped module`).toBe(
        true,
      );
      expect(why.length, `${name} is allowed to schedule with no reason given`).toBeGreaterThan(20);
      expect(
        TOUCHES_A_SESSION.test(name),
        `${name} writes to a Session and may not schedule, allowance or not`,
      ).toBe(false);
    }
  });

  it("bars a timer from every module that writes to a Session, listed or not", () => {
    // The rule at its narrowest, and the one no table can widen: the modules on
    // the path from an operator's text to a harness's stdin schedule nothing.
    for (const file of shippedSources()) {
      const name = path.relative(SRC, file);
      if (!TOUCHES_A_SESSION.test(name)) continue;
      const source = withoutComments(readFileSync(file, "utf8"));
      for (const scheduler of SCHEDULERS) {
        expect(scheduler.test(source), `${name} schedules something on a Session path`).toBe(false);
      }
    }
  });

  it("reads the clock in exactly one place, and only to print an age", () => {
    // `Date.now()` is bound once, in the entry file, and reaches the command
    // tree as an injected `now()` that two lines of formatting call: the
    // bearer-expiry line and `session ls`'s age column. A second reader would
    // be the beginning of something measuring elapsed time, which is what a
    // timing decision looks like before it grows a `setTimeout`.
    const readers = clientSources().filter((file) =>
      /\bDate\s*\.\s*now\s*\(/.test(withoutComments(readFileSync(file, "utf8"))),
    );
    expect(readers.map((file) => path.relative(SRC, file))).toEqual(["actana-cli-entry.ts"]);
  });

  it("never appends a carriage return to text on its way to a Session", () => {
    // `session send` writes one, as a **separate** write, because the operator
    // asked for a message to be sent — by default since #404, and under
    // `--enter` before it. What must not exist is a return glued onto somebody's
    // text: a harness that treats a paste as one unit swallows it, and gluing it
    // is also how a CLI starts deciding *when* a prompt is submitted rather than
    // *that* this one is — the decision ADR 0026 moved to the Core.
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
