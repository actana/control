// `actana pair` — the Core-side operator verbs (#283).
//
// The suite drives `runPairCommand` directly, against a real `material.json`
// and a real pairing file on a real temporary disk. Both halves are deliberate.
// The material is real because the fingerprint the command prints is a hash of
// a certificate, and a stub certificate would let a wrong hash pass; the disk
// is real because the whole reason the pairing store is a file is that the CLI
// and the daemon are two processes, and an in-memory double would test a
// version of this command that does not exist.
//
// The daemon's half of revocation — a revoked certificate refused at the gate,
// a revoked bearer refused at the `auth` frame, a live link closed — is not
// here. It cannot be: it happens in another process. It is in
// `packages/core/src/__tests__/core-pairing-revocation.test.ts` and
// `core-link-revocation.test.ts`, which is the seam this command writes to.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  loadMaterialFromFile,
  materialFilePath,
  mintFreshMaterial,
  persistMaterialToFile,
  type PersistedMaterial,
} from "@actana/shared/core-material-store";
import { coreNameError } from "@actana/shared/blob-registry";
import { normalisePairingCode, PAIRING_CODE_ALPHABET } from "@actana/shared/pairing-code";
import { createPairingSession, PAIRING_SESSION_TTL_MS } from "@actana/shared/pairing-session";
import {
  derivePairingCodeKey,
  hashPairingCode,
  pairingCodeMatches,
  PairingStore,
  pairingStorePath,
  type PairedClient,
} from "@actana/shared/pairing-store";
import {
  describeDuration,
  displayWidth,
  FRAME_WIDTH,
  MAX_PAIRING_TTL_MS,
  NAME_PLACEHOLDER,
  PANEL_INSTRUCTION,
  parseDuration,
  runPairCommand,
  wrapFingerprint,
} from "../actana-pair.ts";
import type { ActanaCliDeps } from "../cli-deps.ts";
import { stubClientHalf, stubMachineHalf } from "./machine-fixture.ts";

const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);

let dir: string;
let materialPath: string;
let material: PersistedMaterial;
let out: string[];
let err: string[];
let audited: Record<string, unknown>[];

/**
 * One run of `actana pair <argv>`, with its two streams captured.
 *
 * **stdout is a pipe unless a test says otherwise**, which is the shape the
 * stdout contract is about and the shape everything written before #357
 * asserts against. {@link runTty} is the other one.
 */
function run(
  argv: string[],
  now = NOW,
  env: Record<string, string> = {},
  stdoutIsTty = false,
): number {
  out = [];
  err = [];
  const deps: ActanaCliDeps = {
    ...stubClientHalf(() => now),
    ...stubMachineHalf(),
    argv: ["pair", ...argv],
    env,
    home: dir,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    stdoutIsTty,
  };
  return runPairCommand(deps, argv, {
    materialPath: () => materialPath,
    audit: (record) => audited.push(record),
  });
}

/** The same run with a terminal on stdout — the framed shape (#357). */
function runTty(argv: string[], now = NOW, env: Record<string, string> = {}): number {
  return run(argv, now, env, true);
}

function store(): PairingStore {
  return new PairingStore(pairingStorePath(materialPath));
}

/** A paired client, as the redemption endpoint would have written one. */
function paired(over: Partial<PairedClient> = {}): PairedClient {
  return {
    certSerial: "0a1b2c3d",
    certSubject: "CN=laptop",
    label: "laptop",
    sessionId: "ps_1",
    pairedAt: NOW - 60_000,
    certNotAfter: NOW + 365 * 24 * 60 * 60 * 1000,
    revokedAt: null,
    created_by: null,
    tenant_id: null,
    auth_method: null,
    ...over,
  };
}

/**
 * Record a paired client on the suite's clock rather than the wall clock.
 *
 * `PairingStore.recordClient` defaults `now` to `Date.now()` and prunes settled
 * sessions past `PAIRING_SESSION_RETENTION_MS` on its way past. The fixture's
 * `NOW` is a fixed date, so once the real clock walks a day beyond it every
 * write here silently drops a pending code a test had just minted — a failure
 * that arrives by the calendar, not by a change to the code under test.
 */
