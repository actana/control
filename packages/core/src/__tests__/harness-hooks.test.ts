import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HOOK_TASK_ID_ENV,
  HOOK_TOKEN_ENV,
  HOOK_URL_ENV,
  harnessSupportsHooks,
  hookCommand,
  installHarnessHooks,
} from "../harness-hooks";

describe("installing a harness's lifecycle hooks (issue 84)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ac-hooks-"));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const readJson = (rel: string) =>
    JSON.parse(fs.readFileSync(path.join(cwd, rel), "utf8")) as Record<string, any>;

  it("writes Claude Code's lifecycle hooks into the workspace", () => {
    expect(installHarnessHooks("claude-code", cwd)).toBe(true);
    const settings = readJson(".claude/settings.local.json");
    // The events that carry every step of a turn: start, permission, end, and
    // the subagent lifecycle the Stop-downgrade counts.
    for (const event of ["UserPromptSubmit", "Stop", "SubagentStart", "SubagentStop"]) {
      expect(settings.hooks[event]).toHaveLength(1);
    }
    const command = settings.hooks.Stop[0].hooks[0].command as string;
    expect(command).toContain("/api/hooks/claude");
    expect(command).toContain(`$${HOOK_URL_ENV}`);
    expect(command).toContain(`$${HOOK_TOKEN_ENV}`);
    expect(command).toContain(`$${HOOK_TASK_ID_ENV}`);
  });

  it("carries no secret on disk — the token comes from the PTY's environment", () => {
    // A hook file lives in the operator's workspace and may well be committed.
    // The literal token must never be in it; a restart also mints a new one,
    // and a file naming an env var stays correct across that.
    expect(hookCommand("claude")).not.toMatch(/[0-9a-f]{32}/);
  });

  it("never blocks the operator's session when the receiver is down", () => {
    expect(hookCommand("claude")).toContain("|| true");
  });

  it("preserves the operator's own hooks and replaces only its own", () => {
    const file = path.join(cwd, ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        customKey: 1,
        hooks: { Stop: [{ hooks: [{ type: "command", command: "my-own-thing" }] }] },
      }),
    );

    installHarnessHooks("claude-code", cwd);
    installHarnessHooks("claude-code", cwd);

    const settings = readJson(".claude/settings.local.json");
    expect(settings.customKey).toBe(1);
    const groups = settings.hooks.Stop as any[];
    // The operator's group survived both installs; ours landed exactly once,
    // replaced rather than appended on the second spawn.
    expect(groups.filter((g) => !g._mcManaged)).toHaveLength(1);
    expect(groups.filter((g) => g._mcManaged)).toHaveLength(1);
  });

  it("gives Cursor the `version: 1` its CLI silently requires", () => {
    expect(installHarnessHooks("cursor-cli", cwd)).toBe(true);
    expect(readJson(".cursor/hooks.json").version).toBe(1);
  });

  it("reports honestly for a harness it has no writer for", () => {
    // The Panel arms its terminal-input fallback off this answer, so a
    // hopeful `true` here is a Session with no status signal at all.
    expect(harnessSupportsHooks("opencode")).toBe(false);
    expect(installHarnessHooks("opencode", cwd)).toBe(false);
    expect(installHarnessHooks(undefined, cwd)).toBe(false);
  });

  it("reports false rather than clobbering a settings file it could not read", () => {
    const file = path.join(cwd, ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ this is not json");
    expect(installHarnessHooks("claude-code", cwd)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("{ this is not json");
  });
});
