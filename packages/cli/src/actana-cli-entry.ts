// The one file that knows about `process`.
//
// Everything above it takes its side effects as arguments and returns an exit
// code (see `actana-cli.ts`), so this is where the real argv, the real
// environment, the real streams, the real system port and the real Core dial
// get bound to it — and the only place `process.exit` is called.
//
// One entry for one program (#288). It is compiled twice, and the two bundles
// are what the two doors onto `actana` load:
//
//   dist/actana-cli.mjs          ESM — what `bin/actana.mjs` loads, and what
//                                `npm i -g @actana/cli` puts on an operator's
//                                PATH.
//   dist-tarball/actana-cli.cjs  CJS — staged into the Core tarball as
//                                `app/actana-cli.cjs`, which `bin/actana` in
//                                the tarball execs on the bundled Node. It is
//                                emitted outside `dist/` so the npm package
//                                does not publish a second copy of itself.
//
// Same source, same verbs, same help: which of the two answers `actana` on a
// machine that has both is no longer a question with consequences.
//
// **The `daemon` verb loads `core-entry.cjs` in-process rather than spawning
// it**: systemd's `Type=simple` and launchd both expect the daemon to BE the
// process they started, and an extra fork in between would leave the init
// system supervising a wrapper that has already exited. It reaches it by
// *path* — `<install root>/app/core-entry.cjs`, through `createRequire` — and
// never by importing `@actana/core`. That is what lets one binary do both jobs
// while `src/__tests__/no-local-escape.test.ts`'s daemon ban stands: a Node
// daemon, `better-sqlite3` and `node-pty` never enter this package's
// dependency graph, because nothing here resolves them at build time.

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runActanaCli } from "./actana-cli.ts";
import { resolveActanaLayout } from "./actana-layout.ts";
import { nodeReleaseFetcher } from "./actana-release.ts";
import { nodeActanaSystem } from "./actana-system.ts";
import { HarnessAvailabilityStore } from "@actana/shared/harness-availability-store";
import { probeCore } from "./core-probe.ts";
import { openCoreShell } from "./core-shell-channel.ts";
import { terminalFromProcess } from "./cli-terminal.ts";
import { connectCore } from "./core-connection.ts";
import { openSessionGateway } from "./session-gateway.ts";
import { openProjectFiles } from "./project-files-gateway.ts";
import { openSessionAttach } from "./session-attach-channel.ts";
import { EXIT_FAILURE } from "./exit-codes.ts";

/** Read stdin to end. Only called by a verb that was told to read it. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The install root — where `bin/`, `app/` and `core-manifest.json` live.
 *
 * The tarball's `bin/actana` exports `ACTANA_ROOT` after resolving symlinks,
 * so a CLI that came with a Core knows the tree it is standing in. A CLI that
 * came from npm is not standing in one and answers "" — every caller treats
 * that as "no tarball here", which is the case `actana install` exists for.
 */
function resolveInstallRoot(): string {
  return process.env.ACTANA_ROOT ?? "";
}

/**
 * Probe the machine's Harnesses for `actana status` and `actana setup`.
 *
 * The Core's own availability store is the source of truth (CONTEXT.md: "CLI
 * availability is Core-published state"), so the CLI runs the very same probe
 * rather than a second, subtly different one. `appendEvent` is a no-op here —
 * there is no event log in a one-shot CLI process, and nothing is listening
 * for a change that only this invocation saw.
 */
function probeHarnesses() {
  const store = new HarnessAvailabilityStore({ appendEvent: () => 0 });
  store.runProbe();
  return store.snapshot();
}

/**
 * Where the daemon's bundle is, for the `daemon` verb.
 *
 * `ACTANA_ROOT` first — that is the tarball launcher telling us which tree it
 * execed us out of, and it is the only answer that is right when several
 * versions are installed side by side. Otherwise the managed install's
 * `current` symlink, which is what an `npm i -g` CLI managing a Core on this
 * machine has. Both are `<root>/app/core-entry.cjs`.
 */
