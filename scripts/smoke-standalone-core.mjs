#!/usr/bin/env node
// Smoke test — the standalone Core boots clean under plain node.
//
// Boots packages/core/dist/core-entry.cjs with the current node binary
// (standard Node ABI) against a temp HOME,
// waits for the @@AC_CORE_LISTENING@@ marker, then dials the core-link
// (mTLS + bearer) and asserts `projectsList` returns `[]` against a real
// schema (not the `db-missing` degradation path).
//
// Guards the workspace restructure (web-panel-extraction issue 01): if a
// future change ships a Core that can't load its natives on the normal
// ABI, can't open SQLite, or can't migrate its schema, this fails loudly in
// CI instead of surfacing as spam on someone's VM weeks later.
//
// The released tarball gets the same assertion from
// `scripts/smoke-core-tarball.mjs`; the shared sequence lives in
// `scripts/lib/core-smoke.mjs`.
//
// Usage:
//   node scripts/smoke-standalone-core.mjs [--entry <file>] [--port <n>] [--timeout <ms>]
//
// --entry <file>    Core bundle (default: packages/core/dist/core-entry.cjs;
//                   run `pnpm --filter @actana/core build` first).
// --port <n>        Loopback port to bind (default: random free port).
// --timeout <ms>    Boot-marker wait (default: 30000).
//
// Exit codes: 0 on pass, non-zero on any failure. On failure the tail of the
// child's stdout/stderr is printed so triage doesn't need a rerun.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseArgs, stringFlag } from "./lib/cli.mjs";
import {
  assertBootsAndDials,
  coreSmokeEnv,
  makeDie,
  pickFreePort,
} from "./lib/core-smoke.mjs";

const die = makeDie("smoke");
const log = (message) => console.log(`[smoke] ${message}`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length > 0) die(`unexpected argument: ${args._[0]}`);

  const timeoutMs = Number(stringFlag(args, "timeout", die, "30000"));
  const portFlag = stringFlag(args, "port", die);
  const port = portFlag ? Number(portFlag) : await pickFreePort();
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) die(`bad --timeout: ${args.timeout}`);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) die(`bad --port: ${args.port}`);

  const repoRoot = path.resolve(import.meta.dirname, "..");
  const entry = path.resolve(
    stringFlag(args, "entry", die) ??
      path.join(repoRoot, "packages", "core", "dist", "core-entry.cjs"),
  );
  if (!fs.existsSync(entry)) {
    die(`core entry not found at ${entry} — run \`pnpm --filter @actana/core build\` first`);
  }

  // Isolate every side-effect the Core might have to a fresh temp dir:
  // HOME (any HOME-scoped writes) and AC_USER_DATA_DIR (the DB it bootstraps).
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mc-smoke-home-"));
  const tmpUserData = path.join(tmpHome, ".actana-control", "data");
  fs.mkdirSync(tmpUserData, { recursive: true });

  log(`node=${process.execPath} (${process.version})`);
  log(`entry=${entry}`);
  log(`HOME=${tmpHome}`);
  log(`port=${port}`);

  const env = coreSmokeEnv({
    home: tmpHome,
    userDataDir: tmpUserData,
    port,
    extra: { AC_APP_PATH: path.dirname(entry) },
  });

  let child;
  try {
    child = spawn(process.execPath, [entry], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
  } catch (err) {
    die(`spawn(${process.execPath}) failed: ${err.message}`);
  }

  const cleanup = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  await assertBootsAndDials(child, { port, timeoutMs, die, log });

  log("OK — standalone Core boots clean under plain node");
  cleanup();
  process.exit(0);
}

void main().catch((err) => {
  console.error(`[smoke] unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});
