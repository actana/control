// Title generation for the Panel's own session rows.
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
import { TITLE_GENERATING, TITLE_WAITING, isSentinelTitle } from "~/lib/session-sentinels";
import { runCli } from "./claude-cli";
import { getSession, updateSession } from "./sessions";

export { isTitleGenerationPrompt, parseResponse, resolveTitleInvocation };

export async function generateTitleForSession(sessionId: string, prompt: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;
  if (session.titleManuallySet) return;
  if (!isSentinelTitle(session.title)) return;
  if (!prompt.trim()) return;

  const invocation = resolveTitleInvocation(session.agent, prompt);
  if (!invocation) {
    if (session.title === TITLE_WAITING) {
      await updateSession(sessionId, { title: fallbackTitle(prompt) });
    }
    return;
  }

  if (session.title === TITLE_WAITING) {
    await updateSession(sessionId, { title: TITLE_GENERATING });
  }

  try {
    const raw = await runCli(invocation.cmd, invocation.args);
    const parsed = parseResponse(raw);
    if (process.env.AC_LOG_TITLE_GEN) {
      console.log("[title-gen] raw:\n" + raw);
      console.log("[title-gen] parsed:", parsed);
    }
    const fresh = await getSession(sessionId);
    if (!fresh || fresh.titleManuallySet || !isSentinelTitle(fresh.title)) return;
    if (parsed.title) {
      await updateSession(sessionId, { title: parsed.title, icon: parsed.icon });
    } else {
      await updateSession(sessionId, { title: fallbackTitle(prompt) });
    }
  } catch (e) {
    if (process.env.AC_LOG_TITLE_GEN) {
      console.error("[title-gen] CLI error:", e);
    }
    const fresh = await getSession(sessionId);
    if (fresh && !fresh.titleManuallySet && isSentinelTitle(fresh.title)) {
      await updateSession(sessionId, { title: fallbackTitle(prompt) });
    }
  }
}
