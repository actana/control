// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CoreLinkHarnessAvailabilityMap } from "@actana/sdk/core";

// New Session is prompt-first (issue 560, design screen 03): harness picker +
// prompt, a Runs on line, no path or cwd field, Remember per Core. The picker
// lists only harnesses this Core has — Install lives in Settings › Providers.

type EventListener = (msg: { coreId: string; event: unknown }) => void;

const listeners = new Set<EventListener>();

const bridge = {
  isConnected: () => true,
  listHarnessAvailability: vi.fn(async (): Promise<CoreLinkHarnessAvailabilityMap> => AVAILABILITY),
  installHarness: vi.fn(async () => ({ accepted: true })),
  watchCore: vi.fn(() => () => {}),
  onEvent: vi.fn((cb: EventListener) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }),
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
const { __resetCoreRememberForTests, readCoreRemember, writeCoreRemember } =
  await import("~/lib/core-remember");
const { SESSION_REPORT_LOCATION } = await import("~/lib/session-report-location");

let AVAILABILITY: CoreLinkHarnessAvailabilityMap = {};

function availability(): CoreLinkHarnessAvailabilityMap {
  return {
    "claude-code": { status: "available", path: "/usr/bin/claude" },
    codex: { status: "available", path: "/usr/bin/codex" },
    "cursor-cli": { status: "missing", reason: "not-found" },
    opencode: { status: "available", path: "/usr/bin/opencode" },
  };
}

async function openDialog(props?: {
  onStart?: (data: unknown) => void;
  onPersistRemember?: (patch: unknown) => void;
}): Promise<{ onStart: ReturnType<typeof vi.fn>; onPersistRemember: ReturnType<typeof vi.fn> }> {
  const onStart = vi.fn(props?.onStart);
  const onPersistRemember = vi.fn(props?.onPersistRemember);
  render(
    <KeybindingsProvider>
      <NewHarnessDialog
        open
        coreId="core_a"
        coreLabel="workstation-berlin"
        onClose={() => {}}
        onStart={onStart}
        onPersistRemember={onPersistRemember}
      />
    </KeybindingsProvider>,
  );
  await act(async () => {});
  return { onStart, onPersistRemember };
}

describe("NewHarnessDialog prompt-first (issue 560)", () => {
  beforeEach(() => {
    AVAILABILITY = availability();
    listeners.clear();
    __resetCliAvailabilityStoresForTests();
    __resetCoreRememberForTests();
  });

  afterEach(() => {
    cleanup();
  });

  it("has no path or cwd field", async () => {
    await openDialog();
    expect(screen.queryByLabelText(/path/i)).toBeNull();
    expect(screen.queryByLabelText(/cwd/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/\/home|\/srv|\.\//i)).toBeNull();
    expect(document.querySelector('input[name="path"]')).toBeNull();
    expect(document.querySelector('input[name="cwd"]')).toBeNull();
  });

  it("lists only harnesses this Core has, not missing ones", async () => {
    await openDialog();
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
    expect(screen.queryByText("Cursor CLI")).toBeNull();
    expect(screen.queryByText("CLI not found on PATH.")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Install$/ })).toBeNull();
  });

  it("points operators to Settings › Providers when the Core has no harnesses", async () => {
    AVAILABILITY = {
      "claude-code": { status: "missing", reason: "not-found" },
      codex: { status: "missing", reason: "not-found" },
      "cursor-cli": { status: "missing", reason: "not-found" },
      opencode: { status: "missing", reason: "not-found" },
      pi: { status: "missing", reason: "not-found" },
    };
    await openDialog();
    expect(screen.getByText(/Settings › Providers/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Install$/ })).toBeNull();
  });

  it("shows a Runs on line with the Core, home and report location", async () => {
    await openDialog();
    const runsOn = screen.getByText(/runs on/i).closest("div");
    expect(runsOn?.textContent).toMatch(/workstation-berlin/);
    expect(runsOn?.textContent).toMatch(/~/);
    expect(runsOn?.textContent).toContain(SESSION_REPORT_LOCATION);
  });

  it("takes a prompt and passes it to onStart", async () => {
    const { onStart } = await openDialog();
    const prompt = screen.getByLabelText(/^prompt$/i);
    await act(async () => {
      fireEvent.change(prompt, { target: { value: "Implement issue 558" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start session/i }));
    });
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "claude-code",
        prompt: "Implement issue 558",
      }),
    );
  });

  it("labels Remember as per Core, not per project", async () => {
    await openDialog();
    expect(screen.getByText(/remember this harness for this core/i)).toBeTruthy();
    expect(screen.queryByText(/remember settings for this project/i)).toBeNull();
  });

  it("persists Remember per Core id", async () => {
    const { onPersistRemember } = await openDialog();
    const checkbox = screen.getByRole("checkbox");
    await act(async () => {
      fireEvent.click(checkbox);
    });
    expect(onPersistRemember).toHaveBeenCalledWith(
      expect.objectContaining({
        rememberHarnessSettings: true,
        savedHarness: "claude-code",
      }),
    );
    writeCoreRemember("core_a", { rememberHarnessSettings: true, savedHarness: "codex" });
    expect(readCoreRemember("core_a")).toEqual({
      rememberHarnessSettings: true,
      savedHarness: "codex",
    });
    expect(readCoreRemember("core_b")).toEqual({
      rememberHarnessSettings: false,
      savedHarness: null,
    });
  });
});
