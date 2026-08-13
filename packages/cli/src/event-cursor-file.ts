// Where the CLI keeps its event cursor.
//
// The SDK declares the two-method store it needs and imports nothing that
// satisfies it (`core-link-cursor-storage.ts`, issue 153's trap): a browser
// hands it `localStorage`, a test hands it a Map, and **a CLI hands it this** —
// one small file per Core under the same config root the blob registry uses.
//
// The difference it makes is the difference between the two defaults. An
// in-memory cursor recovers everything missed while the process was *running*,
// which covers every reconnect; it starts from scratch after a restart. A CLI
// is a program that is restarted constantly — it is a command, not a daemon —
// so for `events tail` the in-memory floor would mean every invocation begins
// with no idea what it has already shown.
//
// The file holds one integer and is written on every event, synchronously.
// Synchronously because the guarantee being bought is that the cursor on disk is
// never behind the line already printed: if it were, a `tail` killed at the
// wrong moment would reprint events on the next run, which is the duplicate this
// whole mechanism exists to prevent.

import * as fs from "node:fs";
import * as path from "node:path";
import { coreLinkCursorStorageKey } from "@actana/sdk/core-link-cursor-storage.ts";
import type { CoreLinkCursorStorage } from "@actana/sdk/core-link-cursor-storage.ts";
import type { RegistryPaths } from "./blob-registry.ts";

/** The directory holding one cursor file per Core, beside the blob registry. */
export function cursorsDir(paths: RegistryPaths): string {
  return path.join(paths.root, "cursors");
}

/**
 * A file-backed cursor store.
 *
 * The SDK derives the key from the Core's URL, and that key is already
 * constrained to `[A-Za-z0-9._-]` — the same alphabet that makes it safe as a
 * `localStorage` key makes it safe as a file name, which is why
 * `coreLinkCursorStorageKey` says so in as many words. Nothing here re-derives
 * or re-sanitizes it; a second sanitizer would be a second opinion about which
 * file a Core's cursor lives in.
 *
 * Every failure is swallowed. A cursor that cannot be read is a `tail` that
 * replays more than it needed to, and a cursor that cannot be written is a
 * `tail` that will do it again next time — both are worse than working and much
 * better than a command that refuses to stream a Core's events because a
 * directory was read-only.
 */
export class FileCursorStorage implements CoreLinkCursorStorage {
  private readonly dir: string;
  private readonly onWriteFailed: (message: string) => void;

  /**
   * @param onWriteFailed Told about a swallowed write failure, once per
   * failure. `events tail` passes `deps.verbose`, which turns "this tail
   * repeats itself every run" from a mystery into a line an operator can read
   * — see {@link setItem}.
   */
  constructor(dir: string, onWriteFailed: (message: string) => void = () => {}) {
    this.dir = dir;
    this.onWriteFailed = onWriteFailed;
  }

  getItem(key: string): string | null {
    try {
      const raw = fs.readFileSync(this.file(key), "utf8").trim();
      return raw === "" ? null : raw;
    } catch {
      return null;
    }
  }

  setItem(key: string, value: string): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file(key), `${value}\n`, "utf8");
    } catch (err) {
      // Still swallowed, for the reason in the class comment: a read-only
      // config directory is not a reason to refuse to stream a Core's events.
      // But it is reported, because the symptom it produces — every run of
      // `events tail` starting where the last one started — looks like a bug in
      // the cursor rather than a failure to write it.
      this.onWriteFailed(
        `could not write the event cursor to ${this.file(key)} (${err instanceof Error ? err.message : String(err)}); ` +
          "the next run of this command will start where this one did",
      );
    }
  }

  private file(key: string): string {
    return path.join(this.dir, `${key}.txt`);
  }
}

/**
 * The cursor already on disk for one Core, or null when there is none.
 *
 * A separate read rather than something observed on the way past, because the
 * question is asked *before* a client exists: "no cursor" and "cursor at 0" are
 * the same number to the SDK and they are different commands — a first
 * `events tail` on a machine starts at the end of the log, the way `tail -f`
 * does, and a second one carries on from where the first stopped. A durable
 * client begins writing this same file as soon as its link comes up, so the
 * only moment the answer is still true is before it dials.
 *
 * The key comes from the SDK's own {@link coreLinkCursorStorageKey}, given the
 * endpoint the blob carries — which is exactly what a client derives it from
 * (`coreConnectionFromBlob` trims the endpoint and hands it over as the URL).
 * Deriving it a second way here would be a second opinion about which file a
 * Core's cursor lives in.
 */
export function storedCursorFor(dir: string, endpoint: string): number | null {
  const raw = new FileCursorStorage(dir).getItem(coreLinkCursorStorageKey(endpoint.trim()));
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * A cursor pinned to one value, which no write moves — what `--since` uses.
 *
 * An explicit `--since` is an ad-hoc read of the log, not a resumption of the
 * follow-along stream, so it deliberately leaves the persisted cursor alone: a
 * plain `actana events tail` afterwards carries on from where the last plain one
 * finished, rather than from wherever a one-off rewind happened to end.
 *
 * Reads answer the same value for every key because the caller does not know
 * the key — the SDK derives it from the Core's URL after this store is already
 * built — and one CLI run follows exactly one Core, so there is no second key
 * for this to answer wrongly.
 */
export function pinnedCursorStorage(value: number): CoreLinkCursorStorage {
  return {
    getItem: () => String(value),
    setItem: () => {},
  };
}
