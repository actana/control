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
// — and it is deliberately small because it was written for two
// implementations. `startLocalCore` is the one that is left: it boots the
// built Core as a plain child process, which is what a macOS runner with no
// Docker can do, and it is fast.
//
// The second was `startContainerCore`, a Core-in-a-box — the release tarball
// installed by `actana setup` on a privileged systemd container. It is gone
// (ADR 0016 D36): `scripts/smoke-core-image.mjs` makes the same "a Panel pairs
// with a containerised Core" assertion against the image that actually ships,
// with no privileged container and no fixture to keep in sync with the real
// thing. The interface stays this narrow anyway — `makeProjectDir` earns its
// place the moment a second implementation appears again.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { coreSmokeEnv, decodeBlob, pickFreePort, waitForListening } from "./core-smoke.mjs";

const DEFAULT_BOOT_TIMEOUT_MS = 60_000;

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
