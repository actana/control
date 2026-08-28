// The operator's public host list — one variable, one or more addresses.
//
// `ACTANA_PUBLIC_HOST` used to be one address and is now a comma-separated
// list of them (#347). Every entry becomes a subject alternative name on this
// Core's server certificate, so one Core can be validly reached as `core` on a
// compose network and as a LAN address from a host-machine CLI at the same
// time — which is the case the single-address model could not serve without
// re-pairing every client each time the answer changed.
//
// **A single value is still a list of one, and nothing about it changes.** A
// compose file that sets `ACTANA_PUBLIC_HOST=core` today parses to `["core"]`,
// mints the same certificate it minted before, and hands back the same
// endpoint. That is the compatibility this module exists to keep, and
// `public-hosts.test.ts` asserts it rather than trusting it.
//
// **The first entry is the primary.** It is the common name on the
// certificate, the endpoint a pairing hands back when nothing else was chosen,
// and the address `actana setup` prints. Order is therefore part of the
// operator's answer, not an implementation detail — which is why
// {@link samePublicHosts} compares lists in order, and a reordered list is a
// moved Core rather than the same one.
//
// Pure: a string in, a list or a sentence out. Nothing here reads an
// environment, a disk or a clock.

/** What separates one address from the next inside the one variable. */
export const PUBLIC_HOST_SEPARATOR = ",";

/** A parsed list, or the sentence to print at the operator. */
export type PublicHostsParse =
  | { ok: true; hosts: string[] }
  | { ok: false; error: string };

/**
 * Read `core,10.0.0.5` as `["core", "10.0.0.5"]`, or say what is wrong with it.
 *
 * `varName` is the name of whatever carried the value — `ACTANA_PUBLIC_HOST` on
 * a container, `--public-host` on metal — and it is a parameter rather than a
 * constant because the refusal has to name the thing the operator can go and
 * edit. A message that named the wrong one would send them to the wrong file.
 *
 * Every entry is trimmed, so `core, 10.0.0.5` is the same answer as
 * `core,10.0.0.5`: a list written for a human to read has spaces in it, and
 * refusing that would be refusing the formatting rather than the value.
 *
 * An **empty entry is refused** rather than dropped. `core,,10.0.0.5` is a typo
 * — a doubled separator, or a trailing one left by an editor — and silently
 * reading it as a two-host list would mint a certificate the operator did not
 * ask for while telling them nothing. So is an entry with a space inside it: no
 * address has one, and `core, my host` is a list that was meant to have three
 * entries or one.
 *
 * Repeats collapse, first occurrence winning, because a certificate with the
 * same name in it twice is the same certificate plus a wasted extension — and
 * the primary has to stay the primary whichever position the repeat was in.
 */
export function parsePublicHosts(raw: string, varName: string): PublicHostsParse {
  if (raw.trim().length === 0) {
    return {
      ok: false,
      error:
        `${varName} is empty. It is the address — or the comma-separated list of ` +
        `addresses — a client reaches this Core on, and it needs at least one.`,
    };
  }

  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(PUBLIC_HOST_SEPARATOR)) {
    const host = entry.trim();
    if (host.length === 0) {
      return {
        ok: false,
        error:
          `${varName} has an empty entry (${JSON.stringify(raw)}). It is a ` +
          `comma-separated list of addresses and every entry has to be one — check for ` +
          `a doubled or trailing comma.`,
      };
    }
    if (/\s/.test(host)) {
      return {
        ok: false,
        error:
          `${varName} entry ${JSON.stringify(host)} has whitespace inside it. No address ` +
          `does; separate the addresses with commas — ${varName}=core,10.0.0.5.`,
      };
    }
    if (seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return { ok: true, hosts };
}

/**
 * The primary — the first entry, and what every single-address behaviour still
 * means.
 *
 * `localhost` for an empty list, matching what `generateCertMaterial` has
 * always defaulted a missing host to. An empty list should not reach here, and
 * a caller that lets one through gets a working loopback Core rather than a
 * `wss://undefined:8443` nobody can debug.
 */
export function primaryPublicHost(hosts: readonly string[]): string {
  return hosts[0] ?? "localhost";
}

/**
 * Render a list back as the operator would type it.
 *
 * Used for the value handed to `AC_CORE_PUBLIC_HOST` in a unit file, and for
 * the list a refusal prints. One spelling, so the string a Core is configured
 * with and the string it prints back are the same string.
 */
export function formatPublicHosts(hosts: readonly string[]): string {
  return hosts.join(`${PUBLIC_HOST_SEPARATOR} `).trim();
}

/**
 * Is `candidate` one of the addresses this Core is configured for?
 *
 * The membership test behind `actana pair new --public-host` (#347). Exact,
 * after a trim: a pairing code may only hand back an address the certificate
 * already covers, and "close enough" is not a property a TLS hostname check
 * has.
 */
export function isConfiguredPublicHost(hosts: readonly string[], candidate: string): boolean {
  return hosts.includes(candidate.trim());
}

/**
 * Are these the same configured hosts, in the same order?
 *
 * Order counts because the first entry is the primary, and a Core whose
 * primary changed is a Core whose endpoint changed — which is exactly the
 * "moved" every paired client has to hear about (ADR 0016 D18).
 */
export function samePublicHosts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((host, index) => host === b[index]);
}
