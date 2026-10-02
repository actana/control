import { describe, expect, it } from "vitest";
import type { CoreSharedFolder, CoreWithDial } from "~/shared/cores";
import {
  coreActivity,
  coreForHotkey,
  coreInitials,
  corePillParts,
  railCores,
} from "~/lib/core-rail";

function core(id: string, label: string, state: CoreWithDial["dial"]["state"] = "connected"): CoreWithDial {
  return {
    id,
    endpoint: "wss://x",
    label,
    lastEventId: 0,
    createdAt: 0,
    updatedAt: 0,
    dial: { coreId: id, state, lastSeenAt: 1 },
  };
}

describe("the Cores rail", () => {
  it("orders Cores by label so a refresh never reshuffles the hotkeys", () => {
    const cores = [core("c", "gpu-rig-02"), core("a", "build-box-01"), core("b", "workstation-berlin")];
    expect(railCores(cores).map((c) => c.label)).toEqual([
      "build-box-01",
      "gpu-rig-02",
      "workstation-berlin",
    ]);
  });

  it("addresses the first nine Cores with digits 1 to 9 and nothing else", () => {
    const cores = Array.from({ length: 11 }, (_, i) => core(`c${i}`, `core-${String(i).padStart(2, "0")}`));
    expect(coreForHotkey(cores, 1)?.label).toBe("core-00");
    expect(coreForHotkey(cores, 9)?.label).toBe("core-08");
    expect(coreForHotkey(cores, 10)).toBeUndefined();
    expect(coreForHotkey(cores, 0)).toBeUndefined();
    expect(coreForHotkey(cores.slice(0, 2), 3)).toBeUndefined();
  });

  it("draws two-letter initials from the label", () => {
    expect(coreInitials("workstation-berlin")).toBe("WB");
    expect(coreInitials("gpu")).toBe("GP");
    expect(coreInitials("build_box_01")).toBe("BB");
    expect(coreInitials("---")).toBe("?");
  });

  it("counts running and needs-input Sessions for one Core only", () => {
    const rows = [
      { coreId: "a", status: "running" },
      { coreId: "a", status: "running" },
      { coreId: "a", status: "needs-input" },
      { coreId: "a", status: "finished" },
      { coreId: "b", status: "running" },
    ];
    expect(coreActivity(rows, "a")).toEqual({ running: 2, needsInput: 1, total: 4 });
    expect(coreActivity(rows, "zzz")).toEqual({ running: 0, needsInput: 0, total: 0 });
  });
});

describe("the status pill", () => {
  const folder = (state: CoreSharedFolder["state"]): CoreSharedFolder => ({
    state,
    prefix: state === "pending" ? null : "cores/a/",
    keyExpiresAt: state === "attached" ? 1 : null,
    error: state === "error" ? "push failed" : null,
  });

  it("says online for a connected Core and offline for any Core that is not reachable", () => {
    expect(corePillParts(core("a", "a").dial).link).toBe("online");
    expect(corePillParts(core("a", "a", "unreachable").dial).link).toBe("offline");
  });

  it("carries the core-link protocol version from the dial when the Core reported one", () => {
    expect(corePillParts(core("a", "a").dial).version).toBeNull();
    const dial = { ...core("a", "a").dial, coreVersion: "0.19.0" };
    expect(corePillParts(dial).version).toBe("0.19.0");
  });

  it("names the Shared folder as attached, pending, failed, or none", () => {
    expect(corePillParts(core("a", "a").dial).shared).toBe("shared —");
    expect(corePillParts(core("a", "a").dial, undefined).shared).toBe("shared —");
    expect(corePillParts(core("a", "a").dial, folder("attached")).shared).toBe("shared attached");
    expect(corePillParts(core("a", "a").dial, folder("pending")).shared).toBe("shared pending");
    expect(corePillParts(core("a", "a").dial, folder("error")).shared).toBe("shared failed");
  });

  it("reads online, protocol version and Shared folder together for a connected Core", () => {
    const dial = { ...core("a", "a").dial, coreVersion: "0.19.0" };
    expect(corePillParts(dial, folder("attached"))).toEqual({
      link: "online",
      version: "0.19.0",
      shared: "shared attached",
    });
  });
});
