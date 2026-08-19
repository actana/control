// `actana core exec` against a Core that is actually running, on real
// processes (#266).
//
// `core-exec.test.ts` injects the client and drives the surface — exit codes,
// `--json` shapes, the dropped link. What it cannot say is whether any of it is
// true of a real command on a real machine, and three of this verb's claims are
// exactly that:
//
//   - **the command's real exit code comes back.** `sh -c 'exit 3'` is the
//     acceptance criterion, and nothing short of a real child proves it.
//   - **stdout and stderr are separate, and free of terminal escape
//     sequences.** This is the property the whole verb exists for and the one a
//     PTY cannot have. Asserted below on `ls --color=always`, which is the
//     command that *would* paint if anything on either end were a terminal.
//   - **a cwd is refused by the Core, in the Core's own words.**
//
// So everything here is real except the machine: `packages/core`'s actual
// `PtyCoreLinkServer` on a real `wss://` port with mTLS and a bearer, its
// actual `runCoreExec` behind the `exec` frame, this CLI's actual `connectCore`
// dialling it, and real children being forked at the far end.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCoreExec } from "@actana/core/core-exec";
import { connectCore } from "../core-connection.ts";
import { EXIT_FAILURE, EXIT_LINK_LOST, EXIT_OK } from "../exit-codes.ts";
import { makeCliFixture, type CliFixture } from "./cli-harness.ts";
import { startInProcessCore, type InProcessCore } from "./in-process-core.ts";

let core: InProcessCore | null = null;
let fixture: CliFixture | null = null;
const temporary: string[] = [];

afterEach(async () => {
  fixture?.cleanup();
  fixture = null;
  await core?.stop();
  core = null;
  while (temporary.length > 0) fs.rmSync(temporary.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "actana-exec-live-")));
  temporary.push(dir);
  return dir;
}

/** A Core that really runs what it is asked to, and a CLI registered against it. */
async function liveCore(opts: { maxOutputBytes?: number } = {}): Promise<void> {
  core = await startInProcessCore({
    execPort: {
      run: (input) =>
        runCoreExec({
          ...input,
          ...(opts.maxOutputBytes === undefined ? {} : { maxOutputBytes: opts.maxOutputBytes }),
        }),
    },
  });
  fixture = makeCliFixture();
  const added = await fixture.run(["core", "add", "inproc"], { stdin: core.blobText });
  expect(added.code).toBe(EXIT_OK);
}

/** Every verb below dials the Core for real. */
function withCore() {
  return { connect: connectCore };
}

