// The pre-trust writers (#685): a fresh file, an existing file with other keys, and
// an already-trusted directory, for each Harness that has a writer.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cursorMarkerPath, cursorProjectSlug, pretrustWorkspaces, trustClaudeCode, trustCodex, trustCursor } from "../harness-pretrust";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pretrust-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

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
