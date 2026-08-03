import { afterEach, describe, expect, it, vi } from "vitest";
import { isMacPlatform, openTerminalLink, terminalLinkRequiresModifier } from "../terminal-links";

describe("terminal links", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requires Cmd on macOS", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "Macintosh" });
    expect(isMacPlatform()).toBe(true);
    expect(terminalLinkRequiresModifier({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(terminalLinkRequiresModifier({ metaKey: false, ctrlKey: true })).toBe(false);
    expect(terminalLinkRequiresModifier({ metaKey: false, ctrlKey: false })).toBe(false);
  });

  it("requires Ctrl on non-macOS", () => {
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Windows NT 10.0" });
    expect(isMacPlatform()).toBe(false);
    expect(terminalLinkRequiresModifier({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(terminalLinkRequiresModifier({ metaKey: true, ctrlKey: false })).toBe(false);
    expect(terminalLinkRequiresModifier({ metaKey: false, ctrlKey: false })).toBe(false);
  });

  it("opens a link with a detached, opener-less anchor click", () => {
    const click = vi.fn();
    const anchor = { href: "", target: "", rel: "", click };
    const createElement = vi.fn().mockReturnValue(anchor);
    vi.stubGlobal("document", { createElement });
    openTerminalLink("https://example.com/docs");
    expect(createElement).toHaveBeenCalledWith("a");
    expect(anchor.href).toBe("https://example.com/docs");
    expect(anchor.target).toBe("_blank");
    expect(anchor.rel).toBe("noopener noreferrer");
    expect(click).toHaveBeenCalled();
  });
});
