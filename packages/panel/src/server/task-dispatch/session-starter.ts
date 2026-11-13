import { CoreSession, HARNESS_LAUNCH_COMMANDS, harnessAutoModeFlag } from "@actana/sdk/core";
import { harnessLaunchesWithSkipPermissions } from "@actana/shared/harnesses";
import { coreLinkManager } from "../services/core-link-manager";
import type { Session } from "~/db/schema";
import type { AiModelId } from "@actana/shared/ai-runtime-defaults";
import { buildHarnessLaunchCommand, harnessLaunchMode, harnessUsesPersistedSession } from "~/lib/harness-command";
import { RESUME_REFUSALS, messageOf, type ResumeOutcome, type SessionResumer, type SessionStarter, type StartSessionRequest, type StartedSession } from "./types";

/**
 * The command a Task's Session is launched with: the harness's own launch command,
 * its auto-mode flag (always, as for a Session: issue 22), and `--model <id>`
 * when it names a model. The Core allow-lists the binary and every flag, so
 * nothing here is trusted to be safe on its own; the Agent's model is already
 * held to a plain id (`AGENT_MODEL_PATTERN`) and its flags to a closed set.
 */
export function launchCommand(request: Pick<StartSessionRequest, "harness" | "model" | "flags">): string {
  const parts: string[] = [HARNESS_LAUNCH_COMMANDS[request.harness]];
  const auto = harnessLaunchesWithSkipPermissions(request.harness) ? harnessAutoModeFlag(request.harness) : null;
  if (auto) parts.push(auto);
  if (request.model) parts.push("--model", request.model);
  return parts.join(" ");
}

/**
 * Start a Session on a Core through the Panel's own link to it (the SDK's
 * `CoreSession`, not a raw frame and not `core exec`). The Core creates the
 * Session row, spawns the harness in the workspace and types the prompt in; it
 * appends its standard block to that prompt itself.
 */
export const startSessionOnCore: SessionStarter = async (request) => {
  const link = coreLinkManager().client(request.coreId);
  if (!link?.sdk) throw new Error("there is no live link to this Core");
  // The row first, here and not inside `CoreSession.start`: a refused spawn (a full Core) would otherwise leave a
  // `ready` row with no PTY behind, which the Core never sweeps. Every probe of a full Core would add one.
  const created = await link.sdk.sessionsMutate({ op: "create", title: request.title, agent: request.harness });
  if (!created) throw new Error("the Core refused to create a Session row");
  const { sessionId } = created;
  let session: Awaited<ReturnType<typeof CoreSession.start>>;
  try {
    session = await CoreSession.start(link.sdk, {
      sessionId,
      harness: request.harness,
      title: request.title,
      prompt: request.prompt,
      command: launchCommand(request),
      ...(harnessLaunchesWithSkipPermissions(request.harness) ? { dangerouslySkipPermissions: true } : {}),
    });
  } catch (err) {
    try {
      await link.sdk.sessionsMutate({ op: "delete", sessionId });
    } catch (deleteErr) {
      console.error(`could not delete Session ${sessionId} after its start failed: ${deleteErr instanceof Error ? deleteErr.message : String(deleteErr)}`);
    }
    throw err;
  }
  return startedSession(session);
};

type LiveCoreSession = Pick<Awaited<ReturnType<typeof CoreSession.start>>, "sessionId" | "onExit" | "onStatus" | "dispose">;

/** The dispatcher's handle on a Session this Panel holds a `CoreSession` for. */
function startedSession(session: LiveCoreSession): StartedSession {
  const unsubscribes: (() => void)[] = [];
  return {
    sessionId: session.sessionId,
    onExit: (cb) => {
      session.onExit(({ exitCode }) => cb({ exitCode }));
    },
    onStatus: (cb) => {
      unsubscribes.push(session.onStatus(cb));
    },
    dispose: () => {
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      session.dispose();
    },
  };
}

/** How long a resumed harness has to stay up before the resume counts as having worked. */
export const RESUME_SETTLE_MS = 3_000;

/** A start the Core turned away for want of room or a link is not a refusal of the resume: the Task waits, as for any start (#962). */
const WAITS = /already runs \d+ live harness PTYs|no live link to this Core/;

/**
 * Continue a Task's own Session on its Core (#955), through the Panel's own link, with the Core link messages a Session
 * already uses (no protocol change): `sessionRowsList` for its row, `findBySession` for a live PTY, then
 *  - a live harness (one live harness per Task): `CoreSession.attach` and the pointer typed with `send`, then the return;
 *  - otherwise `CoreSession.start` against the Session's existing row with the harness's resume command
 *    (`harness-command.ts`, the one the Panel's own terminal relaunches a Session with) and the pointer as its prompt.
 * No row is created or deleted. Never `resumed` for a Session the harness cannot resume (no harness session id, `ready`,
 * another harness). A harness that exits within `settleMs` of the resume is `cannot`: the caller starts a new Session.
 * No link and a full Core throw, like {@link startSessionOnCore}.
 */