function record(client: PairedClient, now = NOW): void {
  store().recordClient(client, now);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-pair-"));
  materialPath = materialFilePath(dir);
  material = await mintFreshMaterial(["10.0.0.5"]);
  persistMaterialToFile(materialPath, material);
  out = [];
  err = [];
  audited = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The value of one `LABEL   value` line from the command's stdout. */
function field(name: string): string {
  const line = out.find((l) => l.startsWith(name));
  if (!line) throw new Error(`no "${name}" line in:\n${out.join("\n")}`);
  return line.slice(name.length).trim();
}

// ─── pair new ───────────────────────────────────────────────────────────────

describe("actana pair new", () => {
  it("prints a well-formed code from the unambiguous alphabet", () => {
    expect(run(["new", "--label", "laptop"])).toBe(0);
    const code = field("Pairing code");
    // Built from the alphabet rather than written out, so the assertion cannot
    // drift from it: a hand-typed `[A-Z2-9]` would admit `O`, `I` and `L`, which
    // are three of the five characters #281 drops precisely because a human
    // transcribes them wrong.
    expect(code).toMatch(new RegExp(`^[${PAIRING_CODE_ALPHABET}]{4}-[${PAIRING_CODE_ALPHABET}]{4}$`));
    for (const excluded of ["0", "O", "1", "I", "L"]) expect(code).not.toContain(excluded);
    expect(normalisePairingCode(code)).toBe(code);
  });

  it("prints a fingerprint that matches this Core's own CA", () => {
    run(["new"]);
    expect(field("CA fingerprint")).toBe(new X509Certificate(material.caCert).fingerprint256);
    expect(field("CA fingerprint")).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
  });

  it("defaults the TTL to the shared five-minute constant, not a literal here", () => {
    run(["new"]);
    const session = store().listSessions()[0]!;
    expect(session.expiresAt - session.createdAt).toBe(PAIRING_SESSION_TTL_MS);
    expect(field("Expires")).toContain("in 5 minutes");
  });

  it("honours --ttl, in the session and in what it printed", () => {
    run(["new", "--ttl", "30s"]);
    const session = store().listSessions()[0]!;
    expect(session.expiresAt - session.createdAt).toBe(30_000);
    expect(field("Expires")).toBe("2026-08-20T12:00:30Z (in 30 seconds)");
  });

  it("prints the expiry as an absolute time AND a relative one", () => {
    run(["new", "--ttl", "2h"]);
    expect(field("Expires")).toBe("2026-08-20T14:00:00Z (in 2 hours)");
  });

  it("refuses a --ttl with no unit rather than guessing seconds or minutes", () => {
    expect(run(["new", "--ttl", "5"])).toBe(2);
    expect(err.join("\n")).toMatch(/number and a unit/);
    expect(store().listSessions()).toEqual([]);
  });

  it("refuses a TTL longer than the store keeps a settled session", () => {
    expect(run(["new", "--ttl", "48h"])).toBe(2);
    expect(parseDuration("48h")).toEqual({
      error: expect.stringContaining("cannot exceed") as unknown as string,
    });
    expect(MAX_PAIRING_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("stores a digest of the code and never the code itself", () => {
    run(["new", "--label", "laptop"]);
    const code = field("Pairing code");
    const session = store().listSessions()[0]!;
    expect(JSON.stringify(session)).not.toContain(code);
    expect(JSON.stringify(session)).not.toContain(code.replace("-", ""));
    // And the digest is one the daemon can check, which is the only thing that
    // makes storing a digest rather than the code workable at all.
    expect(
      pairingCodeMatches(
        session.codeHash,
        hashPairingCode({
          key: derivePairingCodeKey(material.bearerSecret),
          sessionId: session.id,
          code,
        }),
      ),
    ).toBe(true);
  });

  it("mints a different code every time", () => {
    run(["new"]);
    const first = field("Pairing code");
    run(["new"]);
    expect(field("Pairing code")).not.toBe(first);
    expect(store().listSessions()).toHaveLength(2);
  });

  it("keeps stdout to the facts, and the prose on stderr", () => {
    run(["new", "--label", "laptop"]);
    expect(out.every((line) => /^(Pairing code|CA fingerprint|Expires|Label|Session) /.test(line))).toBe(true);
    expect(err.join("\n")).toMatch(/Read the code AND the fingerprint/);
  });

  it("says so rather than writing a session when this Core has no material", () => {
    fs.rmSync(materialPath);
    expect(run(["new"])).toBe(1);
    expect(err.join("\n")).toMatch(/no pairing material/);
    expect(fs.existsSync(pairingStorePath(materialPath))).toBe(false);
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    expect(run(["new", "--tll", "5m"])).toBe(2);
    expect(err.join("\n")).toMatch(/--tll/);
  });

  it("refuses a bare positional instead of minting an unlabelled code", () => {
    // `actana pair new laptop` used to exit 0 having minted a code called
    // nothing. The operator reads it out believing it is `laptop`, `pair ls`
    // shows `(unnamed)`, and `pair revoke laptop` says nothing matches.
    expect(run(["new", "laptop"])).toBe(2);
    expect(err.join("\n")).toMatch(/unexpected argument "laptop"/);
    expect(err.join("\n")).toMatch(/--label laptop/);
    expect(store().listSessions()).toEqual([]);
  });

  it("refuses a single-dash flag rather than reading it as a positional", () => {
    expect(run(["new", "-l", "laptop"])).toBe(2);
    expect(err.join("\n")).toMatch(/unknown option: -l/);
    expect(store().listSessions()).toEqual([]);
  });

  it("refuses to mint against a pairing file it cannot read", () => {
    // `createSession` reads the whole document, adds a session and writes it
    // back — so minting on a corrupt file replaces it, taking the record of who
    // was revoked with it. The daemon would then read a clean store and serve
    // every revoked certificate again.
    fs.writeFileSync(pairingStorePath(materialPath), '{"version":1,"clients":[{"certSerial"');
    expect(run(["new", "--label", "laptop"])).toBe(1);
    expect(err.join("\n")).toMatch(/not valid JSON/);
    expect(err.join("\n")).toMatch(/refuses every client it has paired/);
    expect(err.join("\n")).toMatch(/Do not delete it/);
    // And the file it declined to rewrite is exactly as it was.
    expect(fs.readFileSync(pairingStorePath(materialPath), "utf8")).toBe(
      '{"version":1,"clients":[{"certSerial"',
    );
  });
});

// ─── pair new --public-host (#347) ──────────────────────────────────────────
//
// A Core whose certificate covers several addresses can pair each client to
// the one it can reach. The flag **chooses** from that list; it can never add
// to it, because a code that handed back an address the certificate does not
// cover would give its client a credential that fails on its first dial. The
// refusal is therefore the load-bearing half of this feature, not its edge
// case, and it is what these tests spend most of their assertions on.

describe("actana pair new --public-host", () => {
  /** This suite's Core is reachable three ways, which is the case at issue. */
  async function multiHost(): Promise<void> {
    material = await mintFreshMaterial(["core", "10.0.0.5", "core.example.test"]);
    persistMaterialToFile(materialPath, material);
  }

  it("records the chosen host on the session, and says so on stdout", async () => {
    await multiHost();

    expect(run(["new", "--label", "laptop", "--public-host", "10.0.0.5"])).toBe(0);

    expect(field("Endpoint host")).toBe("10.0.0.5");
    const session = store().getSession(field("Session"))!;
    expect(session.endpointHost).toBe("10.0.0.5");
  });

  it("leaves the session on the primary when the flag is omitted", async () => {
    await multiHost();

    expect(run(["new", "--label", "laptop"])).toBe(0);

    // Null, not the primary spelled into the row: the daemon resolves an
    // unchosen endpoint against whatever this Core is configured with when the
    // code is redeemed, which is today's behaviour and stays it.
    const session = store().getSession(field("Session"))!;
    expect(session.endpointHost).toBeNull();
    expect(out.join("\n")).not.toContain("Endpoint host");
  });

  it("takes any host on the list, not only the primary", async () => {
    await multiHost();
    for (const host of ["core", "10.0.0.5", "core.example.test"]) {
      expect(run(["new", "--public-host", host])).toBe(0);
      expect(field("Endpoint host")).toBe(host);
    }
  });

  it("trims what the operator typed, as the configured list was trimmed", async () => {
    await multiHost();
    expect(run(["new", "--public-host", " 10.0.0.5 "])).toBe(0);
    expect(store().getSession(field("Session"))!.endpointHost).toBe("10.0.0.5");
  });

  // **The constraint the whole design rests on.** A pairing code may not name
  // an address this Core's certificate has no SAN for. Refused before anything
  // is written, and the refusal prints the addresses that would have worked —
  // an operator who typed the wrong one needs the right ones more than they
  // need to be told they were wrong.
  it("refuses a host that is not configured, and prints the ones that are", async () => {
    await multiHost();

    expect(run(["new", "--label", "laptop", "--public-host", "192.168.1.20"])).toBe(2);

    const said = err.join("\n");
    expect(said).toContain("192.168.1.20");
    expect(said).toMatch(/not one of this Core's configured public hosts/);
    // No spaces: an operator pastes this back into `--public-host`, where
    // `core, 10.0.0.5` is two shell words and only the first reaches the flag.
    expect(said).toContain("core,10.0.0.5,core.example.test");
    expect(said).toContain("Omit --public-host to use core, the first of them.");
    // #353 review C3: on metal `ACTANA_PUBLIC_HOST` exists nowhere — the list
    // came from `--public-host` at setup — so naming it would send the operator
    // to grep for an unset variable.
    expect(said).toContain("Configured (actana setup --public-host):");
    expect(said).not.toContain("ACTANA_PUBLIC_HOST");
    // Nothing was minted: no code was printed, and no session was written.
    expect(out).toEqual([]);
    expect(store().listSessions()).toEqual([]);
  });

  it("names the container's own variable when it is running in one", async () => {
    // The other half of C3: in a container the list really does come from
    // `ACTANA_PUBLIC_HOST` in the operator's compose file, and that is where
    // they go to change it. Same refusal, the source named per shape of Core —
    // the rule `parsePublicHosts`'s `varName` parameter exists for.
    await multiHost();

    expect(
      run(["new", "--label", "laptop", "--public-host", "192.168.1.20"], NOW, {
        ACTANA_CONTAINER: "1",
      }),
    ).toBe(2);

    const said = err.join("\n");
    expect(said).toContain("Configured (ACTANA_PUBLIC_HOST):");
    expect(said).not.toContain("actana setup --public-host):");
  });

  // The loopback pair is on every certificate this Core signs (ADR 0032 D9) and
  // is still deliberately not selectable (ADR 0038 D4). The refusal therefore
  // has to give a different reason for them, because the ordinary one — "the
  // certificate does not cover it" — is false about `127.0.0.1`.
  it("refuses a loopback address without claiming the certificate lacks it", async () => {
    await multiHost();

    for (const loopback of ["127.0.0.1", "localhost"]) {
      expect(run(["new", "--public-host", loopback])).toBe(2);
      const said = err.join("\n");
      expect(said).toContain(`${loopback} is in this Core's certificate`);
      expect(said).toMatch(/deliberately not selectable/);
      // The true reason is reachability: handed to a client on another machine
      // it would name that machine.
      expect(said).toMatch(/would name that machine, not this Core/);
      expect(store().listSessions()).toEqual([]);
    }
  });

  it("gives an ordinary refusal no loopback sentence", async () => {
    await multiHost();
    expect(run(["new", "--public-host", "192.168.1.20"])).toBe(2);
    expect(err.join("\n")).not.toMatch(/is in this Core's certificate/);
  });

  it("refuses a near miss rather than resolving it to something close", async () => {
    await multiHost();
    // Prefixes, suffixes and case are all somebody else's address.
    for (const wrong of ["10.0.0.50", "core.example", "CORE", "localhost"]) {
      expect(run(["new", "--public-host", wrong])).toBe(2);
      expect(store().listSessions()).toEqual([]);
    }
  });

  it("refuses an empty value rather than reading it as the primary", async () => {
    await multiHost();
    expect(run(["new", "--public-host="])).toBe(2);
    expect(err.join("\n")).toMatch(/--public-host needs an address/);
    expect(store().listSessions()).toEqual([]);
  });

  // Material written before the SAN list was recorded has nothing to check
  // membership against, and guessing is the one thing this flag exists to
  // prevent. A code without the flag still mints, so the Core is not bricked.
  it("refuses when this Core's material records no configured hosts", () => {
    persistMaterialToFile(materialPath, { ...material, serverHosts: [] });

    expect(run(["new", "--public-host", "10.0.0.5"])).toBe(2);
    expect(err.join("\n")).toMatch(/does not record which addresses/);
    expect(store().listSessions()).toEqual([]);

    expect(run(["new", "--label", "laptop"])).toBe(0);
  });

  it("names the flag in its help, with the rule that binds it", () => {
    expect(run(["new", "--help"])).toBe(0);
    const help = out.join("\n");
    expect(help).toContain("--public-host <addr>");
    expect(help).toMatch(/certificate already covers/);
  });
});

// ─── pair new, the two shapes (#357) ────────────────────────────────────────
//
// One command, two audiences. Down a pipe it is the labelled lines a script
// cuts fields out of; at a terminal it is a framed handout that says what the
// code is for and what to type on the other machine. The switch is
// `isatty(stdout)` and nothing else — there is deliberately no `--json` and no
// flag — so the two things this suite has to hold are that the piped shape did
// not move a byte, and that the framed one carries everything an operator needs
// to finish the job without retyping a fingerprint.

describe("actana pair new, piped", () => {
  /** The 0.4.2 shape, written out rather than derived from the code under test. */
  function expectedLines(over: { label?: string; endpointHost?: string } = {}): string[] {
    const lines = [
      `Pairing code   ${field("Pairing code")}`,
      `CA fingerprint ${new X509Certificate(material.caCert).fingerprint256}`,
      "Expires        2026-08-20T12:05:00Z (in 5 minutes)",
    ];
    if (over.label) lines.push(`Label          ${over.label}`);
    if (over.endpointHost) lines.push(`Endpoint host  ${over.endpointHost}`);
    lines.push(`Session        ${field("Session")}`);
    return lines;
  }

  it("prints the labelled lines byte for byte, in the order 0.4.2 printed them", () => {
    expect(run(["new", "--label", "laptop"])).toBe(0);
    // Every line, whole, in order — not `toContain`. A framed block that leaked
    // into the piped path, an extra blank line, a changed column width or a
    // reordered field would each fail here, and each of them breaks a script.
    expect(out).toEqual(expectedLines({ label: "laptop" }));
  });

  it("keeps the unlabelled shape, which has no Label line at all", () => {
    expect(run(["new"])).toBe(0);
    expect(out).toEqual(expectedLines());
  });

  it("keeps `Endpoint host` where it was, between Label and Session", async () => {
    material = await mintFreshMaterial(["core", "10.0.0.5"]);
    persistMaterialToFile(materialPath, material);

    expect(run(["new", "--label", "laptop", "--public-host", "10.0.0.5"])).toBe(0);

    expect(out).toEqual(expectedLines({ label: "laptop", endpointHost: "10.0.0.5" }));
  });

  it("writes no escape sequence, no box drawing and no instructions", () => {
    run(["new", "--label", "laptop"]);
    const printed = out.join("\n");
    expect(printed).not.toMatch(/\x1b\[/);
    for (const ornament of ["╭", "│", "─"]) expect(printed).not.toContain(ornament);
    expect(printed).not.toContain("From the Panel");
    expect(printed).not.toContain("From a terminal");
    expect(printed).not.toContain("npm i -g");
  });

  it("is the shape a Core with several addresses prints too", async () => {
    // The framed path prints one command per address. Down a pipe the several
    // addresses change nothing at all: same five lines.
    material = await mintFreshMaterial(["core", "10.0.0.5", "core.example.test"]);
    persistMaterialToFile(materialPath, material);

    expect(run(["new", "--label", "laptop"])).toBe(0);

    expect(out).toEqual(expectedLines({ label: "laptop" }));
  });
});

describe("actana pair new, at a terminal", () => {
  /** Everything stdout saw, as one string. */
  function screen(): string {
    return out.join("\n");
  }

  /** The pasteable command lines — the ones that start the client verb. */
  function commands(): string[] {
    return out.map((line) => line.trim()).filter((line) => line.startsWith("actana core pair "));
  }

  it("frames the code, and the code is what was minted", () => {
    expect(runTty(["new", "--label", "laptop"])).toBe(0);

    const session = store().listSessions()[0]!;
    const code = /([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(screen())?.[1];
    expect(code).toBeDefined();
    // The digest in the store is the digest of the code on the screen, which is
    // the only thing that makes the framed shape the same shape.
    expect(
      pairingCodeMatches(
        session.codeHash,
        hashPairingCode({
          key: derivePairingCodeKey(material.bearerSecret),
          sessionId: session.id,
          code: code!,
        }),
      ),
    ).toBe(true);
    expect(screen()).toContain("╭");
    expect(screen()).toContain("Pairing code");
  });

  it("prints the expiry beside the code, absolute and relative", () => {
    runTty(["new", "--ttl", "2h"]);
    expect(screen()).toContain("2026-08-20T14:00:00Z (in 2 hours)");
  });

  it("prints the WHOLE fingerprint, wrapped rather than shortened", () => {
    runTty(["new", "--label", "laptop"]);

    const fingerprint = new X509Certificate(material.caCert).fingerprint256;
    expect(fingerprint.split(":")).toHaveLength(32);

    // Inside the frame it is wrapped: no framed line holds the whole of it,
    // and the framed lines that hold pieces of it re-join to exactly the value
    // — nothing dropped, nothing elided, nothing rewritten.
    const framed = out.filter((line) => line.includes("│"));
    expect(framed.some((line) => line.includes(fingerprint))).toBe(false);
    const rejoined = framed
      .map((line) => /([0-9A-F]{2}(?::[0-9A-F]{2}){7,}:?)/.exec(line)?.[1] ?? "")
      .join("");
    expect(rejoined).toBe(fingerprint);
    for (const elision of ["...", "…"]) expect(screen()).not.toContain(elision);
    // And the pasteable command carries it whole, on one line, because that is
    // the copy a client actually checks the certificate against.
    expect(commands()[0]).toContain(`--fingerprint ${fingerprint}`);
  });

  it("prints the session id", () => {
    runTty(["new"]);
    const sessionId = store().listSessions()[0]!.id;
    expect(screen()).toContain(sessionId);
  });

  // The Panel's form asks for the address *first*, and until now the
  // frame was the one surface that never said what to put in it — `Endpoint
  // host` prints only down a pipe and only for `--public-host`. An operator at
  // a terminal read four values off the box and had to derive the fifth.
  describe("the endpoint row", () => {
    /** The framed lines only, stripped of colour. */
    function box(): string[] {
      return out
        .filter((line) => line.includes("│"))
        .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    }

    it("names the address inside the frame, not only under it", () => {
      expect(runTty(["new", "--label", "laptop"])).toBe(0);
      expect(box().some((line) => line.includes("Endpoint"))).toBe(true);
      expect(box().some((line) => line.includes("10.0.0.5:8443"))).toBe(true);
    });

    it("sits above the fingerprint, the order the Panel's form gates them in", () => {
      // Address, then fingerprint, then session and code — `PANEL_INSTRUCTION`.
      // A box that has to be read out of order into the form is a box that
      // will be read out of order into the form.
      runTty(["new", "--label", "laptop"]);
      const at = (needle: string) => box().findIndex((line) => line.includes(needle));
      expect(at("Endpoint")).toBeGreaterThan(-1);
      expect(at("CA fingerprint")).toBeGreaterThan(at("Endpoint"));
      expect(at("Session")).toBeGreaterThan(at("CA fingerprint"));
    });

    it("is the address the credential names, not whichever one a command dials", async () => {
      // The endpoint a paired client keeps comes off the stored session, so on
      // a Core with three addresses there is still exactly one true answer to
      // "what will this code register" — and it is the primary. Printing the
      // dialled address here instead would contradict the `# dial …` notes.
      material = await mintFreshMaterial(["core", "10.0.0.5", "core.example.test"]);
      persistMaterialToFile(materialPath, material);

      expect(runTty(["new", "--label", "laptop"])).toBe(0);

      expect(box().some((line) => line.includes("Endpoint       core:8443"))).toBe(true);
      // The other two are offered as commands, and only as commands.
      for (const other of ["10.0.0.5:8443", "core.example.test:8443"]) {
        expect(box().some((line) => line.includes(other))).toBe(false);
        expect(commands().some((command) => command.includes(other))).toBe(true);
      }
    });

    it("follows --public-host, because that is what the credential will carry", async () => {
      material = await mintFreshMaterial(["core", "10.0.0.5"]);
      persistMaterialToFile(materialPath, material);

      expect(runTty(["new", "--label", "laptop", "--public-host", "10.0.0.5"])).toBe(0);

      expect(box().some((line) => line.includes("Endpoint       10.0.0.5:8443"))).toBe(true);
    });

    it("wraps a long address rather than clipping it, and stays square", async () => {
      // An address with an ellipsis in it is an address that fails to dial —
      // the same rule the fingerprint follows, for the same reason.
      const long = `a-very-long-core-host-name.${"sub.".repeat(8)}example.invalid`;
      material = await mintFreshMaterial([long]);
      persistMaterialToFile(materialPath, material);

      expect(runTty(["new", "--label", "laptop"])).toBe(0);

      // Measured on the plain text: an escape sequence has a length and no
      // width, which is the whole reason `frameRow` pads the way it does.
      for (const line of box()) expect(displayWidth(line)).toBe(FRAME_WIDTH);
      for (const elision of ["...", "…"]) expect(screen()).not.toContain(elision);

      // Nothing dropped: the rows under the `Endpoint` heading, in order and
      // with nothing but the border and the gutter taken off, re-join to
      // exactly the address — separators included.
      const content = box().map((line) => line.replace(/^│/, "").replace(/│$/, "").trim());
      const heading = content.findIndex((line) => line === "Endpoint");
      expect(heading).toBeGreaterThan(-1);
      const rest = content.slice(heading + 1);
      const rejoined = rest.slice(0, rest.indexOf("")).join("");
      expect(rejoined).toBe(`${long}:8443`);
    });

    it("changes nothing down a pipe", () => {
      // The frame is where this row lives. The piped shape is what every script
      // wrapping `pair new` reads, and it did not grow a field.
      expect(run(["new", "--label", "laptop"])).toBe(0);
      expect(out.some((line) => line.startsWith("Endpoint "))).toBe(false);
    });
  });

  // The wording is pinned to the *form*, not to a paraphrase of it.
  // `AddCoreByPairing.tsx` asks for the address first, gates everything behind
  // a compared CA fingerprint — "the Panel does not send the code until they
  // match" — and only then shows Session and Pairing code. An instruction that
  // named only the code sent an operator to a form that wanted two things
  // first, one of them the security-relevant one (#357 review B1).
  it("gives the Panel path in the order the Panel's own form asks for it", () => {
    runTty(["new", "--label", "laptop"]);
    expect(screen()).toContain("From the Panel");
    expect(screen()).toContain(PANEL_INSTRUCTION);
    expect(PANEL_INSTRUCTION).toBe(
      "Settings (gear icon) -> Cores -> Add a Core: this Core's address, then compare the " +
        "CA fingerprint, then the session and the code",
    );
    // Every field the form requires is named, in the form's order, and the
    // fingerprint comparison is not dropped — it is what makes the first dial
    // verifiable, and the frame above prints the fingerprint without this
    // sentence saying what it is for.
    const address = PANEL_INSTRUCTION.indexOf("address");
    const fingerprint = PANEL_INSTRUCTION.indexOf("fingerprint");
    const session = PANEL_INSTRUCTION.indexOf("session");
    const code = PANEL_INSTRUCTION.indexOf("code");
    expect(address).toBeGreaterThan(-1);
    expect(fingerprint).toBeGreaterThan(address);
    expect(session).toBeGreaterThan(fingerprint);
    expect(code).toBeGreaterThan(session);
    expect(PANEL_INSTRUCTION).toContain("compare");
  });

  it("gives the terminal path: the install, then a command with real values", () => {
    expect(runTty(["new", "--label", "laptop"])).toBe(0);

    expect(screen()).toContain("From a terminal");
    expect(screen()).toContain("npm i -g @actana/cli");

    const session = store().listSessions()[0]!;
    const code = /([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(screen())![1]!;
    const fingerprint = new X509Certificate(material.caCert).fingerprint256;
    expect(commands()).toEqual([
      `actana core pair laptop 10.0.0.5:8443 ${code} --session ${session.id} --fingerprint ${fingerprint}`,
    ]);
    // One address, and it is the one the credential will name, so there is
    // nothing to warn about.
    expect(screen()).toContain("# dial 10.0.0.5:8443 — and that is the endpoint this code registers");
    expect(screen()).not.toContain("still registers");
    // The install line comes before the command it installs the binary for.
    expect(screen().indexOf("npm i -g @actana/cli")).toBeLessThan(screen().indexOf("actana core pair "));
  });

  // The other half of the ticket: `readTicket` refuses a bare code, so a
  // pasteable line without `--session` is a line that fails on arrival.
  it("carries --session, with the id of the session it just minted", () => {
    runTty(["new", "--label", "laptop"]);
    const session = store().listSessions()[0]!;
    for (const command of commands()) {
      expect(command).toContain(`--session ${session.id}`);
      expect(command).toContain("--fingerprint ");
    }
  });

  it("offers one command per configured address, the primary first", async () => {
    material = await mintFreshMaterial(["core", "10.0.0.5", "core.example.test"]);
    persistMaterialToFile(materialPath, material);

    expect(runTty(["new", "--label", "laptop"])).toBe(0);

    const addresses = commands().map((command) => command.split(" ")[4]);
    expect(addresses).toEqual(["core:8443", "10.0.0.5:8443", "core.example.test:8443"]);
  });

  // #357 review B2. The endpoint a paired client keeps comes off the stored
  // session, never off the address it dialled — so a code minted without
  // `--public-host` registers the primary for *every* command in the block.
  // A comment that said only "reachable at 10.0.0.5" was true about the dial
  // and false about the result: pair from a machine that cannot resolve
  // `core`, and `actana core status` fails right after a successful pairing
  // with nothing on screen explaining it.
  it("says which endpoint the credential will carry, per address", async () => {
    material = await mintFreshMaterial(["core", "10.0.0.5", "core.example.test"]);
    persistMaterialToFile(materialPath, material);

    expect(runTty(["new", "--label", "laptop"])).toBe(0);

    const printed = screen();
    // The primary dials and registers the same address: nothing to warn about.
    expect(printed).toContain("# dial core:8443 — and that is the endpoint this code registers");
    // Every other address says what it really leaves behind, and how to get a
    // code that does register it — the `--public-host` workflow #347 designed.
    for (const host of ["10.0.0.5", "core.example.test"]) {
      expect(printed).toContain(`# dial ${host}:8443 — but this code still registers core:8443`);
      expect(printed).toContain(
        `#   to register ${host}:8443: actana pair new --label laptop --public-host ${host}`,
      );
    }
    // And the untruth is gone: no address is described as one you keep unless
    // it is one you keep.
    expect(printed).not.toContain("reachable at 10.0.0.5");
  });

  it("drops --label from the re-mint hint when there is no usable label", async () => {
    material = await mintFreshMaterial(["core", "10.0.0.5"]);
    persistMaterialToFile(materialPath, material);

    runTty(["new"]);

    expect(screen()).toContain("#   to register 10.0.0.5:8443: actana pair new --public-host 10.0.0.5");
  });

  it("warns about nothing when --public-host made dial and endpoint agree", async () => {
    material = await mintFreshMaterial(["core", "10.0.0.5", "core.example.test"]);
    persistMaterialToFile(materialPath, material);

    expect(runTty(["new", "--label", "laptop", "--public-host", "10.0.0.5"])).toBe(0);

    // The session records the choice, so redemption hands back 10.0.0.5 — the
    // address the one command dials.
    expect(store().listSessions()[0]!.endpointHost).toBe("10.0.0.5");
    expect(screen()).toContain("# dial 10.0.0.5:8443 — and that is the endpoint this code registers");
    expect(screen()).not.toContain("still registers");
    expect(screen()).not.toContain("to register");
  });

  it("offers only the chosen address when --public-host chose one", async () => {
    material = await mintFreshMaterial(["core", "10.0.0.5", "core.example.test"]);
    persistMaterialToFile(materialPath, material);

    expect(runTty(["new", "--label", "laptop", "--public-host", "10.0.0.5"])).toBe(0);

    // That is the endpoint redemption will hand this client, so a command
    // pointing anywhere else would pair it to an address the code did not pick.
    expect(commands().map((command) => command.split(" ")[4])).toEqual(["10.0.0.5:8443"]);
  });

  it("dials the port this install recorded, not a guess", () => {
    fs.writeFileSync(
      path.join(dir, "actana.json"),
      JSON.stringify({
        version: "0.4.3",
        port: 9443,
        host: "0.0.0.0",
        publicHost: "10.0.0.5",
        label: "core-1",
        installDir: dir,
        dataDir: dir,
      }),
    );

    runTty(["new", "--label", "laptop"]);

    expect(commands()[0]).toContain(" 10.0.0.5:9443 ");
  });

  it("dials the container's port when it is running in one", () => {
    runTty(["new", "--label", "laptop"], NOW, { ACTANA_CONTAINER: "1", ACTANA_PORT: "7443" });
    expect(commands()[0]).toContain(" 10.0.0.5:7443 ");
  });

  it("falls back to 8443 rather than printing no command at all", () => {
    // No `actana.json` beside the material: an operator with a wrong port can
    // fix one character, and an operator with no command has to build it.
    runTty(["new", "--label", "laptop"]);
    expect(commands()[0]).toContain(" 10.0.0.5:8443 ");
  });

  it("uses a placeholder name when there is no label to use", () => {
    runTty(["new"]);
    expect(commands()[0]).toContain("actana core pair NAME ");
  });

  it("uses a placeholder when the label is not a name the client registry takes", () => {
    // `--label` takes anything an operator wants to call a machine; a Core name
    // does not. Pasting `my laptop` would fail on the far machine with a
    // message about a registry nobody mentioned.
    runTty(["new", "--label", "my laptop"]);
    expect(commands()[0]).toContain("actana core pair NAME ");
    // The label is still the label — it is on the frame and in the store.
    expect(screen()).toContain("my laptop");
    expect(store().listSessions()[0]!.label).toBe("my laptop");
  });

  // #357 review B3. `<name>` is not inert in a shell: pasted into bash it is
  // "read stdin from a file called `name`, write stdout to a file called
  // `10.0.0.5:8443`", and the command never runs. This is the assertion that
  // was missing — not that a placeholder is *present*, but that the line the
  // block promises is pasteable actually survives being pasted.
  it("emits a line a real shell parses into the words it printed", () => {
    for (const argv of [["new"], ["new", "--label", "my laptop"], ["new", "--label", "laptop"]]) {
      runTty(argv);
      const command = commands()[0]!;
      // `sh -c 'printf %s\n <the line>'` is the whole test: a shell reads the
      // line as a command with arguments and hands them back. A redirection,
      // a glob or a quote would consume a word, redirect the output or fail
      // outright — and each of those is a paste that does not work.
      const echoed = execFileSync("/bin/sh", ["-c", `printf '%s\n' ${command}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(echoed.split("\n").filter(Boolean)).toEqual(command.split(" "));
    }
  });

  it("never puts a shell metacharacter in the pasteable line", () => {
    // The belt to the braces above: the line is built from a label, an address,
    // a code, a uuid and colon-hex, and none of those may bring a character a
    // shell would act on.
    for (const argv of [["new"], ["new", "--label", "my laptop"], ["new", "--label", "laptop"]]) {
      runTty(argv);
      expect(commands()[0]).not.toMatch(/[<>|&;$`()'"*?[\]{}\\]/);
    }
  });

  it("names the placeholder in one place, and it is shell-safe there", () => {
    expect(NAME_PLACEHOLDER).toBe("NAME");
    // A slot an operator forgets to edit registers a Core called NAME, which
    // one `actana core rm NAME` undoes. A shell error undoes nothing.
    expect(coreNameError(NAME_PLACEHOLDER)).toBeNull();
  });

  it("colours at a terminal, and the frame stays square anyway", () => {
    runTty(["new", "--label", "laptop"]);
    const printed = out.join("\n");
    expect(printed).toMatch(/\x1b\[1;36m/);
    // Padding measured on the plain text, so every framed row is the same
    // *display* width despite the escapes having a length and no width.
    const framed = out.filter((line) => line.includes("│")).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(framed.length).toBeGreaterThan(5);
    expect(new Set(framed.map((line) => [...line].length))).toEqual(new Set([74]));
  });

  // #357 review N1. `String.length` is UTF-16 code units, and `--label` takes
  // anything: a CJK label measured that way lands the right border early, and
  // an over-long one pushes it out. The label is the row that gives — never
  // the fingerprint, which wraps instead.
  it("keeps the frame square for a wide label, measured in columns", () => {
    runTty(["new", "--label", "笔记本"], NOW, { NO_COLOR: "1" });
    const framed = out.filter((line) => line.includes("│"));
    expect(framed.length).toBeGreaterThan(5);
    for (const line of framed) expect(displayWidth(line)).toBe(FRAME_WIDTH);
    expect(screen()).toContain("笔记本");
  });

  it("clips an over-long label rather than bending the frame", () => {
    const long = "l".repeat(200);
    runTty(["new", "--label", long], NOW, { NO_COLOR: "1" });

    const framed = out.filter((line) => line.includes("│"));
    for (const line of framed) expect(displayWidth(line)).toBe(FRAME_WIDTH);
    // Clipped, and marked as clipped.
    expect(screen()).toContain("…");
    expect(screen()).not.toContain(long);
    // The label the operator gave is untouched everywhere it matters: in the
    // store, and in the piped shape.
    expect(store().listSessions()[0]!.label).toBe(long);
    expect(run(["new", "--label", long])).toBe(0);
    expect(out).toContain(`Label          ${long}`);
  });

  it("clips the label and never the fingerprint", () => {
    runTty(["new", "--label", "l".repeat(200)], NOW, { NO_COLOR: "1" });
    const fingerprint = new X509Certificate(material.caCert).fingerprint256;
    const framed = out.filter((line) => line.includes("│"));
    const rejoined = framed
      .map((line) => /([0-9A-F]{2}(?::[0-9A-F]{2}){7,}:?)/.exec(line)?.[1] ?? "")
      .join("");
    expect(rejoined).toBe(fingerprint);
  });

  it("degrades to no escapes under NO_COLOR, keeping every instruction", () => {
    runTty(["new", "--label", "laptop"], NOW, { NO_COLOR: "1" });
    const printed = out.join("\n");
    expect(printed).not.toMatch(/\x1b\[/);
    expect(printed).toContain("From the Panel");
    expect(printed).toContain("From a terminal");
    expect(commands()).toHaveLength(1);
  });

  it("mints exactly what the piped shape mints — only the printing differs", () => {
    expect(runTty(["new", "--label", "laptop", "--ttl", "30s"])).toBe(0);
    const session = store().listSessions()[0]!;
    expect(session.expiresAt - session.createdAt).toBe(30_000);
    expect(session.label).toBe("laptop");
    // The prose on stderr is the same prose, terminal or not: it is not what a
    // scraper reads, and it is what a human is told either way.
    expect(err.join("\n")).toMatch(/Read the code AND the fingerprint/);
    expect(err.join("\n")).toContain(`actana pair revoke ${session.id}`);
  });

  it("still stores a digest and never the code, framed or not", () => {
    runTty(["new", "--label", "laptop"]);
    const code = /([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(out.join("\n"))![1]!;
    const session = store().listSessions()[0]!;
    expect(JSON.stringify(session)).not.toContain(code);
    expect(JSON.stringify(session)).not.toContain(code.replace("-", ""));
  });

  it("refuses the same things it refuses down a pipe, and frames nothing", () => {
    expect(runTty(["new", "--ttl", "5"])).toBe(2);
    expect(out).toEqual([]);
    expect(store().listSessions()).toEqual([]);
  });
});

describe("wrapFingerprint", () => {
  it("keeps every group, and marks the break with the separator", () => {
    const fingerprint = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0").toUpperCase()).join(":");
    const lines = wrapFingerprint(fingerprint);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.endsWith(":")).toBe(true);
    expect(lines[1]!.endsWith(":")).toBe(false);
    // Rejoinable, exactly: a wrapped fingerprint is the same value with a line
    // break in it, and never a shortened one.
    expect(lines.join("")).toBe(fingerprint);
  });

  it("cannot shorten its input, whatever it is asked for", () => {
    for (const perLine of [0, 1, 5, 999]) {
      expect(wrapFingerprint("AA:BB:CC:DD", perLine).join("")).toBe("AA:BB:CC:DD");
    }
  });
});


// ─── pair ls ────────────────────────────────────────────────────────────────

describe("actana pair ls", () => {
  it("says the list is empty rather than printing an empty table", () => {
    expect(run(["ls"])).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/Pending codes\n\s+None\./);
    expect(text).toMatch(/Paired clients\n\s+None\./);
    expect(text).not.toMatch(/LABEL/);
  });

  it("shows pending codes and paired clients in two separate sections", () => {
    run(["new", "--label", "laptop"]);
    record(paired({ label: "desktop", certSubject: "CN=desktop" }));

    expect(run(["ls"])).toBe(0);
    const text = out.join("\n");
    const pendingAt = text.indexOf("Pending codes");
    const pairedAt = text.indexOf("Paired clients");
    expect(pendingAt).toBeGreaterThanOrEqual(0);
    expect(pairedAt).toBeGreaterThan(pendingAt);
    expect(text.slice(pendingAt, pairedAt)).toMatch(/laptop/);
    expect(text.slice(pairedAt)).toMatch(/desktop.*CN=desktop/s);
  });

  it("shows a pending code's label, created, expiry and attempts used of five", () => {
    run(["new", "--label", "laptop"]);
    run(["ls"]);
    const row = out.find((line) => line.includes("laptop"))!;
    expect(row).toContain("2026-08-20T12:00:00Z");
    expect(row).toContain("2026-08-20T12:05:00Z");
    expect(row).toContain("0 of 5");
  });

  it("never prints a pairing code", () => {
    run(["new", "--label", "laptop"]);
    const code = field("Pairing code");
    run(["ls"]);
    expect(out.join("\n")).not.toContain(code);
    expect(out.join("\n")).not.toContain(code.replace("-", ""));
    // Nor the digest of it: `ls` publishes named fields, not the stored row.
    expect(out.join("\n")).not.toContain(store().listSessions()[0]!.codeHash);
  });

  it("leaves a code out of --json too", () => {
    run(["new", "--label", "laptop"]);
    const code = field("Pairing code");
    const hash = store().listSessions()[0]!.codeHash;
    run(["ls", "--json"]);
    const payload = JSON.parse(out.join("\n")) as {
      pending: { label: string; attemptCap: number }[];
      clients: unknown[];
    };
    expect(payload.pending[0]!.label).toBe("laptop");
    expect(payload.pending[0]!.attemptCap).toBe(5);
    expect(out.join("\n")).not.toContain(code);
    expect(out.join("\n")).not.toContain(hash);
  });

  it("drops a session that is no longer redeemable from the pending section", () => {
    run(["new", "--label", "laptop", "--ttl", "30s"]);
    expect(run(["ls"], NOW + 31_000)).toBe(0);
    expect(out.join("\n")).toMatch(/Pending codes\n\s+None\./);
  });

  it("refuses a bare positional", () => {
    expect(run(["ls", "laptop"])).toBe(2);
    expect(err.join("\n")).toMatch(/unexpected argument "laptop"/);
  });

  it("says the file is unreadable rather than reporting a Core that paired nobody", () => {
    record(paired());
    fs.writeFileSync(pairingStorePath(materialPath), "{ not json");
    expect(run(["ls"])).toBe(1);
    expect(err.join("\n")).toMatch(/not valid JSON/);
    expect(out.join("\n")).not.toMatch(/None\./);
  });

  it("keeps a revoked client visible, and says it is revoked", () => {
    record(paired());
    store().revokeClient("0a1b2c3d", NOW);
    run(["ls"]);
    expect(out.join("\n")).toMatch(/revoked 2026-08-20T12:00:00Z/);
  });
});

// ─── pair revoke ────────────────────────────────────────────────────────────

describe("actana pair revoke", () => {
  it("marks a paired client revoked, by label", () => {
    record(paired());
    expect(run(["revoke", "laptop"])).toBe(0);
    expect(store().listClients()[0]!.revokedAt).toBe(NOW);
    expect(out.join("\n")).toMatch(/Unpaired laptop/);
  });

  it("takes a certificate serial, including a prefix of one", () => {
    record(paired({ certSerial: "0a1b2c3d4e5f", label: "" }));
    expect(run(["revoke", "0a1b2c"])).toBe(0);
    expect(store().listClients()[0]!.revokedAt).toBe(NOW);
  });

  it("stops the credential working — which is what the daemon reads", () => {
    // This command's whole output on the wire is this row. The daemon's
    // enforcement is tested where it lives; what is pinned here is that the
    // fact it enforces on is written, and written against the serial that
    // identifies the issuance rather than the label.
    record(paired({ certSerial: "0a1b2c3d" }));
    run(["revoke", "laptop"]);
    const row = store().listClients().find((c) => c.certSerial === "0a1b2c3d")!;
    expect(row.revokedAt).toBe(NOW);
    expect(out.join("\n")).toMatch(/certificate and its bearer stop working/);
    expect(out.join("\n")).toMatch(/closes any link it has open/);
  });

  it("cancels a pending session so its code can never be redeemed", () => {
    run(["new", "--label", "laptop"]);
    const sessionId = field("Session");

    expect(run(["revoke", sessionId])).toBe(0);
    expect(store().consume(sessionId, NOW)).toEqual({ ok: false, reason: "revoked" });
    expect(out.join("\n")).toMatch(/Cancelled the pending code/);
  });

  it("cancels a pending session named by its label", () => {
    run(["new", "--label", "laptop"]);
    const sessionId = field("Session");
    expect(run(["revoke", "laptop"])).toBe(0);
    expect(store().consume(sessionId, NOW)).toEqual({ ok: false, reason: "revoked" });
  });

  it("refuses to guess when a label matches more than one thing", () => {
    record(paired({ label: "laptop", certSerial: "aaaa" }));
    record(paired({ label: "laptop", certSerial: "bbbb" }));
    expect(run(["revoke", "laptop"])).toBe(1);
    expect(err.join("\n")).toMatch(/matches 2 of them/);
    expect(store().listClients().every((c) => c.revokedAt === null)).toBe(true);
  });

  it("says so when nothing matches, and revokes nothing", () => {
    record(paired());
    expect(run(["revoke", "nobody"])).toBe(1);
    expect(err.join("\n")).toMatch(/nothing here matches/i);
    expect(store().listClients()[0]!.revokedAt).toBe(null);
  });

  it("needs a target", () => {
    expect(run(["revoke"])).toBe(2);
    expect(err.join("\n")).toMatch(/a target is required/);
  });

  it("refuses a blank target rather than matching everything", () => {
    // `actana pair revoke "$SERIAL"` with `SERIAL` unset. `""` prefix-matches
    // every serial and every session id, and on a Core with exactly one client
    // the ambiguity check never fires — so it used to revoke it and exit 0.
    record(paired());
    expect(run(["revoke", ""])).toBe(2);
    expect(err.join("\n")).toMatch(/a target is required/);
    expect(store().listClients()[0]!.revokedAt).toBe(null);

    expect(run(["revoke", "   "])).toBe(2);
    expect(store().listClients()[0]!.revokedAt).toBe(null);
  });

  it("refuses a blank target even when a pending code is the only thing here", () => {
    run(["new", "--label", "laptop"]);
    const sessionId = field("Session");
    expect(run(["revoke", ""])).toBe(2);
    expect(store().consume(sessionId, NOW).ok).toBe(true);
  });

  it("refuses to revoke against a pairing file it cannot read", () => {
    record(paired());
    const corrupt = '{"version":1,"sessions":[],"clients":[{"certSerial":7}]}';
    fs.writeFileSync(pairingStorePath(materialPath), corrupt);
    expect(run(["revoke", "laptop"])).toBe(1);
    expect(err.join("\n")).toMatch(/is not a client this build knows/);
    expect(fs.readFileSync(pairingStorePath(materialPath), "utf8")).toBe(corrupt);
  });

  it("audit-logs the revocation through the same auditor the endpoint uses", () => {
    record(paired());
    run(["revoke", "laptop"]);
    expect(audited).toEqual([
      {
        outcome: "revoked",
        reason: "client",
        sessionId: "ps_1",
        label: "laptop",
        peer: "local-cli",
        certSerial: "0a1b2c3d",
        at: NOW,
      },
    ]);
  });

  it("audit-logs a cancelled session too", () => {
    run(["new", "--label", "laptop"]);
    run(["revoke", field("Session")]);
    expect(audited[0]).toMatchObject({ outcome: "revoked", reason: "pending-session", label: "laptop" });
  });

  it("does not pretend a cancel undoes a redemption", () => {
    const session = createPairingSession({ id: "ps_9", label: "spent", codeHash: "h", now: NOW });
    store().createSession(session, NOW);
    store().consume("ps_9", NOW);
    // A consumed session is not pending, so it is not a revoke target at all —
    // the client it issued is. The message says which.
    expect(run(["revoke", "ps_9"])).toBe(1);
    expect(err.join("\n")).toMatch(/nothing here matches/i);
  });
});

// ─── help ───────────────────────────────────────────────────────────────────

describe("actana pair --help", () => {
  it("lists the three verbs", () => {
    expect(run(["--help"])).toBe(0);
    const text = out.join("\n");
    for (const verb of ["pair new", "pair ls", "pair revoke"]) expect(text).toContain(verb);
  });

  it("says plainly which machine this runs on", () => {
    run(["--help"]);
    const text = out.join("\n");
    expect(text).toMatch(/You are on the Core/);
    // And names the other command, because the trap is that both exist.
    expect(text).toMatch(/actana core pair/);
  });

  it("prints the help and reports usage when no verb was given", () => {
    expect(run([])).toBe(2);
    expect(out.join("\n")).toMatch(/actana pair —/);
  });

  it("rejects an unknown verb", () => {
    expect(run(["frobnicate"])).toBe(2);
    expect(err.join("\n")).toMatch(/unknown verb "frobnicate"/);
  });
});

describe("the relative half of an expiry", () => {
  it("floors and carries a second unit rather than rounding to the largest", () => {
    // Rounding made `--ttl 90m` print "in 2 hours" and `--ttl 90s` print "in 2
    // minutes". The relative half is the half read out down a phone line, and a
    // code described as living longer than it does is one nobody hurries for.
    run(["new", "--ttl", "90m"]);
    expect(field("Expires")).toBe("2026-08-20T13:30:00Z (in 1 hour 30 minutes)");
    run(["new", "--ttl", "90s"]);
    expect(field("Expires")).toBe("2026-08-20T12:01:30Z (in 1 minute 30 seconds)");
  });

  it("drops the second unit when it is zero, so the ordinary cases stay short", () => {
    expect(describeDuration(5 * 60_000)).toBe("5 minutes");
    expect(describeDuration(30_000)).toBe("30 seconds");
    expect(describeDuration(60_000)).toBe("1 minute");
    expect(describeDuration(MAX_PAIRING_TTL_MS)).toBe("24 hours");
  });

  it("never overstates how long a code has left", () => {
    for (const ms of [1_000, 59_000, 61_000, 89_000, 3_599_000, 5_400_000, 86_399_000]) {
      const spoken = describeDuration(ms);
      const hours = Number(/(\d+) hours?/.exec(spoken)?.[1] ?? 0);
      const minutes = Number(/(\d+) minutes?/.exec(spoken)?.[1] ?? 0);
      const seconds = Number(/(\d+) seconds?/.exec(spoken)?.[1] ?? 0);
      expect(hours * 3_600_000 + minutes * 60_000 + seconds * 1_000).toBeLessThanOrEqual(ms);
    }
  });
});

describe("--ttl parsing", () => {
  it("reads a number and a unit", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
  });

  it("refuses everything else", () => {
    for (const bad of ["5", "5 m", "m", "-5m", "5d", "0s", ""]) {
      expect(parseDuration(bad)).toHaveProperty("error");
    }
  });
});

describe("the material this all reads", () => {
  it("is the one on disk, so the CLI and the daemon cannot disagree", () => {
    expect(loadMaterialFromFile(materialPath)?.coreId).toBe(material.coreId);
  });
});
