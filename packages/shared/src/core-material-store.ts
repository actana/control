// Core material store — persists cert material + bearer secret to disk so
// the daemon can reload the same CA + certs across reboots (ADR 0003
// "Auto-start").
//
// Without persistence the daemon would generate fresh certs on each start,
// invalidating the Panel's pinned client cert. The material file lives at
// `{configDir}/material.json` and contains the full CertMaterial (CA + server
// + client certs/keys) plus the bearer HMAC secret and coreId. Re-running
// `core install` overwrites the file (reissue); the SQLite DB lives in a
// separate user-data dir and is never touched by this store.
//
// Core process only — never imported by the browser.

import * as fs from "node:fs";
import * as path from "node:path";
import { createPrivateKey, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { generateCertMaterial, issueServerCert } from "./core-cert-material";
import { samePublicHosts } from "./public-hosts";
import log from "@actana/shared/log";

/**
 * The persisted Core material — everything the daemon needs to restart
 * with the same identity (same CA, same certs, same bearer secret + coreId).
 * Written by `core install`; read by `core-entry.ts` on daemon boot when
 * `AC_CORE_MATERIAL_FILE` is set.
 */
export type PersistedMaterial = {
  /** PEM-encoded self-signed CA cert. */
  caCert: string;
  /** PEM-encoded CA private key. */
  caKey: string;
  /** PEM-encoded server cert presented in the mTLS handshake. */
  serverCert: string;
  /** PEM-encoded server private key. */
  serverKey: string;
  /** PEM-encoded Panel client cert. */
  clientCert: string;
  /** PEM-encoded Panel client private key. */
  clientKey: string;
  /** HMAC secret for the bearer ({@link BearerSecret}). */
  bearerSecret: string;
  /** The coreId embedded in the bearer. */
  coreId: string;
  /**
   * This Core's **stable identifier**, minted once and never replaced (#280).
   *
   * Not a second `coreId`, and the difference is the whole point of the field.
   * `coreId` is `core_<hex>` and belongs to a *set of material*: regenerating a
   * leaked token mints fresh material and a fresh `coreId` with it. This UUID
   * belongs to the *Core*, so it survives a {@link reissueServerCert} and is
   * the identifier a bearer's `aud` can name and a Panel can pin without being
   * invalidated by an operator re-issuing a certificate.
   *
   * Minted at install by {@link mintFreshMaterial} and, for material written
   * before this field existed, minted on load by {@link loadMaterialFromFile} —
   * so an already-installed Core picks one up on its next boot with no
   * re-install and nothing pinned going stale. See
   * {@link readMaterialFile} for who writes that first one back to disk.
   */
  coreUuid: string;
  /**
   * The public hosts `serverCert`'s SAN list was signed for, in the operator's
   * order. This is what makes a moved Core detectable without parsing the
   * certificate back out of the PEM (ADR 0016 D18), and since #347 it is also
   * the list `actana pair new --public-host` may choose from — a pairing code
   * can never hand back an address that is not in here, because that is
   * precisely the set the certificate covers.
   *
   * Empty for material written before any of this was recorded — treated as
   * "unknown", which re-issues the server cert once and records it.
   *
   * A list rather than the single `serverHost` this was until #347. Material
   * written by an earlier build carries that field instead and
   * {@link readMaterialFile} reads it as a list of one, so an installed Core
   * upgrades without re-issuing anything. The reverse — a newer file read by an
   * older build — is a downgrade, and it lands on the same "unknown host" path
   * that build already had: one silent re-issue for its single host.
   */
  serverHosts: string[];
};

/** The filename inside the config dir. */
export const MATERIAL_FILENAME = "material.json";

/** The full path to the material file for a given config dir. */
export function materialFilePath(configDir: string): string {
  return path.join(configDir, MATERIAL_FILENAME);
}

/** Best-effort chmod to owner-only. No-op on non-POSIX filesystems. */
function restrictPermissions(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort */
  }
}

/**
 * Mint a brand-new Core identity: a fresh CA, fresh certs, a fresh bearer
 * secret and a fresh coreId, all valid for every host in `publicHosts`.
 *
 * Everything a paired Panel pinned is replaced, so whoever calls this is
 * choosing to lock that Panel out until it re-pairs. Setup calls it only when
 * there is nothing to reuse; `actana token regenerate` calls it deliberately,
 * which is how a compromised Core is rotated; the daemon's first run in a
 * container calls it when the volume is empty (ADR 0016 D17).
 */
