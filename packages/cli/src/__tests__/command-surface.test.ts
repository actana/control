// The whole command surface, noun by noun, verb by verb, flag by flag (#580, T-403).
//
// T-403 moves the client half of `actana` behind the published `@actana/cli`'s
// `runClient`. The promise of that move is that nothing an operator or a script
// types today changes meaning, so this table was recorded against the code
// *before* the move and has to stay green after it. Each row is one argv, run
// through `runActanaCli` with the fixture's refusing dependencies (no Core, no
// system), and pins what a script can see: the exit code, the first line of
// stderr (a prefix of it) and, where the command prints, the first line of stdout.
//
// The rows tagged INTENDED are the additions this ticket is *for*: `files`
// and `shared` arrive with `runClient`. They are listed apart so the diff that
// turns them from "unknown command" into a recognised noun is one small hunk.
// `search` is not part of this release and stays refused exactly as before.

import { describe, it, expect, afterEach } from "vitest";
import { CLI_VERSION } from "../actana-cli.ts";
import { makeCliFixture, type CliFixture } from "./cli-harness.ts";

type Row = readonly [argv: string[], code: number | "throw", errPrefix: string, outPrefix: string];

let fixture: CliFixture | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

async function run(argv: string[]) {
  fixture = makeCliFixture();
  try {
    const r = await fixture.run(argv);
    return { code: r.code as number | "throw", err: r.err.join("\n"), out: r.out.join("\n") };
  } catch (e) {
    return { code: "throw" as const, err: String(e), out: "" };
  }
}

