// How each harness is asked to pick a conversation back up (#129 D10, #160).
//
// `actana session resume <task>` starts a **new** PTY for a Task that already
// has one behind it, and the only thing that makes it a resumption rather than
// a fresh Session is the launch command: the harness's own session id, spelled
// the way that harness spells it. The Core stores that id on the Task row
// (`claudeSessionId`, written by the hook pipeline), so the CLI never invents
// one — it reads the Task and asks for what is already there.
//
// A pure function, in its own module, for one reason: **the Core's allow-list
// is the authority on what may be spawned** (`pty-spawn-policy.ts`), and the
// only honest way to keep this table in step with it is to have a unit test
// read both. A command this builds that the Core would refuse is a rejected
// spawn with the Core's own message on it — not a command trimmed here on a
// guess about a machine this process is not on.

import type { CoreLinkPtySpawnHarness } from "@actana/sdk/core-link-frames.ts";

/**
 * The launch command that resumes `sessionId` under `harness`.
 *
 * The four spellings are not stylistic variation, and they are not this file's
 * invention — each is what that harness's own CLI accepts and what the Core's
 * spawn policy allow-lists:
 *
 *   - `claude --resume <id>`         a flag with a value
 *   - `codex resume <id>`            a **subcommand**, so it comes first, and
 *                                    `--enable hooks` still has to be there or
 *                                    the Session never reports its lifecycle
 *                                    and every wait on it hangs
 *   - `cursor-agent --resume <id>`   a flag again, different binary
 *   - `opencode --session <id>`      a different flag entirely, and the Core
 *                                    additionally requires the value to start
 *                                    `ses`
 *
 * `dangerouslySkipPermissions` appends that harness's spelling of "do not stop
 * to ask me", which the Core accepts **only** on a spawn that also set the
 * matching option — the CLI sends both or neither (see `session-gateway.ts`).
 * OpenCode has no such flag and gets none, which is not an omission: a flag
 * invented here would be rejected by the allow-list rather than honoured.
 */
export function harnessResumeCommand(
  harness: CoreLinkPtySpawnHarness,
  sessionId: string,
  opts: { dangerouslySkipPermissions?: boolean } = {},
): string {
  const skip = opts.dangerouslySkipPermissions === true;
  switch (harness) {
    case "claude-code":
      return join(["claude", "--resume", sessionId], skip ? "--dangerously-skip-permissions" : null);
    case "codex":
      return join(["codex", "resume", sessionId, "--enable", "hooks"], skip ? "--yolo" : null);
    case "cursor-cli":
      return join(["cursor-agent", "--resume", sessionId], skip ? "--force" : null);
    case "opencode":
      return join(["opencode", "--session", sessionId], null);
  }
}

function join(parts: string[], trailing: string | null): string {
  return (trailing === null ? parts : [...parts, trailing]).join(" ");
}
