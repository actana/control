// Core process entry — the PTY manager + core-link WebSocket server.
//
// Built by esbuild into dist/core-entry.cjs and run by a plain `node`
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
//   AC_CORE_REMOTE=1            — enable remote mode (mTLS + auth)
//   AC_CORE_PUBLIC_HOST=<host>  — the reachable host for the cert SAN + blob
//                                     endpoint (default: AC_CORE_LINK_HOST)
//   AC_CORE_BEARER_SECRET=<hex> — HMAC key for the bearer (default: random)
//   AC_CORE_ID=<id>        — coreId in the bearer (default: random)
//   AC_CORE_BEARER_DAYS=<n>     — bearer validity in days (default: 365)
//   AC_CORE_MATERIAL_FILE=<path> — persisted cert material + bearer secret.
//                                     When set, the daemon restarts with the
//                                     same CA + certs + bearer secret + coreId
//                                     — required for the auto-start reboot
//                                     path (ADR 0003). Present: load, print
//                                     nothing (on metal the operator already
//                                     has the blob from `actana setup`).
//                                     Absent: mint, persist and print the blob
//                                     once — first run in a container, where
//                                     `actana setup` never runs (ADR 0016
//                                     D13/D17).
//
// Container mode (ADR 0016 D15/D16 — baked into the Core image):
//   ACTANA_CONTAINER=1  — this Core is a container. Two effects here: the
//                            first-run blob prints human-readably instead of
//                            behind the sentinel, because the reader is an
//                            operator tailing `docker compose logs` rather
//                            than a supervising parent parsing stdout; and
//                            the public host becomes required, below.
//   ACTANA_LABEL=<text> — human-friendly alias carried in the blob.
//
// The operator sets `ACTANA_PUBLIC_HOST`, which `actana daemon` hands down as
// `AC_CORE_PUBLIC_HOST`. Missing, the boot stops here rather than defaulting to
// the bind address — a Core with a guessed SAN pairs with nothing.
//
// Prints "@@AC_CORE_LISTENING@@" on stdout once the WS server is listening,
// so the parent can resolve boot readiness (mirrors server-runner.mjs). In
// remote mode also prints "@@AC_CORE_REGISTRATION_BLOB@@<base64>" — the
// single paste artifact the operator copies into the Panel's "Add Core"
// (ADR 0003). A supervising parent swallows both lines; a
// `core install` flow captures the blob line for the operator.

import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import {
  PtyCore,
  ensureClaudeShiftEnterBinding,
  type PtyCoreDeps,
} from "./pty-manager";
import { PtyCoreLinkServer } from "./pty-core-link-server";
import { buildCoreFileRoutes, shouldAnnounceFiles } from "./core-files-wiring";
import { buildCorePairingRoutes, composeCoreHttpRoutes, isPairingPath } from "./core-pairing-wiring";
import type { CorePairingRoutesOptions } from "./core-pairing-routes";
import { PairingStore, pairingStorePath } from "@actana/shared/pairing-store";
import { createDirectory, listDirectory } from "./directory-browse";
import { runCoreExec } from "./core-exec";
import { configureProjectRootsDb } from "./project-roots";
import {
  configureEventLogStore,
  disposeEventLogStore,
  getLastEventId,
  readEventTail,
  appendEvent,
} from "./event-log-store";
import {
  configureCoreQueryStore,
  disposeCoreQueryStore,
  coreQueryStore,
  listActiveTasks,
} from "./core-query-store";
import {
  configureCoreMutationStore,
  disposeCoreMutationStore,
  coreMutationStore,
  setLivePtyProbe,
} from "./core-mutation-store";
import type { PtyHookEnv } from "./pty-hook-env";
import { CoreTaskWriter } from "./core-task-writer";
import { CoreHarnessStatus } from "./core-harness-status";
import { CoreTitleGenerator } from "./core-title-generator";
import { startHarnessHookReceiver, type HarnessHookReceiver } from "./harness-hook-receiver";
import { HookDeliveryMonitor, hookMissLogPath } from "./harness-hook-delivery";
import { sweepStrandedSessions } from "./core-session-sweep";
import { CoreSessionBackstop } from "./core-session-backstop";
import { generateCertMaterial } from "@actana/shared/core-cert-material";
import { verifyBearer, type BearerSecret } from "@actana/shared/core-link-bearer";
import {
  buildRegistrationBlob,
  formatRegistrationBlobNotice,
  loadOrMintMaterial,
  registrationBlobPath,
  type LoadOrMintResult,
} from "./core-first-run";
import { registerSelfWithLocalCli } from "./core-self-register";
import {
  CONTAINER_PUBLIC_HOST_ENV,
  coreUpdateCommand,
  inContainer,
} from "@actana/shared/actana-container-contract";
import {
  updateCheckCachePath,
  updateNoticeStatePath,
} from "@actana/shared/actana-state-paths";
import { readCoreManifest } from "@actana/shared/actana-manifest";
import { nodeReleaseFetcher } from "@actana/shared/actana-release-fetch";
import { startUpdateNotice } from "./core-update-notice";
import log from "@actana/shared/log";
import { bootstrapCoreDb } from "./core-db-bootstrap";
import { HarnessAvailabilityStore } from "@actana/shared/harness-availability-store";
import { HarnessSkillWatcher } from "./harness-skill-watcher";
import { ensureOrchestrationSkill } from "./orchestration-skill";
import { HarnessInstallService } from "./harness-install-service";
import { daemonHarnessSystem } from "./core-harness-system";

