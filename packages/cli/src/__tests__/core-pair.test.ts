// `actana core pair` — enrollment from the client's side, end to end through
// `runActanaCli` (#285).
//
// The verb has three jobs and this suite is organised as those three. It has to
// *get* a credential the way #280 says (a fingerprint confirmed before a code
// moves, and a code the operator may type in any of the shapes a human types
// one in); it has to *store* that credential exactly where and how the registry
// expects, so that every verb downstream is unchanged; and it has to *refuse*
// legibly — one sentence, one next step and one exit code per failure the SDK
// distinguishes.
//
// The SDK is behind `deps.pairing`, so no test here opens a socket. What is
// deliberately real is the filesystem: file modes, the cores directory and the
// `current` pointer are the subject of half these assertions, and a stubbed
// filesystem would assert nothing about any of them.

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, statSync } from "node:fs";
import { coreBlobPath, readCurrentCore } from "../blob-registry.ts";
import { displayWidth, FRAME_WIDTH } from "../cli-frame.ts";
import { corePairingOutcome } from "../core-pair-results.ts";
import { resolveCore } from "../core-resolution.ts";
import { CorePairingError, type CorePairingFailure } from "@actana/sdk/core-pairing.ts";
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_PAIR_CERTIFICATE_INVALID,
  EXIT_PAIR_CORE_ERROR,
  EXIT_PAIR_FINGERPRINT_MISMATCH,
  EXIT_PAIR_FINGERPRINT_UNCONFIRMED,
  EXIT_PAIR_HOSTNAME_MISMATCH,
  EXIT_PAIR_MALFORMED_RESPONSE,
  EXIT_PAIR_NO_CA,
  EXIT_PAIR_NOT_PAIRABLE,
  EXIT_PAIR_RATE_LIMITED,
  EXIT_PAIR_REFUSED,
  EXIT_PAIR_REJECTED,
  EXIT_PAIR_UNREACHABLE,
  EXIT_USAGE,
} from "../exit-codes.ts";
import {
  fakePairing,
  healthyProbe,
  makeCliFixture,
  PAIRED_FINGERPRINT,
  sentinelPairedBlob,
  SENTINELS,
  type CliFixture,
  type FakePairing,
} from "./cli-harness.ts";
import { fakeSystem } from "./machine-fixture.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/** The pairing session `actana pair new` printed, as this suite spells it. */
const SESSION = "5f2a1c0e-0000-4000-8000-0123456789ab";

/** The code, as it was read out loud. */
const CODE = "ABCD-2345";

/** The three arguments plus the flags a scripted pair carries. */
function pairArgv(extra: string[] = []): string[] {
  return [
    "core",
    "pair",
    "prod",
    "core.test:8443",
    CODE,
    "--session",
    SESSION,
    "--fingerprint",
    PAIRED_FINGERPRINT,
    ...extra,
  ];
}

describe("actana core pair — coming by the credential", () => {
  it("stores what the SDK issued, at 0600, where `core-resolution.ts` finds it", async () => {
    // The acceptance criterion in full: a successful pair is indistinguishable
    // downstream from a pasted blob. `resolveCore` is the module every other
    // noun reaches a Core through, so resolving through it — rather than
    // re-reading the file this test just watched being written — is what
    // actually proves "no change" for `ls`, `use`, `rm`, `status`, `shell` and
    // `exec`.
    const pairing = fakePairing();
    const run = await cli().run(pairArgv(), { pairing });

    expect(run.code).toBe(EXIT_OK);
    expect(run.out.join("\n")).toContain('Paired Core "prod" → wss://core.test:8443');
    expect(statSync(coreBlobPath(cli().paths, "prod")).mode & 0o777).toBe(0o600);

    const resolved = resolveCore({
      paths: cli().paths,
      env: { XDG_CONFIG_HOME: cli().configHome },
      home: cli().home,
      coreFlag: null,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // `label: ""` because the decoder fills one in and the Core's redemption
    // answer carries none — see `encodeRegistrationBlobText`.
    expect(resolved.core.blob).toEqual({ ...sentinelPairedBlob(), label: "" });
    expect(resolved.core.source).toBe("current");
  });

  it("hands the SDK the normalised code, however the operator typed it", async () => {
    // Hyphen and case are the operator's business; what crosses the seam is one
    // shape. The normaliser is #281's, reached through the SDK's public surface
    // — this package has no copy of it and no opinion about the alphabet.
    for (const typed of ["abcd2345", "AbCd-2345", " abcd 2345 ", "ABCD-2345"]) {
      const pairing = fakePairing();
      const run = await cli().run(
        ["core", "pair", "prod", "core.test:8443", typed, "--session", SESSION, "--fingerprint", PAIRED_FINGERPRINT],
        { pairing },
      );
      expect(run.code, `"${typed}" was refused`).toBe(EXIT_OK);
      expect(pairing.paired[0]?.code).toBe("ABCD-2345");
      expect(pairing.paired[0]?.sessionId).toBe(SESSION);
    }
  });

  it("takes the session joined to the code, as `<session>:<code>`", async () => {
    const pairing = fakePairing();
    const run = await cli().run(
      ["core", "pair", "prod", "core.test:8443", `${SESSION}:${CODE}`, "--fingerprint", PAIRED_FINGERPRINT],
      { pairing },
    );
    expect(run.code).toBe(EXIT_OK);
    expect(pairing.paired[0]?.sessionId).toBe(SESSION);
    expect(pairing.paired[0]?.code).toBe(CODE);
  });

  it("says which machine it is, so the Core's `pair ls` has a name for it", async () => {
    const byDefault = fakePairing();
    await cli().run(pairArgv(), { pairing: byDefault, machine: { hostname: "laptop-7" } });
    expect(byDefault.paired[0]?.label).toBe("laptop-7");
    expect(byDefault.paired[0]?.platform).toBe("linux");

    const named = fakePairing();
    await cli().run(pairArgv(["--label", "the-build-box"]), { pairing: named });
    expect(named.paired[0]?.label).toBe("the-build-box");
  });

  it("does not put that label in the stored blob, because it is not the Core's", async () => {
    // A blob from `actana setup` carries the *Core's* alias, which is what the
    // LABEL column of `core ls` means. A paired credential carries none — the
    // redemption answer has no field for one — and inventing one out of this
    // machine's hostname would make that column disagree with itself.
    await cli().run(pairArgv(["--label", "the-build-box"]), { pairing: fakePairing() });
    const listed = await cli().run(["core", "ls", "--json"]);
    const rows = JSON.parse(listed.out.join("\n")) as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        name: "prod",
        current: true,
        endpoint: "wss://core.test:8443",
        label: "",
        insecureMode: false,
        error: null,
      },
    ]);
  });
});

