// The link `actana session attach` runs a terminal over (#163, #129 D10/D11).
//
// The third seam in this package after `core-probe.ts` and `core-shell-channel.ts`,
// and the same shape for the same reason: one module dials, and the command
// takes what it hands back as a dependency — so raw mode, the detach key and
// every teardown path are exercised by unit tests with no Core anywhere near
// them.
//
// **What makes this one different from the shell's is the write lock, and the
// lock is in here rather than in the command** (ADR 0024 D3–D7, #144). `attach`
// writes to a Session somebody else may be driving, so authority is settled
// before the operator's terminal is touched at all:
//
//   1. **A `claim` goes out before anything is painted** (D6 — claiming is
//      explicit; a mutation never acquires the lock). Its answer is the whole of
//      {@link SessionAttachment.authority}, and the command renders read-only
//      off that rather than discovering it by having a keystroke refused.
//   2. **A refused claim is an answer, not a failure.** Another client holding
//      the Session gives a read-only attachment with a reason on it — not an
//      error, and not a takeover. `forceTakeover` exists (D7) and this command
//      does not send it: an attach that stole the lock from a running automation
//      because somebody typed a session id is the accident the lock was added to
//      prevent.
//   3. **This object cannot write without the lock.** {@link SessionAttachment.write}
//      throws {@link SessionWriteRefused} before reaching the wire when the
//      authority is not a writing one, and turns the Core's own `session-locked`
//      refusal into the same error when the lock is taken away mid-session. The
//      command has one thing to handle, and a read-only attachment that grew a
//      write path by accident would be refused here as well as there.
//   4. **`release` is the ordinary ending, and the link dropping is the other
//      one.** D7 ends a lock on explicit release *or* on the connection going
//      away, which is why {@link SessionAttachment.release} answers `false`
//      rather than throwing on a link that is already gone: there is nothing
//      left to release, because the Core has done it. Nothing here waits on a
//      dead socket to find that out.
//
// **A Core that does not announce `multiConnection` has no lock table at all**
// (ADR 0024 D11), and the SDK answers `supported: false` for it. That is
// {@link SessionAttachment.authority} `"no-lock-table"` and it is **writable** —
// such a Core serves every mutation this client makes. Rendering it read-only
// would tell an operator who is that Core's only client that somebody else is
// typing.
//
// **The SDK is untouched (D11).** Everything below is `@actana/sdk`'s existing
// vocabulary — `claim`, `release`, `ptySubscribe`, `replay`, `write`, `resize`,
// `onData`, `onExit` — with no TTY, no signal and no raw-mode call near it.

import { CoreClient, CoreLinkRequestError } from "@actana/sdk/core-client.ts";
import { SESSION_LOCKED_ERROR_CODE } from "@actana/sdk/core-link-frames.ts";
import { SessionGatewayError } from "./session-gateway.ts";
import type { CoreRegistrationBlob } from "@actana/sdk/core-registration-blob.ts";
import type { Unsubscribe } from "./cli-terminal.ts";

/** How a harness's process ended, while somebody was attached to it. */
export type SessionAttachExit = { exitCode: number; signal?: number };

/**
 * What this attachment may do to the Session, decided once at attach time.
 *
 * Four states rather than a boolean, because "may I write" and "why not" are
 * one question to an operator and the reason is the difference between a bug
 * report and an explanation. `held` and `no-lock-table` write; the other two do
 * not.
 */
export type AttachAuthority =
  /** The `claim` was granted. This attachment holds the Session's write lock. */
  | "held"
  /** Another Core client holds it. Read-only, and the Core said so (D4/D6). */
  | "held-by-another"
  /** `--read-only`: no claim was sent, by request. The Session may be unlocked. */
  | "not-claimed"
  /** This Core publishes no lock state (D11). Writable — there is no lock to lose. */
  | "no-lock-table";

/** Do the rules let this attachment put bytes into the Session? */
export function authorityWrites(authority: AttachAuthority): boolean {
  return authority === "held" || authority === "no-lock-table";
}

/**
 * A write this attachment is not allowed to make.
 *
 * One error for two moments that are the same fact: a read-only attachment that
 * tried to write, and a writing one whose lock was taken away underneath it
 * (D7's force takeover — the previous holder's next mutation is refused). Both
 * mean *stop writing and say so*, and a command that had to tell them apart
 * would end up parsing the Core's prose to do it.
 */
export class SessionWriteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionWriteRefused";
  }
}

