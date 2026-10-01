import { describe, expect, it } from "vitest";
import { terminalScopeKeysForCore } from "../user-terminal-store";

describe("terminalScopeKeysForCore", () => {
  it("includes the scope bucket of a Core and no other Core's", () => {
    expect(
      terminalScopeKeysForCore(
        {
          "core-1:main": [],
          "core-2:main": [],
          "core-10:main": [],
        },
        "core-1",
      ),
    ).toEqual(["core-1:main"]);
  });

  it("covers a bucket keyed by the bare Core id as well", () => {
    expect(
      terminalScopeKeysForCore(
        {
          "core-1": [],
          "core-1:main": [],
        },
        "core-1",
      ),
    ).toEqual(["core-1", "core-1:main"]);
  });
});
