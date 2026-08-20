import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  applyManagedBlock,
  ensureOperatorLoginPath,
  ensureOperatorLoginPathOnDisk,
  loginProfileNames,
  renderManagedBlock,
} from "../operator-login-path";
import {
  UBUNTU_BASHRC_AFTER_OPENCODE,
  cleanupTempHomes,
  makeTempHome,
  readHomeFile,
} from "./temp-home";

/** An in-memory home directory, as `ensureOperatorLoginPath`'s port sees it. */
function fakeHome(files: Record<string, string> = {}) {
  const written = { ...files };
  return {
    files: written,
    port: {
      exists: (file: string) => Object.hasOwn(written, file),
      read: (file: string) => written[file] ?? "",
      write: (file: string, text: string) => {
        written[file] = text;
      },
    },
  };
}

describe("loginProfileNames", () => {
  // bash reads exactly one of these, in this order, and stops. Writing to
  // `.profile` when a `.bash_profile` exists puts the block in a file the
  // operator's login shell will never open.
  it("names the bash login file bash would actually read", () => {
    expect(loginProfileNames("/bin/bash", () => true)[0]).toBe(".bash_profile");
    expect(loginProfileNames("/bin/bash", (n) => n !== ".bash_profile")[0]).toBe(".bash_login");
    expect(loginProfileNames("/bin/bash", (n) => n === ".profile")).toEqual([".profile"]);
  });

  it("creates .profile when bash has no login file yet", () => {
    expect(loginProfileNames("/bin/bash", () => false)).toEqual([".profile"]);
  });

  // zsh opens none of the bash files, so a zsh operator would otherwise get a
  // block that never runs.
  it("uses .zprofile for zsh", () => {
    expect(loginProfileNames("/bin/zsh", () => false)[0]).toBe(".zprofile");
    expect(loginProfileNames("/usr/local/bin/zsh", () => false)[0]).toBe(".zprofile");
  });

  // `$SHELL` and the passwd entry can both be missing or stale inside a
  // systemd unit or a container. Guessing zsh there and writing only
  // `.zprofile` would reproduce the very bug this module fixes.
  it("always includes .profile as well, so a wrong guess still lands somewhere", () => {
    expect(loginProfileNames("/bin/zsh", () => false)).toContain(".profile");
    expect(loginProfileNames("/bin/bash", () => true)).toContain(".profile");
  });

  it("does not name .profile twice when it is already the specific answer", () => {
    expect(loginProfileNames("/bin/sh", () => false)).toEqual([".profile"]);
    expect(loginProfileNames("/usr/bin/fish", () => false)).toEqual([".profile"]);
  });
});

