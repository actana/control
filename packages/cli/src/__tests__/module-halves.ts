// Which half of `actana` a module belongs to.
//
// Since #288 this package ships one program with two halves under one name:
// the **client** — the nouns that reach a Core over the core link — and the
// **machine** half, which installs, starts, stops and supervises the Core on
// the box it is running on. Three of this package's bans were written when the
// second half lived somewhere else, and they are worded as facts about "the
// CLI" that are now only true of the client half:
//
//   1. `no-local-escape.test.ts` — *the CLI cannot shell out* (#129 D9). Its
//      argument, in its own words, is about a **client**: *a CLI that shells
//      into a container to fetch its own credentials is not a CLI.* Driving
//      `systemctl`, `launchctl`, `loginctl` and a vendor's Harness installer is
//      not that temptation — it is the machine half's entire job, and there is
//      no other way to do it.
//   2. `no-prompt-timing.test.ts` — *the CLI schedules nothing* (ADR 0026).
//      Its subject is prompt delivery: the CLI must not decide when a Harness
//      has booted or when a prompt is submitted, because the Core decides
//      that. Waiting for a TCP port to answer after `systemctl start` is not a
//      timing decision about somebody's Session.
//   3. The same file's *reads the clock in exactly one place*, for the same
//      reason.
//
// **The bans are narrowed here, not dropped.** Each keeps sweeping the client
// modules, where the temptation it names actually lives, and stops covering the
// machine modules, which exist to drive an init system. What would make a
// breach a breach again is written into each ban: a *client* noun reaching for
// a subprocess to get at a Core, or a Session path that schedules.
//
// The exemption is a table, not a prefix rule, and every row carries a reason.
// A prefix rule (`actana-*.ts`) would exempt a future client module by the
// accident of its name, and a reviewer could not tell an exemption from a
// filename. Every row is checked to be a real shipped module, so a row for a
// deleted file cannot sit here holding a hole open for whatever takes that name
// next.
//
// **Two files are deliberately NOT on it.** `actana-cli.ts` is the dispatch
// both halves come through and `actana-cli-entry.ts` is the one file that binds
// the real process; if either could shell out or schedule, the narrowing would
// have bought the machine half a door into the client's path. They stay swept.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** This package's `src`, from any test file under `src/__tests__`. */
export const SRC = path.resolve(import.meta.dirname, "..");

/**
 * The machine half: the modules that install and operate a Core on this box.
 *
 * The value is why the module is on the list. Anything not named here is the
 * client half and is swept by every ban.
 */
export const MACHINE_MODULES: Record<string, string> = {
  "actana-config.ts": "reads and writes the install's own `actana.json`",
  "actana-container.ts": "the refusal table for the verbs the container runtime owns",
  "actana-fetch-release.ts": "downloads a release tarball and verifies its SHA-256",
  "actana-harnesses.ts": "installs a Harness the vendor's way, which means running the vendor's installer",
  "actana-install.ts": "fetches a release and installs a Core from it (#288 D8)",
  "actana-launcher.ts": "decides whether `<binDir>/actana` is this install's to write (#288 D10)",
  "actana-launchd.ts": "writes the LaunchAgent plist macOS starts the daemon from",
  "actana-layout.ts": "resolves every path this install owns under the operator's home",
  "actana-manifest.ts": "reads the extracted tarball's `core-manifest.json`",
  "actana-release.ts": "maps this machine to a release target and reads a release's checksums",
  "actana-service.ts": "the init-system port: enable, start, stop and query the unit",
  "actana-setup.ts": "lays down the tree, registers the service and mints the pairing material",
  "actana-status.ts": "formats what the daemon, the unit and the release channel report",
  "actana-system.ts":
    "runs `systemctl`, `launchctl`, `loginctl` and vendor installers, waits for the daemon's " +
    "port, and prompts the operator — the one module here that imports `node:child_process`, " +
    "and the reason the shell-out ban is narrowed rather than deleted (#288 C1)",
  "actana-systemd.ts": "writes the systemd unit the daemon runs under",
  "actana-tree.ts": "installs and swaps the versioned tree under `~/.local/share/actana`",
  "actana-uninstall.ts": "removes the service, the tree and — when asked — the data",
  "actana-update.ts": "swaps a verified release in under a running daemon and restarts it",
  "local-core-wiring.ts": "registers a Core installed here with this machine's own CLI (#288 D9)",
};

/**
 * Every shipped module — this package's own source at any depth, tests
 * excluded. Recursive, so a `src/commands/…` added later is covered without
 * anybody remembering to extend this.
 */
export function shippedSources(dir: string = SRC): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      files.push(...shippedSources(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

/** The shipped modules that are *not* the machine half. What the bans sweep. */
export function clientSources(): string[] {
  return shippedSources().filter((file) => !MACHINE_MODULES[path.relative(SRC, file)]);
}

/** The shipped modules that are the machine half. */
export function machineSources(): string[] {
  return shippedSources().filter((file) => MACHINE_MODULES[path.relative(SRC, file)]);
}

/**
 * Source with its comments removed.
 *
 * The sweeps read what a module *does*, and every file in this package carries
 * a header explaining which packages it may not import — prose that names
 * `@actana/shared` and `child_process` on purpose. Scanning it would make the
 * documentation of a rule indistinguishable from a breach of it.
 */
export function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[^\n"'`]*\/\/[^\n]*$/gm, "");
}

/**
 * The import specifiers in a source file.
 *
 * Double and single quotes both count — TypeScript treats them as one thing and
 * a formatter may rewrite between them. Backticks are deliberately excluded: a
 * static import cannot use one, and the prose in these headers is full of
 * package names in backticks.
 */
export function importSpecifiers(source: string): string[] {
  return [
    ...withoutComments(source).matchAll(/(?:^|[\s(])(?:from|import)\s*\(?\s*(["'])([^"']+)\1/gm),
  ].map((m) => m[2]!);
}

/** Read a shipped module and hand back its path-relative name and body. */
export function named(file: string): { name: string; source: string } {
  return { name: path.relative(SRC, file), source: readFileSync(file, "utf8") };
}
