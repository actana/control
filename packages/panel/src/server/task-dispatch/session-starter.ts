import { CoreSession, HARNESS_LAUNCH_COMMANDS, harnessAutoModeFlag } from "@actana/sdk/core";
import { coreLinkManager } from "../services/core-link-manager";
import type { SessionStarter, StartSessionRequest } from "./types";

/**
 * The command a Task's Session is launched with: the harness's own launch command,
 * its auto-mode flag when the Agent carries `skip-permissions`, and `--model <id>`
 * when it names a model. The Core allow-lists the binary and every flag, so
 * nothing here is trusted to be safe on its own; the Agent's model is already
 * held to a plain id (`AGENT_MODEL_PATTERN`) and its flags to a closed set.
 */
export function launchCommand(request: Pick<StartSessionRequest, "harness" | "model" | "flags">): string {
  const parts: string[] = [HARNESS_LAUNCH_COMMANDS[request.harness]];
  const auto = request.flags.includes("skip-permissions") ? harnessAutoModeFlag(request.harness) : null;
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
  const session = await CoreSession.start(link.sdk, {
    harness: request.harness,
    title: request.title,
    prompt: request.prompt,
    command: launchCommand(request),
    ...(request.flags.includes("skip-permissions") ? { dangerouslySkipPermissions: true } : {}),
  });
  return {
    sessionId: session.sessionId,
    onExit: (cb) => {
      session.onExit(({ exitCode }) => cb({ exitCode }));
    },
    dispose: () => session.dispose(),
  };
};
