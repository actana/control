// The daemon's command port for installing a Harness.
//
// `@actana/shared/actana-harnesses` runs a vendor's installer through an
// {@link ActanaSystem}, and the CLI passes the real one — the port that also
// drives `systemctl`, waits on a TCP port and asks the operator a yes/no
// question on their terminal (`packages/cli/src/actana-system.ts`).
//
// **The daemon cannot pass that one, and the difference is not incidental.** A
// Core running under systemd or `docker run` has no terminal: `confirm` has
// nobody to ask, and answering it "yes" by default would let a frame from a
// Panel take an answer the operator never gave. The Panel already asked — the
// install arrives as an explicit request (ADR 0021) — so the confirmation step
// is not skipped here, it has already happened one layer up.
//
// `passthrough` keeps its name and stops passing anything through: the
// installer's own stdout and stderr are inherited by the daemon's, which is
// what `actana logs` and `docker compose logs` read. That is the only place a
// daemon's subprocess output can honestly go.
//
// The three verbs the operator's port has and this one does not — `run`,
// `waitForPort`, `signal` — throw rather than returning a plausible answer:
// nothing on the Harness-install path calls them, and a silent stub would make
// a future caller's bug look like a machine with no systemd on it.

import { spawn } from "node:child_process";
import type { ActanaSystem } from "@actana/shared/actana-system-port";
import log from "@actana/shared/log";

/** The port the daemon hands `installAgentsNow`. Non-interactive by construction. */
export function daemonHarnessSystem(): ActanaSystem {
  const unused = (verb: string): never => {
    throw new Error(`the daemon's harness system port has no ${verb}()`);
  };
  return {
    run: () => unused("run"),
    passthrough(command, args) {
      return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: "inherit" });
        child.on("error", (err) => {
          log.error(`could not run ${command}: ${err.message}`);
          resolve(127);
        });
        child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
      });
    },
    waitForPort: () => unused("waitForPort"),
    // Never asked: an install that reached this Core came from a Panel that
    // already asked somebody. Answering `false` rather than throwing keeps a
    // future offer-round caller declining instead of crashing the daemon.
    confirm: async () => false,
    signal: () => unused("signal"),
  };
}
