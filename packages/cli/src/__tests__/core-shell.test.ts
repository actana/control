// `actana core shell`, against a fake terminal and a fake Core (#162).
//
// The suite is organised around the ticket's traps rather than around the
// command's code, because the traps are the reason the command is hard:
//
//   - **raw mode is restored on every exit path** — one test per path, and the
//     list of paths is the point. A remote exit, a signal, a dropped link, a
//     write that fails, a terminal that refuses raw mode in the first place.
//   - **`Ctrl-C` reaches the remote process** and does not end the CLI.
//   - **resize propagates**, at spawn and on every `SIGWINCH`.
//   - **the remote exit status comes back**, including `128 + signal`.
//
// Every one of those is a failure mode nobody can stage against a real Core on
// demand, which is why `deps.terminal` and `deps.openShell` are injected at
// all. The fake terminal records raw-mode calls instead of performing them, so
// "did it restore?" is an assertion rather than an operator noticing their
// shell has stopped echoing.

import { describe, it, expect, afterEach } from "vitest";
import { EXIT_FAILURE, EXIT_USAGE } from "../exit-codes.ts";
import {
  fakeTerminal,
  makeCliFixture,
  registerCore,
  sentinelBlobText,
  type CliFixture,
  type FakeTerminal,
} from "./cli-harness.ts";
import type { CoreShellChannel, CoreShellExit } from "../core-shell-channel.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/** A remote shell, under the test's control. */
type FakeShell = CoreShellChannel & {
  /** Everything the CLI sent, joined — keystrokes, in order. */
  typed: () => string;
  resizes: Array<{ cols: number; rows: number }>;
  killCount: () => number;
  closeCount: () => number;
  /** The remote shell prints. */
  emit: (data: string) => void;
  /** The remote shell exits. */
  exit: (exit: CoreShellExit) => void;
  /** The link goes away underneath. */
  drop: (error?: string) => void;
  /** Make every `write` reject — a link that stops accepting input. */
  breakWrites: (err: Error) => void;
};

function fakeShell(): FakeShell {
  const sent: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const data = new Set<(d: string) => void>();
  const exits = new Set<(e: CoreShellExit) => void>();
  const drops = new Set<(i: { error?: string }) => void>();
  let kills = 0;
  let closes = 0;
  let writeError: Error | null = null;

  return {
    ptyId: "pty_test",
    typed: () => sent.join(""),
    resizes,
    killCount: () => kills,
    closeCount: () => closes,
    breakWrites: (err) => {
      writeError = err;
    },
    write: async (d) => {
      if (writeError) throw writeError;
      sent.push(d);
    },
    resize: async (cols, rows) => {
      resizes.push({ cols, rows });
    },
    onData: (cb) => {
      data.add(cb);
      return () => data.delete(cb);
    },
    onExit: (cb) => {
      exits.add(cb);
      return () => exits.delete(cb);
    },
    onDisconnected: (cb) => {
      drops.add(cb);
      return () => drops.delete(cb);
    },
    kill: async () => {
      kills += 1;
    },
    close: () => {
      closes += 1;
    },
    emit: (d) => {
      for (const cb of [...data]) cb(d);
    },
    exit: (e) => {
      for (const cb of [...exits]) cb(e);
    },
    drop: (error) => {
      for (const cb of [...drops]) cb({ error });
    },
  };
}

/** A registered Core, so resolution has something to find. */
async function withRegisteredCore(): Promise<void> {
  registerCore(cli().paths, "prod");
}

/**
 * Start a shell session and hand back the pieces, with the session guaranteed
 * to be fully wired — every listener registered — before the test acts on it.
 */
async function startShell(
  argv: string[] = ["core", "shell"],
  opts: { terminal?: FakeTerminal; shell?: FakeShell } = {},
) {
  await withRegisteredCore();
  const terminal = opts.terminal ?? fakeTerminal();
  const shell = opts.shell ?? fakeShell();
  let spawnSize: { cols: number; rows: number } | null = null;

  const run = cli().run(argv, {
    terminal,
    openShell: async (_blob, o) => {
      spawnSize = { cols: o.cols, rows: o.rows };
      return shell;
    },
  });
  await terminal.wired;
  return { run, terminal, shell, spawnSize: () => spawnSize };
}

