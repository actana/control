// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { ApiKeyView, WebhookView } from "~/shared/api-integrations-wire";
import { ALL_API_KEY_PERMISSIONS } from "~/shared/api-key-permissions";

/** Create API key as a phone sheet (#835, design M66). Desktop keeps the centred Modal. */

const KEYS: ApiKeyView[] = [
  {
    id: "key-1",
    name: "ci-deploy",
    prefix: "ak_1_3f9a12",
    allCores: true,
    coreIds: [],
    permissions: [...ALL_API_KEY_PERMISSIONS],
    createdAt: Date.now() - 4 * 60_000,
    revokedAt: null,
    expiresAt: null,
  },
  {
    id: "key-2",
    name: "studio",
    prefix: "ak_1_91bc00",
    allCores: false,
    coreIds: ["core-a", "core-b"],
    permissions: ["read"],
    createdAt: Date.now() - 2 * 3_600_000,
    revokedAt: null,
    expiresAt: null,
  },
];

const WEBHOOKS: WebhookView[] = [
  {
    id: "wh-1",
    url: "https://hooks.example.com/actana",
    events: ["task.status_changed", "comment.created"],
    allCores: true,
    coreIds: [],
    createdAt: 1,
    updatedAt: 1,
    lastDelivery: {
      id: "wd-1",
      webhookId: "wh-1",
      eventType: "task.status_changed",
      status: "delivered",
      attemptCount: 0,
      lastStatusCode: 200,
      lastError: null,
      createdAt: Date.now() - 3 * 60_000,
      deliveredAt: Date.now() - 3 * 60_000,
      nextAttemptAt: null,
    },
  },
];

const { api } = vi.hoisted(() => {
  const api = {
    listApiKeys: vi.fn(async () => ({ apiKeys: [] as ApiKeyView[] })),
    createApiKey: vi.fn(async () => ({
      apiKey: {
        id: "key-new",
        name: "laptop",
        prefix: "ak_1_aabbcc",
        allCores: false,
        coreIds: ["core-a"],
        permissions: ["read"],
        createdAt: Date.now(),
        revokedAt: null,
        expiresAt: null,
      } satisfies ApiKeyView,
      key: "ak_1_PLAINTEXT_SECRET_SHOWN_ONCE_ONLY_xxxxxxxxxx",
    })),
    revokeApiKey: vi.fn(async () => ({
      apiKey: {
        id: "key-1",
        name: "ci-deploy",
        prefix: "ak_1_3f9a12",
        allCores: true,
        coreIds: [],
        permissions: [...ALL_API_KEY_PERMISSIONS],
        createdAt: Date.now(),
        revokedAt: Date.now(),
        expiresAt: null,
      } satisfies ApiKeyView,
    })),
    listWebhooks: vi.fn(async () => ({ webhooks: [] as WebhookView[] })),
    createWebhook: vi.fn(async () => ({
      webhook: {
        id: "wh-new",
        url: "https://ci.example.com/tasks",
        events: ["task.created"] as WebhookView["events"],
        allCores: true,
        coreIds: [],
        createdAt: 1,
        updatedAt: 1,
        lastDelivery: null,
      } satisfies WebhookView,
      secret: "whsec_PLAINTEXT_SHOWN_ONCE",
    })),
    deleteWebhook: vi.fn(async () => undefined),
    pingWebhook: vi.fn(async () => ({ outboxId: "wob-1" })),
    listWebhookDeliveries: vi.fn(async () => ({ deliveries: [] })),
    getKeybindings: vi.fn(async () => ({ bindings: {} })),
  };
  return { api };
});

vi.mock("~/lib/api", () => ({
  api,
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
      this.name = "ApiError";
    }
  },
}));

