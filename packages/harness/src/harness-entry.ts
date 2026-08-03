// Harness process entry — the PTY manager + core-link WebSocket server.
//
// Built by esbuild into dist/harness-entry.cjs and run by a plain `node`
// binary on the standard Node ABI (node-pty and better-sqlite3 use their
// normal prebuilds/builds).
//
// Env vars:
//   AC_USER_DATA_DIR  — the user-data dir
//   AC_APP_PATH       — the app path
//   AC_CORE_LINK_PORT — the port to listen on for the core-link WebSocket
//   AC_CORE_LINK_HOST — the host to bind to (default: 127.0.0.1)
//
// Remote mode (issue 04 — `wss://` + mTLS + bearer auth):
//   AC_HARNESS_REMOTE=1            — enable remote mode (mTLS + auth)
//   AC_HARNESS_PUBLIC_HOST=<host>  — the reachable host for the cert SAN + blob
//                                     endpoint (default: AC_CORE_LINK_HOST)
//   AC_HARNESS_BEARER_SECRET=<hex> — HMAC key for the bearer (default: random)
//   AC_HARNESS_CORE_ID=<id>        — coreId in the bearer (default: random)
//   AC_HARNESS_BEARER_DAYS=<n>     — bearer validity in days (default: 365)
//   AC_HARNESS_MATERIAL_FILE=<path> — load persisted cert material + bearer
//                                     secret from this file (issue 05). When
//                                     set, the daemon restarts with the same
//                                     CA + certs + bearer secret + coreId —
//                                     required for the auto-start reboot path
//                                     (ADR 0003). The blob is NOT printed in
//                                     this mode; the operator already has it
//                                     from `harness install`.
//
// Prints "@@AC_HARNESS_LISTENING@@" on stdout once the WS server is listening,
// so the parent can resolve boot readiness (mirrors server-runner.mjs). In
// remote mode also prints "@@AC_HARNESS_REGISTRATION_BLOB@@<base64>" — the
// single paste artifact the operator copies into the Panel's "Add Core"
// (ADR 0003). A supervising parent swallows both lines; a
// `harness install` flow captures the blob line for the operator.

import { randomBytes } from "node:crypto";
import {
  PtyHarnessCore,
  ensureClaudeShiftEnterBinding,
  type PtyHarnessDeps,
} from "./pty-manager";
import { PtyCoreLinkServer } from "./pty-core-link-server";
import { createDirectory, listDirectory } from "./directory-browse";
import { configureProjectRootsDb } from "./project-roots";
import {
  configureEventLogStore,
  disposeEventLogStore,
  getLastEventId,
  readEventTail,
  appendEvent,
} from "./event-log-store";
import {
  configureHarnessQueryStore,
  disposeHarnessQueryStore,
  harnessQueryStore,
} from "./harness-query-store";
import {
  configureHarnessMutationStore,
  disposeHarnessMutationStore,
  harnessMutationStore,
  setLivePtyProbe,
} from "./harness-mutation-store";
import type { PtyHookEnv } from "./pty-hook-env";
import { generateCertMaterial } from "./harness-cert-material";
import { signBearer, verifyBearer, type BearerSecret } from "../../shared/src/core-link-bearer";
import { encodeRegistrationBlob } from "../../shared/src/registration-blob";
import { loadMaterialFromFile } from "./harness-material-store";
import { bootstrapHarnessDb } from "./harness-db-bootstrap";
import { HarnessAvailabilityStore } from "./harness-availability-store";

