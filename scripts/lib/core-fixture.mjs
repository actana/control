// The Core fixture the Panel e2e pairs with.
//
// A fixture is one thing to the test: a running Core that hands over a
// registration blob and can be torn down. That is the whole interface —
//
//   {
//     registrationBlob,// the base64 paste an operator would put in "Add Core"
//     blob,            // the same, decoded — the test reads the secrets to
//                      // assert they are NOT readable out of the Panel
//     endpoint,        // wss:// the Panel will dial
//     makeProjectDir,  // (prefix) => a directory path that exists ON THE CORE
//     logLines,        // () => string[], the Core's output for failure triage
//     stop,            // () => void
//   }
//
// `makeProjectDir` is the one member that is not obviously about pairing, and
// it is here because it is the one thing a test cannot do for itself: a
// containerised Core does not share a filesystem with the process testing it,
// so `fs.mkdtempSync` on the host produces a path the Core will rightly refuse.
// Asking the fixture for the directory is what lets the same assertions run
// against a Core in a container and a Core in a sibling process.
//
// — and it is deliberately small because there are two implementations of it.
//
//   • `startLocalCore` boots the built Core as a plain child process.
//     It is what a macOS runner with no Docker can do, and it is fast.
//   • `startContainerCore` is the spec's canonical "Core-in-a-box": the
//     release tarball installed by `actana setup` on a real systemd machine,
//     the pairing token read off what setup printed, and `docker rm -f` on
//     stop. What the Panel dials there is the artifact an operator downloads,
//     auto-started by the init system, rather than a process this repo spawned.
//
// The e2e that consumes either one does not change — which is the point of
// keeping the interface this narrow.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_DISTRO, distroDockerfile, imageTag } from "./container-matrix.mjs";
import {
  decodeBlob,
  extractToken,
  coreSmokeEnv,
  pickFreePort,
  waitForListening,
} from "./core-smoke.mjs";
import {
  OPERATOR,
  pickHostPort,
  run,
  startSystemdContainer,
  waitForPort,
} from "./systemd-container.mjs";

const DEFAULT_BOOT_TIMEOUT_MS = 60_000;

/** The port the Core listens on inside a Core-in-a-box. */
const CONTAINER_PORT = 8443;

/** How much of the Core's journal to hand back for failure triage. */
const LOG_TAIL_LINES = 200;

/**
 * Boot a Core as a local process against a throwaway HOME and data
 * directory, and hand back the fixture interface above.
 *
 * The blob's endpoint is rewritten to the loopback address the Core
 * actually bound. The Core mints its server cert with a `127.0.0.1` SAN
 * (`AC_CORE_PUBLIC_HOST`), so this is the address the Panel's pinned-CA
 * dial verifies against — the same rewrite the tarball smoke makes.
 */
