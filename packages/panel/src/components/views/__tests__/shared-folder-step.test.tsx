// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CoreWithDial } from "~/shared/cores";
import type { StorageConfigView } from "~/shared/storage-wire";

/**
 * Step 4 of pairing from the Panel, and the delete confirmation (#564): what the page itself must hold to, which a
 * server suite cannot see: Finish is disabled until a test of these fields passed, the master key is a write-only
 * box that is never filled and never shown, and a delete cannot be confirmed with anything but the exact prefix.
 */

class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const MASTER = "-----BEGIN PRIVATE KEY-----\nTHIS-IS-THE-MASTER-KEY-BODY\n-----END PRIVATE KEY-----";

function core(extra: Partial<CoreWithDial> = {}): CoreWithDial {
  return {
    id: "core_new",
    endpoint: "wss://prod-vm-1.internal:7777",
    label: "workstation-berlin",
    lastEventId: 0,
    createdAt: 0,
    updatedAt: 0,
    dial: { coreId: "core_new", state: "connected", lastSeenAt: 1 },
    sharedFolder: { state: "pending", prefix: null, keyExpiresAt: null, error: null },
    ...extra,
  };
}

const STORAGE_EMPTY: StorageConfigView = {
  configured: false,
  backend: null,
  endpoint: null,
  bucket: null,
  prefix: null,
  region: null,
  oidcIssuer: null,
  oidcAudience: null,
  keyId: null,
  masterKeySet: false,
  updatedAt: null,
};
const STORAGE_SET: StorageConfigView = {
  ...STORAGE_EMPTY,
  configured: true,
  backend: "seaweedfs",
  endpoint: "http://seaweedfs:8333",
  bucket: "actana-shared",
  prefix: "cores",
  region: "us-east-1",
  oidcIssuer: "https://panel.example.test",
  oidcAudience: "actana-shared",
  keyId: "k1",
  masterKeySet: true,
  updatedAt: 1,
};
const PASSED = { folder: "cores/core_new/", expiresAt: 1_790_000_000_000, read: true, write: true, listOwn: true, reachOther: false };

let CORES: CoreWithDial[] = [];

const api = {
  listCores: vi.fn(async () => ({ cores: CORES })),
  getStorage: vi.fn(async () => ({ storage: STORAGE_SET })),
  putStorage: vi.fn(async (_body: unknown) => ({ storage: STORAGE_SET })),
  testSharedFolder: vi.fn(async () => ({ result: PASSED })),
  finishCorePairing: vi.fn(async (): Promise<{ core: CoreWithDial }> => ({ core: core({ sharedFolder: { state: "attached", prefix: "cores/core_new/", keyExpiresAt: 1, error: null } }) })),
  deleteCoreWithStorage: vi.fn(async (_id: string, _prefix: string) => ({ prefix: "cores/core_new/", removed: 3 })),
  removeCore: vi.fn(async () => undefined),
  renameCore: vi.fn(),
  inspectCoreForPairing: vi.fn(),
  pairCore: vi.fn(),
  getKeybindings: vi.fn(async () => ({ bindings: {} })),
  getSettings: vi.fn(async () => ({})),
};
const toasts = { success: vi.fn(), error: vi.fn() };

vi.mock("~/lib/api", () => ({ api, ApiError }));
vi.mock("sonner", () => ({ toast: toasts }));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CoresSettingsPage } = await import("../CoresSettingsPage");
const { KeybindingsProvider } = await import("~/lib/keybindings/store");

async function openSettings(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KeybindingsProvider>
        <CoresSettingsPage />
      </KeybindingsProvider>
    </QueryClientProvider>,
  );
  await act(async () => {});
}

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(button(name));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  CORES = [core()];
  api.listCores.mockImplementation(async () => ({ cores: CORES }));
  api.getStorage.mockImplementation(async () => ({ storage: STORAGE_SET }));
  api.putStorage.mockImplementation(async () => ({ storage: STORAGE_SET }));
  api.testSharedFolder.mockImplementation(async () => ({ result: PASSED }));
});
afterEach(cleanup);

