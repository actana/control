import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESSES } from "@actana/shared/domain";
import { classifyDialog } from "@actana/shared/harness-dialog-classifier";
import type { DialogKind } from "@actana/shared/harness-dialog-classifier";
import { HARNESS_DIALOG_RULES } from "@actana/shared/harness-dialog-rules";

// Every committed screen capture, classified for its harness (issue 963).
// Real captures are named `<harness>-<version>-<what>`; `synthetic` in the name
// marks a screen built from the rule's own text because the dialog could not be
// produced on the capturing Core. The PR lists every synthetic one.

const dir = path.join(__dirname, "fixtures");
const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");

type Blocked = { file: string; harness: string; ruleId: string; kind: DialogKind };

const BLOCKED: Blocked[] = [
  { file: "claude-code-2.1.228-folder-trust.txt", harness: "claude-code", ruleId: "folder_trust", kind: "trust" },
  { file: "claude-code-synthetic-bash-permission.txt", harness: "claude-code", ruleId: "bash_permission_prompt", kind: "permission" },
  { file: "claude-code-synthetic-mcp-elicitation.txt", harness: "claude-code", ruleId: "mcp_elicitation_prompt", kind: "question" },
  { file: "codex-0.160.0-folder-trust.txt", harness: "codex", ruleId: "trust_directory", kind: "trust" },
  { file: "codex-0.153.0-directory-trust.txt", harness: "codex", ruleId: "trust_directory", kind: "trust" },
  { file: "codex-synthetic-allow-command.txt", harness: "codex", ruleId: "live_strong_blocker", kind: "choice" },
  // cursor-cli: the folder-trust capture is real (cursor-agent 2026.08.11); the approvals are built from the rules' text.
  { file: "cursor-agent-2026.08.11-folder-trust.txt", harness: "cursor-cli", ruleId: "workspace_trust", kind: "trust" },
  { file: "cursor-cli-synthetic-run-command-approval.txt", harness: "cursor-cli", ruleId: "approval_prompt", kind: "permission" },
  { file: "cursor-cli-synthetic-write-file-approval.txt", harness: "cursor-cli", ruleId: "write_file_approval", kind: "permission" },
  // opencode: no live permission dialog could be produced on this Core (no provider), so both are synthetic.
  { file: "opencode-synthetic-permission-required.txt", harness: "opencode", ruleId: "permission_required", kind: "permission" },
  { file: "opencode-synthetic-question.txt", harness: "opencode", ruleId: "dialog_footer", kind: "choice" },
  // pi: the project-trust capture is real (pi 0.85.1; no hook runs before trust); the selector is built from its footer.
  { file: "pi-0.85.1-project-trust.txt", harness: "pi", ruleId: "project_trust", kind: "trust" },
  { file: "pi-synthetic-login-selector.txt", harness: "pi", ruleId: "selector_footer", kind: "choice" },
  { file: "generic-synthetic-yes-no.txt", harness: "generic", ruleId: "yes_no_prompt", kind: "confirm" },
  { file: "generic-synthetic-numbered-choice.txt", harness: "generic", ruleId: "numbered_choice_footer", kind: "choice" },
];

const NEGATIVE: { file: string; harness: string }[] = [
  { file: "claude-code-2.1.235-composer.txt", harness: "claude-code" },
  { file: "claude-code-synthetic-working-spinner.txt", harness: "claude-code" },
  { file: "codex-0.153.0-composer.txt", harness: "codex" },
  { file: "codex-0.153.0-idle.txt", harness: "codex" },
  { file: "codex-synthetic-working-spinner.txt", harness: "codex" },
  { file: "cursor-agent-2026.08.11-e8db854-composer.txt", harness: "cursor-cli" },
  { file: "cursor-cli-synthetic-working-spinner.txt", harness: "cursor-cli" },
  { file: "opencode-1.18.18-boot.txt", harness: "opencode" },
  { file: "opencode-1.18.18-composer.txt", harness: "opencode" },
  { file: "opencode-synthetic-working-spinner.txt", harness: "opencode" },
  { file: "pi-0.85.1-composer-ready.txt", harness: "pi" },
  { file: "pi-0.85.1-composer.txt", harness: "pi" },
  { file: "pi-synthetic-working-spinner.txt", harness: "pi" },
  { file: "generic-synthetic-working-spinner.txt", harness: "generic" },
  { file: "generic-synthetic-idle-prompt.txt", harness: "generic" },
];

