import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachTerminalKeyHandler,
  setTerminalReadOnly,
  stripTerminalSelectionFormatting,
  terminalExitSessionStatus,
} from "../terminal-pane-helpers";

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: "keydown",
    key: "",
    code: "",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The async Clipboard API the pane now uses — the Panel is served over a
 *  secure context, so there is no bridge in front of it. */
function stubClipboard(text = "line1\nline2") {
  const clipboard = {
    readText: vi.fn(async () => text),
    writeText: vi.fn(async () => undefined),
  };
  vi.stubGlobal("navigator", { clipboard });
  return clipboard;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function createFixture(opts: { selection?: string } = {}) {
  let handler: ((e: KeyboardEvent) => boolean) | null = null;
  let selection = opts.selection ?? "";
  const term = {
    focus: vi.fn(),
    attachCustomKeyEventHandler: vi.fn((next: (e: KeyboardEvent) => boolean) => {
      handler = next;
    }),
    hasSelection: vi.fn(() => selection.length > 0),
    getSelection: vi.fn(() => selection),
    clearSelection: vi.fn(() => {
      selection = "";
    }),
    paste: vi.fn(),
  };
  const write = vi.fn(async () => true);

  attachTerminalKeyHandler({ term, write });
  if (!handler) throw new Error("handler was not attached");
  return { term, write, handler: handler as (e: KeyboardEvent) => boolean };
}

describe("stripTerminalSelectionFormatting", () => {
  it("removes ANSI escape sequences from copied terminal selection", () => {
    expect(stripTerminalSelectionFormatting("\x1b[31mred\x1b[0m plain")).toBe("red plain");
  });
});

describe("terminalExitSessionStatus", () => {
  it("marks a clean agent exit as finished", () => {
    expect(terminalExitSessionStatus(0)).toBe("finished");
  });

  it("marks failed or unknown exits as terminated", () => {
    expect(terminalExitSessionStatus(1)).toBe("terminated");
    expect(terminalExitSessionStatus(undefined)).toBe("terminated");
  });
});

describe("attachTerminalKeyHandler clipboard handling", () => {
  it("copies plain Ctrl+C only when the terminal has a selection", async () => {
    const clipboard = stubClipboard();
    const { term, write, handler } = createFixture({ selection: "\x1b[32mhello\x1b[0m" });
    const event = keyEvent({ ctrlKey: true, code: "KeyC", key: "c" });

    expect(handler(event)).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    await flushPromises();

    expect(clipboard.writeText).toHaveBeenCalledWith("hello");
    expect(term.clearSelection).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  });

  it("lets plain Ctrl+C pass through as SIGINT when there is no selection", () => {
    const clipboard = stubClipboard();
    const { handler } = createFixture();
    const event = keyEvent({ ctrlKey: true, code: "KeyC", key: "c" });

    expect(handler(event)).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("pastes plain Ctrl+V through xterm instead of writing directly to the PTY", async () => {
    const clipboard = stubClipboard();
    const { term, write, handler } = createFixture();
    const event = keyEvent({ ctrlKey: true, code: "KeyV", key: "v" });

    expect(handler(event)).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    await flushPromises();

    expect(clipboard.readText).toHaveBeenCalledOnce();
    expect(term.paste).toHaveBeenCalledWith("line1\nline2");
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps Ctrl+Shift+V on the same paste path", async () => {
    const clipboard = stubClipboard();
    const { term, handler } = createFixture();
    const event = keyEvent({ ctrlKey: true, shiftKey: true, code: "KeyV", key: "V" });

    expect(handler(event)).toBe(false);
    await flushPromises();

    expect(clipboard.readText).toHaveBeenCalledOnce();
    expect(term.paste).toHaveBeenCalledWith("line1\nline2");
  });

  it("pastes nothing when the clipboard is empty", async () => {
    stubClipboard("");
    const { term, handler } = createFixture();
    const event = keyEvent({ ctrlKey: true, code: "KeyV", key: "v" });

    expect(handler(event)).toBe(false);
    await flushPromises();

    expect(term.paste).not.toHaveBeenCalled();
  });

  it("still swallows the chord when the browser denies clipboard access", async () => {
    vi.stubGlobal("navigator", {});
    const { term, write, handler } = createFixture();
    const event = keyEvent({ ctrlKey: true, code: "KeyV", key: "v" });

    // Returning false keeps xterm from also handling the key — a denied
    // clipboard must not fall through and write a stray ^V to the PTY.
    expect(handler(event)).toBe(false);
    await flushPromises();

    expect(term.paste).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("writes mapped key sequences to the PTY", () => {
    stubClipboard();
    const { write, handler } = createFixture();
    // Shift+Enter is the canonical remap: xterm's default would send a bare CR.
    const event = keyEvent({ shiftKey: true, key: "Enter", code: "Enter" });

    expect(handler(event)).toBe(false);
    expect(write).toHaveBeenCalledWith("\x1b\r");
  });
});

describe("setTerminalReadOnly", () => {
  // Read-only is a state of the SAME terminal (issue 147, CONTEXT.md's Singular
  // UI): the surface keeps painting every byte, and only its input goes away.
  function term() {
    return {
      options: {} as {
        disableStdin?: boolean;
        cursorBlink?: boolean;
        cursorInactiveStyle?: string;
      },
      blurred: false,
      blur() {
        this.blurred = true;
      },
    };
  }

  it("stops xterm accepting keystrokes at all", () => {
    const t = term();
    setTerminalReadOnly(t, true);
    // Before `onData`, so nothing is typed and nothing is echoed — the operator
    // finds out by looking, not by pressing a key and watching it do nothing.
    expect(t.options.disableStdin).toBe(true);
  });

  it("takes the cursor with it", () => {
    const t = term();
    setTerminalReadOnly(t, true);
    // A blinking cursor is the strongest "type here" a terminal has, and one on
    // a surface that accepts nothing is the affordance worse than none.
    expect(t.options.cursorBlink).toBe(false);
    expect(t.options.cursorInactiveStyle).toBe("none");
    expect(t.blurred).toBe(true);
  });

  it("gives the terminal back when the Session is writable again", () => {
    const t = term();
    setTerminalReadOnly(t, true);
    setTerminalReadOnly(t, false);
    expect(t.options.disableStdin).toBe(false);
    expect(t.options.cursorBlink).toBe(true);
    expect(t.options.cursorInactiveStyle).toBe("outline");
  });
});
