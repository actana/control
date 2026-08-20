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
import {
  loadMaterialFromFile,
  materialFilePath,
  mintFreshMaterial,
  persistMaterialToFile,
  type PersistedMaterial,
} from "@actana/shared/core-material-store";
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
import { runPairCommand, parseDuration, MAX_PAIRING_TTL_MS } from "../actana-pair.ts";
import type { ActanaCliDeps } from "../cli-deps.ts";
import { stubClientHalf, stubMachineHalf } from "./machine-fixture.ts";

const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);

let dir: string;
let materialPath: string;
let material: PersistedMaterial;
let out: string[];
let err: string[];
let audited: Record<string, unknown>[];

/** One run of `actana pair <argv>`, with its two streams captured. */
function run(argv: string[], now = NOW): number {
  out = [];
  err = [];
  const deps: ActanaCliDeps = {
    ...stubClientHalf(() => now),
    ...stubMachineHalf(),
    argv: ["pair", ...argv],
    env: {},
    home: dir,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  };
  return runPairCommand(deps, argv, {
    materialPath: () => materialPath,
    audit: (record) => audited.push(record),
  });
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

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "actana-pair-"));
  materialPath = materialFilePath(dir);
  material = await mintFreshMaterial("10.0.0.5");
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
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // The five characters a human transcribes wrong are not in it (#280/#281).
    expect(code.replace("-", "").split("").every((ch) => PAIRING_CODE_ALPHABET.includes(ch))).toBe(true);
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
    store().recordClient(paired({ label: "desktop", certSubject: "CN=desktop" }));

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

  it("keeps a revoked client visible, and says it is revoked", () => {
    store().recordClient(paired());
    store().revokeClient("0a1b2c3d", NOW);
    run(["ls"]);
    expect(out.join("\n")).toMatch(/revoked 2026-08-20T12:00:00Z/);
  });
});

// ─── pair revoke ────────────────────────────────────────────────────────────

describe("actana pair revoke", () => {
  it("marks a paired client revoked, by label", () => {
    store().recordClient(paired());
    expect(run(["revoke", "laptop"])).toBe(0);
    expect(store().listClients()[0]!.revokedAt).toBe(NOW);
    expect(out.join("\n")).toMatch(/Unpaired laptop/);
  });

  it("takes a certificate serial, including a prefix of one", () => {
    store().recordClient(paired({ certSerial: "0a1b2c3d4e5f", label: "" }));
    expect(run(["revoke", "0a1b2c"])).toBe(0);
    expect(store().listClients()[0]!.revokedAt).toBe(NOW);
  });

  it("stops the credential working — which is what the daemon reads", () => {
    // This command's whole output on the wire is this row. The daemon's
    // enforcement is tested where it lives; what is pinned here is that the
    // fact it enforces on is written, and written against the serial that
    // identifies the issuance rather than the label.
    store().recordClient(paired({ certSerial: "0a1b2c3d" }));
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
    store().recordClient(paired({ label: "laptop", certSerial: "aaaa" }));
    store().recordClient(paired({ label: "laptop", certSerial: "bbbb" }));
    expect(run(["revoke", "laptop"])).toBe(1);
    expect(err.join("\n")).toMatch(/matches 2 of them/);
    expect(store().listClients().every((c) => c.revokedAt === null)).toBe(true);
  });

  it("says so when nothing matches, and revokes nothing", () => {
    store().recordClient(paired());
    expect(run(["revoke", "nobody"])).toBe(1);
    expect(err.join("\n")).toMatch(/nothing here matches/i);
    expect(store().listClients()[0]!.revokedAt).toBe(null);
  });

  it("needs a target", () => {
    expect(run(["revoke"])).toBe(2);
    expect(err.join("\n")).toMatch(/a target is required/);
  });

  it("audit-logs the revocation through the same auditor the endpoint uses", () => {
    store().recordClient(paired());
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
