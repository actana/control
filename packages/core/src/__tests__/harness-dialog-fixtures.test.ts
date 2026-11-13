import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyDialog } from "@actana/shared/harness-dialog-classifier";
import type { DialogKind } from "@actana/shared/harness-dialog-classifier";

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
  { file: "generic-synthetic-yes-no.txt", harness: "generic", ruleId: "yes_no_prompt", kind: "confirm" },
  { file: "generic-synthetic-numbered-choice.txt", harness: "generic", ruleId: "numbered_choice_footer", kind: "choice" },
];

const NEGATIVE: { file: string; harness: string }[] = [
  { file: "claude-code-2.1.235-composer.txt", harness: "claude-code" },
  { file: "claude-code-synthetic-working-spinner.txt", harness: "claude-code" },
  { file: "codex-0.153.0-composer.txt", harness: "codex" },
  { file: "codex-0.153.0-idle.txt", harness: "codex" },
  { file: "codex-synthetic-working-spinner.txt", harness: "codex" },
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

describe("negative fixtures (a working spinner, an idle composer)", () => {
  for (const f of NEGATIVE) {
    it(`${f.file} is not a dialog`, () => {
      expect(classifyDialog(f.harness, read(f.file))).toBeNull();
    });
  }

  it("is not a dialog on any harness's rules either", () => {
    for (const f of NEGATIVE) {
      for (const harness of ["claude-code", "codex", "generic"]) {
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
