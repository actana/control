import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADD_CORE_FIELD_LABEL,
  ADD_CORE_LOCATION,
  COMPOSE_SHORTCUT_ACTION,
  COMPOSE_SHORTCUT_NOTICE,
  FIRST_RUN_STEP_IDS,
  FIRST_RUN_STEP_PARAM,
  PAIR_NEW_OUTPUT,
  REDEEM_STEP_LINK,
  composePairNewCommand,
  composeUpCoreCommand,
  coreImageTag,
  coreInstallPaths,
  firstRunStepFromSearch,
  labelRefusal,
  pairNewCommand,
} from "../core-onboarding";

/**
 * The Core-side commands the first-run wizard teaches (#358).
 *
 * These are pasted into a terminal on a machine this Panel cannot see, so the
 * only thing standing between a wrong string here and an operator debugging
 * their own install is this file.
 *
 * **The `pair new` block is checked against the CLI, not against itself.** The
 * first version of this suite asserted `PAIR_NEW_OUTPUT`'s labels against a
 * literal copy of `PAIR_NEW_OUTPUT`'s own contents — a tautology that pinned
 * the module to itself, said nothing about what `actana pair new` prints, and
 * is exactly why a missing `Label` line survived review. So the expectations
 * below are *read out of `packages/cli`*: the label set from the contract the
 * CLI's own suite pins for this invocation, and the order from the printer.
 * Neither can be satisfied by editing this package. #357 is about to reframe
 * that output; when it does, this suite is what goes red.
 */

const VERSION = "0.4.3";

/** `packages/cli/src/__tests__/actana-pair.test.ts`, read as text. */
const CLI_TEST = readCli("__tests__/actana-pair.test.ts");
/** `packages/cli/src/actana-pair.ts`, read as text. */
const CLI_PRINTER = readCli("actana-pair.ts");

function readCli(relative: string): string {
  const path = fileURLToPath(new URL(`../../../../cli/src/${relative}`, import.meta.url));
  const source = readFileSync(path, "utf8");
  // A file that moved must fail loudly here rather than quietly stop covering
  // anything — a check that silently no longer checks is worse than none.
  if (source.trim() === "") throw new Error(`${relative} is empty`);
  return source;
}

/**
 * The stdout contract the CLI's suite pins for `pair new --label <name>` — the
 * exact invocation this wizard teaches.
 *
 * Lifted from its assertion that every stdout line matches
 * `/^(Pairing code|CA fingerprint|Expires|Label|Session) /`.
 */
function cliPinnedLabels(): string[] {
  const match = /\/\^\(([^)]+)\)\s\//.exec(CLI_TEST);
  if (!match) {
    throw new Error(
      "could not find the pinned stdout contract in actana-pair.test.ts — if that assertion moved or changed shape, this test has to follow it",
    );
  }
  return match[1].split("|");
}

/**
 * The placeholder the CLI puts in the name slot, read out of its own export.
 *
 * Read rather than repeated, for the same reason the label set above is: the
 * two surfaces print the same command, and `<name>` — which both of them once
 * used — is a shell redirection, not a slot. Pinning the Panel's placeholder
 * to `NAME_PLACEHOLDER` is what keeps them from drifting apart again.
 */
function cliNamePlaceholder(): string {
  const match = /export const NAME_PLACEHOLDER = "([^"]+)";/.exec(CLI_PRINTER);
  if (!match) {
    throw new Error(
      "could not find `NAME_PLACEHOLDER` in actana-pair.ts — if it moved or changed shape, this test has to follow it",
    );
  }
  return match[1];
}

/** The mint command as the wizard prints it with no usable name typed. */
const PLACEHOLDER_COMMAND = `actana pair new --label ${cliNamePlaceholder()}`;

/**
 * The order `actana-pair.ts` writes those lines in, read off the `deps.out`
 * calls themselves. `Address host` is dropped: it is printed only for
 * `--public-host`, which this wizard does not teach.
 */
