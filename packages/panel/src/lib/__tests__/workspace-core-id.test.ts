import { describe, expect, it } from "vitest";
import { routeCoreIdFromLocation, workspaceCoreIdFromPath } from "../workspace-core-id";

describe("routeCoreIdFromLocation", () => {
  it("reads the Core off a Core page's path", () => {
    expect(routeCoreIdFromLocation({ pathname: "/cores/core_a", search: {} })).toBe("core_a");
  });

  it("reads it off the workspace beneath that page", () => {
    expect(routeCoreIdFromLocation({ pathname: "/cores/core_a/workspace", search: {} })).toBe("core_a");
  });

  it("decodes an encoded id", () => {
    expect(routeCoreIdFromLocation({ pathname: "/cores/core%20a", search: {} })).toBe("core a");
  });

  it("falls back to a `coreId` search param on a route outside /cores", () => {
    expect(routeCoreIdFromLocation({ pathname: "/settings", search: { coreId: "core_b" } })).toBe("core_b");
  });

  it("names no Core on the Fleet home", () => {
    expect(routeCoreIdFromLocation({ pathname: "/", search: {} })).toBeNull();
    expect(routeCoreIdFromLocation({ pathname: "/", search: { coreId: 3 } })).toBeNull();
  });
});

describe("workspaceCoreIdFromPath", () => {
  it("names the Core only on its workspace", () => {
    expect(workspaceCoreIdFromPath("/cores/core_a/workspace")).toBe("core_a");
  });

  it("names none on the Core page, where no Session panel sits beside the list", () => {
    expect(workspaceCoreIdFromPath("/cores/core_a")).toBeNull();
    expect(workspaceCoreIdFromPath("/")).toBeNull();
  });
});
