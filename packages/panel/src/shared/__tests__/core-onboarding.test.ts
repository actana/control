import { describe, expect, it } from "vitest";
import {
  CORE_INSTALL_PATHS,
  PAIR_NEW_OUTPUT,
  composePairNewCommand,
  pairNewCommand,
} from "../core-onboarding";

/**
 * The Core-side commands the first-run wizard teaches (#358).
 *
 * These are pasted into a terminal on a machine this Panel cannot see, so the
 * only thing standing between a wrong string here and an operator debugging
 * their own install is this file.
 */

describe("the mint command", () => {
  it("names `--label` even when no name has been chosen", () => {
    // Dropping the flag would be the easy thing to do and would teach an
    // operator to skip the one field that makes `actana pair ls` readable.
    expect(pairNewCommand("")).toBe("actana pair new --label <name>");
    expect(pairNewCommand("   ")).toBe("actana pair new --label <name>");
  });

  it("folds the chosen name in, untouched when a shell would not mind", () => {
    expect(pairNewCommand("my-panel")).toBe("actana pair new --label my-panel");
    expect(pairNewCommand("  home_panel.2  ")).toBe("actana pair new --label home_panel.2");
  });

  it("quotes a name a shell would otherwise split or eat", () => {
    // Pasted unquoted, `pair new` would take "the" and refuse "office".
    expect(pairNewCommand("the office")).toBe("actana pair new --label 'the office'");
    expect(pairNewCommand("mehdi's mac")).toBe(`actana pair new --label 'mehdi'\\''s mac'`);
    expect(pairNewCommand("a;rm -rf b")).toBe("actana pair new --label 'a;rm -rf b'");
  });

  it("has a Compose form that runs the same command inside the Core container", () => {
    expect(composePairNewCommand("my-panel")).toBe(
      "docker compose -f deploy/docker-compose.yml exec core actana pair new --label my-panel",
    );
  });
});

describe("what the wizard puts on screen", () => {
  it("offers both documented install paths, each with something to paste", () => {
    expect(CORE_INSTALL_PATHS.map((path) => path.id)).toEqual(["installer", "compose"]);
    for (const path of CORE_INSTALL_PATHS) expect(path.commands.length).toBeGreaterThan(0);
  });

  it("keeps the installer's two commands, in the order that works", () => {
    const installer = CORE_INSTALL_PATHS.find((path) => path.id === "installer");
    expect(installer?.commands).toEqual([
      "curl -fsSL https://raw.githubusercontent.com/actana/control/main/install.sh | bash",
      "actana setup",
    ]);
  });

  it("explains every line `pair new` prints, and invents no credentials", () => {
    expect(PAIR_NEW_OUTPUT.map((line) => line.label)).toEqual([
      "Pairing code",
      "CA fingerprint",
      "Expires",
      "Session",
    ]);
    for (const line of PAIR_NEW_OUTPUT) expect(line.meaning.trim()).not.toBe("");
  });
});
