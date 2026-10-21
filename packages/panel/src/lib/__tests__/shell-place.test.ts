import { describe, expect, it } from "vitest";
import { shellPlace } from "~/lib/shell-place";
import type { CoreWithDial } from "~/shared/cores";

const core = (state: CoreWithDial["dial"]["state"]): CoreWithDial => ({
  id: "c1",
  endpoint: "wss://x",
  label: "workstation-berlin",
  lastEventId: 0,
  createdAt: 0,
  updatedAt: 0,
  dial: { coreId: "c1", state, lastSeenAt: 1 },
});
const base = { pathname: "/", routeCoreId: null, cores: [core("connected")], settingsOpen: false, usageOpen: false };

describe("shellPlace", () => {
  it("says Fleet on / and /fleet", () => {
    expect(shellPlace(base)).toEqual({ label: "Fleet" });
    expect(shellPlace({ ...base, pathname: "/fleet" })).toEqual({ label: "Fleet" });
  });
  it("says the Core label and its link state on a Core page and its workspace", () => {
    for (const pathname of ["/cores/c1", "/cores/c1/workspace"]) {
      expect(shellPlace({ ...base, pathname, routeCoreId: "c1" })).toEqual({
        label: "workstation-berlin",
        coreId: "c1",
        online: true,
      });
    }
    expect(shellPlace({ ...base, pathname: "/cores/c1", routeCoreId: "c1", cores: [core("unreachable")] }).online).toBe(false);
  });
  it("says Tasks on /tasks", () => {
    expect(shellPlace({ ...base, pathname: "/tasks" })).toEqual({ label: "Tasks" });
  });
  it("lets Settings win over the route, then Usage", () => {
    expect(shellPlace({ ...base, pathname: "/cores/c1", routeCoreId: "c1", settingsOpen: true, usageOpen: true })).toEqual({ label: "Settings" });
    expect(shellPlace({ ...base, usageOpen: true })).toEqual({ label: "Usage" });
  });
});
