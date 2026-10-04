// A CLI run, in memory.
//
// `runActanaCli` takes every side effect as a dependency, so a test is a bag of
// fakes and an exit code — no subprocess, no build, no Core. What it does need
// is a real filesystem, because the blob registry's whole subject is one: file
// modes, a directory that may not exist, and `XDG_CONFIG_HOME` are not things a
// stub filesystem would test.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClientDeps } from "@actana/cli";
import { runActanaCli } from "../actana-cli.ts";
import {
  readCurrentCore,
  registryPaths,
  writeCoreBlob,
  writeCurrentCore,
  type RegistryPaths,
} from "../blob-registry.ts";
import type { CoreProbe, CoreProbeFn } from "@actana/cli";
import { nonInteractiveTerminal, type CliTerminal } from "@actana/cli";

/** The signals a terminal reports, read off the published `CliTerminal` rather than a copy of its module. */
type TerminalSignal = Parameters<CliTerminal["onSignal"]>[0];
import { stubMachineHalf, type MachineHalf } from "./machine-fixture.ts";
import type { OpenCoreShellFn } from "@actana/cli";
import { SessionWriteRefused } from "@actana/cli";
import type {
  AttachAuthority,
  OpenSessionAttachFn,
  SessionAttachExit,
  SessionAttachment,
} from "@actana/cli";
import type { CoreConnectFn, CoreConnectOptions, CoreLinkClient } from "@actana/cli";
import type { CorePairingPort } from "@actana/cli";
import { PairingError, type PairingFailure } from "@actana/sdk/pairing";
import type { CoreRegistrationBlob } from "@actana/sdk/pairing";
import type { OpenSessionGateway, SessionGateway, StartedSession } from "@actana/cli";
import type {
  CoreLinkEvent,
  CoreLinkHarnessAvailabilityMap,
  CoreLinkRequestFrame,
  CoreLinkResponseFrame,
} from "@actana/sdk/core";

/** One run's captured output, plus the exit code. */
export type CliRun = {
  code: number;
  /** stdout, one entry per line. */
  out: string[];
  /** stderr, one entry per line — errors and `--verbose` alike. */
  err: string[];
  /** Everything either stream saw, joined. What the "never logs a blob" sweep reads. */
  all: string;
};

export type CliFixture = {
  /** `XDG_CONFIG_HOME`, a fresh temporary directory per fixture. */
  configHome: string;
  /** A home directory that is deliberately *not* where the registry lands. */
  home: string;
  paths: RegistryPaths;
  /** Run `actana` with these arguments. */
  run: (argv: string[], opts?: RunOptions) => Promise<CliRun>;
  cleanup: () => void;
};

export type RunOptions = {
  /** Extra environment on top of `XDG_CONFIG_HOME`. */
  env?: NodeJS.ProcessEnv;
  /** What `readStdin` resolves to. Setting it also makes stdin not a TTY. */
  stdin?: string;
  /** Force the TTY answer. Defaults to false when `stdin` is set, true otherwise. */
  stdinIsTty?: boolean;
  /**
   * Whether stdout is a terminal. Defaults to **false** — a run captured into
   * an array is a piped run, and the commands that render differently at a
   * terminal must render their scrapeable shape here unless a suite says
   * otherwise.
   */
  stdoutIsTty?: boolean;
  /** What `core status` gets back, or a throw. */
  probe?: CoreProbeFn;
  /** What every other noun gets when it dials, or a throw. */
  connect?: CoreConnectFn;
  /** What `core pair` gets back from the SDK, or a throw. */
  pairing?: CorePairingPort;
  /** What the `session` noun's verbs get back, or a throw. */
  sessions?: OpenSessionGateway;
  /** Overrides for the machine half — a suite about a client noun rarely needs one. */
  machine?: Partial<MachineHalf>;
  /**
   * Called with each stdout line as it is written, rather than at the end.
   *
   * For the one command that does not finish on its own: `events tail` follows
   * until a `--limit` is reached, and a suite driving a Core through a restart
   * underneath it has to know what has already been printed before it drops the
   * connection. Every other suite reads {@link CliRun.out} afterwards.
   */
  onOut?: (line: string) => void;
  /**
   * Called with each stderr line as it is written, `--verbose` included.
   *
   * The other half of {@link onOut}, and for the same reason: `events tail`
   * runs until something makes it stop, and the notice that it has found the
   * end of the Core's log is on stderr. A suite that has to append an event
   * *after* that moment — and not before, or the event is history and is
   * suppressed — has no other way to know it has arrived.
   */
  onErr?: (line: string) => void;
  now?: number;
  /**
   * The terminal `core shell` is handed. Defaults to one that is not a TTY, so
   * every other verb's test runs against the same terminal a pipe would give it.
   */
  terminal?: CliTerminal;
  /** What `core shell` gets back, or a throw. */
  openShell?: OpenCoreShellFn;
  /** What `session attach` gets back, or a throw. */
  openAttach?: OpenSessionAttachFn;
  /** What `files` gets back, or a throw. */
  openFiles?: ClientDeps["openFiles"];
  /** What `shared` and `session start --shared` get back, or a throw. */
  openShared?: ClientDeps["openShared"];
};

