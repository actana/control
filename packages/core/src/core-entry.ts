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
//   AC_CORE_LINK_HOST — the host to bind to (default: 127.0.0.1). Outside
//                          remote mode this must be a loopback address: the
//                          server is plain `ws://` and trusts every connection
//                          there, and `core-boot-refusals.ts` says why binding
//                          that anywhere else stops the boot (#348).
//
// Anything named `AC_HARNESS_*` stops the boot outright. Those are the
// pre-rename spellings, this daemon reads none of them, and a machine that
// still sets them is running an auto-start service two renames old — see
// `core-boot-refusals.ts`.
//
// Remote mode (issue 04 — `wss://` + mTLS + bearer auth):
//   AC_CORE_REMOTE=1            — enable remote mode (mTLS + auth)
//   AC_CORE_PUBLIC_HOST=<hosts> — the reachable host for the cert SAN and the
//                                     endpoint, or a comma-separated list of
//                                     them (#347): every entry becomes a SAN,
//                                     the first is the primary and is the
//                                     endpoint a pairing hands back unless the
//                                     code chose another of them
//                                     (default: AC_CORE_LINK_HOST)
//   AC_CORE_BEARER_DAYS=<n>     — bearer validity in days (default: 365)
//   AC_CORE_MATERIAL_FILE=<path> — persisted cert material + bearer secret.
//                                     **Required in remote mode.** The daemon
//                                     restarts with the same CA + certs +
//                                     bearer secret + coreId — required for the
//                                     auto-start reboot path (ADR 0003) — and
//                                     it is also where the pairing sessions
//                                     live, so a remote Core without one could
//                                     enroll nobody. Present: load. Absent:
//                                     mint and persist — first run in a
//                                     container, where `actana setup` never
//                                     runs (ADR 0016 D13/D17).
//
// Container mode (ADR 0016 D15/D16 — baked into the Core image):
//   ACTANA_CONTAINER=1  — this Core is a container. One effect here: the
//                            public host becomes required, below.
//   ACTANA_LABEL=<text> — human-friendly alias for this Core.
//
// The operator sets `ACTANA_PUBLIC_HOST`, which `actana daemon` hands down as
// `AC_CORE_PUBLIC_HOST`. Missing, the boot stops here rather than defaulting to
// the bind address — a Core with a guessed SAN pairs with nothing. One value or
// several, comma-separated, and one value behaves exactly as it always has.
//
// Prints "@@AC_CORE_LISTENING@@" on stdout once the WS server is listening, so
// the parent can resolve boot readiness (mirrors server-runner.mjs). That is the
// only sentinel now: remote mode used to follow it with
// "@@AC_CORE_REGISTRATION_BLOB@@<base64>", the single artifact an operator
// pasted into the Panel's "Add Core", and #287 removed the hand-carry it
// belonged to. A client enrolls with a code from `actana pair new`.

import * as os from "node:os";
import * as path from "node:path";
import {
  PtyCore,
  ensureClaudeShiftEnterBinding,
  type PtyCoreDeps,
} from "./pty-manager";
import { PtyCoreLinkServer } from "./pty-core-link-server";
import { buildCoreFileRoutes, shouldAnnounceFiles } from "./core-files-wiring";
import {
  buildCorePairingRoutes,
  buildPairingEndpointResolver,
  composeCoreHttpRoutes,
  isPairingPath,
} from "./core-pairing-wiring";
import type { CorePairingRoutesOptions } from "./core-pairing-routes";
import { PairingStore, pairingStorePath } from "@actana/shared/pairing-store";
import {
  PairingRevocations,
  startPairingRevocationSweep,
  type PairingRevocationSweep,
} from "./core-pairing-revocation";
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
  listBootSweepTasks,
  taskProvenNeverWorked,
} from "./core-query-store";
import {
  configureCoreMutationStore,
  disposeCoreMutationStore,
  coreMutationStore,
  setLivePtyProbe,
} from "./core-mutation-store";
import type { PtyHookEnv } from "./pty-hook-env";
import {
  SESSION_PROMPT_ABANDONED_EVENT_KIND,
  SESSION_PROMPT_DELIVERED_EVENT_KIND,
  type CoreLinkSessionPromptAbandonedPayload,
  type CoreLinkSessionPromptDeliveredPayload,
} from "@actana/sdk/core-link-frames";
import { CoreTaskWriter } from "./core-task-writer";
import { CoreHarnessStatus } from "./core-harness-status";
import { CoreTitleGenerator } from "./core-title-generator";
import { startHarnessHookReceiver, type HarnessHookReceiver } from "./harness-hook-receiver";
import { HookDeliveryMonitor, hookMissLogPath } from "./harness-hook-delivery";
import { sweepStrandedSessions } from "./core-session-sweep";
import { readySessionOnAgentSpawn } from "./core-session-relaunch";
import { CoreSessionBackstop } from "./core-session-backstop";
import { verifyBearer, type BearerSecret } from "@actana/shared/core-link-bearer";
import { loadOrMintMaterial, type LoadOrMintResult } from "./core-first-run";
import { registerSelfWithLocalCli } from "./core-self-register";
import {
  CONTAINER_PUBLIC_HOST_ENV,
  coreUpdateCommand,
  inContainer,
} from "@actana/shared/actana-container-contract";
import { formatPublicHosts, parsePublicHosts } from "@actana/shared/public-hosts";
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
import { legacyEnvRefusal, plaintextExposureRefusal } from "./core-boot-refusals";

