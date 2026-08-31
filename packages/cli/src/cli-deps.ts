// What the CLI needs from the world, as one injected bag.
//
// One bag for one program (#288): the client half's streams, terminal and Core
// dial sit beside the machine half's system port, release fetcher and daemon
// loader, because `actana` is a single command whose dispatch reaches both.
// `runActanaCli` takes every side effect as a dependency and returns an exit
// code instead of calling `process.exit`, so dispatch, flag validation, output
// and exit codes are all exercised by unit tests rather than by a subprocess.
// `actana-cli-entry.ts` is the only file that knows about `process`.
//
// The two halves are marked below rather than split into two types. A verb
// belongs to one of them and reads only its own fields — but the *program* has
// one entry point and one help text, and a deps type that came in two pieces
// would be the old split rebuilt one layer down.

import type { CoreProbeFn } from "./core-probe.ts";
import type { CliTerminal } from "./cli-terminal.ts";
import type { OpenCoreShellFn } from "./core-shell-channel.ts";
import type { CoreConnectFn } from "./core-connection.ts";
import type { CorePairingPort } from "./core-pair.ts";
import type { OpenSessionGateway } from "./session-gateway.ts";
import type { OpenProjectFilesFn } from "./project-files-gateway.ts";
import type { OpenSessionAttachFn } from "./session-attach-channel.ts";
import type { ActanaSystem } from "./actana-system.ts";
import type { ReleaseFetcher } from "./actana-release.ts";
import type { CoreLinkHarnessAvailabilityMap } from "@actana/sdk/core-link-frames.ts";

