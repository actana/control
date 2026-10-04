import { describe, expect, it } from "vitest";
import { isTaskPointerPrompt, taskPointerLine } from "@actana/shared/task-prompt-file";
import {
  appendPromptBlock,
  buildPromptBlock,
  buildTaskPromptBlock,
  PROMPT_BLOCK_VERSION,
  stripPromptBlock,
  reportPath,
} from "../prompt-standard-block";

describe("the standard block", () => {
  it("names the home, the shared folder, this turn's report path and no sudo", () => {
    expect(buildPromptBlock({ sessionId: "t-abc", turn: 1 })).toMatchInlineSnapshot(
      `"[Actana standard block v1] Your workspace is your home directory (~); go into a subfolder only when this prompt says so. ~/shared is shared with the operator and syncs within seconds. When this turn is done, write your report to ~/shared/sessions/t-abc/report-1.md and make its last line exactly ACT-REPORT-END. Never use sudo. [/Actana standard block v1]"`,
    );
    expect(PROMPT_BLOCK_VERSION).toBe(1);
  });

  it("uses client#8's path and the turn it is given", () => {
    expect(reportPath("t-abc", 3)).toBe("shared/sessions/t-abc/report-3.md");
    expect(buildPromptBlock({ sessionId: "t-abc", turn: 3 })).toContain("~/shared/sessions/t-abc/report-3.md");
  });
});

describe("appendPromptBlock", () => {
  it("puts the block after the user's text, once", () => {
    const out = appendPromptBlock("fix the bug", { sessionId: "t-abc", turn: 1 });
    expect(out.startsWith("fix the bug [Actana standard block v1]")).toBe(true);
    expect(out.match(/\[Actana standard block/g)).toHaveLength(1);
  });

  it("does not stack a second block on a resend of a prompt that carries one", () => {
    const once = appendPromptBlock("fix the bug", { sessionId: "t-abc", turn: 1 });
    const twice = appendPromptBlock(once, { sessionId: "t-abc", turn: 1 });
    expect(twice).toBe(once);
  });
});

describe("stripPromptBlock", () => {
  const input = { sessionId: "t-abc", turn: 1 };

  it("gives back the user's text exactly as it was before the block", () => {
    expect(stripPromptBlock(appendPromptBlock("fix the bug", input))).toBe("fix the bug");
  });

  it("leaves a prompt without a block alone", () => {
    expect(stripPromptBlock("fix the bug")).toBe("fix the bug");
  });

  it("removes a block cut short, from its opening marker to the end", () => {
    const cut = appendPromptBlock("fix the bug", input).slice(0, 90);
    expect(stripPromptBlock(cut)).toBe("fix the bug");
  });

  it("strips any version by its own markers, and only the block", () => {
    expect(stripPromptBlock("a [Actana standard block v7] anything [/Actana standard block v7] b")).toBe("a b");
  });
});

describe("a Task Session's starting prompt", () => {
  const input = { sessionId: "t-abc", turn: 1 };
  const POINTER =
    "Read ~/shared/tasks/task_9/prompt-attempt-2.md and do what it says. It holds your Task and tells you where to report the result.";

  it("carries no session report path, and keeps the workspace, shared folder and sudo sentences", () => {
    const typed = appendPromptBlock(POINTER, input);
    expect(typed).not.toContain("sessions/");
    expect(typed).not.toContain("report-1.md");
    expect(typed).not.toContain("write your report to");
    expect(typed).toContain("Your workspace is your home directory (~)");
    expect(typed).toContain("~/shared is shared with the operator and syncs within seconds.");
    expect(typed).toContain("Never use sudo.");
    expect(typed.match(/\[Actana standard block/g)).toHaveLength(1);
    expect(typed).toBe(`${POINTER} ${buildTaskPromptBlock()}`);
  });

  it("names only the Task file the pointer names: no result file path of its own, so only one instruction", () => {
    const typed = appendPromptBlock(POINTER, input);
    expect([...typed.matchAll(/~\/shared\/[^\s]+/g)].map((m) => m[0]).filter((p) => p.startsWith("~/shared/"))).toEqual([
      "~/shared/tasks/task_9/prompt-attempt-2.md",
    ]);
  });

  it("is recognised whatever mention form wraps the path, and is not stacked on a resend", () => {
    const path = "~/shared/tasks/task_9/prompt-attempt-2.md";
    const at = taskPointerLine(`@${path} (file ${path})`);
    expect(appendPromptBlock(at, input)).not.toContain("sessions/");
    const once = appendPromptBlock(POINTER, input);
    expect(appendPromptBlock(once, input)).toBe(once);
  });

  it.each([
    "summarise ~/shared/tasks/x/prompt-attempt-1.md",
    "why did the Task fail? see ~/shared/tasks/task_9/prompt-attempt-2.md for what it was told",
    "Read ~/shared/tasks/task_9/prompt-attempt-2.md and summarise it",
    `${POINTER} Also tell me a joke.`,
    `Please: ${POINTER}`,
    "Read ~/shared/tasks/task_9/prompt-attempt-2.md and do what it says. It holds your Task and tells you where to report the result. Then stop.",
  ])("keeps the normal block, with the session report path, for a prompt that only mentions the path: %s", (prompt) => {
    expect(isTaskPointerPrompt(prompt)).toBe(false);
    expect(appendPromptBlock(prompt, input)).toBe(`${prompt} ${buildPromptBlock(input)}`);
    expect(appendPromptBlock(prompt, input)).toContain("~/shared/sessions/t-abc/report-1.md");
  });

  it("leaves an interactive Session's block unchanged, even one that mentions tasks", () => {
    expect(appendPromptBlock("fix the bug", input)).toBe(`fix the bug ${buildPromptBlock(input)}`);
    expect(appendPromptBlock("look at ~/shared/tasks/x/success.md", input)).toContain("~/shared/sessions/t-abc/report-1.md");
  });
});
