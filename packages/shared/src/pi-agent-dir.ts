import * as os from "node:os";
import * as path from "node:path";

/**
 * Pi's agent config directory, resolved the way Pi resolves it:
 * `$PI_CODING_AGENT_DIR` when set (a leading `~` expanded), otherwise
 * `~/.pi/agent`. The Core writes its extension under it and the Panel reads
 * `auth.json` from it, so the two must agree with Pi and with each other.
 */
export function piAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv.replace(/^~(?=$|[/\\])/, home));
  return path.join(home, ".pi", "agent");
}
