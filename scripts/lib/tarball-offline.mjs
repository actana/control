// What the Core tarball's bundled `actana` has to do with the network taken away (#580 T-405).
//
// The tarball claims an extracted tree needs nothing from the host. Since T-403 the client nouns of
// that `actana` are the published `@actana/cli`, inlined by esbuild into `app/actana-cli.cjs`; this
// proves, on the extracted bytes and against a Core booted from the same tree, that
//
//   * the bundle is the version the manifests pin and the protocol the manifest states (a bundle
//     built from other bytes than it names is refused, as `build-core-tarball.mjs` refuses it);
//   * it starts as the tarball loads it: plain CommonJS under the bundled Node. The published CLI
//     once read `data/orchestration-skill.json` through `import.meta.url` at module load, which a
//     CJS bundle cannot do (`fileURLToPath(undefined)`), and `harness skills` is the verb that
//     loads that payload;
//   * `session ls`, `session start --await-prompt`, `events`, `files` and `shared` answer, with the
//     process unable to leave the machine (`no-network-preload.cjs`) and no attempt to leave it
//     logged: working because a fallback absorbed a refused connection would not be working offline.
//
// It is a library so the two callers (`smoke-core-tarball.mjs`, and the unit tests of the parts
// that need no Core) share one definition.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  assertPackageVersionAgreement,
  inlinedPackageVersions,
  parseCoreLinkProtocolVersion,
  pinnedVersion,
} from "./core-tarball.mjs";
import { credentialAfterBoot } from "./core-smoke.mjs";

export const NO_NETWORK_PRELOAD = path.resolve(import.meta.dirname, "no-network-preload.cjs");

/**
 * What `actana session start --await-prompt <prompt>` did, on a Core that may or may not have the
 * harness: it either refused to spawn one (the Core's own `pty:spawn rejected (<reason>)`, which proves
 * the whole path to the Core) or started a Session and printed its id (which the caller must kill, so a
 * smoke on a machine that has a harness does not leave one running).
 *
 * @returns {{kind: "refused"} | {kind: "started", id: string} | {kind: "unexpected", why: string}}
 */
