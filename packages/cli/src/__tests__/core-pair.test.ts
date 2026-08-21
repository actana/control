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