/**
 * A Session that started, for a fake gateway to hand back.
 *
 * `wait` resolves with whatever the test says the Core reported — the CLI never
 * decides idleness, so a fake has to be the one holding the answer.
 */
export function fakeStartedSession(overrides: Partial<StartedSession> = {}): StartedSession {
  return {
    sessionId: "session_1",
    ptyId: "pty_1",
    harness: "claude-code",
    command: "claude",
    // Claude Code is the one harness that reports a turn's start, so the
    // default fake is the quiet case — a test asking about the caveat has to
    // say `reportsTurnStart: false` and mean it.
    reportsTurnStart: true,
    wait: async () => ({ status: "finished", exited: false }),
    screen: () => "the transcript",
    // The default is a prompt that landed. A test about #483's outcome says
    // `promptAbandoned: () => ({ reason: "…" })` and means it.
    promptAbandoned: () => null,
    // The same answer without waiting, for `--wait`'s non-blocking read. The
    // default is a Core that has said `delivered`; a test about the harness
    // exiting before it said anything returns `null` and means it (#495 gate
    // review, addendum blocker 6).
    promptDeliveryReport: () => ({ outcome: "delivered" }),
    // And the default start is one whose prompt the Core reported delivered. A
    // test about #395's wait says otherwise and means it.
    awaitPromptDelivery: async () => ({ outcome: "delivered" }),
    dispose: () => {},
    ...overrides,
  };
}

/**
 * A gateway that answers without a Core.
 *
 * Every verb throws by default and a test overrides the one it is about: a
 * suite that reaches a verb it did not mean to exercise should fail loudly
 * rather than pass against a stub that said yes.
 */
export function fakeSessionGateway(overrides: Partial<SessionGateway> = {}): OpenSessionGateway {
  const refuse = (verb: string) => async () => {
    throw new Error(`this test did not expect session ${verb}`);
  };
  return async () => ({
    list: refuse("ls"),
    start: refuse("start"),
    resume: refuse("resume"),
    logs: refuse("logs"),
    send: refuse("send"),
    wait: refuse("wait"),
    sendAndWait: refuse("send --wait"),
    kill: refuse("kill"),
    close: () => {},
    ...overrides,
  });
}

/** What a {@link fakePairing} was asked, and what it answered. */
export type FakePairing = CorePairingPort & {
  /** Every `identify`, by the address it was given. */
  identified: string[];
  /**
   * Every `pair`, with the options it carried — **including the code**.
   *
   * Recorded so a suite can assert what crossed the seam: that the code handed
   * to the SDK is the normalised one, that the fingerprint is the confirmed
   * one, and that a refusal happened without `pair` ever being reached.
   */
  paired: Array<Parameters<CorePairingPort["pair"]>[0]>;
};

/**
 * The SDK's pairing surface, without a Core.
 *
 * `identify` answers with the fingerprint the test says the Core presents;
 * `pair` hands back a credential or throws the `PairingError` the suite is
 * about. Both are recorded, because half of what this verb has to get right is
 * *not* reaching the second one.
 */