describe("pairing step 4: the Shared folder", () => {
  it("resumes for a Core whose pairing was left unfinished, and names its own folder", async () => {
    await openSettings();
    expect(document.querySelector('[data-step="shared-folder"]')).not.toBeNull();
    expect((screen.getByLabelText("This Core's folder") as HTMLInputElement).value).toBe("cores/core_new/");
    expect(screen.queryByLabelText("Core address")).toBeNull();
  });

  it("keeps Finish disabled until a test passed, and again after any field is edited", async () => {
    await openSettings();
    expect(button("Connect and finish pairing").disabled).toBe(true);

    await click("Test connection");
    expect(document.querySelector('[data-connection="passed"]')).not.toBeNull();
    expect(button("Connect and finish pairing").disabled).toBe(false);

    await act(async () => {
      type("Bucket", "another-bucket");
    });
    expect(button("Connect and finish pairing").disabled).toBe(true);
    expect(document.querySelector("[data-connection]")).toBeNull();
    expect(api.finishCorePairing).not.toHaveBeenCalled();
  });

  it("does not let a failed test through: a key that reaches another Core's folder is a FAILED, not a pass", async () => {
    api.testSharedFolder.mockImplementation(async () => ({ result: { ...PASSED, reachOther: true } }));
    await openSettings();
    await click("Test connection");
    expect(document.querySelector('[data-connection="failed"]')).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("FAILED");
    expect(button("Connect and finish pairing").disabled).toBe(true);
  });

  it("shows what the Panel said when a step is refused, and does not finish", async () => {
    api.testSharedFolder.mockRejectedValueOnce(new ApiError("Storage is not configured: set the endpoint first.", 409, {}));
    await openSettings();
    await click("Test connection");
    expect(screen.getByRole("alert").textContent).toContain("Storage is not configured");
    expect(button("Connect and finish pairing").disabled).toBe(true);

    await click("Test connection");
    api.finishCorePairing.mockRejectedValueOnce(new ApiError("The Core refused the Shared folder: mount-failed: no route", 409, {}));
    await click("Connect and finish pairing");
    expect(screen.getByRole("alert").textContent).toContain("mount-failed");
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("finishes by attaching, then reports the Core paired", async () => {
    await openSettings();
    await click("Test connection");
    await click("Connect and finish pairing");
    expect(api.finishCorePairing).toHaveBeenCalledWith("core_new");
    expect(toasts.success).toHaveBeenCalledWith('Core "workstation-berlin" paired.');
  });

  it("takes the master key through a write-only box: never filled, sent once, then dropped from the page", async () => {
    api.getStorage.mockImplementation(async () => ({ storage: STORAGE_EMPTY }));
    await openSettings();
    const box = screen.getByLabelText("Master key") as HTMLInputElement;
    expect(box.type).toBe("password");
    expect(box.value).toBe("");
    // Nothing to test with until there is a key.
    for (const [label, v] of [["S3 endpoint", "http://s3:8333"], ["Bucket", "actana-shared"], ["OIDC issuer", "https://p"], ["Key id", "k1"]] as const) type(label, v);
    expect(button("Test connection").disabled).toBe(true);
    await act(async () => {
      type("Master key", MASTER);
    });
    await click("Test connection");

    expect(api.putStorage).toHaveBeenCalledTimes(1);
    expect(api.putStorage.mock.calls[0]![0]).toMatchObject({ masterKey: MASTER.replace(/\n/g, ""), bucket: "actana-shared", prefix: "cores" });
    expect((screen.getByLabelText("Master key") as HTMLInputElement).value).toBe("");
    expect(document.body.innerHTML).not.toContain("THIS-IS-THE-MASTER-KEY-BODY");
    // A later edit does not send the key again: the Panel keeps the one it has.
    await act(async () => {
      type("Bucket", "second-bucket");
    });
    await click("Test connection");
    expect(api.putStorage.mock.calls[1]![0]).not.toHaveProperty("masterKey");
  });

  it("says plainly that the master key stays in the Panel", async () => {
    await openSettings();
    expect(document.body.textContent).toMatch(/never sends it to a Core/);
  });
});

describe("delete: the Core and its Shared folder", () => {
  const attached = (): CoreWithDial =>
    core({ sharedFolder: { state: "attached", prefix: "cores/core_new/", keyExpiresAt: 1, error: null } });

  beforeEach(() => {
    CORES = [attached()];
  });

  it("offers Delete only for a Core that has a folder in S3", async () => {
    CORES = [core({ sharedFolder: undefined })];
    await openSettings();
    expect(screen.queryByRole("button", { name: /Delete Core/ })).toBeNull();
    cleanup();
    // The same page for a Core that does have one: the button is there, so the absence above is a decision.
    CORES = [attached()];
    await openSettings();
    expect(screen.getByRole("button", { name: /Delete Core workstation-berlin and its Shared folder/ })).toBeTruthy();
  });

  it("cannot be confirmed with anything but the exact prefix", async () => {
    await openSettings();
    await click(/Delete Core workstation-berlin and its Shared folder/);
    expect(document.body.textContent).toContain("cores/core_new/");
    const confirm = () => button("Delete Core and folder");
    expect(confirm().disabled).toBe(true);
    for (const wrong of ["core_new", "cores/core_new", "cores/", "cores/core_new/ "]) {
      await act(async () => {
        type("Prefix", wrong);
      });
      expect(confirm().disabled, wrong).toBe(true);
    }
    await act(async () => {
      type("Prefix", "cores/core_new/");
    });
    expect(confirm().disabled).toBe(false);
    await click("Delete Core and folder");
    expect(api.deleteCoreWithStorage).toHaveBeenCalledWith("core_new", "cores/core_new/");
    expect(toasts.success).toHaveBeenCalledWith('Core "workstation-berlin" and its Shared folder deleted.');
  });

  it("shows the Shared folder's error on the Core when its key could not be refreshed", async () => {
    CORES = [core({ sharedFolder: { state: "error", prefix: "cores/core_new/", keyExpiresAt: 1, error: "core-link request timed out" } })];
    await openSettings();
    expect(document.querySelector('[data-shared-folder="error"]')).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("core-link request timed out");
  });
});
