// `actana` CLI entry — what `bin/actana` in the tarball execs.
//
// Everything interesting lives in `actana-cli.ts`; this file only supplies the
// real process to it. Keeping the wiring this thin is what makes the verb
// surface testable without spawning anything.
//
// The `daemon` verb loads the sibling `core-entry.cjs` in-process rather
// than spawning it: systemd's `Type=simple` and launchd both expect the daemon
// to BE the process they started, and an extra fork in between would leave the
// init system supervising a wrapper that has already exited.

import * as os from "node:os";
import * as path from "node:path";
import { runActanaCli } from "./actana-cli";
import { nodeReleaseFetcher } from "./actana-release";
import { nodeActanaSystem } from "./actana-system";
import { HarnessAvailabilityStore } from "./harness-availability-store";

/**
 * The install root — where `bin/`, `app/` and `core-manifest.json` live.
 *
 * `bin/actana` exports `ACTANA_ROOT` after resolving symlinks; falling back to
 * `__dirname/..` covers running the built bundle directly out of `app/`.
 */
function resolveInstallRoot(): string {
  return process.env.ACTANA_ROOT || path.resolve(__dirname, "..");
}

/**
 * Probe the machine's Harnesses for `actana status`.
 *
 * The Core's own availability store is the source of truth (CONTEXT.md:
 * "CLI availability is Core-published state"), so `status` runs the very
 * same probe rather than a second, subtly different one. `appendEvent` is a
 * no-op here — there is no event log in a one-shot CLI process, and nothing
 * is listening for a change that only this invocation saw.
 */
function probeHarnesses() {
  const store = new HarnessAvailabilityStore({ appendEvent: () => 0 });
  store.runProbe();
  return store.snapshot();
}

async function main(): Promise<void> {
  const code = await runActanaCli({
    argv: process.argv.slice(2),
    env: process.env,
    home: os.homedir(),
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
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    probeHarnesses,
    runDaemon: async (env) => {
      // `core-entry` reads its configuration from `process.env`, so whatever
      // the CLI resolved for it (the container contract; nothing on metal)
      // is merged in before the module is loaded.
      Object.assign(process.env, env);
      // Requiring rather than importing keeps the daemon out of this bundle:
      // both files ship side by side in `app/`, and duplicating the Core
      // into the CLI would double the tarball's JavaScript for no gain.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(path.join(__dirname, "core-entry.cjs"));
      // core-entry installs its own SIGTERM/SIGINT handlers and never
      // resolves — the process lives until systemd stops it.
      await new Promise<void>(() => {});
    },
  });
  // The daemon path never gets here; every other verb does.
  process.exit(code);
}

void main().catch((err) => {
  console.error(`[actana] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
