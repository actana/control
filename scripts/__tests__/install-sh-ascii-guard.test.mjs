// The #346 regression guard, exercised rather than eyeballed.
//
// #346 was one character: `say "Downloading $asset…"` in `install.sh`. On
// macOS — bash 3.2.57 under a UTF-8 locale, which is every Mac — the
// identifier scan runs past `asset` into the bytes of the `…`, the name it
// ends up looking for is unbound, and `set -eu` aborts the installer on the
// first command the product asks anyone to run. The fix was three ASCII bytes.
//
// The fix is not the deliverable, because the same three bytes can be typed
// back tomorrow by anyone composing a nicer-looking message, and nothing on a
// Linux runner under bash 5 would notice. `scripts/install-sh-ascii-guard.sh`
// is the deliverable, and this file is what keeps *it* honest. Four properties,
// each failing here on its own:
//
//   1. **It refuses the reported shape, and the neighbouring ones.** `$name…`,
//      `${name}…`, `$1…`, and a bare `$…` are all refused, with the line
//      number of the offence — a guard that says only "something is wrong in
//      install.sh" sends the reader back to a 591-line file.
//   2. **It passes what is correct.** The shipped installer, and the many
//      lines where an em-dash follows a variable with a space between them.
//      A guard with false positives is a guard people route around.
//   3. **It cannot pass silently.** Its own detector is self-tested before the
//      scan, and a missing file is a failure rather than a green no-op. The
//      byte-range match under `LC_ALL=C` is this script's one environmental
//      assumption, and "the assumption broke, so nothing matched, so the check
//      is green" is precisely the shape of failure that would let #346 back in.
//   4. **It gates.** The step lives in a job whose name every ruleset that
//      requires checks at all requires — read out of `ci.yml` rather than
//      asserted as a literal in two places, so a coordinated rename stays
//      green and a one-sided one does not.
//
// And one property of the file under it: `install.sh` line 80 carries
// `LINE="x.y.z"`, the release-train stamp that decides which line a fetched
// copy installs (ADR 0036 D1, D2) and that `Train rules` asserts against the
// train. The guard reads and never writes, and the stamp passes it — asserted
// below, because a guard that "fixed" what it found would be a second thing
// editing that line and there must be exactly one.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const GUARD = path.join(repoRoot, "scripts/install-sh-ascii-guard.sh");
const INSTALL_SH = path.join(repoRoot, "install.sh");
const ci = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");

const ELLIPSIS = "…";
const EM_DASH = "—";

let workDir;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-ascii-guard-"));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** The real guard, run the way `ci.yml` runs it. */
const run = (target) => {
  const result = spawnSync("bash", [GUARD, target], { encoding: "utf8", cwd: repoRoot });
  expect(result.error, `${GUARD} did not run`).toBeUndefined();
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
};

/** A throwaway shell file with the given body. */
const fixture = (name, body) => {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, body);
  return file;
};

