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
import type { CoreConnectFn, CoreConnectOptions, CoreLinkClient } from "../core-connection.ts";
import type { OpenSessionGateway, SessionGateway, StartedSession } from "../session-gateway.ts";
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
  /** What the `session` noun's verbs get back, or a throw. */
  sessions?: OpenSessionGateway;
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
        openSessions:
          opts.sessions ??
          (async () => {
            throw new Error("this test did not expect to open a session gateway");
          }),
        now: () => opts.now ?? Date.UTC(2026, 7, 12),
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
