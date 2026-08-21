import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePanelDataDir } from "../panel-data-dir";

/**
 * Encryption for the secrets the Panel holds at rest — today the CA, client
 * cert/key, and bearer that came out of a pairing with a Core.
 *
 * The threat this answers is the one from the spec: "a casual copy of my
 * database doesn't leak fleet credentials." A `panel.db` lifted off a backup,
 * a snapshot, or a mounted volume is inert without the key, and the key is a
 * separate file (or an environment variable, so it need not live next to the
 * data at all — ADR 0011).
 *
 * It is NOT a defence against someone who already has the data directory *and*
 * the key file, which is the same trust boundary the Panel process itself sits
 * on. There is no passphrase to prompt for: the service must be able to dial
 * every registered Core after an unattended restart.
 */

/** AES-256-GCM: authenticated, so a tampered blob fails to open rather than decrypting to garbage. */
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Envelope version marker, so a future key rotation or cipher change is legible at rest. */
const MAGIC = Buffer.from("AC1", "utf8");

export const SECRETS_KEY_FILENAME = "secrets.key";

/** Cache key: the inputs that decide the key, so repointing either re-resolves. */
let cached: { key: Buffer; from: string } | null = null;

function cacheKey(dataDir: string, envKey: string | undefined): string {
  return `${envKey ? "env" : "file"}:${envKey ?? dataDir}`;
}

/**
 * Decode `AC_SECRETS_KEY`. Hex and base64 are both accepted because both are
 * what a secrets manager hands you; anything that isn't 32 bytes is a
 * misconfiguration the operator has to see, not something to paper over with a
 * derived key — silently accepting a short key would mean the Panel encrypts
 * with less entropy than it claims.
 */
function decodeEnvKey(raw: string): Buffer {
  const candidates = [/^[0-9a-fA-F]+$/.test(raw) ? Buffer.from(raw, "hex") : null, Buffer.from(raw, "base64")];
  for (const candidate of candidates) {
    if (candidate && candidate.length === KEY_BYTES) return candidate;
  }
  throw new Error(
    `AC_SECRETS_KEY must be a ${KEY_BYTES}-byte key in hex or base64 (got ${raw.length} characters)`,
  );
}

/**
 * Read the key file, creating it on first boot. Written with `wx` so two
 * processes racing a cold data directory can't end up with one of them
 * encrypting under a key the other just overwrote.
 */
function readOrCreateKeyFile(dataDir: string): Buffer {
  const keyPath = path.join(dataDir, SECRETS_KEY_FILENAME);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const key = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64");
      if (key.length !== KEY_BYTES) {
        throw new Error(
          `${keyPath} is not a ${KEY_BYTES}-byte key. Restore it from backup — the Cores' secrets cannot be read without it.`,
        );
      }
      return key;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(keyPath, randomBytes(KEY_BYTES).toString("base64"), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (err) {
      // EEXIST: someone else won the race — the next read picks up their key.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`could not establish a secrets key at ${keyPath}`);
}

function secretsKey(): Buffer {
  const dataDir = resolvePanelDataDir();
  const envKey = process.env.AC_SECRETS_KEY?.trim() || undefined;
  const from = cacheKey(dataDir, envKey);
  if (cached && cached.from === from) return cached.key;
  const key = envKey ? decodeEnvKey(envKey) : readOrCreateKeyFile(dataDir);
  cached = { key, from };
  return key;
}

/** Encrypt a secret for storage. Throws only on a misconfigured key. */
export function sealSecret(plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, secretsKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

/**
 * Decrypt a stored secret, or null when it can't be read — a wrong key, a
 * truncated or tampered blob, an envelope from some other scheme. Callers
 * treat null as "this Core's secrets are gone" and surface it rather than
 * dialing with nothing.
 */
export function openSecret(sealed: Buffer): string | null {
  const header = MAGIC.length + IV_BYTES + TAG_BYTES;
  if (sealed.length < header || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = sealed.subarray(MAGIC.length + IV_BYTES, header);
  try {
    const decipher = createDecipheriv(ALGORITHM, secretsKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed.subarray(header)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** @internal — tests repoint the data directory / env key between cases. */
export function resetSecretsKeyForTests(): void {
  cached = null;
}