export function fakePairing(
  opts: {
    fingerprint?: string;
    identifyFails?: unknown;
    blob?: CoreRegistrationBlob;
    fails?: PairingFailure;
    failsWith?: unknown;
    detail?: ConstructorParameters<typeof PairingError>[2];
  } = {},
): FakePairing {
  const fingerprint = opts.fingerprint ?? PAIRED_FINGERPRINT;
  const state: FakePairing = {
    identified: [],
    paired: [],
    identify: async ({ address }) => {
      state.identified.push(address);
      if (opts.identifyFails) throw opts.identifyFails;
      return {
        fingerprint,
        caCert: SENTINEL_CA,
        host: address.split(":")[0] ?? address,
        port: 8443,
        httpsOrigin: `https://${address}`,
      };
    },
    pair: async (pairOpts) => {
      state.paired.push(pairOpts);
      if (opts.failsWith) throw opts.failsWith;
      if (opts.fails) {
        throw new PairingError(opts.fails, `the fake Core answered ${opts.fails}`, opts.detail ?? {});
      }
      // **The label is echoed, because `pairWithCore` echoes it.** The real
      // function copies `opts.label` straight into the blob it returns — the
      // one field where what the caller passed in comes back out — and a fake
      // that answered with a fixed blob instead would make every assertion
      // about what is *stored* vacuous, which is exactly how a client hostname
      // reached the column that means the Core's own alias.
      const issued = opts.blob ?? sentinelPairedBlob();
      return { ...issued, ...(pairOpts.label === undefined ? {} : { label: pairOpts.label }) };
    },
  };
  return state;
}

/** The fingerprint {@link fakePairing} presents unless a test says otherwise. */
export const PAIRED_FINGERPRINT =
  "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";

/**
 * The credential a successful pair hands back: the same sentinels every other
 * suite sweeps for, so `never-logs-a-blob.test.ts` covers this path too.
 */
export function sentinelPairedBlob(endpoint = "wss://core.test:8443"): CoreRegistrationBlob {
  return {
    endpoint,
    caCert: SENTINEL_CA,
    clientCert: SENTINEL_CERT,
    clientKey: SENTINEL_KEY,
    bearer: SENTINEL_BEARER,
  };
}

/** A probe that answers like a healthy Core on the current protocol. */
export function healthyProbe(overrides: Partial<CoreProbe> = {}): CoreProbeFn {
  return async () => ({
    coreId: "core_test",
    protocolVersion: "1.0.0",
    compatible: true,
    multiConnection: true,
    bearerExpiresAt: Date.UTC(2030, 0, 1),
    ...overrides,
  });
}

export function makeCliFixture(): CliFixture {
  const root = mkdtempSync(path.join(tmpdir(), "actana-cli-"));
  const configHome = path.join(root, "xdg");
  const home = path.join(root, "home");
  const paths = registryPaths({ XDG_CONFIG_HOME: configHome }, home);

  return {
    configHome,
    home,
    paths,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    run: async (argv, opts = {}) => {
      const out: string[] = [];
      const err: string[] = [];
      const verboseOn = argv.includes("--verbose");
      const code = await runActanaCli({
        argv,
        env: { XDG_CONFIG_HOME: configHome, ...opts.env },
        home,
        out: (line) => {
          out.push(line);
          opts.onOut?.(line);
        },
        err: (line) => {
          err.push(line);
          opts.onErr?.(line);
        },
        // The byte sinks land in the same two arrays as the line sinks, so
        // `all` still sees every byte either stream emitted and the "never logs
        // a blob" sweep keeps covering the one verb that writes raw.
        outBytes: (chunk) => {
          out.push(chunk);
          opts.onOut?.(chunk);
        },
        errBytes: (chunk) => {
          err.push(chunk);
          opts.onErr?.(chunk);
        },
        verbose: verboseOn
          ? (line) => {
              err.push(`actana: ${line}`);
              opts.onErr?.(`actana: ${line}`);
            }
          : () => {},
        readStdin: async () => opts.stdin ?? "",
        stdinIsTty: opts.stdinIsTty ?? opts.stdin === undefined,
        stdoutIsTty: opts.stdoutIsTty ?? false,
        probe:
          opts.probe ??
          (async () => {
            throw new Error("this test did not expect to dial a Core");
          }),
        connect:
          opts.connect ??
          (async () => {
            throw new Error("this test did not expect to dial a Core");
          }),
        pairing:
          opts.pairing ?? {
            identify: async () => {
              throw new Error("this test did not expect to identify a Core");
            },
            pair: async () => {
              throw new Error("this test did not expect to pair with a Core");
            },
          },
        openSessions:
          opts.sessions ??
          (async () => {
            throw new Error("this test did not expect to open a session gateway");
          }),
        now: () => opts.now ?? Date.UTC(2026, 7, 12),
        // Terminal bytes are swept for credentials alongside the line sinks, so
        // a `core shell` that ever echoed a blob back would fail the same test
        // every other verb does.
        terminal: opts.terminal ?? nonInteractiveTerminal((data) => out.push(data)),
        openShell:
          opts.openShell ??
          (async () => {
            throw new Error("this test did not expect to open a shell");
          }),
        openAttach:
          opts.openAttach ??
          (async () => {
            throw new Error("this test did not expect to attach to a session");
          }),
        openFiles:
          opts.openFiles ??
          (async () => {
            throw new Error("this test did not expect to open a home folder");
          }),
        openShared:
          opts.openShared ??
          (async () => {
            throw new Error("this test did not expect to open a Shared folder");
          }),
        // `actana` is one program, so its deps bag has one shape (#288). A
        // suite about the client nouns still has to fill the machine half; it
        // gets fakes that refuse, so a noun that somehow reached `systemctl`
        // or the release channel fails here rather than passing quietly.
        ...stubMachineHalf(opts.machine),
      });
      return { code, out, err, all: [...out, ...err].join("\n") };
    },
  };
}

