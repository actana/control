import { describe, expect, it, vi } from "vitest";

import { parseArgs, stringFlag } from "../lib/cli.mjs";

describe("parseArgs", () => {
  it("reads --key value pairs", () => {
    expect(parseArgs(["--out-dir", "artifacts", "--version", "0.49.0"])).toEqual({
      _: [],
      "out-dir": "artifacts",
      version: "0.49.0",
    });
  });

  it("treats a flag with no value as true", () => {
    expect(parseArgs(["--yes"])).toEqual({ _: [], yes: true });
  });

  it("does not swallow the next flag as a value", () => {
    // `--out-dir --version 1.2.3` must not silently lose the directory.
    expect(parseArgs(["--out-dir", "--version", "1.2.3"])).toEqual({
      _: [],
      "out-dir": true,
      version: "1.2.3",
    });
  });

  it("collects positionals so scripts can reject them", () => {
    expect(parseArgs(["stray", "--dir", "x"])._).toEqual(["stray"]);
  });
});

describe("stringFlag", () => {
  it("returns the value", () => {
    const fail = vi.fn();
    expect(stringFlag({ dir: "artifacts" }, "dir", fail)).toBe("artifacts");
    expect(fail).not.toHaveBeenCalled();
  });

  it("returns the fallback when the flag is absent", () => {
    expect(stringFlag({}, "dir", vi.fn(), "default")).toBe("default");
  });

  it("fails when the flag was passed bare", () => {
    const fail = vi.fn();
    stringFlag({ dir: true }, "dir", fail);
    expect(fail).toHaveBeenCalledWith("--dir needs a value");
  });
});
