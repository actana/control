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
import { runActanaCli } from "../actana-cli.ts";
import { registryPaths, type RegistryPaths } from "../blob-registry.ts";
import type { CoreProbe, CoreProbeFn } from "../core-probe.ts";
import { nonInteractiveTerminal, type CliTerminal, type TerminalSignal } from "../cli-terminal.ts";
import { stubMachineHalf, type MachineHalf } from "./machine-fixture.ts";
import type { OpenCoreShellFn } from "../core-shell-channel.ts";
import { SessionWriteRefused } from "../session-attach-channel.ts";
import type {
  AttachAuthority,
  OpenSessionAttachFn,
  SessionAttachExit,
  SessionAttachment,
} from "../session-attach-channel.ts";
import type { CoreConnectFn, CoreConnectOptions, CoreLinkClient } from "../core-connection.ts";
import type { CorePairingPort } from "../core-pair.ts";
import { CorePairingError, type CorePairingFailure } from "@actana/sdk/core-pairing.ts";
import type { CoreRegistrationBlob } from "@actana/sdk/core-registration-blob.ts";
import type { OpenSessionGateway, SessionGateway, StartedSession } from "../session-gateway.ts";
import { projectFilesErrorFrom } from "../project-files-gateway.ts";
import type {
  OpenProjectFilesFn,
  ProjectFileTransfers,
  ProjectFilesGateway,
} from "../project-files-gateway.ts";
import type {
  CoreFileDownload,
  CoreFileEntry,
  CoreFileListOptions,
  CoreFileProgress,
  CoreFileSource,
} from "@actana/sdk/core-files.ts";
import type {
  CoreLinkDirListing,
  CoreLinkEvent,
  CoreLinkHarnessAvailabilityMap,
  CoreLinkProjectMutation,
  CoreLinkProjectSnapshot,
  CoreLinkRequestFrame,
  CoreLinkResponseFrame,
} from "@actana/sdk/core-link-frames.ts";

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
  /** What `core status` gets back, or a throw. */
  probe?: CoreProbeFn;
  /** What every other noun gets when it dials, or a throw. */
  connect?: CoreConnectFn;
  /** What `core pair` gets back from the SDK, or a throw. */
  pairing?: CorePairingPort;
  /** What the `session` noun's verbs get back, or a throw. */
  sessions?: OpenSessionGateway;
  /** What `project cp` and `project files` get back, or a throw. */
  files?: OpenProjectFilesFn;
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
};

/**
 * A Session that started, for a fake gateway to hand back.
 *
 * `wait` resolves with whatever the test says the Core reported — the CLI never
 * decides idleness, so a fake has to be the one holding the answer.
 */
