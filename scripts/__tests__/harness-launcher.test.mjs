// The `bin/actana` launcher has to find its own install root three ways: run
// in place, run off PATH, and run through a symlink from somewhere like
// ~/.local/bin. Each is a real operator path (issue 02's `actana setup` links
// the launcher into the user's bin dir), and each has broken a shell launcher
// before — so the script is exercised for real against a fake install tree
// whose `node` is a stub that reports what it was asked to run.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LAUNCHER_SCRIPT } from "../lib/harness-tarball.mjs";

// POSIX sh only — the launcher never runs on Windows (no Windows Core).
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

describeOnPosix("bin/actana launcher", () => {
  let root;
  let installRoot;
  let launcher;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "actana-launcher-test-"));
    installRoot = path.join(root, "install");

    fs.mkdirSync(path.join(installRoot, "bin"), { recursive: true });
    fs.mkdirSync(path.join(installRoot, "node", "bin"), { recursive: true });
    fs.mkdirSync(path.join(installRoot, "app"), { recursive: true });

    launcher = path.join(installRoot, "bin", "actana");
    fs.writeFileSync(launcher, LAUNCHER_SCRIPT);
    fs.chmodSync(launcher, 0o755);

    // Stands in for the bundled runtime: prints what it was asked to run, the
    // app path the launcher exported, and the arguments it forwarded.
    const stubNode = path.join(installRoot, "node", "bin", "node");
    fs.writeFileSync(
      stubNode,
      '#!/bin/sh\necho "entry=$1"\necho "app_path=$AC_APP_PATH"\necho "root=$ACTANA_ROOT"\nshift\necho "args=$*"\n',
    );
    fs.chmodSync(stubNode, 0o755);

    fs.writeFileSync(path.join(installRoot, "app", "actana-cli.cjs"), "// stub\n");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const parseOutput = (result) => {
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return Object.fromEntries(
      result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
  };

  it("execs the bundled node on the bundled actana CLI", () => {
    const out = parseOutput(spawnSync(launcher, [], { encoding: "utf8" }));

    expect(out.root).toBe(fs.realpathSync(installRoot));
    expect(out.entry).toBe(path.join(fs.realpathSync(installRoot), "app", "actana-cli.cjs"));
    expect(out.app_path).toBe(path.join(fs.realpathSync(installRoot), "app"));
  });

  it("forwards its arguments", () => {
    const out = parseOutput(spawnSync(launcher, ["status", "--json"], { encoding: "utf8" }));
    expect(out.args).toBe("status --json");
  });

  it("finds its install root when invoked bare off PATH", () => {
    // The naive `case $0 in */*)` launcher resolves the root relative to the
    // CWD here, which is wrong for every CWD but one.
    const out = parseOutput(
      spawnSync("actana", [], {
        encoding: "utf8",
        cwd: os.tmpdir(),
        env: { ...process.env, PATH: `${path.join(installRoot, "bin")}${path.delimiter}/usr/bin:/bin` },
      }),
    );

    expect(out.root).toBe(fs.realpathSync(installRoot));
  });

  it("follows a symlink back to the install root", () => {
    const linkDir = path.join(root, "local-bin");
    fs.mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, "actana");
    fs.symlinkSync(launcher, link);

    const out = parseOutput(spawnSync(link, [], { encoding: "utf8" }));
    expect(out.root).toBe(fs.realpathSync(installRoot));
  });

  it("follows the two-hop chain `actana setup` actually creates", () => {
    // setup links ~/.local/bin/actana -> <root>/current/bin/actana, and
    // <root>/current -> <root>/versions/<v>. Resolving only the first hop
    // would land the install root on `current`'s parent.
    const versioned = path.join(root, "versions", "0.49.0");
    fs.mkdirSync(path.dirname(versioned), { recursive: true });
    fs.symlinkSync(installRoot, versioned);
    const current = path.join(root, "current");
    fs.symlinkSync(versioned, current);
    const binDir = path.join(root, "chain-bin");
    fs.mkdirSync(binDir, { recursive: true });
    const link = path.join(binDir, "actana");
    fs.symlinkSync(path.join(current, "bin", "actana"), link);

    const out = parseOutput(spawnSync(link, [], { encoding: "utf8" }));
    expect(out.root).toBe(fs.realpathSync(installRoot));
  });

  it("follows a relative symlink", () => {
    const linkDir = path.join(root, "relative-bin");
    fs.mkdirSync(linkDir, { recursive: true });
    const link = path.join(linkDir, "actana");
    fs.symlinkSync(path.relative(linkDir, launcher), link);

    const out = parseOutput(spawnSync(link, [], { encoding: "utf8" }));
    expect(out.root).toBe(fs.realpathSync(installRoot));
  });
});