/** One job block from `ci.yml`, from its key up to the next job at that indent. */
const jobBlock = (source, name) => {
  const start = source.indexOf(`\n  ${name}:`);
  expect(start, `no ${name} job`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
};

describe("the guard refuses an expansion against a non-ASCII byte (#346)", () => {
  it("refuses the exact line #346 was reported as, and names its line number", () => {
    const file = fixture(
      "reported.sh",
      ["#!/bin/sh", "set -eu", 'asset=core.tgz', `say "Downloading $asset${ELLIPSIS}"`, ""].join(
        "\n",
      ),
    );
    const { status, out } = run(file);
    expect(status, "the reported shape passed the guard").toBe(1);
    // The line number, in the annotation and in the human-readable line. Both,
    // because the Checks tab renders one and the log carries the other.
    expect(out).toContain("line=4");
    expect(out).toContain(":4:");
    expect(out).toMatch(/::error file=/);
  });

  it("refuses the braced form as well", () => {
    const file = fixture("braced.sh", `say "Downloading \${asset}${ELLIPSIS}"\n`);
    const { status, out } = run(file);
    expect(status).toBe(1);
    expect(out).toContain("line=1");
  });

  it("refuses a positional parameter and a bare dollar sign", () => {
    for (const [name, body] of [
      ["positional.sh", `say "installing $1${ELLIPSIS}"\n`],
      ["special.sh", `say "exit $?${ELLIPSIS}"\n`],
      ["bare.sh", `say "$${ELLIPSIS}"\n`],
    ]) {
      const { status } = run(fixture(name, body));
      expect(status, `${name} passed the guard`).toBe(1);
    }
  });

  it("reports every offending line, not just the first", () => {
    const file = fixture(
      "several.sh",
      [`say "one $a${ELLIPSIS}"`, "say 'fine'", `say "two $b${ELLIPSIS}"`, ""].join("\n"),
    );
    const { status, out } = run(file);
    expect(status).toBe(1);
    expect(out).toContain("line=1");
    expect(out).toContain("line=3");
  });

  it("says what the fix is, so the reader does not have to find this issue", () => {
    const { out } = run(fixture("advice.sh", `say "$a${ELLIPSIS}"\n`));
    expect(out).toContain("#346");
    expect(out).toMatch(/bash 3\.2/);
    expect(out).toMatch(/UTF-8/);
    expect(out).toMatch(/\.\.\./);
  });
});

describe("the guard passes what is correct", () => {
  it("passes the shipped installer", () => {
    const { status, out } = run(INSTALL_SH);
    expect(status, `install.sh fails its own guard:\n${out}`).toBe(0);
  });

  it("passes a non-ASCII character separated from the expansion by a space", () => {
    // The shape `install.sh` uses on lines like `$latest_url — is $REPO …`.
    // Refusing it would refuse most of the file's prose.
    const file = fixture("spaced.sh", `die "no build for $TARGET ${EM_DASH} pin a version."\n`);
    expect(run(file).status).toBe(0);
  });

  it("passes a command substitution, which closes on an ASCII byte of its own", () => {
    const file = fixture("subst.sh", `say "$(date)${EM_DASH}"\n`);
    expect(run(file).status).toBe(0);
  });

  it("passes the release-train stamp, and leaves it exactly as it found it", () => {
    // ADR 0036 D1, D2: `LINE="x.y.z"` decides which line a fetched copy of the
    // installer installs, `Train rules` asserts it against the train, and the
    // cut's `sed` is the only thing that may rewrite it.
    const stamp = 'LINE="0.4.2"\n';
    const file = fixture("stamp.sh", stamp);
    expect(run(file).status).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(stamp);

    const before = fs.readFileSync(INSTALL_SH);
    run(INSTALL_SH);
    expect(fs.readFileSync(INSTALL_SH).equals(before), "the guard wrote to install.sh").toBe(true);
  });

  it("finds the stamp in the shipped installer, unchanged and on one line", () => {
    const lines = fs.readFileSync(INSTALL_SH, "utf8").split("\n");
    const stamps = lines.filter((line) => /^LINE="[^"]*"$/.test(line));
    expect(stamps, "install.sh carries no LINE stamp").toHaveLength(1);
  });
});

describe("the guard cannot report green by accident", () => {
  it("fails on a file that does not exist rather than passing over it", () => {
    const { status, out } = run(path.join(workDir, "nothing-here.sh"));
    expect(status, "a missing file reported green").toBe(1);
    expect(out).toMatch(/::error/);
  });

  it("self-tests its own detector before it trusts a scan", () => {
    // The one environmental assumption is that `grep -E` matches the
    // 0x80-0xFF byte range under `LC_ALL=C`. If that ever stops holding, the
    // scan matches nothing and the check goes green over a broken installer.
    const source = fs.readFileSync(GUARD, "utf8");
    expect(source).toMatch(/BAD_SAMPLE/);
    expect(source).toMatch(/GOOD_SAMPLE/);
    expect(source).toMatch(/self-test failed/);
  });

  it("scans under LC_ALL=C, so 'non-ASCII' means bytes and not the caller's locale", () => {
    const source = fs.readFileSync(GUARD, "utf8");
    expect(source).toMatch(/export LC_ALL=C/);
    // Same answer whatever the caller's locale is.
    const file = fixture("locale.sh", `say "$a${ELLIPSIS}"\n`);
    for (const locale of ["C", "en_US.UTF-8"]) {
      const result = spawnSync("bash", [GUARD, file], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: locale, LANG: locale },
      });
      expect(result.status, `guard passed under LC_ALL=${locale}`).toBe(1);
    }
  });
});

