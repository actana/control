// The pure half of issue 394: what a persisted terminal identity is allowed to
// restore. The rule these cases pin down is that identity is the only thing
// that may decide which shell a row is — a row with no identity, or with one
// that does not parse, restores as nothing rather than as a default.
import { describe, expect, it } from "vitest";
import {
  forgetIdentities,
  parseIdentityMap,
  pruneIdentities,
  restoreUserTerminals,
  type UserTerminalIdentityMap,
} from "../user-terminal-identity";

const VM_SHELL = {
  scopeKey: "p1:main",
  coreId: "core_a",
  kind: "vm-shell" as const,
  cwd: "",
};

describe("parseIdentityMap", () => {
  it("keeps well-formed entries", () => {
    expect(parseIdentityMap({ t1: VM_SHELL })).toEqual({ t1: VM_SHELL });
  });

  it("drops entries that could only be restored by guessing", () => {
    const parsed = parseIdentityMap({
      good: VM_SHELL,
      noScope: { ...VM_SHELL, scopeKey: "" },
      badKind: { ...VM_SHELL, kind: "login-shell" },
      noCwd: { scopeKey: "p1:main", coreId: "core_a", kind: "vm-shell" },
      notAnObject: "vm-shell",
    });
    expect(Object.keys(parsed)).toEqual(["good"]);
  });

  it("survives a bucket that is not an object at all", () => {
    expect(parseIdentityMap("nonsense")).toEqual({});
    expect(parseIdentityMap(null)).toEqual({});
  });
});

describe("restoreUserTerminals", () => {
  const identities: UserTerminalIdentityMap = {
    t1: VM_SHELL,
    t2: { ...VM_SHELL, scopeKey: "__home__:local" },
  };

  it("returns every row to the bucket its identity names", () => {
    const restored = restoreUserTerminals(
      [{ id: "t1" }, { id: "t2" }],
      identities,
    );
    expect(Object.keys(restored).sort()).toEqual(["__home__:local", "p1:main"]);
    expect(restored["p1:main"]!.map((e) => e.terminal.id)).toEqual(["t1"]);
    expect(restored["p1:main"]![0]!.identity.kind).toBe("vm-shell");
  });

  it("restores nothing for a row with no identity — never a default bucket", () => {
    const restored = restoreUserTerminals([{ id: "orphan" }], identities);
    expect(restored).toEqual({});
  });
});

describe("identity bookkeeping", () => {
  it("forgets killed terminals and returns the same map when there is nothing to forget", () => {
    const map: UserTerminalIdentityMap = { t1: VM_SHELL, t2: VM_SHELL };
    expect(Object.keys(forgetIdentities(map, ["t1"]))).toEqual(["t2"]);
    expect(forgetIdentities(map, ["nope"])).toBe(map);
  });

  it("prunes identities whose row the server no longer has", () => {
    const map: UserTerminalIdentityMap = { t1: VM_SHELL, gone: VM_SHELL };
    expect(Object.keys(pruneIdentities(map, new Set(["t1"])))).toEqual(["t1"]);
  });
});
