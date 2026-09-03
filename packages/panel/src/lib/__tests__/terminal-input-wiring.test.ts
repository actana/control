import { describe, expect, it } from "vitest";
import { createTerminalInputWiring, type InputSubscription } from "../terminal-input-wiring";

// Issue 393, second half: a pane can attach more than once for one surface, and
// every attach used to wire an xterm `onData` handler that nothing disposed.
// What the operator saw was doubled characters after a reload against a pty
// that had gone — and doubled characters are not a rendering artefact, they are
// bytes the shell received twice.

/**
 * A stand-in for the pane's terminal: hands out disposable subscriptions and
 * delivers a keystroke to every one still live. Deliberately dumb — an xterm
 * emitter is exactly this, and the bug was never in xterm.
 */
function fakeTerm() {
  const live = new Set<(data: string) => void>();
  return {
    liveHandlers: () => live.size,
    onData(cb: (data: string) => void): InputSubscription {
      live.add(cb);
      return { dispose: () => live.delete(cb) };
    },
    type(data: string) {
      for (const cb of [...live]) cb(data);
    },
  };
}

/**
 * The pane's attach path, reduced to what issue 393 is about: each attach wires
 * the input and writes what it receives to the PTY. `wireTerminalInput` in the
 * pane is this call, with the running-fallback and prompt-capture side effects
 * that are not what is under test here.
 */
function attach(
  wiring: ReturnType<typeof createTerminalInputWiring>,
  term: ReturnType<typeof fakeTerm>,
  ptyId: string,
  writes: Array<{ ptyId: string; data: string }>,
) {
  wiring.wire(() => [term.onData((data) => writes.push({ ptyId, data }))]);
}

describe("the pane's terminal input wiring", () => {
  it("delivers a keystroke once after a failed reattach wires the input again", () => {
    const term = fakeTerm();
    const writes: Array<{ ptyId: string; data: string }> = [];
    const wiring = createTerminalInputWiring();

    // `ensurePty`'s real sequence on a reload whose recorded pty is gone: wire
    // against the descriptor's pty, find the replay empty, fall through to
    // `findByTask`, wire again against the live one.
    attach(wiring, term, "pty_stale", writes);
    attach(wiring, term, "pty_live", writes);

    term.type("a");

    // One keystroke, one byte, and it goes to the pty the pane actually ended
    // up attached to. Before the fix this was `["pty_stale", "pty_live"]` —
    // "aa" in the shell, and a stray write to a dead pty besides.
    expect(writes).toEqual([{ ptyId: "pty_live", data: "a" }]);
    expect(term.liveHandlers()).toBe(1);
  });

  it("holds one subscription however many times the pane re-attaches", () => {
    const term = fakeTerm();
    const writes: Array<{ ptyId: string; data: string }> = [];
    const wiring = createTerminalInputWiring();

    // A pane that flaps: reattach, respawn, reattach. The surface is built once
    // and survives all of it, which is why the handlers used to accumulate.
    for (const ptyId of ["pty_1", "pty_2", "pty_3", "pty_4"]) {
      attach(wiring, term, ptyId, writes);
    }

    term.type("\r");

    expect(writes).toEqual([{ ptyId: "pty_4", data: "\r" }]);
  });

  it("disposes every subscription an attach wired, not only the first", () => {
    const term = fakeTerm();
    const seen: string[] = [];
    const wiring = createTerminalInputWiring();

    // The pane wires two per attach — `onData` and `onResize` — and a wiring
    // that only remembered one of them would leak the other on every attach.
    wiring.wire(() => [
      term.onData((d) => seen.push(`first:${d}`)),
      term.onData((d) => seen.push(`second:${d}`)),
    ]);
    wiring.wire(() => [term.onData((d) => seen.push(`third:${d}`))]);

    term.type("x");

    expect(seen).toEqual(["third:x"]);
  });

  it("leaves nothing behind when the pane tears down", () => {
    const term = fakeTerm();
    const seen: string[] = [];
    const wiring = createTerminalInputWiring();

    attach(wiring, term, "pty_1", []);
    wiring.wire(() => [term.onData((d) => seen.push(d))]);
    wiring.dispose();
    // Idempotent: the pane's teardown runs it, and a `wire` that never happened
    // must not make it throw.
    wiring.dispose();

    term.type("q");

    expect(seen).toEqual([]);
    expect(term.liveHandlers()).toBe(0);
  });
});
