// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeybindingsProvider } from "~/lib/keybindings/store";
import type { ApiKeyView, WebhookView } from "~/shared/api-integrations-wire";
import { ALL_API_KEY_PERMISSIONS } from "~/shared/api-key-permissions";
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
afterEach(() => cleanup());

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function mutationCacheBlob(client: QueryClient): string {
  return JSON.stringify(
    client.getMutationCache().getAll().map((m) => ({
      data: m.state.data,
      error: m.state.error,
      variables: m.state.variables,
    })),
  );
}

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

  it("shows each key's permissions next to its Core scope (#688)", async () => {
    await act(async () => {
      mount();
    });
    const full = (await screen.findByText("ci-deploy")).closest("[data-api-key-id]") as HTMLElement;
    expect(full.querySelector("[data-api-key-permissions]")!.textContent).toBe("read · tasks:write · agents:write");
    expect(full.querySelector("[data-api-key-scope]")!.textContent).toMatch(/^All Cores · created/);
    const readOnly = screen.getByText("studio").closest("[data-api-key-id]") as HTMLElement;
    expect(readOnly.querySelector("[data-api-key-permissions]")!.textContent).toBe("read");
    expect(readOnly.querySelector("[data-api-key-scope]")!.textContent).toMatch(/^workstation-berlin, build-box-01 · created/);
  });

  it("asks for the permissions and the Core scope: read is preselected, no scope is, and Create waits for both (#688)", async () => {
    await act(async () => {
      mount();
    });
    await screen.findByText("ci-deploy");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Create API key/i }));
    });
    const dialog = screen.getByRole("dialog");
    const create = () => within(dialog).getByRole("button", { name: /^Create$/i }) as HTMLButtonElement;
    const box = (name: string) => within(dialog).getByLabelText(name) as HTMLInputElement;
    expect(box("read").checked).toBe(true);
    expect(box("tasks:write").checked).toBe(false);
    expect(box("agents:write").checked).toBe(false);
    expect(within(dialog).getByText(/Create and delete Agents/)).toBeTruthy();
    expect((within(dialog).getByLabelText(/^All Cores$/i) as HTMLInputElement).checked).toBe(false);
    expect((within(dialog).getByLabelText(/Only these Cores/i) as HTMLInputElement).checked).toBe(false);

    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText(/^Name$/i), { target: { value: "bot" } });
    });
    expect(create().disabled).toBe(true); // a name and read, but no Core scope chosen yet
    await act(async () => {
      fireEvent.click(within(dialog).getByLabelText(/^All Cores$/i));
    });
    expect(create().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(box("read"));
    });
    expect(create().disabled).toBe(true); // a scope, but no permission left
    await act(async () => {
      fireEvent.click(box("agents:write"));
      fireEvent.click(box("read"));
      fireEvent.click(box("tasks:write"));
    });
    await act(async () => {
      fireEvent.click(create());
    });
    expect(api.createApiKey).toHaveBeenCalledWith({
      name: "bot",
      coreIds: null,
      permissions: ["read", "tasks:write", "agents:write"],
      expiresAt: null,
    });
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
      fireEvent.click(within(dialog).getByLabelText(/Only these Cores/i));
      fireEvent.click(within(dialog).getByLabelText(/workstation-berlin/i));
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /^Create$/i }));
    });
    expect(api.createApiKey).toHaveBeenCalledWith({ name: "laptop", coreIds: ["core-a"], permissions: ["read"], expiresAt: null });
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

  it("clears plaintext from state and the mutation cache after the shown-once dialog closes", async () => {
    let client!: QueryClient;
    await act(async () => {
      client = mount().client;
    });
    await screen.findByText("ci-deploy");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Create API key/i }));
    });
    const dialog = screen.getByRole("dialog");
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText(/^Name$/i), { target: { value: "x" } });
      fireEvent.click(within(dialog).getByLabelText(/^All Cores$/i));
      fireEvent.click(within(dialog).getByRole("button", { name: /^Create$/i }));
    });
    expect(screen.getByText(/ak_1_PLAINTEXT_SECRET/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Done$/i }));
    });
    expect(document.body.textContent).not.toContain("PLAINTEXT_SECRET");
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.getItem("api-key")).toBeNull();
    expect(mutationCacheBlob(client)).not.toContain("PLAINTEXT_SECRET");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Add webhook/i }));
    });
    const hookDialog = screen.getByRole("dialog");
    await act(async () => {
      fireEvent.change(within(hookDialog).getByLabelText(/^URL$/i), {
        target: { value: "https://ci.example.com/tasks" },
      });
      fireEvent.click(within(hookDialog).getByRole("button", { name: /^Create$/i }));
    });
    expect(screen.getByText(/whsec_PLAINTEXT_SHOWN_ONCE/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Done$/i }));
    });
    expect(document.body.textContent).not.toContain("whsec_PLAINTEXT");
    expect(mutationCacheBlob(client)).not.toContain("whsec_PLAINTEXT");
    expect(mutationCacheBlob(client)).not.toContain("PLAINTEXT_SECRET");
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

  it("shows a future webhook retry as in N minutes, not just now", async () => {
    const now = Date.now();
    api.listWebhooks.mockResolvedValue({
      webhooks: [
        {
          ...WEBHOOKS[0]!,
          lastDelivery: {
            id: "wd-retry",
            webhookId: "wh-1",
            eventType: "task.status_changed",
            status: "pending",
            attemptCount: 1,
            lastStatusCode: 500,
            lastError: "upstream",
            createdAt: now - 60_000,
            deliveredAt: null,
            nextAttemptAt: now + 5 * 60_000,
          },
        },
      ],
    });
    await act(async () => {
      mount();
    });
    expect(await screen.findByText(/retry in 5 minutes/i)).toBeTruthy();
    expect(screen.queryByText(/retry just now/i)).toBeNull();
  });

  it("shows a refused create error inside the open dialog", async () => {
    api.createWebhook.mockRejectedValueOnce(
      new Error("URL must be https and must not target a private address"),
    );
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
        target: { value: "http://127.0.0.1/hook" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: /^Create$/i }));
    });
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(/https|private/i);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByText(/whsec_PLAINTEXT/)).toBeNull();
  });

  describe("expiry (#689)", () => {
    async function openCreate(name: string) {
      await act(async () => {
        mount();
      });
      await screen.findByText("ci-deploy");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Create API key/i }));
      });
      const dialog = screen.getByRole("dialog");
      await act(async () => {
        fireEvent.change(within(dialog).getByLabelText(/^Name$/i), { target: { value: name } });
        // #688: no scope is preselected, so pick All Cores before Create.
        fireEvent.click(within(dialog).getByLabelText(/^All Cores$/i));
      });
      return dialog;
    }

    it("defaults to Never, which sends no expiry", async () => {
      const dialog = await openCreate("forever");
      expect((within(dialog).getByLabelText(/^Expiry$/i) as HTMLSelectElement).value).toBe("never");
      expect(within(dialog).getByText(/works until you revoke it/i)).toBeTruthy();
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: /^Create$/i }));
      });
      expect(api.createApiKey).toHaveBeenCalledWith({ name: "forever", coreIds: null, permissions: ["read"], expiresAt: null });
    });

    it("offers 7, 30 and 90 days, and sends the instant that many days from now", async () => {
      const dialog = await openCreate("month");
      const select = within(dialog).getByLabelText(/^Expiry$/i) as HTMLSelectElement;
      expect([...select.options].map((o) => o.textContent)).toEqual(["Never", "7 days", "30 days", "90 days", "Custom date"]);
      const before = Date.now();
      await act(async () => {
        fireEvent.change(select, { target: { value: "30d" } });
      });
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: /^Create$/i }));
      });
      const after = Date.now();
      const sent = (api.createApiKey.mock.calls[0] as unknown as [{ expiresAt: number }])[0].expiresAt;
      expect(sent).toBeGreaterThanOrEqual(before + 30 * 86_400_000);
      expect(sent).toBeLessThanOrEqual(after + 30 * 86_400_000);
    });

    it("takes a custom date as the end of that day, and will not create with a past or missing date", async () => {
      const dialog = await openCreate("custom");
      await act(async () => {
        fireEvent.change(within(dialog).getByLabelText(/^Expiry$/i), { target: { value: "custom" } });
      });
      const create = within(dialog).getByRole("button", { name: /^Create$/i }) as HTMLButtonElement;
      expect(create.disabled).toBe(true);
      const date = within(dialog).getByLabelText(/Expiry date/i);
      await act(async () => {
        fireEvent.change(date, { target: { value: "2001-01-01" } });
      });
      expect(create.disabled).toBe(true);
      expect(within(dialog).getByText(/Pick a date after today/i)).toBeTruthy();
      const future = new Date();
      future.setFullYear(future.getFullYear() + 1);
      const day = localDay(future);
      await act(async () => {
        fireEvent.change(date, { target: { value: day } });
      });
      expect(create.disabled).toBe(false);
      await act(async () => {
        fireEvent.click(create);
      });
      const sent = (api.createApiKey.mock.calls[0] as unknown as [{ expiresAt: number }])[0].expiresAt;
      const end = new Date(future.getFullYear(), future.getMonth(), future.getDate(), 23, 59, 59, 999).getTime();
      expect(sent).toBe(end);
    });

    // West of UTC the local day and the UTC day differ every evening; pin a zone and an evening so this
    // fails if the picker and the list ever read the day in different timezones again (review r1).
    it("reads the picked day, the list label and the earliest pick in one timezone (America/New_York, 21:00)", async () => {
      const tz = process.env.TZ;
      process.env.TZ = "America/New_York";
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-11T01:00:00Z")); // 2026-10-10 21:00 in New York
      try {
        const dialog = await openCreate("new-york");
        await act(async () => {
          fireEvent.change(within(dialog).getByLabelText(/^Expiry$/i), { target: { value: "custom" } });
        });
        const date = within(dialog).getByLabelText(/Expiry date/i) as HTMLInputElement;
        // Tomorrow in New York is the 11th; UTC is already on the 11th, so a UTC day would say the 12th.
        expect(date.min).toBe("2026-10-11");
        await act(async () => {
          fireEvent.change(date, { target: { value: "2026-12-31" } });
        });
        api.listApiKeys.mockResolvedValue({ apiKeys: [] });
        await act(async () => {
          fireEvent.click(within(dialog).getByRole("button", { name: /^Create$/i }));
        });
        const sent = (api.createApiKey.mock.calls[0] as unknown as [{ expiresAt: number }])[0].expiresAt;
        expect(sent).toBe(Date.parse("2027-01-01T04:59:59.999Z")); // end of 2026-12-31 in New York
        cleanup();
        api.listApiKeys.mockResolvedValue({
          apiKeys: [{ ...KEYS[0]!, id: "k-ny", name: "ny-key", expiresAt: sent }],
        });
        await act(async () => {
          mount();
        });
        const row = (await screen.findByText("ny-key")).closest("[data-api-key-id]") as HTMLElement;
        expect(row.textContent).toMatch(/expires 2026-12-31/);
      } finally {
        vi.useRealTimers();
        if (tz === undefined) delete process.env.TZ;
        else process.env.TZ = tz;
      }
    });

    it("shows each key's expiry date in the list, and marks an expired key", async () => {
      const now = Date.now();
      api.listApiKeys.mockResolvedValue({
        apiKeys: [
          { ...KEYS[0]!, id: "k-never", name: "never-key", expiresAt: null },
          { ...KEYS[0]!, id: "k-later", name: "later-key", expiresAt: new Date(2099, 4, 17, 12).getTime() },
          { ...KEYS[0]!, id: "k-gone", name: "gone-key", expiresAt: now - 86_400_000 },
          { ...KEYS[0]!, id: "k-revoked", name: "revoked-key", expiresAt: now - 86_400_000, revokedAt: now - 2 * 86_400_000 },
        ],
      });
      await act(async () => {
        mount();
      });
      const row = (name: string) => screen.getByText(name).closest("[data-api-key-id]") as HTMLElement;
      await screen.findByText("never-key");
      expect(row("never-key").textContent).toMatch(/no expiry/);
      expect(row("never-key").dataset.expired).toBe("false");
      expect(row("later-key").textContent).toMatch(/expires 2099-05-17/);
      expect(row("later-key").dataset.expired).toBe("false");
      expect(within(row("later-key")).queryByText(/^Expired$/)).toBeNull();
      const gone = row("gone-key");
      expect(gone.dataset.expired).toBe("true");
      expect(within(gone).getByText(/^Expired$/)).toBeTruthy();
      expect(gone.textContent).toContain(`expired ${localDay(new Date(now - 86_400_000))}`);
      // A revoked key reads as revoked, not as expired.
      expect(row("revoked-key").dataset.expired).toBe("false");
      expect(row("revoked-key").textContent).toMatch(/revoked/);
    });
  });
});
