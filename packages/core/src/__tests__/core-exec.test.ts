// `runCoreExec` — the Core half of `actana core exec` (#266).
//
// Real child processes, because every claim here is about one: that the exit
// code is the command's own, that a signal is reported as a signal, that the
// two streams stay apart, that the child is given no terminal, and that the
// three bounds — cwd, output, time — refuse rather than lie.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCoreExec, EXEC_MAX_OUTPUT_BYTES } from "../core-exec";

const temporary: string[] = [];
afterEach(() => {
  while (temporary.length > 0) fs.rmSync(temporary.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "core-exec-")));
  temporary.push(dir);
  return dir;
}

/** Narrow to the ok arm, failing with the refusal's own message if it is not. */
function ok(result: Awaited<ReturnType<typeof runCoreExec>>) {
  if (result.outcome !== "ok") throw new Error(`expected a run, got: ${result.message}`);
  return result;
}

describe("runCoreExec — the command's own status", () => {
  it("returns the exit code the command chose", async () => {
    const result = ok(await runCoreExec({ command: "sh", args: ["-c", "exit 3"] }));
    expect(result.exitCode).toBe(3);
    expect(result.signal).toBeNull();
  });

  it("returns 0 for a command that succeeded", async () => {
    expect(ok(await runCoreExec({ command: "true", args: [] })).exitCode).toBe(0);
  });

  it("reports a signal as a signal, with a null exit code", async () => {
    const result = ok(
      await runCoreExec({ command: "sh", args: ["-c", "kill -TERM $$; sleep 5"] }),
    );
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  it("does not reject for a command that failed — a non-zero status is an answer", async () => {
    await expect(runCoreExec({ command: "false", args: [] })).resolves.toMatchObject({
      outcome: "ok",
      exitCode: 1,
    });
  });
});

describe("runCoreExec — the two streams", () => {
  it("keeps stdout and stderr apart", async () => {
    const result = ok(
      await runCoreExec({ command: "sh", args: ["-c", "echo o; echo e >&2"] }),
    );
    expect(result.stdout).toBe("o\n");
    expect(result.stderr).toBe("e\n");
  });

  it("gives the child no terminal, which is the whole reason this is not a PTY", async () => {
    const result = ok(
      await runCoreExec({
        command: "sh",
        args: ["-c", "if [ -t 1 ]; then echo TTY; else echo PIPE; fi"],
      }),
    );
    expect(result.stdout.trim()).toBe("PIPE");
  });

  it("gives the child no stdin either, so a command that reads one finishes", async () => {
    // Inherited stdin would make this hang until the test timed out, which is
    // the failure a maintenance script would hit at 3am.
    const result = ok(await runCoreExec({ command: "cat", args: [] }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("runs no shell of its own — an argv is an argv", async () => {
    const dir = scratch();
    // Under a shell this would create a file called `x`; spawned directly, the
    // redirect is just an argument echo prints.
    const result = ok(await runCoreExec({ command: "echo", args: ["hi", ">", "x"], cwd: dir }));
    expect(result.stdout).toBe("hi > x\n");
    expect(fs.existsSync(path.join(dir, "x"))).toBe(false);
  });
});

describe("runCoreExec — cwd is validated here, by the machine that owns the disk", () => {
  it("runs in the directory it was given", async () => {
    const dir = scratch();
    const result = ok(await runCoreExec({ command: "pwd", args: [], cwd: dir }));
    expect(result.stdout.trim()).toBe(dir);
  });

  it("defaults to this Core's home when none was given", async () => {
    const result = ok(await runCoreExec({ command: "pwd", args: [] }));
    expect(fs.realpathSync(result.stdout.trim())).toBe(fs.realpathSync(os.homedir()));
  });

  it("refuses a missing directory with a sentence written for the operator", async () => {
    const missing = path.join(scratch(), "not-here");
    await expect(runCoreExec({ command: "pwd", args: [], cwd: missing })).rejects.toThrow(
      /No such directory on this Core/,
    );
  });

  it("refuses a path that is a file rather than a directory", async () => {
    const file = path.join(scratch(), "a-file");
    fs.writeFileSync(file, "x");
    await expect(runCoreExec({ command: "pwd", args: [], cwd: file })).rejects.toThrow(
      /Not a directory on this Core/,
    );
  });

  it("rejects rather than resolving when the executable does not exist", async () => {
    await expect(runCoreExec({ command: "no-such-binary-266", args: [] })).rejects.toThrow();
  });
});

describe("runCoreExec — the output bound", () => {
  it("states a bound rather than leaving it to whatever the command felt like", () => {
    expect(EXEC_MAX_OUTPUT_BYTES).toBe(8 * 1024 * 1024);
  });

  it("passes output that fits straight through", async () => {
    const result = ok(
      await runCoreExec({ command: "echo", args: ["small"], maxOutputBytes: 1024 }),
    );
    expect(result.stdout).toBe("small\n");
  });

  it("refuses past the bound instead of truncating — a short stdout that looks whole is the bug", async () => {
    const result = await runCoreExec({
      command: "sh",
      args: ["-c", "head -c 100000 /dev/zero | tr '\\0' x"],
      maxOutputBytes: 64,
    });
    expect(result.outcome).toBe("output-too-large");
    // Nothing partial comes back with it. There is no `stdout` on this arm at
    // all, which is what makes "truncated" unrepresentable rather than merely
    // avoided.
    expect("stdout" in result).toBe(false);
    if (result.outcome === "output-too-large") {
      expect(result.message).toContain("Nothing was returned");
    }
  });

  it("counts both streams against the one bound", async () => {
    const result = await runCoreExec({
      command: "sh",
      args: ["-c", "head -c 100000 /dev/zero | tr '\\0' x >&2"],
      maxOutputBytes: 64,
    });
    expect(result.outcome).toBe("output-too-large");
  });
});

describe("runCoreExec — the time bound", () => {
  it("stops a command that never finishes, and says so", async () => {
    // Nobody is watching an exec, so an unbounded child would sit on this
    // machine holding a process until the daemon restarted.
    await expect(
      runCoreExec({ command: "sleep", args: ["30"], timeoutMs: 200 }),
    ).rejects.toThrow(/did not finish within/);
  });
});
