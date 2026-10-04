// A lint-style guard for issue 559, PR 2: the daemon never asks `os` who it is
// and never starts or signals a child any way but `asCore` / `killAsCore`.
//
// This reads the source. It is here because every one of the call sites below
// was correct by hand once, and one new `spawn(` or `os.homedir()` added later
// silently puts a Session back on the daemon's identity — which, once the image
// gives the daemon two capabilities and its own state directory, is the whole
// privilege boundary. The detector is tested on known-bad text first, so a
// guard that stopped matching anything would fail here rather than pass.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGES = path.resolve(__dirname, "../../..");

function sources(pkg: string): string[] {
  const dir = path.join(PACKAGES, pkg, "src");
  // Recursive: a spawn added under a subdirectory of src/ is still a spawn.
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.split(path.sep).includes("__tests__"))
    .map((f) => path.join(dir, f));
}

/** Source with comments and string-free noise out of the way of the detectors. */
function code(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const rel = (file: string) => path.relative(PACKAGES, file);

/** The one module allowed to ask `os`: it is the fallback outside the container. */
const IDENTITY_MODULE = path.join(PACKAGES, "shared/src/core-home.ts");

export function homeLookups(text: string): string[] {
  return [...text.matchAll(/\b(?:os\.)?(?:homedir|userInfo)\s*\(/g)].map((m) => m[0]);
}

export function spawnCalls(text: string): Array<{ call: string; firstArg: string }> {
  const out: Array<{ call: string; firstArg: string }> = [];
  const pattern =
    /(?<![\w.])(?<!async\s)(?:(?:pty|nodePty|childProcess)\.)?(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\(\s*([^,)]*)/g;
  for (const m of text.matchAll(pattern)) out.push({ call: m[1]!, firstArg: m[2]!.trim() });
  return out;
}

export function directKills(text: string): string[] {
  return [
    ...text.matchAll(/\bprocess\.kill\s*\(/g),
    ...text.matchAll(/\b[A-Za-z_][\w.]*\.kill\s*\(\s*(?:["'`]SIG\w+["'`]|\))/g),
  ].map((m) => m[0]);
}

describe("the detectors", () => {
  it("see a home lookup, a bare spawn and a direct kill", () => {
    expect(homeLookups('const h = os.homedir(); const u = os.userInfo().shell; homedir()')).toHaveLength(3);
    expect(spawnCalls('spawnSync("lsof", args); pty.spawn(target, [], {}); spawn(cmd, a)')).toEqual([
      { call: "spawnSync", firstArg: '"lsof"' },
      { call: "spawn", firstArg: "target" },
      { call: "spawn", firstArg: "cmd" },
    ]);
    expect(directKills('process.kill(pid, "SIGTERM"); child.kill("SIGKILL"); proc.kill()')).toHaveLength(3);
  });

  it("leave a wrapped spawn, a frame method and a destructor alone", () => {
    expect(directKills("this.core.kill(frame.ptyId); ptys.kill(id); killAsCore(child, 'SIGTERM')")).toEqual([]);
    expect(homeLookups("coreHome(); const homedir = x; readUserStatusLine(homedir)")).toEqual([]);
  });
});

describe("no daemon code path asks os who it is", () => {
  it("has no os.homedir() or os.userInfo() outside the identity module", () => {
    const offenders: string[] = [];
    for (const file of [...sources("core"), ...sources("shared")]) {
      if (file === IDENTITY_MODULE) continue;
      const hits = homeLookups(code(file));
      if (hits.length > 0) offenders.push(`${rel(file)}: ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("computes no home-relative path at import in the statusline tap", () => {
    const text = code(path.join(PACKAGES, "shared/src/statusline-tap.ts"));
    expect(text).not.toMatch(/^(?:export\s+)?const\s+\w+\s*=\s*path\.join\(/m);
  });
});

describe("every spawn and every kill goes through the identity wrapper", () => {
  const spawners = [...sources("core"), ...sources("shared")].filter((file) => {
    const text = code(file);
    return /node:child_process/.test(text) || /\bpty\.spawn\(/.test(text);
  });

  it("finds the spawn sites it is meant to guard", () => {
    const names = spawners.map((f) => path.basename(f));
    for (const expected of [
      "pty-manager.ts",
      "core-exec.ts",
      "harness-cli-run.ts",
      "core-harness-system.ts",
      "harness-cli-version.ts",
      "npm-install-prefix.ts",
      "shell-env.ts",
      "login-shell.ts",
      "core-identity.ts",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("starts every child from an asCore spec", () => {
    const offenders: string[] = [];
    for (const file of spawners) {
      const text = code(file);
      const wrapped = /\basCore\(|\bcoreKillSpec\(/.test(text);
      for (const { call, firstArg } of spawnCalls(text)) {
        if (!wrapped || !/^(launch|spec)\.command$/.test(firstArg)) {
          offenders.push(`${rel(file)}: ${call}(${firstArg}…)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never passes node-pty (or child_process) a uid or gid, which keep the capabilities", () => {
    for (const file of spawners) {
      expect(code(file), rel(file)).not.toMatch(/\b(?:uid|gid)\s*:/);
    }
  });

  it("signals no process directly", () => {
    const offenders: string[] = [];
    for (const file of [...sources("core"), ...sources("shared")]) {
      // killAsCore's own outside-the-container branch is the one direct signal.
      if (path.basename(file) === "core-identity.ts") continue;
      const hits = directKills(code(file));
      if (hits.length > 0) offenders.push(`${rel(file)}: ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