function daemonEntryPath(): string {
  const roots = [
    resolveInstallRoot(),
    resolveActanaLayout(process.env, os.homedir(), process.platform).currentLink,
  ].filter(Boolean);
  for (const root of roots) {
    const candidate = path.join(root, "app", "core-entry.cjs");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    "no Core is installed here: could not find app/core-entry.cjs under " +
      `${roots.join(" or ") || "any install root"}. \`actana install\` puts one there.`,
  );
}

const verbose = process.argv.includes("--verbose");

// Wrapped in a function rather than left as a top-level `await`, because this
// file is compiled to CJS as well as ESM (see the header) and CJS has no
// top-level await. One entry, two formats, one shape.
async function main(): Promise<void> {
  const code = await runActanaCli({
    argv: process.argv.slice(2),
    env: process.env,
    home: os.homedir(),
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
    // The same two streams without the newline: what `core exec` relays a remote
    // command's own output through, so `printf hello` arrives as `hello`.
    outBytes: (chunk) => {
      process.stdout.write(chunk);
    },
    errBytes: (chunk) => {
      process.stderr.write(chunk);
    },
    // Verbose goes to stderr so it cannot corrupt the stdout a `--json` consumer
    // is parsing, and it is a no-op rather than a filtered sink when the flag is
    // off — a disabled sink that still formats its argument is a disabled sink
    // that can still be handed something it should not have been.
    verbose: verbose
      ? (line) => {
          process.stderr.write(`actana: ${line}\n`);
        }
      : () => {},
    readStdin,
    stdinIsTty: Boolean(process.stdin.isTTY),
    probe: probeCore,
    connect: connectCore,
    openSessions: openSessionGateway,
    // The file surface, which is the one thing in this program that does not
    // cross the core link: `project cp` and `project files` reach the Core's
    // HTTPS routes through the SDK (ADR 0028, #129 F12).
    openFiles: openProjectFiles,
    now: () => Date.now(),
    // The real terminal, and the only place one is built. `core shell` is what
    // uses it; every other verb is handed it and never asks. It takes `process`
    // as an argument rather than reading the global, which is what keeps this the
    // one file that knows about one (#129 D11).
    terminal: terminalFromProcess(process),
    openShell: openCoreShell,
    // The other command that holds the terminal, and the only one that holds a
    // Session write lock for as long as it runs (#163, ADR 0024 D3–D7).
    openAttach: openSessionAttach,

    // ─── the machine half ─────────────────────────────────────────────────────

    hostname: os.hostname(),
    networkInterfaces: os.networkInterfaces(),
    platform: process.platform,
    arch: process.arch,
    user: os.userInfo().username,
    uid: os.userInfo().uid,
    installRoot: resolveInstallRoot(),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    system: nodeActanaSystem(),
    fetcher: nodeReleaseFetcher(),
    // Dropped on the floor deliberately. The only thing that logs here is the
    // update check giving up, and an operator running `actana status` did not
    // ask about the release channel — the daemon logs the same facts once a day
    // where someone reading `actana logs` will actually find them.
    debug: () => {},
    probeHarnesses,
    runDaemon: async (env) => {
      // `core-entry` reads its configuration from `process.env`, so whatever the
      // CLI resolved for it (the container contract; nothing on metal) is merged
      // in before the module is loaded.
      Object.assign(process.env, env);
      const entry = daemonEntryPath();
      // `createRequire` rather than `import`, and an absolute path rather than a
      // specifier: the daemon is a sibling *file*, not a dependency. Requiring it
      // this way keeps `@actana/core` out of this bundle — see the header, and
      // `no-local-escape.test.ts`'s daemon ban, which is what enforces it.
      createRequire(entry)(entry);
      // core-entry installs its own SIGTERM/SIGINT handlers and never resolves —
      // the process lives until systemd, launchd or Docker stops it.
      await new Promise<void>(() => {});
    },
  }).catch((err: unknown) => {
    // A throw that reached here is a defect, not an operator error: every
    // expected failure returns an exit code. Print the message and nothing
    // about the inputs — a stack trace from inside the blob path is one of the
    // few ways credential material could still reach a terminal.
    process.stderr.write(`actana: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_FAILURE;
  });

  // The `daemon` verb never gets here; every other command does.
  process.exit(code);
}

void main();
