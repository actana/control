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
    expect(installHarnessHooks("claude-code", cwd)).toEqual({
      installed: true,
      reportsTurnStart: true,
    });
    const settings = readJson(".claude/settings.local.json");
    // The events that carry every step of a turn: start, permission, end, and
    // the subagent lifecycle the Stop-downgrade counts.
    for (const event of ["UserPromptSubmit", "Stop", "SubagentStart", "SubagentStop"]) {
      expect(settings.hooks[event]).toHaveLength(1);
    }
    const command = settings.hooks.Stop[0].hooks[0].command as string;
    expect(command).toContain("/api/hooks/claude");
    // The event rides the URL too, so a payload that omits `hook_event_name`
    // is still routable and every request identifies itself in a log.
    expect(command).toContain("hookEvent=Stop");
    expect(command).toContain(`$${HOOK_URL_ENV}`);
    expect(command).toContain(`$${HOOK_TOKEN_ENV}`);
    expect(command).toContain(`$${HOOK_TASK_ID_ENV}`);
  });

  it("carries no secret on disk — the token comes from the PTY's environment", () => {
    // A hook file lives in the operator's workspace and may well be committed.
    // The literal token must never be in it; a restart also mints a new one,
    // and a file naming an env var stays correct across that.
    expect(hookCommand("claude", "Stop")).not.toMatch(/[0-9a-f]{32}/);
  });

  it("never blocks the operator's session when the receiver is down", () => {
    expect(hookCommand("claude", "Stop")).toContain("|| true");
  });

  it("matches PreToolUse to AskUserQuestion but leaves PostToolUse open", () => {
    installHarnessHooks("claude-code", cwd);
    const hooks = readJson(".claude/settings.local.json").hooks;
    // The only tool either host acts on — an unmatched subscription would
    // spawn a curl per tool call to learn nothing.
    expect(hooks.PreToolUse[0].matcher).toBe("AskUserQuestion");
    // Unmatched on purpose: Claude fires no hook when a permission is
    // GRANTED, so "some tool ran" is the only signal that heals a card stuck
    // on needs-input before the turn's Stop.
    expect(hooks.PostToolUse[0].matcher).toBeUndefined();
  });

  it("says a turn's START is unreported for families that only report its end", () => {
    // Installing is not reporting. Cursor takes the file but never fires
    // `beforeSubmitPrompt`; Codex will not run new hooks until the operator
    // reviews them with `/hooks`. Claiming otherwise suppresses the Panel's
    // fallback and leaves the Session on `ready` for its whole first turn.
    expect(installHarnessHooks("cursor-cli", cwd)).toEqual({
      installed: true,
      reportsTurnStart: false,
    });
    expect(installHarnessHooks("codex", cwd)).toEqual({
      installed: true,
      reportsTurnStart: false,
    });
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
    expect(groups.filter((g) => !g._acManaged)).toHaveLength(1);
    expect(groups.filter((g) => g._acManaged)).toHaveLength(1);
  });

  it("sweeps out the retired Electron app's entries rather than leaving them to fail", () => {
    const file = path.join(cwd, ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          Stop: [{ _mcManaged: true, hooks: [{ command: "curl http://127.0.0.1:1/api/hooks" }] }],
        },
      }),
    );

    installHarnessHooks("claude-code", cwd);

    const groups = readJson(".claude/settings.local.json").hooks.Stop as any[];
    // The legacy entry POSTs to an endpoint that no longer exists; leaving it
    // means a dead curl on every turn, forever.
    expect(groups).toHaveLength(1);
    expect(groups[0]._acManaged).toBe(true);
  });

  it("gives Cursor the `version: 1` its CLI silently requires", () => {
    installHarnessHooks("cursor-cli", cwd);
    expect(readJson(".cursor/hooks.json").version).toBe(1);
  });

  it("reports honestly for a harness it has no writer for", () => {
    // The Panel arms its terminal-input fallback off this answer, so a
    // hopeful `true` here is a Session with no status signal at all.
    expect(harnessSupportsHooks("opencode")).toBe(false);
    expect(installHarnessHooks("opencode", cwd)).toEqual({
      installed: false,
      reportsTurnStart: false,
    });
    expect(installHarnessHooks(undefined, cwd)).toEqual({
      installed: false,
      reportsTurnStart: false,
    });
  });

  it("reports false rather than clobbering a settings file it could not read", () => {
    const file = path.join(cwd, ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ this is not json");
    expect(installHarnessHooks("claude-code", cwd)).toEqual({
      installed: false,
      reportsTurnStart: false,
    });
    expect(fs.readFileSync(file, "utf8")).toBe("{ this is not json");
  });
});
