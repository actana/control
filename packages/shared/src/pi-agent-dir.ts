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

/**
 * Marker directories that mean "Pi is on this machine" for the skills fan-out
 * (#518 part 3).
 *
 * Without `$PI_CODING_AGENT_DIR`, that is `~/.pi` — the same evidence the
 * tables used before. With it set, it is the directory {@link piAgentDir}
 * resolves to: home-relative when that path sits under `home`, absolute
 * otherwise. `path.join(home, absoluteMarker)` still yields the absolute path
 * (Node discards prior segments on an absolute join), so the installer needs
 * no special case.
 */
export function piHomeMarkers(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): readonly string[] {
  if (!env.PI_CODING_AGENT_DIR?.trim()) return [".pi"];

  const agentDir = piAgentDir(env, home);
  const relative = path.relative(path.resolve(home), agentDir);
  if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return [relative.split(path.sep).join("/")];
  }
  return [agentDir];
}
