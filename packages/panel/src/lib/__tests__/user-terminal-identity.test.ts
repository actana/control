// @vitest-environment jsdom
// The pure half of issue 394: what a persisted terminal identity is allowed to
// restore. The rule these cases pin down is that identity is the only thing
// that may decide which shell a row is — a row with no identity, or with one
// that does not parse, restores as nothing rather than as a default.
import { beforeEach, describe, expect, it } from "vitest";
import {
  commitIdentityChange,
  forgetIdentities,
  parseIdentityMap,
  pruneIdentities,
  readIdentityMap,
  restoreUserTerminals,
  writeIdentityMap,
  type UserTerminalIdentityMap,
} from "../user-terminal-identity";

const VM_SHELL = { coreId: "core_a" };

describe("parseIdentityMap", () => {
  it("keeps well-formed entries", () => {
    expect(parseIdentityMap({ t1: VM_SHELL })).toEqual({ t1: VM_SHELL });
  });

  it("drops entries that could only be restored by guessing", () => {
    const parsed = parseIdentityMap({
      good: VM_SHELL,
      noCore: { ...VM_SHELL, coreId: "" },
      badKind: { ...VM_SHELL, kind: "login-shell" },
      projectShell: { ...VM_SHELL, kind: "project", cwd: "/home/core/web" },
      notAnObject: "vm-shell",
    });
    expect(Object.keys(parsed)).toEqual(["good"]);
  });

  it("reads an entry written while shells had a scope, a kind and a cwd", () => {
    expect(
      parseIdentityMap({
        t1: { scopeKey: "p1:main", coreId: "core_a", kind: "vm-shell", cwd: "" },
      }),
    ).toEqual({ t1: { coreId: "core_a" } });
  });

  it("survives a bucket that is not an object at all", () => {
    expect(parseIdentityMap("nonsense")).toEqual({});
    expect(parseIdentityMap(null)).toEqual({});
  });
});

describe("restoreUserTerminals", () => {
  const scopeKeyFor = (coreId: string) => `${coreId}:main`;
  const identities: UserTerminalIdentityMap = {
    t1: VM_SHELL,
    t2: { coreId: "core_b" },
  };

  it("returns every row to the bucket of the Core its identity names", () => {
    const restored = restoreUserTerminals([{ id: "t1" }, { id: "t2" }], identities, scopeKeyFor);
    expect(Object.keys(restored).sort()).toEqual(["core_a:main", "core_b:main"]);
    expect(restored["core_a:main"]!.map((e) => e.terminal.id)).toEqual(["t1"]);
    expect(restored["core_a:main"]![0]!.identity.coreId).toBe("core_a");
  });

  it("restores nothing for a row with no identity — never a default bucket", () => {
    const restored = restoreUserTerminals([{ id: "orphan" }], identities, scopeKeyFor);
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
    const candidates = new Set(["t1", "gone"]);
    expect(Object.keys(pruneIdentities(map, new Set(["t1"]), candidates))).toEqual(["t1"]);
  });

  it("never prunes an identity the list call could not have known about", () => {
    // Opened while the list was in flight: absent from the answer because it
    // did not exist when the request went out, not because its row is gone.
    const map: UserTerminalIdentityMap = { t1: VM_SHELL, opened: VM_SHELL };
    const pruned = pruneIdentities(map, new Set(["t1"]), new Set(["t1"]));
    expect(Object.keys(pruned).sort()).toEqual(["opened", "t1"]);
  });
});

// `commitIdentityChange` touches localStorage, so these run in jsdom. Losing an
// identity is not like losing a hidden flag: the terminal it names can never be
// restored again and its row is never cleaned up either, so a second tab's
// snapshot must not be able to overwrite this one's.
describe("commitIdentityChange (jsdom)", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps an identity another tab wrote after this tab's snapshot", () => {
    const before: UserTerminalIdentityMap = {};
    writeIdentityMap({ fromOtherTab: VM_SHELL });
    commitIdentityChange(before, { mine: VM_SHELL });
    expect(Object.keys(readIdentityMap()).sort()).toEqual(["fromOtherTab", "mine"]);
  });

  it("removes exactly what this tab removed, and nothing else", () => {
    writeIdentityMap({ mine: VM_SHELL, fromOtherTab: VM_SHELL });
    commitIdentityChange({ mine: VM_SHELL }, {});
    expect(Object.keys(readIdentityMap())).toEqual(["fromOtherTab"]);
  });
});
