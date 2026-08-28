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
//                           `ACTANA_PUBLIC_HOST` changed (D18)
//
// "Changed" is two different events since #347, and the difference is what the
// operator is told rather than what is signed. A list that **widened** — every
// host already covered, plus one or more new ones — costs nobody anything: no
// paired client is dialling an address this Core has left. A genuine **move**
// does, and only that one earns the "re-address your Panel or pair again" line.
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
  checkMaterialIdentity,
  mintFreshMaterial,
  persistMaterialToFile,
  checkServerCertHost,
  readMaterialFile,
  reissueServerCert,
  type PersistedMaterial,
} from "@actana/shared/core-material-store";
import { widenedPublicHosts } from "@actana/shared/public-hosts";
import log from "@actana/shared/log";

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
   * What this boot did to the server cert.
   *
   * - `unchanged` — nothing was re-signed.
   * - `widened` — every host this Core was already signed for is still
   *   covered, and at least one more joined them (#347). The certificate was
   *   re-signed, and **no client lost anything**: a paired Panel still
   *   validates, still reaches this Core at the address it holds, and needs no
   *   attention at all. Its own action because it is the one #347 exists to
   *   make painless, and because the `moved` advice below is exactly wrong for
   *   it.
   * - `moved` — the operator hears about this one: a host this Core was signed
   *   for is no longer covered, or the primary changed with nothing added, so
   *   some client is dialling an address this certificate has left.
   * - `backfilled` — re-signs material that never recorded which host it was
   *   signed for, which says nothing about whether anything moved and so says
   *   nothing at all.
   */
  certAction: "unchanged" | "widened" | "moved" | "backfilled";
  /**
   * On a `widened` boot, the hosts that joined the list, in the operator's
   * order. Empty for every other action.
   *
   * Returned rather than recomputed by the caller because the previous list is
   * gone by then: {@link loadOrMintMaterial} re-signs and overwrites
   * `serverHosts`, so the only place that can name the difference is the place
   * that still has both sides of it.
   */
  addedHosts: string[];
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
 * Throws when the file exists but cannot be parsed, and when it parses into an
 * identity that could never serve TLS — a leaf the CA beside it did not sign,
 * or a certificate and key that do not agree (#348). The operator decides
 * whether to discard an identity, not the daemon; what the daemon owes them is
 * the reason, at boot, instead of a TLS error at a client three steps away.
 *
 * Material from an older generation of this product is **not** in that
 * category: it works, it is logged, and it boots. `actana setup` is where an
 * operator chooses to replace it.
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
    // Before anything is done with it: material that could never complete a
    // handshake stops the boot here, rather than reaching a client as an
    // unexplainable TLS failure (#348). Material that merely came from an
    // older generation of this product is *kept* and logged — it serves TLS
    // exactly as it always did, and the rename broke the environment around it
    // rather than the identity itself. The check is on the load path only;
    // what this function mints is ours by construction.
    const issue = checkMaterialIdentity(existing);
    if (issue?.severity === "unusable") {
      throw new Error(
        `${opts.materialFile} cannot be used as this Core's identity. ${issue.message}`,
      );
    }
    if (issue) {
      log.warn("core-material.foreign-identity", {
        file: opts.materialFile,
        detail: issue.message,
      });
    }
    // Material written before #282 has no stable core UUID, and the load just
    // minted one. Writing it back here is what makes it stable: unpersisted, a
    // Core would announce a different `aud` on every boot, which is the one
    // thing that identifier exists not to do. Nothing else about the identity
    // changes, so no Panel notices and nothing has to re-pair.
    if (read.mintedCoreUuid) persistMaterialToFile(opts.materialFile, existing);
    const check = checkServerCertHost(existing, opts.publicHosts);
    if (check === "covered" || !opts.publicHostDeclared) {
      return { material: existing, certAction: "unchanged", addedHosts: [] };
    }

    // Taken before the re-issue overwrites it: this is the only moment both the
    // list this Core was signed for and the list it is about to be signed for
    // exist at once, and telling a widening from a move needs both.
    const added = widenedPublicHosts(existing.serverHosts, opts.publicHosts);

    const reissued = await reissueServerCert(existing, opts.publicHosts);
    persistMaterialToFile(opts.materialFile, reissued);
    if (check === "unrecorded") {
      // Nothing moved as far as anyone knows — the record simply did not exist
      // before D18. Re-signing for the host in hand fills it in; announcing a
      // move here would be a fiction.
      return { material: reissued, certAction: "backfilled", addedHosts: [] };
    }
    if (added) {
      // Every address this Core was already signed for is still on the new
      // certificate, and one or more joined them (#347). Nothing is dialling an
      // address this Core has left, so there is nothing for an operator to do —
      // announcing this as a move would tell them to pay the exact cost #347
      // exists to remove.
      return { material: reissued, certAction: "widened", addedHosts: added };
    }
    // A paired client is still dialling the address this Core just left, and
    // that address is the one thing re-issuing cannot fix from here — the
    // client holds it. There is nothing to rewrite on disk any more (#287): the
    // caller says the new address in the log, and an operator either re-points
    // their client at it or pairs again.
    return { material: reissued, certAction: "moved", addedHosts: [] };
  }

  const material = await mintFreshMaterial(opts.publicHosts);
  persistMaterialToFile(opts.materialFile, material);

  return { material, certAction: "unchanged", addedHosts: [] };
}