const SURFACE: Row[] = [
  [["core","pair"], 2, "actana core pair: a name, an address and a code are required", ""],
  [["core","ls"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","list"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","use"], 2, "actana core use: a name is required — `actana core use <name", ""],
  [["core","rm"], 2, "actana core rm: a name is required — `actana core rm <name>`", ""],
  [["core","remove"], 2, "actana core rm: a name is required — `actana core rm <name>`", ""],
  [["core","status"], 1, "actana core status: no Core selected. Pass --core <name>, se", ""],
  [["core","shell"], 2, "actana core shell: this is an interactive command and stdin/", ""],
  [["core","exec"], 2, "actana core exec: a command is required — `actana core exec ", ""],
  [["core","bogus"], 2, "actana core: unknown verb \"bogus\".", ""],
  [["harness","ls"], 1, "actana harness ls: no Core selected. Pass --core <name>, set", ""],
  [["harness","list"], 1, "actana harness ls: no Core selected. Pass --core <name>, set", ""],
  [["harness","install"], 2, "actana harness install: a Harness id is required —", ""],
  [["harness","skills"], 0, "No Harness of the four this build knows has a directory in t", "HARNESS      RESULT  SKILL FOLDER"],
  [["harness","bogus"], 2, "actana harness: unknown verb \"bogus\".", ""],
  [["events","tail"], 1, "actana events tail: no Core selected. Pass --core <name>, se", ""],
  [["events","bogus"], 2, "actana events: unknown verb \"bogus\".", ""],
  [["session","start"], 1, "actana session start: no Core selected. Pass --core <name>, ", ""],
  [["session","ls"], 1, "actana session ls: no Core selected. Pass --core <name>, set", ""],
  [["session","list"], 1, "actana session ls: no Core selected. Pass --core <name>, set", ""],
  [["session","logs"], 2, "actana session logs: a session id is required — `actana sess", ""],
  [["session","resume"], 2, "actana session resume: a session id is required — `actana se", ""],
  [["session","send"], 2, "actana session send: a session id is required — `actana sess", ""],
  [["session","wait"], 2, "actana session wait: a session id is required — `actana sess", ""],
  [["session","kill"], 2, "actana session kill: a session id is required — `actana sess", ""],
  [["session","attach"], 2, "actana session attach: a session id is required — `actana se", ""],
  [["session","bogus"], 2, "actana session: unknown verb \"bogus\".", ""],
  [["install"], 1, "could not fetch https://api.github.com/repos/actana/control/", ""],
  [["place"], 1, "there is no extracted Core bundle here to place. `actana pla", ""],
  [["setup"], 1, "could not fetch https://api.github.com/repos/actana/control/", ""],
  [["status"], 1, "", ""],
  [["token"], 2, "There is no pairing token to print. A client enrolls with a ", ""],
  [["update"], 1, "No Core is installed for this user. Run `actana setup` first", ""],
  [["start"], 1, "No Core is installed for this user. Run `actana setup` first", ""],
  [["stop"], 1, "No Core is installed for this user. Run `actana setup` first", ""],
  [["restart"], 1, "No Core is installed for this user. Run `actana setup` first", ""],
  [["logs"], 1, "No Core is installed for this user. Run `actana setup` first", ""],
  [["harnesses"], 2, "actana harnesses needs a subcommand.", ""],
  [["uninstall"], 0, "", "There was no Core installed for this user."],
  [["daemon"], "throw", "Error: this test did not expect to start a daemon", ""],
  [["help"], 0, "", "actana — drive AI coding agents across your Cores,"],
  [["bogus"], 2, "actana: unknown command \"bogus\".", ""],
  // INTENDED additions (#580): `files` and `shared` arrive with runClient. These rows answered
  // `unknown command` before the move; everything above and below them did not change.
  [["files"], 2, "", "actana files — a Core's files"],
  [["files","ls"], 1, "actana files ls: no Core selected.", ""],
  [["files","bogus"], 2, "actana files: unknown verb \"bogus\".", ""],
  [["files","--help"], 0, "", "actana files — a Core's files"],
  [["shared"], 2, "", "actana shared — a Core's Shared folder"],
  [["shared","ls"], 1, "actana shared ls: no Core selected.", ""],
  [["shared","bogus"], 2, "actana shared: unknown verb \"bogus\".", ""],
  [["search"], 2, "actana: unknown command \"search\".", ""],
  [["token","regenerate"], 1, "No Core is installed for this user. Run `actana setup` first", ""],
  [["pair","new"], 1, "No Core is installed for this user. Run `actana setup` first", ""],
  [["pair","ls"], 1, "No Core is installed for this user. Run `actana setup` first", ""],
  [["pair","list"], 1, "No Core is installed for this user. Run `actana setup` first", ""],
  [["pair","revoke"], 2, "actana pair revoke: a target is required — `actana pair revo", ""],
  [["pair","bogus"], 2, "actana pair: unknown verb \"bogus\".", ""],
  [["harnesses","install"], 2, "actana harnesses install <id> — name the Harness to install.", ""],
  [["session","ls","--json"], 1, "actana session ls: no Core selected. Pass --core <name>, set", ""],
  [["session","ls","--verbose"], 1, "actana session ls: no Core selected. Pass --core <name>, set", ""],
  [["session","ls","--sha256"], 1, "actana session ls: no Core selected. Pass --core <name>, set", ""],
  [["session","ls","--wait"], 2, "actana session ls: --wait does not apply here.", ""],
  [["session","ls","--await-prompt"], 2, "actana session ls: --await-prompt does not apply here.", ""],
  [["session","ls","--raw"], 2, "actana session ls: --raw does not apply here.", ""],
  [["session","ls","--enter"], 2, "actana session ls: --enter does not apply here.", ""],
  [["session","ls","--no-enter"], 2, "actana session ls: --no-enter does not apply here.", ""],
  [["session","ls","--dangerously-skip-permissions"], 2, "actana session ls: --dangerously-skip-permissions does not a", ""],
  [["session","ls","--read-only"], 2, "actana session ls: --read-only does not apply here.", ""],
  [["session","ls","-h"], 0, "", "actana session — the Sessions running on a Core"],
  [["session","ls","--help"], 0, "", "actana session — the Sessions running on a Core"],
  [["session","ls","-V"], 1, "actana session ls: no Core selected. Pass --core <name>, set", ""],
  [["session","ls","--version"], 1, "actana session ls: no Core selected. Pass --core <name>, set", ""],
  [["session","ls","--bogus"], 2, "actana: unknown flag --bogus.", ""],
  [["core","ls","--core","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--since","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--kind","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--limit","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--depth","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--wait-timeout","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--harness","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--cwd","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--title","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--fingerprint","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--session","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--label","x"], 0, "", "No Cores registered. `actana core pair <name> <add"],
  [["core","ls","--core"], 2, "actana: --core needs a value.", ""],
  [["core","ls","--since"], 2, "actana: --since needs a value.", ""],
  [["core","ls","--kind"], 2, "actana: --kind needs a value.", ""],
  [["core","ls","--limit"], 2, "actana: --limit needs a value.", ""],
  [["core","ls","--depth"], 2, "actana: --depth needs a value.", ""],
  [["core","ls","--wait-timeout"], 2, "actana: --wait-timeout needs a value.", ""],
  [["core","ls","--harness"], 2, "actana: --harness needs a value.", ""],
  [["core","ls","--cwd"], 2, "actana: --cwd needs a value.", ""],
  [["core","ls","--title"], 2, "actana: --title needs a value.", ""],
  [["core","ls","--fingerprint"], 2, "actana: --fingerprint needs a value.", ""],
  [["core","ls","--session"], 2, "actana: --session needs a value.", ""],
  [["core","ls","--label"], 2, "actana: --label needs a value.", ""],
  [["status","--port","x"], 2, "unknown option: --port", ""],
  [["status","--host","x"], 2, "unknown option: --host", ""],
  [["status","--public-host","x"], 2, "unknown option: --public-host", ""],
  [["status","--label","x"], 2, "unknown option: --label", ""],
  [["status","--version","x"], 2, "unknown option: --version", ""],
  [["status","--repo","x"], 2, "unknown option: --repo", ""],
  [["status","--base-url","x"], 2, "unknown option: --base-url", ""],
  [["status","-n","x"], 2, "unknown option: -n", ""],
  [["status","--lines","x"], 2, "unknown option: --lines", ""],
  [["status","--no-harnesses"], 2, "unknown option: --no-harnesses", ""],
  [["status","--yes"], 2, "unknown option: --yes", ""],
  [["status","--purge-data"], 2, "unknown option: --purge-data", ""],
  [["status","-f"], 2, "unknown option: -f", ""],
  [["status","--follow"], 2, "unknown option: --follow", ""],
  [["status","--bogus"], 2, "unknown option: --bogus", ""],
  [["--version"], 0, "", "actana " + CLI_VERSION],
  [["-V"], 0, "", "actana " + CLI_VERSION],
  [["-v"], 0, "", "actana " + CLI_VERSION],
  [["--help"], 0, "", "actana — drive AI coding agents across your Cores,"],
  [["-h"], 0, "", "actana — drive AI coding agents across your Cores,"],
  [["--json","core","ls"], 0, "", "[]"],
  [["core","ls","--json"], 0, "", "[]"],
];