/** What a {@link fakeCore} was asked, and the levers a test pulls on it. */
export type FakeCore = {
  /** What `deps.connect` hands the command under test. */
  connect: CoreConnectFn;
  /** Every frame that went through `request`, in order. */
  requests: CoreLinkRequestFrame[];
  mutations: unknown[];
  /** The cursor each `subscribe` carried. */
  subscribes: number[];
  /** True once the command hung up — a link left open is a defect worth failing on. */
  closed: boolean;
  /** The options each `connect` was asked for — durability, cursor storage. */
  connectOptions: CoreConnectOptions[];
  /** Deliver one event, as the Core's live push would. */
  emitEvent: (event: Partial<CoreLinkEvent> & Pick<CoreLinkEvent, "eventId" | "kind">) => void;
  /** Close a replay tail, as `eventsReplayed` does. */
  emitReplayed: (lastEventId: number) => void;
  /** Report the link as lost, as a dropped socket does. */
  emitDisconnected: (error?: string) => void;
};

export type FakeCoreOptions = {
  availability?: CoreLinkHarnessAvailabilityMap;
  /** Answer `request` yourself — for `harnessInstall` shapes. */
  respond?: (frame: CoreLinkRequestFrame) => CoreLinkResponseFrame | Promise<CoreLinkResponseFrame>;
};

/**
 * A Core client that never opens a socket.
 *
 * The three nouns' surfaces — flags, columns, `--json` shapes, exit codes — are
 * what these suites are about, and none of them is a fact about a WebSocket.
 * `CoreLinkClient` is structural and eight members wide precisely so this can
 * exist; `live-core.test.ts` and the in-process Core cover the wire.
 */
export function fakeCore(opts: FakeCoreOptions = {}): FakeCore {
  const eventListeners = new Set<(msg: { event: CoreLinkEvent }) => void>();
  const replayedListeners = new Set<(msg: { lastEventId: number }) => void>();
  const downListeners = new Set<(msg: { error?: string }) => void>();
  const state: FakeCore = {
    connect: async (_blob, connectOpts = {}) => {
      state.connectOptions.push(connectOpts);
      return client;
    },
    requests: [],
    mutations: [],
    subscribes: [],
    connectOptions: [],
    closed: false,
    emitEvent: (event) => {
      const full: CoreLinkEvent = {
        ts: Date.UTC(2026, 7, 12),
        ptyId: null,
        sessionId: null,
        payload: "{}",
        ...event,
      };
      for (const cb of [...eventListeners]) cb({ event: full });
    },
    emitReplayed: (lastEventId) => {
      for (const cb of [...replayedListeners]) cb({ lastEventId });
    },
    emitDisconnected: (error) => {
      for (const cb of [...downListeners]) cb(error === undefined ? {} : { error });
    },
  };

  const client: CoreLinkClient = {
    request: async (frame) => {
      state.requests.push(frame);
      if (opts.respond) return opts.respond(frame);
      return { type: "error", reqId: "r", message: `fake Core has no answer for ${frame.type}` };
    },
    agentsAvailabilityList: async () => opts.availability ?? {},
    onEvent: (cb) => {
      eventListeners.add(cb);
      return () => eventListeners.delete(cb);
    },
    onEventsReplayed: (cb) => {
      replayedListeners.add(cb);
      return () => replayedListeners.delete(cb);
    },
    onDisconnected: (cb) => {
      downListeners.add(cb);
      return () => downListeners.delete(cb);
    },
    onReady: () => () => {},
    subscribeEvents: (lastEventId = 0) => {
      state.subscribes.push(lastEventId);
      return true;
    },
    close: () => {
      state.closed = true;
    },
  };

  return state;
}