describe("raw mode is restored on every exit path", () => {
  it("restores it when the remote shell exits", async () => {
    const { run, terminal, shell } = await startShell();
    expect(terminal.isRaw()).toBe(true);

    shell.exit({ exitCode: 0 });
    await run;

    expect(terminal.rawModeCalls).toEqual([true, false]);
    expect(terminal.isRaw()).toBe(false);
  });

  it("restores it when the connection drops", async () => {
    // The path the ticket calls out by name. Nothing exited, nothing was
    // signalled — the socket simply went away, and the operator is still
    // sitting in a terminal with no echo until this happens.
    const { run, terminal, shell } = await startShell();
    shell.drop("socket hang up");

    const result = await run;
    expect(terminal.isRaw()).toBe(false);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err.join("\n")).toContain("dropped");
    expect(result.err.join("\n")).toContain("socket hang up");
  });

  it.each(["SIGINT", "SIGTERM"] as const)("restores it on %s", async (signal) => {
    const { run, terminal } = await startShell();
    terminal.raise(signal);

    const result = await run;
    expect(terminal.isRaw()).toBe(false);
    // 130 and 143 — `128 + n`, the convention every shell already uses, so a
    // caller can tell a signalled shell from one that exited 2 or 15.
    expect(result.code).toBe(signal === "SIGINT" ? 130 : 143);
  });

  it("restores it when the link stops accepting input", async () => {
    const { run, terminal, shell } = await startShell();
    shell.breakWrites(new Error("write after end"));
    terminal.type("x");

    const result = await run;
    expect(terminal.isRaw()).toBe(false);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err.join("\n")).toContain("write after end");
  });

  it("never enters raw mode at all when the Core will not open a shell", async () => {
    await withRegisteredCore();
    const terminal = fakeTerminal();
    const result = await cli().run(["core", "shell"], {
      terminal,
      openShell: async () => {
        throw new Error("connect ETIMEDOUT");
      },
    });

    // Dialling happens before the terminal is taken, so the ordinary failure of
    // this command — a Core that is down — never touches raw mode.
    expect(terminal.rawModeCalls).toEqual([]);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err.join("\n")).toContain("connect ETIMEDOUT");
  });

  it("gives up cleanly when the terminal itself refuses raw mode", async () => {
    await withRegisteredCore();
    const terminal = fakeTerminal();
    terminal.breakRawMode(new Error("ioctl failed"));
    const shell = fakeShell();

    const result = await cli().run(["core", "shell"], { terminal, openShell: async () => shell });

    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err.join("\n")).toContain("raw mode");
    // The shell was already spawned on the Core. Leaving it would strand a
    // login shell nobody can reach: the task id was random and is now gone.
    expect(shell.killCount()).toBe(1);
    expect(shell.closeCount()).toBe(1);
  });

  it("hands the terminal back before it waits on the Core", async () => {
    // Tearing down after a signal means a best-effort kill, which is a round
    // trip to a machine that may already be gone. Doing that while the terminal
    // was still raw would leave a request timeout's worth of unusable shell
    // behind every `SIGTERM` — the exact outcome the restore exists to prevent.
    const shell = fakeShell();
    let finishKill = () => {};
    shell.kill = () =>
      new Promise<void>((resolve) => {
        finishKill = resolve;
      });

    const { run, terminal } = await startShell(["core", "shell"], { shell });
    terminal.raise("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The kill has not come back yet, and the terminal is already usable.
    expect(terminal.isRaw()).toBe(false);
    finishKill();
    expect((await run).code).toBe(143);
  });

  it("hangs up on every path, so the Core is not left timing out a socket", async () => {
    for (const ending of ["exit", "drop", "signal"] as const) {
      const { run, terminal, shell } = await startShell();
      if (ending === "exit") shell.exit({ exitCode: 0 });
      else if (ending === "drop") shell.drop();
      else terminal.raise("SIGTERM");
      await run;
      expect(shell.closeCount(), `${ending} left the channel open`).toBe(1);
      expect(terminal.isRaw(), `${ending} left the terminal raw`).toBe(false);
    }
  });
});

describe("Ctrl-C reaches the remote process", () => {
  it("forwards it as a byte and does not end the session", async () => {
    // The trap, stated as a test: in raw mode `Ctrl-C` is the byte 0x03 on
    // stdin, not a signal against this CLI. If it were a local kill, nothing
    // running on the Core could ever be interrupted — which is the one thing an
    // escape hatch exists for.
    const { run, terminal, shell } = await startShell();
    terminal.type("\u0003");

    // Still live: the session has not settled, and the byte went out.
    expect(shell.typed()).toBe("\u0003");
    expect(terminal.isRaw()).toBe(true);

    // The remote shell reports the interrupt itself, which is the only place a
    // status for it can come from.
    shell.exit({ exitCode: 130 });
    const result = await run;
    expect(result.code).toBe(130);
  });

  it("forwards keystrokes in order, including whatever the operator pastes", async () => {
    const { run, terminal, shell } = await startShell();
    terminal.type("ec");
    terminal.type("ho hi\r");
    terminal.type("\u0004");

    expect(shell.typed()).toBe("echo hi\r\u0004");
    shell.exit({ exitCode: 0 });
    await run;
  });
});