describe("actana core pair — the fingerprint, which is the whole security argument", () => {
  it("refuses with no fingerprint and no terminal, and sends no code", async () => {
    const pairing = fakePairing();
    const run = await cli().run(["core", "pair", "prod", "core.test:8443", CODE, "--session", SESSION], {
      pairing,
    });
    expect(run.code).toBe(EXIT_PAIR_FINGERPRINT_UNCONFIRMED);
    expect(pairing.paired).toEqual([]);
    expect(pairing.identified).toEqual([]);
    expect(run.err.join("\n")).toContain("--fingerprint");
    expect(existsSync(coreBlobPath(cli().paths, "prod"))).toBe(false);
  });

  it("shows the presented fingerprint and pairs when the operator confirms it", async () => {
    const system = fakeSystem();
    system.answers = [true];
    const pairing = fakePairing();
    const run = await cli().run(["core", "pair", "prod", "core.test:8443", CODE, "--session", SESSION], {
      pairing,
      machine: { interactive: true, system },
    });

    expect(run.out.join("\n")).toContain(PAIRED_FINGERPRINT);
    expect(pairing.identified).toEqual(["core.test:8443"]);
    // What was confirmed is what is enforced: the fingerprint handed to `pair`
    // is the one the operator was shown, not an absence that would waive it.
    expect(pairing.paired[0]?.expectedCaFingerprint).toBe(PAIRED_FINGERPRINT);
    expect(run.code).toBe(EXIT_OK);
  });

  it("writes nothing when the operator says the fingerprint does not match", async () => {
    const system = fakeSystem();
    system.answers = [false];
    const pairing = fakePairing();
    const run = await cli().run(["core", "pair", "prod", "core.test:8443", CODE, "--session", SESSION], {
      pairing,
      machine: { interactive: true, system },
    });

    expect(run.code).toBe(EXIT_PAIR_FINGERPRINT_MISMATCH);
    expect(pairing.paired).toEqual([]);
    expect(existsSync(coreBlobPath(cli().paths, "prod"))).toBe(false);
    expect(run.err.join("\n")).toContain("the pairing code was not sent");
  });

  it("writes nothing when the SDK reports a mismatch", async () => {
    // The other half of the same rule: the human check can be skipped with
    // `--fingerprint`, and then the comparison is the SDK's. A credential must
    // not land, and neither must a half-written file.
    const pairing = fakePairing({ fails: "fingerprint-mismatch" });
    const run = await cli().run(pairArgv(), { pairing });

    expect(run.code).toBe(EXIT_PAIR_FINGERPRINT_MISMATCH);
    expect(existsSync(coreBlobPath(cli().paths, "prod"))).toBe(false);
    expect(readCurrentCore(cli().paths)).toBe(null);
    expect(run.err.join("\n")).toContain("Do not retry until you know why");
  });
});