describe("renderManagedBlock", () => {
  it("guards each directory on $HOME, not on an absolute path", () => {
    const block = renderManagedBlock([".opencode/bin"]);
    expect(block).toContain('"$HOME/.opencode/bin"');
    expect(block).toMatch(/^# >>> actana managed PATH >>>/m);
    expect(block.trimEnd().endsWith(MANAGED_BLOCK_END)).toBe(true);
  });

  it("is POSIX sh — no bashisms a zsh or dash login would choke on", () => {
    const block = renderManagedBlock([".opencode/bin", ".other/bin"]);
    expect(block).not.toMatch(/\[\[/);
    expect(block).not.toMatch(/^\s*local\s/m);
    expect(block).toContain("esac");
  });

  it("points at a verb the CLI actually has", () => {
    // The block lands in every operator's dotfile; a command that does not
    // exist there is worse than no comment at all.
    expect(renderManagedBlock([".opencode/bin"])).toContain("actana harnesses install");
  });

  it("lists every directory it was given", () => {
    const block = renderManagedBlock([".opencode/bin", ".other/bin"]);
    expect(block).toContain('"$HOME/.opencode/bin"');
    expect(block).toContain('"$HOME/.other/bin"');
  });
});

describe("applyManagedBlock", () => {
  const block = renderManagedBlock([".opencode/bin"]);

  it("appends to a profile that has never seen one", () => {
    const out = applyManagedBlock("export EDITOR=vi\n", block);
    expect(out).not.toBeNull();
    expect(out).toContain("export EDITOR=vi");
    expect(out).toContain(MANAGED_BLOCK_BEGIN);
  });

  it("reports no change when the block is already exactly right", () => {
    const once = applyManagedBlock("export EDITOR=vi\n", block)!;
    expect(applyManagedBlock(once, block)).toBeNull();
  });

  // The whole point of the markers: a second agent landing later must not
  // leave two competing blocks behind.
  it("replaces a stale block in place rather than appending a second", () => {
    const stale = applyManagedBlock("export EDITOR=vi\n", renderManagedBlock([".old/bin"]))!;
    const fresh = applyManagedBlock(stale, block)!;
    expect(fresh.match(new RegExp(MANAGED_BLOCK_BEGIN, "g"))).toHaveLength(1);
    expect(fresh).toContain('"$HOME/.opencode/bin"');
    expect(fresh).not.toContain('"$HOME/.old/bin"');
  });

  it("keeps what the operator wrote around the block", () => {
    const stale = applyManagedBlock("before\n", renderManagedBlock([".old/bin"]))!;
    const withTail = `${stale}\nexport AFTER=1\n`;
    const fresh = applyManagedBlock(withTail, block)!;
    expect(fresh).toContain("before");
    expect(fresh).toContain("export AFTER=1");
  });

  it("ends with exactly one trailing newline", () => {
    const out = applyManagedBlock("export EDITOR=vi", block)!;
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });
});

describe("ensureOperatorLoginPath", () => {
  it("writes the block to the file bash would read", () => {
    const home = fakeHome({ ".profile": "export EDITOR=vi\n", ".bashrc": "" });
    const result = ensureOperatorLoginPath({
      shell: "/bin/bash",
      platform: "linux",
      suffixes: [".opencode/bin"],
      ...home.port,
    });

    expect(result.written).toEqual([".profile"]);
    expect(result.failed).toEqual([]);
    expect(home.files[".profile"]).toContain('"$HOME/.opencode/bin"');
    // The vendor put its export in .bashrc, below the non-interactive guard.
    // Nothing here should touch that file.
    expect(home.files[".bashrc"]).toBe("");
  });

  it("is idempotent — a second run writes nothing", () => {
    const home = fakeHome({ ".profile": "export EDITOR=vi\n" });
    const opts = {
      shell: "/bin/bash",
      platform: "linux" as NodeJS.Platform,
      suffixes: [".opencode/bin"],
      ...home.port,
    };
    expect(ensureOperatorLoginPath(opts).written).toEqual([".profile"]);
    const after = home.files[".profile"];
    expect(ensureOperatorLoginPath(opts).written).toEqual([]);
    expect(home.files[".profile"]).toBe(after);
  });

  it("covers both files for a zsh operator", () => {
    const home = fakeHome({ ".zprofile": "", ".profile": "" });
    const result = ensureOperatorLoginPath({
      shell: "/bin/zsh",
      platform: "linux",
      suffixes: [".opencode/bin"],
      ...home.port,
    });
    expect(result.written).toEqual([".zprofile", ".profile"]);
  });

  it("reports the profiles it could not write instead of throwing", () => {
    const home = fakeHome({ ".profile": "" });
    const result = ensureOperatorLoginPath({
      shell: "/bin/bash",
      platform: "linux",
      suffixes: [".opencode/bin"],
      exists: home.port.exists,
      read: home.port.read,
      write: () => {
        throw new Error("EROFS: read-only file system");
      },
    });
    expect(result.written).toEqual([]);
    expect(result.failed).toEqual([".profile"]);
  });

  it("does nothing on Windows, where a POSIX profile means nothing", () => {
    const home = fakeHome({ ".profile": "" });
    const result = ensureOperatorLoginPath({
      shell: "powershell.exe",
      platform: "win32",
      suffixes: [".opencode/bin"],
      ...home.port,
    });
    expect(result.written).toEqual([]);
    expect(home.files[".profile"]).toBe("");
  });

  it("does nothing when no agent declares a home directory", () => {
    const home = fakeHome({ ".profile": "export EDITOR=vi\n" });
    const result = ensureOperatorLoginPath({
      shell: "/bin/bash",
      platform: "linux",
      suffixes: [],
      ...home.port,
    });
    expect(result.written).toEqual([]);
    expect(home.files[".profile"]).toBe("export EDITOR=vi\n");
  });
});

// Filesystem work is not behind the system port (see actana-system.ts), so
// these run against a real temp home.
describe("ensureOperatorLoginPathOnDisk", () => {
  afterEach(cleanupTempHomes);

  it("creates .profile when the home has no login file at all", () => {
    const home = makeTempHome();
    const result = ensureOperatorLoginPathOnDisk({
      homeDir: home,
      platform: "linux",
      shell: "/bin/bash",
      suffixes: [".opencode/bin"],
    });

    expect(result.written).toEqual([".profile"]);
    expect(readHomeFile(home, ".profile")).toContain('"$HOME/.opencode/bin"');
  });

  it("leaves the operator's own lines alone", () => {
    const home = makeTempHome({ ".profile": "export EDITOR=vi\n" });
    ensureOperatorLoginPathOnDisk({
      homeDir: home,
      platform: "linux",
      shell: "/bin/bash",
      suffixes: [".opencode/bin"],
    });
    expect(readHomeFile(home, ".profile")).toContain("export EDITOR=vi");
  });

  it("does not rewrite the file when nothing changed", () => {
    const home = makeTempHome({ ".profile": "export EDITOR=vi\n" });
    const opts = {
      homeDir: home,
      platform: "linux" as NodeJS.Platform,
      shell: "/bin/bash",
      suffixes: [".opencode/bin"],
    };
    expect(ensureOperatorLoginPathOnDisk(opts).written).toEqual([".profile"]);
    const before = fs.statSync(path.join(home, ".profile")).mtimeMs;
    expect(ensureOperatorLoginPathOnDisk(opts).written).toEqual([]);
    expect(fs.statSync(path.join(home, ".profile")).mtimeMs).toBe(before);
  });

  // The assertion the whole ticket turns on, made against a real shell rather
  // than a string comparison: a *non-interactive login* bash must resolve the
  // binary afterwards. Skipped where there is no bash to ask.
  const withBash = fs.existsSync("/bin/bash") ? it : it.skip;
  withBash("puts the binary on PATH for `bash -lc`, the shape the e2e checks", () => {
    const home = makeTempHome({
      ".bashrc": UBUNTU_BASHRC_AFTER_OPENCODE,
      ".profile": "# ~/.profile\n",
    });

    const bin = path.join(home, ".opencode", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\necho ok\n", { mode: 0o755 });

    const resolve = () =>
      execFileSync("/bin/bash", ["-lc", "command -v opencode || true"], {
        encoding: "utf8",
        env: { HOME: home, PATH: "/usr/bin:/bin", SHELL: "/bin/bash" },
      }).trim();

    // Red without the block: .bashrc returns before the export is reached.
    expect(resolve()).toBe("");

    ensureOperatorLoginPathOnDisk({
      homeDir: home,
      platform: "linux",
      shell: "/bin/bash",
      suffixes: [".opencode/bin"],
    });

    expect(resolve()).toBe(path.join(bin, "opencode"));
  });
});
