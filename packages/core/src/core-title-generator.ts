// Naming a Session, on the Core.
//
// Decided, not open (issue 84): task metadata is Core-owned, the harness
// binaries this shells out to in print mode exist only on the Core, and the
// prompt that triggers it now arrives at the Core's own hook receiver. Routing
// the prompt back to the Panel and the title back again would buy nothing.
//
// The prompt, the CLI choice and the parsing are shared with the Panel's
// remaining local path (`@actana/shared/title-generation`); what is here is
// the Core's reads and writes — and the one rule that makes the whole thing
// safe: a generated title is written with `titleManuallySet: false`, and every
// check before writing re-reads the row, so an operator's rename that lands
// while the CLI is still thinking is never overwritten. The flag is on the
// row, not in memory, so that protection survives a Panel reload.

import log from "@actana/shared/log";
import {
  fallbackTitle,
  isTitleGenerationPrompt,
  parseResponse,
  resolveTitleInvocation,
} from "@actana/shared/title-generation";
import { TITLE_GENERATING, TITLE_WAITING, isSentinelTitle } from "@actana/shared/task-sentinels";
import type { Harness } from "@actana/shared/domain";
import { runCli } from "./harness-cli-run";
import type { CoreTaskWriter } from "./core-task-writer";

export type CoreTitleGeneratorDeps = {
  writer: CoreTaskWriter;
  /** Injectable for tests; defaults to the real print-mode CLI runner. */
  runCli?: (cmd: string, args: string[]) => Promise<string>;
};

export class CoreTitleGenerator {
  constructor(private readonly deps: CoreTitleGeneratorDeps) {}

  /**
   * Fire-and-forget entry point for every caller that has a prompt — the hook
   * pipeline, and the Panel's terminal capture for harnesses whose hooks do
   * not report one. A failure to name a Session is never a reason to fail
   * what triggered it.
   */
  schedule(taskId: string, prompt: string): void {
    // Never name a Session from this generator's OWN meta-prompt. A headless
    // helper inherits the session's hook env, so if one ever fires these
    // hooks, generating from its prompt is a loop with no end. The guard lives
    // here rather than at each caller so a new caller cannot forget it.
    if (isTitleGenerationPrompt(prompt)) return;
    void this.generate(taskId, prompt).catch((err) => {
      log.warn("title-gen.failed", { taskId, error: String(err) });
    });
  }

  async generate(taskId: string, prompt: string): Promise<void> {
    const task = this.deps.writer.readTask(taskId);
    if (!task) return;
    // Three ways a row is off limits, and all three are re-checked after the
    // CLI returns: the operator named it, it already has a real name, or there
    // is no prompt to name it from.
    if (task.titleManuallySet) return;
    if (!isSentinelTitle(task.title)) return;
    if (!prompt.trim()) return;

    const invocation = resolveTitleInvocation(task.agent as Harness, prompt);
    if (!invocation) {
      if (task.title === TITLE_WAITING) this.writeTitle(taskId, fallbackTitle(prompt), null);
      return;
    }

    if (task.title === TITLE_WAITING) this.writeTitle(taskId, TITLE_GENERATING, null);

    const run = this.deps.runCli ?? runCli;
    let parsed: { title: string; icon: string | null };
    try {
      parsed = parseResponse(await run(invocation.cmd, invocation.args));
    } catch (err) {
      log.info("title-gen.cli-failed", { taskId, error: String(err) });
      const stale = this.deps.writer.readTask(taskId);
      if (stale && !stale.titleManuallySet && isSentinelTitle(stale.title)) {
        this.writeTitle(taskId, fallbackTitle(prompt), null);
      }
      return;
    }

    // Re-read: the operator may have renamed the Session while the CLI ran,
    // and their name wins. This is the race the row-level flag exists for.
    const fresh = this.deps.writer.readTask(taskId);
    if (!fresh || fresh.titleManuallySet || !isSentinelTitle(fresh.title)) return;
    if (parsed.title) this.writeTitle(taskId, parsed.title, parsed.icon);
    else this.writeTitle(taskId, fallbackTitle(prompt), null);
  }

  /**
   * Write a generated title. `titleManuallySet: false` is the load-bearing
   * part: without it the Core's own update helper would pin the row as
   * renamed, and the generator would have locked the operator out of the very
   * protection this flag provides.
   */
  private writeTitle(taskId: string, title: string, icon: string | null): void {
    this.deps.writer.mutate({
      op: "update",
      taskId,
      title,
      titleManuallySet: false,
      ...(icon ? { icon } : {}),
    });
  }
}