describe("actana core pair — refusals", () => {
  it("writes nothing and exits non-zero when the Core refuses the code", async () => {
    const pairing = fakePairing({ fails: "refused" });
    const run = await cli().run(pairArgv(), { pairing });

    expect(run.code).toBe(EXIT_PAIR_REFUSED);
    expect(run.code).not.toBe(EXIT_OK);
    expect(existsSync(coreBlobPath(cli().paths, "prod"))).toBe(false);
    expect(run.err.join("\n")).toContain("`actana pair new` on the Core");
  });

  it("gives every failure the SDK distinguishes its own exit code and next step", async () => {
    // The table is the acceptance criterion, and it is a table rather than
    // fifteen `it`s because what is being asserted is that the *set* is covered
    // and that no two members answer with the same number.
    const expected: Array<[CorePairingFailure, number]> = [
      ["bad-address", EXIT_USAGE],
      ["unreachable", EXIT_PAIR_UNREACHABLE],
      ["not-pairable", EXIT_PAIR_NOT_PAIRABLE],
      ["no-ca-presented", EXIT_PAIR_NO_CA],
      ["fingerprint-unconfirmed", EXIT_PAIR_FINGERPRINT_UNCONFIRMED],
      ["fingerprint-mismatch", EXIT_PAIR_FINGERPRINT_MISMATCH],
      ["hostname-mismatch", EXIT_PAIR_HOSTNAME_MISMATCH],
      ["certificate-invalid", EXIT_PAIR_CERTIFICATE_INVALID],
      ["refused", EXIT_PAIR_REFUSED],
      ["rate-limited", EXIT_PAIR_RATE_LIMITED],
      ["rejected", EXIT_PAIR_REJECTED],
      ["core-error", EXIT_PAIR_CORE_ERROR],
      ["malformed-response", EXIT_PAIR_MALFORMED_RESPONSE],
    ];

    const seen = new Set<number>();
    for (const [failure, code] of expected) {
      const run = await cli().run(pairArgv(), { pairing: fakePairing({ fails: failure }) });
      expect(run.code, `${failure} exited ${run.code}`).toBe(code);
      // Two lines: what happened, and what to do about it. The second is what
      // an operator at three in the morning is actually reading.
      expect(run.err.length, `${failure} said nothing about what to do next`).toBeGreaterThanOrEqual(2);
      expect(run.err.at(-1)?.length, `${failure}'s next step is empty`).toBeGreaterThan(20);
      seen.add(code);
    }
    // Every code distinct, bar the three input-shape failures that are all
    // `EXIT_USAGE` on purpose — see the block comment in `exit-codes.ts`.
    expect(seen.size).toBe(expected.length);
  });

  it("says how long to wait when the Core said so", async () => {
    const pairing = fakePairing({ fails: "rate-limited", detail: { retryAfterSeconds: 42 } });
    const run = await cli().run(pairArgv(), { pairing });
    expect(run.code).toBe(EXIT_PAIR_RATE_LIMITED);
    expect(run.err.join("\n")).toContain("Wait 42 seconds");
  });

  it("reports a failure on the unverified dial the same way, with nothing sent", async () => {
    const system = fakeSystem();
    const pairing = fakePairing({
      identifyFails: new CorePairingError("unreachable", "https://core.test:8443 could not be reached"),
    });
    const run = await cli().run(["core", "pair", "prod", "core.test:8443", CODE, "--session", SESSION], {
      pairing,
      machine: { interactive: true, system },
    });
    expect(run.code).toBe(EXIT_PAIR_UNREACHABLE);
    expect(pairing.paired).toEqual([]);
  });

  it("treats anything that is not a CorePairingError as a defect, not an operator error", async () => {
    const pairing = fakePairing({ failsWith: new TypeError("cannot read properties of undefined") });
    const run = await cli().run(pairArgv(), { pairing });
    expect(run.code).toBe(EXIT_FAILURE);
    expect(existsSync(coreBlobPath(cli().paths, "prod"))).toBe(false);
  });
});

describe("actana core pair — the command line", () => {
  it("needs a name, an address and a code", async () => {
    for (const argv of [
      ["core", "pair"],
      ["core", "pair", "prod"],
      ["core", "pair", "prod", "core.test:8443"],
    ]) {
      const run = await cli().run(argv, { pairing: fakePairing() });
      expect(run.code).toBe(EXIT_USAGE);
      expect(run.err.join("\n")).toContain("a name, an address and a code are required");
    }
  });

  // #357. `readTicket` refuses a bare code without `--session <id>` or the
  // joined `<session>:<code>` form, and this usage line used to show neither —
  // so an operator who followed it exactly landed on a second refusal for a
  // flag they had never been told about.
  it("shows both required flags in the usage line it prints", async () => {
    const run = await cli().run(["core", "pair", "prod"], { pairing: fakePairing() });
    expect(run.err.join("\n")).toContain(
      "actana core pair <name> <host:port> <code> --session <id> --fingerprint <sha256>",
    );
  });

  it("refuses a fourth argument without echoing it", async () => {
    const run = await cli().run(
      ["core", "pair", "prod", "core.test:8443", CODE, "WXYZ-6789", "--session", SESSION],
      { pairing: fakePairing() },
    );
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("too many arguments");
    expect(run.all).not.toContain("WXYZ-6789");
  });

  it("rejects a name that could become a different path, exactly as `add` does", async () => {
    const run = await cli().run(
      ["core", "pair", "../escape", "core.test:8443", CODE, "--session", SESSION, "--fingerprint", PAIRED_FINGERPRINT],
      { pairing: fakePairing() },
    );
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("Core name");
  });

  it("asks for the session when the code does not name one, before dialling anything", async () => {
    const pairing = fakePairing();
    const run = await cli().run(
      ["core", "pair", "prod", "core.test:8443", CODE, "--fingerprint", PAIRED_FINGERPRINT],
      { pairing },
    );
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("--session");
    expect(pairing.identified).toEqual([]);
    expect(pairing.paired).toEqual([]);
  });

  it("refuses a code that is not one, without printing it back", async () => {
    const pairing = fakePairing();
    const run = await cli().run(
      ["core", "pair", "prod", "core.test:8443", "NOT-A-REAL-CODE", "--session", SESSION, "--fingerprint", PAIRED_FINGERPRINT],
      { pairing },
    );
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("eight characters");
    expect(run.all).not.toContain("NOT-A-REAL-CODE");
    // And the Core was never dialled, so the operator's session still has all
    // five of its attempts.
    expect(pairing.paired).toEqual([]);
  });

  it("does not blame the session when the ids agree and the code is malformed", async () => {
    // The overlap the two cases either side of this one each miss. Both spellings
    // of the session are present and they agree; what is wrong is the code. An
    // operator told to drop `--session` here would be sent after a mistake they
    // did not make, and dropping it would not help.
    const run = await cli().run(
      [
        "core",
        "pair",
        "prod",
        "core.test:8443",
        `${SESSION}:ABCD-234`,
        "--session",
        SESSION,
        "--fingerprint",
        PAIRED_FINGERPRINT,
      ],
      { pairing: fakePairing() },
    );
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("eight characters");
    expect(run.err.join("\n")).not.toContain("--session");
    expect(run.all).not.toContain("ABCD-234");
  });

  it("writes its own sentence for a code the SDK refuses, rather than relaying one that quotes it", async () => {
    // The second door onto `bad-code`: `pairWithCore` parses the ticket again,
    // so a shape this file accepted and the SDK did not arrives through the
    // failure path instead. Its message ends `— "…" is not`, and relaying it
    // would put the code on stderr through the one route the header's rule does
    // not cover.
    const pairing = fakePairing({
      failsWith: new CorePairingError(
        "bad-code",
        `a pairing code is eight characters, written XXXX-XXXX — "${CODE}" is not`,
      ),
    });
    const run = await cli().run(pairArgv(), { pairing });

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("eight characters");
    expect(run.all, "the SDK's sentence was relayed with the code in it").not.toContain(CODE);
    expect(existsSync(coreBlobPath(cli().paths, "prod"))).toBe(false);
  });

  it("refuses two session ids that disagree", async () => {
    const run = await cli().run(
      ["core", "pair", "prod", "core.test:8443", `other-session:${CODE}`, "--session", SESSION, "--fingerprint", PAIRED_FINGERPRINT],
      { pairing: fakePairing() },
    );
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("they have to agree");
  });
});

