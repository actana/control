// `actana core exec` — the surface, without a socket (#266).
//
// What is under test is what a Core cannot make on this command's behalf: that
// the command's exit code becomes this process's, that a signal becomes
// `128 + n`, that stdout and stderr stay apart, that `--json` is one document
// on every path including the failures, that Core selection is the same order
// every other verb uses, and — the one that matters most — that a link which
// dies mid-command is never reported as the command's own outcome.
//
// `core-exec-live.test.ts` runs the same verb over a real socket against a real
// Core. This suite is about the surface; that one is about the wire.

import { describe, it, expect, afterEach } from "vitest";
import { fakeCore, makeCliFixture, sentinelBlobText, type CliFixture } from "./cli-harness.ts";
import { EXIT_FAILURE, EXIT_LINK_LOST, EXIT_OK, EXIT_USAGE } from "../exit-codes.ts";
import { EXEC_OUTPUT_TOO_LARGE_ERROR_CODE } from "@actana/sdk/core-link-frames.ts";
import type {
  CoreLinkRequestFrame,
  CoreLinkResponseFrame,
} from "@actana/sdk/core-link-frames.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

async function withRegisteredCore(): Promise<void> {
  const added = await cli().run(["core", "add", "prod"], { stdin: sentinelBlobText() });
  expect(added.code).toBe(EXIT_OK);
}

