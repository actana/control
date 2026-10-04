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

import type { ClientDeps } from "@actana/cli";
import type { ActanaSystem } from "./actana-system.ts";
import type { ReleaseFetcher } from "./actana-release.ts";
import type { CoreLinkHarnessAvailabilityMap } from "@actana/sdk/core";

/**
 * The client half is the published `@actana/cli`'s own `ClientDeps` (#580):
 * streams, terminal and every Core port are *its* contract, bound in
 * `actana-cli-entry.ts` from its root exports and handed to `runClient`
 * untouched. Only the machine half below is this package's.
 */
export type ActanaCliDeps = ClientDeps & {
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
