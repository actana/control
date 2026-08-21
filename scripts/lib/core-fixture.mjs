// The Core fixture the Panel e2e pairs with.
//
// A fixture is one thing to the test: a running Core it can pair with and tear
// down. That is the whole interface —
//
//   {
//     address,         // host:port, what an operator types into "Add Core"
//     endpoint,        // wss:// the Panel will dial
//     newPairing,      // () => {code, sessionId} — one `actana pair new`
//     caFingerprint,   // what the operator reads out beside the code
//     secrets,         // the Core's own key material — the test asserts the
//                      // Panel never hands any of it back
//     makeProjectDir,  // (prefix) => a directory path that exists ON THE CORE
//     logLines,        // () => string[], the Core's output for failure triage
//     stop,            // () => void
//   }
//
// `newPairing` is a function rather than a field because a code is *single-use*:
// a phase that pairs is spending one, and a run with three phases in it needs
// three. That is the product's rule showing through the fixture, not a
// convenience.
//
// **It used to hand over a registration blob and it now mints a code**, because
// #287 removed the blob and its paste box: `POST /api/cores` is gone, and the
// only way into the Panel's registry is `POST /api/cores/pairing`. The pairing
// session is written straight into the Core's `pairing.json` — a deliberate
// copy of `@actana/shared/pairing-store`'s digest, for the same reason the
// encoder below was one: this test drives both ends from outside, and importing
// the hasher would let one bug in it cancel itself out against the Core.
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
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { X509Certificate } from "node:crypto";
import { coreSmokeEnv, materialFileFor, pickFreePort, waitForListening } from "./core-smoke.mjs";

const DEFAULT_BOOT_TIMEOUT_MS = 60_000;

/** The alphabet `@actana/shared/pairing-code` draws from — no 0, O, 1, I or L. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** How long the fixture's code stays good. Generous: an e2e is not a stopwatch. */
const CODE_TTL_MS = 30 * 60 * 1000;

/**
 * Boot a Core as a local process against a throwaway HOME and data
 * directory, mint it a pairing session, and hand back the fixture interface
 * above.
 *
 * The address is the loopback one the Core actually bound. The Core mints its
 * server cert with a `127.0.0.1` SAN (`AC_CORE_PUBLIC_HOST`), so this is the
 * address the Panel's pinned-CA dial verifies against.
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

  const observer = { logLines: [], badTags: [] };
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

  let material;
  try {
    await waitForListening(child, timeoutMs, observer);
    material = JSON.parse(fs.readFileSync(materialFileFor(home), "utf8"));
  } catch (err) {
    stop();
    err.logLines = observer.logLines;
    throw err;
  }

  const endpoint = `wss://127.0.0.1:${port}`;
  log?.(`core fixture up on ${endpoint} (home=${home})`);

  return {
    address: `127.0.0.1:${port}`,
    endpoint,
    newPairing: () => mintPairingSession(materialFileFor(home), material.bearerSecret),
    caFingerprint: fingerprintOf(material.caCert),
    // The Core's own material, so the e2e can assert the Panel hands none of it
    // back. The key the Panel ends up holding is one it generated itself and
    // this fixture never sees — which is the point of the exchange.
    secrets: {
      caKey: material.caKey,
      serverKey: material.serverKey,
      bearerSecret: material.bearerSecret,
    },
    // This Core shares the host's filesystem, so a host temp directory is a
    // directory it can see. It lives under the fixture's own home so `stop`
    // takes it away.
    makeProjectDir: (prefix) => fs.mkdtempSync(path.join(home, prefix)),
    logLines: () => [...observer.logLines],
    stop,
  };
}

/**
 * Write one pending pairing session into the Core's `pairing.json`, and return
 * the code that redeems it.
 *
 * What `actana pair new` does on the Core, done from outside it: the file lives
 * beside the material file, holds `{version, sessions, clients}`, and stores a
 * *digest* of the code keyed by a secret derived from the bearer secret — never
 * the code itself. All three of those are copied here rather than imported, so
 * a bug in the real hasher cannot cancel itself out against a test that uses
 * the same one.
 */
function mintPairingSession(materialFile, bearerSecret) {
  const code = `${randomCode(4)}-${randomCode(4)}`;
  const sessionId = crypto.randomUUID();
  const key = crypto
    .createHmac("sha256", bearerSecret)
    .update("actana:pairing-code:v1")
    .digest();
  const now = Date.now();
  const session = {
    id: sessionId,
    label: "panel-e2e",
    codeHash: crypto.createHmac("sha256", key).update(`${sessionId}:${code}`).digest("hex"),
    createdAt: now,
    expiresAt: now + CODE_TTL_MS,
    attempts: 0,
    attemptCap: 5,
    consumedAt: null,
    revokedAt: null,
    created_by: null,
    tenant_id: null,
    auth_method: null,
  };
  const file = path.join(path.dirname(materialFile), "pairing.json");
  const records = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { version: 1, sessions: [], clients: [] };
  records.sessions.push(session);
  fs.writeFileSync(file, JSON.stringify(records), { encoding: "utf8", mode: 0o600 });
  return { code, sessionId };
}

/** `n` characters from the unambiguous alphabet, CSPRNG-drawn. */
function randomCode(n) {
  const bytes = crypto.randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** The CA fingerprint an operator reads out, in the conventional colon hex. */
function fingerprintOf(caCertPem) {
  return new X509Certificate(caCertPem).fingerprint256.toUpperCase();
}
