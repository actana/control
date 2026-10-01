import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSharedWatchMain, type SharedWatchMessage } from "../shared-folder-watch-main";

// The program the daemon runs as `core` in the container (#561).

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "shared-watch-main-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function io(env: NodeJS.ProcessEnv) {
  const stdin = new PassThrough();
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdin,
    out,
    err,
    io: { stdin, stdout: { write: (c: string) => out.push(c) }, stderr: { write: (c: string) => err.push(c) }, env },
    messages: () =>
      out
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as SharedWatchMessage),
  };
}

async function until(pred: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe("the Shared folder watcher process", () => {
  it("makes the folder as the user it runs as, says ready, reports a change, and exits when stdin ends", async () => {
    const h = io({ HOME: home });
    const done = runSharedWatchMain(h.io);
    await until(() => h.messages().some((m) => m.type === "ready"));
    expect(fs.statSync(path.join(home, "shared")).isDirectory()).toBe(true);

    fs.writeFileSync(path.join(home, "shared", "r.md"), "abc");
    await until(() => h.messages().some((m) => m.type === "changes"), 8_000);
    const changes = h.messages().flatMap((m) => (m.type === "changes" ? m.changes : []));
    expect(changes).toContainEqual(expect.objectContaining({ path: "r.md", size: 3, deleted: false }));

    h.stdin.end();
    expect(await done).toBe(0);
  });

  it("makes the folder again if it is deleted while it runs", async () => {
    const h = io({ HOME: home });
    const done = runSharedWatchMain(h.io);
    await until(() => h.messages().some((m) => m.type === "ready"));
    fs.rmSync(path.join(home, "shared"), { recursive: true });
    await until(() => fs.existsSync(path.join(home, "shared")), 8_000);
    h.stdin.end();
    await done;
  });

  it("refuses to run with the daemon's environment, on stderr and by exit status", async () => {
    const h = io({ HOME: home, AC_CORE_UID: "1000" });
    expect(await runSharedWatchMain(h.io)).toBe(2);
    expect(h.err.join("")).toMatch(/refusing to run with the daemon's environment \(AC_CORE_UID\)/);
    expect(fs.existsSync(path.join(home, "shared"))).toBe(false);
  });

  it("refuses a HOME that is not absolute", async () => {
    const h = io({ HOME: "relative/home" });
    expect(await runSharedWatchMain(h.io)).toBe(2);
    expect(h.err.join("")).toMatch(/HOME is not an absolute path/);
  });

  it("exits 1 and names the problem when ~/shared is a link", async () => {
    fs.symlinkSync(os.tmpdir(), path.join(home, "shared"));
    const h = io({ HOME: home });
    expect(await runSharedWatchMain(h.io)).toBe(1);
    expect(h.err.join("")).toMatch(/is a symbolic link/);
  });
});
