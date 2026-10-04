import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HARNESS_CLI_CONFIG } from "../harness-cli-version-requirements";
import { clearHarnessCliVersionCache } from "../harness-cli-version";
import {
  pickHarnessCandidateMeetingVersion,
  resolveHarnessCommandMeetingVersion,
  resolveHarnessCommandOnPath,
  resolveAllHarnessCommandsOnPath,
} from "../harness-cli-resolution";

function touch(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "", "utf8");
}

function writeExecutable(file: string, contents = "#!/bin/sh\n") {
  touch(file);
  fs.writeFileSync(file, contents, "utf8");
  fs.chmodSync(file, 0o755);
}

describe("resolveHarnessCommandOnPath", () => {
  it("resolves Cursor CLI via the official agent binary name", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-cursor-alias-"));
    const binDir = path.join(root, "User", ".local", "bin");
    touch(path.join(binDir, "agent.exe"));

    const env = {
      Path: binDir,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    };

    expect(resolveHarnessCommandOnPath("cursor-agent", env, "win32")).toBe(
      path.join(binDir, "agent.exe"),
    );
    expect(resolveHarnessCommandOnPath("cursor-agent", env, "win32")).toBe(
      resolveHarnessCommandOnPath("agent", env, "win32"),
    );
  });

  it("prefers Windows command shims over extensionless npm shell shims", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-npm-shim-"));
    const binDir = path.join(root, "npm");
    touch(path.join(binDir, "codex"));
    touch(path.join(binDir, "codex.cmd"));

    const env = {
      Path: binDir,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    };

    expect(resolveHarnessCommandOnPath("codex", env, "win32")).toBe(
      path.join(binDir, "codex.cmd"),
    );
  });

  it("prefers cursor-agent when both shims exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-cursor-both-"));
    const binDir = path.join(root, "bin");
    writeExecutable(path.join(binDir, "cursor-agent"));
    writeExecutable(path.join(binDir, "agent"));

    const env = { PATH: binDir };

    expect(resolveHarnessCommandOnPath("cursor-agent", env, "darwin")).toBe(
      path.join(binDir, "cursor-agent"),
    );
  });
});

describe("resolveHarnessCommandMeetingVersion", () => {
  it("skips an outdated early PATH match in favor of a newer later install", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-codex-multi-"));
    const staleDir = path.join(root, "homebrew", "bin");
    const freshDir = path.join(root, "herd", "bin");
    const stale = path.join(staleDir, "codex");
    const fresh = path.join(freshDir, "codex");

    writeExecutable(stale, "#!/bin/sh\necho 'codex-cli 0.131.0'\n");
    writeExecutable(fresh, "#!/bin/sh\necho 'codex-cli 0.144.1'\n");

    const env = { PATH: `${staleDir}${path.delimiter}${freshDir}` };
    clearHarnessCliVersionCache();

    expect(resolveAllHarnessCommandsOnPath("codex", env, "darwin")).toEqual([stale, fresh]);
    expect(resolveHarnessCommandOnPath("codex", env, "darwin")).toBe(stale);

    const meeting = resolveHarnessCommandMeetingVersion(
      "codex",
      HARNESS_CLI_CONFIG.codex,
      env,
      "darwin",
      { fresh: true },
    );
    expect(meeting?.binary).toBe(fresh);
    expect(meeting?.check.ok).toBe(true);
    if (meeting?.check.ok) expect(meeting.check.version).toBe("0.144.1");
  });

  it("returns the first binary when every PATH match is outdated", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-codex-all-stale-"));
    const firstDir = path.join(root, "a");
    const secondDir = path.join(root, "b");
    const first = path.join(firstDir, "codex");
    const second = path.join(secondDir, "codex");

    writeExecutable(first, "#!/bin/sh\necho 'codex-cli 0.131.0'\n");
    writeExecutable(second, "#!/bin/sh\necho 'codex-cli 0.120.0'\n");

    const env = { PATH: `${firstDir}${path.delimiter}${secondDir}` };
    clearHarnessCliVersionCache();

    const meeting = resolveHarnessCommandMeetingVersion(
      "codex",
      HARNESS_CLI_CONFIG.codex,
      env,
      "darwin",
      { fresh: true },
    );
    expect(meeting?.binary).toBe(first);
    expect(meeting?.check.ok).toBe(false);
    if (meeting && !meeting.check.ok) {
      expect(meeting.check.reason).toBe("outdated");
      expect(meeting.check.version).toBe("0.131.0");
    }
  });
});

describe("pickHarnessCandidateMeetingVersion", () => {
  // The container's daemon cannot list `core`'s PATH, so core lists it and the
  // daemon picks among the answers. The pick must be the one the local lookup makes.
  it("picks the newer later candidate over an outdated early one, as the local lookup does", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-pick-multi-"));
    const stale = path.join(root, "a", "codex");
    const fresh = path.join(root, "b", "codex");
    writeExecutable(stale, "#!/bin/sh\necho 'codex-cli 0.131.0'\n");
    writeExecutable(fresh, "#!/bin/sh\necho 'codex-cli 0.144.1'\n");
    clearHarnessCliVersionCache();
    const picked = pickHarnessCandidateMeetingVersion([stale, fresh], HARNESS_CLI_CONFIG.codex, {}, "darwin", { fresh: true });
    expect(picked?.binary).toBe(fresh);
    const env = { PATH: `${path.dirname(stale)}${path.delimiter}${path.dirname(fresh)}` };
    expect(resolveHarnessCommandMeetingVersion("codex", HARNESS_CLI_CONFIG.codex, env, "darwin", { fresh: true })?.binary).toBe(fresh);
  });

  it("returns the first candidate when all are outdated, and null when there are none", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-pick-stale-"));
    const first = path.join(root, "a", "codex");
    const second = path.join(root, "b", "codex");
    writeExecutable(first, "#!/bin/sh\necho 'codex-cli 0.131.0'\n");
    writeExecutable(second, "#!/bin/sh\necho 'codex-cli 0.120.0'\n");
    clearHarnessCliVersionCache();
    const picked = pickHarnessCandidateMeetingVersion([first, second], HARNESS_CLI_CONFIG.codex, {}, "darwin", { fresh: true });
    expect(picked?.binary).toBe(first);
    expect(picked?.check.ok).toBe(false);
    expect(pickHarnessCandidateMeetingVersion([], HARNESS_CLI_CONFIG.codex, {}, "darwin")).toBeNull();
  });
});