function printerOrder(pinned: string[]): string[] {
  const emitted = [...CLI_PRINTER.matchAll(/deps\.out\(`([A-Za-z][A-Za-z ]*?) +\$\{/g)].map(
    (m) => m[1],
  );
  if (emitted.length === 0) throw new Error("found no `deps.out` label lines in actana-pair.ts");
  return emitted.filter((label) => pinned.includes(label));
}

describe("the `pair new` output block, against the CLI itself", () => {
  it("explains every line that invocation prints, and invents none", () => {
    expect(new Set(PAIR_NEW_OUTPUT.map((line) => line.label))).toEqual(new Set(cliPinnedLabels()));
  });

  it("lists them in the order the terminal shows them", () => {
    // The wizard is a recognition aid; a set in the wrong order is a worse one.
    expect(PAIR_NEW_OUTPUT.map((line) => line.label)).toEqual(printerOrder(cliPinnedLabels()));
  });

  it("includes `Label`, because the command it teaches always carries `--label`", () => {
    // Named on its own: it is the line the first version of this block missed,
    // and the one an operator sees only when they follow the wizard's command.
    expect(cliPinnedLabels()).toContain("Label");
    expect(PAIR_NEW_OUTPUT.map((line) => line.label)).toContain("Label");
  });

  it("samples the shapes an operator has to recognise", () => {
    const sample = (label: string) =>
      PAIR_NEW_OUTPUT.find((line) => line.label === label)?.sample ?? "";
    // `absoluteTime` emits ISO-8601 in UTC, with the milliseconds stripped.
    expect(sample("Expires")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \(.+\)$/);
    // `randomUUID()` — 36 characters, no prefix. A short stand-in invites
    // truncating the real one into the redeem step's Session box.
    expect(sample("Session")).toHaveLength(36);
    expect(sample("Session")).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  });

  it("says something about every line", () => {
    for (const line of PAIR_NEW_OUTPUT) expect(line.meaning.trim()).not.toBe("");
  });
});

describe("the mint command", () => {
  it("names `--label` even when no name has been chosen", () => {
    // Dropping the flag would be the easy thing to do and would teach an
    // operator to skip the one field that makes `actana pair ls` readable.
    expect(pairNewCommand("")).toBe(PLACEHOLDER_COMMAND);
    expect(pairNewCommand("   ")).toBe(PLACEHOLDER_COMMAND);
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

describe("a name the Core would refuse", () => {
  it("is refused here, with the reason", () => {
    expect(labelRefusal("-panel")).toMatch(/cannot start with/);
    expect(labelRefusal("  -panel")).toMatch(/cannot start with/);
  });

  it("never reaches the printed command", () => {
    // The CLI's option parser refuses any `--label` value starting with `-`,
    // in both flag forms, and quoting cannot help because the shell strips the
    // quotes first. Emitting it would hand the operator a command that fails on
    // paste — with the Panel to blame for printing it.
    expect(pairNewCommand("-panel")).toBe(PLACEHOLDER_COMMAND);
    expect(composePairNewCommand("-panel")).toContain(`--label ${cliNamePlaceholder()}`);
  });

  it("still refuses it in the CLI's own parser, which is why this exists", () => {
    // Read from the CLI rather than asserted from memory: if that guard is ever
    // relaxed, this stops being a rule the Panel has to enforce.
    expect(CLI_PRINTER).toContain('value.startsWith("-")');
  });

  it("lets every ordinary name through", () => {
    for (const name of ["my-panel", "panel-1", "the office", "a_b.c"]) {
      expect(labelRefusal(name)).toBeNull();
    }
  });
});

describe("what the wizard puts on screen", () => {
  it("offers both documented install paths, each with something to paste", () => {
    const paths = coreInstallPaths(VERSION);
    expect(paths.map((path) => path.id)).toEqual(["installer", "compose"]);
    for (const path of paths) expect(path.commands.length).toBeGreaterThan(0);
  });

  it("keeps the installer's two commands, in the order that works", () => {
    const installer = coreInstallPaths(VERSION).find((path) => path.id === "installer");
    expect(installer?.commands).toEqual([
      "curl -fsSL https://raw.githubusercontent.com/actana/control/main/install.sh | bash",
      "actana setup",
    ]);
  });

  it("brings up the Core service alone, never a second Panel", () => {
    // `docker compose … up -d` starts the whole file, `panel` included. That is
    // the README's command, for a reader who has no Panel; here the reader is
    // looking at one, and a bare `up -d` would clash with it on 7420 or shadow
    // it — with this screen having told them to do it.
    const compose = coreInstallPaths(VERSION).find((path) => path.id === "compose");
    const up = compose?.commands.find((command) => command.includes("up -d"));
    expect(up).toBe(composeUpCoreCommand(VERSION));
    expect(up?.endsWith("up -d core")).toBe(true);
    expect(compose?.commands.join("\n")).not.toMatch(/up -d(\s|$)(?!core)/);
  });

  it("pins an image tag rather than falling through to a `:latest` that 404s", () => {
    const up = composeUpCoreCommand(VERSION);
    expect(up.startsWith(`ACTANA_TAG=${coreImageTag(VERSION)} `)).toBe(true);
    expect(coreImageTag("0.4.3")).toBe("beta-0.4.3");
    // And the note has to explain the tag, or the operator cannot correct it
    // once a release exists.
    const compose = coreInstallPaths(VERSION).find((path) => path.id === "compose");
    expect(compose?.note).toContain("ACTANA_TAG");
    expect(compose?.note).toContain(VERSION);
  });

  it("tracks the Panel's own line rather than a hard-coded version", () => {
    expect(composeUpCoreCommand("9.9.9")).toContain("ACTANA_TAG=beta-9.9.9");
  });

  it("names the canonical Add-a-Core location once", () => {
    expect(ADD_CORE_LOCATION).toBe(`Settings → Cores → ${ADD_CORE_FIELD_LABEL}`);
  });
});

/**
 * The Compose shortcut.
 *
 * An operator who came from `deploy/docker-compose.yml` has a Core running
 * beside this Panel before they ever see the wizard, so its first two screens
 * are install advice for a machine they already provisioned. The parameter
 * lets a link skip them; the bar tells them the link exists.
 */
describe("opening the wizard on a given step", () => {
  it("takes the step's own id", () => {
    expect(firstRunStepFromSearch("?step=install")).toBe(0);
    expect(firstRunStepFromSearch("?step=mint")).toBe(1);
    expect(firstRunStepFromSearch("?step=redeem")).toBe(2);
  });

  it("takes the 1-based number the rail puts on screen", () => {
    // The rail is labelled "Step 1".."Step 3", and someone told to jump to the
    // third step will type 3 before they will type `redeem`.
    expect(firstRunStepFromSearch("?step=1")).toBe(0);
    expect(firstRunStepFromSearch("?step=3")).toBe(2);
  });

  it("is forgiving about case and whitespace, and works with other parameters", () => {
    expect(firstRunStepFromSearch("?step=REDEEM")).toBe(2);
    expect(firstRunStepFromSearch("?step=%20redeem%20")).toBe(2);
    expect(firstRunStepFromSearch("?foo=bar&step=redeem&baz=1")).toBe(2);
    expect(firstRunStepFromSearch("step=redeem")).toBe(2);
  });

  it("says nothing rather than throwing when it is absent or unrecognised", () => {
    // A stale bookmark opens the wizard at the beginning. It does not break it.
    for (const search of ["", "?", "?other=1", "?step=", "?step=0", "?step=4", "?step=redem"]) {
      expect(firstRunStepFromSearch(search)).toBeNull();
    }
  });

  it("covers every step the wizard has, and invents none", () => {
    expect(FIRST_RUN_STEP_IDS).toEqual(["install", "mint", "redeem"]);
    for (const [index, id] of FIRST_RUN_STEP_IDS.entries()) {
      expect(firstRunStepFromSearch(`?${FIRST_RUN_STEP_PARAM}=${id}`)).toBe(index);
    }
  });

  it("has a link that opens the last step, and it is relative", () => {
    // A Panel is reached at whatever address is in front of it; a link with an
    // origin baked in would be right for exactly one deployment.
    expect(firstRunStepFromSearch(REDEEM_STEP_LINK)).toBe(FIRST_RUN_STEP_IDS.length - 1);
    expect(REDEEM_STEP_LINK.startsWith("?")).toBe(true);
  });
});

describe("the Compose disclaimer", () => {
  /** `deploy/docker-compose.yml`, read as text. */
  const COMPOSE = readFileSync(
    fileURLToPath(new URL("../../../../../deploy/docker-compose.yml", import.meta.url)),
    "utf8",
  );

  it("is offered by the file it is about", () => {
    // The bar is only half the feature: the operator has to be told the link
    // exists somewhere they are already reading, and that is the Compose file
    // whose `up -d` put them in this position.
    expect(COMPOSE).toContain(REDEEM_STEP_LINK);
  });

  it("names the address that Compose actually serves the Core on", () => {
    // `core:8443` is the compose service name, and it is what the redeem step's
    // first field wants. A disclaimer that skipped two screens without saying
    // this would strand the operator on the third.
    expect(COMPOSE_SHORTCUT_NOTICE).toContain("core:8443");
    expect(COMPOSE).toContain("core:8443");
  });

  it("asks rather than asserts, because nothing here can detect Compose", () => {
    // The Panel has no marker for how it was started. The bar is therefore a
    // question the operator answers about themselves — if it ever starts
    // claiming, it is claiming something it cannot know.
    expect(COMPOSE_SHORTCUT_NOTICE).toContain("?");
  });

  it("is worded as a move between steps, not as a way out of them", () => {
    // The wizard is a gate, and `first-run-gate.test.tsx` scans every button on
    // every step for the words an escape hatch gets named. This control lands
    // on the step that pairs a Core — the gate's only exit — so it must not be
    // called "Skip", and neither this label nor the notice may carry the words
    // that guard is looking for.
    expect(COMPOSE_SHORTCUT_ACTION).toBe("Jump to step 3");
    for (const copy of [COMPOSE_SHORTCUT_ACTION, COMPOSE_SHORTCUT_NOTICE]) {
      expect(copy).not.toMatch(/skip|dismiss|later|not now|close|continue anyway|explore/i);
    }
  });
});
