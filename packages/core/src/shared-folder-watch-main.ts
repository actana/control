// The Shared folder watcher as a process of its own (#561).
//
// In the container the daemon is `actana` and `core`'s home is 0750 core:core, so
// the daemon cannot read `~/shared` (ADR 0041 D24). The watcher therefore runs as
// `core`: the daemon starts this program through `asCore` and reads its stdout.
// It is the same watcher the daemon runs in process on metal; only the channel
// differs. `shared-folder-watch-entry.ts` is the bundle entry.
//
// Protocol: one JSON object per line on stdout, nothing else.
//   {"type":"ready","mode":"recursive"|"scan"}     the baseline is taken
//   {"type":"changes","changes":[SharedChange…]}   a batch, already coalesced
//   {"type":"log","level":"warn","what":…,"error":…}
// It exits when stdin closes (the daemon is gone), and on a folder it cannot use.
//
// It never runs with the daemon's environment: a variable in the `AC_` namespace
// means it was started some other way, and it refuses, as the home helper does.

import * as path from "node:path";
import type { Readable } from "node:stream";
import { ensureSharedFolder } from "@actana/shared/shared-folder";
import { watchSharedFolder, type SharedChange } from "./shared-folder-watcher";

/** What the watcher process says, one per line. The daemon's feed parses it back. */
export type SharedWatchMessage =
  | { type: "ready"; mode: "recursive" | "scan" }
  | { type: "changes"; changes: SharedChange[] }
  | { type: "log"; level: "info" | "warn"; what: string; error?: string };

export type SharedWatchIo = {
  stdin: Readable;
  stdout: { write: (chunk: string) => unknown };
  stderr: { write: (chunk: string) => unknown };
  env: NodeJS.ProcessEnv;
  /** Resolves with the exit status when the program should end. Tests stop it early. */
  signal?: AbortSignal;
};

export async function runSharedWatchMain(io: SharedWatchIo): Promise<number> {
  const say = (message: SharedWatchMessage) => io.stdout.write(`${JSON.stringify(message)}\n`);

  const inherited = Object.keys(io.env).filter((key) => key.startsWith("AC_") && !key.startsWith("AC_HOOK_"));
  if (inherited.length > 0) {
    io.stderr.write(`shared-watch: refusing to run with the daemon's environment (${inherited.join(", ")})\n`);
    return 2;
  }
  const home = io.env.HOME;
  if (!home || !path.isAbsolute(home) || home.includes("\0")) {
    io.stderr.write("shared-watch: HOME is not an absolute path\n");
    return 2;
  }

  let root: string;
  try {
    root = ensureSharedFolder(home);
  } catch (err) {
    io.stderr.write(`shared-watch: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const watcher = await watchSharedFolder({
    root,
    ensureRoot: () => void ensureSharedFolder(home),
    onChanges: (changes) => say({ type: "changes", changes }),
    onError: (what, error) => say({ type: "log", level: "warn", what, error: String(error) }),
  });
  say({ type: "ready", mode: watcher.mode });

  await new Promise<void>((resolve) => {
    io.stdin.on("end", resolve);
    io.stdin.on("close", resolve);
    io.stdin.resume();
    io.signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  watcher.stop();
  return 0;
}
