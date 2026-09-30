import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { repoRoot } from "../lib/panel-image.mjs";

const PREP = path.join(repoRoot, "deploy/core-fs-prep.sh");

function runPrep(home, env = {}) {
  return spawnSync("sh", [PREP], {
    encoding: "utf8",
    env: {
      ...process.env,
      CORE_HOME: home,
      CORE_USER: String(process.getuid()),
      CORE_UID: String(process.getuid()),
      CORE_GID: String(process.getgid()),
      ...env,
    },
  });
}

describe("core-fs-prep.sh", () => {
  it("creates home, shared and state under a fresh CORE_HOME", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "core-fs-prep-"));
    fs.rmSync(home, { recursive: true, force: true });

    const result = runPrep(home);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.statSync(home).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(home, "shared")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(home, ".local/share/actana/data")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(home, ".config/actana")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(home, "repos")).isDirectory()).toBe(true);
  });

  it("fails hard when .local is a symlink out of home", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-fs-prep-"));
    const home = path.join(root, "home");
    const evil = path.join(root, "evil-usr");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(evil, { recursive: true });
    fs.symlinkSync(evil, path.join(home, ".local"));

    const before = fs.readdirSync(evil);
    const result = runPrep(home);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/symlink|refusing/i);
    expect(fs.readdirSync(evil)).toEqual(before);
    expect(fs.existsSync(path.join(evil, "bin"))).toBe(false);
    expect(fs.existsSync(path.join(evil, "share"))).toBe(false);
  });

  it("fails hard when .config is a symlink out of home", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-fs-prep-"));
    const home = path.join(root, "home");
    const evil = path.join(root, "evil-config");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(home, ".local/share/actana/data"), { recursive: true });
    fs.mkdirSync(evil, { recursive: true });
    fs.symlinkSync(evil, path.join(home, ".config"));

    const before = fs.readdirSync(evil);
    const result = runPrep(home);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/symlink|refusing/i);
    expect(fs.readdirSync(evil)).toEqual(before);
    expect(fs.existsSync(path.join(evil, "actana"))).toBe(false);
  });

  it("warns and continues when repos is a symlink (workspace policy)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-fs-prep-"));
    const home = path.join(root, "home");
    const evil = path.join(root, "evil-repos");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(evil, { recursive: true });
    fs.symlinkSync(evil, path.join(home, "repos"));

    const result = runPrep(home);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/warning:.*repos/i);
    expect(fs.lstatSync(path.join(home, "repos")).isSymbolicLink()).toBe(true);
  });
});