export function fakeStartedSession(overrides: Partial<StartedSession> = {}): StartedSession {
  return {
    taskId: "task_1",
    ptyId: "pty_1",
    harness: "claude-code",
    command: "claude",
    // Claude Code is the one harness that reports a turn's start, so the
    // default fake is the quiet case — a test asking about the caveat has to
    // say `reportsTurnStart: false` and mean it.
    reportsTurnStart: true,
    projectId: "proj_1",
    project: "web",
    wait: async () => ({ status: "finished", exited: false }),
    screen: () => "the transcript",
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
 * `pair` hands back a credential or throws the `CorePairingError` the suite is
 * about. Both are recorded, because half of what this verb has to get right is
 * *not* reaching the second one.
 */
export function fakePairing(
  opts: {
    fingerprint?: string;
    identifyFails?: unknown;
    blob?: CoreRegistrationBlob;
    fails?: CorePairingFailure;
    failsWith?: unknown;
    detail?: ConstructorParameters<typeof CorePairingError>[2];
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
        throw new CorePairingError(opts.fails, `the fake Core answered ${opts.fails}`, opts.detail ?? {});
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
        openFiles:
          opts.files ??
          (async () => {
            throw new Error("this test did not expect to open a file gateway");
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
  /** Every project mutation, in order. */
  mutations: CoreLinkProjectMutation[];
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
  projects?: CoreLinkProjectSnapshot[];
  availability?: CoreLinkHarnessAvailabilityMap;
  listing?: CoreLinkDirListing;
  /** Answer `request` yourself — for `dirList` / `harnessInstall` shapes. */
  respond?: (frame: CoreLinkRequestFrame) => CoreLinkResponseFrame | Promise<CoreLinkResponseFrame>;
  /** Reject `projectsMutate` the way a Core rejecting a path does. */
  refuseMutation?: string;
  /** What `projectsMutate` answers when it is not refused. Default: echo the create. */
  mutationResult?: CoreLinkProjectSnapshot | null;
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
        taskId: null,
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
      if (frame.type === "dirList") {
        return {
          type: "dirListResult",
          reqId: "r",
          listing: opts.listing ?? emptyListing(),
        };
      }
      return { type: "error", reqId: "r", message: `fake Core has no answer for ${frame.type}` };
    },
    projectsList: async () => opts.projects ?? [],
    projectsMutate: async (mutation) => {
      state.mutations.push(mutation);
      if (opts.refuseMutation !== undefined) throw new Error(opts.refuseMutation);
      if (opts.mutationResult !== undefined) return opts.mutationResult;
      return mutation.op === "create" ? projectSnapshot(mutation.name, mutation.path) : null;
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

/** What a {@link fakeProjectFiles} was asked to transfer, and what it answered. */
export type FakeProjectFiles = {
  /** What `deps.openFiles` hands the verb under test. */
  open: OpenProjectFilesFn;
  /** Every Project name or id a verb asked to resolve, in order. */
  resolved: string[];
  /** Every listing, with the options it carried. */
  lists: CoreFileListOptions[];
  /**
   * Every upload, **with its body drained to a buffer**.
   *
   * Draining rather than counting is what makes the round-trip suites possible:
   * a `cp ./dir project:path` produces a real tar here, and a test can unpack it
   * with `local-tar.ts` and assert on the modes that came out. The Core is
   * faked; the archive is not.
   */
  uploads: Array<{
    path: string;
    kind: "file" | "tar";
    mode: number | null;
    mtime: number | null;
    contentLength: number | null;
    body: Buffer;
  }>;
  /** Every download, by the path it asked for. */
  downloads: string[];
  /** True once the verb hung up. A gateway left open is a defect worth failing on. */
  closed: boolean;
};

export type FakeProjectFilesOptions = {
  /** The Project every resolution answers with. */
  project?: { projectId: string; name: string; path: string };
  /** What `list` streams. */
  entries?: CoreFileEntry[];
  /** Refuse to resolve the Project — a bad name, or a Core that has none. */
  refuseProject?: Error;
  /**
   * What an upload reports back, given what it was handed.
   *
   * The default reports nothing, because the *Core* is what decides whether an
   * entry was an overwrite and a fake that guessed would be asserting on its own
   * opinion. A suite about F5 supplies the `overwritten` lines it means to test.
   */
  progressFor?: (upload: FakeProjectFiles["uploads"][number]) => CoreFileProgress[];
  /** Throw instead of streaming progress — the F8 conflict, a refusal, a stream error. */
  uploadFails?: Error;
  /**
   * Stream the progress `progressFor` supplies, **then** throw.
   *
   * The part-way failure the Core models with `CoreFileStreamError`: entries
   * really landed, and then the transfer died. Distinct from `uploadFails`,
   * which dies before anything crosses — the difference is the whole point of
   * the test, because what is at stake is what the CLI does with the entries it
   * already knows about.
   */
  uploadFailsAfterProgress?: Error;
  /** What a download answers with, given the path. */
  downloadWith?: (path: string) => CoreFileDownload;
  /** Throw instead of answering a download. */
  downloadFails?: Error;
  /** Throw instead of streaming a listing. */
  listFails?: Error;
};

/**
 * A Project's file surface that never opens a socket.
 *
 * The counterpart to {@link fakeCore} for the two verbs that do not use the
 * core link for their bytes. What the `cp` and `files` suites are about — the
 * direction parse, the progress rule, the overwrite naming, the `--json` shapes,
 * the exit codes — is none of it a fact about HTTPS, and
 * `project-files-live.test.ts` is where a real Core answers instead.
 */
export function fakeProjectFiles(opts: FakeProjectFilesOptions = {}): FakeProjectFiles {
  const project = opts.project ?? { projectId: "p-api", name: "api", path: "/srv/api" };
  const state: FakeProjectFiles = {
    open: async () => gateway,
    resolved: [],
    lists: [],
    uploads: [],
    downloads: [],
    closed: false,
  };

  const transfers: ProjectFileTransfers = {
    projectId: project.projectId,
    name: project.name,
    path: project.path,
    list: (listOpts = {}) => {
      state.lists.push(listOpts);
      return {
        async *[Symbol.asyncIterator]() {
          if (opts.listFails) throw projectFilesErrorFrom(opts.listFails);
          for (const entry of opts.entries ?? []) yield entry;
        },
      };
    },
    upload: (uploadOpts) => ({
      async *[Symbol.asyncIterator]() {
        // Drained first and always, exactly as a real transfer does: a body the
        // caller never read is a file handle nobody closed, and a `cp` whose
        // upload was abandoned half-way is a different test.
        const upload = {
          path: uploadOpts.path,
          kind: uploadOpts.kind ?? ("file" as const),
          mode: uploadOpts.mode ?? null,
          mtime: uploadOpts.mtime ?? null,
          contentLength: uploadOpts.contentLength ?? null,
          body: await drain(uploadOpts.body),
        };
        state.uploads.push(upload);
        if (opts.uploadFails) throw projectFilesErrorFrom(opts.uploadFails);
        for (const line of opts.progressFor?.(upload) ?? []) yield line;
        if (opts.uploadFailsAfterProgress) throw projectFilesErrorFrom(opts.uploadFailsAfterProgress);
      },
    }),
    download: async (downloadOpts) => {
      state.downloads.push(downloadOpts.path);
      if (opts.downloadFails) throw projectFilesErrorFrom(opts.downloadFails);
      if (!opts.downloadWith) throw new Error("this test did not say what a download answers with");
      return opts.downloadWith(downloadOpts.path);
    },
  };

  const gateway: ProjectFilesGateway = {
    project: async (wanted) => {
      state.resolved.push(wanted);
      if (opts.refuseProject) throw projectFilesErrorFrom(opts.refuseProject);
      return transfers;
    },
    close: () => {
      state.closed = true;
    },
  };

  return state;
}

/** A `CoreFileSource` as one buffer — both shapes the SDK accepts. */
async function drain(body: CoreFileSource): Promise<Buffer> {
  const chunks: Buffer[] = [];
  if (typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value) chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks);
  }
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Bytes as the `ReadableStream` a download hands back. */
export function streamOf(bytes: Uint8Array | AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  if (bytes instanceof Uint8Array) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
  const iterator = bytes[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
  });
}

/** A project row with the columns a CLI renders and defaults for the rest. */
export function projectSnapshot(
  name: string,
  projectPath: string,
  overrides: Partial<CoreLinkProjectSnapshot> = {},
): CoreLinkProjectSnapshot {
  return {
    projectId: `p-${name}`,
    name,
    path: projectPath,
    icon: "PR",
    iconColor: "#7ce58a",
    pinned: false,
    rememberHarnessSettings: false,
    savedHarness: null,
    savedSkipPermissions: false,
    savedBareSession: false,
    defaultGridView: false,
    updatedAt: Date.UTC(2026, 7, 12),
    ...overrides,
  };
}

function emptyListing(): CoreLinkDirListing {
  return { path: "/", parent: null, home: "/root", roots: [], entries: [], truncated: false };
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

/**
 * A terminal that behaves like one, without being one.
 *
 * What `core shell` must be tested against: raw mode is recorded rather than
 * performed, keystrokes and resizes and signals are things a test *does*, and
 * the promise says when the command has finished wiring itself up — which is
 * the only moment from which sending it a `SIGINT` proves anything.
 */
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
  opts: { authority?: AttachAuthority; backlog?: string; taskId?: string } = {},
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
    taskId: opts.taskId ?? "task_1",
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
