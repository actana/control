// Core first run — the daemon mints its own identity when the volume is empty
// (ADR 0016 D17).
//
// On metal, `actana setup` mints the material and persists it; the daemon only
// ever loads what setup left behind. In a container the image *is* the install
// (D13) and `actana setup` never runs, so the daemon has to mint and persist
// for itself on first boot:
//
//   material file absent  → mint it, persist it
//   material file present → load it; re-sign only the server cert if
//                           `ACTANA_PUBLIC_HOST` moved (D18)
//
// **Nothing is emitted either way (#287).** The first run used to write a
// `registration-blob.txt` beside the material and print the blob once for an
// operator to copy into a Panel; that hand-carry is gone, and a client enrolls
// by spending a code from `actana pair new` — which works in a container,
// because `pair` is deliberately not on the refusal table (ADR 0016 D13).
//
// The asymmetry above is still the whole identity contract for a containerised
// Core: `docker compose restart` re-enters the second branch and is a no-op for
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
import {
  mintFreshMaterial,
  persistMaterialToFile,
  checkServerCertHost,
  readMaterialFile,
  reissueServerCert,
  type PersistedMaterial,
} from "@actana/shared/core-material-store";

export type LoadOrMintOptions = {
  /** Full path from `AC_CORE_MATERIAL_FILE`. */
  materialFile: string;
  /**
   * The hosts a client reaches this Core on — the server cert's SAN list, in
   * the operator's order, the first of them the primary (#347).
   *
   * A list rather than one host, and a single-entry list is the case that has
   * not changed: `ACTANA_PUBLIC_HOST=core` arrives here as `["core"]`, mints
   * the certificate it always minted and hands back the endpoint it always
   * handed back.
   */
  publicHosts: readonly string[];
  /**
   * Whether `publicHosts` is the operator's answer (`ACTANA_PUBLIC_HOST`) or the
   * bind address standing in for one. Only the operator's answer may re-sign an
   * existing Core's cert: the stand-in is a guess, and a guess that rewrote the
   * SAN would take a working Core off its own address to put it on `127.0.0.1`.
   */
  publicHostDeclared: boolean;
};

export type LoadOrMintResult = {
  /** The identity the daemon serves — freshly minted or loaded from disk. */
  material: PersistedMaterial;
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
 * when it is absent — mint one and persist it.
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
    const read = readMaterialFile(opts.materialFile);
    if (!read) {
      throw new Error(
        `${opts.materialFile} exists but could not be read as Core material. ` +
          "Fix or remove it — removing it re-mints this Core's identity and " +
          "every paired Panel has to re-pair.",
      );
    }
    const existing = read.material;
    // Material written before #282 has no stable core UUID, and the load just
    // minted one. Writing it back here is what makes it stable: unpersisted, a
    // Core would announce a different `aud` on every boot, which is the one
    // thing that identifier exists not to do. Nothing else about the identity
    // changes, so no Panel notices and nothing has to re-pair.
    if (read.mintedCoreUuid) persistMaterialToFile(opts.materialFile, existing);
    const check = checkServerCertHost(existing, opts.publicHosts);
    if (check === "covered" || !opts.publicHostDeclared) {
      return { material: existing, certAction: "unchanged" };
    }

    const reissued = await reissueServerCert(existing, opts.publicHosts);
    persistMaterialToFile(opts.materialFile, reissued);
    if (check === "unrecorded") {
      // Nothing moved as far as anyone knows — the record simply did not exist
      // before D18. Re-signing for the host in hand fills it in; announcing a
      // move here would be a fiction.
      return { material: reissued, certAction: "backfilled" };
    }
    // A paired client is still dialling the address this Core just left, and
    // that address is the one thing re-issuing cannot fix from here — the
    // client holds it. There is nothing to rewrite on disk any more (#287): the
    // caller says the new address in the log, and an operator either re-points
    // their client at it or pairs again.
    return { material: reissued, certAction: "moved" };
  }

  const material = await mintFreshMaterial(opts.publicHosts);
  persistMaterialToFile(opts.materialFile, material);

  return { material, certAction: "unchanged" };
}
