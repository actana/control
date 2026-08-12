// The root of the command tree — which noun you got, and what a script learns
// from the exit code (#129 D8, D10).
//
// `core-command.test.ts` covers the one noun this ticket builds. This covers
// the layer above it: the three answers a noun that is *not* `core` can get,
// and the fact that they are three rather than two. The distinction is the
// whole of `exit-codes.ts`'s argument, and until now nothing asserted it at the
// root — the reserved nouns exited `2` and `core shell` exited `3` for the same
// underlying fact, which the review of #201 caught. #162 built `core shell`, so
// what is reserved here is nouns.

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

/** Every noun reserved in the tree, and the ticket each names. */
const RESERVED = [
  ["session", "#160"],
  ["project", "#161"],
  ["harness", "#161"],
  ["events", "#161"],
] as const;

describe("a reserved noun is `not built yet`, not `you typed it wrong`", () => {
  it.each(RESERVED)("exits EXIT_UNIMPLEMENTED for `%s`, naming its ticket", async (noun, ticket) => {
    const run = await cli().run([noun]);
    // 3, not 2. A script written against a later train hits one of these long
    // before it hits `core shell`, so this is the case the distinction was
    // really written for — and it is the one that had it backwards.
    expect(run.code).toBe(EXIT_UNIMPLEMENTED);
    expect(run.err.join("\n")).toContain("not built yet");
    expect(run.err.join("\n")).toContain(ticket);
  });

  it("is the answer for a name that is reserved, and not for one that is built", async () => {
    // `core shell` was the reserved *verb* and shared this code until #162
    // built it. Now it is a command like any other, and a build that answered
    // `3` for it would be telling a script to come back on a later train for
    // something already shipped.
    const noun = await cli().run(["session"]);
    expect(noun.code).toBe(EXIT_UNIMPLEMENTED);
    const built = await cli().run(["core", "shell"]);
    expect(built.code).not.toBe(EXIT_UNIMPLEMENTED);
  });

  it("still separates a reserved noun from a typo", async () => {
    // The distinction this must not collapse: `sessoin` has no ticket number
    // and no later train that fixes it, and a script that retries on 3 must not
    // retry on it.
    const typo = await cli().run(["sessoin"]);
    expect(typo.code).toBe(EXIT_USAGE);
    expect(typo.err.join("\n")).toContain('unknown noun "sessoin"');
    expect(typo.err.join("\n")).not.toContain("not built yet");
  });

  it("keeps `daemon` a usage error — it is the wrong package, not a later train", async () => {
    // Deliberately 2 and not 3. Nothing in this phase, or any phase, makes
    // `actana daemon` work here: the Core's tarball is where that half of the
    // command name lives (#129 D8). "Not built yet" would promise a train that
    // is never coming.
    const run = await cli().run(["daemon"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("not this package's half");
  });
});

describe("the root itself", () => {
  it("prints the help and succeeds when asked nothing", async () => {
    const run = await cli().run([]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toContain("actana <noun> <verb>");
  });

  it("lists every reserved noun in the help, with its ticket", async () => {
    // The help and the dispatch reading from one table is what keeps a noun
    // from being reserved in one and not the other.
    const run = await cli().run(["--help"]);
    for (const [noun] of RESERVED) expect(run.out.join("\n")).toContain(noun);
  });

  it("prints the train's version", async () => {
    const run = await cli().run(["--version"]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toBe(`actana ${CLI_VERSION}`);
  });
});