vi.mock("~/lib/use-fleet", () => ({
  useCores: () => ({
    cores: [
      {
        id: "core-a",
        label: "workstation-berlin",
        endpoint: "wss://a",
        lastEventId: 0,
        createdAt: 0,
        updatedAt: 0,
        dial: { coreId: "core-a", state: "connected", lastSeenAt: 1 },
      },
      {
        id: "core-b",
        label: "build-box-01",
        endpoint: "wss://b",
        lastEventId: 0,
        createdAt: 0,
        updatedAt: 0,
        dial: { coreId: "core-b", state: "connected", lastSeenAt: 1 },
      },
    ],
    loading: false,
    error: null,
  }),
}));

const { ApiSettingsPage } = await import("../ApiSettingsPage");

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false, gcTime: 5 * 60_000 } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <ApiSettingsPage />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockClear();
  api.listApiKeys.mockResolvedValue({ apiKeys: structuredClone(KEYS) });
  api.listWebhooks.mockResolvedValue({ webhooks: structuredClone(WEBHOOKS) });
  api.getKeybindings.mockResolvedValue({ bindings: {} });
  Object.defineProperty(window, "location", {
    value: { origin: "https://panel.example.com" },
    writable: true,
  });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
});


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

function stubVisualViewport(initial: { height: number; offsetTop: number }) {
  const vv = Object.assign(new EventTarget(), initial);
  vi.stubGlobal("visualViewport", vv);
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  return vv;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "visualViewport");
});

async function openSheet() {
  await act(async () => {
    mount();
  });
  await screen.findByText("ci-deploy");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Create API key/i }));
  });
  return document.querySelector<HTMLElement>("[data-full-screen-sheet]")!;
}

const header = (sheet: HTMLElement) => sheet.querySelector<HTMLElement>(".mc-sheet-header")!;
const body = (sheet: HTMLElement) => sheet.querySelector<HTMLElement>(".mc-sheet-body")!;
const footer = (sheet: HTMLElement) => sheet.querySelector<HTMLElement>(".mc-sheet-footer")!;

async function fillForm(sheet: HTMLElement) {
  await act(async () => {
    fireEvent.change(within(body(sheet)).getByLabelText(/^Name$/i), { target: { value: "laptop" } });
    fireEvent.click(within(body(sheet)).getByLabelText("tasks:write"));
    fireEvent.click(within(body(sheet)).getByLabelText(/Only these Cores/i));
  });
  await act(async () => {
    fireEvent.click(within(body(sheet)).getByLabelText("workstation-berlin"));
    fireEvent.change(within(body(sheet)).getByLabelText("Expiry"), { target: { value: "custom" } });
  });
  await act(async () => {
    fireEvent.change(within(body(sheet)).getByLabelText("Expiry date"), { target: { value: "2099-12-31" } });
  });
}

const EXPECTED = {
  name: "laptop",
  coreIds: ["core-a"],
  permissions: ["read", "tasks:write"],
  expiresAt: expect.any(Number),
};

