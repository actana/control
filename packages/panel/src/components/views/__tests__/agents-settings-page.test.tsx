// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { AgentDto } from "~/shared/task-wire";
import type { CoreWithDial } from "~/shared/cores";
import type { CliAvailabilityMap } from "~/lib/cli-availability";

/**
 * Settings › Agents (#893): each Core's Agents with create, edit and delete.
 * The api, the fleet and the Core's harness report are the edges.
 */

const core = (id: string, label: string, state: CoreWithDial["dial"]["state"]): CoreWithDial => ({
  id,
  label,
  endpoint: `wss://${id}`,
  lastEventId: 0,
  createdAt: 0,
  updatedAt: 0,
  dial: { coreId: id, state, lastSeenAt: 1 },
});
let cores: CoreWithDial[] = [];
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({ cores, loading: false, error: null }),
}));

let availability: CliAvailabilityMap = {};
vi.mock("~/lib/cli-availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/cli-availability")>()),
  useCliAvailability: () => availability,
}));

const { api, FakeApiError } = vi.hoisted(() => {
  class FakeApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(message);
      this.name = "ApiError";
    }
  }
  const api = {
    listCoreAgents: vi.fn(),
    createCoreAgent: vi.fn(),
    updateCoreAgent: vi.fn(),
    deleteCoreAgent: vi.fn(),
    getKeybindings: vi.fn(async () => ({ bindings: {} })),
  };
  return { api, FakeApiError };
});
vi.mock("~/lib/api", () => ({ api, ApiError: FakeApiError }));

const { AgentsSettingsPage } = await import("../AgentsSettingsPage");

