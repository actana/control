import { afterEach, describe, expect, it } from "vitest";
import { CoreClient } from "../core-client";
import {
  CORE_LINK_PROTOCOL_VERSION,
  coreLinkProtocolCompatible,
  readFilesCapability,
  serializeCoreLinkFrame,
  type CoreLinkServerFrame,
} from "../core-link-frames";
import { startCoreRig, type CoreRig } from "./fake-core-link";

// The optional `files` capability on `ready` (#165 F9, ADR 0024 D11).
//
// Two properties, and the second is the one the ticket asks for by name: a Core
// announces the capability without moving `CORE_LINK_PROTOCOL_VERSION`, and
// **both mismatch directions behave sanely** — an older Panel against a newer
// Core, and a newer Panel against an older Core. Neither is "needs update", and
// the file surface is not on this socket at all, so neither loses a frame.

let rig: CoreRig | null = null;
let client: CoreClient | null = null;

afterEach(() => {
  client?.close();
  client = null;
  rig?.close();
  rig = null;
});

async function connectTo(opts: { announceFiles?: boolean } = {}): Promise<CoreClient> {
  rig = startCoreRig(opts.announceFiles === undefined ? {} : { announceFiles: opts.announceFiles });
  const dialer = rig.dialer();
  client = new CoreClient({ url: "ws://core.test", createSocket: dialer.createSocket });
  await client.connect();
  return client;
}

describe("readFilesCapability", () => {
  it("reads version 1", () => {
    expect(readFilesCapability({ version: 1 })).toEqual({ version: 1 });
  });

  it("reads an absent capability as null — a Core with no file surface", () => {
    expect(readFilesCapability(undefined)).toBe(null);
    expect(readFilesCapability(null)).toBe(null);
  });

  it("reads a version this build does not know as null rather than guessing it is a superset", () => {
    expect(readFilesCapability({ version: 2 })).toBe(null);
    expect(readFilesCapability({ version: 0 })).toBe(null);
  });

  it("reads a malformed capability as null", () => {
    expect(readFilesCapability({})).toBe(null);
    expect(readFilesCapability({ version: "1" })).toBe(null);
    expect(readFilesCapability("files")).toBe(null);
    expect(readFilesCapability(1)).toBe(null);
  });

  it("cannot mark a Core incompatible — a null answer withholds an affordance, it does not fail a Core", () => {
    expect(coreLinkProtocolCompatible(CORE_LINK_PROTOCOL_VERSION)).toBe(true);
    expect(readFilesCapability(undefined)).toBe(null);
  });
});

describe("the protocol version does not move for it", () => {
  // The reason is in the test name so that whoever reads this failing after
  // bumping the version gets the reason rather than the number. `files` did
  // not move it and does not: it is a ready capability whose absence yields
  // today's behaviour exactly. What moved it to 0.16.0 is the `exec` frame
  // (#266), which is a frame and therefore not that case.
  it("is 0.16.0 for the `exec` frame (#266) and not for `files`, which is a ready capability no Core becomes needs-update for (#165 F9, ADR 0024 D11)", () => {
    expect(CORE_LINK_PROTOCOL_VERSION).toBe("0.16.0");
  });

  it("serializes the ready frame with the capability when a Core announces it", () => {
    const frame: CoreLinkServerFrame = {
      type: "ready",
      version: CORE_LINK_PROTOCOL_VERSION,
      files: { version: 1 },
    };
    expect(JSON.parse(serializeCoreLinkFrame(frame))).toEqual({
      type: "ready",
      version: CORE_LINK_PROTOCOL_VERSION,
      files: { version: 1 },
    });
  });

  it("omits the field entirely rather than sending it null or false", () => {
    const wire = JSON.parse(serializeCoreLinkFrame({ type: "ready", version: CORE_LINK_PROTOCOL_VERSION }));
    expect("files" in wire).toBe(false);
  });
});

describe("a newer client against a Core that announces the capability", () => {
  it("reads it off `ready` and reports it as usable", async () => {
    const connected = await connectTo({ announceFiles: true });
    expect(connected.canUseFileRoutes()).toBe(true);
    expect(connected.filesCapability()).toEqual({ version: 1 });
    expect(connected.connectionInfo().files).toEqual({ version: 1 });
  });

  it("still reports the same protocol version and compatibility", async () => {
    const connected = await connectTo({ announceFiles: true });
    const info = connected.connectionInfo();
    expect(info.protocolVersion).toBe(CORE_LINK_PROTOCOL_VERSION);
    expect(info.compatible).toBe(true);
  });
});

describe("a newer client against an older Core that omits it", () => {
  it("reports the capability as absent rather than treating the Core as stale", async () => {
    const connected = await connectTo();
    expect(connected.canUseFileRoutes()).toBe(false);
    expect(connected.filesCapability()).toBe(null);
    // The Core is fully compatible and fully usable. Absence of a file surface
    // is a fact about that Core, not a version problem.
    expect(connected.connectionInfo().compatible).toBe(true);
  });

  it("drives that Core exactly as it always did — no frame is gated on this", async () => {
    // Unlike `multiConnection`, there is nothing to withhold: the file surface
    // adds no frame to this socket (ADR 0028), so a client that cannot use it
    // loses nothing here.
    const connected = await connectTo();
    const result = await connected.request({ type: "projectsList", reqId: "r1" });
    expect(result).toBeTruthy();
  });
});

describe("an older client against a newer Core that announces it", () => {
  it("connects, is compatible, and is unaffected by a field it never reads", async () => {
    // "An older Panel" is precisely a client that does not know the field
    // exists. Nothing in this test touches `files` — that IS the test.
    const connected = await connectTo({ announceFiles: true });
    const info = connected.connectionInfo();
    expect(info.compatible).toBe(true);
    expect(info.protocolVersion).toBe(CORE_LINK_PROTOCOL_VERSION);

    const result = await connected.request({ type: "projectsList", reqId: "r1" });
    expect(result).toBeTruthy();
  });

  it("is served an unchanged ready frame apart from the one added field", async () => {
    const withFiles = startCoreRig({ announceFiles: true });
    const withoutFiles = startCoreRig();
    try {
      const readFrame = async (r: CoreRig): Promise<Record<string, unknown>> => {
        const dialer = r.dialer();
        const c = new CoreClient({ url: "ws://core.test", createSocket: dialer.createSocket });
        await c.connect();
        const frames = dialer
          .last()
          .server.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)
          .filter((f) => f.type === "ready");
        c.close();
        return frames[0]!;
      };

      const announced = await readFrame(withFiles);
      const silent = await readFrame(withoutFiles);

      expect(announced).toEqual({ ...silent, files: { version: 1 } });
    } finally {
      withFiles.close();
      withoutFiles.close();
    }
  });
});

describe("a Core announcing a version this build has never seen", () => {
  it("is read as no file surface, which is the behaviour that predates the capability", () => {
    // Reached through the reader rather than the rig, because standing up a
    // Core that announces a version this repository does not have is not a
    // thing the Core can be asked to do — and the reader is where the decision
    // is made.
    expect(readFilesCapability({ version: 3 })).toBe(null);
  });
});