/**
 * One attached Session, as the command sees it.
 *
 * Narrower than a `CoreClient` on purpose — the same argument
 * `core-shell-channel.ts` makes: handing the command the whole client would let
 * the terminal half reach for `forceTakeover`, and would make the fake this is
 * tested against a re-implementation of the SDK.
 */
export type SessionAttachment = {
  /** The Session this is attached to. */
  readonly taskId: string;
  /** The PTY the Core resolved that Session to, right now. */
  readonly ptyId: string;
  /** What the `claim` settled. See {@link AttachAuthority}. */
  readonly authority: AttachAuthority;
  /**
   * The scrollback the Core still holds for this PTY, to paint before the live
   * stream. Read at attach time because a `replay` that arrived later would
   * paint history on top of the present.
   */
  readonly backlog: string;
  /**
   * Keystrokes into the Session, in the order they were typed.
   *
   * Throws {@link SessionWriteRefused} when this attachment holds no write
   * authority — before the wire when it never had it, and after the Core's own
   * refusal when it lost it.
   */
  write(data: string): Promise<void>;
  /** Tell the PTY the terminal's new size. Only the writer calls it — see the command. */
  resize(cols: number, rows: number): Promise<void>;
  /** Bytes from the Session, live, from the moment this attachment opened. */
  onData(cb: (data: string) => void): Unsubscribe;
  /** The harness's process exited. The Session outlives it; this attachment does not. */
  onExit(cb: (exit: SessionAttachExit) => void): Unsubscribe;
  /** The link went away underneath. Not fired by {@link close}. */
  onDisconnected(cb: (info: { error?: string }) => void): Unsubscribe;
  /**
   * Give the write lock back (D7).
   *
   * `false` means there was nothing to give back — this attachment never held
   * one, or the link is already gone and the Core has released it. Never throws:
   * it is called from a teardown, and a detach that failed to release loudly
   * would still have detached.
   */
  release(): Promise<boolean>;
  /** Hang up. Idempotent, and never throws. */
  close(): void;
};

/** How `session attach` reaches a Session. Injected, so the command is testable. */
export type OpenSessionAttachFn = (
  blob: CoreRegistrationBlob,
  opts: {
    taskId: string;
    cols: number;
    rows: number;
    connectTimeoutMs: number;
    /** False for `--read-only`: attach as a Reader and send no `claim` at all. */
    claimWrite: boolean;
  },
) => Promise<SessionAttachment>;

/**
 * Attach to a running Session: connect, claim, subscribe, and hand back the
 * stream with the authority that claim settled.
 *
 * The order is the point. Authority first, because it decides what the operator
 * is told before a byte is painted; the stream second, with the Core holding it
 * until the scrollback has been served (`catchUp`), so nothing paints live bytes
 * in front of its own history. Every failure after the claim releases the lock
 * on the way out — a Session left locked by an attach that never opened is
 * exactly the stranding this ticket is about.
 */
export const openSessionAttach: OpenSessionAttachFn = async (blob, opts) => {
  const client = CoreClient.fromRegistrationBlob(blob, {
    connectTimeoutMs: opts.connectTimeoutMs,
    requestTimeoutMs: opts.connectTimeoutMs,
  });

  let claimed = false;
  try {
    await client.connect();
    const ptyId = await livePty(client, opts.taskId);

    // The claim, before anything is painted and before any input is wired. A
    // refusal is an answer — `granted: false` becomes a read-only attachment —
    // and `supported: false` is a third thing entirely: a Core with no lock
    // table, which writes.
    let authority: AttachAuthority = "not-claimed";
    if (opts.claimWrite) {
      const { supported, granted } = await client.claim(opts.taskId);
      claimed = supported && granted;
      authority = !supported ? "no-lock-table" : granted ? "held" : "held-by-another";
    }

    // `catchUp` says a `replay` follows and the Core must hold this PTY's live
    // stream until it has been served. A caller that sets it owes that replay,
    // and the two lines below are that debt paid — skipping it would leave the
    // Session's output held on the Core until this connection went away.
    await client.ptySubscribe(ptyId, { catchUp: true });
    const { data: backlog } = await client.replay(ptyId);

    return attachment(client, opts.taskId, ptyId, authority, backlog);
  } catch (err) {
    // A lock this connection took and is not going to use. The release goes
    // first: `close()` would release it too, by dropping the connection (D7),
    // but only once the Core noticed — and a Session that reads as locked to the
    // next operator for as long as a socket takes to time out is the failure
    // this ticket calls the one that strands a Session.
    if (claimed) await client.release(opts.taskId).catch(() => ({ released: false }));
    client.close();
    throw err;
  }
};

