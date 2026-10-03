// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { StorageConfigInput, StorageConfigView, StorageCoreFolderView } from "~/shared/storage-wire";

/**
 * Settings › Storage (screen 08, #566): SeaweedFS is the default tab, the master key is write-only,
 * and per-Core rows show size and key expiry from the server.
 */

const STORAGE_EMPTY: StorageConfigView = {
  configured: false,
  backend: null,
  endpoint: null,
  issuerEndpoint: null,
  bucket: null,
  prefix: null,
  region: null,
  oidcIssuer: null,
  oidcAudience: null,
  keyId: null,
  roleArn: null,
  accountId: null,
  parentAccessKeyId: null,
  anonKey: null,
  masterKeySet: false,
  masterKeyRotatedAt: null,
  uploadSizeLimitBytes: null,
  updatedAt: null,
};

const STORAGE_SET: StorageConfigView = {
  ...STORAGE_EMPTY,
  configured: true,
  backend: "seaweedfs",
  endpoint: "https://s3.panel.internal:8333",
  bucket: "actana-shared",
  prefix: "cores",
  region: "us-east-1",
  oidcIssuer: "https://panel.example.test",
  oidcAudience: "actana-shared",
  keyId: "k1",
  masterKeySet: true,
  masterKeyRotatedAt: Date.now() - 12 * 24 * 60 * 60 * 1000,
  uploadSizeLimitBytes: 512 * 1024 * 1024,
  updatedAt: 1,
};

const CORES: StorageCoreFolderView[] = [
  {
    coreId: "core_a",
    label: "workstation-berlin",
    prefix: "cores/workstation-berlin/",
    sizeBytes: 412 * 1024 * 1024,
    keyExpiresAt: Date.now() + 60_000,
    state: "attached",
    offline: false,
    error: null,
  },
  {
    coreId: "core_b",
    label: "gpu-rig-02",
    prefix: "cores/gpu-rig-02/",
    sizeBytes: 38 * 1024 * 1024,
    keyExpiresAt: Date.now() - 60_000,
    state: "attached",
    offline: true,
    error: null,
  },
];

const api = {
  getStorage: vi.fn(async () => ({ storage: STORAGE_SET, cores: CORES })),
  putStorage: vi.fn(async (_input: StorageConfigInput) => ({ storage: STORAGE_SET })),
  testStorage: vi.fn(async () => ({
    result: { folder: "cores/probe_abc/", expiresAt: Date.now() + 3_600_000, read: true, write: true, listOwn: true, reachOther: false },
  })),
};

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

const { StorageSettingsPage } = await import("../StorageSettingsPage");

beforeEach(() => {
  api.getStorage.mockClear();
  api.putStorage.mockClear();
  api.testStorage.mockClear();
  api.getStorage.mockResolvedValue({ storage: STORAGE_SET, cores: CORES });
});
afterEach(() => cleanup());

describe("Settings › Storage", () => {
  it("defaults to the SeaweedFS tab and shows per-Core size and key expiry", async () => {
    await act(async () => {
      render(<StorageSettingsPage />);
    });
    const seaweed = screen.getByRole("tab", { name: /SeaweedFS/i });
    expect(seaweed.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("workstation-berlin")).toBeTruthy();
    expect(screen.getByText(/412 MB/)).toBeTruthy();
    expect(screen.getByText(/offline · key expired/)).toBeTruthy();
    expect(screen.getByText(/master key · held by the Panel only/)).toBeTruthy();
    expect(screen.getByText(/last rotated 12 days ago/)).toBeTruthy();
  });

  it("never fills the master key box from the server, and Test connection saves then probes", async () => {
    await act(async () => {
      render(<StorageSettingsPage />);
    });
    const master = screen.getByLabelText(/^Master key$/i) as HTMLInputElement;
    expect(master.value).toBe("");
    expect(master.type).toBe("password");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Test connection/i }));
    });
    expect(api.putStorage).toHaveBeenCalled();
    expect(api.testStorage).toHaveBeenCalled();
    expect(screen.getByRole("status").getAttribute("data-connection")).toBe("passed");
    // Still empty after a successful save: write-only.
    expect((screen.getByLabelText(/^Master key$/i) as HTMLInputElement).value).toBe("");
  });

  it("starts on SeaweedFS even when storage is empty", async () => {
    api.getStorage.mockResolvedValue({ storage: STORAGE_EMPTY, cores: [] });
    await act(async () => {
      render(<StorageSettingsPage />);
    });
    expect(screen.getByRole("tab", { name: /SeaweedFS/i }).getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole("tablist")).getByRole("tab", { name: /S3 STS/i })).toBeTruthy();
  });

  it("Save with a typed master key refuses and points at Rotate when one is already stored", async () => {
    await act(async () => {
      render(<StorageSettingsPage />);
    });
    const master = screen.getByLabelText(/^Master key$/i) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(master, { target: { value: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    });
    expect(api.putStorage).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/Rotate/i);
    expect(master.value).toContain("PRIVATE KEY");
  });

  it("asks S3 STS for its AssumeRole URL and the S3 host separately, with no not-usable note", async () => {
    await act(async () => {
      render(<StorageSettingsPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: /S3 STS/i }));
    });
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByLabelText("STS AssumeRole URL")).toBeTruthy();
    expect(screen.getByLabelText("S3 API endpoint")).toBeTruthy();
    expect(screen.getByLabelText(/Role ARN/i)).toBeTruthy();
  });

  it("asks Supabase for its project URL, leaves the S3 host to be derived, and saves both", async () => {
    await act(async () => {
      render(<StorageSettingsPage />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: /Supabase/i }));
    });
    expect(screen.queryByRole("note")).toBeNull();
    const project = screen.getByLabelText("Supabase project URL") as HTMLInputElement;
    const s3 = screen.getByLabelText("S3 API endpoint") as HTMLInputElement;
    expect(s3.placeholder).toMatch(/storage\/v1\/s3/);
    await act(async () => {
      fireEvent.change(project, { target: { value: "https://xyz.supabase.co" } });
      fireEvent.change(s3, { target: { value: "" } });
      fireEvent.change(screen.getByLabelText(/Anon key/i), { target: { value: "anon" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    });
    expect(api.putStorage).toHaveBeenCalledTimes(1);
    const sent = api.putStorage.mock.calls[0]![0];
    expect(sent.backend).toBe("supabase");
    expect(sent.issuerEndpoint).toBe("https://xyz.supabase.co");
    expect(sent.endpoint).toBe("");
  });
});
