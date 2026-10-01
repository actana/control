import { describe, expect, it } from "vitest";
import {
  appendPromptBlock,
  buildPromptBlock,
  PROMPT_BLOCK_VERSION,
  reportPath,
} from "../prompt-standard-block";

describe("the standard block", () => {
  it("names the home, the shared folder, this turn's report path and no sudo", () => {
    expect(buildPromptBlock({ sessionId: "t-abc", turn: 1 })).toMatchInlineSnapshot(
      `"[Actana standard block v1] Your workspace is your home directory (~); go into a subfolder only when this prompt says so. ~/shared is shared with the operator and syncs within seconds. When this turn is done, write your report to ~/shared/sessions/t-abc/report-1.md and make its last line exactly ACT-REPORT-END. Never use sudo."`,
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