export function classifySessionStart({ status, stdout = "", stderr = "" }) {
  if (status !== 0) {
    return /pty:spawn rejected \(/.test(stderr)
      ? { kind: "refused" }
      : { kind: "unexpected", why: `exit ${status} without the Core's \`pty:spawn rejected\` refusal` };
  }
  const id = String(stdout).trim().split(/\s+/)[0];
  return id ? { kind: "started", id } : { kind: "unexpected", why: "exit 0 but printed no Session id" };
}

/** `core-link protocol X.Y.Z` out of `actana --version`, or null. */
export function protocolFromVersionLine(text) {
  const match = /core-link protocol (\d+\.\d+\.\d+)/.exec(String(text));
  return match ? match[1] : null;
}

/**
 * The pinned and inlined `@actana/cli` and `@actana/sdk` of an extracted tarball.
 *
 * @param {string} installRoot the extracted tree.
 * @param {string} repoRoot where the manifests are pinned.
 * @returns {{[name: string]: string}} the version each agrees on; throws when they do not.
 */
export function assertExtractedTarballPins(installRoot, repoRoot) {
  const manifest = (...segments) =>
    JSON.parse(fs.readFileSync(path.join(repoRoot, ...segments, "package.json"), "utf8"));
  const mapText = (file) => {
    const mapPath = path.join(installRoot, "app", `${file}.map`);
    if (!fs.existsSync(mapPath)) throw new Error(`the tarball has no app/${file}.map: the bundled versions cannot be read`);
    return fs.readFileSync(mapPath, "utf8");
  };
  const maps = { "actana-cli.cjs": mapText("actana-cli.cjs"), "core-entry.cjs": mapText("core-entry.cjs") };
  const agreed = {};
  for (const [name, holders] of [
    ["@actana/cli", { "packages/cli": manifest("packages", "cli"), "packages/core": manifest("packages", "core") }],
    ["@actana/sdk", { "package.json": manifest(), "packages/cli": manifest("packages", "cli") }],
  ]) {
    const pins = Object.fromEntries(Object.entries(holders).map(([label, m]) => [label, pinnedVersion(m, name, label)]));
    const [pinned] = new Set(Object.values(pins));
    agreed[name] = assertPackageVersionAgreement({
      name,
      pins,
      // The tarball carries the bytes, not node_modules: what is inlined is the installed version.
      installed: pinned,
      inlined: Object.fromEntries(Object.entries(maps).map(([file, text]) => [file, inlinedPackageVersions(text, name)])),
    });
  }
  return agreed;
}

/** The protocol literal the extracted bundles carry, which must be the manifest's. */
export function bundledProtocolVersions(installRoot) {
  return Object.fromEntries(
    ["actana-cli.cjs", "core-entry.cjs"].map((file) => [
      file,
      parseCoreLinkProtocolVersion(fs.readFileSync(path.join(installRoot, "app", file), "utf8")),
    ]),
  );
}

/**
 * Run the extracted tarball's `actana` and the Core it booted, with the network taken away.
 *
 * @param {object} o
 * @param {string} o.installRoot the extracted tree (has `bin/actana`, `node/bin/node`).
 * @param {object} o.env the environment the Core was booted with (HOME, PATH scrubbed of node).
 * @param {string} o.home the Core's HOME.
 * @param {number} o.port the core-link port.
 * @param {object} o.manifest the tarball's `core-manifest.json`.
 * @param {string} o.repoRoot where the manifests are pinned.
 * @param {(message: string, lines?: string[]) => never} o.die
 * @param {(message: string) => void} o.log
 */
export async function assertBundledCliWorksOffline({ installRoot, env, home, port, manifest, repoRoot, die, log }) {
  const launcher = path.join(installRoot, "bin", "actana");
  const bundledNode = path.join(installRoot, "node", "bin", "node");

  // 1. The bytes are the pinned ones, and say the protocol the manifest says.
  let agreed;
  try {
    agreed = assertExtractedTarballPins(installRoot, repoRoot);
  } catch (err) {
    die(`the tarball's bundled packages are not the pinned ones: ${err.message}`);
  }
  const carried = bundledProtocolVersions(installRoot);
  for (const [file, version] of Object.entries(carried)) {
    if (version !== manifest.protocolVersion) {
      die(`app/${file} carries core-link protocol ${version}, core-manifest.json says ${manifest.protocolVersion}`);
    }
  }
  log(`bundled @actana/cli ${agreed["@actana/cli"]} and @actana/sdk ${agreed["@actana/sdk"]}, as pinned; protocol ${manifest.protocolVersion} in the manifest and in both bundles`);

  // 2. The guard is real: the same preload, on the bundled Node, refuses a public address.
  const attempts = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "actana-offline-")), "attempts.log");
  const guardEnv = {
    ...env,
    // Quoted: a checkout path with a space would otherwise split into two options.
    NODE_OPTIONS: `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ""}--require=${JSON.stringify(NO_NETWORK_PRELOAD)}`,
    ACTANA_NO_NETWORK_LOG: attempts,
  };
  const control = spawnSync(
    bundledNode,
    ["-e", 'require("node:net").connect(443,"192.0.2.1").on("error",(e)=>{console.log("CODE="+e.code);process.exit(0)}).on("connect",()=>process.exit(3))'],
    { env: guardEnv, encoding: "utf8", timeout: 20_000 },
  );
  if (!`${control.stdout}`.includes("CODE=ENETUNREACH")) {
    die(`the no-network guard let a connection to 192.0.2.1 through (exit ${control.status}): ${control.stdout}${control.stderr}`);
  }
  fs.writeFileSync(attempts, ""); // the control's own refusal is not the CLI's attempt
  log("the no-network guard refuses a public address under the bundled Node");

  // 3. The verbs, from the tarball's launcher, under the guard.
  const blob = Buffer.from(
    JSON.stringify(await credentialAfterBoot(home, `wss://127.0.0.1:${port}`)),
  ).toString("base64");
  const cliEnv = { ...guardEnv, ACTANA_CORE_BLOB: blob };
  const run = (args, { timeoutMs = 30_000 } = {}) => {
    const result = spawnSync(launcher, args, { env: cliEnv, encoding: "utf8", timeout: timeoutMs });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const expectOk = (args, check) => {
    const result = run(args);
    const problem = result.status !== 0 ? `exit ${result.status}` : check ? check(result) : null;
    if (problem) {
      die(`\`actana ${args.join(" ")}\` offline: ${problem}\n  stdout: ${result.stdout.slice(0, 300)}\n  stderr: ${result.stderr.slice(0, 600)}`);
    }
    log(`actana ${args.join(" ")}: ok`);
    return result;
  };

  expectOk(["--version"], (r) => {
    const protocol = protocolFromVersionLine(r.stdout);
    return protocol === manifest.protocolVersion ? null : `prints protocol ${protocol}, the manifest says ${manifest.protocolVersion}`;
  });
  // The verb that loads the skill payload from `@actana/cli/skill-payload` at start-up.
  expectOk(["harness", "skills", "--json"], (r) => {
    try {
      const parsed = JSON.parse(r.stdout);
      return Array.isArray(parsed.skills) && parsed.skills.length > 0 ? null : "lists no skills";
    } catch {
      return `printed no JSON: ${r.stdout.slice(0, 120)}`;
    }
  });
  expectOk(["session", "ls", "--json"], (r) => {
    try {
      return JSON.parse(r.stdout).length === 0 ? null : `expected [], got ${r.stdout}`;
    } catch {
      return `printed no JSON: ${r.stdout.slice(0, 120)}`;
    }
  });
  expectOk(["files", "ls"], (r) => (/^KIND\s+SIZE/m.test(r.stdout) ? null : "printed no listing header"));
  expectOk(["shared", "ls"], (r) => (r.stdout.trim() === "" ? "printed nothing" : null));

  // `session start --await-prompt` reaches the Core: on a PATH without the harness the Core refuses
  // to spawn it (`pty:spawn rejected`), on a machine that has one a Session starts and is killed.
  const start = run(["session", "start", "--await-prompt", "hello"]);
  const outcome = classifySessionStart(start);
  if (outcome.kind === "unexpected") {
    die(`\`actana session start --await-prompt\` offline did not reach the Core: ${outcome.why}\n  stdout: ${start.stdout.slice(0, 300)}\n  stderr: ${start.stderr.slice(0, 600)}`);
  }
  if (outcome.kind === "started") run(["session", "kill", outcome.id]);
  log(`actana session start --await-prompt: reached the Core (${outcome.kind === "started" ? "started a Session, killed it" : "the Core refused the missing harness"})`);

  await expectFirstEvent(launcher, cliEnv, die);
  log("actana events tail: streamed an event");

  // 4. And not one attempt to leave the machine.
  const attempted = fs.existsSync(attempts) ? fs.readFileSync(attempts, "utf8").split("\n").filter(Boolean) : [];
  if (attempted.length > 0) {
    die(`the bundled actana tried to use the network (${attempted.length}):\n  ${attempted.join("\n  ")}`);
  }
  fs.rmSync(path.dirname(attempts), { recursive: true, force: true });
  log("the CLI made no attempt to leave this machine");
}

/** `events tail` follows forever: read until the first NDJSON event, then stop it. */
function expectFirstEvent(launcher, env, die) {
  return new Promise((resolve) => {
    const child = spawn(launcher, ["events", "tail", "--json", "--since", "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const finish = (problem) => {
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (problem) die(`\`actana events tail\` offline: ${problem}\n  stdout: ${out.slice(0, 300)}\n  stderr: ${err.slice(0, 600)}`);
      resolve();
    };
    const timer = setTimeout(() => finish("no event within 20 s"), 20_000);
    child.stderr.on("data", (chunk) => (err += chunk));
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const line = out.split("\n")[0];
      if (!out.includes("\n")) return;
      try {
        finish(typeof JSON.parse(line).eventId === "number" ? null : "first line has no eventId");
      } catch {
        finish("first line is not JSON");
      }
    });
    child.on("exit", (code) => {
      if (!out.includes("\n")) finish(`exited ${code} before any event`);
    });
  });
}
