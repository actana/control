import { CoreSession, HARNESS_LAUNCH_COMMANDS, harnessAutoModeFlag } from "@actana/sdk/core";
import { harnessLaunchesWithSkipPermissions } from "@actana/shared/harnesses";
import { coreLinkManager } from "../services/core-link-manager";
import type { SessionStarter, StartSessionRequest } from "./types";

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
};