export const resumeSessionOnCore = async (request: Parameters<SessionResumer>[0], settleMs: number = RESUME_SETTLE_MS): Promise<ResumeOutcome> => {
  const sdk = coreLinkManager().client(request.coreId)?.sdk;
  if (!sdk) throw new Error("there is no live link to this Core");
  let row: Awaited<ReturnType<typeof sdk.sessionRowsList>>["sessions"][number] | undefined;
  let live: boolean;
  try {
    row = (await sdk.sessionRowsList()).sessions.find((r) => r.sessionId === request.sessionId);
    live = row ? (await sdk.findBySession(request.sessionId)).ptyId !== null : false;
  } catch (err) {
    if (WAITS.test(messageOf(err))) throw err;
    return { kind: "cannot", refusal: RESUME_REFUSALS.noAnswer };
  }
  if (!row) return { kind: "cannot", refusal: RESUME_REFUSALS.sessionGone };
  if (row.agent !== request.harness) return { kind: "cannot", refusal: RESUME_REFUSALS.otherHarness };
  if (live) return sendIntoRunningSession(sdk, request);
  const claudeSessionId = row.claudeSessionId;
  if (!claudeSessionId) return { kind: "cannot", refusal: RESUME_REFUSALS.noSessionId };
  // A Task's Session is never a bare one. The row's status is read as the Panel's own terminal reads it.
  const asSession = { agent: request.harness, claudeSessionId, status: row.status as Session["status"], claudeBareSession: false };
  if (!harnessUsesPersistedSession(request.harness) || harnessLaunchMode(asSession) !== "resume") {
    return { kind: "cannot", refusal: RESUME_REFUSALS.noResume };
  }
  let session: Awaited<ReturnType<typeof CoreSession.start>>;
  try {
    session = await CoreSession.start(sdk, {
      sessionId: request.sessionId,
      harness: request.harness,
      prompt: request.prompt,
      command: buildHarnessLaunchCommand(asSession, claudeSessionId, "resume", { model: request.model as AiModelId | null }),
      ...(harnessLaunchesWithSkipPermissions(request.harness) ? { dangerouslySkipPermissions: true } : {}),
    });
  } catch (err) {
    if (WAITS.test(messageOf(err))) throw err;
    return { kind: "cannot", refusal: RESUME_REFUSALS.resumeRefused(messageOf(err)) };
  }
  if (await exitsWithin(session, settleMs)) {
    session.dispose();
    return { kind: "cannot", refusal: RESUME_REFUSALS.exitedAtOnce };
  }
  return { kind: "resumed", session: startedSession(session) };
};

/** Did the harness exit before `ms` passed (or already)? */
async function exitsWithin(session: Pick<LiveCoreSession, "onExit"> & { exitStatus?: () => unknown }, ms: number): Promise<boolean> {
  if (session.exitStatus?.()) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let off: (() => void) | undefined;
  try {
    return await new Promise<boolean>((resolve) => {
      off = session.onExit(() => resolve(true)) as (() => void) | undefined;
      timer = setTimeout(() => resolve(false), ms);
    });
  } finally {
    clearTimeout(timer);
    off?.();
  }
}

async function sendIntoRunningSession(sdk: NonNullable<ReturnType<ReturnType<typeof coreLinkManager>["client"]>>["sdk"], request: Parameters<SessionResumer>[0]): Promise<ResumeOutcome> {
  const refused: ResumeOutcome = { kind: "cannot", refusal: RESUME_REFUSALS.sendRefused, stillLive: true };
  let session: Awaited<ReturnType<typeof CoreSession.attach>>;
  try {
    session = await CoreSession.attach(sdk!, { sessionId: request.sessionId });
  } catch (err) {
    if (WAITS.test(messageOf(err))) throw err;
    return refused;
  }
  try {
    // A message that starts a turn is the text and then the return, two writes (never glued): the SDK's rule for `send`.
    // Both are stamped writes (`deliver`), not `send`: the Core refuses a stamped write into a Session parked on a dialog
    // (`blocked`), so the pointer cannot answer an approval by accident (#924). A refused pointer gets no return after it.
    if ((await session.deliver(request.prompt)).ok && (await session.deliver("\r")).ok) return { kind: "sent", session: startedSession(session) };
  } catch {
    // Locked by another client, or the PTY went away: refused below.
  }
  session.dispose();
  return refused;
}