describe("the command surface", () => {
  it.each(SURFACE.map((r) => [r[0].join(" "), r] as const))("%s", async (_name, row) => {
    const [argv, code, errPrefix, outPrefix] = row;
    const got = await run(argv);
    expect(got.code).toBe(code);
    if (errPrefix === "") {
      // Where the command said nothing on stderr, it must still say nothing:
      // a new warning on stderr is a change a script reading it can see.
      if (code === 0) expect(got.err).toBe("");
    } else {
      expect(got.err).toContain(errPrefix);
    }
    if (outPrefix !== "") expect(got.out).toContain(outPrefix);
  });

  it("refuses `search` as an unknown command, as it always has", async () => {
    const got = await run(["search"]);
    expect(got.code).toBe(2);
    expect(got.err).toContain('actana: unknown command "search".');
  });
});

describe("INTENDED: the nouns runClient adds", () => {
  it("lists files and shared in `actana --help`, and still not search", async () => {
    const got = await run(["--help"]);
    expect(got.code).toBe(0);
    expect(got.out).toMatch(/^ {2}files {6}ls, get, put, rm/m);
    expect(got.out).toMatch(/^ {2}shared {5}ls, get, put, rm, mkdir, watch/m);
    expect(got.out).not.toMatch(/^ {2}search\b/m);
  });
});
