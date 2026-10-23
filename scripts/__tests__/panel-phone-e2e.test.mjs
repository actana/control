import { describe, expect, it } from "vitest";

import * as path from "node:path";

import {
  CHROME_ARGS,
  PHONE_USER_AGENT,
  PHONE_VIEWPORT,
  LegError,
  formatLegFailure,
  hasHorizontalOverflow,
  legFileName,
  looksLikeApiKey,
  parsePhoneArgs,
  runLeg,
  shellEchoCommand,
} from "../lib/panel-phone-e2e.mjs";

describe("PHONE_VIEWPORT", () => {
  it("is the 390 x 844 phone of the card, with touch", () => {
    expect(PHONE_VIEWPORT).toMatchObject({ width: 390, height: 844, isMobile: true, hasTouch: true });
  });

  it("sits under the Panel's phone breakpoint (max-width 767px)", () => {
    expect(PHONE_VIEWPORT.width).toBeLessThanOrEqual(767);
  });
});

describe("PHONE_USER_AGENT", () => {
  it("names a phone", () => {
    expect(PHONE_USER_AGENT).toMatch(/iPhone/);
    expect(PHONE_USER_AGENT).toMatch(/Mobile/);
  });
});

describe("hasHorizontalOverflow", () => {
  it("is false when the page is exactly as wide as the window", () => {
    expect(hasHorizontalOverflow({ scrollWidth: 390, innerWidth: 390 })).toBe(false);
  });

  it("is false when the page is narrower than the window", () => {
    expect(hasHorizontalOverflow({ scrollWidth: 320, innerWidth: 390 })).toBe(false);
  });

  it("is true as soon as the page is one pixel wider than the window", () => {
    expect(hasHorizontalOverflow({ scrollWidth: 391, innerWidth: 390 })).toBe(true);
  });

  it("is true for a measurement that is not a number, rather than passing silently", () => {
    expect(hasHorizontalOverflow({ scrollWidth: undefined, innerWidth: 390 })).toBe(true);
  });
});

describe("CHROME_ARGS", () => {
  it("runs without Chrome's sandbox (ubuntu-24.04 runners restrict user namespaces)", () => {
    expect(CHROME_ARGS).toContain("--no-sandbox");
  });

  it("turns WebGL off so xterm draws DOM rows the test can read", () => {
    expect(CHROME_ARGS).toContain("--disable-gpu");
    expect(CHROME_ARGS).toContain("--disable-3d-apis");
  });
});

describe("parsePhoneArgs", () => {
  const root = path.resolve("/repo");

  it("defaults to the built Panel and Core, and no screenshot directory", () => {
    expect(parsePhoneArgs([], root)).toEqual({
      panelEntry: path.join(root, "packages", "panel", "dist", "server", "server.js"),
      coreEntry: path.join(root, "packages", "core", "dist", "core-entry.cjs"),
      screenshotsDir: null,
    });
  });

  it("takes --panel-entry, --core-entry and --screenshots, resolved to absolute paths", () => {
    const parsed = parsePhoneArgs(
      ["--panel-entry", "p/server.js", "--core-entry", "/abs/core.cjs", "--screenshots", "shots"],
      root,
    );
    expect(parsed.panelEntry).toBe(path.resolve("p/server.js"));
    expect(parsed.coreEntry).toBe("/abs/core.cjs");
    expect(parsed.screenshotsDir).toBe(path.resolve("shots"));
  });

  it("refuses a positional argument", () => {
    expect(() => parsePhoneArgs(["stray"], root)).toThrow(/unexpected argument: stray/);
  });

  it("refuses a flag that was given no value", () => {
    expect(() => parsePhoneArgs(["--screenshots"], root)).toThrow(/--screenshots needs a value/);
    expect(() => parsePhoneArgs(["--panel-entry", "--core-entry", "x"], root)).toThrow(
      /--panel-entry needs a value/,
    );
  });

  it("refuses a flag it does not know, so a typo does not silently drop screenshots", () => {
    expect(() => parsePhoneArgs(["--screenshot", "dir"], root)).toThrow(/unknown flag: --screenshot/);
  });
});

describe("runLeg", () => {
  it("logs the leg by number and name and resolves with what the leg returned", async () => {
    const lines = [];
    const value = await runLeg({ index: 2, name: "open a Core", timeoutMs: 1_000, log: (l) => lines.push(l), run: async () => 42 });
    expect(value).toBe(42);
    expect(lines).toEqual(["leg 2: open a Core"]);
  });

  it("turns a throw into a LegError that names the leg and keeps the message", async () => {
    const failure = await runLeg({
      index: 3,
      name: "open a Session terminal",
      timeoutMs: 1_000,
      log: () => {},
      run: async () => {
        throw new Error("timed out after 5ms waiting for the shell prompt");
      },
    }).catch((err) => err);
    expect(failure).toBeInstanceOf(LegError);
    expect(failure.leg).toBe("open a Session terminal");
    expect(failure.index).toBe(3);
    expect(failure.message).toContain("timed out after 5ms waiting for the shell prompt");
  });

  it("gives up on a leg that never finishes, saying which leg and for how long", async () => {
    const failure = await runLeg({
      index: 4,
      name: "create a Task",
      timeoutMs: 20,
      log: () => {},
      run: () => new Promise(() => {}),
    }).catch((err) => err);
    expect(failure).toBeInstanceOf(LegError);
    expect(failure.message).toMatch(/create a Task.*exceeded 20ms/);
  });
});

describe("formatLegFailure", () => {
  it("says which leg failed and why", () => {
    const err = new LegError({ index: 6, name: "create an API key", cause: new Error("no sheet") });
    expect(formatLegFailure(err)).toBe('leg 6 "create an API key" failed: no sheet');
  });

  it("still formats an error that is not a LegError", () => {
    expect(formatLegFailure(new Error("boom"))).toBe("boom");
  });
});

describe("legFileName", () => {
  it("numbers the leg and slugs its name", () => {
    expect(legFileName(3, "open a Session terminal")).toBe("03-open-a-session-terminal.png");
  });

  it("marks a failure screenshot", () => {
    expect(legFileName(10, "Settings & API key!", { failed: true })).toBe("10-settings-api-key-FAILED.png");
  });
});

describe("shellEchoCommand", () => {
  it("never types the marker in one piece, so the shell's echo of the line cannot satisfy the wait", () => {
    const { marker, typed } = shellEchoCommand("a1b2c3d4");
    expect(marker).toBe("PHONE-a1b2c3d4");
    expect(typed.includes(marker)).toBe(false);
  });

  it("makes the shell print the marker whole", () => {
    const { marker, typed } = shellEchoCommand("a1b2c3d4");
    // What `echo` prints once the shell has joined the quoted halves.
    expect(typed.replace(/^echo /, "").replaceAll('"', "")).toBe(marker);
  });
});

describe("looksLikeApiKey", () => {
  it("accepts the shape the Panel mints", () => {
    expect(looksLikeApiKey("ak_1_Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA")).toBe(true);
  });

  it.each(["", "ak_1_short", "sk_1_Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA", "ak_1_has space in it 1234567890"])(
    "rejects %j",
    (value) => {
      expect(looksLikeApiKey(value)).toBe(false);
    },
  );
});
