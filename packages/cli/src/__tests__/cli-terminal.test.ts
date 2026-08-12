// The real terminal, against a fake process (#162, #129 D11).
//
// `core-shell.test.ts` drives the command against a fake terminal, which leaves
// the terminal itself — the half that actually calls `setRawMode` and attaches
// to stdin — asserted by nothing. This is that half: `terminalFromProcess`
// takes its process as an argument precisely so it can be handed one written in
// twenty lines, and the things worth pinning down here are the ones that are
// invisible until an operator's terminal is already broken.

import { describe, it, expect } from "vitest";
import { FALLBACK_SIZE, nonInteractiveTerminal, terminalFromProcess, type ProcessLike } from "../cli-terminal.ts";

type Listener = (...args: never[]) => void;

/** A process, as much of one as this module touches. */
function fakeProcess(opts: { stdinTty?: boolean; stdoutTty?: boolean; columns?: number; rows?: number } = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const on = (event: string, cb: Listener) => {
    const set = listeners.get(event) ?? new Set();
    set.add(cb);
    listeners.set(event, set);
  };
  const off = (event: string, cb: Listener) => listeners.get(event)?.delete(cb);
  const fire = (event: string, ...args: unknown[]) => {
    for (const cb of [...(listeners.get(event) ?? [])]) (cb as (...a: unknown[]) => void)(...args);
  };

  const state = {
    rawModeCalls: [] as boolean[],
    resumed: 0,
    paused: 0,
    written: [] as string[],
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    fire,
  };

  const proc: ProcessLike = {
    stdin: {
      isTTY: opts.stdinTty ?? true,
      setRawMode: (raw: boolean) => state.rawModeCalls.push(raw),
      resume: () => (state.resumed += 1),
      pause: () => (state.paused += 1),
      on: (event, cb) => on(event, cb as Listener),
      off: (event, cb) => off(event, cb as Listener),
    },
    stdout: {
      isTTY: opts.stdoutTty ?? true,
      columns: opts.columns,
      rows: opts.rows,
      write: (data: string) => state.written.push(data),
      on: (event, cb) => on(event, cb as Listener),
      off: (event, cb) => off(event, cb as Listener),
    },
    on: (event, cb) => on(event, cb as Listener),
    off: (event, cb) => off(event, cb as Listener),
    once: (event, cb) => on(event, cb as Listener),
  };

  return { proc, state };
}

describe("terminalFromProcess", () => {
  it("is a TTY only when both halves are", async () => {
    // A piped stdin has no raw mode to enter; a redirected stdout has no size
    // to propagate. Either one alone is not a terminal a shell can run in.
    expect(terminalFromProcess(fakeProcess().proc).isTty).toBe(true);
    expect(terminalFromProcess(fakeProcess({ stdinTty: false }).proc).isTty).toBe(false);
    expect(terminalFromProcess(fakeProcess({ stdoutTty: false }).proc).isTty).toBe(false);
  });

  it("reads the size fresh, and falls back when the terminal will not say", () => {
    const { proc } = fakeProcess({ columns: 120, rows: 40 });
    const terminal = terminalFromProcess(proc);
    expect(terminal.size()).toEqual({ cols: 120, rows: 40 });

    // Not cached: a resize changes the answer, which is the whole point of
    // reading it on every `SIGWINCH`.
    proc.stdout.columns = 60;
    expect(terminal.size().cols).toBe(60);

    expect(terminalFromProcess(fakeProcess().proc).size()).toEqual(FALLBACK_SIZE);
  });

  it("resumes stdin on the way in and pauses it on the way out", () => {
    // The pause is not tidiness: an stdin with a live `data` listener holds the
    // event loop open, and a CLI that has printed its last line and will not
    // exit reads exactly like a hang.
    const { proc, state } = fakeProcess();
    const terminal = terminalFromProcess(proc);
    terminal.setRawMode(true);
    expect(state.resumed).toBe(1);
    terminal.setRawMode(false);
    expect(state.paused).toBe(1);
    expect(state.rawModeCalls).toEqual([true, false]);
  });

  it("installs a last-resort restore the first time raw mode is entered", () => {
    // The guard for the route no `finally` covers. Nothing above it is allowed
    // to rely on this — the command restores in a `finally`, on both signals
    // and on a dropped link — but the cost of the one path that escapes all
    // three is an operator with an unusable shell.
    const { proc, state } = fakeProcess();
    const terminal = terminalFromProcess(proc);
    expect(state.listenerCount("exit")).toBe(0);

    terminal.setRawMode(true);
    terminal.setRawMode(false);
    terminal.setRawMode(true);
    // One hook, however many times raw mode is toggled.
    expect(state.listenerCount("exit")).toBe(1);

    state.rawModeCalls.length = 0;
    state.fire("exit");
    expect(state.rawModeCalls).toEqual([false]);
  });

  it("arms the last-resort restore before it can fail, and never throws from it", () => {
    const { proc, state } = fakeProcess();
    proc.stdin.setRawMode = () => {
      throw new Error("ioctl failed");
    };
    const terminal = terminalFromProcess(proc);

    // Entering raw mode propagates the failure — the caller must not carry on
    // as though it had a terminal it can drive.
    expect(() => terminal.setRawMode(true)).toThrow("ioctl failed");
    // …but the hook is armed first, so a terminal that refused half way (raw
    // enough to be unusable, not raw enough to report success) is still put
    // back. A throw from an exit hook replaces one bad outcome with a worse one.
    expect(state.listenerCount("exit")).toBe(1);
    expect(() => state.fire("exit")).not.toThrow();
  });

  it("does not split a multi-byte character across two chunks", () => {
    // A keystroke is bytes, and `é` arrives as two of them. Decoding per chunk
    // would send the far side replacement characters instead of the letter that
    // was typed.
    const { proc, state } = fakeProcess();
    const seen: string[] = [];
    terminalFromProcess(proc).onInput((data) => seen.push(data));

    const bytes = Buffer.from("héllo", "utf8");
    state.fire("data", bytes.subarray(0, 2));
    state.fire("data", bytes.subarray(2));

    expect(seen.join("")).toBe("héllo");
    expect(seen.join("")).not.toContain("�");
  });

  it("unsubscribes what it subscribed", () => {
    const { proc, state } = fakeProcess();
    const terminal = terminalFromProcess(proc);
    const stop = [
      terminal.onInput(() => {}),
      terminal.onResize(() => {}),
      terminal.onSignal("SIGINT", () => {}),
      terminal.onSignal("SIGTERM", () => {}),
    ];
    expect(state.listenerCount("data")).toBe(1);
    expect(state.listenerCount("resize")).toBe(1);
    expect(state.listenerCount("SIGINT")).toBe(1);

    for (const dispose of stop) dispose();
    for (const event of ["data", "resize", "SIGINT", "SIGTERM"]) {
      expect(state.listenerCount(event), `${event} listener outlived its session`).toBe(0);
    }
  });

  it("writes bytes to stdout with nothing appended", () => {
    const { proc, state } = fakeProcess();
    terminalFromProcess(proc).write("$ ");
    expect(state.written).toEqual(["$ "]);
  });
});

describe("nonInteractiveTerminal", () => {
  it("refuses raw mode rather than pretending to enter it", () => {
    // A command that reached for raw mode through this object has a bug, and
    // the throw says so at the call site instead of leaving an operator to
    // discover it.
    expect(() => nonInteractiveTerminal().setRawMode(true)).toThrow(/not interactive/);
    expect(nonInteractiveTerminal().isTty).toBe(false);
  });
});
