// Where the daemon keeps the Shared folder's S3 key (#562, ADR 0041 D33).
//
// The controller pushes a 1-hour key limited to this Core's prefix (`sharedAttach`,
// `sharedCredentials`). The daemon, which is `actana` in the container, writes it into
// its own state directory (`/var/lib/actana`, 0700, ADR 0041 D24) and nowhere else, so
// `core` cannot read it. There is no long-lived key on the Core: a key lives an hour
// and the next push replaces the file.
//
// The file is the whole attachment: where the bucket is and the key. It is replaced
// atomically (a temp file made 0600 from the start, then `rename`), so a reader is
// never handed half of one, and a push that lands while an upload is in flight leaves
// that upload's already-signed request alone.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** The file's name inside the state directory. */
export const SHARED_KEY_FILE = "shared-key.json";

/** What the controller attached the Core to, and the key it may use there. */
export type SharedAttachment = {
  /** S3 gateway base URL, path style. */
  endpoint: string;
  bucket: string;
  /** The Core's prefix, without a leading or trailing slash. */
  prefix: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** Epoch milliseconds: when the key stops working. */
  expiresAt: number;
};

export function sharedKeyPath(stateDir: string): string {
  return path.join(stateDir, SHARED_KEY_FILE);
}

/** A string field that is present, text, and carries no control character. */
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/.test(value);
}

/** A prefix the Core may sync under: relative, no empty, `.` or `..` segment, no backslash. */
export function normalizePrefix(raw: string): string | null {
  const trimmed = raw.replace(/^\/+|\/+$/g, "");
  if (trimmed.length === 0 || trimmed.includes("\\")) return null;
  if (trimmed.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  return trimmed;
}

/** The attachment as stored, or null when it is not one. Nothing is repaired. */
export function parseAttachment(raw: unknown): SharedAttachment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!text(r.endpoint) || !text(r.bucket) || !text(r.prefix) || !text(r.region)) return null;
  if (!text(r.accessKeyId) || !text(r.secretAccessKey) || !text(r.sessionToken)) return null;
  if (typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt)) return null;
  const prefix = normalizePrefix(r.prefix);
  if (!prefix) return null;
  try {
    const url = new URL(r.endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return {
    endpoint: r.endpoint,
    bucket: r.bucket,
    prefix,
    region: r.region,
    accessKeyId: r.accessKeyId,
    secretAccessKey: r.secretAccessKey,
    sessionToken: r.sessionToken,
    expiresAt: r.expiresAt,
  };
}

export type SharedKeyStore = {
  readonly path: string;
  /** The attachment on disk, or null when there is none or it is not readable. */
  load(): SharedAttachment | null;
  /** Replace the file, atomically, mode 0600. */
  save(attachment: SharedAttachment): void;
  /** Remove it. Nothing is left behind when there was none. */
  clear(): void;
};

export function createSharedKeyStore(stateDir: string): SharedKeyStore {
  const file = sharedKeyPath(stateDir);
  return {
    path: file,
    load() {
      try {
        return parseAttachment(JSON.parse(fs.readFileSync(file, "utf8")));
      } catch {
        return null;
      }
    },
    save(attachment) {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const temp = path.join(stateDir, `.${SHARED_KEY_FILE}.${crypto.randomBytes(6).toString("hex")}`);
      // `wx` and 0600 at creation: there is no moment at which the bytes are in a file
      // anyone else could open.
      const fd = fs.openSync(temp, "wx", 0o600);
      try {
        fs.writeSync(fd, `${JSON.stringify(attachment)}\n`);
        fs.fsyncSync(fd);
      } catch (err) {
        fs.closeSync(fd);
        fs.rmSync(temp, { force: true });
        throw err;
      }
      fs.closeSync(fd);
      try {
        fs.renameSync(temp, file);
      } catch (err) {
        fs.rmSync(temp, { force: true });
        throw err;
      }
    },
    clear() {
      fs.rmSync(file, { force: true });
    },
  };
}
