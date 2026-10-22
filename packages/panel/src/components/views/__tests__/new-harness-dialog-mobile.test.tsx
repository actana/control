// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { CoreLinkHarnessAvailabilityMap } from "@actana/sdk/core";

// New session as a full-screen sheet on phone (#832, design M23). Desktop and
// tablet keep the centered Modal.

const bridge = {
  isConnected: () => true,
  listHarnessAvailability: vi.fn(async (): Promise<CoreLinkHarnessAvailabilityMap> => AVAILABILITY),
  installHarness: vi.fn(async () => ({ accepted: true })),
  watchCore: vi.fn(() => () => {}),
  onEvent: vi.fn(() => () => {}),
};

vi.mock("~/lib/panel-bridge", () => ({ getPanelBridge: () => bridge }));
vi.mock("~/queries", () => ({ useSettings: () => ({ data: undefined }) }));
vi.mock("~/lib/use-fleet", () => ({
  useCores: () => ({ cores: [{ id: "core_a", label: "workstation-berlin" }] }),
}));
vi.mock("~/lib/api", () => ({ api: { getKeybindings: async () => ({ bindings: {} }) } }));

const { NewHarnessDialog } = await import("../NewHarnessDialog");
const { KeybindingsProvider } = await import("~/lib/keybindings/store");
const { __resetCliAvailabilityStoresForTests } = await import("~/lib/cli-availability");
const { __resetCoreRememberForTests } = await import("~/lib/core-remember");
const { SESSION_REPORT_LOCATION } = await import("~/lib/session-report-location");

let AVAILABILITY: CoreLinkHarnessAvailabilityMap = {};

function stubWidth(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      media: query,
      matches: max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
}

function availability(): CoreLinkHarnessAvailabilityMap {
  return {
    "claude-code": { status: "available", path: "/usr/bin/claude" },
    codex: { status: "available", path: "/usr/bin/codex" },
    "cursor-cli": { status: "missing", reason: "not-found" },
    opencode: { status: "available", path: "/usr/bin/opencode" },
  };
}

async function openDialog() {
  const onStart = vi.fn();
  const onClose = vi.fn();
  const onPersistRemember = vi.fn();
  render(
    <KeybindingsProvider>
      <NewHarnessDialog
        open
        coreId="core_a"
        coreLabel="workstation-berlin"
        onClose={onClose}
        onStart={onStart}
        onPersistRemember={onPersistRemember}
      />
    </KeybindingsProvider>,
  );
  await act(async () => {});
  return { onStart, onClose };
}

const sheet = () => document.querySelector<HTMLElement>("[data-full-screen-sheet]")!;
const header = () => sheet().querySelector<HTMLElement>(".mc-sheet-header")!;
const footer = () => sheet().querySelector<HTMLElement>(".mc-sheet-footer")!;

describe("NewHarnessDialog on phone (M23)", () => {
  beforeEach(() => {
    AVAILABILITY = availability();
    __resetCliAvailabilityStoresForTests();
    __resetCoreRememberForTests();
    bridge.installHarness.mockClear();
    stubWidth(390);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens as a full-screen sheet with Cancel, title and Start", async () => {
    await openDialog();
    expect(sheet()).toBeTruthy();
    const h = within(header());
    expect(h.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(h.getByText("Start a new session")).toBeTruthy();
    expect(h.getByRole("button", { name: "Start" })).toBeTruthy();
  });

  it("shows Runs on, Harness, Prompt and Remember sections stacked", async () => {
    await openDialog();
    const body = sheet().textContent ?? "";
    expect(body).toContain("workstation-berlin");
    expect(body).toContain(SESSION_REPORT_LOCATION);
    expect(screen.getByText("Harness")).toBeTruthy();
    expect(screen.getByLabelText("Prompt")).toBeTruthy();
    expect(screen.getByText("Remember this harness for this Core")).toBeTruthy();
  });

  it("header Start starts the session with the chosen harness and prompt", async () => {
    const { onStart } = await openDialog();
    fireEvent.click(screen.getAllByText("Codex")[0]!.closest("button")!);
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "  do it  " } });
    await act(async () => {
      fireEvent.click(within(header()).getByRole("button", { name: "Start" }));
    });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0]![0]).toMatchObject({ agent: "codex", prompt: "do it", bareSession: false });
  });

  it("footer Start session does the same", async () => {
    const { onStart } = await openDialog();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(within(footer()).getByRole("button", { name: "Start session" }));
    });
    expect(onStart.mock.calls[0]![0]).toMatchObject({ agent: "claude-code", prompt: "hello" });
    expect(within(footer()).queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("Start is disabled when the desktop button would be", async () => {
    AVAILABILITY = {
      "claude-code": { status: "missing", reason: "not-found" },
      codex: { status: "missing", reason: "not-found" },
      "cursor-cli": { status: "missing", reason: "not-found" },
      opencode: { status: "missing", reason: "not-found" },
      pi: { status: "missing", reason: "not-found" },
    };
    await openDialog();
    expect((within(header()).getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(footer()).getByRole("button", { name: "Start session" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a harness that could not start shows the reason in the card, in the warning color", async () => {
    AVAILABILITY = {
      ...availability(),
      codex: { status: "missing", reason: "setup-check-failed: posix_spawnp failed", path: "/usr/bin/codex" },
    };
    await openDialog();
    const reason = screen.getByText(/Could not start on this Core \(posix_spawnp failed\)/);
    expect(reason.closest("button")?.textContent).toContain("Codex");
    expect(reason.style.color).toBe("var(--warning)");
  });

  it("a harness missing on this Core is listed under Not on <core> yet with Install", async () => {
    await openDialog();
    expect(screen.getByText("Not on workstation-berlin yet")).toBeTruthy();
    const note = screen.getByText("CLI not found on PATH.");
    expect(note.style.color).toBe("var(--status-failed)");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Install$/ }));
    });
    expect(bridge.installHarness).toHaveBeenCalledWith("core_a", "cursor-cli");
  });

  it("harness cards are at least 44 px tall targets", async () => {
    await openDialog();
    const card = screen.getAllByText("Claude Code")[0]!.closest("button")!;
    expect(card.style.minHeight).toBe("44px");
  });

  it("the prompt textarea is at least 16 px", async () => {
    await openDialog();
    expect(parseFloat(screen.getByLabelText("Prompt").style.fontSize)).toBeGreaterThanOrEqual(16);
  });

  it("Cancel closes without starting", async () => {
    const { onStart, onClose } = await openDialog();
    fireEvent.click(within(header()).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("NewHarnessDialog on desktop", () => {
  beforeEach(() => {
    AVAILABILITY = availability();
    __resetCliAvailabilityStoresForTests();
    __resetCoreRememberForTests();
    stubWidth(1280);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("is unchanged: centered modal with its buttons and no sheet header", async () => {
    await openDialog();
    expect(document.querySelector("[data-full-screen-sheet]")).toBeNull();
    expect(document.querySelector(".mc-sheet-header")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start session" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Start$/ })).toBeNull();
    const card = screen.getAllByText("Claude Code")[0]!.closest("button")!;
    expect(card.style.minHeight).toBe("");
    expect(screen.getByLabelText("Prompt").style.fontSize).toBe("12.5px");
  });
});