export type ActanaCliDeps = {
  // ─── both halves ──────────────────────────────────────────────────────────

  /** `process.argv.slice(2)`. */
  argv: string[];
  env: NodeJS.ProcessEnv;
  home: string;
  /** Where ordinary output goes. One call per line; the line has no newline on it. */
  out: (line: string) => void;
  /** Where errors and diagnostics go. */
  err: (line: string) => void;
  /**
   * The same two streams, as bytes: written exactly as given, with nothing
   * appended.
   *
   * A second pair rather than a widening of {@link out} and {@link err},
   * because almost every verb of this CLI emits *lines* — a line sink is the
   * shape that keeps them from each having to remember a trailing newline, and
   * it is the shape the `--json` document is written through. One verb is
   * different: `actana core exec` relays a remote command's own streams, and
   * its whole argument is that the bytes come back exactly as the command
   * wrote them. A line sink cannot say that. `printf hello` produced no
   * newline, and a relay that adds one has reported a byte the command did not
   * emit.
   *
   * Both halves land in the same place the line sinks do, so the "never logs a
   * blob" sweep reads them too.
   */
  outBytes: (chunk: string) => void;
  errBytes: (chunk: string) => void;
  /**
   * Where `--verbose` goes, when it is on.
   *
   * A separate sink rather than a boolean on {@link out} because verbose output
   * is a diagnostic — it belongs on stderr, where it cannot corrupt the stdout
   * a `--json` consumer is parsing. **Nothing that reaches here has ever held a
   * credential**: see the module header of `actana-cli.ts`.
   */
  verbose: (line: string) => void;
  /** Read stdin to end. Only called when a verb was actually told to read it. */
  readStdin: () => Promise<string>;
  /**
   * Whether stdin is a terminal. A verb that reads a piped payload with no
   * pipe would otherwise sit waiting for a paste with no prompt, which reads as
   * a hang.
   */
  stdinIsTty: boolean;
  /**
   * Whether **stdout** is a terminal — the whole of the switch between the two
   * shapes `actana pair new` prints (#357).
   *
   * Its own field rather than {@link interactive}, which is the *pair* of them
   * and answers a different question: whether there is somewhere to prompt.
   * `actana pair new > code.txt` at a terminal has an interactive stdin and a
   * redirected stdout, and it is the second half that decides whether what
   * lands in that file is the scrapeable labelled lines or a box drawing.
   *
   * A cosmetic frame is only ever built off this. Nothing about *what* the CLI
   * does may read it — a command that behaved differently down a pipe than it
   * does at a terminal is a command no script can trust.
   */
  stdoutIsTty: boolean;
  // ─── the client half: Cores this machine can reach ────────────────────────

  /** How `core status` reaches a Core. See `core-probe.ts`. */
  probe: CoreProbeFn;
  /**
   * How every other noun reaches a Core: dial, and hand back a connected
   * client. See `core-connection.ts`.
   *
   * Separate from {@link probe} rather than replacing it. `core status` asks one
   * question of the handshake and sends no request frames at all, and a verb
   * that reports whether a Core is reachable should not be built on a helper
   * that refuses to hand it a client when the Core is on another train.
   */
  connect: CoreConnectFn;
  /**
   * How `core pair` reaches a Core it has **no credential for yet** (#285).
   *
   * Its own port rather than a verb on {@link connect}, because it is the one
   * client call made before there is anything to authenticate with: the dial is
   * unverified by construction, what pins it is a fingerprint a human read out
   * loud, and what comes back is the credential every other field here already
   * assumes exists. See `core-pair.ts`.
   */
  pairing: CorePairingPort;
  /** How the `session` noun reaches a Core. See `session-gateway.ts`. */
  openSessions: OpenSessionGateway;
  /**
   * How `project cp` and `project files` reach a Core's file surface. See
   * `project-files-gateway.ts` (#129 F12, #168).
   *
   * Its own seam rather than a verb on {@link connect}, because it is its own
   * *protocol*: a Project's files cross the Core's HTTPS routes and deliberately
   * not the core link (ADR 0028), so the client behind this is one that has both
   * — a socket to resolve a Project's name on, and a `fetch` with the same mTLS
   * material for the bytes. {@link CoreLinkClient} describes the socket half
   * only, and widening it would put a file surface on the three nouns that have
   * no use for one.
   */
  openFiles: OpenProjectFilesFn;
  /** Epoch ms. Only the bearer-expiry line reads it. */
  now: () => number;
  /**
   * The operator's terminal — raw mode, keystrokes, size, signals.
   *
   * Injected for the same reason as everything above it, and with more riding
   * on it: `core shell` must restore raw mode on every exit path, and a fake
   * terminal is the only way a test can assert that about a dropped connection
   * or a signal. Commands that only print lines never touch it. See
   * `cli-terminal.ts` (#129 D11).
   */
  terminal: CliTerminal;
  /** How `core shell` opens a shell on a Core. See `core-shell-channel.ts`. */
  openShell: OpenCoreShellFn;
  /**
   * How `session attach` reaches a running Session — and claims its write lock
   * on the way in. See `session-attach-channel.ts` (#163, ADR 0024 D3–D7).
   *
   * Separate from {@link openSessions} rather than a verb on the gateway,
   * because the two are different lifetimes: a gateway is opened per verb, hands
   * back plain data and is closed on the way out, while an attach is a live
   * stream *and* a lock held for exactly as long as one connection is open.
   */
  openAttach: OpenSessionAttachFn;

  // ─── the machine half: this machine's own Core ────────────────────────────

  hostname: string;
  networkInterfaces: NodeJS.Dict<{ address: string; family: string; internal: boolean }[]>;
  platform: NodeJS.Platform;
  arch: string;
  /** The operator's username, for `loginctl`. */
  user: string;
  /** The operator's uid, for the launchd domain. */
  uid: number;
  /**
   * The extracted tarball tree this CLI is running from, when it is running
   * from one.
   *
   * A tarball install runs `bin/actana`, which exports `ACTANA_ROOT`; an
   * `npm i -g @actana/cli` has no tarball around it, and `setup` fetches one
   * (#288 D8) rather than refusing. Either way the *managed* install is found
   * through the layout's `current` symlink, not through this.
   */
  installRoot: string;
  /** Whether there is a terminal to prompt on. */
  interactive: boolean;
  system: ActanaSystem;
  /** How `actana install` and `actana update` reach the release channel. */
  fetcher: ReleaseFetcher;
  /**
   * Where the update check's silent failures go.
   *
   * Separate from {@link err} because they are not the operator's business: a
   * release channel that 404s must leave `actana status` looking exactly as it
   * did before the check existed.
   */
  debug: (line: string) => void;
  /** The Core's own PATH probe — the source of truth for Harness availability. */
  probeHarnesses: () => CoreLinkHarnessAvailabilityMap;
  /**
   * Run the Core daemon in the foreground. What the systemd unit execs, and
   * what the image's `CMD` runs.
   *
   * **In-process, never spawned (#288 D4).** systemd's `Type=simple` and
   * launchd both expect the daemon to BE the process they started, and an extra
   * fork in between would leave the init system supervising a wrapper that has
   * already exited. The implementation behind this port resolves
   * `<install root>/app/core-entry.cjs` and `require`s it — a path, not an
   * import, which is what keeps a Node daemon, `better-sqlite3` and `node-pty`
   * out of this package's dependency graph while one binary does both jobs.
   *
   * The env bag is what the daemon needs on top of what it already inherits.
   * On metal it is empty — the unit's `Environment=` lines carry everything.
   * In a container there is no unit, so the `ACTANA_*` contract is translated
   * into the `AC_*` variables the daemon reads and handed over here.
   */
  runDaemon: (env: Record<string, string>) => Promise<void>;
};