/** A Core that answers `exec` with one finished command. */
function coreThatRuns(result: {
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}) {
  return fakeCore({
    respond: (frame: CoreLinkRequestFrame): CoreLinkResponseFrame => {
      expect(frame.type).toBe("exec");
      return {
        type: "execResult",
        reqId: "r",
        exitCode: result.exitCode === undefined ? 0 : result.exitCode,
        signal: result.signal ?? null,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  });
}

describe("actana core exec — the command's own exit code", () => {
  it("exits 0 when the command did", async () => {
    await withRegisteredCore();
    const run = await cli().run(["core", "exec", "--", "true"], {
      connect: coreThatRuns({ exitCode: 0 }).connect,
    });
    expect(run.code).toBe(EXIT_OK);
  });

  it("exits 3 when the command did — `sh -c 'exit 3'` is the acceptance criterion", async () => {
    await withRegisteredCore();
    const core = coreThatRuns({ exitCode: 3 });
    const run = await cli().run(["core", "exec", "--", "sh", "-c", "exit 3"], {
      connect: core.connect,
    });
    expect(run.code).toBe(3);
    // And the argv reached the Core as an argv, not as a shell string.
    expect(core.requests[0]).toMatchObject({
      type: "exec",
      command: "sh",
      args: ["-c", "exit 3"],
    });
  });

  it("exits 128 + n when the command was killed by a signal", async () => {
    await withRegisteredCore();
    const run = await cli().run(["core", "exec", "--", "sleep", "99"], {
      connect: coreThatRuns({ exitCode: null, signal: "SIGKILL" }).connect,
    });
    expect(run.code).toBe(137);
  });

  it("falls back to a plain failure for a status this process cannot carry", async () => {
    await withRegisteredCore();
    const run = await cli().run(["core", "exec", "--", "weird"], {
      connect: coreThatRuns({ exitCode: 9999 }).connect,
    });
    expect(run.code).toBe(EXIT_FAILURE);
  });
});

describe("actana core exec — the two streams", () => {
  it("keeps stdout on stdout and stderr on stderr", async () => {
    await withRegisteredCore();
    const run = await cli().run(["core", "exec", "--", "build"], {
      connect: coreThatRuns({ stdout: "out-line\n", stderr: "err-line\n" }).connect,
    });
    expect(run.out.join("")).toBe("out-line\n");
    expect(run.err.join("")).toBe("err-line\n");
  });

  it("does not invent a trailing blank line for output that ended with a newline", async () => {
    await withRegisteredCore();
    const run = await cli().run(["core", "exec", "--", "echo", "hi"], {
      connect: coreThatRuns({ stdout: "hi\n" }).connect,
    });
    expect(run.out.join("")).toBe("hi\n");
  });

  it("does not invent a trailing newline for output that ended without one", async () => {
    await withRegisteredCore();
    // The other direction, and the one a line sink gets wrong: `printf hello`
    // emits no newline, so neither may this. A verb whose argument is that the
    // bytes come back unpainted cannot be the thing that adds one.
    const run = await cli().run(["core", "exec", "--", "printf", "hello"], {
      connect: coreThatRuns({ stdout: "hello" }).connect,
    });
    expect(run.out.join("")).toBe("hello");
  });

  it("is byte-for-byte on both streams, blank lines and all", async () => {
    await withRegisteredCore();
    // Interior structure survives too: a blank line in the middle is the
    // command's, and so is the absence of one at the end.
    const bytes = "one\n\nthree";
    const run = await cli().run(["core", "exec", "--", "emit"], {
      connect: coreThatRuns({ stdout: bytes, stderr: bytes }).connect,
    });
    expect(run.out.join("")).toBe(bytes);
    expect(run.err.join("")).toBe(bytes);
  });

  it("prints nothing at all for a command that said nothing", async () => {
    await withRegisteredCore();
    const run = await cli().run(["core", "exec", "--", "true"], {
      connect: coreThatRuns({}).connect,
    });
    expect(run.out).toEqual([]);
  });

  it("passes bytes through unrendered — an escape the command really emitted survives", async () => {
    await withRegisteredCore();
    // The other half of the claim: this CLI does not strip either. Whatever
    // the command wrote is what a pipe receives, which is what makes the
    // no-escapes property a fact about the *spawn* rather than about a filter
    // here that could be wrong.
    const run = await cli().run(["core", "exec", "--", "printf", "\u001b[31mred"], {
      connect: coreThatRuns({ stdout: "\u001b[31mred" }).connect,
    });
    expect(run.out.join("")).toBe("\u001b[31mred");
  });
});

describe("actana core exec — the two deadlines", () => {
  it("dials with the CLI's default deadline, not the command's 16-minute bound", async () => {
    await withRegisteredCore();
    // `connectCore` spends one `timeoutMs` on both halves — the handshake and
    // the request — so passing the command's bound to `openCore` would give a
    // Core that accepts the socket and never finishes the core-link handshake
    // sixteen silent minutes to do it in. This is the verb built for unattended
    // scripts; the long bound belongs to the request alone, which applies it
    // itself. `events tail` leaves the dial at the default for the same reason.
    const core = coreThatRuns({ exitCode: 0 });
    const run = await cli().run(["core", "exec", "--", "true"], { connect: core.connect });
    expect(run.code).toBe(EXIT_OK);
    expect(core.connectOptions).toEqual([{}]);
  });
});

describe("actana core exec --json", () => {
  it("writes exactly one document on stdout, with the streams separated", async () => {
    await withRegisteredCore();
    const run = await cli().run(["core", "exec", "--json", "--", "build"], {
      connect: coreThatRuns({ exitCode: 2, stdout: "o", stderr: "e" }).connect,
    });
    expect(run.code).toBe(2);
    const doc = JSON.parse(run.out.join("\n")) as Record<string, unknown>;
    expect(doc).toEqual({
      outcome: "exited",
      exitCode: 2,
      signal: null,
      status: 2,
      stdout: "o",
      stderr: "e",
    });
  });

  it("still writes exactly one document when the Core refuses", async () => {
    await withRegisteredCore();
    const core = fakeCore({
      respond: (): CoreLinkResponseFrame => ({
        type: "error",
        reqId: "r",
        message: "No such directory on this Core: /nope",
      }),
    });
    const run = await cli().run(["core", "exec", "--json", "--cwd", "/nope", "--", "ls"], {
      connect: core.connect,
    });
    expect(run.code).toBe(EXIT_FAILURE);
    const doc = JSON.parse(run.out.join("\n")) as Record<string, unknown>;
    expect(doc.outcome).toBe("refused");
    expect(String(doc.error)).toContain("/nope");
  });

  it("writes one document when the Core could not be reached at all", async () => {
    await withRegisteredCore();
    const run = await cli().run(["core", "exec", "--json", "--", "ls"], {
      connect: async () => {
        throw new Error("connection refused");
      },
    });
    expect(run.code).toBe(EXIT_FAILURE);
    // Every outcome carries `error`, so a consumer reading `.error` off the one
    // document never gets `undefined` on one of the four.
    const doc = JSON.parse(run.out.join("\n")) as Record<string, unknown>;
    expect(doc.outcome).toBe("unreachable");
    expect(String(doc.error)).toContain("connection refused");
    expect(run.err.join("\n")).toContain("connection refused");
  });
});

describe("actana core exec — the Core's own refusals", () => {
  it("sends the cwd as the operator typed it and lets the Core refuse it", async () => {
    await withRegisteredCore();
    const core = fakeCore({
      respond: (): CoreLinkResponseFrame => ({
        type: "error",
        reqId: "r",
        message: "Not a directory on this Core: ../../etc",
      }),
    });
    const run = await cli().run(["core", "exec", "--cwd", "../../etc", "--", "ls"], {
      connect: core.connect,
    });
    // Sent verbatim: one place validates a path, and it is the machine that
    // owns the disk. Nothing here resolved it against *this* filesystem.
    expect(core.requests[0]).toMatchObject({ type: "exec", cwd: "../../etc" });
    // And the sentence the operator reads is the Core's, not a local guess.
    expect(run.err.join("\n")).toContain("Not a directory on this Core: ../../etc");
    expect(run.code).toBe(EXIT_FAILURE);
  });

  it("honours --cwd on the happy path too", async () => {
    await withRegisteredCore();
    const core = coreThatRuns({ stdout: "ok\n" });
    await cli().run(["core", "exec", "--cwd", "/srv/app", "--", "pwd"], { connect: core.connect });
    expect(core.requests[0]).toMatchObject({ cwd: "/srv/app" });
  });

  it("omits cwd entirely when the flag was not given, so the Core picks its own home", async () => {
    await withRegisteredCore();
    const core = coreThatRuns({});
    await cli().run(["core", "exec", "--", "pwd"], { connect: core.connect });
    expect("cwd" in (core.requests[0] as object)).toBe(false);
  });

  it("fails loudly on output past the Core's bound, and never prints half of it", async () => {
    await withRegisteredCore();
    const core = fakeCore({
      respond: (): CoreLinkResponseFrame => ({
        type: "error",
        reqId: "r",
        code: EXEC_OUTPUT_TOO_LARGE_ERROR_CODE,
        message: "The command produced more than 8 MiB of output. Nothing was returned.",
      }),
    });
    const run = await cli().run(["core", "exec", "--json", "--", "cat", "/dev/urandom"], {
      connect: core.connect,
    });
    expect(run.code).toBe(EXIT_FAILURE);
    const doc = JSON.parse(run.out.join("\n")) as Record<string, unknown>;
    expect(doc.outcome).toBe("refused");
    // The code is what lets a script tell "too much output" from "would not
    // run" without reading English.
    expect(doc.code).toBe(EXEC_OUTPUT_TOO_LARGE_ERROR_CODE);
    expect(doc.stdout).toBeUndefined();
  });
});

describe("actana core exec — a link that went away mid-command", () => {
  it("exits 125, never the command's code and never 0, and says the fate is unknown", async () => {
    await withRegisteredCore();
    // A Core that takes the frame and then loses the socket: the command is
    // still running over there and this CLI will never learn how it ended.
    const core = fakeCore({
      respond: () =>
        new Promise<CoreLinkResponseFrame>((_resolve, reject) => {
          setTimeout(() => {
            core.emitDisconnected("socket hang up");
            reject(new Error("core-link rpc exec timed out"));
          }, 1);
        }),
    });
    const run = await cli().run(["core", "exec", "--", "long-migration"], {
      connect: core.connect,
    });
    expect(run.code).toBe(EXIT_LINK_LOST);
    expect(run.code).not.toBe(EXIT_OK);
    expect(run.err.join("\n")).toContain("outcome is unknown");
    expect(run.err.join("\n")).toContain("may still be running on the Core");
  });

  it("reports it as its own outcome under --json, with a null exit code", async () => {
    await withRegisteredCore();
    const core = fakeCore({
      respond: () =>
        new Promise<CoreLinkResponseFrame>((_resolve, reject) => {
          setTimeout(() => {
            core.emitDisconnected();
            reject(new Error("dropped"));
          }, 1);
        }),
    });
    const run = await cli().run(["core", "exec", "--json", "--", "long-migration"], {
      connect: core.connect,
    });
    const doc = JSON.parse(run.out.join("\n")) as Record<string, unknown>;
    // The structural distinction the exit code alone cannot carry: this is not
    // `{"outcome":"exited","exitCode":125}` and a script can tell.
    expect(doc.outcome).toBe("link-lost");
    expect(doc.exitCode).toBeNull();
  });

  it("keeps a timeout with no disconnect as an ordinary failure, not a lost link", async () => {
    await withRegisteredCore();
    const run = await cli().run(["core", "exec", "--", "slow"], {
      connect: fakeCore({
        respond: () => Promise.reject(new Error("core-link rpc exec timed out")),
      }).connect,
    });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).not.toContain("outcome is unknown");
  });
});

describe("actana core exec — Core selection and usage", () => {
  it("takes --core, ACTANA_CORE_BLOB and the `current` pointer, in that order", async () => {
    await withRegisteredCore();
    const core = coreThatRuns({});

    // 1. `current`, which `core add` set.
    const viaCurrent = await cli().run(["core", "exec", "--", "true"], { connect: core.connect });
    expect(viaCurrent.code).toBe(EXIT_OK);

    // 2. the environment beats the pointer.
    const viaEnv = await cli().run(["core", "exec", "--verbose", "--", "true"], {
      connect: core.connect,
      env: { ACTANA_CORE_BLOB: sentinelBlobText("wss://env.test:9444") },
    });
    expect(viaEnv.err.join("\n")).toContain("wss://env.test:9444");

    // 3. the flag beats both.
    const added = await cli().run(["core", "add", "other"], {
      stdin: sentinelBlobText("wss://other.test:9444"),
    });
    expect(added.code).toBe(EXIT_OK);
    const viaFlag = await cli().run(
      ["core", "exec", "--core", "other", "--verbose", "--", "true"],
      {
        connect: core.connect,
        env: { ACTANA_CORE_BLOB: sentinelBlobText("wss://env.test:9444") },
      },
    );
    expect(viaFlag.err.join("\n")).toContain("wss://other.test:9444");
  });

  it("refuses with a usage error when no command was given", async () => {
    await withRegisteredCore();
    const run = await cli().run(["core", "exec"], { connect: coreThatRuns({}).connect });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("a command is required");
  });

  it("names `exec` in the help and in the unknown-verb line", async () => {
    const help = await cli().run(["core", "--help"]);
    expect(help.out.join("\n")).toContain("actana core exec");
    const unknown = await cli().run(["core", "wat"]);
    expect(unknown.err.join("\n")).toContain("exec");
  });

  it("hangs up — a link left open after one command is a defect", async () => {
    await withRegisteredCore();
    const core = coreThatRuns({});
    await cli().run(["core", "exec", "--", "true"], { connect: core.connect });
    expect(core.closed).toBe(true);
  });
});
