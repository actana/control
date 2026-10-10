// The lock Core shares with Claude Code around `~/.claude.json` (#699): a mkdir lock directory
// at `${file}.lock`, stale after 10 s, broken only with rmdir.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CONFIG_LOCK_DELAYS_MS,
  CLAUDE_CONFIG_LOCK_STALE_MS,
  claudeConfigLockPath,
  withClaudeConfigLock,
} from "../claude-config-lock";

let dir: string;
let file: string;
let lock: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-lock-"));
  file = path.join(dir, ".claude.json");
  lock = `${file}.lock`;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function recorder(onCall?: (n: number) => void) {
  const slept: number[] = [];
  return {
    slept,
    sleep: (ms: number) => {
      slept.push(ms);
      onCall?.(slept.length);
    },
  };
}

describe("withClaudeConfigLock", () => {
  it("uses the documented constants", () => {
    expect(CLAUDE_CONFIG_LOCK_STALE_MS).toBe(10_000);
    expect(CLAUDE_CONFIG_LOCK_DELAYS_MS).toEqual([50, 100, 200, 400, 800, 1600]);
  });

  it("acquires, runs fn, returns its value and removes the lock dir", () => {
    let during = false;
    const value = withClaudeConfigLock(file, () => {
      during = fs.statSync(lock).isDirectory();
      return 42;
    });
    expect(value).toBe(42);
    expect(during).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("puts the lock beside a symlinked file, not beside its target", () => {
    const other = path.join(dir, "other");
    fs.mkdirSync(other);
    const target = path.join(other, "real.json");
    fs.writeFileSync(target, "{}");
    const link = path.join(dir, "link.json");
    fs.symlinkSync(target, link);
    expect(claudeConfigLockPath(link)).toBe(`${link}.lock`);
    withClaudeConfigLock(link, () => {
      expect(fs.existsSync(`${link}.lock`)).toBe(true);
      expect(fs.existsSync(`${target}.lock`)).toBe(false);
    });
    expect(fs.existsSync(`${link}.lock`)).toBe(false);
  });

  it("releases the lock when fn throws, and the error propagates", () => {
    expect(() =>
      withClaudeConfigLock(file, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("does not fail when fn's lock was already removed", () => {
    expect(withClaudeConfigLock(file, () => fs.rmdirSync(lock))).toBeUndefined();
  });

  it("waits while a live writer holds the lock and runs once it is released", () => {
    fs.mkdirSync(lock);
    const r = recorder((n) => {
      if (n === 2) fs.rmdirSync(lock);
    });
    let ran = false;
    withClaudeConfigLock(file, () => (ran = true), { sleep: r.sleep });
    expect(ran).toBe(true);
    expect(r.slept).toEqual([50, 100]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("gives up when the lock stays held past the delays, leaving the other lock alone", () => {
    fs.mkdirSync(lock);
    const r = recorder();
    let ran = false;
    expect(() => withClaudeConfigLock(file, () => (ran = true), { sleep: r.sleep })).toThrow(
      new RegExp(`${lock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*another writer.*waiting 3150 ms`),
    );
    expect(ran).toBe(false);
    expect(r.slept).toEqual([...CLAUDE_CONFIG_LOCK_DELAYS_MS]);
    expect(fs.statSync(lock).isDirectory()).toBe(true);
  });

  it("breaks a stale lock with no sleep", () => {
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 11_000);
    fs.utimesSync(lock, old, old);
    const r = recorder();
    let ran = false;
    withClaudeConfigLock(file, () => (ran = true), { sleep: r.sleep });
    expect(ran).toBe(true);
    expect(r.slept).toEqual([]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("honours an injected clock for staleness", () => {
    fs.mkdirSync(lock);
    const r = recorder();
    let ran = false;
    withClaudeConfigLock(file, () => (ran = true), {
      sleep: r.sleep,
      now: () => Date.now() + 60_000,
    });
    expect(ran).toBe(true);
    expect(r.slept).toEqual([]);
  });

  it("does not remove a non-empty stale lock directory", () => {
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "keep"), "x");
    const old = new Date(Date.now() - 11_000);
    fs.utimesSync(lock, old, old);
    let ran = false;
    expect(() => withClaudeConfigLock(file, () => (ran = true), { sleep: () => {} })).toThrow();
    expect(ran).toBe(false);
    expect(fs.readFileSync(path.join(lock, "keep"), "utf8")).toBe("x");
  });

  it("refuses a regular file at the lock path and leaves it", () => {
    fs.writeFileSync(lock, "mine");
    let ran = false;
    expect(() => withClaudeConfigLock(file, () => (ran = true), { sleep: () => {} })).toThrow(/not a lock directory/);
    expect(ran).toBe(false);
    expect(fs.readFileSync(lock, "utf8")).toBe("mine");
  });

  it("refuses a symlink to a directory at the lock path and leaves it", () => {
    const target = path.join(dir, "elsewhere");
    fs.mkdirSync(target);
    fs.symlinkSync(target, lock);
    let ran = false;
    expect(() => withClaudeConfigLock(file, () => (ran = true), { sleep: () => {} })).toThrow(/not a lock directory/);
    expect(ran).toBe(false);
    expect(fs.lstatSync(lock).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("creates a missing parent directory", () => {
    const nested = path.join(dir, "a", "b", ".claude.json");
    withClaudeConfigLock(nested, () => {
      expect(fs.existsSync(`${nested}.lock`)).toBe(true);
    });
    expect(fs.existsSync(`${nested}.lock`)).toBe(false);
  });

  it("validates its options before touching anything", () => {
    const noop = () => 1;
    expect(() => withClaudeConfigLock(file, noop, { delays: [-1] })).toThrow(TypeError);
    expect(() => withClaudeConfigLock(file, noop, { delays: [NaN] })).toThrow(TypeError);
    expect(() => withClaudeConfigLock(file, noop, { delays: [Infinity] })).toThrow(TypeError);
    expect(() => withClaudeConfigLock(file, noop, { staleMs: 0 })).toThrow(TypeError);
    expect(() => withClaudeConfigLock(file, noop, { staleMs: Infinity })).toThrow(TypeError);
    expect(() => withClaudeConfigLock(file, noop, { staleMs: -5 })).toThrow(TypeError);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("the default sleep really blocks", () => {
    fs.mkdirSync(lock);
    const start = Date.now();
    expect(() => withClaudeConfigLock(file, () => 1, { delays: [20] })).toThrow(/another writer/);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    expect(fs.existsSync(lock)).toBe(true);
  });
});
