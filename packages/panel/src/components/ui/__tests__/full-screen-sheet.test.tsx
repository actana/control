// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { CoreWithDial } from "~/shared/cores";
import type { TaskDto } from "~/shared/task-wire";

// Full-screen sheet for dialogs on phones and drawers as screens (#830).

vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ navigate: vi.fn() }),
}));
vi.mock("~/lib/session-notification-store", () => ({ requestSessionOpen: vi.fn() }));
const cores = vi.hoisted((): CoreWithDial[] => []);
vi.mock("~/lib/fleet-context", () => ({
  useFleet: () => ({ cores, fleet: { rows: [], offlineCores: [], singleCore: false }, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("~/lib/panel-bridge", () => ({
  getPanelBridge: () => ({
    listSessionRows: async () => ({ sessions: [], archivedCount: 0 }),
    listArchivedSessions: async () => [],
  }),
}));
const api = vi.hoisted(() => ({
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
  getTask: vi.fn(),
  listCoreAgents: vi.fn(async () => ({ agents: [] })),
}));
vi.mock("~/lib/api", () => ({ api, ApiError: class extends Error {} }));

const { Modal } = await import("../Modal");
const { ConfirmDialog } = await import("../ConfirmDialog");
const { TaskDetail } = await import("~/components/views/TaskDetail");

// jsdom has no matchMedia: report "(max-width: Npx)" queries for a window width.
function stubWidth(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      media: query,
      matches: max ? width <= Number(max[1]) : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
}
const phone = () => stubWidth(390);

function stubVisualViewport(initial: { height: number; offsetTop: number }) {
  const vv = Object.assign(new EventTarget(), initial);
  vi.stubGlobal("visualViewport", vv);
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  return vv;
}

const withClient = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
);

function renderModal(props: Partial<React.ComponentProps<typeof Modal>> = {}) {
  const onClose = props.onClose ?? vi.fn();
  render(
    withClient(<KeybindingsProvider>
      <Modal open onClose={onClose} title="New session" footer={<button type="button">Create session</button>} {...props}>
        <p>Body copy</p>
      </Modal>
    </KeybindingsProvider>),
  );
  return onClose;
}

beforeEach(() => {
  cores.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "visualViewport");
  vi.clearAllMocks();
});

describe("Modal as a full-screen sheet", () => {
  it("Modal on desktop renders the centred dialog unchanged (no data-full-screen-sheet)", () => {
    renderModal();
    const dialog = screen.getByRole("dialog", { name: "New session" });
    expect(dialog.hasAttribute("data-full-screen-sheet")).toBe(false);
    expect(document.querySelector("[data-modal-open]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeTruthy();
  });

  it("Modal on phone renders a full-screen sheet with Cancel · title · primary action in the header", () => {
    phone();
    renderModal({ primaryAction: { label: "Create", onClick: vi.fn() } });
    const sheet = screen.getByRole("dialog", { name: "New session" });
    expect(sheet.hasAttribute("data-full-screen-sheet")).toBe(true);
    expect(document.querySelector("[data-modal-open]")).toBeNull();
    const header = sheet.querySelector(".mc-sheet-header") as HTMLElement;
    const labels = Array.from(header.children).map((n) => n.textContent);
    expect(labels).toEqual(["Cancel", "New session", "Create"]);
  });

  it("omits the header primary action when none is given", () => {
    phone();
    renderModal();
    const header = screen.getByRole("dialog").querySelector(".mc-sheet-header") as HTMLElement;
    expect(within(header).queryAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel"]);
  });

  it("Cancel in the sheet header calls onClose; Escape still closes", () => {
    phone();
    const onClose = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("primary action in the header calls primaryAction.onClick and honours disabled", () => {
    phone();
    const onClick = vi.fn();
    renderModal({ primaryAction: { label: "Create", onClick } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    cleanup();
    const again = vi.fn();
    renderModal({ primaryAction: { label: "Create", onClick: again, disabled: true } });
    const button = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(again).not.toHaveBeenCalled();
  });

  it("footer is rendered at the end of the scrolling body (action repeated at the bottom)", () => {
    phone();
    renderModal();
    const sheet = screen.getByRole("dialog");
    const body = sheet.querySelector(".mc-sheet-body") as HTMLElement;
    const footer = sheet.querySelector(".mc-sheet-footer") as HTMLElement;
    expect(body.textContent).toContain("Body copy");
    expect(within(footer).getByRole("button", { name: "Create session" })).toBeTruthy();
    expect(body.nextElementSibling).toBe(footer);
    expect(sheet.lastElementChild).toBe(footer);
  });

  it("sheet height follows visualViewport when the keyboard opens", () => {
    phone();
    const vv = stubVisualViewport({ height: 700, offsetTop: 0 });
    renderModal();
    const sheet = screen.getByRole("dialog");
    expect(sheet.style.height).toBe("700px");
    act(() => {
      vv.height = 400;
      vv.offsetTop = 120;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(sheet.style.height).toBe("400px");
    expect(sheet.style.top).toBe("120px");
  });

  it("sheet falls back to 100dvh without visualViewport", () => {
    phone();
    renderModal();
    expect(screen.getByRole("dialog").style.height).toBe("100dvh");
  });
});

describe("ConfirmDialog on phone", () => {
  it("ConfirmDialog stays a centred modal on phone", () => {
    phone();
    render(
      withClient(
        <KeybindingsProvider>
          <ConfirmDialog open onClose={vi.fn()} onConfirm={vi.fn()} title="Delete Task" confirmLabel="Delete" />
        </KeybindingsProvider>,
      ),
    );
    const dialog = screen.getByRole("dialog", { name: "Delete Task" });
    expect(dialog.hasAttribute("data-full-screen-sheet")).toBe(false);
    expect(document.querySelector("[data-modal-open]")).not.toBeNull();
  });
});

describe("TaskDetail as a drawer-screen", () => {
  function mountTask() {
    const task: TaskDto = { id: "T-7", title: "Rotate keys", description: "", status: "assigned", coreId: "core_a", agent: null, attemptCount: 0, dispatchedAt: null, lastError: null, timeoutMinutes: 60, createdAt: 1, updatedAt: 1 };
    api.getTask.mockResolvedValue({ task, comments: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <KeybindingsProvider>
          <TaskDetail taskId="T-7" onClose={onClose} />
        </KeybindingsProvider>
      </QueryClientProvider>,
    );
    return onClose;
  }

  it("TaskDetail on phone shows Back and is marked data-mc-drawer; desktop keeps Close", async () => {
    mountTask();
    await waitFor(() => expect(screen.getByText("Rotate keys")).toBeTruthy());
    const desktopDrawer = screen.getByRole("dialog", { name: "Task detail" });
    expect(desktopDrawer.hasAttribute("data-mc-drawer")).toBe(true);
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    cleanup();

    phone();
    const onClose = mountTask();
    await waitFor(() => expect(screen.getByText("Rotate keys")).toBeTruthy());
    expect(screen.getByRole("dialog", { name: "Task detail" }).hasAttribute("data-mc-drawer")).toBe(true);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("mobile-sheet.css", () => {
  const css = readFileSync(path.resolve(__dirname, "../../../styles/mobile-sheet.css"), "utf8");
  const phoneBlocks = css.split("@media (max-width: 767px)").slice(1).join("\n");

  it("mobile-sheet.css: inputs 16px under max-width 767px, safe-area insets, drawer full-screen rule", () => {
    expect(phoneBlocks).toMatch(/input,[\s\S]*textarea,[\s\S]*select[\s\S]*font-size:\s*16px\s*!important/);
    expect(css).toMatch(/env\(safe-area-inset-top\)/);
    expect(css).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(phoneBlocks).toMatch(/\[data-mc-drawer\][\s\S]*width:\s*100%\s*!important/);
    expect(phoneBlocks).toMatch(/\[data-testid="task-detail-backdrop"\][\s\S]*display:\s*none/);
    expect(css).toMatch(/\.mc-sheet-body[\s\S]*overflow-y:\s*auto/);
  });
});