export async function mintFreshMaterial(publicHosts: readonly string[]): Promise<PersistedMaterial> {
  const generated = await generateCertMaterial({ hosts: publicHosts });
  return {
    caCert: generated.ca.cert,
    caKey: generated.ca.key,
    serverCert: generated.server.cert,
    serverKey: generated.server.key,
    clientCert: generated.client.cert,
    clientKey: generated.client.key,
    bearerSecret: randomBytes(32).toString("hex"),
    coreId: `core_${randomBytes(8).toString("hex")}`,
    coreUuid: randomUUID(),
    serverHosts: [...publicHosts],
  };
}

/**
 * What `material`'s server cert says about `hosts`:
 *
 * - `covered` — it was signed for exactly these hosts, in this order; a client
 *   dialling any of them gets past TLS hostname verification.
 * - `moved` — it was signed for a different list, and some client would not.
 * - `unrecorded` — the material predates the record and nothing on disk says
 *   either way.
 *
 * **In order**, because the first entry is the primary: it is the certificate's
 * common name and the endpoint a pairing hands back by default, so a list that
 * was reordered is a Core whose clients are being sent somewhere else. Treating
 * that as `covered` would leave the recorded primary disagreeing with the
 * configured one for the life of the install.
 *
 * `fallbackHosts` is what the caller knows independently, for material that
 * predates the record: `actana setup` wrote the hosts into the config beside
 * the material, which is as good as the record would have been. A daemon
 * booting in a container has no such config, which is why `unrecorded` stays a
 * third answer rather than collapsing into `moved` — re-signing is safe, but
 * telling an operator their Core moved when it did not is not.
 */
export function checkServerCertHost(
  material: PersistedMaterial,
  hosts: readonly string[],
  fallbackHosts?: readonly string[],
): "covered" | "moved" | "unrecorded" {
  const signedFor = material.serverHosts.length > 0 ? material.serverHosts : (fallbackHosts ?? []);
  if (signedFor.length === 0) return "unrecorded";
  return samePublicHosts(signedFor, hosts) ? "covered" : "moved";
}

/**
 * Sign a fresh server cert for `publicHosts` against the material's own CA,
 * keeping everything else byte-for-byte.
 *
 * This is what a changed public host does now (ADR 0016 D18). The CA key, the
 * bearer secret, the `coreId`, the `coreUuid` and the Panel's client cert all
 * survive the spread below, so a Panel paired before the move still validates
 * this Core against the CA it pinned — where the re-mint this replaced locked
 * that Panel out for what is usually a typo'd env var. Revoking a leaked
 * identity stays the deliberate act it was: {@link mintFreshMaterial} via
 * `actana token regenerate`.
 *
 * The `coreUuid` is called out because it is the one field with a *claim* on
 * it: it is what an issued bearer's `aud` names (#280), and an audience that
 * changed whenever a certificate was re-signed would be no more stable than the
 * certificate. `core-material-store.test.ts` asserts it across this call.
 */
export async function reissueServerCert(
  material: PersistedMaterial,
  publicHosts: readonly string[],
): Promise<PersistedMaterial> {
  const server = await issueServerCert({
    ca: { cert: material.caCert, key: material.caKey },
    hosts: publicHosts,
  });
  return {
    ...material,
    serverCert: server.cert,
    serverKey: server.key,
    serverHosts: [...publicHosts],
  };
}

/**
 * Persist material to `{configDir}/material.json` as JSON. Creates `configDir`
 * if it does not exist. Overwrites any existing material (reissue). The file is
 * chmod'd to 0o600 because it contains private keys.
 */
export function persistMaterial(configDir: string, material: PersistedMaterial): void {
  persistMaterialToFile(materialFilePath(configDir), material);
}

/**
 * Persist material to an explicit path, creating the directory it names. The
 * counterpart of {@link loadMaterialFromFile}, and what the container Core
 * writes through — both the CLI and the daemon's first-run path: its material
 * lives wherever `AC_CORE_MATERIAL_FILE` points inside the mounted volume, and
 * there is no config dir to derive it from because in a container there is no
 * `actana setup` to have made one (ADR 0016 D13).
 */
export function persistMaterialToFile(filePath: string, material: PersistedMaterial): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(material, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  restrictPermissions(filePath);
}