describe("the guard runs on bash 3.2, which is the shell the bug lives on", () => {
  it("uses nothing newer than bash 3.2 in the guard or in the installer", () => {
    // An operator reproducing #346 on their Mac runs both of these files under
    // bash 3.2.57. A guard that needs bash 4 could only ever run where the bug
    // cannot: on the Linux runner.
    const BASH_4_ONLY = [
      [/\bmapfile\b/, "mapfile"],
      [/\breadarray\b/, "readarray"],
      [/declare\s+-A/, "declare -A"],
      [/local\s+-A/, "local -A"],
      [/local\s+-n/, "local -n (nameref)"],
      [/declare\s+-n/, "declare -n (nameref)"],
      [/\$\{[A-Za-z_][A-Za-z0-9_]*\^\^?/, "${var^^} case conversion"],
      [/\$\{[A-Za-z_][A-Za-z0-9_]*,,?/, "${var,,} case conversion"],
      [/&>>/, "&>> redirection"],
      [/\bcoproc\b/, "coproc"],
    ];
    for (const file of [GUARD, INSTALL_SH]) {
      // Whole-line comments are dropped first. Both files explain themselves at
      // length, and the guard's own portability note names `mapfile` in order
      // to say it is not used — a scan that could not tell prose from code
      // would make writing that sentence down impossible.
      const source = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      for (const [pattern, what] of BASH_4_ONLY) {
        expect(pattern.test(source), `${path.basename(file)} uses ${what}, which is bash 4+`).toBe(
          false,
        );
      }
    }
  });

  it("parses under every shell the installer claims to run on", () => {
    const shells = ["bash", "dash", "sh"].filter(
      (shell) => spawnSync("sh", ["-c", `command -v ${shell}`]).status === 0,
    );
    expect(shells.length, "no shell available to parse install.sh").toBeGreaterThan(0);
    for (const shell of shells) {
      const result = spawnSync(shell, ["-n", INSTALL_SH], { encoding: "utf8" });
      expect(result.status, `${shell} -n install.sh: ${result.stderr}`).toBe(0);
    }
  });
});

describe("the guard gates every pull request", () => {
  const job = jobBlock(ci, "lint");

  it("is a step in that job, run against the shipped installer", () => {
    expect(job).toContain("scripts/install-sh-ascii-guard.sh install.sh");
    expect(fs.existsSync(GUARD), "the guard the workflow runs does not exist").toBe(true);
  });

  it("runs before anything is installed, so it answers in seconds", () => {
    expect(job.indexOf("install-sh-ascii-guard.sh")).toBeLessThan(job.indexOf("setup-node"));
  });

  it("carries no if:, so it cannot be skipped into a green pull request", () => {
    // Job-level `if:` is four spaces in; a step-level one is deeper and is not
    // what this is about.
    expect(job).not.toMatch(/^ {4}if:/m);
  });

  it("lives in a job every gating ruleset requires, so it actually blocks a merge", () => {
    const name = /^ {4}name: (.+)$/m.exec(job);
    expect(name, "the lint job has no name:").not.toBeNull();
    const context = name[1].trim();

    const dir = path.join(repoRoot, "docs/rulesets");
    const gating = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const contexts = [
        ...JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))).matchAll(
          /"context":"([^"]+)"/g,
        ),
      ].map((m) => m[1]);
      // The rulesets with no contexts restrict pushes rather than require
      // checks; excluded by that property rather than by name.
      if (contexts.length > 0) gating.push([file, contexts]);
    }
    expect(gating.length, "no ruleset requires any check").toBeGreaterThan(0);
    for (const [file, contexts] of gating) {
      expect(contexts, `${file} does not require the ${context} job`).toContain(context);
    }
  });
});
