// One write transfer per Project at a time (#165 F8).
//
// **A refusal, not a queue.** A second write to the same Project is answered
// immediately with a distinguishable error, and the reason is that the honest
// thing to tell an operator whose upload collided is "something else is writing
// this Project right now", straight away, while they still have the terminal in
// front of them. A queue would hold their connection open for as long as a
// multi-gigabyte `node_modules` takes, produce no output while it waited, and
// then interleave two people's intentions over the same tree anyway.
//
// **Reads are not gated at all** — unrestricted and concurrent, any number at
// once, including during a write. A read cannot corrupt anything, and a Core
// that made downloads queue behind an upload would make the fleet view of a
// busy Project unusable for the duration.
//
// In memory and per process, exactly like the Session lock table it sits beside
// (ADR 0024 D12). The thing it guards is a transfer in flight, and a transfer
// in flight does not survive the process either.

/** What a caller is told about the transfer that is already running. */
export type ProjectWriteTransfer = {
  projectId: string;
  /** The path being written, relative to the Project root. `""` is the root. */
  path: string;
  /** Epoch milliseconds. Reported so a refusal can say how long it has been held. */
  startedAt: number;
};

export type ProjectWriteLease = {
  /** Release the lease. Idempotent — a double release is not an error. */
  release(): void;
};

export type ProjectWriteAcquisition =
  | { ok: true; lease: ProjectWriteLease }
  | { ok: false; held: ProjectWriteTransfer };

/**
 * The Core's table of in-flight write transfers, keyed by Project.
 *
 * Injected rather than global so a test can hold one without reaching into
 * module state, and so two Cores in one process (which is how the integration
 * tests run) do not share a table they have no business sharing.
 */
export class ProjectWriteLocks {
  private readonly held = new Map<string, ProjectWriteTransfer>();

  /**
   * Take the write lease for a Project, or report the transfer that has it.
   *
   * Synchronous on purpose. The check and the claim happen in one turn of the
   * event loop with nothing awaited between them, which is what makes "one at a
   * time" true without a mutex: two requests arriving in the same tick are
   * still serialised by the single thread, and the second one sees the first's
   * entry.
   */
  acquire(projectId: string, path: string, now: number = Date.now()): ProjectWriteAcquisition {
    const existing = this.held.get(projectId);
    if (existing) return { ok: false, held: existing };
    const transfer: ProjectWriteTransfer = { projectId, path, startedAt: now };
    this.held.set(projectId, transfer);
    let released = false;
    return {
      ok: true,
      lease: {
        release: () => {
          if (released) return;
          released = true;
          // Compared before deleting: a lease whose entry has already been
          // replaced must not delete its successor's. That cannot happen today
          // — nothing else clears the map — and costs one comparison to keep
          // true if anything ever does.
          if (this.held.get(projectId) === transfer) this.held.delete(projectId);
        },
      },
    };
  }

  /** The transfer currently writing this Project, or null. */
  current(projectId: string): ProjectWriteTransfer | null {
    return this.held.get(projectId) ?? null;
  }

  /** Every in-flight write transfer. For logging and for tests. */
  all(): ProjectWriteTransfer[] {
    return [...this.held.values()];
  }
}