const HARNESS_LISTENING_SENTINEL = "@@AC_HARNESS_LISTENING@@";
const REGISTRATION_BLOB_SENTINEL = "@@AC_HARNESS_REGISTRATION_BLOB@@";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[harness-entry] ${name} env not set`);
    process.exit(1);
  }
  return value;
}

async function startHarness(): Promise<void> {
  const userDataDir = requiredEnv("AC_USER_DATA_DIR");
  const appPath = requiredEnv("AC_APP_PATH");
  const port = Number(requiredEnv("AC_CORE_LINK_PORT"));
  const host = process.env.AC_CORE_LINK_HOST || "127.0.0.1";
  const remoteMode = process.env.AC_HARNESS_REMOTE === "1";

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`[harness-entry] invalid AC_CORE_LINK_PORT: ${port}`);
    process.exit(1);
  }

  // On a harness-only VM (remote mode, no sibling stateful server) the Harness
  // owns bringing up `missioncontrol.db`. Do it BEFORE configuring any store
  // or starting the WS server — a store opened against a missing/empty file
  // otherwise spams `event-log.open-failed` every 500 ms and every read frame
  // returns `[]` against no real schema. Failure here exits non-zero rather
  // than degrading into that broken-boot loop. In loopback mode the sibling
  // server-runner owns bootstrap, so this is skipped to avoid double-running
  // the DDL (SQLite's WAL tolerates it, but it's still wasted work).
  if (remoteMode) {
    try {
      bootstrapHarnessDb(userDataDir);
    } catch (err) {
      console.error(`[harness-entry] harness-db.bootstrap-failed: ${err}`);
      process.exit(1);
    }
  }

  // The project-roots DB is read by the spawn policy to validate cwd. Configure
  // it the same way main.ts does — the harness shares the same SQLite file.
  configureProjectRootsDb(userDataDir);
  // The event log lives in the same SQLite file. The Harness appends PTY
  // lifecycle events (pty:spawn / pty:exit) and serves the reconnect replay
  // tail; the stateful server process appends task/session/hook events to the
  // same append-only table.
  configureEventLogStore(userDataDir);
  // The query store reads projects + tasks from the same SQLite (read-only) so
  // the `projectsList` / `tasksList` core-link frames return live snapshots
  // with no Panel-side persistence (issue 07 — per-Core navigation + Fleet
  // view).
  configureHarnessQueryStore(userDataDir);
  // The mutation store writes projects + tasks against the same SQLite
  // (read-write) so the `projectsMutate` / `tasksMutate` / `sessionsList`
  // core-link frames execute the write path directly on the Harness (issue
  // 04, ADR 0004). WAL absorbs coexistence with the event-log writer.
  configureHarnessMutationStore(userDataDir);

  const deps: PtyHarnessDeps = {
    userDataDir,
    appPath,
    getHookEnv: (): PtyHookEnv | null => null,
    // Protect the core-link WS port so killLaunchProcesses never touches it.
    getProtectedPorts: () => [port],
  };

  // Eagerly install Claude Code's Shift+Enter keybinding flag for terminals
  // spawned by this Harness (best-effort; see ensureClaudeShiftEnterBinding).
  ensureClaudeShiftEnterBinding();

  const core = new PtyHarnessCore(deps);

  // Enrich `sessionsList` with live PTY ids: a task is "reattachable" when the
  // Harness's PTY core currently has a running PTY for it. Wired here so the
  // mutation store has no import-time dependency on `PtyHarnessCore`.
  setLivePtyProbe((taskId) => core.findByTask(taskId).ptyId);

  // Issue 11: this Core probes its own PATH for every managed agent CLI and
  // publishes the resulting map as (a) a live snapshot readable via the
  // `agentsAvailabilityList` frame and (b) an `agents:availabilityChanged`
  // event appended to the same monotonic event log the PTY / project / task
  // lifecycle events use. Loopback and remote Cores emit the identical shape
  // so the Panel's per-Core availability store is oblivious to which Core
  // answered. Started after `configureEventLogStore` has run — the first
  // probe emits an event.
  const availabilityStore = new HarnessAvailabilityStore({ appendEvent });
  availabilityStore.start();

  // Installer issue 05: `actana agents install` puts a new CLI on PATH while
  // this daemon is running. The 60s tick would find it eventually; SIGHUP is
  // how the CLI says "now", so a Panel sees the agent it just installed
  // without a restart and without a wait. Unknown senders cost one probe.
  process.on("SIGHUP", () => availabilityStore.runProbe());

  // ─── mTLS + bearer auth (issue 04) ───
  // In remote mode the Harness presents a server cert, pins the CA, requires a
  // Panel client cert, and gates every frame behind a verified bearer. In
  // loopback mode (default) the server stays plain `ws://` and trusted — no
  // auth, no TLS, exactly as before.
  const serverOpts: import("./pty-core-link-server").PtyCoreLinkServerOptions = {
    port,
    host,
    eventLog: {
      appendEvent,
      readEventTail,
      getLastEventId,
    },
    // Issue 07: back the `projectsList` / `tasksList` frames with the shared
    // SQLite so the Panel renders live project/task snapshots per Core.
    queryPort: harnessQueryStore,
    // Issue 04 (ADR 0004): back the `projectsMutate` / `tasksMutate` /
    // `sessionsList` frames with the same SQLite (read-write). The Harness
    // process is the sole VM-side writer; WAL keeps the event-log writer
    // and this writer coexisting on one DB.
    mutationPort: harnessMutationStore,
    // Issue 11: back the `agentsAvailabilityList` frame with the current
    // snapshot from the Harness's own PATH probe. The event stream carries
    // deltas; this snapshot answers the fresh-Panel hydration path.
    availabilityPort: {
      snapshot: () => availabilityStore.snapshot(),
    },
    // Web-panel issue 06: the Panel's folder picker browses THIS machine's
    // disk. The browser has none to offer and the operator's laptop is the
    // wrong one — a Project's path is a VM path, so the Harness serves and
    // validates every listing.
    directoryPort: {
      list: (requestedPath) => listDirectory(requestedPath),
      create: (parent, name) => createDirectory(parent, name),
    },
  };

  if (remoteMode) {
    const publicHost = process.env.AC_HARNESS_PUBLIC_HOST || host;
    const materialFile = process.env.AC_HARNESS_MATERIAL_FILE;

    if (materialFile) {
      // Persisted-material path (issue 05): the daemon was started by the
      // auto-start unit (or `harness install`) with a material file written
      // by the install command. Load it so the CA + certs + bearer secret +
      // coreId match what the operator pasted into the Panel — a rebooted VM
      // must resume the same identity, not generate fresh certs.
      const material = loadMaterialFromFile(materialFile);
      if (!material) {
        console.error(`[harness-entry] failed to load material from ${materialFile}`);
        process.exit(1);
      }
      const secret: BearerSecret = material.bearerSecret;

      serverOpts.tls = {
        caCert: material.caCert,
        serverCert: material.serverCert,
        serverKey: material.serverKey,
      };
      serverOpts.authVerifier = (b) => verifyBearer(b, secret);
      // Do NOT print the registration blob — the operator already has it
      // from `harness install`. The daemon just starts with the persisted
      // identity.
    } else {
      // Fresh-material path (issue 04 backward-compat): generate new certs +
      // bearer, print the registration blob for the operator to capture. Used
      // when the daemon is invoked directly without a persisted material file.
      const mat = await generateCertMaterial({ host: publicHost });
      const secretHex = process.env.AC_HARNESS_BEARER_SECRET ?? randomBytes(32).toString("hex");
      const secret: BearerSecret = secretHex;
      const coreId = process.env.AC_HARNESS_CORE_ID ?? `core_${randomBytes(8).toString("hex")}`;
      const bearerDays = Number(process.env.AC_HARNESS_BEARER_DAYS ?? 365);
      const exp = Date.now() + bearerDays * 24 * 60 * 60 * 1000;
      const bearer = signBearer({ coreId, exp }, secret);

      serverOpts.tls = {
        caCert: mat.ca.cert,
        serverCert: mat.server.cert,
        serverKey: mat.server.key,
      };
      serverOpts.authVerifier = (b) => verifyBearer(b, secret);

      // Print the registration blob first so the operator can capture it
      // before the "listening" line resolves boot readiness.
      const blob = encodeRegistrationBlob({
        endpoint: `wss://${publicHost}:${port}`,
        label: "",
        caCert: mat.ca.cert,
        clientCert: mat.client.cert,
        clientKey: mat.client.key,
        bearer,
      });
      console.log(`${REGISTRATION_BLOB_SENTINEL}${blob}`);
    }
  }

  const server = new PtyCoreLinkServer(core, serverOpts);

  // Clean up on shutdown.
  const shutdown = () => {
    core.killAll();
    server.close();
    availabilityStore.stop();
    disposeEventLogStore();
    disposeHarnessQueryStore();
    disposeHarnessMutationStore();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // The sentinel is printed on the next tick so the WS server has definitely
  // bound the port before the parent resolves readiness.
  process.nextTick(() => {
    console.log(HARNESS_LISTENING_SENTINEL);
  });
}

void startHarness().catch((err) => {
  console.error("[harness-entry] startup failed:", err);
  process.exit(1);
});
