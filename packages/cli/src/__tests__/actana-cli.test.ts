// The root of the command tree — which noun you got, and what a script learns
// from the exit code (#129 D8, D10).
//
// `core-command.test.ts` covers the one noun this ticket builds. This covers
// the layer above it: the three answers a noun that is *not* `core` can get,
// and the fact that they are three rather than two. The distinction is the
// whole of `exit-codes.ts`'s argument, and until now nothing asserted it at the
// root — the reserved nouns exited `2` and `core shell` exited `3` for the same
// underlying fact, which the review of #201 caught. #162 built `core shell` and
// #160/#161 built the nouns, so what is reserved here is verbs inside a built
// noun: `project cp` and `project files`. `session attach` was the third until
// #163 built it, and it is the counter-example below — the thing a reservation
// is supposed to stop being.

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
 * The reservations this build carries, and the ticket each names.
 *
 * No *noun* is reserved any more: `session` left the list when #160 built it
 * and `project`, `harness` and `events` left when #161 did, which is the shape
 * a reservation is supposed to end in. `session attach` left it the same way
 * when #163 built it. What is still reserved is a verb waiting on phase 3 — and
 * the distinction the exit code draws is the same one either way, so these are
 * what assert it.
 */
const RESERVED = [
  [["project", "cp"], "#168"],
  [["project", "files"], "#168"],
] as const;

/** The nouns that are built, so the help below cannot go quiet about them. */
const BUILT = ["core", "project", "harness", "events", "session"] as const;

describe("a reservation is `not built yet`, not `you typed it wrong`", () => {
  it.each(RESERVED)("exits EXIT_UNIMPLEMENTED for `actana %s`, naming its ticket", async (argv, ticket) => {
    const run = await cli().run([...argv]);
    // 3, not 2. A script written against a later train hits one of these long
    // before it hits anything else, so this is the case the distinction was
    // really written for — and it is the one that had it backwards.
    expect(run.code).toBe(EXIT_UNIMPLEMENTED);
    expect(run.err.join("\n")).toContain("not built yet");
    expect(run.err.join("\n")).toContain(ticket);
  });

  it("is the answer for a name that is reserved, and not for one that is built", async () => {
    // `core shell` was the reserved *verb* and shared this code until #162
    // built it; `session attach` was the last one and #163 built it. Now they
    // are commands like any other, and a build that answered `3` for either
    // would be telling a script to come back on a later train for something
    // already shipped.
    const reserved = await cli().run(["project", "cp"]);
    expect(reserved.code).toBe(EXIT_UNIMPLEMENTED);
    for (const built of [["core", "shell"], ["session", "attach"]]) {
      const run = await cli().run(built);
      expect(run.code, built.join(" ")).not.toBe(EXIT_UNIMPLEMENTED);
    }
  });

  it("answers the same for every reserved verb, and not for a built one beside it", async () => {
    // One fact about this build, one exit code — and it has to stay a *fact
    // about the build* rather than about a file. `project cp` and `project ls`
    // sit in the same module and differ only in whether they are built, which
    // is the difference the code is supposed to carry.
    const cp = await cli().run(["project", "cp"]);
    const files = await cli().run(["project", "files"]);
    expect(cp.code).toBe(files.code);
    const built = await cli().run(["project", "ls"]);
    expect(built.code).not.toBe(cp.code);
  });

  it("dials nothing to say it — a reservation is answered before a Core is", async () => {
    // The fixture throws on `connect`, so a reserved verb that reached the wire
    // would fail here rather than pass. "Not built yet" is a fact about this
    // build and needs no Core's opinion, which is also why it is the one answer
    // that works with no Core registered at all.
    for (const [argv] of RESERVED) {
      const run = await cli().run([...argv]);
      expect(run.code, argv.join(" ")).toBe(EXIT_UNIMPLEMENTED);
    }
  });

  it("still separates a reservation from a typo", async () => {
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

  it("advertises no reserved noun, because there is none left to advertise", async () => {
    // The root help and the dispatch table read from the same fact, and the
    // fact is now "every noun in the tree is built". A "Reserved, landing later
    // in this phase" heading with nothing under it is how a help text starts
    // lying about a build.
    const run = await cli().run(["--help"]);
    expect(run.out.join("\n")).not.toContain("Reserved, landing later");
  });

  it("keeps each reserved verb's ticket in the help of the noun that owns it", async () => {
    // The reservations that are left are verbs, and a reserved verb nobody can
    // find in `--help` is a reservation only the source knows about.
    for (const [argv, ticket] of RESERVED) {
      const run = await cli().run([argv[0], "--help"]);
      const help = run.out.join("\n");
      expect(help, `${argv.join(" ")} is not in \`actana ${argv[0]} --help\``).toContain(argv[1]);
      expect(help, `${argv.join(" ")} does not name ${ticket}`).toContain(ticket);
    }
  });

  it("lists every built noun in the help too", async () => {
    // The other half, and the one a reservation turns into: a noun that works
    // and is not in the help is a noun nobody finds.
    const run = await cli().run(["--help"]);
    for (const noun of BUILT) expect(run.out.join("\n"), `${noun} is not in the help`).toContain(noun);
  });

  it("prints the train's version", async () => {
    const run = await cli().run(["--version"]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toBe(`actana ${CLI_VERSION}`);
  });
});
