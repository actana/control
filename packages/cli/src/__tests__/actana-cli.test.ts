// The root of the command tree — which noun you got, and what a script learns
// from the exit code (#129 D8, D10).
//
// `core-command.test.ts` covers the one noun this ticket builds. This covers
// the layer above it: the three answers a noun that is *not* `core` can get,
// and the fact that they are three rather than two. The distinction is the
// whole of `exit-codes.ts`'s argument, and until now nothing asserted it at the
// root — the reserved nouns exited `2` and `core shell` exited `3` for the same
// underlying fact, which the review of #201 caught.
//
// **Nothing in this build is reserved any more.** #160/#161 built the nouns,
// #162 built `core shell`, #163 built `session attach`, and #168 built the last
// two — `project cp` and `project files`. So what this suite asserts has turned
// over: not "a reservation answers 3", but "every name in the tree either works
// or is a typo, and the two are still told apart". The mechanism stays, because
// #210 and #211 are the next things that will want it, and because a script
// that already branches on 3 must keep meaning the same thing by it.

import { describe, it, expect, afterEach } from "vitest";
import { EXIT_OK, EXIT_UNIMPLEMENTED, EXIT_USAGE } from "../exit-codes.ts";
import { CLI_VERSION } from "../actana-cli.ts";
import { makeCliFixture, type CliFixture } from "./cli-harness.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/**
 * Every name in the tree, noun and verb, run with no arguments.
 *
 * The sweep that replaced the reservation table. A verb here may well answer
 * `EXIT_USAGE` — most of them need arguments — and that is fine: what none of
 * them may do is answer `EXIT_UNIMPLEMENTED`, because that is the code for "not
 * on this train" and there is nothing left on the list.
 */
const EVERY_NAME = [
  ["core", "ls"],
  ["core", "status"],
  ["core", "shell"],
  ["project", "ls"],
  ["project", "add"],
  ["project", "browse"],
  ["project", "cp"],
  ["project", "files"],
  ["harness", "ls"],
  ["events", "tail"],
  ["session", "ls"],
  ["session", "attach"],
] as const;

/** The nouns that are built, so the help below cannot go quiet about them. */
const BUILT = ["core", "project", "harness", "events", "session"] as const;

describe("nothing is reserved any more, and a typo is still a typo", () => {
  it("answers `not built yet` for no name in the tree", async () => {
    // The list emptied one ticket at a time and #168 took the last two off it.
    // A name here that still answered 3 would be a build advertising a train
    // that has already arrived.
    for (const argv of EVERY_NAME) {
      const run = await cli().run([...argv]);
      expect(run.code, argv.join(" ")).not.toBe(EXIT_UNIMPLEMENTED);
      expect(run.err.join("\n"), argv.join(" ")).not.toContain("not built yet");
    }
  });

  it("keeps the three codes three, so a script that branches on them still can", () => {
    // The mechanism outlives the last reservation on purpose: `project rm`
    // (#210) and `--model` (#211) are the next names that will need it, and a
    // code re-used in the meantime would silently change what a script reading
    // `3` is being told.
    expect(new Set([EXIT_OK, EXIT_USAGE, EXIT_UNIMPLEMENTED]).size).toBe(3);
  });

  it("still separates a name that does not exist from one that does", async () => {
    // The distinction this must not collapse: `sessoin` has no ticket number
    // and no later train that fixes it, and a script that retries on 3 must not
    // retry on it.
    const typo = await cli().run(["sessoin"]);
    expect(typo.code).toBe(EXIT_USAGE);
    expect(typo.err.join("\n")).toContain('unknown command "sessoin"');
    expect(typo.err.join("\n")).not.toContain("not built yet");
  });

  it("keeps `cp` a typo at the root: the noun grammar holds (D8, F12)", async () => {
    // #168 built `project cp` and deliberately did not build `actana cp`. The
    // shorter name has to stay an unknown noun, or the grammar has a hole in it
    // that nobody documented.
    const run = await cli().run(["cp", "./a", "api:b"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain('unknown command "cp"');
  });

  it("no longer answers `daemon` with a wrong-package refusal (#288)", async () => {
    // This assertion is inverted from what it was, and the inversion is the
    // point. Until 0.4.0 `actana daemon` here printed *running a Core is not
    // this package's half of `actana`* — a message that existed only because
    // two programs shared one name, and whose whole job was to explain which
    // of the two the operator had installed. There is one program now, so the
    // message is deleted rather than reworded: the confusion it explained
    // cannot occur.
    //
    // What `daemon` does instead is run the Core, which needs a Core on this
    // machine — so what a fixture with no install can assert is that the
    // refusal is gone and the verb is dispatched.
    const run = await cli()
      .run(["daemon"], { machine: { runDaemon: async () => {} } })
      .catch((err: unknown) => ({ code: -1, out: [], err: [String(err)], all: String(err) }));
    expect(run.err.join("\n")).not.toContain("not this package's half");
    expect(run.err.join("\n")).not.toContain("unknown command");
    expect(run.code).toBe(0);
  });
});

describe("the root itself", () => {
  it("prints the help and succeeds when asked nothing", async () => {
    const run = await cli().run([]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toContain("actana <noun> <verb>");
  });

  it("advertises no reserved noun, because there is none left to advertise", async () => {
    // The root help and the dispatch table read from the same fact, and the
    // fact is now "every noun in the tree is built". A "Reserved, landing later
    // in this phase" heading with nothing under it is how a help text starts
    // lying about a build.
    const run = await cli().run(["--help"]);
    expect(run.out.join("\n")).not.toContain("Reserved, landing later");
  });

  it("advertises no reserved verb either, now that there is none", async () => {
    // The counterpart to the noun assertion above: a "Reserved, landing in
    // phase 3" heading over verbs this build ships is the same lie one line
    // further down the tree.
    for (const noun of BUILT) {
      const run = await cli().run([noun, "--help"]);
      expect(run.out.join("\n"), `${noun} --help`).not.toContain("Reserved, landing");
    }
  });

  it("lists every built noun in the help too", async () => {
    // The other half, and the one a reservation turns into: a noun that works
    // and is not in the help is a noun nobody finds.
    const run = await cli().run(["--help"]);
    for (const noun of BUILT) expect(run.out.join("\n"), `${noun} is not in the help`).toContain(noun);
  });

  it("prints the train's version", async () => {
    // One version answer (#288). A CLI with no Core installed under it says
    // one line; `actana-machine-cli.test.ts` covers the second line a machine
    // with a Core on a different version gets.
    const run = await cli().run(["--version"]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toBe(`actana ${CLI_VERSION}`);
  });
});
