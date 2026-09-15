import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  NPM_USER_BIN_SUFFIX,
  NPM_USER_PREFIX_SUFFIX,
  isDirectoryWritable,
  isNpmGlobalInstallCommand,
  withNpmUserPrefixIfNeeded,
} from "../npm-install-prefix";

const PI =
  "npm install -g --ignore-scripts @earendil-works/pi-coding-agent";
const CODEX = "npm install -g @openai/codex@latest";
const OPENCODE_WIN = "npm i -g opencode-ai@latest";
const CURLED = "curl -fsSL https://opencode.ai/install | bash";

describe("isNpmGlobalInstallCommand", () => {
  it("recognises npm install -g and npm i -g", () => {
    expect(isNpmGlobalInstallCommand(PI)).toBe(true);
    expect(isNpmGlobalInstallCommand(CODEX)).toBe(true);
    expect(isNpmGlobalInstallCommand(OPENCODE_WIN)).toBe(true);
  });

  it("rejects non-npm installers", () => {
    expect(isNpmGlobalInstallCommand(CURLED)).toBe(false);
    expect(isNpmGlobalInstallCommand("pi update --self")).toBe(false);
  });
});

describe("withNpmUserPrefixIfNeeded", () => {
  const prefixed = (command: string) =>
    command.replace(
      /^npm\s+(?:install|i)\s+-g\b/,
      (match) => `${match} --prefix "$HOME/${NPM_USER_PREFIX_SUFFIX}"`,
    );

  it("rewrites Pi and Codex when the global prefix is not writable (#521)", () => {
    expect(
      withNpmUserPrefixIfNeeded(PI, {
        platform: "linux",
        resolvePrefix: () => "/usr/local",
        isWritable: () => false,
      }),
    ).toBe(prefixed(PI));
    expect(
      withNpmUserPrefixIfNeeded(CODEX, {
        platform: "linux",
        resolvePrefix: () => "/usr/local",
        isWritable: () => false,
      }),
    ).toBe(prefixed(CODEX));
  });

  it("leaves the command alone when the prefix is writable", () => {
    expect(
      withNpmUserPrefixIfNeeded(PI, {
        platform: "linux",
        resolvePrefix: () => "/home/core/.local",
        isWritable: () => true,
      }),
    ).toBe(PI);
  });

  it("is a no-op on Windows and for non-npm installers", () => {
    expect(
      withNpmUserPrefixIfNeeded(OPENCODE_WIN, {
        platform: "win32",
        resolvePrefix: () => "C:\\Program Files\\nodejs",
        isWritable: () => false,
      }),
    ).toBe(OPENCODE_WIN);
    expect(
      withNpmUserPrefixIfNeeded(CURLED, {
        platform: "linux",
        resolvePrefix: () => "/usr/local",
        isWritable: () => false,
      }),
    ).toBe(CURLED);
  });

  it("does not double-prefix an already-prefixed command", () => {
    const already = prefixed(PI);
    expect(
      withNpmUserPrefixIfNeeded(already, {
        platform: "linux",
        resolvePrefix: () => "/usr/local",
        isWritable: () => false,
      }),
    ).toBe(already);
  });

  it("leaves the command alone when npm will not name a prefix", () => {
    expect(
      withNpmUserPrefixIfNeeded(PI, {
        platform: "linux",
        resolvePrefix: () => null,
        isWritable: () => false,
      }),
    ).toBe(PI);
  });
});

describe("isDirectoryWritable", () => {
  it("reports a fresh temp directory as writable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-npm-prefix-"));
    try {
      expect(isDirectoryWritable(dir)).toBe(true);
      // A child that does not exist yet is still creatable when the parent is.
      expect(isDirectoryWritable(path.join(dir, "nested", "prefix"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("registry PATH suffix", () => {
  it("exposes the user npm bin directory Pi and Codex land in", () => {
    expect(NPM_USER_BIN_SUFFIX).toBe(".local/bin");
  });
});
