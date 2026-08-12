// Opening a link to a Core, for the nouns that need more than one question.
//
// `core-probe.ts` is this seam narrowed to a single round trip — connect, read
// the handshake, hang up — and it stays as it is because `core status` needs
// nothing else. `project`, `harness` and `events` do: they send request frames,
// they read the event log, and one of them stays up for hours. So the same
// trade is made once more at the right width: **one injected function that
// hands back a connected client**, and a narrow structural type describing the
// slice of that client the commands use.
//
// Narrow on purpose. `CoreClient` is a large class, and a test that had to
// stand one up in order to check a table's columns would be testing the SDK.
// {@link CoreLinkClient} is the eight members the three nouns actually touch,
// which a fake satisfies in twenty lines — and because it is structural, the
// real `CoreClient` and `DurableCoreClient` satisfy it without an adapter or a
// declaration saying so.
//
// **Which of the two entry points (#129 D6) is a per-command decision.** A list
// is one question and takes the one-shot client; `events tail` is a program
// that must survive a Core restart and takes the durable one, cursor and all.
// Nothing here chooses for them.

import { CoreClient } from "@actana/sdk/core-client.ts";
import { DurableCoreClient } from "@actana/sdk/durable-core-client.ts";
import type { CoreRegistrationBlob } from "@actana/sdk/core-registration-blob.ts";
import type { CoreLinkCursorStorage } from "@actana/sdk/core-link-cursor-storage.ts";
import type { CoreConnectionInfo } from "@actana/sdk/core-client.ts";
import type {
  CoreLinkEvent,
  CoreLinkHarnessAvailabilityMap,
  CoreLinkProjectMutation,
  CoreLinkProjectSnapshot,
  CoreLinkRequestFrame,
  CoreLinkResponseFrame,
} from "@actana/sdk/core-link-frames.ts";
import { resolveCore } from "./core-resolution.ts";
import { EXIT_FAILURE } from "./exit-codes.ts";
import type { RegistryPaths } from "./blob-registry.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import type { ParsedArgs } from "./cli-args.ts";

/** How long a command waits for a Core to answer, unless it says otherwise. */
export const DEFAULT_CORE_TIMEOUT_MS = 30_000;

/**
 * The slice of a Core client the client nouns use.
 *
 * Satisfied structurally by `CoreClient` and `DurableCoreClient`. `request` is
 * here alongside the typed methods because two of the frames these nouns send —
 * `dirList` and `harnessInstall` — have no typed method on the client and no
 * arm in `unwrapResponse`, so their answers are read as frames. That is the
 * documented use of that seam rather than a gap being routed around.
 */
export type CoreLinkClient = {
  request(frame: CoreLinkRequestFrame, timeoutMs?: number): Promise<CoreLinkResponseFrame>;
  projectsList(): Promise<CoreLinkProjectSnapshot[]>;
  projectsMutate(mutation: CoreLinkProjectMutation): Promise<CoreLinkProjectSnapshot | null>;
  agentsAvailabilityList(): Promise<CoreLinkHarnessAvailabilityMap>;
  onEvent(cb: (msg: { event: CoreLinkEvent }) => void): () => void;
  onEventsReplayed(cb: (msg: { lastEventId: number }) => void): () => void;
  onDisconnected(cb: (msg: { error?: string }) => void): () => void;
  onReady(cb: (info: CoreConnectionInfo) => void): () => void;
  subscribeEvents(lastEventId?: number): boolean;
  close(): void;
};

export type CoreConnectOptions = {
  /**
   * Take the durable entry point: heartbeat, reconnect with backoff, and the
   * event cursor that makes a replay after a drop lose nothing and repeat
   * nothing (#129 D6). One command sets it — `events tail`.
   */
  durable?: boolean;
  /** Where a durable client keeps its cursor. Ignored unless `durable`. */
  storage?: CoreLinkCursorStorage;
  timeoutMs?: number;
};

/** How the client nouns reach a Core. Injected, so every verb is testable. */
export type CoreConnectFn = (
  blob: CoreRegistrationBlob,
  opts?: CoreConnectOptions,
) => Promise<CoreLinkClient>;

/**
 * The real connect: build a client off the blob, dial, refuse a Core this build
 * cannot speak to.
 *
 * The version gate is here rather than at each call site because the answer is
 * the same everywhere and the failure mode of skipping it is not: a frame this
 * build understands, sent to a Core on another train, comes back as an `error`
 * frame about that one frame, and the operator reads "unknown frame type" when
 * the fact is "update one of these two programs". `core status` is the verb
 * that exists to report this, and every other verb points at it.
 */
export const connectCore: CoreConnectFn = async (blob, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CORE_TIMEOUT_MS;
  const client = opts.durable
    ? DurableCoreClient.fromRegistrationBlob(blob, {
        connectTimeoutMs: timeoutMs,
        requestTimeoutMs: timeoutMs,
        ...(opts.storage ? { storage: opts.storage } : {}),
      })
    : CoreClient.fromRegistrationBlob(blob, {
        connectTimeoutMs: timeoutMs,
        requestTimeoutMs: timeoutMs,
      });

  let info;
  try {
    info = await client.connect();
  } catch (err) {
    client.close();
    throw err;
  }
  if (!info.compatible) {
    client.close();
    throw new Error(
      `this Core speaks core-link ${info.protocolVersion ?? "(none reported)"}, which this CLI does not. ` +
        "Update whichever of the two is older — `actana core status` reports both.",
    );
  }
  return client;
};

/** A Core this command may now talk to, and the two facts output is allowed to name. */
export type OpenedCore = {
  client: CoreLinkClient;
  /** The registry name, or null for a blob out of the environment. */
  name: string | null;
  endpoint: string;
};

export type OpenCoreResult = { ok: true; core: OpenedCore } | { ok: false; code: number };

/**
 * Resolve the Core this command means, dial it, and report a failure once.
 *
 * The failure is reported **on stderr only, never as a JSON object on stdout**,
 * and that is a deliberate departure from `core status --json`. Reachability is
 * what `core status` is *about*, so "unreachable" is its answer and belongs in
 * its payload. For `project ls` it is not an answer at all — a list that could
 * not be fetched is not an empty list and is not an error-shaped list, and a
 * consumer that got `{"error": …}` on the stream it parses as data would have
 * to learn to tell one from the other on every read. The exit code is the
 * channel for "this did not happen"; stderr carries the sentence.
 */
export async function openCore(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  label: string,
  opts: CoreConnectOptions = {},
): Promise<OpenCoreResult> {
  const resolved = resolveCore({ paths, env: deps.env, home: deps.home, coreFlag: args.core });
  if (!resolved.ok) {
    deps.err(`${label}: ${resolved.error}`);
    return { ok: false, code: EXIT_FAILURE };
  }

  const { name, blob } = resolved.core;
  deps.verbose(`dialling ${blob.endpoint}`);
  try {
    const client = await deps.connect(blob, opts);
    return { ok: true, core: { client, name, endpoint: blob.endpoint } };
  } catch (err) {
    deps.err(`${label}: ${blob.endpoint} — ${errorText(err)}`);
    return { ok: false, code: EXIT_FAILURE };
  }
}

/** An error's operator-facing sentence, whatever was thrown. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