describe("Create API key on phone (M66)", () => {
  beforeEach(() => stubWidth(390));

  it("Create API key opens as a full-screen sheet: Cancel · Create API key · Create", async () => {
    const sheet = await openSheet();
    expect(sheet).toBeTruthy();
    expect(Array.from(header(sheet).children).map((n) => n.textContent)).toEqual(["Cancel", "Create API key", "Create"]);
  });

  it("footer holds a single full-width Create (no Cancel) on phone", async () => {
    const sheet = await openSheet();
    const buttons = within(footer(sheet)).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Create"]);
    expect(footer(sheet).closest(".mc-sheet-body")).toBeNull();
    expect(body(sheet).contains(footer(sheet))).toBe(false);
  });

  it("Name, the 3 permission checkboxes, All Cores / Only these Cores radios, each Core checkbox, Expiry select and Expiry date are all inside .mc-sheet-body", async () => {
    const sheet = await openSheet();
    const b = within(body(sheet));
    expect(b.getByLabelText(/^Name$/i)).toBeTruthy();
    for (const p of ["read", "tasks:write", "agents:write"]) expect(b.getByLabelText(p)).toBeTruthy();
    expect(b.getByLabelText(/^All Cores$/i)).toBeTruthy();
    await act(async () => {
      fireEvent.click(b.getByLabelText(/Only these Cores/i));
      fireEvent.change(b.getByLabelText("Expiry"), { target: { value: "custom" } });
    });
    expect(b.getByLabelText("workstation-berlin")).toBeTruthy();
    expect(b.getByLabelText("build-box-01")).toBeTruthy();
    expect(b.getByLabelText("Expiry")).toBeTruthy();
    expect(b.getByLabelText("Expiry date")).toBeTruthy();
  });

  it("header Create submits name, permissions, chosen Cores and expiry", async () => {
    const sheet = await openSheet();
    await fillForm(sheet);
    await act(async () => {
      fireEvent.click(within(header(sheet)).getByRole("button", { name: "Create" }));
    });
    expect(api.createApiKey).toHaveBeenCalledTimes(1);
    expect(api.createApiKey).toHaveBeenCalledWith(EXPECTED);
  });

  it("footer Create submits the same payload", async () => {
    const sheet = await openSheet();
    await fillForm(sheet);
    await act(async () => {
      fireEvent.click(within(footer(sheet)).getByRole("button", { name: "Create" }));
    });
    expect(api.createApiKey).toHaveBeenCalledTimes(1);
    expect(api.createApiKey).toHaveBeenCalledWith(EXPECTED);
  });

  it("Create stays disabled until name, permission and scope are chosen", async () => {
    const sheet = await openSheet();
    const both = () => [
      within(header(sheet)).getByRole("button", { name: "Create" }) as HTMLButtonElement,
      within(footer(sheet)).getByRole("button", { name: "Create" }) as HTMLButtonElement,
    ];
    expect(both().map((x) => x.disabled)).toEqual([true, true]);
    await act(async () => {
      fireEvent.change(within(body(sheet)).getByLabelText(/^Name$/i), { target: { value: "bot" } });
    });
    expect(both().map((x) => x.disabled)).toEqual([true, true]); // no scope yet
    await act(async () => {
      fireEvent.click(within(body(sheet)).getByLabelText(/^All Cores$/i));
    });
    expect(both().map((x) => x.disabled)).toEqual([false, false]);
    await act(async () => {
      fireEvent.click(within(body(sheet)).getByLabelText("read"));
    });
    expect(both().map((x) => x.disabled)).toEqual([true, true]); // no permission left
  });

  it("with visualViewport height 420 (keyboard open) the sheet is 420px tall, .mc-sheet-body is the scroll box (overflow-y auto) and .mc-sheet-footer with Create stays outside the body", async () => {
    const vv = stubVisualViewport({ height: 780, offsetTop: 0 });
    const sheet = await openSheet();
    await act(async () => {
      vv.height = 420;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(sheet.style.height).toBe("420px");
    const css = readFileSync(path.resolve(__dirname, "../../../styles/mobile-sheet.css"), "utf8");
    expect(/\.mc-sheet-body\s*\{[^}]*overflow-y:\s*auto/.test(css)).toBe(true);
    expect(body(sheet).contains(footer(sheet))).toBe(false);
    expect(sheet.contains(footer(sheet))).toBe(true);
    expect(within(footer(sheet)).getByRole("button", { name: "Create" })).toBeTruthy();
  });

  it("choice rows and the expiry controls are ≥44px tall on phone", async () => {
    const sheet = await openSheet();
    const b = within(body(sheet));
    await act(async () => {
      fireEvent.click(b.getByLabelText(/Only these Cores/i));
      fireEvent.change(b.getByLabelText("Expiry"), { target: { value: "custom" } });
    });
    const rows = [
      ...["read", "tasks:write", "agents:write", "All Cores", "Only these Cores", "workstation-berlin", "build-box-01"].map(
        (l) => b.getByLabelText(l, { exact: true }).closest("label")!,
      ),
    ];
    for (const row of rows) expect(Number.parseInt(row.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
    for (const ctl of [b.getByLabelText("Expiry"), b.getByLabelText("Expiry date")]) {
      expect(Number.parseInt((ctl as HTMLElement).style.minHeight, 10)).toBeGreaterThanOrEqual(44);
      expect((ctl as HTMLElement).style.flex).toMatch(/^1/);
    }
  });

  it("Cancel closes without creating", async () => {
    const sheet = await openSheet();
    await act(async () => {
      fireEvent.click(within(header(sheet)).getByRole("button", { name: "Cancel" }));
    });
    expect(document.querySelector("[data-full-screen-sheet]")).toBeNull();
    expect(api.createApiKey).not.toHaveBeenCalled();
  });

  it("a key's Revoke is centred in the expanded row on phone", async () => {
    await act(async () => {
      mount();
    });
    const row = (await screen.findByText("ci-deploy")).closest("[data-api-key-id]") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row).getAllByRole("button")[0]);
    });
    const revoke = within(row).getByRole("button", { name: "Revoke" });
    expect(revoke.parentElement!.style.justifyContent).toBe("center");
  });
});