const CORE_LISTENING_SENTINEL = "@@AC_CORE_LISTENING@@";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[core-entry] ${name} env not set`);
    process.exit(1);
  }
  return value;
}

async function startCore(): Promise<void> {
  // First, before a single variable is read for its value: an environment
  // written for the Harness-era daemon is refused outright (#348). It has to
  // be first because the variables that survived the rename —
  // `AC_USER_DATA_DIR`, `AC_CORE_LINK_PORT`, `AC_CORE_LINK_HOST` — are set on
  // that machine too, so every check below it would pass and the daemon would
  // boot as something nobody asked for.
  const legacyEnv = legacyEnvRefusal(process.env);
  if (legacyEnv) {
    console.error(`[core-entry] ${legacyEnv}`);
    process.exit(1);
  }

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

  // The combination the refusal above exists to make impossible, refused again
  // on its own terms: plaintext, unauthenticated core-link on an address other
  // than this machine. A pre-rename plist is one way to reach it and no longer
  // the only one that matters — anything that sets a bind address without
  // setting remote mode arrives here, and none of them should listen.
  const exposure = plaintextExposureRefusal({ remoteMode, host });
  if (exposure) {
    console.error(`[core-entry] ${exposure}`);
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
  //
  // `listBootSweepTasks` widens that read by the one class of orphan the
  // status filter could never see: a bare Session left on `ready`, whose PTY
  // spawned and died without a single hook ever firing for it (issue 387).
  sweepStrandedSessions({ listBootSweepTasks, writer: taskWriter });

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
      const result = harnessStatus.receiveHook(taskId, payload, eventNameFallback);
      // A hook that landed is this Session talking, whatever it said — that is
      // what keeps the quiet-Session backstop off a turn that is really
      // running (issue 243) — and it is also the end of the idle rule's claim
      // on the row, because the pipeline has just decided the status (issue
      // 391).
      //
      // Reported *after* the pipeline, and only for a hook the pipeline
      // accepted: `reconcileSessionId` drops a POST carrying another session's
      // id (base `2bdcb56`), and a hook from a harness process this Session no
      // longer owns is not evidence that this Session is alive. `ok` is the
      // positive test — it is already false for a row this Core does not have
      // — and `foreign-session` is the one rejection that answers `ok`.
      if (result.ok && result.body?.ignored !== "foreign-session") {
        sessionBackstop?.noteActivity(taskId, "hook");
      }
      return result;
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
    // Issue 483. The status the signal above writes is what a client renders;
    // this row is what lets it say *why*. It goes into the same monotonic log
    // every other Session event does, so a CLI or an SDK automation waiting on
    // the start reads it on the connection it already has — no new frame, no
    // poll, and nothing for a client that has never heard of the kind to do.
    onSessionPromptAbandoned: ({ taskId, ptyId, reason }) => {
      const payload: CoreLinkSessionPromptAbandonedPayload = { taskId, ptyId, reason };
      try {
        appendEvent(SESSION_PROMPT_ABANDONED_EVENT_KIND, JSON.stringify(payload), {
          taskId,
          ptyId,
        });
      } catch (err) {
        console.error(`[core-entry] prompt-abandoned.append-failed: ${err}`);
      }
    },
    // Issue 395, and the row that makes `session start` able to stop guessing.
    // Same log, same connection, one kind further on: a client that waited for
    // this heard the Core say the harness took the prompt, which is the only
    // evidence there is that the composer is listening — nobody outside this
    // process sees the screen (ADR 0026), and #191 removed the last client that
    // tried to infer it from quietness.
    onSessionPromptDelivered: ({ taskId, ptyId, characters, waitedMs, composerObserved }) => {
      const payload: CoreLinkSessionPromptDeliveredPayload = {
        taskId,
        ptyId,
        characters,
        waitedMs,
        composerObserved,
      };
      try {
        appendEvent(SESSION_PROMPT_DELIVERED_EVENT_KIND, JSON.stringify(payload), {
          taskId,
          ptyId,
        });
      } catch (err) {
        console.error(`[core-entry] prompt-delivered.append-failed: ${err}`);
      }
    },
    // A harness that is working redraws its spinner into the PTY about once a
    // second. Silence there, and no hooks either, is what the backstop below
    // reads as "this turn ended and nobody said so" (issue 243) — and a
    // spinner that is all that is left, with nothing new on screen behind it,
    // is what it reads as an idle TUI nobody will ever hear a `Stop` from
    // (issue 391). The PTY core says which of the two arrived.
    onSessionOutputActivity: ({ taskId, kind }) => sessionBackstop?.noteActivity(taskId, kind),
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
  // Set beside `pairing`, and for the same reason: a Core with no persisted
  // material has no pairing store, so there is nothing on this machine that
  // could have been revoked.
  let revocations: PairingRevocations | null = null;

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
    // The other side of issue 387's sweep: a bare Session that settled while
    // it had never run a turn is put back on `ready` when a harness is spawned
    // for it again. Nothing else would — no hook fires until the first prompt,
    // so the card would read `disconnected` over a healthy harness.
    relaunchPort: {
      agentSpawned: (taskId) =>
        void readySessionOnAgentSpawn(
          { writer: taskWriter, provenNeverWorked: taskProvenNeverWorked },
          taskId,
        ),
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
    // It grants nothing `core shell` does not already grant — same credential,
    // same link, same class of process — and it is more auditable, because it
    // arrives through this Core's own authentication instead of through a
    // `docker exec` on the host that this Core never sees.
    execPort: {
      run: (input) => runCoreExec(input),
    },
  };

  if (remoteMode) {
    // In a container the public host is the operator's to supply and never
    // ours to guess (ADR 0016 D15): it is baked into the server certificate's
    // SAN and into the endpoint every pairing hands back, so falling back to
    // the bind address would mint a Core no Panel can verify. `actana daemon` translates
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
    // One address or a comma-separated list of them (#347). Every entry becomes
    // a SAN on this Core's certificate; the first is the primary — the endpoint
    // a pairing hands back unless the operator chose otherwise when they minted
    // the code. A single value parses to a list of one and nothing about it
    // changes.
    //
    // The refusal names whichever variable actually carried the value. In a
    // container that is the operator's `ACTANA_PUBLIC_HOST`, which `actana
    // daemon` translated; on metal the unit sets `AC_CORE_PUBLIC_HOST` directly
    // and `ACTANA_PUBLIC_HOST` does not exist there at all — and this branch
    // exists precisely for whatever execs the daemon bundle without the CLI in
    // front of it. Naming a variable the operator cannot find is worse than
    // naming none.
    const publicHostVar = containerMode ? CONTAINER_PUBLIC_HOST_ENV : "AC_CORE_PUBLIC_HOST";
    const parsedPublicHosts = parsePublicHosts(
      process.env.AC_CORE_PUBLIC_HOST || host,
      process.env.AC_CORE_PUBLIC_HOST ? publicHostVar : "AC_CORE_LINK_HOST",
    );
    if (!parsedPublicHosts.ok) {
      console.error(`[core-entry] ${parsedPublicHosts.error}`);
      process.exit(1);
    }
    const publicHosts = parsedPublicHosts.hosts;
    const materialFile = process.env.AC_CORE_MATERIAL_FILE;
    const bearerDays = Number(process.env.AC_CORE_BEARER_DAYS ?? 365);
    const label = process.env.ACTANA_LABEL || "";

    // **A remote Core has a material file or it does not boot (#287).** There
    // used to be a second branch here for a daemon started without one: it
    // minted certs it never persisted and printed a blob for the operator to
    // carry, which was the whole of how anything reached that Core. The blob is
    // gone, and a Core that cannot enroll a client — no CA key to sign a CSR
    // with, no file for a pairing session to live in (#282) — is not a Core
    // anybody can use. So the configuration is refused rather than served: a
    // dual identity path where one of the two is unreachable is exactly the
    // "second way to become a Core client" #280 exists to remove.
    if (!materialFile) {
      console.error(
        "[core-entry] AC_CORE_MATERIAL_FILE is not set. A Core in remote mode keeps its " +
          "identity and its pairing sessions in that file; without one it can issue no " +
          "credential and no client can ever reach it. `actana setup` sets it on metal, " +
          "and the Core image bakes it into the ENTRYPOINT.",
      );
      process.exit(1);
    }

    {
      // The daemon was started by the auto-start unit (or the container's
      // ENTRYPOINT) with a material file. Present, it is loaded so the CA +
      // certs + bearer secret + coreId are the ones every paired client
      // chains to — a rebooted machine must resume the same identity, not
      // generate fresh certs. Absent, this is a first run with no `actana
      // setup` behind it (ADR 0016 D17) and the daemon mints and persists.
      let resolved: LoadOrMintResult;
      try {
        resolved = await loadOrMintMaterial({
          materialFile,
          publicHosts,
          // `host` is the bind address standing in for an answer the operator
          // did not give — enough to mint a first identity from, never enough
          // to re-sign an existing one's SAN with.
          publicHostDeclared: Boolean(process.env.AC_CORE_PUBLIC_HOST),
        });
      } catch (err) {
        console.error(`[core-entry] ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      const { material, certAction, addedHosts } = resolved;
      const secret: BearerSecret = material.bearerSecret;

      // The pre-auth pairing endpoint (#282). Mounted only on this path, and
      // that is the whole of the condition: pairing needs a CA key to sign
      // with, a stable UUID to put in the bearers it issues, and a file the
      // operator's `actana pair new` and this daemon can both see — all three
      // are the persisted material, and a daemon started without one has
      // nowhere for a session to live.
      const pairingStore = new PairingStore(pairingStorePath(materialFile));
      pairing = {
        material: {
          caCert: material.caCert,
          caKey: material.caKey,
          bearerSecret: material.bearerSecret,
          coreId: material.coreId,
          coreUuid: material.coreUuid,
        },
        sessions: pairingStore,
        // Per redeemed session, not one string for the route: which of this
        // Core's addresses a client is told to dial is the operator's choice at
        // `actana pair new` time, and the resolver reads it off the stored
        // session and off nothing in the request (#347).
        endpointFor: buildPairingEndpointResolver({ publicHosts, port }),
        bearerDays,
      };
      // The other half of `actana pair revoke` (#283). That command runs in the
      // CLI and can only stamp a row; this is the process that makes the stamp
      // mean something — refusing the certificate at the gate, refusing the
      // bearer at the `auth` frame, and closing the link a revoked client
      // already has open. Built here, next to the store it reads, and armed
      // below once there is a server for it to close connections on.
      revocations = new PairingRevocations(pairingStore);
      serverOpts.revocation = revocations;

      serverOpts.tls = {
        caCert: material.caCert,
        serverCert: material.serverCert,
        serverKey: material.serverKey,
      };
      serverOpts.authVerifier = (b) => verifyBearer(b, secret);

      // A changed public host list keeps the identity and re-signs the cert
      // (D18), so neither branch below is a pairing event. **Which sentence is
      // printed matters more than that one is**, because the two changes cost
      // an operator completely different things and the wrong advice on the
      // cheap one is the whole of what it costs (#347).
      //
      // Both print the full list. Naming the primary alone was the old bug: an
      // operator who added `192.168.1.20` read "public host is now core" — a
      // line that does not mention the thing that changed.
      if (certAction === "widened") {
        // Nothing is dialling an address this Core has left, so there is
        // nothing to do and nothing is advised. Saying "update your Panel or
        // pair again" here would charge the operator the exact cost #347 exists
        // to remove, over a change that removed it.
        console.log(
          `[core-entry] public hosts are now ${formatPublicHosts(publicHosts)} — added ` +
            `${formatPublicHosts(addedHosts)}, and re-issued this Core's server certificate ` +
            `from its existing CA to cover ${addedHosts.length === 1 ? "it" : "them"}. Every ` +
            "address this Core already answered to is still covered, so every paired client " +
            `keeps working and none has to be re-paired. Pair a client to a new address with ` +
            "`actana pair new --public-host <addr>`.",
        );
      } else if (certAction === "moved") {
        // A host this Core was signed for is gone. A paired client is still
        // dialling it, and that address is the one thing re-issuing cannot fix
        // from here — the client holds it.
        console.log(
          `[core-entry] public hosts are now ${formatPublicHosts(publicHosts)} — re-issued ` +
            "this Core's server certificate from its existing CA. This Core no longer answers " +
            "to every address it was signed for. Pairing credentials are unchanged; update " +
            "this Core's address in your Panel, or run `actana pair new` here and pair it " +
            "again.",
        );
      }

      // #288 D9, criterion 3: a containerised Core wires itself to the `actana`
      // on its own machine, because the image is the install and `actana setup`
      // — which does this on metal — is refused here. Without it a Session
      // started on this Core finds an empty registry and cannot address the
      // Core it is running on, and the `actana-sessions` skill installed a few
      // lines below states the opposite as a fact. Not gated on a first mint: a
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
              `${registered.error}. \`actana core ls\` here will be empty; \`actana pair new\` ` +
              "here still enrolls a client from anywhere.",
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

  // Armed after the server exists, because what it does when it finds a fresh
  // revocation is close that client's connections. Its first read runs here and
  // is deliberately not dispatched — see `startPairingRevocationSweep` — so a
  // Core that boots with revocations already on file refuses them from its
  // first request rather than from one second in.
  const revocationSweep: PairingRevocationSweep | null = revocations
    ? startPairingRevocationSweep({ revocations, onRevoked: () => server.closeRevoked() })
    : null;

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
    revocationSweep?.stop();
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
