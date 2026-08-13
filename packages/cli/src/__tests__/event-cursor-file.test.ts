// The cursor file itself (#161).
//
// `events-tail-cursor.test.ts` proves what the cursor buys against a real Core;
// this covers the two things that file cannot see from the outside — that "is
// there a cursor for this Core?" is answered by reading the Core's own file,
// and that a write which fails is swallowed *and said out loud*.
//
// The second one is the review of #205's note. The failure a silent swallow
// produces is not an error anywhere: it is `events tail` starting from the same
// place on every run, forever, which reads as a broken cursor rather than as a
// directory nobody can write to.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { coreLinkCursorStorageKey } from "@actana/sdk/core-link-cursor-storage.ts";
import { FileCursorStorage, storedCursorFor } from "../event-cursor-file.ts";

let root: string | null = null;
function dir(): string {
  root ??= mkdtempSync(path.join(tmpdir(), "actana-cursor-"));
  return root;
}
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

const ENDPOINT = "wss://127.0.0.1:8443";

describe("the event cursor on disk", () => {
  it("has no cursor for a Core it has never followed", () => {
    expect(storedCursorFor(dir(), ENDPOINT)).toBeNull();
  });

  it("reads back what a client wrote, under the key the SDK derives", () => {
    // The key is the SDK's, from the endpoint the blob carries — the same one a
    // client derives from the URL it dials. Deriving it a second way here would
    // be a second opinion about which file a Core's cursor lives in, and the
    // symptom would be a resuming tail behaving like a first run.
    const store = new FileCursorStorage(dir());
    store.setItem(coreLinkCursorStorageKey(ENDPOINT), "42");

    expect(storedCursorFor(dir(), ENDPOINT)).toBe(42);
    // A trailing space or a newline is what the file has; the number is what
    // the caller asked for.
    expect(storedCursorFor(dir(), `${ENDPOINT} `)).toBe(42);
  });

  it("keeps one Core's cursor away from another's", () => {
    const store = new FileCursorStorage(dir());
    store.setItem(coreLinkCursorStorageKey(ENDPOINT), "42");

    expect(storedCursorFor(dir(), "wss://127.0.0.1:9443")).toBeNull();
  });

  it("treats a garbled cursor as no cursor rather than as event 0", () => {
    // "Resume from 0" and "there is nothing to resume from" are different
    // commands: the first replays a Core's whole history, the second starts at
    // the end of the log. A file somebody edited must not become the first.
    const store = new FileCursorStorage(dir());
    store.setItem(coreLinkCursorStorageKey(ENDPOINT), "not a number");

    expect(storedCursorFor(dir(), ENDPOINT)).toBeNull();
  });

  it("reports a write it could not make, instead of only swallowing it", () => {
    // A directory that cannot be created because a file is standing where it
    // should be — the same shape as a read-only config root, and one that does
    // not depend on this process's uid.
    const blocked = path.join(dir(), "in-the-way");
    writeFileSync(blocked, "not a directory\n");

    const said: string[] = [];
    const store = new FileCursorStorage(path.join(blocked, "cursors"), (line) => said.push(line));

    // Still no throw: an unwritable config directory is not a reason to refuse
    // to stream a Core's events.
    expect(() => store.setItem(coreLinkCursorStorageKey(ENDPOINT), "42")).not.toThrow();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("could not write the event cursor");
    // The sentence names the consequence, because that is the part an operator
    // is looking at when they come asking.
    expect(said[0]).toContain("will start where this one did");
  });
});