/**
 * The PTY running for this Session, or the reason there is none to attach to.
 *
 * Two different sentences, because they are two different mistakes: a Session
 * that finished half an hour ago is a `session logs` away from being useful, and
 * a Session id this Core has never heard of is a typo. The Task list is read
 * only when there is bad news to explain, so the ordinary attach still costs one
 * round trip.
 */
async function livePty(client: CoreClient, taskId: string): Promise<string> {
  const { ptyId } = await client.findByTask(taskId);
  if (ptyId !== null) return ptyId;

  const { tasks } = await client.tasksList();
  if (!tasks.some((task) => task.taskId === taskId)) {
    throw new SessionGatewayError("no-such-session", `this Core has no session ${taskId}`);
  }
  throw new SessionGatewayError(
    "not-running",
    `session ${taskId} has no harness running — there is no terminal to attach to`,
  );
}

/** Present a connected client as a {@link SessionAttachment}. */
function attachment(
  client: CoreClient,
  taskId: string,
  ptyId: string,
  authority: AttachAuthority,
  backlog: string,
): SessionAttachment {
  // Two facts, not one. **May this attachment write** is true for a Core with no
  // lock table as well as for the holder of a real lock; **does it hold a lock**
  // is true only for the second, and is what decides whether there is anything to
  // release. Collapsing them into one boolean makes a lock-less Core either
  // unwritable or the subject of a `release` frame it has no vocabulary for.
  let mayWrite = authorityWrites(authority);
  let holdsLock = authority === "held";

  // Live bytes, buffered from the moment the attachment exists rather than from
  // the moment the command gets round to listening. The Core released its hold
  // when the `replay` above was served, so output between that answer and the
  // command's first `onData` belongs to this attach and would otherwise be a
  // gap in the middle of a terminal nobody could explain.
  const pending: string[] = [];
  let sink: ((data: string) => void) | null = (data) => {
    pending.push(data);
  };
  const forThisPty = client.onData((frame) => {
    if (frame.ptyId === ptyId) sink?.(frame.data);
  });

  const forPty = <T extends { ptyId: string }>(cb: (frame: T) => void) => (frame: T) => {
    if (frame.ptyId === ptyId) cb(frame);
  };

  return {
    taskId,
    ptyId,
    authority,
    backlog,

    write: async (data) => {
      if (!mayWrite) {
        throw new SessionWriteRefused("this attachment does not hold this Session's write lock");
      }
      try {
        await client.write(ptyId, data);
      } catch (err) {
        // The Core's refusal, in the one vocabulary the command handles. It
        // arrives here only after a force takeover (D7): nothing else moves a
        // lock out from under a holder, and the previous holder learns of it on
        // its next mutation and no sooner.
        if (err instanceof CoreLinkRequestError && err.code === SESSION_LOCKED_ERROR_CODE) {
          mayWrite = false;
          holdsLock = false;
          throw new SessionWriteRefused("another Core client has taken this Session's write lock");
        }
        throw err;
      }
    },

    resize: (cols, rows) => client.resize(ptyId, cols, rows).then(() => undefined),

    onData: (cb) => {
      sink = cb;
      // Whatever arrived before the command was listening, in order, before
      // anything that arrives after it.
      for (const data of pending.splice(0)) cb(data);
      return () => {
        sink = null;
        forThisPty();
      };
    },

    onExit: (cb) =>
      client.onExit(forPty((frame) => cb({ exitCode: frame.exitCode, signal: frame.signal }))),

    onDisconnected: (cb) => client.onDisconnected(cb),

    release: async () => {
      // Nothing to give back, and — the case this ticket is really about —
      // nothing to give it back *to*: a link that has dropped has already had
      // its locks released by the Core (D7), so asking would be a request into a
      // socket that is gone.
      if (!holdsLock || !client.isConnected()) {
        holdsLock = false;
        mayWrite = false;
        return false;
      }
      holdsLock = false;
      mayWrite = false;
      try {
        const { released } = await client.release(taskId);
        return released;
      } catch {
        // The link went away while the frame was in flight, which released the
        // lock by the other route. A teardown must not fail on the way out.
        return false;
      }
    },

    close: () => {
      forThisPty();
      client.close();
    },
  };
}
