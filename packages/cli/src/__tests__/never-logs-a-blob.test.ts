// A blob is a credential, and this suite is what makes "never log it" a
// property rather than an intention (#129 D9).
//
// Every verb of the `core` noun is run against a registry holding a blob whose
// CA cert, client cert, private key and bearer are unmistakable sentinels —
// with `--verbose` on, because `--verbose` is the flag most likely to be the
// one that leaks, and because the ticket names it explicitly. Every byte either
// stream emitted is then swept for every sentinel.
//
// The sweep asserts *absence*, which is the only assertion that survives the
// output being rewritten. A test that pinned the exact wording of each line
// would go green the day somebody added a line, and this suite exists for
// exactly the line somebody adds without thinking.

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  fakeSessionGateway,
  fakeStartedSession,
  healthyProbe,
  makeCliFixture,
  sentinelBlobText,
  SENTINELS,
  type CliFixture,
} from "./cli-harness.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/** Fail naming which secret leaked, rather than "output contained a string". */
function expectNoSecrets(what: string, output: string) {
  for (const secret of SENTINELS) {
    const kind = secret.includes("PRIVATE KEY")
      ? "the private key"
      : secret.startsWith("bearer")
        ? "the bearer"
        : "a certificate";
    expect(output, `${what} printed ${kind}`).not.toContain(secret);
  }
  // The bearer and the key are also checked in pieces: a truncated credential
  // is still a credential, and "first 40 characters of the key" is a plausible
  // thing for a well-meaning diagnostic line to print.
  for (const fragment of ["SENTINEL-QQQ", "SENTINEL-ZZZ", "SENTINEL-WWW", "SENTINEL-YYY", "SENTINEL-XXX"]) {
    expect(output, `${what} printed a fragment of a credential`).not.toContain(fragment);
  }
}

describe("no verb prints a blob, with --verbose on", () => {
  it("sweeps add, ls, use, status, rm and the help", async () => {
    const dir = path.join(cli().home, "blobs");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "blob.txt");
    writeFileSync(file, `${sentinelBlobText()}\n`);

    const runs: Array<[string, string[]]> = [
      ["core add (file)", ["core", "add", "prod", file, "--verbose"]],
      ["core ls", ["core", "ls", "--verbose"]],
      ["core ls --json", ["core", "ls", "--json", "--verbose"]],
      ["core use", ["core", "use", "prod", "--verbose"]],
      ["core status", ["core", "status", "--verbose"]],
      ["core status --json", ["core", "status", "--json", "--verbose"]],
      ["core --help", ["core", "--help", "--verbose"]],
      ["core rm", ["core", "rm", "prod", "--verbose"]],
    ];

    for (const [what, argv] of runs) {
      const run = await cli().run(argv, { probe: healthyProbe() });
      expectNoSecrets(what, run.all);
    }
  });

  it("sweeps every session verb, which dials with the same credential (#160)", async () => {
    // The `session` noun resolves a blob on every verb and hands it to a
    // gateway, so it has the credential in scope everywhere — including on the
    // failure path, which is where a diagnostic would quote what it dialled
    // with. The gateway refuses so that path is the one swept; the successes
    // are covered by the verbs above it.
    await cli().run(["core", "add", "prod"], { stdin: sentinelBlobText() });

    const refusing = fakeSessionGateway({
      list: async () => {
        throw new Error("the Core refused");
      },
      kill: async () => {
        throw new Error("the Core refused");
      },
    });
    const starting = fakeSessionGateway({
      start: async () => fakeStartedSession(),
      resume: async () => fakeStartedSession(),
      logs: async () => ({ taskId: "task_1", ptyId: "pty_1", screen: "a screen", raw: "raw" }),
      send: async () => true,
    });

    const runs: Array<[string, string[], typeof refusing]> = [
      ["session ls", ["session", "ls", "--verbose"], refusing],
      ["session ls --json", ["session", "ls", "--json", "--verbose"], refusing],
      ["session kill", ["session", "kill", "task_1", "--verbose"], refusing],
      ["session start", ["session", "start", "web", "go", "--verbose"], starting],
      ["session start --json", ["session", "start", "web", "go", "--json", "--verbose"], starting],
      ["session resume", ["session", "resume", "task_1", "--verbose"], starting],
      ["session logs", ["session", "logs", "task_1", "--verbose"], starting],
      ["session send", ["session", "send", "task_1", "hi", "--verbose"], starting],
      ["session --help", ["session", "--help", "--verbose"], refusing],
    ];

    for (const [what, argv, sessions] of runs) {
      const run = await cli().run(argv, { sessions });
      expectNoSecrets(what, run.all);
    }
  });

  it("sweeps the stdin path, where the blob is in memory rather than on disk", async () => {
    const run = await cli().run(["core", "add", "prod", "--verbose"], {
      stdin: sentinelBlobText(),
    });
    expectNoSecrets("core add (stdin)", run.all);
  });

  it("sweeps single-Core mode, where the blob is in the environment", async () => {
    const run = await cli().run(["core", "status", "--json", "--verbose"], {
      env: { ACTANA_CORE_BLOB: sentinelBlobText() },
      probe: healthyProbe(),
    });
    expectNoSecrets("core status (ACTANA_CORE_BLOB)", run.all);
  });

  it("sweeps the failure paths, which are where a diagnostic would quote its input", async () => {
    // A blob that is *nearly* right is the dangerous case: the decoder has the
    // real credential in hand and is about to explain what is wrong with it.
    const almost = Buffer.from(
      JSON.stringify({
        endpoint: "ws://downgraded.test:9444",
        caCert: SENTINELS[0],
        clientCert: SENTINELS[1],
        clientKey: SENTINELS[2],
        bearer: SENTINELS[3],
      }),
    ).toString("base64");

    const downgraded = await cli().run(["core", "add", "prod", "--verbose"], { stdin: almost });
    expect(downgraded.code).not.toBe(0);
    expectNoSecrets("core add (rejected blob)", downgraded.all);

    // …and a Core that refuses the connection, where the error comes back from
    // the transport with the endpoint and whatever else it chose to include.
    await cli().run(["core", "add", "prod"], { stdin: sentinelBlobText() });
    const refused = await cli().run(["core", "status", "--verbose"], {
      probe: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expectNoSecrets("core status (refused)", refused.all);
  });

  it("prints the endpoint and label, which are the non-secret half", async () => {
    // The counterpart assertion: a sweep that passed because nothing was printed
    // at all would be a sweep that proves nothing.
    await cli().run(["core", "add", "prod"], { stdin: sentinelBlobText("wss://visible.test:9444") });
    const run = await cli().run(["core", "ls", "--json"]);
    expect(run.out.join("\n")).toContain("wss://visible.test:9444");
    expect(run.out.join("\n")).toContain("the-test-core");
  });
});