describe("resize propagates", () => {
  it("tells the Core the size at spawn", async () => {
    const terminal = fakeTerminal({ cols: 120, rows: 40 });
    const { run, shell, spawnSize } = await startShell(["core", "shell"], { terminal });
    expect(spawnSize()).toEqual({ cols: 120, rows: 40 });
    shell.exit({ exitCode: 0 });
    await run;
  });

  it("sends a resize for every SIGWINCH", async () => {
    const { run, terminal, shell } = await startShell();
    terminal.resizeTo(100, 30);
    terminal.resizeTo(60, 20);

    expect(shell.resizes).toEqual([
      { cols: 100, rows: 30 },
      { cols: 60, rows: 20 },
    ]);
    shell.exit({ exitCode: 0 });
    await run;
  });

  it("does not end a working session because one resize failed", async () => {
    // A resize that did not land means the far side is drawing at the old size.
    // That is a redraw away from fixed, and nowhere near worth tearing down a
    // shell somebody is working in.
    const shell = fakeShell();
    shell.resize = async () => {
      throw new Error("resize refused");
    };
    const { run, terminal } = await startShell(["core", "shell"], { shell });
    terminal.resizeTo(100, 30);

    expect(terminal.isRaw()).toBe(true);
    shell.exit({ exitCode: 0 });
    expect((await run).code).toBe(0);
  });
});

describe("the remote exit status comes back", () => {
  it.each([0, 1, 2, 3, 42, 255])("returns %i", async (exitCode) => {
    const { run, shell } = await startShell();
    shell.exit({ exitCode });
    expect((await run).code).toBe(exitCode);
  });

  it("reports a remote kill as 128 + signal", async () => {
    const { run, shell } = await startShell();
    shell.exit({ exitCode: 0, signal: 9 });
    expect((await run).code).toBe(137);
  });

  it("falls back to a plain failure for a status a process cannot carry", async () => {
    // Nothing on the wire guarantees 0–255. Truncating would report a number
    // the remote shell never chose, which is worse than saying "it failed".
    const { run, shell } = await startShell();
    shell.exit({ exitCode: 4096 });
    expect((await run).code).toBe(EXIT_FAILURE);
  });

  it("does not kill a shell that ended by itself", async () => {
    const { run, shell } = await startShell();
    shell.exit({ exitCode: 0 });
    await run;
    expect(shell.killCount()).toBe(0);
  });

  it("kills the remote shell when this end is torn down instead", async () => {
    const { run, terminal, shell } = await startShell();
    terminal.raise("SIGTERM");
    await run;
    expect(shell.killCount()).toBe(1);
  });
});

describe("the shell's bytes reach the terminal", () => {
  it("paints them unmodified, and adds nothing of its own to the stream", async () => {
    const { run, terminal, shell } = await startShell();
    // Escape sequences, no trailing newline — what a full-screen program emits.
    shell.emit("\u001b[2J\u001b[H$ ");
    shell.emit("ls\r\n");
    shell.exit({ exitCode: 0 });
    await run;

    // The session ended on a newline, so nothing was appended to realign it.
    expect(terminal.painted()).toBe("\u001b[2J\u001b[H$ ls\r\n");
  });

  it("realigns the cursor when the shell ended mid-line", async () => {
    const { run, terminal, shell } = await startShell();
    shell.emit("$ ");
    shell.drop();
    await run;
    expect(terminal.painted()).toBe("$ \r\n");
  });
});

describe("what it refuses", () => {
  it("refuses a stdin/stdout that is not a terminal", async () => {
    await withRegisteredCore();
    const result = await cli().run(["core", "shell"], { terminal: fakeTerminal({ isTty: false }) });
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join("\n")).toContain("not a terminal");
  });

  it("refuses --json, which it cannot honour", async () => {
    await withRegisteredCore();
    const result = await cli().run(["core", "shell", "--json"], { terminal: fakeTerminal() });
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join("\n")).toContain("--json");
  });

  it("says which Core it could not find, rather than dialling nothing", async () => {
    const result = await cli().run(["core", "shell"], { terminal: fakeTerminal() });
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.err.join("\n")).toContain("no Core selected");
  });

  it("honours --core, like every other verb that leaves the machine", async () => {
    registerCore(cli().paths, "prod", sentinelBlobText("wss://prod.test:9444"));
    registerCore(cli().paths, "staging", sentinelBlobText("wss://staging.test:9444"));

    let dialled: string | null = null;
    const terminal = fakeTerminal();
    const shell = fakeShell();
    const run = cli().run(["core", "shell", "--core", "staging"], {
      terminal,
      openShell: async (blob) => {
        dialled = blob.endpoint;
        return shell;
      },
    });
    await terminal.wired;
    shell.exit({ exitCode: 0 });
    await run;

    expect(dialled).toBe("wss://staging.test:9444");
  });
});