const CORE_LISTENING_SENTINEL = "@@AC_CORE_LISTENING@@";
const REGISTRATION_BLOB_SENTINEL = "@@AC_CORE_REGISTRATION_BLOB@@";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[core-entry] ${name} env not set`);
    process.exit(1);
  }
  return value;
}

async function startCore(): Promise<void> {
  const userDataDir = requiredEnv("AC_USER_DATA_DIR");
  const appPath = requiredEnv("AC_APP_PATH");
  const port = Number(requiredEnv("AC_CORE_LINK_PORT"));
  const host = process.env.AC_CORE_LINK_HOST || "127.0.0.1";
  const remoteMode = process.env.AC_CORE_REMOTE === "1";
  // Baked into the Core image, never sniffed from `/.dockerenv` (ADR 0016 D16).
  // Read through `actana-container`, which owns the marker for the whole Core.
  const containerMode = inContainer(process.env);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`[core-entry] invalid AC_CORE_LINK_PORT: ${port}`);
    process.exit(1);
  }

  // On a core-only VM (remote mode, no sibling stateful server) the Core
  // owns bringing up `missioncontrol.db`. Do it BEFORE configuring any store
  // or starting the WS server — a store opened against a missing/empty file
  // otherwise spams `event-log.open-failed` every 500 ms and every read frame
  // returns `[]` against no real schema. Failure here exits non-zero rather
  // than degrading into that broken-boot loop. In loopback mode the sibling
  // server-runner owns bootstrap, so this is skipped to avoid double-running
  // the DDL (SQLite's WAL tolerates it, but it's still wasted work).
  if (remoteMode) {
    try {
      bootstrapCoreDb(userDataDir);
    } catch (err) {
      console.error(`[core-entry] core-db.bootstrap-failed: ${err}`);
      process.exit(1);
    }
  }

  // The project-roots DB is read by the spawn policy to validate cwd. Configure
  // it the same way main.ts does — the core shares the same SQLite file.
  configureProjectRootsDb(userDataDir);
  // The event log lives in the same SQLite file. The Core appends PTY
  // lifecycle events (pty:spawn / pty:exit) and serves the reconnect replay
  // tail; the stateful server process appends task/session/hook events to the
  // same append-only table.
  configureEventLogStore(userDataDir);
  // The query store reads projects + tasks from the same SQLite (read-only) so
  // the `projectsList` / `tasksList` core-link frames return live snapshots
  // with no Panel-side persistence (issue 07 — per-Core navigation + Fleet
  // view).
  configureCoreQueryStore(userDataDir);
  // The mutation store writes projects + tasks against the same SQLite
  // (read-write) so the `projectsMutate` / `tasksMutate` / `sessionsList`
  // core-link frames execute the write path directly on the Core (issue
  // 04, ADR 0004). WAL absorbs coexistence with the event-log writer.
  configureCoreMutationStore(userDataDir);

  // ─── Harness status detection (issue 84) ───
  // The Core owns its task rows, so the Core is what a harness's hooks report
  // to and what settles a Session whose process died. One writer underneath
  // all of it, so every change appends the event the Panel's card re-renders
  // from — and does so whether or not a Panel is connected.
  const taskWriter = new CoreTaskWriter({
    mutationPort: coreMutationStore,
    queryPort: coreQueryStore,
    eventLog: { appendEvent, readEventTail, getLastEventId },
  });
  // Boot reconciliation (issue 243). This Core's PTYs did not survive whatever
  // ended the last process, so every row still claiming `running` /
  // `needs-input` is an orphan of that run — no exit callback fired for any of
  // them. Swept here: after the writer exists (each settle appends the event a
  // Panel re-renders from) and before the PTY core, the hook receiver or the
  // core-link server can produce a Session of THIS run that would be in scope.
  sweepStrandedSessions({ listActiveTasks, writer: taskWriter });

  const titleGenerator = new CoreTitleGenerator({ writer: taskWriter });
  const harnessStatus = new CoreHarnessStatus({
    writer: taskWriter,
    generateTitle: (taskId, prompt) => titleGenerator.schedule(taskId, prompt),
  });

  // Loopback only, ephemeral port, token minted here — see the decisions
  // recorded at the top of harness-hook-receiver.ts. A receiver that cannot
  // start is not fatal: hooks go uninstalled, the Panel is told so, and its
  // terminal-input fallback carries the `running` signal instead.
  // Assigned once the PTY core exists (it probes live PTYs); every producer of
  // "this Session is still talking" reaches it through this binding.
  let sessionBackstop: CoreSessionBackstop | null = null;

  let hookReceiver: HarnessHookReceiver | null = null;
  try {
    hookReceiver = await startHarnessHookReceiver((taskId, payload, eventNameFallback) => {
      // A hook that landed is this Session talking, whatever it said — that is
      // what keeps the quiet-Session backstop off a turn that is really
      // running (issue 243).
      sessionBackstop?.noteActivity(taskId);
      return harnessStatus.receiveHook(taskId, payload, eventNameFallback);
    });
  } catch (err) {
    console.error(`[core-entry] hook-receiver.start-failed: ${err}`);
  }

  // The other end of the same conversation (issue 243). A hook that never got
  // an ack records one line in this file; this folds those lines into the
  // Core's log with a running total, starting with whatever was recorded while
  // this process was not running — a restart is exactly when hooks are
  // refused, and those are the drops nobody could otherwise hear about.
  const hookDelivery = new HookDeliveryMonitor({ missLogPath: hookMissLogPath(userDataDir) });
  hookDelivery.start();

  const deps: PtyCoreDeps = {
    userDataDir,
    appPath,
    getHookEnv: (): PtyHookEnv | null =>
      hookReceiver
        ? {
            apiUrl: hookReceiver.url,
            token: hookReceiver.token,
            missLogPath: hookMissLogPath(userDataDir),
          }
        : null,
    // Protect the core-link WS port so killLaunchProcesses never touches it —
    // and the hook receiver's, for the same reason: killing it would silently
    // strand every running Session's status.
    getProtectedPorts: () => [port, hookReceiver?.port],
    onSessionExit: ({ taskId, exitCode }) => {
      harnessStatus.sessionExited(taskId, exitCode);
      sessionBackstop?.forget(taskId);
    },
    onSessionOutputSignal: ({ taskId, signal }) => harnessStatus.outputSignal(taskId, signal),
    // A harness that is working redraws its spinner into the PTY about once a
    // second. Silence there, and no hooks either, is what the backstop below
    // reads as "this turn ended and nobody said so" (issue 243).
    onSessionOutputActivity: ({ taskId }) => sessionBackstop?.noteActivity(taskId),
  };

  // Eagerly install Claude Code's Shift+Enter keybinding flag for terminals
  // spawned by this Core (best-effort; see ensureClaudeShiftEnterBinding).
  ensureClaudeShiftEnterBinding();

  const core = new PtyCore(deps);

  // Enrich `sessionsList` with live PTY ids: a task is "reattachable" when the
  // Core's PTY core currently has a running PTY for it. Wired here so the
  // mutation store has no import-time dependency on `PtyCore`.
  setLivePtyProbe((taskId) => core.findByTask(taskId).ptyId);

  // The unconditional half of issue 243. `armDeferredFinish` only ever fires
  // for a Session whose hook ARRIVED; when the terminal `Stop` is the POST
  // that dropped, nothing is armed at all. This one arms nothing: it asks the
  // database once a minute which rows still claim to be working, and settles
  // the ones that have gone quiet — no hook, no output — for long enough that
  // the turn is provably over.
  sessionBackstop = new CoreSessionBackstop({
    listActiveTasks,
    writer: taskWriter,
    hasLivePty: (taskId) => Boolean(core.findByTask(taskId).ptyId),
  });
  sessionBackstop.start();

  // Issue 11: this Core probes its own PATH for every managed Harness and
  // publishes the resulting map as (a) a live snapshot readable via the
  // `agentsAvailabilityList` frame and (b) an `agents:availabilityChanged`
  // event appended to the same monotonic event log the PTY / project / task
  // lifecycle events use. Loopback and remote Cores emit the identical shape
  // so the Panel's per-Core availability store is oblivious to which Core
  // answered. Started after `configureEventLogStore` has run — the first
  // probe emits an event.
  // ADR 0031 D6/D7: the product's own orchestration skill goes into this
  // machine's Harness skill directories — this machine, because a remote Core's
  // Harnesses are nowhere near the laptop that drives it. Once at boot, and
  // again whenever a Harness this Core had not seen becomes available.
  //
  // The watcher is wired by teeing the store's own append rather than by
  // re-reading the log, which is what makes ADR 0031 D7's replay guard cheap to
  // hold: it sees each event once, in order, as it is produced. The guard is
  // there anyway, because "this is only ever fed live events" is a property of
  // this one call site and not of the class.
  ensureOrchestrationSkill(os.homedir());
  const skillWatcher = new HarnessSkillWatcher({
    ensure: () => ensureOrchestrationSkill(os.homedir()),
  });
  const availabilityStore = new HarnessAvailabilityStore({
    appendEvent: (kind, payload, opts) => {
      const eventId = appendEvent(kind, payload, opts);
      skillWatcher.observe(kind, payload, eventId);
      return eventId;
    },
  });
  availabilityStore.start();

  // Installer issue 05: `actana harnesses install` puts a new CLI on PATH while
  // this daemon is running. The 60s tick would find it eventually; SIGHUP is
  // how the CLI says "now", so a Panel sees the agent it just installed
  // without a restart and without a wait. Unknown senders cost one probe.
  process.on("SIGHUP", () => availabilityStore.runProbe());

  // Issue 83 (ADR 0021): the Panel can now ask this Core to install a Harness
  // it found missing. Same non-interactive path `actana harnesses install <id>`
  // takes, and the same re-probe afterwards — the difference is only who asked.
  // `os.homedir()` is the daemon's own operator, whose login PATH the install
  // writes; the daemon runs as that operator on metal and in the container.
  const harnessInstalls = new HarnessInstallService({
    availability: () => availabilityStore.snapshot(),
    reprobe: () => availabilityStore.runProbe(),
    system: daemonHarnessSystem(),
    platform: process.platform,
    homeDir: os.homedir(),
  });

  // ─── mTLS + bearer auth (issue 04) ───
  // In remote mode the Core presents a server cert, pins the CA, requires a
  // Panel client cert, and gates every frame behind a verified bearer. In
  // loopback mode (default) the server stays plain `ws://` and trusted — no
  // auth, no TLS, exactly as before.
  // Set by the remote-mode block below when this Core has persisted material —
  // the only shape of Core that can pair (#282). Left null otherwise, which is
  // what keeps a loopback Core's TLS posture and route list exactly as they
  // were.
  let pairing: CorePairingRoutesOptions | null = null;

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
    queryPort: coreQueryStore,
    // Issue 04 (ADR 0004): back the `projectsMutate` / `tasksMutate` /
    // `sessionsList` frames with the same SQLite (read-write). The Core
    // process is the sole VM-side writer; WAL keeps the event-log writer
    // and this writer coexisting on one DB.
    mutationPort: coreMutationStore,
    // One write seam for the Panel's `tasksMutate` and the Core's own hook /
    // exit / title writes (issue 84).
    taskWriter,
    // Cursor never fires `beforeSubmitPrompt`, so the Panel reads the prompt
    // off the terminal and hands it here — the only way a Core-owned Cursor
    // Session gets named at all (issue 84).
    promptPort: {
      submitted: (taskId, prompt) => titleGenerator.schedule(taskId, prompt),
    },
    // Issue 11: back the `agentsAvailabilityList` frame with the current
    // snapshot from the Core's own PATH probe. The event stream carries
    // deltas; this snapshot answers the fresh-Panel hydration path.
    availabilityPort: {
      snapshot: () => availabilityStore.snapshot(),
    },
    // Issue 83: the `harnessInstall` frame's other end. Acked immediately by
    // the server and run in the background, so a vendor installer taking
    // minutes never holds the link.
    installPort: {
      installable: (harnessId) => harnessInstalls.installable(harnessId),
      install: (harnessId) => harnessInstalls.install(harnessId),
    },
    // Web-panel issue 06: the Panel's folder picker browses THIS machine's
    // disk. The browser has none to offer and the operator's laptop is the
    // wrong one — a Project's path is a VM path, so the Core serves and
    // validates every listing.
    directoryPort: {
      list: (requestedPath) => listDirectory(requestedPath),
      create: (parent, name) => createDirectory(parent, name),
    },
    // Issue 266: `actana core exec` runs one command here, non-interactively.
    // It grants nothing `core shell` does not already grant — same blob, same
    // link, same class of process — and it is more auditable, because it
    // arrives through this Core's own authentication instead of through a
    // `docker exec` on the host that this Core never sees.
    execPort: {
      run: (input) => runCoreExec(input),
    },
  };

  if (remoteMode) {
    // In a container the public host is the operator's to supply and never
    // ours to guess (ADR 0016 D15): it is baked into the server certificate's
    // SAN and into every pairing token, so falling back to the bind address
    // would mint a Core no Panel can verify. `actana daemon` translates
    // `ACTANA_PUBLIC_HOST` into `AC_CORE_PUBLIC_HOST` before it gets here; this
    // is the same refusal one layer down, for anything that execs the daemon
    // bundle directly.
    if (containerMode && !process.env.AC_CORE_PUBLIC_HOST) {
      console.error(
        `[core-entry] ${CONTAINER_PUBLIC_HOST_ENV} is not set, and this Core will not ` +
          "guess the address a Panel dials. Set it to the host or IP your Panel reaches " +
          `this container on:\n  ${CONTAINER_PUBLIC_HOST_ENV}=core1.example.com`,
      );
      process.exit(1);
    }
    const publicHost = process.env.AC_CORE_PUBLIC_HOST || host;
    const materialFile = process.env.AC_CORE_MATERIAL_FILE;
    const bearerDays = Number(process.env.AC_CORE_BEARER_DAYS ?? 365);
    const label = process.env.ACTANA_LABEL || "";

    if (materialFile) {
      // Persisted-material path: the daemon was started by the auto-start unit
      // (or the container's ENTRYPOINT) with a material file. Present, it is
      // loaded so the CA + certs + bearer secret + coreId match what the
      // operator pasted into the Panel — a rebooted machine must resume the
      // same identity, not generate fresh certs. Absent, this is a first run
      // with no `actana setup` behind it (ADR 0016 D17) and the daemon mints,
      // persists and prints the blob itself.
      let resolved: LoadOrMintResult;
      try {
        resolved = await loadOrMintMaterial({
          materialFile,
          publicHost,
          // `host` is the bind address standing in for an answer the operator
          // did not give — enough to mint a first identity from, never enough
          // to re-sign an existing one's SAN with.
          publicHostDeclared: Boolean(process.env.AC_CORE_PUBLIC_HOST),
          port,
          label,
          bearerDays,
        });
      } catch (err) {
        console.error(`[core-entry] ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      const { material, blob, certAction } = resolved;
      const secret: BearerSecret = material.bearerSecret;

      // The pre-auth pairing endpoint (#282). Mounted only on this path, and
      // that is the whole of the condition: pairing needs a CA key to sign
      // with, a stable UUID to put in the bearers it issues, and a file the
      // operator's `actana pair new` and this daemon can both see — all three
      // are the persisted material, and a daemon started without one has
      // nowhere for a session to live.
      pairing = {
        material: {
          caCert: material.caCert,
          caKey: material.caKey,
          bearerSecret: material.bearerSecret,
          coreId: material.coreId,
          coreUuid: material.coreUuid,
        },
        sessions: new PairingStore(pairingStorePath(materialFile)),
        endpoint: `wss://${publicHost}:${port}`,
        bearerDays,
      };

      serverOpts.tls = {
        caCert: material.caCert,
        serverCert: material.serverCert,
        serverKey: material.serverKey,
      };
      serverOpts.authVerifier = (b) => verifyBearer(b, secret);

      // A moved public host keeps the identity and re-signs the cert for the
      // new address (D18), so this is not a pairing event — but the Panel is
      // still dialling the old address, so say where the fresh token is.
      if (certAction === "moved") {
        console.log(
          `[core-entry] public host is now ${publicHost} — re-issued this Core's server ` +
            "certificate from its existing CA. Pairing credentials are unchanged; update " +
            `this Core's address in your Panel, or re-pair with the token in ` +
            `${registrationBlobPath(materialFile)}.`,
        );
      }

      // #288 D9, criterion 3: a containerised Core wires itself to the `actana`
      // on its own machine, because the image is the install and `actana setup`
      // — which does this on metal — is refused here. Without it a Session
      // started on this Core finds an empty registry and cannot address the
      // Core it is running on, and the `actana-sessions` skill installed a few
      // lines below states the opposite as a fact. Not gated on `blob`: a
      // volume that predates this has material but no registry entry, and this
      // is the boot that fixes it. See `core-self-register.ts`.
      if (containerMode) {
        const registered = registerSelfWithLocalCli({
          material,
          bindHost: host,
          port,
          label,
          bearerDays,
          env: process.env,
          home: os.homedir(),
        });
        if (!registered.ok) {
          // Serving Panels does not depend on this, so a registry that cannot
          // be written is reported and stepped over rather than fatal.
          console.error(
            `[core-entry] could not register this Core with the \`actana\` on its own machine: ` +
              `${registered.error}. \`actana core ls\` here will be empty; the pairing token in ` +
              `${registrationBlobPath(materialFile)} still works from anywhere.`,
          );
        } else if (registered.wiring.selected) {
          console.log(
            `[core-entry] registered this Core with this machine's \`actana\` as ` +
              `${registered.wiring.name} (${registered.endpoint}) and selected it.`,
          );
        } else {
          console.log(
            `[core-entry] registered this Core with this machine's \`actana\` as ` +
              `${registered.wiring.name} (${registered.endpoint}). ` +
              `\`current\` still points at ${registered.wiring.keptSelection} — ` +
              `\`actana core use ${registered.wiring.name}\` switches to this one.`,
          );
        }
      }

      // Printed only when this boot minted the identity. On every later boot
      // `blob` is null: the operator has already paired, and a second blob in
      // the log reads as "this Core moved".
      if (blob !== null) {
        console.log(
          containerMode
            ? formatRegistrationBlobNotice(blob, registrationBlobPath(materialFile))
            : `${REGISTRATION_BLOB_SENTINEL}${blob}`,
        );
      }
    } else {
      // Fresh-material path (issue 04 backward-compat): generate new certs +
      // bearer, print the registration blob for the operator to capture. Used
      // when the daemon is invoked directly without a persisted material file.
      const mat = await generateCertMaterial({ host: publicHost });
      const secretHex = process.env.AC_CORE_BEARER_SECRET ?? randomBytes(32).toString("hex");
      const secret: BearerSecret = secretHex;
      const coreId = process.env.AC_CORE_ID ?? `core_${randomBytes(8).toString("hex")}`;

      serverOpts.tls = {
        caCert: mat.ca.cert,
        serverCert: mat.server.cert,
        serverKey: mat.server.key,
      };
      serverOpts.authVerifier = (b) => verifyBearer(b, secret);

      // Print the registration blob first so the operator can capture it
      // before the "listening" line resolves boot readiness.
      const blob = buildRegistrationBlob(
        {
          caCert: mat.ca.cert,
          clientCert: mat.client.cert,
          clientKey: mat.client.key,
          coreId,
          bearerSecret: secretHex,
        },
        { publicHost, port, label, bearerDays },
      );
      console.log(`${REGISTRATION_BLOB_SENTINEL}${blob}`);
    }
  }

  // Issue 165: the `/v1/…` file routes, mounted on the same HTTPS server the
  // core link is on (ADR 0028). Built here rather than inside the server, next
  // to the query store they read Project roots from — the core-link server
  // mounts whatever HTTP surface it is handed and never imports the tar codec.
  //
  // **After** the remote-mode block, not before it, and that ordering is the
  // fix for a real defect rather than tidiness. Built earlier, the routes could
  // only be handed a closure that reached for `serverOpts.authVerifier` later —
  // and that closure was never *absent*, it just answered `{ ok: false }`. So
  // the default loopback Core announced `files: { version: 1 }` on `ready` and
  // then 401'd every request against it: exactly what ADR 0028 D4 says is worse
  // than announcing nothing. Resolving the material first means the verifier
  // can be passed by value, and "loopback" can be the absence it is documented
  // to be. `buildCoreFileRoutes` holds the rule and is tested directly.
  //
  // The lookup is a scan of the project list rather than a `WHERE id = ?`, and
  // deliberately: a Core holds a handful of Projects, `listProjects` is the read
  // seam that already exists and already degrades to `[]` on a broken DB, and a
  // second by-id query in `@actana/shared` would be a second thing to keep in
  // step with the first. If a Core ever holds enough Projects for this to
  // matter, the fix is an index in SQLite, not a cache here — the filesystem is
  // the model (ADR 0027) and this is the one lookup that is not the filesystem.
  const fileRoutes = buildCoreFileRoutes({
    filesPort: {
      projectRoot: (projectId) =>
        coreQueryStore.listProjects().find((project) => project.projectId === projectId)?.path ?? null,
    },
    ...(serverOpts.authVerifier ? { authVerifier: serverOpts.authVerifier } : {}),
  });
  // The pairing family goes first, and `composeCoreHttpRoutes` documents why:
  // the file routes claim the whole `/v1/` prefix and would answer
  // `/v1/pair/redeem` with the 401 a client without a bearer gets — which is
  // every client that is here to be given one.
  //
  // `announceFiles` stays a statement about the *file* routes. The composed
  // surface is no longer only them, so the default ("yes if any HTTP surface is
  // mounted") would now be announcing a capability on the strength of a
  // pairing endpoint — the exact confusion ADR 0028 D4 warns about.
  serverOpts.httpRoutes = pairing
    ? composeCoreHttpRoutes(buildCorePairingRoutes(pairing), fileRoutes)
    : fileRoutes;
  serverOpts.announceFiles = shouldAnnounceFiles(fileRoutes);
  // What the mTLS gate is allowed to serve without a client certificate. Absent
  // unless pairing is mounted, and absent means the handshake keeps refusing
  // uncertificated clients outright — see `core-preauth-gate.ts`.
  if (pairing) serverOpts.isPreAuthPath = isPairingPath;

  const server = new PtyCoreLinkServer(core, serverOpts);

  // Alert-only, once a day, into this daemon's log — never a frame the Panel
  // raises and never an update this process applies (ADR 0010).
  //
  // No manifest means no check at all, never a placeholder version: every
  // release is newer than an invented `0.0.0`, so guessing would make a daemon
  // that cannot read its own manifest announce an update on every boot.
  const ownVersion = readCoreManifest(path.resolve(__dirname, ".."))?.version ?? null;
  const updateNotice = ownVersion
    ? startUpdateNotice({
        current: ownVersion,
        fetcher: nodeReleaseFetcher(),
        cachePath: updateCheckCachePath(userDataDir),
        noticePath: updateNoticeStatePath(userDataDir),
        env: process.env,
        now: () => Date.now(),
        log: (message) => log.info(message),
        remedy: coreUpdateCommand(containerMode),
      })
    : null;

  // Clean up on shutdown.
  const shutdown = () => {
    core.killAll();
    server.close();
    hookReceiver?.close();
    hookDelivery.stop();
    sessionBackstop?.stop();
    availabilityStore.stop();
    updateNotice?.stop();
    disposeEventLogStore();
    disposeCoreQueryStore();
    disposeCoreMutationStore();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // The sentinel is printed on the next tick so the WS server has definitely
  // bound the port before the parent resolves readiness.
  process.nextTick(() => {
    console.log(CORE_LISTENING_SENTINEL);
  });
}

void startCore().catch((err) => {
  console.error("[core-entry] startup failed:", err);
  process.exit(1);
});