const AGENTS: AgentDto[] = [
  { id: "a-def", coreId: "c1", name: "claude-code", harness: "claude-code", model: null, isDefault: true, flags: [] },
  { id: "a-mine", coreId: "c1", name: "Reviewer", harness: "claude-code", model: "opus", isDefault: false, flags: ["skip-permissions"] },
];

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

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <AgentsSettingsPage />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  stubWidth(1280);
  cores = [core("c1", "berlin", "connected")];
  availability = {
    "claude-code": { status: "available" },
    codex: { status: "checking" },
    pi: { status: "missing", reason: "not-found" },
  };
  for (const fn of Object.values(api)) fn.mockReset();
  api.getKeybindings.mockResolvedValue({ bindings: {} });
  api.listCoreAgents.mockImplementation(async () => ({ agents: structuredClone(AGENTS) }));
  api.createCoreAgent.mockResolvedValue({ agent: AGENTS[1] });
  api.updateCoreAgent.mockResolvedValue({ agent: AGENTS[1] });
  api.deleteCoreAgent.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Agents list", () => {
  it("lists each Core's Agents with harness, model and flags", async () => {
    cores = [core("c1", "berlin", "connected"), core("c2", "paris", "connected")];
    api.listCoreAgents.mockImplementation(async (id: string) => ({
      agents: id === "c1" ? structuredClone(AGENTS) : [],
    }));
    mount();
    expect(await screen.findByText("Reviewer")).toBeTruthy();
    expect(screen.getByText(/Claude Code · opus · skip-permissions/)).toBeTruthy();
    expect(await screen.findByText("No Agents on this Core yet.")).toBeTruthy();
    expect(api.listCoreAgents).toHaveBeenCalledWith("c1");
    expect(api.listCoreAgents).toHaveBeenCalledWith("c2");
  });

  it("does not offer Edit or Delete on a default Agent and says why", async () => {
    mount();
    await screen.findByText("Reviewer");
    const edit = screen.getByRole("button", { name: "Edit claude-code" }) as HTMLButtonElement;
    const del = screen.getByRole("button", { name: "Delete claude-code" }) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(del.disabled).toBe(true);
    expect(screen.getByText(/A default Agent is the Core's own: it can't be changed or deleted\./)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Edit Reviewer" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says an offline Core is offline, and still lets its Agents be edited", async () => {
    cores = [core("c1", "berlin", "unreachable")];
    mount();
    await screen.findByText("Reviewer");
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText(/can't be checked\. Try again when it is back online\. Existing Agents can still be edited or deleted/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Edit Reviewer" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Create", () => {
  it("offers only the harnesses the Core reports ready and says why the others are not", async () => {
    mount();
    await screen.findByText("Reviewer");
    fireEvent.click(screen.getByRole("button", { name: "New Agent on berlin" }));
    const dialog = await screen.findByRole("dialog");
    const radios = within(dialog).getAllByRole("radio");
    expect(radios).toHaveLength(1);
    expect(within(dialog).getByText("Claude Code")).toBeTruthy();
    // "not ready yet" and "missing" read differently.
    expect(within(dialog).getByText(/Codex: not ready yet \(checking\), ask again shortly/)).toBeTruthy();
    expect(within(dialog).getByText("Pi: missing")).toBeTruthy();
  });

  it("creates from name, harness, model and flags, then closes and refreshes the list", async () => {
    mount();
    await screen.findByText("Reviewer");
    fireEvent.click(screen.getByRole("button", { name: "New Agent on berlin" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "  Builder " } });
    fireEvent.change(within(dialog).getByLabelText("Model"), { target: { value: "claude-opus-4-1" } });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    const calls = api.listCoreAgents.mock.calls.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(api.createCoreAgent).toHaveBeenCalledWith("c1", {
        name: "Builder",
        harness: "claude-code",
        model: "claude-opus-4-1",
        flags: ["skip-permissions"],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.listCoreAgents.mock.calls.length).toBeGreaterThan(calls);
  });

  it("sends no flag the picked harness does not have after the harness is switched", async () => {
    availability = { ...availability, opencode: { status: "available" } };
    mount();
    await screen.findByText("Reviewer");
    fireEvent.click(screen.getByRole("button", { name: "New Agent on berlin" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Switcher" } });
    fireEvent.click(within(dialog).getByRole("checkbox")); // skip-permissions on claude-code
    fireEvent.click(within(dialog).getByRole("radio", { name: "OpenCode" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(api.createCoreAgent).toHaveBeenCalledWith("c1", { name: "Switcher", harness: "opencode", flags: [] }),
    );
  });

  it("has no command, argument, script or environment field", async () => {
    mount();
    await screen.findByText("Reviewer");
    fireEvent.click(screen.getByRole("button", { name: "New Agent on berlin" }));
    const dialog = await screen.findByRole("dialog");
    const labels = [...dialog.querySelectorAll("input")].map((i) => (i.getAttribute("aria-label") ?? i.id ?? "").toLowerCase());
    expect(dialog.textContent?.toLowerCase()).not.toMatch(/command|argument|script|environment/);
    expect(dialog.querySelectorAll("textarea")).toHaveLength(0);
    expect(labels.some((l) => /command|args|env/.test(l))).toBe(false);
  });

  it("will not submit an empty name or a model with a space", async () => {
    mount();
    await screen.findByText("Reviewer");
    fireEvent.click(screen.getByRole("button", { name: "New Agent on berlin" }));
    const dialog = await screen.findByRole("dialog");
    const create = within(dialog).getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "X" } });
    expect(create.disabled).toBe(false);
    fireEvent.change(within(dialog).getByLabelText("Model"), { target: { value: "bad model; rm" } });
    expect(create.disabled).toBe(true);
    expect(within(dialog).getByText(/A model id: letters, digits/)).toBeTruthy();
  });

  it("reads the offline refusal (core_harnesses_unavailable) clearly", async () => {
    api.createCoreAgent.mockRejectedValue(
      new FakeApiError("this Core cannot be asked which harnesses it has right now", 409, { code: "core_harnesses_unavailable" }),
    );
    mount();
    await screen.findByText("Reviewer");
    fireEvent.click(screen.getByRole("button", { name: "New Agent on berlin" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "X" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("offline or not answering");
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("reads 'not ready yet' differently from 'missing' when the Core refuses a harness", async () => {
    api.createCoreAgent.mockRejectedValueOnce(
      new FakeApiError("claude-code on this Core is not ready yet (checking)", 409, { code: "harness_not_ready" }),
    );
    mount();
    await screen.findByText("Reviewer");
    fireEvent.click(screen.getByRole("button", { name: "New Agent on berlin" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "X" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    const wait = (await within(dialog).findByRole("alert")).textContent ?? "";
    expect(wait).toContain("not ready yet (checking)");
    expect(wait).toContain("Nothing was created");
    expect(wait).not.toContain("Install or set it up");

    api.createCoreAgent.mockRejectedValueOnce(
      new FakeApiError("this Core does not have claude-code available: missing (not-found)", 409, { code: "harness_missing_on_core" }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("Install or set it up on that Core first"));
    expect(within(dialog).getByRole("alert").textContent).not.toContain("not ready yet");
  });

  it("offers no harness while the Core is offline", async () => {
    cores = [core("c1", "berlin", "unreachable")];
    availability = {};
    mount();
    await screen.findByText("Reviewer");
    fireEvent.click(screen.getByRole("button", { name: "New Agent on berlin" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
    expect(within(dialog).getByRole("alert").textContent).toContain("offline or not answering");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "X" } });
    expect((within(dialog).getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Edit", () => {
  it("opens the same form with the Agent's values, harness and Core read-only, and saves the change", async () => {
    mount();
    await screen.findByText("Reviewer");
    fireEvent.click(screen.getByRole("button", { name: "Edit Reviewer" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Reviewer");
    expect((within(dialog).getByLabelText("Model") as HTMLInputElement).value).toBe("opus");
    expect((within(dialog).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
    expect(within(dialog).getByText("fixed once the Agent exists")).toBeTruthy();
    expect(within(dialog).getByText("berlin")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Model"), { target: { value: "sonnet" } });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.updateCoreAgent).toHaveBeenCalledWith("c1", "a-mine", { name: "Reviewer", model: "sonnet", flags: [] }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("clears the model when the field is emptied", async () => {
    mount();
    await screen.findByText("Reviewer");
    fireEvent.click(screen.getByRole("button", { name: "Edit Reviewer" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Model"), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.updateCoreAgent).toHaveBeenCalledWith("c1", "a-mine", { name: "Reviewer", model: null, flags: ["skip-permissions"] }),
    );
  });

  it("shows the service's refusal (a name already on the Core) and keeps the form", async () => {
    api.updateCoreAgent.mockRejectedValue(new FakeApiError("this Core already has an Agent named Builder", 409, { error: "x" }));
    mount();
    await screen.findByText("Reviewer");
    fireEvent.click(screen.getByRole("button", { name: "Edit Reviewer" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Builder" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("already has an Agent named Builder");
  });
});

describe("Delete", () => {
  it("asks first, then deletes and refreshes", async () => {
    mount();
    await screen.findByText("Reviewer");
    fireEvent.click(screen.getByRole("button", { name: "Delete Reviewer" }));
    const dialog = await screen.findByRole("dialog");
    expect(api.deleteCoreAgent).not.toHaveBeenCalled();
    expect(within(dialog).getByText("Delete Reviewer?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteCoreAgent).toHaveBeenCalledWith("c1", "a-mine"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says why when the service refuses a default Agent (409)", async () => {
    api.deleteCoreAgent.mockRejectedValue(new FakeApiError("a default Agent cannot be deleted", 409, { error: "a default Agent cannot be deleted" }));
    mount();
    await screen.findByText("Reviewer");
    fireEvent.click(screen.getByRole("button", { name: "Delete Reviewer" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("A default Agent is the Core's own");
  });
});

describe("Phone", () => {
  it("opens the form as a full-screen sheet and edits in one too", async () => {
    stubWidth(390);
    mount();
    await screen.findByText("Reviewer");
    fireEvent.click(screen.getByRole("button", { name: "New Agent on berlin" }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet.hasAttribute("data-full-screen-sheet")).toBe(true);
    const header = sheet.querySelector(".mc-sheet-header") as HTMLElement;
    expect(header.textContent).toContain("New Agent");
    expect(header.textContent).toContain("Cancel");
    expect(header.textContent).toContain("Create");
    fireEvent.click(within(header).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Edit Reviewer" }));
    const edit = await screen.findByRole("dialog");
    expect(edit.hasAttribute("data-full-screen-sheet")).toBe(true);
    expect(edit.querySelector(".mc-sheet-header")?.textContent).toContain("Edit Reviewer");
  });

  it("is a list screen: rows stack on a phone", async () => {
    stubWidth(390);
    mount();
    await screen.findByText("Reviewer");
    const row = screen.getByText("Reviewer").closest("li") as HTMLElement;
    expect(row.style.flexDirection).toBe("column");
  });
});