/**
 * Load material from `{configDir}/material.json`. Returns `null` for a missing
 * file, corrupt JSON, or a payload missing required fields / wrong-typed
 * fields — the caller treats null as "generate fresh material" (first boot).
 */
/**
 * Load material from `{configDir}/material.json`. Returns `null` for a missing
 * file, corrupt JSON, or a payload missing required fields / wrong-typed
 * fields — the caller treats null as "generate fresh material" (first boot).
 */
export function loadMaterial(configDir: string): PersistedMaterial | null {
  return loadMaterialFromFile(materialFilePath(configDir));
}

/**
 * Load material from an explicit file path. Returns `null` for a missing file,
 * corrupt JSON, or a payload missing required fields / wrong-typed fields.
 * Used by `core-entry.ts` which receives the full path via
 * `AC_CORE_MATERIAL_FILE`.
 *
 * A file with no `coreUuid` — every file written before #282 — loads with a
 * freshly minted one. See {@link readMaterialFile} when you need to know that
 * happened, which is the only way the new UUID reaches the disk.
 */
export function loadMaterialFromFile(filePath: string): PersistedMaterial | null {
  return readMaterialFile(filePath)?.material ?? null;
}

/** What {@link readMaterialFile} found, and what it had to invent. */
export type MaterialFileRead = {
  material: PersistedMaterial;
  /**
   * True when the file carried no `coreUuid` and this read minted one.
   *
   * The caller has to persist the material when this is set, and the caller
   * rather than this function because reading is not writing: `actana core ls`
   * reads material it has no business rewriting, while the daemon's boot path
   * (`core-first-run.ts`) is the one place that owns the file. An unpersisted
   * mint is not a correctness failure — nothing reads `aud` in this train — but
   * it would hand every boot a different audience, so the one caller that can
   * write does.
   */
  mintedCoreUuid: boolean;
};

/**
 * Load material and say whether the stable UUID had to be minted (#282).
 *
 * The primitive {@link loadMaterialFromFile} delegates to. Split out rather
 * than folded into it so that every existing reader keeps its signature and
 * only the boot path has to care about writing the mint back.
 */
export function readMaterialFile(filePath: string): MaterialFileRead | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("core-material.load: corrupt JSON", { filePath });
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (
    typeof o.caCert !== "string" ||
    typeof o.caKey !== "string" ||
    typeof o.serverCert !== "string" ||
    typeof o.serverKey !== "string" ||
    typeof o.clientCert !== "string" ||
    typeof o.clientKey !== "string" ||
    typeof o.bearerSecret !== "string" ||
    typeof o.coreId !== "string"
  ) {
    log.warn("core-material.load: missing or wrong-typed fields", { filePath });
    return null;
  }
  // Absent in material written before #282, and minted here rather than
  // refused: the identity on disk is intact, the UUID is an addition to it, and
  // an install that predates the field must not have to be redone to gain one.
  // Empty string is treated as absent for the same reason `serverHosts` is —
  // a field that is there but says nothing is not a value.
  const storedUuid = typeof o.coreUuid === "string" ? o.coreUuid : "";
  const mintedCoreUuid = storedUuid === "";
  return {
    material: {
      caCert: o.caCert,
      caKey: o.caKey,
      serverCert: o.serverCert,
      serverKey: o.serverKey,
      clientCert: o.clientCert,
      clientKey: o.clientKey,
      bearerSecret: o.bearerSecret,
      coreId: o.coreId,
      coreUuid: mintedCoreUuid ? randomUUID() : storedUuid,
      // Absent in material written before D18. Not a validation failure — the
      // identity is intact and only the SAN's provenance is unknown, so it loads
      // as "unknown host" and {@link checkServerCertHost} takes it from there.
      serverHosts: readServerHosts(o),
    },
    mintedCoreUuid,
  };
}

/** The common name on every CA this product has minted since the rename. */
export const CORE_CA_COMMON_NAME = "mission-control-core-ca";

/** The common name the Harness-era installer minted, and the tell for #348. */
export const LEGACY_CA_COMMON_NAME = "mission-control-harness-ca";

/** The common name in an X.509 subject / issuer string, or `""`. */
function commonNameOf(distinguishedName: string): string {
  return /^CN=(.*)$/m.exec(distinguishedName)?.[1]?.trim() ?? "";
}

/** What to tell the operator to do about material this Core cannot use. */
const REMEDY =
  "Run `actana setup` to mint this Core's identity again — every paired client re-pairs " +
  "with a fresh `actana pair new` code.";