describe("API key row on phone (M65)", () => {
  it("phone: a key row stacks name, prefix, permissions and scope in one column", async () => {
    stubWidth(390);
    await act(async () => {
      mount();
    });
    const row = (await screen.findByText("ci-deploy")).closest("[data-api-key-id]") as HTMLElement;
    const name = within(row).getByText("ci-deploy");
    const perms = row.querySelector("[data-api-key-permissions]") as HTMLElement;
    const scope = row.querySelector("[data-api-key-scope]") as HTMLElement;
    const column = name.parentElement!;
    expect(column.contains(perms)).toBe(true);
    expect(column.contains(scope)).toBe(true);
    expect(perms.parentElement!.style.textAlign).not.toBe("right");
    expect(perms.parentElement!.style.textAlign).toBe("left");
  });
});

describe("Create API key on desktop is unchanged", () => {
  it("desktop (1280): centred Modal, no data-full-screen-sheet, footer Cancel + Create, choice rows without minHeight", async () => {
    stubWidth(1280);
    await act(async () => {
      mount();
    });
    await screen.findByText("ci-deploy");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Create API key/i }));
    });
    const dialog = screen.getByRole("dialog");
    expect(dialog.hasAttribute("data-full-screen-sheet")).toBe(false);
    expect(document.querySelector("[data-modal-open]")).not.toBeNull();
    expect(document.querySelector(".mc-sheet-header")).toBeNull();
    // footer: Cancel + Create, and no second Create in a header
    expect(within(dialog).getAllByRole("button", { name: /^Create$/ })).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByLabelText(/Only these Cores/i));
      fireEvent.change(within(dialog).getByLabelText("Expiry"), { target: { value: "custom" } });
    });
    for (const l of ["read", "All Cores", "workstation-berlin"]) {
      expect(within(dialog).getByLabelText(l).closest("label")!.style.minHeight).toBe("");
    }
    const select = within(dialog).getByLabelText("Expiry");
    expect(select.style.minHeight).toBe("");
    expect(select.style.flex).toBe("");
    expect(within(dialog).getByLabelText("read").getAttribute("style")).toBe("margin-top: 3px;");
  });

  it("desktop (1280): Revoke stays right-aligned", async () => {
    stubWidth(1280);
    await act(async () => {
      mount();
    });
    const row = (await screen.findByText("ci-deploy")).closest("[data-api-key-id]") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row).getAllByRole("button")[0]);
    });
    expect(within(row).getByRole("button", { name: "Revoke" }).parentElement!.style.justifyContent).toBe("flex-end");
  });

  it("desktop (1280): the key row keeps its right-aligned permissions/scope block beside the name column", async () => {
    stubWidth(1280);
    await act(async () => {
      mount();
    });
    const row = (await screen.findByText("ci-deploy")).closest("[data-api-key-id]") as HTMLElement;
    const column = within(row).getByText("ci-deploy").parentElement!;
    const perms = row.querySelector("[data-api-key-permissions]") as HTMLElement;
    expect(column.contains(perms)).toBe(false);
    expect(perms.parentElement!.style.textAlign).toBe("right");
  });
});
