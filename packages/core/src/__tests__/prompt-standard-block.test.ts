import { describe, expect, it } from "vitest";
import {
  appendPromptBlock,
  buildPromptBlock,
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
