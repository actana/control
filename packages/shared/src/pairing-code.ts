// The one-time pairing code an operator reads out loud (#280, #281).
//
// `actana pair new` mints one of these on the Core and a human carries it to
// the client — that hand-carry is the only manual step left in enrollment, so
// the code is shaped for a voice call and a keyboard, not for a URL. Hence the
// two decisions below.
//
// **The alphabet drops `0`, `O`, `1`, `I` and `L`.** They are the characters a
// human transcribes wrong, and there is nobody downstream to forgive a typo:
// a wrong character burns one of five attempts on a session that dies at the
// cap. Dropping them costs ~3 bits over the eight characters (31^8 ≈ 2^39.6
// against 36^8 ≈ 2^41.3) and buys a code that survives being spoken.
//
// **The draw rejects biased bytes rather than folding them with `%`.** A
// pairing code is a pre-auth secret guarding CSR signing, so the draw has to
// be uniform over the alphabet: `randomBytes(1)[0] % 31` would make the first
// eight letters ~14% likelier than the rest, which is a measurable head start
// for anyone spraying codes at the endpoint.
//
// This file is self-contained (no `~/` imports) and reaches `node:crypto`
// through an injectable port, the same arrangement as the HMAC port in
// `core-link-bearer.ts`: the Core mints codes, tests assert the draw, and
// neither has to stub a global to do it.
//
// These are internals, not wire types. `packages/shared` is private and stays
// private ([ADR 0025][adr] D4); the SDK declares its own shapes for whatever
// crosses the socket, as `packages/sdk/src/core-registration-blob.ts` argues
// at length.
//
// [adr]: ../../../docs/adr/0025-the-protocol-ships-with-the-client.md

import { randomBytes } from "node:crypto";

/**
 * The code alphabet: A–Z and 2–9, less `0`, `O`, `1`, `I` and `L`. 31
 * characters. Exported because the Core's operator output and the client's
 * input hint both describe it to a human, and two descriptions of one alphabet
 * drift apart.
 */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Characters drawn per code, before grouping. */
export const PAIRING_CODE_LENGTH = 8;

/** Characters per printed group — the code reads as `XXXX-XXXX`. */
export const PAIRING_CODE_GROUP_SIZE = 4;

/**
 * Byte values at or above this are thrown away instead of being folded into
 * the alphabet. 256 is not a multiple of 31, so the top 8 byte values (248–255)
 * have no partner in the last cycle and would over-weight `A`–`H`. Discarding
 * them leaves 248 values covering the 31 characters exactly 8 times each, which
 * is what makes the `%` below unbiased rather than merely convenient.
 */
const UNBIASED_BYTE_CEILING = 256 - (256 % PAIRING_CODE_ALPHABET.length);

/**
 * CSPRNG port. The default draws from `node:crypto.randomBytes`, which is
 * available everywhere this module is imported (the Core mints, the CLI prints,
 * tests assert). Bytes rather than integers on purpose: the rejection above is
 * the property under test, so it lives here in code a test can drive, not
 * behind `randomInt` where a fake would have to be trusted to be uniform.
 */
export interface CsprngPort {
  /** Fill `n` cryptographically random bytes. Never returns fewer than one. */
  bytes(n: number): Uint8Array;
}

const defaultCsprng: CsprngPort = {
  bytes: (n) => randomBytes(n),
};

/** Group a raw 8-character draw for printing: `ABCDEFGH` -> `ABCD-EFGH`. */
export function formatPairingCode(raw: string): string {
  return `${raw.slice(0, PAIRING_CODE_GROUP_SIZE)}-${raw.slice(PAIRING_CODE_GROUP_SIZE)}`;
}

/**
 * Mint a pairing code, formatted `XXXX-XXXX`.
 *
 * Draws in batches sized to what is still missing, so a run with no rejections
 * costs one call to the port and the common case is a single `randomBytes(8)`.
 */
export function generatePairingCode(csprng: CsprngPort = defaultCsprng): string {
  const drawn: string[] = [];
  while (drawn.length < PAIRING_CODE_LENGTH) {
    const batch = csprng.bytes(PAIRING_CODE_LENGTH - drawn.length);
    // A port that yields nothing would spin this loop forever. Fail loudly
    // instead: a starved CSPRNG is a broken one, and a pairing code minted from
    // a broken CSPRNG is worse than no pairing code.
    if (batch.length === 0) throw new Error("CSPRNG port returned no bytes");
    for (const byte of batch) {
      if (byte >= UNBIASED_BYTE_CEILING) continue;
      drawn.push(PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length]);
      if (drawn.length === PAIRING_CODE_LENGTH) break;
    }
  }
  return formatPairingCode(drawn.join(""));
}

/**
 * Canonicalise a code a human typed, or return `null` if it cannot be one.
 *
 * Accepts the hyphen or no hyphen, any case, and stray whitespace from a paste
 * — everything a phone call and a text field produce between the operator's
 * screen and the client's prompt. The canonical form is the printed one
 * (`XXXX-XXXX`, upper case), so `normalisePairingCode(generatePairingCode())`
 * is the code itself and a comparison never has to know which side it came
 * from.
 *
 * Out-of-alphabet characters are rejected rather than folded: the excluded
 * five have no unambiguous partner to fold *to* — `0` and `O` are both absent
 * — so a `0` here is a transcription error, and quietly guessing at which
 * character was meant would spend the caller's attempt on a code they never
 * heard.
 */
export function normalisePairingCode(input: string): string | null {
  const stripped = input.replace(/[\s-]/g, "").toUpperCase();
  if (stripped.length !== PAIRING_CODE_LENGTH) return null;
  for (const ch of stripped) {
    if (!PAIRING_CODE_ALPHABET.includes(ch)) return null;
  }
  return formatPairingCode(stripped);
}
