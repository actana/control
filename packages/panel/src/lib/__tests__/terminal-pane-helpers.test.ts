import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachTerminalKeyHandler,
  stripTerminalSelectionFormatting,
  terminalExitTaskStatus,
  wireTerminalFileDrop,
} from "../terminal-pane-helpers";
import { PROJECT_PATH_DRAG_MIME } from "../project-path-drag";

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

describe("terminalExitTaskStatus", () => {
  it("marks a clean agent exit as finished", () => {
    expect(terminalExitTaskStatus(0)).toBe("finished");
  });

  it("marks failed or unknown exits as terminated", () => {
    expect(terminalExitTaskStatus(1)).toBe("terminated");
    expect(terminalExitTaskStatus(undefined)).toBe("terminated");
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

describe("wireTerminalFileDrop", () => {
  function dropFixture() {
    const listeners = new Map<string, EventListener>();
    const host = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    const write = vi.fn(async () => true);
    const onFocus = vi.fn();
    wireTerminalFileDrop({ host: host as never, write, onFocus });
    return { listeners, host, write, onFocus };
  }

  it("pastes a project path dragged from the Panel's own rail", async () => {
    const { listeners, write, onFocus } = dropFixture();
    const event = {
      preventDefault: vi.fn(),
      dataTransfer: {
        types: [PROJECT_PATH_DRAG_MIME],
        files: [],
        getData: vi.fn(() => "/srv/checkout a"),
      },
    } as unknown as DragEvent;

    listeners.get("drop")?.(event);
    await flushPromises();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    // Quoted: the path has a space, and the shell on the other end is real.
    expect(write).toHaveBeenCalledWith('"/srv/checkout a" ');
    expect(onFocus).toHaveBeenCalledOnce();
  });

  it("ignores files dragged in from the operator's own machine", async () => {
    const { listeners, write, onFocus } = dropFixture();
    const file = new File([new Uint8Array([1, 2, 3])], "screenshot.png", {
      type: "image/png",
    });
    const event = {
      preventDefault: vi.fn(),
      dataTransfer: {
        types: ["Files"],
        files: [file],
        getData: vi.fn(() => ""),
      },
    } as unknown as DragEvent;

    listeners.get("drop")?.(event);
    await flushPromises();

    // The browser hands over bytes, never a path — and the path that would
    // matter is one on the Core's machine (ADR 0010). Leave the event alone so
    // the page's default handling applies.
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(onFocus).not.toHaveBeenCalled();
  });

  it("only claims the dragover for project-path drags", () => {
    const { listeners } = dropFixture();
    const dataTransfer = { types: ["Files"], dropEffect: "none" };
    const fileDrag = {
      preventDefault: vi.fn(),
      dataTransfer,
    } as unknown as DragEvent;

    listeners.get("dragover")?.(fileDrag);
    expect(fileDrag.preventDefault).not.toHaveBeenCalled();

    const pathDrag = {
      preventDefault: vi.fn(),
      dataTransfer: { types: [PROJECT_PATH_DRAG_MIME], dropEffect: "none" },
    } as unknown as DragEvent;
    listeners.get("dragover")?.(pathDrag);
    expect(pathDrag.preventDefault).toHaveBeenCalledOnce();
  });
});
