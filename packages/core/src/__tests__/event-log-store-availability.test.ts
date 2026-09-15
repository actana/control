// Can this Core read its own event log, and does it say so? (#495 gate review,
// addendum blocker 7.)
//
// `event-log-store.ts` degrades rather than throws, which is right: a Core whose
// DB the server process has not bootstrapped yet should keep running and drop
// its best-effort lifecycle rows, not die. What it must not do is make that
// state *look* like an ordinary empty log — because `getLastEventId` is
// published on the wire as `tipEventId`, a client's prompt-delivery latch takes
// it as the floor a verdict row has to clear, and `0` is a perfectly good floor.
// A client that armed on it waited for a row the same dead store would never let
// `appendEvent` write, and `--await-prompt` refuses `--wait-timeout`, so the
// wait had no bound at all.
//
// So this suite is about one distinction and only that one: `0` is "the log is
// open and empty", `null` is "there is no log to ask".

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bootstrapCoreDb } from "../core-db-bootstrap";
import {
  appendEvent,
  configureEventLogStore,
  disposeEventLogStore,
  getLastEventId,
} from "../event-log-store";

let userDataDir: string;

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-event-log-availability-"));
});

afterEach(() => {
  disposeEventLogStore();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe("what the event-log store says about itself", () => {
  it("answers 0 for an open log with nothing in it", () => {
    bootstrapCoreDb(userDataDir);
    configureEventLogStore(userDataDir);

    // The distinction's other side, and it has to be asserted or the fix reads
    // as "return null when unsure": an empty log is a working log.
    expect(getLastEventId()).toBe(0);
  });

  it("answers null when there is no log to ask, rather than 0", () => {
    // The DB the server process owns has not been created. `ensureConnection`
    // finds no file, logs `event-log.db-missing`, and returns null — the same
    // state a broken native binding or an unconfigured store leaves behind.
    configureEventLogStore(path.join(userDataDir, "never-bootstrapped"));

    expect(getLastEventId()).toBeNull();
  });

  it("still records nothing on that store, which is why 0 was a trap", () => {
    // The two halves together are the hang. `appendEvent` returning 0 is the
    // Core saying "not recorded"; the old `getLastEventId` returning 0 was the
    // Core saying "ask me again after row 0". A client believed the second and
    // waited for a row the first had already declined to write.
    configureEventLogStore(path.join(userDataDir, "never-bootstrapped"));

    expect(appendEvent("session:promptDelivered", "{}")).toBe(0);
    expect(getLastEventId()).toBeNull();
  });

  it("answers null before it has been configured at all", () => {
    // `disposeEventLogStore` in `afterEach` leaves the module in this state for
    // the next suite; a Core that never called `configureEventLogStore` is in it
    // from boot.
    disposeEventLogStore();
    expect(getLastEventId()).toBeNull();
  });
});
