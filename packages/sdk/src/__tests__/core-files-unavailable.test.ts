// The F9 gate: against a Core that does not announce `files` on `ready`, the
// file surface is unavailable **with a clear reason** (#167, #165 F9).
//
// Two properties, and the second is the one that makes this a gate rather than
// an error message: nothing is sent. A client that called the route anyway
// would get a `404` off a Core that simply predates the surface, and would then
// have to guess whether it had found a missing Project, a missing file, a
// routing mistake or an old Core. The whole point of announcing the capability
// on `ready` is that the client never has to guess.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { CoreClient } from "../core-client";
import { CoreFilesUnavailableError } from "../core-files-http";
import { cleanupRoots, connectedClient, startFilesRig, type FilesRig } from "./files-rig";
import { startCoreRig, type CoreRig } from "./fake-core-link";

let rig: FilesRig | null = null;
let coreRig: CoreRig | null = null;
let client: CoreClient | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  coreRig?.close();
  coreRig = null;
  await rig?.close();
  rig = null;
});

afterAll(() => cleanupRoots());

/** A Core with a real file surface behind it that never announces one. */
async function silentCore(): Promise<CoreClient> {
  rig = await startFilesRig({ seed: { "a.txt": "a" }, listing: true });
  const connected = await connectedClient(rig, { announceFiles: false });
  client = connected.client;
  coreRig = connected.coreRig;
  return connected.client;
}

describe("a Core that does not announce `files`", () => {
  it("refuses all three calls, and sends nothing", async () => {
    const core = await silentCore();
    const project = core.project(rig!.projectId);

    // The routes are genuinely there and would answer — the rig is the same one
    // every other suite uses. That is what makes this test about the *gate*: a
    // client reading the capability stops, and one that ignored it would sail
    // through and succeed here, which is the bug F9 exists to prevent from
    // being written in the first place.
    await expect(project.files.download({ path: "a.txt" })).rejects.toThrow(
      CoreFilesUnavailableError,
    );
    await expect(project.files.list().next()).rejects.toThrow(CoreFilesUnavailableError);
    await expect(
      project.files.upload({ path: "b.txt", body: chunk("b") }).next(),
    ).rejects.toThrow(CoreFilesUnavailableError);

    expect(rig!.requests).toEqual([]);
  });

  it("gives a reason an operator can act on, naming the capability", async () => {
    const core = await silentCore();

    const error = await project(core).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CoreFilesUnavailableError);
    const { reason, message } = error as CoreFilesUnavailableError;
    // Not "unavailable", not "404", not "an error occurred". The three things an
    // operator needs are: which operation, that the capability is what is
    // missing, and that this is not something they broke.
    expect(message).toContain("reading a Project's files is unavailable on this Core");
    expect(reason).toContain("`files` capability");
    expect(reason).toContain("`ready`");
    expect(reason).toMatch(/not a broken or out-of-date one/);
    expect(reason).toContain("#165 F9");
  });

  it("says something different — and also true — before the client has connected", async () => {
    rig = await startFilesRig();
    coreRig = startCoreRig({ announceFiles: true });
    // Never connected. The Core here *does* announce the capability, so a gate
    // that conflated "no" with "not yet" would report the wrong reason and send
    // an operator looking for an old Core that is not the problem.
    client = new CoreClient({
      url: `ws://${rig.host}:${rig.port}`,
      createSocket: coreRig.dialer().createSocket,
    });

    const error = (await client
      .project(rig.projectId)
      .files.download({ path: "a.txt" })
      .catch((err: unknown) => err)) as CoreFilesUnavailableError;

    expect(error).toBeInstanceOf(CoreFilesUnavailableError);
    expect(error.reason).toContain("not connected");
    expect(error.reason).toContain("await connect()");
    expect(error.reason).not.toContain("`files` capability");
    expect(rig.requests).toEqual([]);
  });

  it("is not a needs-update: the link itself is fully usable", async () => {
    const core = await silentCore();

    // The capability's absence withholds no frame, because the file surface
    // adds none — it is a second protocol on the same server (ADR 0028). A Core
    // without it is connected, compatible and ordinary.
    expect(core.isConnected()).toBe(true);
    expect(core.connectionInfo().compatible).toBe(true);
    expect(core.canUseFileRoutes()).toBe(false);
    expect(core.filesCapability()).toBe(null);
  });
});

function project(core: CoreClient): Promise<unknown> {
  return core.project(rig!.projectId).files.download({ path: "a.txt" });
}

function chunk(content: string): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield new TextEncoder().encode(content);
  })();
}