describe("blocked fixtures", () => {
  for (const f of BLOCKED) {
    it(`${f.file} is ${f.ruleId} (${f.kind})`, () => {
      const hit = classifyDialog(f.harness, read(f.file));
      expect(hit?.ruleId).toBe(f.ruleId);
      expect(hit?.kind).toBe(f.kind);
    });
  }

  it("reads the options of the Claude folder-trust capture", () => {
    expect(classifyDialog("claude-code", read("claude-code-2.1.228-folder-trust.txt"))?.options).toEqual([
      { label: "Yes, I trust this folder", key: "1", selected: true },
      { label: "No, exit", key: "2" },
    ]);
  });
});

describe("options inside a bordered dialog", () => {
  it("reads the marked options of the real Cursor workspace-trust capture", () => {
    expect(classifyDialog("cursor-cli", read("cursor-agent-2026.08.11-folder-trust.txt"))?.options).toEqual([
      { label: "[a] Trust this workspace", selected: true },
      { label: "[q] Quit" },
    ]);
  });

  it("reads the numbered options of the OpenCode question", () => {
    expect(classifyDialog("opencode", read("opencode-synthetic-question.txt"))?.options?.map((o) => o.key)).toEqual(["1", "2", "3"]);
  });
});

describe("negative fixtures (a working spinner, an idle composer)", () => {
  for (const f of NEGATIVE) {
    it(`${f.file} is not a dialog`, () => {
      expect(classifyDialog(f.harness, read(f.file))).toBeNull();
    });
  }

  it("is not a dialog on any harness's rules either", () => {
    for (const f of NEGATIVE) {
      for (const harness of [...HARNESSES, "generic"]) {
        expect(classifyDialog(harness, read(f.file)), `${f.file} as ${harness}`).toBeNull();
      }
    }
  });
});

describe("one harness's dialog is not another's", () => {
  it("gives null for a Claude-only dialog inside a Codex Session", () => {
    expect(classifyDialog("claude-code", read("claude-code-synthetic-mcp-elicitation.txt"))?.ruleId).toBe("mcp_elicitation_prompt");
    expect(classifyDialog("codex", read("claude-code-synthetic-mcp-elicitation.txt"))?.ruleId).not.toBe("mcp_elicitation_prompt");
    expect(classifyDialog("codex", read("claude-code-synthetic-bash-permission.txt"))?.ruleId).not.toBe("bash_permission_prompt");
  });

  it("does not run Codex rules against a Claude Session", () => {
    expect(classifyDialog("claude-code", read("codex-synthetic-allow-command.txt"))?.ruleId).not.toBe("live_strong_blocker");
  });
});

describe("every harness has a blocked and a negative fixture", () => {
  it("covers all of HARNESSES and generic, with a working spinner and an idle composer as negatives", () => {
    for (const harness of [...HARNESSES, "generic"]) {
      expect(BLOCKED.some((f) => f.harness === harness), `${harness} blocked`).toBe(true);
      const negatives = NEGATIVE.filter((f) => f.harness === harness).map((f) => f.file);
      expect(negatives.some((n) => /working-spinner/.test(n)), `${harness} working spinner`).toBe(true);
      expect(negatives.some((n) => /composer|idle/.test(n)), `${harness} idle composer`).toBe(true);
    }
  });
});

describe("a harness's rules never fire on another harness's dialog", () => {
  // A harness's own rules may read a similar-looking screen (a Codex `[y/n]` rule
  // sees a Claude "Do you want to ... Yes"), as text printed in a Codex Session.
  // What must never happen is the dialog's own rule applying outside its harness.
  for (const f of BLOCKED.filter((b) => b.harness !== "generic")) {
    it(`${f.file}: rule ${f.ruleId} runs only for ${f.harness}`, () => {
      for (const other of HARNESSES.filter((h) => h !== f.harness)) {
        expect(classifyDialog(other, read(f.file))?.ruleId, `${f.file} as ${other}`).not.toBe(f.ruleId);
      }
      expect(classifyDialog(f.harness, read(f.file))?.ruleId).toBe(f.ruleId);
    });
  }

  it("keeps the harness-specific rule ids of one harness out of every other file", () => {
    const ids = new Map<string, string>();
    for (const h of HARNESSES) {
      for (const r of HARNESS_DIALOG_RULES[h].rules) {
        // `source: screen:<ruleId>` must tell the harness; a shared id would not.
        expect(ids.get(r.id), `${r.id} in ${h} and ${ids.get(r.id)}`).toBeUndefined();
        ids.set(r.id, h);
      }
    }
  });
});
