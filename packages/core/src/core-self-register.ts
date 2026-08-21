// A containerised Core registers itself with the CLI on its own machine
// (#288 D9, criterion 3).
//
// On metal `actana setup` does this: it mints the material and writes the
// credential straight into this machine's blob registry, so the `actana` that
// installed the Core is already pointed at it. In a container none of that
// runs — the image *is* the install (ADR 0016 D13) and `setup` and `install` are
// refused there — so a fresh Session inside the container found an empty
// registry: `actana core ls` printed the no-Cores sentence and every `actana
// session …` answered `no Core registered`, on the one machine that is
// unambiguously standing on a Core. The `actana-sessions` skill the daemon
// installs at boot states the opposite rule as a fact, which made the skill
// dishonest on the machine the Core itself put it on — the complaint #288 opens
// with, in a new form.
//
// So the daemon does its own wiring, through the same module `setup` uses
// (`@actana/shared/local-core-wiring`) and into the same directory: the
// container's `AC_CORE_MATERIAL_FILE` already lives in `~/.config/actana`, which
// is where the registry is. Since #287 this is the *only* place a credential
// this Core issued to itself is written down — the `registration-blob.txt` that
// used to sit beside the material file is gone, along with everything that read
// it.
//
// **The endpoint is this machine's, not the Panel's.** `ACTANA_PUBLIC_HOST` is
// the address *other* machines dial, and inside the container it may not route
// at all — it is a LAN address of the host, a public DNS name, or whatever the
// deployment put in front of the port. The CLI doing the dialling here shares a
// network namespace with the daemon, so it is registered on the loopback
// address the daemon is already listening on. Hostname verification survives it:
// `core-cert-material.ts` puts `127.0.0.1` in every server cert's SAN alongside
// the public host, on both the mint and the re-issue path, exactly so that the
// machine's own client can dial it.
//
// **It runs on every boot, not only the one that mints.** A volume created
// before this existed has material but no registry entry, and a Core
// that only wired itself on the boot that minted would never fix itself for the
// life of that volume. Writing is idempotent, and the bearer in the entry is
// re-signed with a full lease each time — which is strictly better than a
// registry row slowly ageing out while the Core it names is up.
//
// A pointer the operator moved is left alone; that is `wireLocalCore`'s rule and
// this module adds nothing to it.

import { signBearer, type BearerSecret } from "@actana/shared/core-link-bearer";
import { registryPaths } from "@actana/shared/blob-registry";
import { wireLocalCore, type LocalCoreWiring } from "@actana/shared/local-core-wiring";
import type { PersistedMaterial } from "@actana/shared/core-material-store";

/** The identity fields the credential is built from — what the boot has in hand. */
export type SelfRegistrationMaterial = Pick<
  PersistedMaterial,
  "caCert" | "clientCert" | "clientKey" | "coreId" | "bearerSecret"
>;

export type SelfRegistrationOptions = {
  material: SelfRegistrationMaterial;
  /** `AC_CORE_LINK_HOST` — what the daemon binds, which decides what it can be dialled on here. */
  bindHost: string;
  /** The core-link port. */
  port: number;
  /** `ACTANA_LABEL`, which the registry name is derived from. */
  label: string;
  /** Bearer lease length in days. */
  bearerDays: number;
  /** The daemon's environment, for `XDG_CONFIG_HOME`. */
  env: NodeJS.ProcessEnv;
  /** The daemon's home directory — the operator's, on metal and in the image. */
  home: string;
};

export type SelfRegistration =
  | { ok: true; wiring: LocalCoreWiring; endpoint: string }
  | { ok: false; error: string };

/**
 * The host this machine's own CLI dials the daemon on.
 *
 * A bind address is not always a dial address: `0.0.0.0` and `::` mean "every
 * interface", which is not something a client can connect to. Both become
 * `127.0.0.1` — including the IPv6 wildcard, because the *certificate* is what
 * decides whether a dial succeeds and `core-cert-material.ts` puts `127.0.0.1`
 * in every SAN and `::1` in none. A dual-stack `::` listener accepts the v4
 * loopback, so this is the address that is both reachable and verifiable.
 *
 * A daemon bound to one specific address is dialled on that address — the only
 * one it answers.
 */
export function localDialHost(bindHost: string): string {
  const host = bindHost.trim();
  if (host === "" || host === "0.0.0.0" || host === "::" || host === "[::]" || host === "::0") {
    return "127.0.0.1";
  }
  return host;
}

/** An IPv6 literal needs brackets before it can be a URL authority. */
function endpointHost(dialHost: string): string {
  return dialHost.includes(":") && !dialHost.startsWith("[") ? `[${dialHost}]` : dialHost;
}

/** `wss://host:port`, as it goes into the credential and into the log line. */
export function localEndpoint(dialHost: string, port: number): string {
  return `wss://${endpointHost(dialHost)}:${port}`;
}

/**
 * Register this Core in its own machine's blob registry, and select it unless
 * the operator has selected something else.
 *
 * Never throws: a registry this daemon cannot write — a read-only mount, a home
 * directory owned by somebody else — is a reason to say so in the log and go on
 * serving Panels, not a reason to fail a boot that is otherwise healthy. The
 * caller reports the error; the Core comes up either way.
 */
export function registerSelfWithLocalCli(opts: SelfRegistrationOptions): SelfRegistration {
  const dialHost = localDialHost(opts.bindHost);
  const endpoint = localEndpoint(dialHost, opts.port);
  try {
    // The bearer is signed here rather than stored, so the entry this boot
    // writes carries a full lease instead of whatever is left of an older one.
    const wiring = wireLocalCore(registryPaths(opts.env, opts.home), opts.label, {
      endpoint,
      label: opts.label,
      caCert: opts.material.caCert,
      clientCert: opts.material.clientCert,
      clientKey: opts.material.clientKey,
      bearer: signBearer(
        {
          coreId: opts.material.coreId,
          exp: Date.now() + opts.bearerDays * 24 * 60 * 60 * 1000,
        },
        opts.material.bearerSecret as BearerSecret,
      ),
    });
    return { ok: true, wiring, endpoint };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
