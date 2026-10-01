// One write transfer into the workspace at a time (#165 F8).
//
// **A refusal, not a queue.** A second write is answered immediately with a
// distinguishable error, and the reason is that the honest thing to tell an
// operator whose upload collided is "something else is writing the workspace
// right now", straight away, while they still have the terminal in front of
// them. A queue would hold their connection open for as long as a
// multi-gigabyte `node_modules` takes, produce no output while it waited, and
// then interleave two people's intentions over the same tree anyway.
//
// **Reads are not gated at all** — unrestricted and concurrent, any number at
// once, including during a write. A read cannot corrupt anything, and a Core
// that made downloads queue behind an upload would make the fleet view of a
// busy workspace unusable for the duration.
//
// A Core has one workspace (ADR 0041 D1), so there is one lease and nothing to
// key it by.
//
// In memory and per process, exactly like the Session lock table it sits beside
// (ADR 0024 D12). The thing it guards is a transfer in flight, and a transfer
// in flight does not survive the process either.

/** What a caller is told about the transfer that is already running. */
export type WorkspaceWriteTransfer = {
  /** The path being written, relative to the workspace root. `""` is the root. */
  path: string;
  /** Epoch milliseconds. Reported so a refusal can say how long it has been held. */
  startedAt: number;
};

export type WorkspaceWriteLease = {
  /** Release the lease. Idempotent — a double release is not an error. */
  release(): void;
};

export type WorkspaceWriteAcquisition =
  | { ok: true; lease: WorkspaceWriteLease }
  | { ok: false; held: WorkspaceWriteTransfer };

/**
 * The Core's record of the write transfer in flight, if there is one.
 *
 * Injected rather than global so a test can hold one without reaching into
 * module state, and so two Cores in one process (which is how the integration
 * tests run) do not share a lease they have no business sharing.
 */
export class WorkspaceWriteLocks {
  private held: WorkspaceWriteTransfer | null = null;

  /**
   * Take the write lease, or report the transfer that has it.
   *
   * Synchronous on purpose. The check and the claim happen in one turn of the
   * event loop with nothing awaited between them, which is what makes "one at a
   * time" true without a mutex: two requests arriving in the same tick are
   * still serialised by the single thread, and the second one sees the first's
   * entry.
   */
  acquire(path: string, now: number = Date.now()): WorkspaceWriteAcquisition {
    if (this.held) return { ok: false, held: this.held };
    const transfer: WorkspaceWriteTransfer = { path, startedAt: now };
    this.held = transfer;
    let released = false;
    return {
      ok: true,
      lease: {
        release: () => {
          if (released) return;
          released = true;
          // Compared before clearing: a lease whose entry has already been
          // replaced must not clear its successor's. That cannot happen today
          // — nothing else clears it — and costs one comparison to keep true if
          // anything ever does.
          if (this.held === transfer) this.held = null;
        },
      },
    };
  }

  /** The transfer currently writing the workspace, or null. */
  current(): WorkspaceWriteTransfer | null {
    return this.held;
  }
}