describe("actana core pair — the registry, unchanged", () => {
  it("makes the first Core `current` and leaves the pointer alone after that", async () => {
    await cli().run(pairArgv(), { pairing: fakePairing() });
    expect(readCurrentCore(cli().paths)).toBe("prod");

    const second = await cli().run(
      ["core", "pair", "spare", "core.test:8443", CODE, "--session", SESSION, "--fingerprint", PAIRED_FINGERPRINT],
      { pairing: fakePairing() },
    );
    expect(readCurrentCore(cli().paths)).toBe("prod");
    expect(second.out.join("\n")).toContain('`current` is still "prod"');
  });

  it("replaces a name already registered, which is what re-pairing is", async () => {
    await cli().run(pairArgv(), { pairing: fakePairing() });
    const again = await cli().run(pairArgv(), {
      pairing: fakePairing({ blob: sentinelPairedBlob("wss://moved.test:8443") }),
    });
    expect(again.code).toBe(EXIT_OK);
    expect(again.out.join("\n")).toContain('Replaced Core "prod"');
    expect(again.out.join("\n")).toContain("wss://moved.test:8443");
  });

  it("leaves every other verb working against what it wrote", async () => {
    await cli().run(pairArgv(), { pairing: fakePairing() });

    const listed = await cli().run(["core", "ls"]);
    expect(listed.out.join("\n")).toContain("prod");
    expect(listed.out.join("\n")).toContain("wss://core.test:8443");

    const status = await cli().run(["core", "status"], { probe: healthyProbe() });
    expect(status.code).toBe(EXIT_OK);
    expect(status.out.join("\n")).toContain("core_test");

    const used = await cli().run(["core", "use", "prod"]);
    expect(used.code).toBe(EXIT_OK);

    const removed = await cli().run(["core", "rm", "prod"]);
    expect(removed.code).toBe(EXIT_OK);
    expect(existsSync(coreBlobPath(cli().paths, "prod"))).toBe(false);
  });
});

describe("actana core pair — what it says", () => {
  it("explains the steps under --verbose without printing the code or the key", async () => {
    const system = fakeSystem();
    system.answers = [true];
    const pairing: FakePairing = fakePairing();
    const run = await cli().run(
      ["core", "pair", "prod", "core.test:8443", CODE, "--session", SESSION, "--verbose"],
      { pairing, machine: { interactive: true, system } },
    );

    expect(run.code).toBe(EXIT_OK);
    const verbose = run.err.join("\n");
    expect(verbose).toContain("with nothing trusted yet");
    expect(verbose).toContain("mode 0600");
    expect(verbose).toContain(`pairing session ${SESSION}`);

    // The two rules, asserted as absence — the only assertion that survives the
    // output being rewritten.
    for (const secret of SENTINELS) {
      expect(run.all, "the credential reached an output sink").not.toContain(secret);
    }
    expect(run.all, "the pairing code reached an output sink").not.toContain(CODE);
    // In either case, and without its hyphen: a code echoed back in any of the
    // shapes it is accepted in is a code in a shell history.
    expect(run.all.toUpperCase(), "the pairing code reached an output sink").not.toContain("ABCD");
  });

  it("is listed in `actana core --help`, and says which machine it runs on", async () => {
    const help = await cli().run(["core", "--help"]);
    expect(help.code).toBe(EXIT_OK);
    const text = help.out.join("\n");
    expect(text).toContain("actana core pair <name> <address> <code>");
    expect(text).toContain("runs on the machine being paired");
    expect(text).toContain("actana pair new");
  });

  it("is named in the verb list an unknown verb prints", async () => {
    const run = await cli().run(["core", "wat"]);
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err.join("\n")).toContain("Verbs: pair, ls");
  });
});

