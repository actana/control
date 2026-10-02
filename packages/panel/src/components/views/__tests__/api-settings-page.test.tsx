// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { ApiKeyView, WebhookView } from "~/shared/api-integrations-wire";
import { API_KEY_PLACEHOLDER, mcpAddCommand } from "~/shared/api-integrations-wire";

/**
 * Settings › API & integrations (screen 09; #572 / #573 / #574): create key
 * (shown once), restrict to Cores, revoke, MCP command with a placeholder, and
 * webhooks (create, last delivery, ping, delete). Plaintext never stays in
 * react-query or closed-dialog state.
 */

const KEYS: ApiKeyView[] = [
  {
    id: "key-1",
    name: "ci-deploy",
    prefix: "ak_1_3f9a12",
    allCores: true,
    coreIds: [],
    createdAt: Date.now() - 4 * 60_000,
    revokedAt: null,
  },
  {
    id: "key-2",
    name: "studio",
    prefix: "ak_1_91bc00",
    allCores: false,
    coreIds: ["core-a", "core-b"],
    createdAt: Date.now() - 2 * 3_600_000,
    revokedAt: null,
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
        createdAt: Date.now(),
        revokedAt: null,
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
        createdAt: Date.now(),
        revokedAt: Date.now(),
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
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <ApiSettingsPage />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
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
afterEach(() => cleanup());

describe("Settings › API & integrations", () => {
  it("lists keys and the MCP command with the Panel URL and a key placeholder", async () => {
    await act(async () => {
      mount();
    });
    expect(await screen.findByText("ci-deploy")).toBeTruthy();
    expect(screen.getByText(/workstation-berlin, build-box-01/)).toBeTruthy();
    expect(screen.getAllByText(/All Cores/).length).toBeGreaterThan(0);
    const mcp = mcpAddCommand("https://panel.example.com");
    expect(screen.getByText(mcp)).toBeTruthy();
    expect(mcp).toContain(API_KEY_PLACEHOLDER);
    expect(mcp).not.toMatch(/ak_1_[A-Za-z0-9_-]{10,}/);
    expect(screen.getByText(/last delivery 200/)).toBeTruthy();
  });

  it("creates a key restricted to chosen Cores and shows the plaintext exactly once", async () => {
    await act(async () => {
      mount();
    });
    await screen.findByText("ci-deploy");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Create API key/i }));
    });
    const dialog = screen.getByRole("dialog");
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText(/^Name$/i), { target: { value: "laptop" } });
      fireEvent.click(within(dialog).getByLabelText(/All Cores/i));
      fireEvent.click(within(dialog).getByLabelText(/workstation-berlin/i));
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /^Create$/i }));
    });
    expect(api.createApiKey).toHaveBeenCalledWith({ name: "laptop", coreIds: ["core-a"] });
    expect(screen.getByText(/ak_1_PLAINTEXT_SECRET/)).toBeTruthy();
    expect(screen.getByText(/only time the key/i)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Done$/i }));
    });
    expect(screen.queryByText(/ak_1_PLAINTEXT_SECRET/)).toBeNull();
    expect(screen.queryByText(/whsec_PLAINTEXT/)).toBeNull();
    const listed = JSON.stringify(api.listApiKeys.mock.results);
    expect(listed).not.toContain("PLAINTEXT_SECRET");
  });

  it("clears plaintext from state after the shown-once dialog closes", async () => {
    await act(async () => {
      mount();
    });
    await screen.findByText("ci-deploy");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Create API key/i }));
    });
    const dialog = screen.getByRole("dialog");
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText(/^Name$/i), { target: { value: "x" } });
      fireEvent.click(within(dialog).getByRole("button", { name: /^Create$/i }));
    });
    expect(screen.getByText(/ak_1_PLAINTEXT_SECRET/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Done$/i }));
    });
    expect(document.body.textContent).not.toContain("PLAINTEXT_SECRET");
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.getItem("api-key")).toBeNull();
  });

  it("asks for confirmation before revoking a key", async () => {
    await act(async () => {
      mount();
    });
    await screen.findByText("ci-deploy");
    const row = screen.getByText("ci-deploy").closest("[data-api-key-id]") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row).getByRole("button"));
    });
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: /^Revoke$/i }));
    });
    expect(api.revokeApiKey).not.toHaveBeenCalled();
    expect(screen.getByText(/Revoke API key/i)).toBeTruthy();
    await act(async () => {
      const confirms = screen.getAllByRole("button", { name: /^Revoke$/i });
      fireEvent.click(confirms[confirms.length - 1]!);
    });
    expect(api.revokeApiKey).toHaveBeenCalledWith("key-1");
  });

  it("pings a webhook and asks before delete", async () => {
    await act(async () => {
      mount();
    });
    await screen.findByText("https://hooks.example.com/actana");
    const row = screen.getByText("https://hooks.example.com/actana").closest("[data-webhook-id]") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row).getByRole("button"));
    });
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: /Send test/i }));
    });
    expect(api.pingWebhook).toHaveBeenCalledWith("wh-1");

    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: /^Delete$/i }));
    });
    expect(api.deleteWebhook).not.toHaveBeenCalled();
    await act(async () => {
      const confirms = screen.getAllByRole("button", { name: /^Delete$/i });
      fireEvent.click(confirms[confirms.length - 1]!);
    });
    expect(api.deleteWebhook).toHaveBeenCalledWith("wh-1");
  });

  it("creates a webhook and shows the secret once", async () => {
    await act(async () => {
      mount();
    });
    await screen.findByText("https://hooks.example.com/actana");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Add webhook/i }));
    });
    const dialog = screen.getByRole("dialog");
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText(/^URL$/i), {
        target: { value: "https://ci.example.com/tasks" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: /^Create$/i }));
    });
    expect(api.createWebhook).toHaveBeenCalled();
    expect(screen.getByText(/whsec_PLAINTEXT_SHOWN_ONCE/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Done$/i }));
    });
    expect(screen.queryByText(/whsec_PLAINTEXT/)).toBeNull();
  });
});
