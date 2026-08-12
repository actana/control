// The session layer against a Core that is actually running a harness (issue 155).
//
// Opt-in, and skipped unless it is given a machine to drive:
//
//     ACTANA_CORE_BLOB=~/.config/actana/registration-blob.txt \
//     ACTANA_LIVE_PROJECT_ID=p-… \
//     ACTANA_LIVE_CWD=/home/op/projects/scratch \
//       pnpm --filter @actana/sdk test
//
// **Unlike `live-core.test.ts`, this one writes.** It creates a Task, spawns a
// harness, sends it a prompt and kills it, so it wants a scratch Project rather
// than the machine somebody is working on — hence the second and third
// variables, which have no default. Everything it creates it kills; the Task row
// it leaves behind is the record of the run.
//
// Two things only a live Core can show, and both are the ticket's acceptance
// criteria rather than nice-to-haves:
//
//   1. The prompt arrives without this side timing anything. The Core waits for
//      the harness's TUI to settle, answers whatever dialog it opened and sends
//      the carriage return separately (ADR 0026, #191) — so what is asserted
//      here is that the *prompt text is on the harness's screen and answered*,
//      which no in-process rig can fake, because the thing being tested is the
//      Core's reaction to a real TUI's real output.
//   2. `screen()` renders that TUI. The rig's PTY manager emits whatever a test
//      hands it; a real harness emits box drawing, cursor addressing, a spinner
//      and a status line, and the assertion below is that a script reads its
//      answer out of that.
//
// Requires a Core carrying #191 — the prompt-delivery sequence. Against an older
// Core the prompt is written on the flat timer that release deleted, lands in
// the harness's boot sequence, and is lost; the session then sits at `ready`
// until this suite's deadline. That is the dependency this ticket declares, seen
// from the outside.

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { CoreClient } from "../core-client.ts";
import { CoreSession } from "../core-session.ts";
import type { CoreRegistrationBlob } from "../core-registration-blob.ts";

function loadBlob(): CoreRegistrationBlob | null {
  const raw = process.env.ACTANA_CORE_BLOB?.trim();
  if (!raw) return null;
  const source =
    raw.startsWith("~") || raw.startsWith("/")
      ? readFileSync(raw.replace(/^~/, homedir()), "utf8")
      : raw;
  const parsed = JSON.parse(
    Buffer.from(source.trim(), "base64").toString("utf8"),
  ) as CoreRegistrationBlob;
  if (!parsed.endpoint || !parsed.bearer) throw new Error("ACTANA_CORE_BLOB is not a blob");
  return parsed;
}

const blob = loadBlob();
const projectId = process.env.ACTANA_LIVE_PROJECT_ID?.trim();
const cwd = process.env.ACTANA_LIVE_CWD?.trim();
const harness = (process.env.ACTANA_LIVE_HARNESS?.trim() ?? "claude-code") as "claude-code";
const armed = blob !== null && !!projectId && !!cwd;
/** A turn on a real harness is not fast, and this suite waits for a real one. */
const TURN_TIMEOUT_MS = 300_000;

describe.skipIf(!armed)("a Session on a live Core", () => {
  let client: CoreClient | null = null;
  let session: CoreSession | null = null;

  afterEach(async () => {
    if (session) await session.kill().catch(() => undefined);
    session = null;
    client?.close();
    client = null;
  });

  it(
    "starts a harness, has the Core deliver the prompt, and reads the answer off the screen",
    async () => {
      client = CoreClient.fromRegistrationBlob(blob!, { connectTimeoutMs: 15_000 });
      await client.connect();

      const marker = `ACTANA-SDK-LIVE-OK`;
      session = await CoreSession.start(client, {
        projectId,
        cwd: cwd!,
        harness,
        title: "SDK live session test",
        // Text, and no timing with it. Everything about *when* this reaches the
        // harness is decided on the Core.
        prompt: `Reply with exactly: ${marker} and nothing else.`,
      });

      expect(session.ptyId).toBeTruthy();
      expect(session.taskId).toBeTruthy();

      const statuses: string[] = [];
      session.onStatus((s) => statuses.push(s));

      const idle = await session.waitForIdle({ timeoutMs: TURN_TIMEOUT_MS });

      // `running` is the harness's own turn-start hook firing, which happens
      // only once it has *accepted* a prompt. Seeing it is the difference
      // between "the text is on the input line" and "the harness was asked".
      expect(statuses).toContain("running");

      // The Core's own report of the turn, off its event log. Not a guess from
      // the byte stream going quiet.
      expect(["finished", "needs-input"]).toContain(idle.status);
      expect(idle.exited).toBe(false);

      // Read before the kill in `afterEach`: a full-screen harness leaves the
      // alternate screen on the way out, and the transcript with it.
      const screen = session.screen();
      // The prompt reached the harness — this is #191's delivery, observed from
      // outside the Core.
      expect(screen).toContain(marker);
      // And it is a rendered screen rather than a stream of escape codes: the
      // harness's own box drawing is laid out, not stripped into one line.
      expect(screen.split("\n").length).toBeGreaterThan(3);
      expect(screen).not.toContain("\u001B[");
    },
    TURN_TIMEOUT_MS + 30_000,
  );

  it(
    "surfaces the Core's spawn policy rather than pre-empting it",
    async () => {
      // A working directory outside every registered Project root. The refusal
      // is the Core's — this side does not know that machine's Projects, and
      // the point of the assertion is that it did not pretend to.
      client = CoreClient.fromRegistrationBlob(blob!, { connectTimeoutMs: 15_000 });
      await client.connect();

      await expect(
        CoreSession.start(client, {
          projectId,
          cwd: "/",
          harness,
          title: "SDK live rejection test",
        }),
      ).rejects.toThrow(/cwd-outside-project-roots|rejected/);
    },
    60_000,
  );
});
