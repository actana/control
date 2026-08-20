// Core first run — the daemon mints its own identity when the volume is empty
// (ADR 0016 D17).
//
// On metal, `actana setup` mints the material, persists it and prints the
// pairing blob; the daemon only ever loads what setup left behind. In a
// container the image *is* the install (D13) and `actana setup` never runs, so
// the daemon has to do all three itself on first boot:
//
//   material file absent  → mint, persist, write `registration-blob.txt`
//                           beside it, hand the blob back to be printed once
//   material file present → load it, print nothing; re-sign only the server
//                           cert if `ACTANA_PUBLIC_HOST` moved (D18)
//
// That asymmetry is the whole pairing contract for a containerised Core:
// `docker compose restart` re-enters the second branch and is a no-op for
// pairing; `docker compose down -v` drops the volume and is the only thing
// that unpairs. Pre-seeding material through env or a mounted secret is
// deliberately not an option — it would need a generator that runs outside a
// Core and would put private keys in compose files.
//
// A material file that exists but cannot be read is an error, never a re-mint.
// The two cases are not symmetric: an absent file means the identity is
// already gone — that file *is* the CA and the bearer secret, so no paired
// Panel can dial this Core whatever the daemon does next, and minting is
// strictly better than crash-looping. A corrupt file may still hold salvageable
// bytes, and re-minting over it would throw away a recoverable pairing to
// paper over a bad write. The mint is therefore not gated on container mode:
// on metal the unit sets `AC_CORE_MATERIAL_FILE` too, and a metal daemon whose
// material was deleted has the same nothing-to-load problem and the same
// recovery.
//
// Core process only — never imported by the browser.

import * as fs from "node:fs";
import * as path from "node:path";
import { signBearer, type BearerSecret } from "@actana/shared/core-link-bearer";
import { encodeRegistrationBlob } from "@actana/shared/registration-blob";
import {
  loadMaterialFromFile,
  mintFreshMaterial,
  persistMaterialToFile,
  checkServerCertHost,
  reissueServerCert,
  type PersistedMaterial,
} from "@actana/shared/core-material-store";

/** The blob file written beside the material file on first run. */
export const REGISTRATION_BLOB_FILENAME = "registration-blob.txt";

/**
 * Where the blob lands for a given material file — beside it, so one volume
 * carries both and `docker compose exec core cat …` finds it for the life of
 * that volume.
 */
export function registrationBlobPath(materialFile: string): string {
  return path.join(path.dirname(materialFile), REGISTRATION_BLOB_FILENAME);
}

/** Everything a blob needs that is not part of the identity itself. */
export type BlobAddressing = {
  /** The host a Panel reaches this Core on — the cert SAN and the endpoint. */
  publicHost: string;
  /** The core-link port, for the endpoint in the blob. */
  port: number;
  /** Human-friendly alias carried in the blob (`ACTANA_LABEL`). */
  label: string;
  /** Bearer lease length in days. */
  bearerDays: number;
};

/**
 * Build the pairing blob for an identity: the Panel's half of the mTLS pair,
 * the CA to pin, where to dial, and a freshly signed bearer.
 *
 * The bearer is signed here rather than stored, so every blob this Core hands
 * out carries a full lease instead of whatever is left of an older one.
 */
export function buildRegistrationBlob(
  material: Pick<
    PersistedMaterial,
    "caCert" | "clientCert" | "clientKey" | "coreId" | "bearerSecret"
  >,
  addressing: BlobAddressing,
): string {
  return encodeRegistrationBlob({
    endpoint: `wss://${addressing.publicHost}:${addressing.port}`,
    label: addressing.label,
    caCert: material.caCert,
    clientCert: material.clientCert,
    clientKey: material.clientKey,
    bearer: signBearer(
      {
        coreId: material.coreId,
        exp: Date.now() + addressing.bearerDays * 24 * 60 * 60 * 1000,
      },
      material.bearerSecret as BearerSecret,
    ),
  });
}

export type LoadOrMintOptions = BlobAddressing & {
  /** Full path from `AC_CORE_MATERIAL_FILE`. */
  materialFile: string;
  /**
   * Whether `publicHost` is the operator's answer (`ACTANA_PUBLIC_HOST`) or the
   * bind address standing in for one. Only the operator's answer may re-sign an
   * existing Core's cert: the stand-in is a guess, and a guess that rewrote the
   * SAN would take a working Core off its own address to put it on `127.0.0.1`.
   */
  publicHostDeclared: boolean;
};

