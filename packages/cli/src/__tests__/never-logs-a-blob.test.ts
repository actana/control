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
import { CorePairingError } from "@actana/sdk/core-pairing.ts";
import {
  fakeAttachment,
  fakePairing,
  fakeTerminal,
  fakeCore,
  fakeProjectFiles,
  fakeSessionGateway,
  fakeStartedSession,
  healthyProbe,
  makeCliFixture,
  projectSnapshot,
  registerCore,
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
  it("sweeps ls, use, status, rm and the help", async () => {
    // The sweep used to open with `core add (file)`, the verb that read a blob
    // off disk. #287 removed it, so the registry is arranged directly and the
    // sweep starts at the first verb that *reads* one.
    registerCore(cli().paths, "prod");

    const runs: Array<[string, string[]]> = [
      ["core ls", ["core", "ls", "--verbose"]],
      ["core ls --json", ["core", "ls", "--json", "--verbose"]],
      ["core use", ["core", "use", "prod", "--verbose"]],
      ["core status", ["core", "status", "--verbose"]],
      ["core status --json", ["core", "status", "--json", "--verbose"]],
      ["core --help", ["core", "--help", "--verbose"]],
      ["core shell (no terminal)", ["core", "shell", "--verbose"]],
      ["core rm", ["core", "rm", "prod", "--verbose"]],
    ];

    for (const [what, argv] of runs) {
      const run = await cli().run(argv, { probe: healthyProbe() });
      expectNoSecrets(what, run.all);
    }
  });

  it("sweeps `core pair`, which is handed a credential rather than reading one (#285)", async () => {
    // The verb the sweep would miss if it were only ever run against a registry
    // that already had a blob in it: `core pair` receives one from the SDK and
    // writes it, so every line it prints — the success, the `--verbose` steps,
    // the fingerprint prompt and every refusal — has the material in scope.
    //
    // The pairing **code** is swept alongside the credential here, because this
    // is the one verb that is handed one. It is a bearer secret for as long as
    // its session is open and it must not reach a terminal, a CI log or a shell
    // history any more than the key does.
    //
    // **The sentinel is a code the shape check accepts.** An unmistakable
    // string that could not be a pairing code only ever reaches the one path
    // that refuses it, which would leave the absence assertion vacuous on the
    // three runs that matter most — the confirmed dial, the issued credential
    // and the Core's refusal. So the well-formed sentinel goes through all
    // four, and the malformed one shares its first four characters so a single
    // absence check covers both.
    const CODE = "ZZVV-QQWW";
    const MALFORMED = "ZZVVQQWWXX";
    const session = "session-1";
    const fingerprint = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
    const argv = (code: string, extra: string[] = []) => [
      "core",
      "pair",
      "paired",
      "core.test:8443",
      code,
      "--session",
      session,
      "--verbose",
      ...extra,
    ];

    const runs: Array<[string, string[], Parameters<CliFixture["run"]>[1]]> = [
      // A shape that is refused before anything is dialled.
      ["core pair (bad code)", argv(MALFORMED, ["--fingerprint", fingerprint]), { pairing: fakePairing() }],
      // The interactive confirmation, which prints a fingerprint beside a code
      // it was given.
      [
        "core pair (confirmed)",
        argv(CODE),
        { pairing: fakePairing({ fingerprint }), machine: { interactive: true } },
      ],
      // The success, which has the issued credential in hand.
      [
        "core pair (issued)",
        argv(CODE, ["--fingerprint", fingerprint]),
        { pairing: fakePairing({ fingerprint }) },
      ],
      // And a refusal, where a diagnostic would reach for its input.
      [
        "core pair (refused)",
        argv(CODE, ["--fingerprint", fingerprint]),
        { pairing: fakePairing({ fingerprint, fails: "refused" }) },
      ],
      // And the second door onto `bad-code`: a shape this package accepted and
      // the SDK did not, whose own message ends with the code in quotes.
      [
        "core pair (SDK refused the shape)",
        argv(CODE, ["--fingerprint", fingerprint]),
        {
          pairing: fakePairing({
            fingerprint,
            failsWith: new CorePairingError(
              "bad-code",
              `a pairing code is eight characters, written XXXX-XXXX — "${CODE}" is not`,
            ),
          }),
        },
      ],
    ];

    for (const [what, args, opts] of runs) {
      const run = await cli().run(args, opts);
      expectNoSecrets(what, run.all);
      // Both spellings, and the prefix they share: a code echoed back without
      // its hyphen is a code in a shell history.
      for (const shape of [CODE, MALFORMED, "ZZVV"]) {
        expect(run.all, `${what} printed the pairing code`).not.toContain(shape);
      }
    }

    // The guard on the guard: the well-formed sentinel really is one the shape
    // check takes, so the four runs above reached the paths they name rather
    // than all landing on the refusal that rejects a malformed code.
    const issued = await cli().run(argv(CODE, ["--fingerprint", fingerprint]), {
      pairing: fakePairing({ fingerprint }),
    });
    expect(issued.code, "the sentinel code was refused, so three of these runs proved nothing").toBe(0);
  });

  it("sweeps the nouns that dial with the credential in hand", async () => {
    // `project`, `harness` and `events` (#161) reach a Core, which means the
    // blob is decoded, handed to a client and quoted back by any failure on the
    // way. Every verb runs with `--verbose`, including the paths where the Core
    // refuses — the diagnostic that explains a refusal is the line most likely
    // to reach for its input.
    registerCore(cli().paths, "prod");
    const core = fakeCore({
      projects: [projectSnapshot("api", "/srv/work/api")],
      availability: { opencode: { status: "missing" } },
    });

    const runs: Array<[string, string[]]> = [
      ["project ls", ["project", "ls", "--verbose"]],
      ["project ls --json", ["project", "ls", "--json", "--verbose"]],
      ["project add", ["project", "add", "api", "/srv/work/api", "--verbose"]],
      ["project browse", ["project", "browse", "--verbose"]],
      ["project browse --json", ["project", "browse", "--json", "--verbose"]],
      ["harness ls", ["harness", "ls", "--verbose"]],
      ["harness ls --json", ["harness", "ls", "--json", "--verbose"]],
      ["project --help", ["project", "--help", "--verbose"]],
      ["harness --help", ["harness", "--help", "--verbose"]],
      ["events --help", ["events", "--help", "--verbose"]],
    ];
    for (const [what, argv] of runs) {
      const run = await cli().run(argv, { connect: core.connect });
      expectNoSecrets(what, run.all);
    }

    // …and the two verbs that reach a Core over HTTPS rather than the link
    // (#168). Their gateway holds the same bearer and the same PEM material,
    // and both of them quote paths back in every message they print — including
    // the refusals, which is where an error that reached for its whole input
    // would show up.
    const files = fakeProjectFiles({
      entries: [
        { path: "readme.md", kind: "file", size: 6, mtime: 0, mode: 0o644, sha256: null },
      ],
      progressFor: () => [{ type: "done", entries: 0, bytes: 0 }],
    });
    const fileRuns: Array<[string, string[]]> = [
      ["project files", ["project", "files", "api", "--verbose"]],
      ["project files --json", ["project", "files", "api", "--json", "--verbose"]],
      ["project cp (up)", ["project", "cp", cli().home, "api:build", "--verbose"]],
      ["project cp (bad args)", ["project", "cp", "./a", "./b", "--verbose"]],
    ];
    for (const [what, argv] of fileRuns) {
      const run = await cli().run(argv, { files: files.open });
      expectNoSecrets(what, run.all);
    }

    // …and the one that follows a stream, which has to be driven to its limit.
    const tail = cli().run(["events", "tail", "--since", "start", "--limit", "1", "--verbose"], {
      connect: core.connect,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    core.emitEvent({ eventId: 1, kind: "task:created" });
    expectNoSecrets("events tail", (await tail).all);
  });

  it("sweeps a dial that failed, where the error quotes the endpoint it could not reach", async () => {
    registerCore(cli().paths, "prod");
    for (const argv of [
      ["project", "ls", "--verbose"],
      ["harness", "ls", "--verbose"],
      ["events", "tail", "--verbose"],
      ["project", "files", "api", "--verbose"],
    ]) {
      const refuse = async () => {
        throw new Error("connect ECONNREFUSED");
      };
      const run = await cli().run(argv, { connect: refuse, files: refuse });
      expect(run.code).not.toBe(0);
      expectNoSecrets(argv.join(" "), run.all);
    }
  });

  it("sweeps every session verb, which dials with the same credential (#160)", async () => {
    // The `session` noun resolves a blob on every verb and hands it to a
    // gateway, so it has the credential in scope everywhere — including on the
    // failure path, which is where a diagnostic would quote what it dialled
    // with. The gateway refuses so that path is the one swept; the successes
    // are covered by the verbs above it.
    registerCore(cli().paths, "prod");

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
      send: async () => ({ ok: true }) as const,
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

  it("sweeps single-Core mode, where the blob is in the environment", async () => {
    const run = await cli().run(["core", "status", "--json", "--verbose"], {
      env: { ACTANA_CORE_BLOB: sentinelBlobText() },
      probe: healthyProbe(),
    });
    expectNoSecrets("core status (ACTANA_CORE_BLOB)", run.all);
  });

  it("sweeps the failure paths, which are where a diagnostic would quote its input", async () => {
    // A stored credential that is *nearly* right is the dangerous case: the
    // decoder has the real material in hand and is about to explain what is
    // wrong with it. It arrives through the registry rather than a paste now
    // (#287) — the file a pairing wrote, corrupted since.
    const almost = Buffer.from(
      JSON.stringify({
        endpoint: "ws://downgraded.test:9444",
        caCert: SENTINELS[0],
        clientCert: SENTINELS[1],
        clientKey: SENTINELS[2],
        bearer: SENTINELS[3],
      }),
    ).toString("base64");

    registerCore(cli().paths, "downgraded", almost);
    const listed = await cli().run(["core", "ls", "--verbose"]);
    expectNoSecrets("core ls (unusable entry)", listed.all);
    const selected = await cli().run(["core", "status", "--core", "downgraded", "--verbose"], {
      probe: healthyProbe(),
    });
    expect(selected.code).not.toBe(0);
    expectNoSecrets("core status (unusable entry)", selected.all);

    // …and a Core that refuses the connection, where the error comes back from
    // the transport with the endpoint and whatever else it chose to include.
    //
    // `--core prod` is load-bearing, not decoration. `registerCore` claims
    // `current` only when nothing holds it, so the undecodable entry above took
    // the pointer and keeps it — and a bare `core status` would resolve *that*,
    // fail inside the decoder, and never reach the probe. The sweep would still
    // pass, on a path the leg above already covers, which is the worst way for
    // an absence assertion to be green.
    registerCore(cli().paths, "prod");
    const refused = await cli().run(["core", "status", "--core", "prod", "--verbose"], {
      probe: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(refused.all).toContain("ECONNREFUSED");
    expectNoSecrets("core status (refused)", refused.all);
  });

  it("sweeps `core shell`, the one verb that holds the credential for a whole session", async () => {
    // The dangerous line here is the one that reports a shell that would not
    // open: it has the resolved blob in hand and is explaining a failure to
    // reach the Core the blob names. Everything after that point is bytes the
    // remote shell chose, which never touch a credential.
    registerCore(cli().paths, "prod");
    const run = await cli().run(["core", "shell", "--verbose"], {
      terminal: fakeTerminal(),
      openShell: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(run.code).not.toBe(0);
    expectNoSecrets("core shell (refused)", run.all);
  });

  it("sweeps `session attach`, the other verb that holds the credential for a whole session", async () => {
    // Two lines are worth the sweep here. The one that reports an attach that
    // would not open has the resolved blob in hand and is explaining a failure
    // to reach the Core the blob names; and the one that says *why* an attach is
    // read-only names another Core client, at a moment when the only identity
    // this process holds is a credential. Everything else is bytes the harness
    // chose, which never touch one.
    registerCore(cli().paths, "prod");

    const refused = await cli().run(["session", "attach", "task_1", "--verbose"], {
      terminal: fakeTerminal(),
      openAttach: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(refused.code).not.toBe(0);
    expectNoSecrets("session attach (refused)", refused.all);

    const readOnly = fakeAttachment({ authority: "held-by-another" });
    const terminal = fakeTerminal();
    const attached = cli().run(["session", "attach", "task_1", "--verbose"], {
      terminal,
      openAttach: async () => readOnly,
    });
    // Wired first: a drop delivered before the command is listening is a drop
    // nobody hears, and the run would sit there until the suite timed out.
    await terminal.wired;
    readOnly.drop("socket hang up");
    expectNoSecrets("session attach (read-only, dropped)", (await attached).all);
  });

  it("prints the endpoint and label, which are the non-secret half", async () => {
    // The counterpart assertion: a sweep that passed because nothing was printed
    // at all would be a sweep that proves nothing.
    registerCore(cli().paths, "prod", sentinelBlobText("wss://visible.test:9444"));
    const run = await cli().run(["core", "ls", "--json"]);
    expect(run.out.join("\n")).toContain("wss://visible.test:9444");
    expect(run.out.join("\n")).toContain("the-test-core");
  });
});
