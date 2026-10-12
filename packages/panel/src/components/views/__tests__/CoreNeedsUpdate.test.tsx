// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CoreNeedsUpdateNotice } from "../CoreNeedsUpdate";
import { DOCKER_COMPOSE_UPDATE, coreUpdateCommand } from "@actana/shared/actana-container-contract";
import { CURRENT_MC_VERSION } from "~/queries/mission-control-version";
import { coreImageTag } from "~/shared/core-onboarding";
import {
  CORE_IMAGE_UPDATE_COMMAND,
  CORE_UPDATE_COMMAND,
  type CoreDialStatus,
} from "~/shared/cores";

// What the operator is owed when a Core drifts: the fact, the two versions, and
// the command that fixes it — copyable, because it is going to be pasted into
// a terminal on another machine. The Panel cannot see whether that Core was
// installed with the installer or runs from the image (and `actana update`
// refuses in the image), so both commands are offered and the notice says so.
//
// Every assertion below reads `CORE_UPDATE_COMMAND` /
// `CORE_IMAGE_UPDATE_COMMAND` rather than a literal, so none of them can tell
// whether a constant still names a command that works.
// `the command it offers actually updates a running Core` is the one that can,
// and it is here because #316 broke the old value: `install.sh` installs and no
// longer activates, so the installer one-liner now lands a tree and leaves the
// daemon on the version it started with — a notice that would never clear.

function needsUpdate(overrides: Partial<CoreDialStatus> = {}): CoreDialStatus {
  return {
    coreId: "core_a",
    state: "needs-update",
    lastSeenAt: 1,
    coreVersion: "0.1.0",
    panelVersion: "0.8.0",
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => cleanup());

describe("CoreNeedsUpdateNotice", () => {
  it("names the state and both protocol versions", () => {
    render(<CoreNeedsUpdateNotice dial={needsUpdate()} />);
    expect(screen.getByText(/needs update/i)).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).toContain("0.1.0");
    expect(text).toContain("0.8.0");
  });

  it("shows both update commands verbatim", () => {
    render(<CoreNeedsUpdateNotice dial={needsUpdate()} />);
    expect(screen.getByText(CORE_UPDATE_COMMAND)).toBeTruthy();
    expect(screen.getByText(CORE_IMAGE_UPDATE_COMMAND)).toBeTruthy();
  });

  it("copies the container command to the clipboard", () => {
    render(<CoreNeedsUpdateNotice dial={needsUpdate()} />);
    fireEvent.click(screen.getByRole("button", { name: /container update command/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(CORE_IMAGE_UPDATE_COMMAND);
  });

  it("copies the installer command to the clipboard", () => {
    render(<CoreNeedsUpdateNotice dial={needsUpdate()} />);
    fireEvent.click(screen.getByRole("button", { name: /installer update command/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(CORE_UPDATE_COMMAND);
  });

  it("says it cannot tell how the Core was installed", () => {
    render(<CoreNeedsUpdateNotice dial={needsUpdate()} />);
    expect(document.body.textContent).toMatch(/cannot see how that Core was installed/i);
  });

  it("tells the operator to run the image update on the host, not in the container", () => {
    render(<CoreNeedsUpdateNotice dial={needsUpdate()} />);
    expect(document.body.textContent).toMatch(/on the host/i);
    expect(document.body.textContent).not.toMatch(/docker exec/i);
  });

  it("gives the compose row a concrete tag and directory, since no compose Core saved one", () => {
    render(<CoreNeedsUpdateNotice dial={needsUpdate()} />);
    expect(document.body.textContent).toContain(coreImageTag(CURRENT_MC_VERSION));
    const row = screen.getByText(CORE_IMAGE_UPDATE_COMMAND).closest("div")?.parentElement;
    expect(row?.textContent).toMatch(/deploy\//);
    expect(row?.textContent).toContain(`ACTANA_TAG=${coreImageTag(CURRENT_MC_VERSION)}`);
  });

  it("renders no literal backticks: `Ticked` turns them into code", () => {
    render(<CoreNeedsUpdateNotice dial={needsUpdate()} />);
    expect(document.body.textContent).not.toContain("`");
    const codes = [...document.querySelectorAll("code")].map((c) => c.textContent);
    expect(codes).toContain(`ACTANA_TAG=${coreImageTag(CURRENT_MC_VERSION)}`);
    expect(codes).toContain("deploy/");
  });

  it("names the Panel as the stale side when the Core is ahead, with no Core command", () => {
    render(
      <CoreNeedsUpdateNotice dial={needsUpdate({ coreVersion: "0.9.0", panelVersion: "0.8.0" })} />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/ahead of this Panel/i);
    expect(screen.queryByText(CORE_UPDATE_COMMAND)).toBeNull();
    expect(screen.queryByText(CORE_IMAGE_UPDATE_COMMAND)).toBeNull();
  });

  // Bound to the value, not to the rendering: the rest of this file would pass
  // just as happily with a command that does nothing.
  it("the command it offers actually updates a running Core", () => {
    // `actana update` is the only one of the three candidates that lands the
    // new tree *and* restarts the daemon onto it (see the constant's
    // docstring). The installer one-liner stopped doing the second half in
    // #316, and `install.sh … && actana setup` is the gesture for activating a
    // machine, not for upgrading one that is already a Core.
    expect(CORE_UPDATE_COMMAND).toBe("actana update");
    expect(CORE_UPDATE_COMMAND).not.toMatch(/install\.sh/);
    expect(CORE_UPDATE_COMMAND).not.toMatch(/\bcurl\b/);
    expect(CORE_UPDATE_COMMAND).not.toMatch(/\bsetup\b/);
    expect(CORE_UPDATE_COMMAND).toBe(coreUpdateCommand(false));
  });

  // The CLI's refusal prints the bare `up -d`, which would also start a second
  // Panel on a stack the wizard brought up with `up -d core`. Ours is scoped.
  it("the image command is the refusal's compose command scoped to the core service", () => {
    expect(CORE_IMAGE_UPDATE_COMMAND.startsWith("docker compose pull")).toBe(true);
    expect(CORE_IMAGE_UPDATE_COMMAND).toMatch(/pull core && docker compose up -d core$/);
    expect(CORE_IMAGE_UPDATE_COMMAND).not.toBe(DOCKER_COMPOSE_UPDATE);
  });

  it("stays useful when the Core advertised no version at all", () => {
    render(<CoreNeedsUpdateNotice dial={needsUpdate({ coreVersion: null })} />);
    expect(screen.getByText(CORE_UPDATE_COMMAND)).toBeTruthy();
    expect(screen.getByText(CORE_IMAGE_UPDATE_COMMAND)).toBeTruthy();
    expect(document.body.textContent).toContain("unknown");
  });
});
