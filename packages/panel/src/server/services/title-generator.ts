// Title generation for the Panel's own task rows.
//
// The meta-prompt, the harness→CLI choice and the parsing live in
// `@actana/shared/title-generation`; the Core runs the same code for the
// Sessions it owns (issue 84), where the harness binaries and the row actually
// are. This file is what remains: the Panel's reads and writes around it.

import {
  fallbackTitle,
  isTitleGenerationPrompt,
  parseResponse,
  resolveTitleInvocation,
} from "@actana/shared/title-generation";
import { TITLE_GENERATING, TITLE_WAITING, isSentinelTitle } from "~/lib/task-sentinels";
import { runCli } from "./claude-cli";
import { getTask, updateTask } from "./tasks";

export { isTitleGenerationPrompt, parseResponse, resolveTitleInvocation };

export async function generateTitleForTask(taskId: string, prompt: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) return;
  if (task.titleManuallySet) return;
  if (!isSentinelTitle(task.title)) return; // existing finalized title
  if (!prompt.trim()) return;

  const invocation = resolveTitleInvocation(task.agent, prompt);
  if (!invocation) {
    if (task.title === TITLE_WAITING) {
      updateTask(taskId, { title: fallbackTitle(prompt) });
    }
    return;
  }

  // Move from "Waiting" → "Generating".
  if (task.title === TITLE_WAITING) {
    updateTask(taskId, { title: TITLE_GENERATING });
  }

  try {
    const raw = await runCli(invocation.cmd, invocation.args);
    const parsed = parseResponse(raw);
    if (process.env.AC_LOG_TITLE_GEN) {
      // Opt-in diagnostic. Pipe to a file when starting the app to capture
      // CLI output verbatim while iterating on the prompt format.
      console.log("[title-gen] raw:\n" + raw);
      console.log("[title-gen] parsed:", parsed);
    }
    const fresh = getTask(taskId);
    if (!fresh || fresh.titleManuallySet || !isSentinelTitle(fresh.title)) return; // user edited mid-flight
    if (parsed.title) {
      updateTask(taskId, { title: parsed.title, icon: parsed.icon });
    } else {
      updateTask(taskId, { title: fallbackTitle(prompt) });
    }
  } catch (e) {
    if (process.env.AC_LOG_TITLE_GEN) {
      console.error("[title-gen] CLI error:", e);
    }
    const fresh = getTask(taskId);
    if (fresh && !fresh.titleManuallySet && isSentinelTitle(fresh.title)) {
      updateTask(taskId, { title: fallbackTitle(prompt) });
    }
  }
}