// ─── the two shapes (#360) ──────────────────────────────────────────────────
//
// One command, two audiences — the client half of the split #357 made on the
// Core. Down a pipe `core pair` is the lines 0.4.2 printed and nothing else; at
// a terminal it is a framed result that says what just happened and what to
// type next. The switch is `isatty(stdout)` and nothing else, so the two things
// this suite has to hold are that the piped shape did not move a byte, and that
// the framed one carries a concrete remedy for every class of failure rather
// than the prose that sent an operator to the help.

/** The escape byte, built rather than typed, so no raw control byte is in this file. */
const ESC = String.fromCharCode(0x1b);
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;

/** The three arguments for a second Core, so the pointer has something to keep. */
function sparePairArgv(): string[] {
  return [
    "core",
    "pair",
    "spare",
    "core.test:8443",
    CODE,
    "--session",
    SESSION,
    "--fingerprint",
    PAIRED_FINGERPRINT,
  ];
}

/** Every failure the SDK distinguishes and that a fake Core can be told to raise. */
const SDK_FAILURES: CorePairingFailure[] = [
  "bad-address",
  "unreachable",
  "not-pairable",
  "no-ca-presented",
  "fingerprint-mismatch",
  "hostname-mismatch",
  "certificate-invalid",
  "refused",
  "rate-limited",
  "rejected",
  "core-error",
  "malformed-response",
];