export async function startLocalCore({ entry, timeoutMs = DEFAULT_BOOT_TIMEOUT_MS, log } = {}) {
  if (!entry || !fs.existsSync(entry)) {
    throw new Error(
      `core entry not found at ${entry} — run \`pnpm --filter @actana/core build\` first`,
    );
  }
  const port = await pickFreePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ac-e2e-core-"));
  const userDataDir = path.join(home, ".actana-control", "data");
  fs.mkdirSync(userDataDir, { recursive: true });

  const child = spawn(process.execPath, [entry], {
    env: coreSmokeEnv({
      home,
      userDataDir,
      port,
      extra: { AC_APP_PATH: path.dirname(entry) },
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const observer = { logLines: [], badTags: [], blob: null };
  const stop = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  try {
    await waitForListening(child, timeoutMs, observer);
    if (!observer.blob) throw new Error("core printed no registration blob");
  } catch (err) {
    stop();
    err.logLines = observer.logLines;
    throw err;
  }

  const endpoint = `wss://127.0.0.1:${port}`;
  const blob = { ...decodeBlob(observer.blob), endpoint };
  log?.(`core fixture up on ${endpoint} (home=${home})`);

  return {
    registrationBlob: encodeBlob(blob),
    blob,
    endpoint,
    // This Core shares the host's filesystem, so a host temp directory is a
    // directory it can see. It lives under the fixture's own home so `stop`
    // takes it away.
    makeProjectDir: (prefix) => fs.mkdtempSync(path.join(home, prefix)),
    logLines: () => [...observer.logLines],
    stop,
  };
}

/**
 * Install a release tarball on a throwaway systemd machine and hand back the
 * same fixture interface — the Core-in-a-box.
 *
 * The Core here is installed the way an operator installs one: extract the
 * tarball, `actana setup`, and let the user unit start the daemon. Nothing
 * about the fixture reaches past `actana` into the Core, so what the Panel
 * e2e pairs with is genuinely the shipped artifact on a machine that boots it.
 *
 * The blob's endpoint is rewritten to the host-published port for the same
 * reason `startLocalCore` rewrites it: setup mints the server cert with a
 * `127.0.0.1` SAN, so loopback is the address the Panel's pinned-CA dial can
 * verify — only the port differs between inside and outside the container.
 */
export async function startContainerCore({
  tarball,
  distro = DEFAULT_DISTRO,
  keep = false,
  timeoutMs = DEFAULT_BOOT_TIMEOUT_MS,
  log,
} = {}) {
  if (!tarball || !fs.existsSync(tarball)) {
    throw new Error(
      `no tarball at ${tarball} — run \`pnpm core:tarball\` first, or drop the --core-tarball flag`,
    );
  }
  if (!path.basename(tarball).includes("-linux-")) {
    throw new Error(
      `${path.basename(tarball)} is not a linux tarball — a Core-in-a-box is a Linux container`,
    );
  }

  const observed = { logLines: [] };
  /**
   * The container helpers end a run by calling `die`; a fixture ends it by
   * throwing, so the caller can fall back or report. Whatever output was
   * gathered rides along on the error rather than being printed and lost.
   */
  const die = (message, lines = []) => {
    const error = new Error(message);
    error.logLines = [...observed.logLines, ...lines];
    throw error;
  };
  const note = (message) => {
    observed.logLines.push(message);
    log?.(message);
  };

  const hostPort = await pickHostPort();
  const machine = await startSystemdContainer({
    tag: imageTag("core-in-a-box", distro),
    name: `actana-core-in-a-box-${distro}-${process.pid}`,
    containerPort: CONTAINER_PORT,
    hostPort,
    dockerfile: distroDockerfile(distro, { fail: die }),
    keep,
    die,
    log: note,
  });

  const asset = path.basename(tarball);
  machine.copyToOperator(tarball);
  const extracted = `/home/${OPERATOR}/${path.basename(asset, ".tar.gz")}`;
  // `--no-harnesses`: what this fixture is for is a Core the Panel can pair with
  // and drive. Harness CLIs are a separate seam with its own e2e, and attempting
  // their vendor installers here would make a hermetic fixture depend on the
  // network.
  const setup = machine.asOperator(
    `cd ~ && tar -xzf ${asset} && ${extracted}/bin/actana setup --public-host 127.0.0.1 --yes --no-harnesses`,
  );
  observed.logLines.push(...setup.stdout.split("\n"));
  if (setup.status !== 0) die(`\`actana setup\` exited ${setup.status} in the Core-in-a-box`);

  const { blob: decoded } = extractToken(setup.stdout, "the Core-in-a-box's actana setup", die);
  await waitForPort(hostPort, die, timeoutMs);

  const endpoint = `wss://127.0.0.1:${hostPort}`;
  const blob = { ...decoded, endpoint };
  log?.(`Core-in-a-box up on ${endpoint} (${distro}, container ${machine.name})`);

  let stopped = false;
  /**
   * Append the Core's journal to what has been observed.
   *
   * Failure-path only, and the container may already be gone by the time it
   * runs — so a dead machine costs the caller nothing rather than replacing
   * their real error with a docker one.
   */
  const captureJournal = () => {
    if (stopped) return;
    try {
      const logs = machine.asOperator(`actana logs -n ${LOG_TAIL_LINES}`);
      if (logs.status === 0) observed.logLines.push(...logs.stdout.split("\n"));
    } catch {
      /* the machine is gone; what was gathered before it went is what there is */
    }
  };

  return {
    registrationBlob: encodeBlob(blob),
    blob,
    endpoint,
    /** A directory inside the machine — the only kind this Core can open. */
    makeProjectDir: (prefix) => {
      const made = machine.asOperator(`mktemp -d "$HOME/${prefix}XXXXXX"`);
      if (made.status !== 0) die(`could not make a project directory on the Core`, [made.stdout]);
      return made.stdout.trim();
    },
    /**
     * The Core's journal, read live while the container is up.
     *
     * Cached on the way out so a caller that stops the fixture before printing
     * a failure still gets the output it was stopping because of.
     */
    logLines: () => {
      captureJournal();
      return [...observed.logLines];
    },
    stop: () => {
      if (stopped) return;
      captureJournal();
      stopped = true;
      if (keep) {
        log?.(`--keep: leaving Core-in-a-box ${machine.name} running`);
        return;
      }
      run("docker", ["rm", "-f", machine.name]);
    },
  };
}

/**
 * Re-encode a decoded blob into the base64 paste string the Panel accepts.
 *
 * A copy of `encodeRegistrationBlob` rather than an import of it: this test
 * drives the Panel from outside, and a shared encoder would let one bug in the
 * codec cancel itself out on both ends of the paste.
 */
function encodeBlob(blob) {
  return Buffer.from(
    JSON.stringify({
      endpoint: blob.endpoint,
      label: blob.label ?? "",
      caCert: blob.caCert,
      clientCert: blob.clientCert,
      clientKey: blob.clientKey,
      bearer: blob.bearer,
    }),
    "utf8",
  ).toString("base64");
}
