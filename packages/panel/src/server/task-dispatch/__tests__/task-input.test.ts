import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildTaskPrompt, maskSecrets, planAnswer, type TaskPrompt } from "../task-input";

// #959: what a waiting Task asks (`buildTaskPrompt`) and what an answer types (`planAnswer`). The screens are the
// committed PTY fixtures of #963 (`packages/core/src/__tests__/fixtures`).
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "../../../../../core/src/__tests__/fixtures", `${name}.txt`), "utf8");
const AT = 1_700_000_000_000;

describe("buildTaskPrompt: where kind and options come from", () => {
  it("source 1, a hook: PermissionRequest gives permission, and the dialog's own choices", () => {
    const p = buildTaskPrompt({ harness: "claude-code", screen: fixture("claude-code-synthetic-bash-permission"), hook: { kind: "permission", tool: "Bash" }, at: AT });
    expect(p.kind).toBe("permission");
    expect(p.source).toBe("hook");
    expect(p.at).toBe(AT);
    expect(p.options?.map((o) => o.label)).toEqual(["Yes", "Yes, and don't ask again for: npm test:*", "No, and tell Claude what to do differently (esc)"]);
    expect(p.text).toContain("npm test");
  });

  it("source 1, a hook: AskUserQuestion gives choice with its parsed options, numbered as the dialog numbers them", () => {
    const p = buildTaskPrompt({
      harness: "claude-code",
      screen: "",
      hook: { kind: "choice", text: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
      at: AT,
    });
    expect(p).toMatchObject({ kind: "choice", source: "hook", text: "Which database?" });
    expect(p.options).toEqual([
      { label: "Postgres", key: "1" },
      { label: "SQLite", key: "2" },
    ]);
  });

  it("source 1, a hook without detail (Pi, OpenCode): its kind, text from the screen", () => {
    const p = buildTaskPrompt({ harness: "pi", screen: fixture("generic-synthetic-numbered-choice"), hook: { kind: "question" }, at: AT });
    expect(p.kind).toBe("question");
    expect(p.source).toBe("hook");
    expect(p.text).toContain("Choose a deployment target");
  });

  it("source 2, classifyDialog, for a dialog without a hook: kind and options from the screen", () => {
    const p = buildTaskPrompt({ harness: "codex", screen: fixture("codex-synthetic-allow-command"), hook: null, at: AT });
    expect(p.kind).toBe("choice");
    expect(p.source).toBe("screen");
    expect(p.options?.map((o) => [o.key, o.label])).toEqual([
      ["1", "Yes, proceed (y)"],
      ["2", "Yes, and don't ask again for this command (a)"],
      ["3", "No, and tell Codex what to do differently (esc)"],
    ]);
    expect(p.text).toContain("Would you like to run the following command?");
  });

  it("source 2: a trust dialog is trust, even when a hook said permission", () => {
    const hooked = buildTaskPrompt({ harness: "claude-code", screen: fixture("claude-code-2.1.228-folder-trust"), hook: { kind: "permission" }, at: AT });
    expect(hooked.kind).toBe("trust");
    expect(buildTaskPrompt({ harness: "claude-code", screen: fixture("claude-code-2.1.228-folder-trust"), hook: null, at: AT }).kind).toBe("trust");
  });

  it("source 3, neither: unknown, the screen's text only, no options", () => {
    const p = buildTaskPrompt({ harness: "claude-code", screen: "something nobody classifies\nreally\n", hook: null, at: AT });
    expect(p).toMatchObject({ kind: "unknown", source: "screen" });
    expect(p.options).toBeUndefined();
    expect(p.text).toContain("something nobody classifies");
  });

  it("caps the text at 4 KB, keeping the end, and masks secrets", () => {
    const long = `${"x".repeat(6000)}\nPaste your key sk-abcdefghijklmnopqrstuvwxyz012345 here\n`;
    const p = buildTaskPrompt({ harness: "claude-code", screen: long, hook: null, at: AT });
    expect(p.text.length).toBeLessThanOrEqual(4096);
    expect(p.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(p.text).toContain("Paste your key");
  });
});

describe("maskSecrets", () => {
  it("masks API keys, bearer tokens and key=value secrets", () => {
    expect(maskSecrets("key sk-abcdefghijklmnopqrstuvwxyz012345")).not.toContain("abcdefghijklmnop");
    expect(maskSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("[masked]");
    expect(maskSecrets("Authorization: Bearer abc.def.ghi-jkl")).not.toContain("abc.def");
    expect(maskSecrets("password=hunter2 next")).toBe("password=[masked] next");
    expect(maskSecrets("nothing here")).toBe("nothing here");
  });
});

const prompt = (over: Partial<TaskPrompt>): TaskPrompt => ({ text: "Pick one", kind: "choice", at: AT, source: "screen", ...over });
const choice = prompt({
  options: [
    { label: "staging", key: "1", selected: true },
    { label: "production", key: "2" },
  ],
});

describe("planAnswer", () => {
  it("{ option: 2 } on a numbered choice types its number", () => {
    expect(planAnswer(choice, { option: 2 })).toMatchObject({ ok: true, bytes: "2", summary: 'option 2 "production"' });
  });

  it("{ option } by label, case-insensitive", () => {
    expect(planAnswer(choice, { option: "Production" })).toMatchObject({ ok: true, bytes: "2" });
  });

  it("an option with no number is reached with the arrow keys from the cursor row, then Enter", () => {
    const marked = prompt({ options: [{ label: "a", selected: true }, { label: "b" }, { label: "c" }] });
    expect(planAnswer(marked, { option: 3 })).toMatchObject({ ok: true, bytes: "\u001b[B\u001b[B\r" });
    expect(planAnswer(marked, { option: 1 })).toMatchObject({ ok: true, bytes: "\r" });
  });

  it("an option that is not there is refused", () => {
    expect(planAnswer(choice, { option: 3 })).toMatchObject({ ok: false, code: "invalid_answer" });
    expect(planAnswer(choice, { option: "maybe" })).toMatchObject({ ok: false, code: "invalid_answer" });
  });

  it("{ text } on a question is typed, then Enter", () => {
    const q = prompt({ kind: "question", text: "Which environment should I use?" });
    expect(planAnswer(q, { text: "staging" })).toMatchObject({ ok: true, bytes: "staging\r", summary: '"staging"' });
  });

  it("{ text } refuses control characters and anything empty or longer than 1000 characters", () => {
    const q = prompt({ kind: "question" });
    for (const text of ["", "a\u001b[31m", "a\nb", "a\u0003", "x".repeat(1001)]) {
      expect(planAnswer(q, { text })).toMatchObject({ ok: false, code: "invalid_answer" });
    }
  });

  it("keys outside the allowlist are refused, whole", () => {
    const q = prompt({ kind: "confirm" });
    expect(planAnswer(q, { keys: ["Enter", "Ctrl-C"] })).toMatchObject({ ok: false, code: "invalid_answer" });
    expect(planAnswer(q, { keys: ["Delete"] })).toMatchObject({ ok: false, code: "invalid_answer" });
    expect(planAnswer(q, { keys: [] })).toMatchObject({ ok: false, code: "invalid_answer" });
    expect(planAnswer(q, { keys: Array(17).fill("Down") })).toMatchObject({ ok: false, code: "invalid_answer" });
  });

  it("keys on the allowlist are typed in order", () => {
    expect(planAnswer(prompt({ kind: "confirm" }), { keys: ["y", "Enter"] })).toMatchObject({ ok: true, bytes: "y\r", summary: "keys [y, Enter]" });
    expect(planAnswer(prompt({ kind: "choice" }), { keys: ["Down", "Up", "Esc", "Tab", "Space", "Left", "Right"] })).toMatchObject({
      ok: true,
      bytes: "\u001b[B\u001b[A\u001b\t \u001b[D\u001b[C",
    });
  });

  it("unknown: { keys } only; { text } and { option } are refused and nothing is planned", () => {
    const u = prompt({ kind: "unknown", options: undefined });
    expect(planAnswer(u, { text: "yes" })).toMatchObject({ ok: false, code: "invalid_answer" });
    expect(planAnswer(u, { option: 1 })).toMatchObject({ ok: false, code: "invalid_answer" });
    expect(planAnswer(u, { keys: ["Enter"] })).toMatchObject({ ok: true, bytes: "\r" });
  });

  it("text is refused on a confirm or a permission prompt (use option or keys)", () => {
    expect(planAnswer(prompt({ kind: "confirm" }), { text: "y" })).toMatchObject({ ok: false, code: "invalid_answer" });
    expect(planAnswer(prompt({ kind: "permission" }), { text: "y" })).toMatchObject({ ok: false, code: "invalid_answer" });
  });

  it("trust is needs_human for every answer", () => {
    const t = prompt({ kind: "trust", text: "Do you trust the files in this folder?", options: [{ label: "Yes, I trust this folder", key: "1" }] });
    for (const answer of [{ option: 1 }, { keys: ["Enter"] }, { text: "yes" }]) {
      expect(planAnswer(t, answer)).toMatchObject({ ok: false, code: "needs_human" });
    }
  });

  it("a password, token or credential prompt is needs_human, whatever its kind and whatever the answer", () => {
    for (const text of ["Enter your password:", "Paste your API key", "GitHub token required", "Enter passphrase for key", "Provide credentials"]) {
      for (const kind of ["question", "unknown", "choice", "confirm"] as const) {
        expect(planAnswer(prompt({ kind, text }), { keys: ["Enter"] })).toMatchObject({ ok: false, code: "needs_human" });
      }
      expect(planAnswer(prompt({ kind: "question", text }), { text: "hunter2" })).toMatchObject({ ok: false, code: "needs_human" });
    }
  });

  it("a permission prompt widens access when approved: only a decline is answered", () => {
    const perm = prompt({
      kind: "permission",
      options: [
        { label: "Yes", key: "1", selected: true },
        { label: "Yes, and don't ask again for: npm test:*", key: "2" },
        { label: "No, and tell Claude what to do differently (esc)", key: "3" },
      ],
    });
    expect(planAnswer(perm, { option: 1 })).toMatchObject({ ok: false, code: "needs_human" });
    expect(planAnswer(perm, { option: 2 })).toMatchObject({ ok: false, code: "needs_human" });
    expect(planAnswer(perm, { keys: ["Enter"] })).toMatchObject({ ok: false, code: "needs_human" });
    expect(planAnswer(perm, { keys: ["y"] })).toMatchObject({ ok: false, code: "needs_human" });
    expect(planAnswer(perm, { keys: ["2"] })).toMatchObject({ ok: false, code: "needs_human" });
    expect(planAnswer(perm, { keys: ["3"] })).toMatchObject({ ok: true, bytes: "3" });
    expect(planAnswer(perm, { option: 3 })).toMatchObject({ ok: true, bytes: "3" });
    expect(planAnswer(perm, { keys: ["Esc"] })).toMatchObject({ ok: true, bytes: "\u001b" });
    expect(planAnswer(perm, { keys: ["n"] })).toMatchObject({ ok: true, bytes: "n" });
  });

  it("a confirmation that follows from the brief is answered with keys", () => {
    expect(planAnswer(prompt({ kind: "confirm", text: "Proceed with the install? [Y/n]" }), { keys: ["y", "Enter"] })).toMatchObject({ ok: true });
  });
});
