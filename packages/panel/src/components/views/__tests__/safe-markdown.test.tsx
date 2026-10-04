// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SafeMarkdown, safeMarkdownUrl } from "../SafeMarkdown";

// A report is written by an agent, so the page treats it as hostile: no raw HTML, no script, no remote image, and only
// http(s) and mailto links, opened without a handle back to this page.

afterEach(() => cleanup());

function html(markdown: string): string {
  render(<SafeMarkdown>{markdown}</SafeMarkdown>);
  return screen.getByTestId("markdown-preview").innerHTML;
}

describe("SafeMarkdown", () => {
  it("renders headings, emphasis, lists, code and tables", () => {
    const out = html("# Title\n\n**bold** and `code`\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<code>code</code>");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<table>");
  });

  it("renders a task list as read-only boxes", () => {
    render(<SafeMarkdown>{"- [x] sudo removed\n- [ ] harnesses install"}</SafeMarkdown>);
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    expect(boxes.every((b) => b.disabled)).toBe(true);
  });

  it("drops raw HTML: no script, no handler, no iframe, no style, and not as text either", () => {
    const out = html(
      [
        "before",
        "",
        "<script>window.__pwned = 1</script>",
        "",
        '<img src="https://evil.test/x.png" onerror="window.__pwned = 2">',
        "",
        '<iframe src="https://evil.test"></iframe>',
        "",
        '<a href="javascript:alert(1)" onclick="alert(2)">raw link</a>',
        "",
        "<style>body{display:none}</style>",
        "",
        "after <b onmouseover=\"alert(3)\">inline</b> text",
      ].join("\n"),
    );
    expect(out).not.toMatch(/<(script|iframe|style|img|b)\b/i);
    expect(out).not.toMatch(/onerror|onclick|onmouseover|javascript:/i);
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("drops images, so the browser fetches nothing a report names", () => {
    const out = html("![pixel](https://evil.test/p.png)\n\n![](data:image/png;base64,AAAA)");
    expect(out).not.toContain("<img");
    expect(document.querySelector("img")).toBeNull();
  });

  it("keeps http, https and mailto links, opened in a new tab without a handle back", () => {
    render(<SafeMarkdown>{"[pr](https://github.com/acme/app/pull/1) [mail](mailto:a@b.test) [plain](http://example.test)"}</SafeMarkdown>);
    for (const name of ["pr", "mail", "plain"]) {
      const a = screen.getByRole("link", { name });
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    }
  });

  it("turns a javascript:, data: or relative link into plain text", () => {
    render(<SafeMarkdown>{"[js](javascript:alert(1)) [data](data:text/html,<b>x</b>) [rel](../secret) [VB](vbscript:x)"}</SafeMarkdown>);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByTestId("markdown-preview").textContent).toContain("js");
  });

  it("allows only the three schemes", () => {
    expect(safeMarkdownUrl("https://x.test")).toBe("https://x.test");
    expect(safeMarkdownUrl("HTTP://x.test")).toBe("HTTP://x.test");
    expect(safeMarkdownUrl("mailto:a@b.test")).toBe("mailto:a@b.test");
    expect(safeMarkdownUrl("  javascript:alert(1)")).toBe("");
    expect(safeMarkdownUrl("/relative")).toBe("");
    expect(safeMarkdownUrl("//evil.test/x")).toBe("");
    expect(safeMarkdownUrl("data:text/html,x")).toBe("");
  });
});

describe("SafeMarkdown on a card (plain)", () => {
  it("renders links as their text and task-list boxes as marks, with no raw HTML", () => {
    render(<SafeMarkdown plain>{"[pr](https://github.com/a/b/pull/1) - [x] done\n\n<script>window.__pwned = 1</script>"}</SafeMarkdown>);
    const root = screen.getByTestId("markdown-preview");
    expect(root.querySelector("a")).toBeNull();
    expect(root.querySelector("input")).toBeNull();
    expect(root.querySelector("script")).toBeNull();
    expect(root.textContent).toContain("pr");
  });
});