/**
 * A registration blob whose every secret field is a sentinel.
 *
 * The strings are unmistakable in a haystack and share no substring with
 * anything the CLI legitimately prints, which is what lets
 * `never-logs-a-blob.test.ts` assert absence rather than assert a format.
 */
export const SENTINEL_CA = "-----BEGIN CERTIFICATE-----CA-SENTINEL-QQQ-----END CERTIFICATE-----";
export const SENTINEL_CERT = "-----BEGIN CERTIFICATE-----CLIENT-SENTINEL-ZZZ-----END CERTIFICATE-----";
export const SENTINEL_KEY = "-----BEGIN PRIVATE KEY-----KEY-SENTINEL-WWW-----END PRIVATE KEY-----";
export const SENTINEL_BEARER = "bearer-SENTINEL-YYY.signature-SENTINEL-XXX";

/** Every secret the sentinel blob carries, for an absence sweep. */
export const SENTINELS = [SENTINEL_CA, SENTINEL_CERT, SENTINEL_KEY, SENTINEL_BEARER];

export type FakeTerminal = CliTerminal & {
  /** Every `setRawMode` call, in order. `[true, false]` is a session done right. */
  rawModeCalls: boolean[];
  /** Whether the terminal is in raw mode *now*. False after a restore. */
  isRaw: () => boolean;
  /** Everything written to it, joined — the remote shell's bytes. */
  painted: () => string;
  /** Type at it. */
  type: (data: string) => void;
  /** Resize it, then fire the resize listeners. */
  resizeTo: (cols: number, rows: number) => void;
  /** Deliver a signal. */
  raise: (signal: TerminalSignal) => void;
  /** Resolves once the command has registered its signal handlers. */
  wired: Promise<void>;
  /** Make the next `setRawMode` throw — a terminal that refuses. */
  breakRawMode: (err: Error) => void;
};

export function fakeTerminal(opts: { isTty?: boolean; cols?: number; rows?: number } = {}): FakeTerminal {
  const rawModeCalls: boolean[] = [];
  const written: string[] = [];
  const input = new Set<(data: string) => void>();
  const resized = new Set<() => void>();
  const signalled = new Map<TerminalSignal, Set<() => void>>();
  let size = { cols: opts.cols ?? 80, rows: opts.rows ?? 24 };
  let rawModeError: Error | null = null;

  // The last thing `core shell` wires is its two signal handlers, so a test
  // that awaits this is guaranteed the whole session is live — not sleeping and
  // hoping, which is how this kind of test goes flaky.
  let announceWired = () => {};
  const wired = new Promise<void>((resolve) => {
    announceWired = resolve;
  });

  return {
    isTty: opts.isTty ?? true,
    rawModeCalls,
    wired,
    isRaw: () => rawModeCalls.at(-1) === true,
    painted: () => written.join(""),
    breakRawMode: (err) => {
      rawModeError = err;
    },
    size: () => ({ ...size }),
    setRawMode: (raw) => {
      if (rawModeError) throw rawModeError;
      rawModeCalls.push(raw);
    },
    onInput: (cb) => {
      input.add(cb);
      return () => input.delete(cb);
    },
    onResize: (cb) => {
      resized.add(cb);
      return () => resized.delete(cb);
    },
    onSignal: (signal, cb) => {
      const set = signalled.get(signal) ?? new Set();
      set.add(cb);
      signalled.set(signal, set);
      if (signalled.size === 2) announceWired();
      return () => set.delete(cb);
    },
    write: (data) => {
      written.push(data);
    },
    type: (data) => {
      for (const cb of [...input]) cb(data);
    },
    resizeTo: (cols, rows) => {
      size = { cols, rows };
      for (const cb of [...resized]) cb();
    },
    raise: (signal) => {
      for (const cb of [...(signalled.get(signal) ?? [])]) cb();
    },
  };
}

