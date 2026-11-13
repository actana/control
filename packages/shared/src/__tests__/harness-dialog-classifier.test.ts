import { describe, expect, it } from "vitest";
import { HARNESSES } from "../domain";
import { classifyDialog } from "../harness-dialog-classifier";
import { GENERIC_DIALOG_RULES, HARNESS_DIALOG_RULES } from "../harness-dialog-rules";
import { renderScreenText } from "../screen-text";

const filler = (n: number) => Array.from({ length: n }, (_, i) => `agent output line ${i + 1}`).join("\n");

const CLAUDE_PERMISSION = [
  "● Bash(rm -rf build)",
  "",
  "────────────────────────────────────────",
  " Bash command",
  "",
  "   rm -rf build",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for: rm:*",
  "   3. No, and tell Claude what to do differently (esc)",
].join("\n");

describe("rule registry", () => {
  it("has a rule file for every harness and for generic", () => {
    for (const harness of HARNESSES) expect(HARNESS_DIALOG_RULES[harness].harness).toBe(harness);
    expect(GENERIC_DIALOG_RULES.harness).toBe("generic");
  });

  it("names the source and licence of rules adapted from herdr", () => {
    for (const harness of ["claude-code", "codex", "cursor-cli", "opencode"] as const) {
      expect(HARNESS_DIALOG_RULES[harness].attribution).toMatch(/ee5bfb5.*Apache-2\.0/);
    }
  });

  it("gives every rule a unique id inside its file", () => {
    for (const file of [...Object.values(HARNESS_DIALOG_RULES), GENERIC_DIALOG_RULES]) {
      const ids = file.rules.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("classifyDialog", () => {
  it("reads a Claude permission prompt: rule, kind, text and numbered options", () => {
    const hit = classifyDialog("claude-code", CLAUDE_PERMISSION);
    expect(hit?.ruleId).toBe("bash_permission_prompt");
    expect(hit?.kind).toBe("permission");
    expect(hit?.text).toContain("Do you want to proceed?");
    expect(hit?.options).toEqual([
      { label: "Yes", key: "1", selected: true },
      { label: "Yes, and don't ask again for: rm:*", key: "2" },
      { label: "No, and tell Claude what to do differently (esc)", key: "3" },
    ]);
  });

  it("gives null for a Claude dialog inside a Codex Session", () => {
    const claudeOnly = "Run a dynamic workflow?\n\n Esc to cancel";
    expect(classifyDialog("claude-code", claudeOnly)?.ruleId).toBe("dynamic_workflow_prompt");
    expect(classifyDialog("codex", claudeOnly)).toBeNull();
  });

  it("never applies one harness's rules to another", () => {
    const trust = "> You are in /x\n\nDo you trust the contents of this directory?\n\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue";
    expect(classifyDialog("codex", trust)?.ruleId).toBe("trust_directory");
    expect(classifyDialog("claude-code", trust)?.ruleId).toBe("numbered_choice_footer");
    expect(classifyDialog("pi", trust)?.ruleId).toBe("numbered_choice_footer");
  });

  it("does not match text printed 40 lines above the bottom", () => {
    expect(classifyDialog("claude-code", `${CLAUDE_PERMISSION}\n${filler(40)}`)).toBeNull();
    expect(classifyDialog("generic", `Proceed? [y/n]\n${filler(10)}`)).toBeNull();
  });

  it("matches the same dialog when it is the bottom of a long screen", () => {
    expect(classifyDialog("claude-code", `${filler(60)}\n${CLAUDE_PERMISSION}`)?.ruleId).toBe("bash_permission_prompt");
  });

  it("uses only the text after the last horizontal rule for after-last-rule rules", () => {
    const form = [
      "────────────────────────────────────────",
      " Pick one",
      "   Alpha",
      "   Beta",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(classifyDialog("claude-code", form)?.ruleId).toBe("live_blocked_form");
    const staleAbove = `${form}\n────────────────────────────────────────\n ❯ ask me anything`;
    expect(classifyDialog("claude-code", staleAbove)).toBeNull();
  });

  it("tries a harness's rules by priority, then generic", () => {
    const both = "Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel";
    expect(classifyDialog("claude-code", both)?.ruleId).toBe("generic_permission_prompt");
    expect(classifyDialog("opencode", both)?.ruleId).toBe("numbered_choice_footer");
  });

  it("classifies the generic shapes", () => {
    expect(classifyDialog("pi", "Overwrite config? [y/N]")).toMatchObject({ ruleId: "yes_no_prompt", kind: "confirm" });
    expect(classifyDialog("pi", "Continue (Y/n)")).toMatchObject({ ruleId: "yes_no_prompt", kind: "confirm" });
    expect(classifyDialog("pi", "Update ready\n\n  Press enter to continue")).toMatchObject({
      ruleId: "press_enter_to_continue",
      kind: "confirm",
    });
    expect(classifyDialog("pi", "Press any key to continue")).toMatchObject({ ruleId: "press_any_key", kind: "unknown" });
    const arrows = "Choose a model\n❯ fast\n  smart\n\nenter to select · esc to cancel";
    expect(classifyDialog("pi", arrows)).toMatchObject({ ruleId: "arrow_choice_footer", kind: "choice" });
    expect(classifyDialog("pi", arrows)?.options).toEqual([
      { label: "fast", selected: true },
      { label: "smart" },
    ]);
  });

  it("returns null for an unknown harness name only when generic does not match", () => {
    expect(classifyDialog("not-a-harness", "just some text")).toBeNull();
    expect(classifyDialog("not-a-harness", "Go on? [Y/n]")?.ruleId).toBe("yes_no_prompt");
  });

  it("reads a raw terminal stream by replaying it onto a screen first", () => {
    const raw = "\u001b[2J\u001b[1;1HProceed with the update?\u001b[2;1H\u001b[1mContinue [Y/n]\u001b[22m";
    expect(classifyDialog("generic", raw)).toMatchObject({ ruleId: "yes_no_prompt" });
  });

  it("matches a regex rule that wraps across lines (named session form)", () => {
    const text = [
      " Enter to confirm · Esc to cancel",
      "────────────── api ──────────────",
      "  2 tasks (1 done, 1 open)",
      "  ✔ first",
      "  ◻ second",
    ].join("\n");
    expect(classifyDialog("claude-code", text)?.ruleId).toBe("live_blocked_form_named_session");
  });

  it("recognises the MCP elicitation form only with its header and controls", () => {
    const form = ['MCP server "docs" requests your input', "", "❯ Accept", "  Decline", "", "Esc to cancel"].join("\n");
    expect(classifyDialog("claude-code", form)).toMatchObject({ ruleId: "mcp_elicitation_prompt", kind: "question" });
    expect(classifyDialog("claude-code", form.replace('MCP server "docs" requests your input', "hello"))?.ruleId).toBe("arrow_choice_footer");
  });

  it("stops a bare ❯ composer from satisfying the legacy rule", () => {
    expect(classifyDialog("claude-code", "Would you like to continue? yes\n\n❯")).toBeNull();
  });
});

describe("renderScreenText", () => {
  it("honours cursor addressing so lines do not glue together", () => {
    expect(renderScreenText("\u001b[1;1HOne\u001b[3;3HTwo\u001b[4;1HThree")).toBe("One\n\n  Two\nThree");
  });

  it("drops colour, mode and title escapes and keeps the text", () => {
    expect(renderScreenText("\u001b]0;title\u0007\u001b[?25l\u001b[31mred\u001b[0m")).toBe("red");
  });

  it("forgets what a full clear wiped", () => {
    expect(renderScreenText("old\n\u001b[2J\u001b[Hnew")).toBe("new");
  });

  it("overwrites in place after a carriage return and erase", () => {
    expect(renderScreenText("working 1\r\u001b[Kworking 2")).toBe("working 2");
  });
});

const CURSOR_APPROVAL = [
  "⚠ Waiting for approval...",
  "Run this command?",
  "→ Run (once) (y) (enter)",
  "  Skip (esc or n)",
].join("\n");
const OPENCODE_PERMISSION = ["┃  △ Permission required", "┃  ← Edit src/app.ts", "┃  ⇆ select  enter confirm  esc dismiss"].join("\n");
const PI_SELECTOR = [
  "────────────────",
  " Select provider to login:",
  " → Anthropic",
  "   OpenAI",
  " ↑↓ navigate  enter select  escape/ctrl+c cancel",
  "────────────────",
].join("\n");

describe("cursor-cli, opencode and pi rules", () => {
  it("reads the marked options of a Cursor approval and of a Pi selector", () => {
    expect(classifyDialog("cursor-cli", CURSOR_APPROVAL)?.options).toEqual([
      { label: "Run (once) (y) (enter)", selected: true },
      { label: "Skip (esc or n)" },
    ]);
    expect(classifyDialog("pi", PI_SELECTOR)?.options).toEqual([
      { label: "Anthropic", selected: true },
      { label: "OpenAI" },
    ]);
  });

  it("does not match a dialog printed 40 lines above the bottom, on any of the three", () => {
    for (const [harness, dialog] of [
      ["cursor-cli", CURSOR_APPROVAL],
      ["opencode", OPENCODE_PERMISSION],
      ["pi", PI_SELECTOR],
    ] as const) {
      expect(classifyDialog(harness, dialog)?.kind, `${harness} at the bottom`).toBeDefined();
      expect(classifyDialog(harness, `${dialog}\n${filler(40)}`), `${harness} 40 lines up`).toBeNull();
    }
  });

  it("never applies one of the three's dialog to the others", () => {
    expect(classifyDialog("opencode", CURSOR_APPROVAL)).toBeNull();
    expect(classifyDialog("pi", CURSOR_APPROVAL)).toBeNull();
    expect(classifyDialog("cursor-cli", OPENCODE_PERMISSION)).toBeNull();
    expect(classifyDialog("pi", OPENCODE_PERMISSION)).toBeNull();
    expect(classifyDialog("claude-code", PI_SELECTOR)).toBeNull();
    expect(classifyDialog("opencode", PI_SELECTOR)).toBeNull();
  });

  it("does not read Pi's idle composer footer as a selector", () => {
    const composer = ["────", " ", "────", "/work", " escape interrupt · ctrl+c/ctrl+d clear/exit · / commands"].join("\n");
    expect(classifyDialog("pi", composer)).toBeNull();
  });
});