/**
 * Whether this material is an identity this Core can actually serve (#348).
 *
 * {@link readMaterialFile} type-checks eight strings, which is the difference
 * between a file and JSON — not between *this* Core's identity and one from
 * two renames ago. Pre-rename material has the same eight fields, the same
 * filename and the same shape; the only thing that distinguishes it is the CA
 * it chains to, and nothing looked. So it loaded, the daemon presented it, and
 * the operator's first news of the problem was `wrong version number` from a
 * client — a message about a wire protocol, for a problem about an identity.
 *
 * Three questions, in the order that produces the most useful answer: is the
 * CA one of ours, did it issue this server certificate, and does that
 * certificate go with the key beside it. Each returns a sentence naming what
 * is wrong and what to run; null means the material is usable.
 *
 * A *check*, not a validation of the whole file: the client certificate and
 * the bearer secret are deliberately not examined here. The server pair is
 * what the TLS handshake fails on, and a check that grew to cover everything
 * would start refusing material over fields no handshake reads.
 */
export function checkMaterialIdentity(material: PersistedMaterial): string | null {
  let ca: X509Certificate;
  try {
    ca = new X509Certificate(material.caCert);
  } catch {
    return `\`caCert\` is not a certificate this Core can parse. ${REMEDY}`;
  }

  const issuer = commonNameOf(ca.subject);
  if (issuer !== CORE_CA_COMMON_NAME) {
    // The pre-rename CA gets its own sentence: an operator who sees it needs
    // to know the file is *old*, not corrupt, and that a stale auto-start
    // service is very likely still pointing at it (#348).
    const provenance =
      issuer === LEGACY_CA_COMMON_NAME
        ? `is \`${LEGACY_CA_COMMON_NAME}\`, the CA an install from before the Harness → Core ` +
          "rename minted. This file is that install's identity, and the service that pointed " +
          "at it is from before the rename too."
        : `is \`${issuer || "(no common name)"}\`, which no version of this product has minted.`;
    return (
      `The CA in this material ${provenance} A Core cannot serve an identity it did not ` +
      `issue: the certificate would chain to nothing any client pins. ${REMEDY}`
    );
  }

  let server: X509Certificate;
  try {
    server = new X509Certificate(material.serverCert);
  } catch {
    return `\`serverCert\` is not a certificate this Core can parse. ${REMEDY}`;
  }
  // `verify` and deliberately not `checkIssued`: the latter compares names, and
  // every CA this product mints carries the *same* name — so two Cores' files
  // shuffled together would pass it while chaining to different keys. The
  // signature is the only part of a certificate that cannot be coincidence.
  let issuedByThisCa: boolean;
  try {
    issuedByThisCa = server.verify(ca.publicKey);
  } catch {
    issuedByThisCa = false;
  }
  if (!issuedByThisCa) {
    return (
      "The server certificate in this material was not issued by the CA beside it, so no " +
      `client that pins the CA can validate it. ${REMEDY}`
    );
  }

  try {
    if (!server.checkPrivateKey(createPrivateKey(material.serverKey))) {
      return (
        "The server certificate and `serverKey` in this material are not a pair. TLS would " +
        `fail at the handshake with nothing said about why. ${REMEDY}`
      );
    }
  } catch {
    return `\`serverKey\` is not a private key this Core can parse. ${REMEDY}`;
  }

  return null;
}

/**
 * The recorded SAN hosts, from either spelling this file has written.
 *
 * `serverHosts` is the list (#347). `serverHost` is the single string it
 * replaced, and material written by any build before #347 carries that one —
 * read here as a list of one so an installed Core keeps its certificate across
 * the upgrade instead of re-issuing it on the next boot. Neither present, or
 * both empty, is `[]`: the "unknown host" {@link checkServerCertHost} answers
 * `unrecorded` for.
 *
 * Anything that is not a string is dropped rather than refused. This is a
 * provenance record, not the identity — a mangled entry costs one re-issue from
 * the CA already on disk, where refusing the file would cost the CA itself.
 */
function readServerHosts(o: Record<string, unknown>): string[] {
  if (Array.isArray(o.serverHosts)) {
    return o.serverHosts
      .filter((host): host is string => typeof host === "string")
      .map((host) => host.trim())
      .filter((host) => host.length > 0);
  }
  const legacy = typeof o.serverHost === "string" ? o.serverHost.trim() : "";
  return legacy.length > 0 ? [legacy] : [];
}
