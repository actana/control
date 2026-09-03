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

import { harnessAutoModeFlag } from "@actana/sdk/core-session.ts";
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
 *                                    `--enable hooks` and
 *                                    `--dangerously-bypass-hook-trust` still
 *                                    have to be there or the Session never
 *                                    reports its lifecycle and every wait on
 *                                    it hangs. The second is issue 290: a
 *                                    resumed Session gets the same freshly
 *                                    written hooks file as a new one, and
 *                                    Codex holds a hooks file it has not
 *                                    reviewed whether the thread is new or
 *                                    picked back up
 *   - `cursor-agent --resume <id>`   a flag again, different binary
 *   - `opencode --session <id>`      a different flag entirely, and the Core
 *                                    additionally requires the value to start
 *                                    `ses`
 *
 * `dangerouslySkipPermissions` appends that harness's spelling of "do not stop
 * to ask me", and it is **read from {@link harnessAutoModeFlag} rather than
 * spelled again here** (issue 177 finding 2). It used to be a fourth switch
 * over the same four harnesses, which is one more transcription of a vendor
 * fact than can be kept in step — and the direction it drifts in is the silent
 * one: a wrong flag is a rejected spawn, a *missing* flag used to be an
 * interactive harness a caller thought was unattended.
 *
 * The Core now checks the gesture both ways: the flag is accepted only on a
 * spawn that set the option, and since issue 177 the option is refused on a
 * command that lacks the flag. The CLI sends both or neither (see
 * `session-gateway.ts`). OpenCode has no such flag and gets none, which is not
 * an omission — it is the one harness whose auto-mode cell is genuinely empty,
 * and the Core reads it the same way.
 */
export function harnessResumeCommand(
  harness: CoreLinkPtySpawnHarness,
  sessionId: string,
  opts: { dangerouslySkipPermissions?: boolean } = {},
): string {
  // One table for the flag, whatever the shape of the command it hangs off.
  // `null` here is both "auto mode was not asked for" and "this harness has
  // none" — two different facts with the same consequence for the command.
  const autoMode =
    opts.dangerouslySkipPermissions === true ? harnessAutoModeFlag(harness) : null;
  switch (harness) {
    case "claude-code":
      return join(["claude", "--resume", sessionId], autoMode);
    case "codex":
      return join(
        ["codex", "resume", sessionId, "--enable", "hooks", "--dangerously-bypass-hook-trust"],
        autoMode,
      );
    case "cursor-cli":
      return join(["cursor-agent", "--resume", sessionId], autoMode);
    case "opencode":
      return join(["opencode", "--session", sessionId], autoMode);
  }
}

function join(parts: string[], trailing: string | null): string {
  return (trailing === null ? parts : [...parts, trailing]).join(" ");
}
