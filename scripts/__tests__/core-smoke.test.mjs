import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  FILE_CAPABILITY_SCAN,
  checkProcessStatus,
  expectedStatusLines,
  rootProcessesBesideInit,
  statusLines,
} from "../lib/core-smoke.mjs";
import { CORE_DAEMON_CAPS, CORE_DAEMON_CAP_MASK, CORE_NO_CAP_MASK, readRepoFile } from "../lib/panel-image.mjs";

// The image smoke compares what the kernel prints in /proc/<pid>/status with the
// privilege model, line for line (#559). It cannot run here (it needs Docker and
// a built image), so what these tests hold is the comparison itself: a wrong
// capability set has to fail it loudly, in every set and for every way of being
// wrong, because a checker that passes a bad status makes the smoke worthless.

/** A `/proc/<pid>/status` as the kernel prints it, with the privilege lines replaceable. */
function status(overrides = {}) {
  const base = {
    Name: "node",
    Uid: "1001\t1001\t1001\t1001",
    Gid: "1001\t1001\t1001\t1001",
    Groups: "",
    CapInh: CORE_DAEMON_CAP_MASK,
    CapPrm: CORE_DAEMON_CAP_MASK,
    CapEff: CORE_DAEMON_CAP_MASK,
    CapBnd: CORE_DAEMON_CAP_MASK,
    CapAmb: CORE_DAEMON_CAP_MASK,
    NoNewPrivs: "1",
    ...overrides,
  };
  return [
    "Name:\t" + base.Name,
    "State:\tS (sleeping)",
    "Pid:\t42",
    "Uid:\t" + base.Uid,
    "Gid:\t" + base.Gid,
    "Groups:\t" + (base.Groups ? `${base.Groups} ` : ""),
    "CapInh:\t" + base.CapInh,
    "CapPrm:\t" + base.CapPrm,
    "CapEff:\t" + base.CapEff,
    "CapBnd:\t" + base.CapBnd,
    "CapAmb:\t" + base.CapAmb,
    "NoNewPrivs:\t" + base.NoNewPrivs,
    "Seccomp:\t2",
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

const sessionStatus = (overrides = {}) =>
  status({
    Uid: "1000\t1000\t1000\t1000",
    Gid: "1000\t1000\t1000\t1000",
    CapInh: CORE_NO_CAP_MASK,
    CapPrm: CORE_NO_CAP_MASK,
    CapEff: CORE_NO_CAP_MASK,
    CapAmb: CORE_NO_CAP_MASK,
    ...overrides,
  });

describe("the model the smoke compares against", () => {
  it("is exactly SETUID and SETGID: bit 6 and bit 7, 0xc0, and no capability for a Session", () => {
    expect(CORE_DAEMON_CAPS).toEqual(["SETUID", "SETGID"]);
    expect(CORE_DAEMON_CAP_MASK).toBe("00000000000000c0");
    expect(BigInt(`0x${CORE_DAEMON_CAP_MASK}`)).toBe((1n << 6n) | (1n << 7n));
    expect(CORE_NO_CAP_MASK).toBe("0000000000000000");
  });

  it("states the whole line for every field it checks", () => {
    expect(expectedStatusLines("daemon")).toEqual([
      "Uid:\t1001\t1001\t1001\t1001",
      "Gid:\t1001\t1001\t1001\t1001",
      "Groups:",
      "CapInh:\t00000000000000c0",
      "CapPrm:\t00000000000000c0",
      "CapEff:\t00000000000000c0",
      "CapBnd:\t00000000000000c0",
      "CapAmb:\t00000000000000c0",
      "NoNewPrivs:\t1",
    ]);
    expect(expectedStatusLines("session")).toEqual([
      "Uid:\t1000\t1000\t1000\t1000",
      "Gid:\t1000\t1000\t1000\t1000",
      "Groups:",
      "CapInh:\t0000000000000000",
      "CapPrm:\t0000000000000000",
      "CapEff:\t0000000000000000",
      "CapBnd:\t00000000000000c0",
      "CapAmb:\t0000000000000000",
      "NoNewPrivs:\t1",
    ]);
    expect(() => expectedStatusLines("root")).toThrow(/unknown process kind/);
  });
});

describe("the daemon's status", () => {
  it("passes when it is exactly actana with the two ambient capabilities", () => {
    expect(checkProcessStatus(status(), "daemon")).toEqual([]);
  });

  it.each([
    ["a third capability in the ambient set (CAP_KILL too)", { CapAmb: "00000000000000e0" }, /CapAmb/],
    ["a third capability in the permitted set", { CapPrm: "00000000000000e0" }, /CapPrm/],
    ["a third capability in the effective set", { CapEff: "00000000000000e0" }, /CapEff/],
    ["a third capability in the inheritable set", { CapInh: "00000000000000e0" }, /CapInh/],
    ["a wider bounding set (docker's default caps)", { CapBnd: "00000000a80425fb" }, /CapBnd/],
    ["no ambient capability, which is a daemon that cannot start a Session", { CapAmb: CORE_NO_CAP_MASK }, /CapAmb/],
    ["only one of the two", { CapEff: "0000000000000080" }, /CapEff/],
    ["every capability (a root-style set)", { CapPrm: "000001ffffffffff" }, /CapPrm/],
    ["no-new-privs off", { NoNewPrivs: "0" }, /NoNewPrivs/],
    ["root as the saved uid (it could switch back)", { Uid: "1001\t1001\t1001\t0" }, /Uid/],
    ["root as the real uid", { Uid: "0\t1001\t1001\t1001" }, /Uid/],
    ["core's uid", { Uid: "1000\t1000\t1000\t1000" }, /Uid/],
    ["root's gid", { Gid: "0\t1001\t1001\t1001" }, /Gid/],
    ["a supplementary group (root's, say)", { Groups: "0" }, /Groups/],
    ["its own gid as a supplementary group", { Groups: "1001" }, /Groups/],
  ])("fails on %s", (_what, override, field) => {
    const problems = checkProcessStatus(status(override), "daemon");
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(field);
  });

  it("fails when a line is missing altogether, not only when it is wrong", () => {
    for (const name of ["Uid", "Gid", "Groups", "CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs"]) {
      const without = status()
        .split("\n")
        .filter((line) => !line.startsWith(`${name}:`))
        .join("\n");
      expect(checkProcessStatus(without, "daemon"), name).toContain(`no ${name} line`);
    }
    expect(checkProcessStatus("", "daemon")).toHaveLength(9);
  });

  it("is not satisfied by a digit string that merely contains the mask", () => {
    expect(checkProcessStatus(status({ CapAmb: "000000000000c0c0" }), "daemon").join()).toMatch(/CapAmb/);
    expect(checkProcessStatus(status({ CapAmb: "00000000000000C0" }), "daemon").join()).toMatch(/CapAmb/);
  });
});

describe("a Session's status", () => {
  it("passes when it is core with no capability but the inert bounding set", () => {
    expect(checkProcessStatus(sessionStatus(), "session")).toEqual([]);
  });

  it.each([
    ["the daemon's ambient capabilities (it is actana in disguise)", { CapAmb: CORE_DAEMON_CAP_MASK }, /CapAmb/],
    ["a permitted capability", { CapPrm: "0000000000000080" }, /CapPrm/],
    ["an effective capability", { CapEff: CORE_DAEMON_CAP_MASK }, /CapEff/],
    ["an inheritable capability", { CapInh: CORE_DAEMON_CAP_MASK }, /CapInh/],
    ["a wider bounding set", { CapBnd: "00000000a80425fb" }, /CapBnd/],
    ["no-new-privs off", { NoNewPrivs: "0" }, /NoNewPrivs/],
    ["the daemon's uid", { Uid: "1001\t1001\t1001\t1001" }, /Uid/],
    ["the daemon as the saved uid", { Uid: "1000\t1000\t1000\t1001" }, /Uid/],
    ["the daemon's gid", { Gid: "1001\t1001\t1001\t1001" }, /Gid/],
    ["the daemon's groups carried over", { Groups: "1001" }, /Groups/],
  ])("fails on %s", (_what, override, field) => {
    const problems = checkProcessStatus(sessionStatus(override), "session");
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(field);
  });

  it("fails a daemon status read as a Session's and a Session's read as the daemon's", () => {
    expect(checkProcessStatus(status(), "session").length).toBeGreaterThan(5);
    expect(checkProcessStatus(sessionStatus(), "daemon").length).toBeGreaterThan(5);
  });
});

describe("reading a status text", () => {
  it("keeps the first of a repeated field and trims the kernel's padding", () => {
    const lines = statusLines("Groups:\t\nGroups:\t5 \nUid:\t1\t1\t1\t1\n");
    expect(lines.get("Groups")).toBe("Groups:");
    expect(lines.get("Uid")).toBe("Uid:\t1\t1\t1\t1");
  });
});

describe("no root process beside tini", () => {
  const proc = (pid, uid) => ({ pid, status: status({ Uid: `${uid}\t${uid}\t${uid}\t${uid}` }) });

  it("lets PID 1 be root and nothing else be", () => {
    expect(rootProcessesBesideInit([proc(1, 0), proc(7, 1001), proc(9, 1000)])).toEqual([]);
  });

  it("names every other process that is root, by its effective uid", () => {
    expect(rootProcessesBesideInit([proc(1, 0), proc(7, 0), proc(12, 1001), proc(30, 0)])).toEqual([7, 30]);
    // A leftover entrypoint shell that did not exec: pid 8 is the one a bad edit would leave.
    expect(rootProcessesBesideInit([proc(1, 0), proc(8, 0)])).toEqual([8]);
  });
});

describe("the file-capability scan", () => {
  const python = spawnSync("python3", ["--version"]);
  const hasPython = python.status === 0;

  it.skipIf(!hasPython)("refuses to say 'none' when it cannot plant a probe, instead of passing on a blind scan", () => {
    // As an unprivileged user the probe's setxattr is refused, so the scan stops
    // with its own exit code and a reason; as root on a filesystem that takes
    // security.* attributes it would plant one (the image's scan runs as root).
    if (process.getuid?.() === 0) return;
    const run = spawnSync("python3", ["-c", FILE_CAPABILITY_SCAN], { encoding: "utf8" });
    expect(run.status).toBe(3);
    expect(run.stdout).toMatch(/^PROBE-FAILED /);
  });

  it.skipIf(!hasPython)("lists a planted file and only that file, and skips the probe, on a tree it can write attributes to", () => {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "fscap-scan-"));
    try {
      fs.writeFileSync(path.join(tree, "plain"), "x");
      // The same scan, pointed at a scratch tree and at a user.* attribute, which an
      // unprivileged process may set: it proves the walk reads and reports what it finds.
      const script = FILE_CAPABILITY_SCAN.replaceAll("security.capability", "user.capability")
        .replace("os.walk('/'", `os.walk(${JSON.stringify(tree)}`)
        .replace("os.stat('/')", `os.stat(${JSON.stringify(tree)})`)
        .replace("probe = '/tmp/fscap-probe'", `probe = ${JSON.stringify(path.join(tree, "probe"))}`)
        .replace("struct.pack('<IIIII', 0x02000000, 0, 0, 0, 0)", "b'x'");
      const planted = path.join(tree, "capable");
      fs.writeFileSync(planted, "x");
      const plant = spawnSync("python3", ["-c", `import os; os.setxattr(${JSON.stringify(planted)}, 'user.capability', b'x')`], { encoding: "utf8" });
      if (plant.status !== 0) return; // this filesystem takes no user.* attributes: nothing to prove here
      const run = spawnSync("python3", ["-c", script], { encoding: "utf8" });
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(run.stdout.trim().split("\n")).toEqual([planted]);
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  });
});

// The smoke is a script, not a module: it cannot be imported without booting
// Docker. What can be held is that each of the nine assertions of plan 559 §3 is
// still in it, in the strict form: a deleted or softened leg is a failing test
// here and not a smoke that quietly asks less.
describe("the image smoke still asks every question of the privilege model", () => {
  const smoke = readRepoFile("scripts/smoke-core-image.mjs");
  const code = smoke
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  it.each([
    ["1. the daemon's node process, line for line", 'checkProcessStatus(daemonStatus, "daemon")'],
    ["1. and no root process beside tini", "rootProcessesBesideInit(statuses)"],
    ["2. the state is 1001:1001 mode 700 on a mount of its own", 'stateStat !== "1001:1001 700"'],
    ["2. a Session's user cannot read the state", "core could read ${kept}"],
    ["3. a Session, line for line", 'checkProcessStatus(read.output, "session")'],
    ["3. a Session cannot become the daemon's user", "setpriv --reuid=${CORE_DAEMON_USER.uid}"],
    ["3. a Session cannot signal the daemon", "kill -0 ${daemon.pid}"],
    ["3. a `core exec` child, line for line", 'checkProcessStatus(exec.stdout, "session")'],
    ["4. the terminal: tty, stty, /dev/tty and script", "script -qec tty /dev/null"],
    ["5. a Session that ignores HUP and TERM is gone after the stop", "trap '' HUP TERM"],
    ["6. no setuid or setgid bit", '"/", "-xdev", "-type", "f", "-perm", "/6000"'],
    ["6. no file capability", "FILE_CAPABILITY_SCAN"],
    ["7. pairing as actana, and not as core", 'pairAsCore.status === 0 || /Pairing code/.test(pairAsCore.stdout)'],
    ["8. the entrypoint refuses 1000 and 1001", "must start as root (uid 0), not uid ${user.uid}"],
    ["8. and a state volume with the wrong owner, repairing nothing", "the entrypoint changed the owner of a state volume it refused"],
    ["9. core-init hands the state volume to actana", "core-init left the state volume ${repaired}"],
    ["the compose file as Docker resolves it", '"config", "--format", "json"'],
    ["a plain exec is root with no DAC override", "root without a DAC override read ${unreadable}"],
  ])("%s", (_what, fragment) => {
    expect(code).toContain(fragment);
  });

  it("boots the Core with exactly compose's capability set, and not with the image's default", () => {
    expect(code).toMatch(/const COMPOSE_CORE_FLAGS = \[\s*"--cap-drop",\s*"ALL",\s*\.\.\.CORE_DAEMON_CAPS\.flatMap\(\(cap\) => \["--cap-add", cap\]\),\s*"--security-opt",\s*"no-new-privileges:true",\s*\];/);
    expect(code).toMatch(/\.\.\.COMPOSE_CORE_FLAGS,\s*"--publish"/);
  });

  it("does not accept the old identity: no 1000 daemon, no 'refusing to start as root'", () => {
    expect(code).not.toContain("refusing to start as root");
    expect(code).not.toMatch(/expected 1000:1000"\);\s*}\s*const homeEnv/);
    expect(code).not.toContain('config?.User !== "1000:1000"');
  });
});
