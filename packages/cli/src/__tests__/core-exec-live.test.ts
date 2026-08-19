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
//     PTY cannot have. Asserted below by asking the command itself whether it
//     has a terminal, and then by `ls --color=auto` declining to paint. Its
//     other half — that the clean output is the *spawn* and not a scrubber in
//     this CLI — is a separate test, on bytes the command is told to emit.
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
    expect(isatty.out.join("")).toBe("PIPE\n");

    // And the consequence, on the command the criterion names. `--color=auto`
    // is the honest test: it asks `ls` to colour *if it sees a terminal*, and
    // it does not see one. (What it cannot rule out on its own is a filter in
    // this CLI producing the same clean output; the test below rules that out
    // on bytes of its own choosing, without asking any tool for an opinion.)
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

    // The bytes are chosen *here* rather than left to a tool's opinion about
    // whether anything is worth colouring. This test used to run
    // `ls --color=always` and assert an escape came back, which is a claim
    // about the machine it runs on rather than about this CLI: GNU `ls`
    // disables colour outright when `TERM` is unset, whatever the flag says, so
    // on a CI runner it returned a bare `a-dir\n` and the assertion failed
    // with nothing wrong in the code under test. A `printf` of explicit octal
    // escapes emits the same bytes on every machine, terminal or not, and
    // `\0ddd` under `%b` is the one spelling POSIX pins down.
    //
    // ESC is the byte a scrubber strips first. BEL, BS and DEL are here too
    // because a filter written for "colour" tends to take the rest of C0 with
    // it, and each of those is a byte somebody's program really does emit.
    const bytes = "before\u001b[31mred\u001b[0m\u0007\u0008\u007fafter\n";
    const emit = String.raw`printf "%b" "before\0033[31mred\0033[0m\0007\0010\0177after\n"`;

    const forced = await fixture!.run(
      ["core", "exec", "--json", "--", "sh", "-c", `${emit}; ${emit} >&2`],
      withCore(),
    );
    const doc = JSON.parse(forced.out.join("\n")) as Record<string, unknown>;
    expect(doc.exitCode, forced.err.join("\n")).toBe(0);
    // Byte for byte, on both streams — not "contains an escape" but "is exactly
    // what the command wrote". If these bytes came back stripped or rewritten,
    // the clean output asserted above would be measuring a filter in this CLI
    // rather than the absence of a terminal, and a filter is a thing that can
    // be wrong about somebody's actual output.
    expect(doc.stdout).toBe(bytes);
    expect(doc.stderr).toBe(bytes);

    // And on the stream an operator without `--json` actually reads, where the
    // command's own streams are written through as this process's own.
    const plain = await fixture!.run(["core", "exec", "--", "sh", "-c", emit], withCore());
    expect(plain.code, plain.err.join("\n")).toBe(EXIT_OK);
    // Byte for byte here too, trailing newline included: without `--json` the
    // command's streams go out through the byte sinks, so nothing is added and
    // nothing is taken off.
    expect(plain.out.join("")).toBe(bytes);
    expect(plain.all).toContain("\u001b");

    // And the byte a line sink would have invented: a command that ended
    // without a newline gets none added on the way out.
    const bare = await fixture!.run(
      ["core", "exec", "--", "printf", "%s", "no-newline"],
      withCore(),
    );
    expect(bare.code, bare.err.join("\n")).toBe(EXIT_OK);
    expect(bare.out.join("")).toBe("no-newline");
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