/**
 * An attached Session, under the test's control.
 *
 * The counterpart to {@link fakeTerminal} for `session attach`: the lock is a
 * value the test sets rather than a race it has to stage, and every ending —
 * the harness exiting, the link dropping, a write refused because the lock
 * moved — is a method. `session-attach-live.test.ts` is where those same
 * endings are produced by a real Core instead.
 */
export type FakeAttachment = SessionAttachment & {
  /** Everything the CLI forwarded, joined — keystrokes, in order. */
  typed: () => string;
  resizes: Array<{ cols: number; rows: number }>;
  /** How many times the lock was handed back. Never more than once. */
  releaseCount: () => number;
  closeCount: () => number;
  /** The harness prints. */
  emit: (data: string) => void;
  /** The harness's process exits. */
  exit: (exit: SessionAttachExit) => void;
  /** The link goes away underneath. */
  drop: (error?: string) => void;
  /** Somebody force-took the lock: every write from here is refused (ADR 0024 D7). */
  takeLock: () => void;
  /** Make every write fail for a reason that is *not* the lock. */
  breakWrites: (err: Error) => void;
};

export function fakeAttachment(
  opts: { authority?: AttachAuthority; backlog?: string; sessionId?: string } = {},
): FakeAttachment {
  const authority = opts.authority ?? "held";
  const sent: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const data = new Set<(d: string) => void>();
  const exits = new Set<(e: SessionAttachExit) => void>();
  const drops = new Set<(i: { error?: string }) => void>();
  let releases = 0;
  let closes = 0;
  let held = authority === "held";
  let taken = false;
  let writeError: Error | null = null;

  return {
    sessionId: opts.sessionId ?? "session_1",
    ptyId: "pty_1",
    authority,
    backlog: opts.backlog ?? "",
    typed: () => sent.join(""),
    resizes,
    releaseCount: () => releases,
    closeCount: () => closes,
    takeLock: () => {
      taken = true;
      held = false;
    },
    breakWrites: (err) => {
      writeError = err;
    },
    write: async (d) => {
      // The real channel refuses before the wire when it holds no authority and
      // after the Core's refusal when the lock moved. One error for both, so a
      // test that drives either path drives the command's one handler.
      if (taken) throw new SessionWriteRefused("another Core client has taken this Session's write lock");
      if (authority === "held-by-another" || authority === "not-claimed") {
        throw new SessionWriteRefused("this attachment does not hold this Session's write lock");
      }
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
    release: async () => {
      releases += 1;
      const wasHeld = held;
      held = false;
      return wasHeld;
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
      for (const cb of [...drops]) cb(error === undefined ? {} : { error });
    },
  };
}

/**
 * Put a Core in a fixture's registry, the way a pairing leaves one.
 *
 * `actana core pair` writes the credential it was issued into
 * `cores/<name>.txt` and points `current` at the first Core a machine learns
 * about. This is those two writes with no Core to dial, and it is how every
 * suite below arranges a registry now that #287 has removed `actana core add` —
 * a test that still pasted a blob would be exercising a door the product does
 * not have.
 */
export function registerCore(
  paths: RegistryPaths,
  name: string,
  blobText: string = sentinelBlobText(),
): void {
  writeCoreBlob(paths, name, blobText);
  if (readCurrentCore(paths) === null) writeCurrentCore(paths, name);
}

/** A base64 blob with the sentinel credentials in it. */
export function sentinelBlobText(endpoint = "wss://core.test:9444", label = "the-test-core"): string {
  return Buffer.from(
    JSON.stringify({
      endpoint,
      label,
      caCert: SENTINEL_CA,
      clientCert: SENTINEL_CERT,
      clientKey: SENTINEL_KEY,
      bearer: SENTINEL_BEARER,
    }),
    "utf8",
  ).toString("base64");
}
