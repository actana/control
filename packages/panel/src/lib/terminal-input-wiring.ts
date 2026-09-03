// One live input subscription per pane, however many times it re-attaches
// (issue 393).
//
// A pane wires its xterm `onData`/`onResize` handlers when it attaches to a
// PTY, and it can attach more than once for one surface: `ensurePty` tries the
// descriptor's pty, and when that reattach comes back empty it falls through to
// `findByTask`, and when *that* finds nothing it spawns. Each attempt wired a
// fresh handler and none of them disposed the last, so after a reload against a
// dead pty the surviving handlers all fired on one keystroke — every byte
// written to the PTY twice, which a shell reads as the operator typing it
// twice. Nothing on screen says so until the doubled characters arrive.
//
// So the pane holds *the* subscription rather than a pile of them: wiring again
// disposes what was wired before, and the pane's teardown disposes the last.
// Kept here, out of the pane's build closure, because it is a fact about the
// pane's lifetime that is worth asserting on without an xterm in jsdom.

/** The shape xterm's `onData`/`onResize` return. Structural, so a fake fits. */
export type InputSubscription = { dispose(): void };

export type TerminalInputWiring = {
  /**
   * Replace the pane's input subscription with a fresh one.
   *
   * `subscribe` is called *after* the previous subscription is disposed, so an
   * emitter that fires during subscribe cannot reach a handler on its way out.
   */
  wire(subscribe: () => InputSubscription[]): void;
  /** Drop the current subscription, if any. Idempotent. */
  dispose(): void;
};

export function createTerminalInputWiring(): TerminalInputWiring {
  let current: InputSubscription[] = [];
  const dispose = () => {
    // Copied out before disposing: a `dispose` that re-enters (a handler that
    // rewires) must not find the array it is walking being rewritten under it.
    const going = current;
    current = [];
    for (const sub of going) sub.dispose();
  };
  return {
    wire(subscribe) {
      dispose();
      current = subscribe();
    },
    dispose,
  };
}