describe("actana core exec, against a Core in this process", () => {
  it("propagates the command's real exit code — `sh -c 'exit 3'` exits 3", async () => {
    await liveCore();
    const run = await fixture!.run(["core", "exec", "--", "sh", "-c", "exit 3"], withCore());
    expect(run.code, run.err.join("\n")).toBe(3);
  }, 30_000);

  it("exits 0 for a command that succeeded", async () => {
    await liveCore();
    const run = await fixture!.run(["core", "exec", "--", "sh", "-c", "exit 0"], withCore());
    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
  }, 30_000);

  it("keeps stdout and stderr apart, on a command that writes to both", async () => {
    await liveCore();
    const run = await fixture!.run(
      ["core", "exec", "--json", "--", "sh", "-c", "echo to-out; echo to-err >&2; exit 7"],
      withCore(),
    );
    expect(run.code).toBe(7);
    const doc = JSON.parse(run.out.join("\n")) as Record<string, unknown>;
    expect(doc.stdout).toBe("to-out\n");
    expect(doc.stderr).toBe("to-err\n");
    expect(doc.exitCode).toBe(7);
    expect(doc.signal).toBeNull();
  }, 30_000);

  it("gives the command no terminal, so nothing colours itself on the way back", async () => {
    await liveCore();
    const dir = scratch();
    fs.writeFileSync(path.join(dir, "a-file"), "x");
    fs.mkdirSync(path.join(dir, "a-dir"));

    // The crispest form of the claim: ask the command itself. Under a PTY this
    // prints TTY, which is what makes `session logs` need a terminal emulator
    // and what `exec` exists to avoid.
    const isatty = await fixture!.run(
      ["core", "exec", "--", "sh", "-c", "if [ -t 1 ]; then echo TTY; else echo PIPE; fi"],
      withCore(),
    );
    expect(isatty.out).toEqual(["PIPE"]);

    // And the consequence, on the command the criterion names. `--color=auto`
    // is the honest test: it asks `ls` to colour *if it sees a terminal*, and
    // it does not see one. (`--color=always` is not a TTY question at all — it
    // says colour regardless, and it is asserted below precisely to show this
    // CLI is not stripping anything.)
    const auto = await fixture!.run(
      ["core", "exec", "--json", "--cwd", dir, "--", "ls", "--color=auto"],
      withCore(),
    );
    const autoDoc = JSON.parse(auto.out.join("\n")) as Record<string, unknown>;
    expect(autoDoc.exitCode).toBe(0);
    expect(String(autoDoc.stdout)).toContain("a-file");
    expect(String(autoDoc.stdout)).toContain("a-dir");
    expect(String(autoDoc.stdout)).not.toContain("\u001b");
    // Nor on the stream the operator actually reads.
    expect(auto.all).not.toContain("\u001b");
  }, 30_000);

  it("passes bytes through rather than filtering them — the clean output above is the spawn, not a scrubber", async () => {
    await liveCore();
    const dir = scratch();
    // A directory, because that is what default LS_COLORS actually paints — a
    // plain file comes back uncoloured even under `--color=always`, and the
    // assertion below would then be vacuously true.
    fs.mkdirSync(path.join(dir, "a-dir"));

    // `--color=always` overrides the TTY question entirely. If those escapes
    // came back stripped, the assertion above would be measuring a filter in
    // this CLI rather than the absence of a terminal — and a filter is a thing
    // that can be wrong about somebody's actual output.
    const forced = await fixture!.run(
      ["core", "exec", "--json", "--cwd", dir, "--", "ls", "--color=always"],
      withCore(),
    );
    const doc = JSON.parse(forced.out.join("\n")) as Record<string, unknown>;
    // BSD `ls` rejects the long flag; there the question does not arise and the
    // non-zero status is the answer.
    if (doc.exitCode === 0) expect(String(doc.stdout)).toContain("\u001b");
  }, 30_000);

  it("honours --cwd, and it is the Core's directory rather than this process's", async () => {
    await liveCore();
    const dir = scratch();
    const run = await fixture!.run(
      ["core", "exec", "--json", "--cwd", dir, "--", "pwd"],
      withCore(),
    );
    const doc = JSON.parse(run.out.join("\n")) as Record<string, unknown>;
    expect(String(doc.stdout).trim()).toBe(dir);
  }, 30_000);

  it("refuses a bad cwd in the Core's own words, not a client-side guess", async () => {
    await liveCore();
    const missing = path.join(scratch(), "not-here");
    const run = await fixture!.run(["core", "exec", "--cwd", missing, "--", "pwd"], withCore());
    expect(run.code).toBe(EXIT_FAILURE);
    // "on this Core" is the Core's sentence. A client-side check could not have
    // written it, because a client cannot see this filesystem.
    expect(run.err.join("\n")).toContain("No such directory on this Core");
    expect(run.err.join("\n")).toContain(missing);
  }, 30_000);

  it("fails loudly rather than truncating when the output passes the bound", async () => {
    // A deliberately tiny bound, so the assertion is about the refusal rather
    // than about how long a test is willing to wait for 8 MiB.
    await liveCore({ maxOutputBytes: 64 });
    const run = await fixture!.run(
      ["core", "exec", "--json", "--", "sh", "-c", "head -c 4096 /dev/zero | tr ' ' x"],
      withCore(),
    );
    expect(run.code).toBe(EXIT_FAILURE);
    const doc = JSON.parse(run.out.join("\n")) as Record<string, unknown>;
    expect(doc.outcome).toBe("refused");
    expect(doc.code).toBe("exec-output-too-large");
    // The whole point: no half-output anywhere. Not on stdout, not in the
    // document.
    expect(doc.stdout).toBeUndefined();
    expect(run.out.join("\n")).not.toContain("xxxx");
  }, 30_000);

  it("reports a link that died mid-command as unknown, never as a status", async () => {
    await liveCore();
    // Start something slow, then destroy every connection under it. The command
    // is still running on the Core and this CLI can never learn how it ended.
    const running = fixture!.run(
      ["core", "exec", "--", "sh", "-c", "sleep 20; exit 0"],
      withCore(),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    core!.dropConnections();

    const run = await running;
    expect(run.code).toBe(EXIT_LINK_LOST);
    expect(run.code).not.toBe(EXIT_OK);
    expect(run.err.join("\n")).toContain("outcome is unknown");
  }, 60_000);

  it("answers with the Core's own refusal for an executable it cannot find", async () => {
    await liveCore();
    const run = await fixture!.run(["core", "exec", "--", "no-such-binary-266"], withCore());
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.out).toEqual([]);
  }, 30_000);
});