export type LoadOrMintResult = {
  /** The identity the daemon serves — freshly minted or loaded from disk. */
  material: PersistedMaterial;
  /** The pairing blob, to print once. `null` on every boot after the first. */
  blob: string | null;
  /**
   * What this boot did to the server cert. `moved` is the one the operator
   * hears about: `ACTANA_PUBLIC_HOST` changed under a paired Core. `backfilled`
   * re-signs material that never recorded which host it was signed for, which
   * says nothing about whether anything moved and so says nothing at all.
   */
  certAction: "unchanged" | "moved" | "backfilled";
};

/**
 * Resolve the identity this daemon boots with: load the material file, or —
 * when it is absent — mint one, persist it and write the blob beside it.
 *
 * Named for both paths because it runs on every boot, and after the first one
 * the load is all that happens.
 *
 * The one thing a load may change is the server cert, and only when the
 * operator declared the public host: `ACTANA_PUBLIC_HOST` is an env var, so it
 * moves far more easily in a container than on metal, and the cert's SAN has to
 * follow it or the Panel's next dial fails hostname verification. Re-signing it
 * from the CA already in the volume keeps the CA, the bearer secret, the
 * `coreId` and the Panel's client cert exactly as they were — a typo'd env var
 * costs a certificate, not the pairing (ADR 0016 D18).
 *
 * Throws when the file exists but cannot be parsed — the operator decides
 * whether to discard a corrupt identity, not the daemon.
 */
export async function loadOrMintMaterial(opts: LoadOrMintOptions): Promise<LoadOrMintResult> {
  if (fs.existsSync(opts.materialFile)) {
    const existing = loadMaterialFromFile(opts.materialFile);
    if (!existing) {
      throw new Error(
        `${opts.materialFile} exists but could not be read as Core material. ` +
          "Fix or remove it — removing it re-mints this Core's identity and " +
          "every paired Panel has to re-pair.",
      );
    }
    const check = checkServerCertHost(existing, opts.publicHost);
    if (check === "covered" || !opts.publicHostDeclared) {
      return { material: existing, blob: null, certAction: "unchanged" };
    }

    const reissued = await reissueServerCert(existing, opts.publicHost);
    persistMaterialToFile(opts.materialFile, reissued);
    if (check === "unrecorded") {
      // Nothing moved as far as anyone knows — the record simply did not exist
      // before D18. Re-signing for the host in hand fills it in; announcing a
      // move here, or handing out a new token for one, would be a fiction.
      return { material: reissued, blob: null, certAction: "backfilled" };
    }
    // The blob on disk still points a Panel at the address this Core just left,
    // and that address is the one thing re-issuing cannot fix from here — the
    // Panel holds it. Rewriting the file means the documented `cat` hands the
    // operator a token for where the Core actually is.
    writeBlobFile(opts.materialFile, buildRegistrationBlob(reissued, opts));
    return { material: reissued, blob: null, certAction: "moved" };
  }

  const material = await mintFreshMaterial(opts.publicHost);
  persistMaterialToFile(opts.materialFile, material);

  const blob = buildRegistrationBlob(material, opts);
  writeBlobFile(opts.materialFile, blob);

  return { material, blob, certAction: "unchanged" };
}

/**
 * Write the blob beside the material file. It holds the blob and nothing else:
 * the documented way to get it is `cat`, and its output has to be pasteable
 * without editing.
 */
function writeBlobFile(materialFile: string, blob: string): void {
  fs.writeFileSync(registrationBlobPath(materialFile), `${blob}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * The first-run blob as a human reads it out of `docker compose logs`.
 *
 * The `@@AC_CORE_REGISTRATION_BLOB@@` sentinel exists for a supervising parent
 * that captures the line; a container has no such parent, and prefixing the
 * one thing the operator must copy makes it something they have to edit first.
 * The blob keeps a line to itself so a triple-click gets exactly it.
 */
export function formatRegistrationBlobNotice(blob: string, blobFile: string): string {
  return [
    "",
    'Your pairing token — paste this into your Panel\'s "Add Core":',
    "",
    blob,
    "",
    `Saved to ${blobFile}. It stays valid for the life of this volume.`,
    "",
  ].join("\n");
}