describe("actana core pair, piped", () => {
  it("prints the two success lines byte for byte, in the order 0.4.2 printed them", async () => {
    const run = await cli().run(pairArgv(), { pairing: fakePairing() });

    expect(run.code).toBe(EXIT_OK);
    // Whole, in order — not `toContain`. A framed block that leaked into the
    // piped path, an extra blank line, a reworded pointer note or a fourth line
    // would each fail here, and each of them breaks a script.
    expect(run.out).toEqual([
      'Paired Core "prod" → wss://core.test:8443',
      '`current` now points at "prod".',
    ]);
    expect(run.err).toEqual([]);
  });

  it("keeps the second-Core shape, which names the pointer it did not move", async () => {
    await cli().run(pairArgv(), { pairing: fakePairing() });
    const second = await cli().run(sparePairArgv(), { pairing: fakePairing() });

    expect(second.out).toEqual([
      'Paired Core "spare" → wss://core.test:8443',
      '`current` is still "prod" — `actana core use spare` to switch.',
    ]);
  });

  it("keeps the re-pair shape, which is one line and no pointer note at all", async () => {
    await cli().run(pairArgv(), { pairing: fakePairing() });
    const again = await cli().run(pairArgv(), { pairing: fakePairing() });

    // `current` already names this Core, so 0.4.2 said nothing about it. The
    // framed block *does* have a row for it, and this is the assertion that
    // keeps that row from leaking down here.
    expect(again.out).toEqual(['Replaced Core "prod" → wss://core.test:8443']);
  });

  it("writes no escape sequence, no box drawing and no next steps", async () => {
    const run = await cli().run(pairArgv(), { pairing: fakePairing() });
    const printed = [...run.out, ...run.err].join("\n");

    expect(printed).not.toMatch(/\x1b\[/);
    for (const ornament of ["╭", "╰", "│", "─", "✓", "✗"]) expect(printed).not.toContain(ornament);
    expect(printed).not.toContain("Next steps");
    expect(printed).not.toContain("actana core status");
  });

  it("gives every SDK failure exactly the two lines it gave in 0.4.2", async () => {
    for (const failure of SDK_FAILURES) {
      const run = await cli().run(pairArgv(), { pairing: fakePairing({ fails: failure }) });
      // Two lines: the SDK's sentence, then the one-line next step. Exactly two
      // — the remedy the frame adds is three or four more, and none of them may
      // appear here.
      expect(run.err, `${failure} did not print the 0.4.2 pair of lines`).toEqual([
        `actana core pair: the fake Core answered ${failure}`,
        corePairingOutcome(failure).next,
      ]);
      expect(run.out).toEqual([]);
    }
  });

  it("pins two of those next-step lines by value, not by the table that writes them", async () => {
    // The table is the code under test, so a suite that only compared against
    // it would pass on a rewrite of every line in it. Two spelled out: the
    // class an operator hits most, and the one that matters most.
    const refused = await cli().run(pairArgv(), { pairing: fakePairing({ fails: "refused" }) });
    expect(refused.err[1]).toBe(
      "Ask for a fresh code — `actana pair new` on the Core. Its audit log says which of the four this was.",
    );

    const mismatch = await cli().run(pairArgv(), { pairing: fakePairing({ fails: "fingerprint-mismatch" }) });
    expect(mismatch.err[1]).toBe(
      "Do not retry until you know why: either that is not the Core you were told about, or its credentials " +
        "were reissued and the fingerprint you have is stale. `actana pair new` prints the current one.",
    );
  });

  it("gives every refusal this file words itself exactly the lines it gave in 0.4.2", async () => {
    const missing = await cli().run(["core", "pair", "prod"], { pairing: fakePairing() });
    expect(missing.err).toEqual([
      "actana core pair: a name, an address and a code are required.",
      "  actana core pair <name> <host:port> <code> --session <id> --fingerprint <sha256>",
      "`actana pair new` on the Core prints the code, the fingerprint and the session.",
    ]);

    const extra = await cli().run(
      ["core", "pair", "prod", "core.test:8443", CODE, "WXYZ-6789", "--session", SESSION],
      { pairing: fakePairing() },
    );
    expect(extra.err).toEqual([
      "actana core pair: too many arguments — expected <name> <address> <code>.",
    ]);

    const badName = await cli().run(
      ["core", "pair", "bad name", "core.test:8443", CODE, "--session", SESSION],
      { pairing: fakePairing() },
    );
    expect(badName.err).toEqual([
      "actana core pair: a Core name starts with a letter or digit and holds only letters, digits, dot, dash and underscore.",
    ]);

    const noSession = await cli().run(
      ["core", "pair", "prod", "core.test:8443", CODE, "--fingerprint", PAIRED_FINGERPRINT],
      { pairing: fakePairing() },
    );
    expect(noSession.err).toEqual([
      "actana core pair: a pairing code names the pairing session it belongs to.",
      "Pass `--session <id>` — `actana pair new` prints it beside the code — or the <session>:<code> form.",
    ]);

    const disagree = await cli().run(
      ["core", "pair", "prod", "core.test:8443", `other-session:${CODE}`, "--session", SESSION],
      { pairing: fakePairing() },
    );
    expect(disagree.err).toEqual([
      "actana core pair: the code names one pairing session and `--session` names another.",
      "Drop `--session`, or pass the bare code beside it — they have to agree.",
    ]);

    const shape = await cli().run(
      ["core", "pair", "prod", "core.test:8443", "no", "--session", SESSION, "--fingerprint", PAIRED_FINGERPRINT],
      { pairing: fakePairing() },
    );
    expect(shape.err).toEqual([
      "actana core pair: that was not accepted as a pairing code — hyphen and case do not matter, its shape does.",
      "A pairing code is eight characters, written XXXX-XXXX. `actana pair new` prints a fresh one.",
    ]);
  });

  it("is the same piped shape with NO_COLOR set as without it", async () => {
    const plain = await cli().run(pairArgv(), { pairing: fakePairing() });
    cli().cleanup();
    fixture = null;
    const noColor = await cli().run(pairArgv(), { pairing: fakePairing(), env: { NO_COLOR: "1" } });
    expect(noColor.out).toEqual(plain.out);
  });
});

describe("actana core pair, at a terminal", () => {
  /** The framed lines of a run — the ones the border is drawn on. */
  function framed(lines: string[]): string[] {
    return lines.filter((line) => /^[╭│╰]/.test(line));
  }

  /**
   * Everything a run said, as one line of prose.
   *
   * The escapes come off and every run of whitespace becomes one space, so a
   * sentence can be asserted as the sentence it is rather than as the shape a
   * 74-column wrap happened to give it. Asserting the wrap instead would make
   * every one of these tests fail on a reworded neighbour.
   */
  function prose(lines: string[]): string {
    return lines
      .join(" ")
      .replace(/\x1b\[[0-9;]*m/g, "")
      // The border too: a sentence wrapped across two framed rows has a bar,
      // two runs of padding and a gutter in the middle of it.
      .replace(/[│╭╮╰╯─]/g, " ")
      .replace(/\s+/g, " ");
  }

  it("frames the success, marks it green, and names the Core and its endpoint", async () => {
    const run = await cli().run(pairArgv(), { stdoutIsTty: true, pairing: fakePairing() });
    const screen = run.out.join("\n");

    expect(run.code).toBe(EXIT_OK);
    expect(screen).toContain("╭");
    expect(screen).toContain("╰");
    expect(screen).toContain('Paired Core "prod"');
    expect(screen).toContain("wss://core.test:8443");
    // Green, and only on the marker — nothing on a success is red.
    expect(screen).toContain(`${GREEN}✓`);
    expect(screen).not.toContain(RED);
  });

  it("claims `current` only for a Core that actually became current", async () => {
    const first = await cli().run(pairArgv(), { stdoutIsTty: true, pairing: fakePairing() });
    expect(first.out.join("\n")).toContain('"prod" — every later verb talks to this Core');

    // The second pairing does not move the pointer, and the block has to say so
    // rather than congratulating an operator on a `current` they do not have.
    const second = await cli().run(sparePairArgv(), { stdoutIsTty: true, pairing: fakePairing() });
    const screen = second.out.join("\n");
    expect(readCurrentCore(cli().paths)).toBe("prod");
    expect(screen).toContain('still "prod" — this pairing did not change it');
    expect(screen).not.toContain("every later verb talks to this Core");
    // And the first thing it offers is the command that fixes it.
    expect(screen).toContain("actana core use spare");
  });

  it("offers `core use` only when there is a pointer to move", async () => {
    const run = await cli().run(pairArgv(), { stdoutIsTty: true, pairing: fakePairing() });
    expect(run.out.join("\n")).not.toContain("actana core use prod");
  });

  it("ends in the four verbs a freshly paired Core exists for", async () => {
    const run = await cli().run(pairArgv(), { stdoutIsTty: true, pairing: fakePairing() });
    const screen = run.out.join("\n");

    expect(screen).toContain("Next steps");
    for (const verb of [
      "actana core status",
      "actana project ls",
      "actana harness ls",
      "actana session start <project>",
    ]) {
      expect(screen, `the success block does not teach ${verb}`).toContain(verb);
    }
    // In that order: verify, then look around, then do something.
    expect(screen.indexOf("actana core status")).toBeLessThan(screen.indexOf("actana project ls"));
    expect(screen.indexOf("actana project ls")).toBeLessThan(screen.indexOf("actana harness ls"));
    expect(screen.indexOf("actana harness ls")).toBeLessThan(screen.indexOf("actana session start"));
    // And the Panel, which is the other thing to pair with the same Core.
    expect(screen).toContain("Settings -> Cores");
  });

  it("names this machine as the Core will list it, from --label or the hostname", async () => {
    // The one row about the far end. It is the name an operator looks for in
    // `actana pair ls` on the Core when they come to revoke this client, and a
    // certificate serial is not a name anybody recognises.
    const labelled = await cli().run(pairArgv(["--label", "ada-laptop"]), {
      stdoutIsTty: true,
      pairing: fakePairing(),
    });
    expect(prose(labelled.out)).toContain("Label ada-laptop — this machine, in the Core's `pair ls`");

    // With no --label the hostname is the honest default, and it is the value
    // that was actually sent — not something this block made up to fill a row.
    const pairing = fakePairing();
    const bare = await cli().run(pairArgv(), { stdoutIsTty: true, pairing });
    expect(pairing.paired[0]?.label).toBeTruthy();
    expect(prose(bare.out)).toContain(`Label ${pairing.paired[0]?.label} —`);

    // And nothing about it reaches the piped shape.
    const piped = await cli().run(pairArgv(["--label", "ada-laptop"]), { pairing: fakePairing() });
    expect(piped.out.join("\n")).not.toContain("ada-laptop");
  });

  it("says where the credential landed and at what mode, and never what is in it", async () => {
    const run = await cli().run(pairArgv(), { stdoutIsTty: true, pairing: fakePairing() });

    const inFrame = run.out
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
      .filter((line) => line.startsWith("│"))
      .map((line) => line.replace(/^│\s*/, "").replace(/\s*│$/, ""))
      .join("");
    expect(inFrame).toContain(coreBlobPath(cli().paths, "prod"));
    expect(prose(run.out)).toContain("(mode 0600)");
    for (const secret of SENTINELS) expect(run.all).not.toContain(secret);
  });

  it("frames every failure class, each with a marker and something to type", async () => {
    for (const failure of SDK_FAILURES) {
      const run = await cli().run(pairArgv(), { stdoutIsTty: true, pairing: fakePairing({ fails: failure }) });
      const screen = run.err.join("\n");

      expect(run.code, `${failure} exited ${run.code}`).toBe(corePairingOutcome(failure).exit);
      expect(screen, `${failure} was not framed`).toContain("╭");
      expect(screen, `${failure} carried no red marker`).toContain(`${RED}✗`);
      expect(screen, `${failure} offered no remedy section`).toContain("What to do");
      // The acceptance criterion in full: every class ends with a copyable
      // command, not only an explanation. A command line is the one that is
      // indented two and carries no escape — the notes under it are dim.
      const commands = run.err.filter((line) => /^ {2}\S/.test(line) && !line.startsWith(ESC));
      expect(commands.length, `${failure} ended with an explanation and nothing to type`).toBeGreaterThan(0);
    }
  });

  it("gives no two failure classes the same remedy", async () => {
    // The point of the table: "ask for a fresh code" and "check the port is
    // open" are answers to different problems, and a surface that gave both to
    // both would be the prose it replaced.
    const seen = new Map<string, string>();
    for (const failure of SDK_FAILURES) {
      const remedy = corePairingOutcome(failure)
        .steps.map((step) => `${step.command ?? ""}|${step.note}`)
        .join("\n");
      expect(seen.has(remedy), `${failure} repeats ${seen.get(remedy)}'s remedy`).toBe(false);
      seen.set(remedy, failure);
    }
  });

  it("tells an expired or unknown code how to mint a fresh one, and to re-run with it", async () => {
    const run = await cli().run(pairArgv(), { stdoutIsTty: true, pairing: fakePairing({ fails: "refused" }) });
    const screen = run.err.join("\n");

    expect(screen).toContain("actana pair new --label <name>");
    const said = prose(run.err);
    expect(said).toContain("expired, already spent, never issued, or out of attempts");
    // The mistake this exists to stop: a new code with yesterday's session.
    expect(said).toContain("NEW code");
    expect(said).toContain("NEW --session");
    expect(said).toContain("the old session will not redeem the new code");
  });

  it("explains the fingerprint comparison and warns against going round it", async () => {
    const run = await cli().run(pairArgv(), {
      stdoutIsTty: true,
      pairing: fakePairing({ fails: "fingerprint-mismatch" }),
    });
    const screen = run.err.join("\n");

    const said = prose(run.err);
    expect(said).toContain("compared against the one you gave, and the two differ");
    expect(said).toContain("The code was not sent");
    expect(said).toContain("no flag that skips the comparison");
    expect(said).toContain("somebody sitting between you and the right one");
    expect(screen).toContain("actana pair new --label <name>");
  });

  it("separates a dial failure from a refusal, and says what to check", async () => {
    const unreachable = await cli().run(pairArgv(), {
      stdoutIsTty: true,
      pairing: fakePairing({ fails: "unreachable" }),
    });
    const dial = prose(unreachable.err);
    expect(dial).toContain("a dial failure, not a refusal");
    expect(dial).toContain("no attempt was spent");
    expect(dial).toContain("getent hosts <host>");
    expect(dial).toContain("nc -vz <host> <port>");
    expect(dial).toContain("HTTPS_PROXY");
    // Nothing about minting a fresh code: the code in the operator's hand is
    // still good, and sending them back to the Core would waste the trip.
    expect(dial).not.toContain("actana pair new");

    const answered = await cli().run(pairArgv(), {
      stdoutIsTty: true,
      pairing: fakePairing({ fails: "not-pairable" }),
    });
    const stillWrong = prose(answered.err);
    expect(stillWrong).toContain("The dial worked");
    expect(stillWrong).toContain("actana update");
    expect(stillWrong).not.toContain("getent hosts");
  });

  it("points a bare code at both the flag and the joined form the usage line shows", async () => {
    const run = await cli().run(
      ["core", "pair", "prod", "core.test:8443", CODE, "--fingerprint", PAIRED_FINGERPRINT],
      { stdoutIsTty: true, pairing: fakePairing() },
    );
    const screen = run.err.join("\n");

    expect(run.code).toBe(EXIT_USAGE);
    expect(screen).toContain(
      "actana core pair <name> <host:port> <code> --session <id> --fingerprint <sha256>",
    );
    expect(screen).toContain(
      "actana core pair <name> <host:port> <session>:<code> --fingerprint <sha256>",
    );
    expect(prose(run.err)).toContain("prints the session id on its own line");
  });

  it("wraps a credential path too long for the frame instead of overflowing it", async () => {
    // A deep home directory is ordinary, and the row that reassures an
    // operator their credential exists is the row most likely to be long.
    const deep = "d".repeat(30);
    const run = await cli().run(
      ["core", "pair", deep, "core.test:8443", CODE, "--session", SESSION, "--fingerprint", PAIRED_FINGERPRINT],
      { stdoutIsTty: true, pairing: fakePairing(), env: { NO_COLOR: "1" } },
    );

    for (const line of framed(run.out)) expect(displayWidth(line)).toBe(FRAME_WIDTH);
    const inFrame = framed(run.out)
      .map((line) => line.replace(/^│\s*/, "").replace(/\s*│$/, ""))
      .join("");
    // Wrapped, never shortened: the whole path is still there.
    expect(inFrame).toContain(coreBlobPath(cli().paths, deep));
  });

  it("keeps every framed line exactly the frame's width", async () => {
    // Measured under NO_COLOR, because `displayWidth` counts columns and an
    // escape sequence has none — the padding is computed on the plain text and
    // this is the assertion that says so.
    const runs = [
      await cli().run(pairArgv(), { stdoutIsTty: true, pairing: fakePairing(), env: { NO_COLOR: "1" } }),
      await cli().run(pairArgv(), {
        stdoutIsTty: true,
        pairing: fakePairing({ fails: "refused" }),
        env: { NO_COLOR: "1" },
      }),
      await cli().run(
        ["core", "pair", "prod", "core.test:8443", CODE, "--fingerprint", PAIRED_FINGERPRINT],
        { stdoutIsTty: true, pairing: fakePairing(), env: { NO_COLOR: "1" } },
      ),
    ];
    for (const run of runs) {
      const lines = framed([...run.out, ...run.err]);
      expect(lines.length).toBeGreaterThan(3);
      for (const line of lines) expect(displayWidth(line)).toBe(FRAME_WIDTH);
    }
  });

  it("degrades to no escapes under NO_COLOR, keeping every instruction", async () => {
    const coloured = await cli().run(pairArgv(), { stdoutIsTty: true, pairing: fakePairing() });
    // Back to nothing registered, so the second run is the same first pairing
    // in the same fixture — same credential path, same `current` sentence, and
    // a comparison that is about the escapes and nothing else.
    await cli().run(["core", "rm", "prod"]);
    const plain = await cli().run(pairArgv(), {
      stdoutIsTty: true,
      pairing: fakePairing(),
      env: { NO_COLOR: "1" },
    });

    expect(coloured.out.join("\n")).toMatch(/\x1b\[/);
    expect(plain.out.join("\n")).not.toMatch(/\x1b\[/);
    // Same block, same words, same commands — only the escapes are gone.
    expect(plain.out).toEqual(coloured.out.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")));
    // And the padding was computed on the plain text: strip the escapes off
    // the coloured run and its borders still land in the same column. That is
    // the property a frame padded by `String.length` would fail.
    for (const line of framed(coloured.out)) {
      expect(displayWidth(line.replace(/\x1b\[[0-9;]*m/g, ""))).toBe(FRAME_WIDTH);
    }
  });

  it("never prints the pairing code, framed or not", async () => {
    for (const stdoutIsTty of [true, false]) {
      cli().cleanup();
      fixture = null;
      const run = await cli().run(pairArgv(), { stdoutIsTty, pairing: fakePairing() });
      expect(run.all, "the pairing code reached an output sink").not.toContain(CODE);
      expect(run.all.toUpperCase(), "the pairing code reached an output sink").not.toContain("ABCD");
    }
  });
});
