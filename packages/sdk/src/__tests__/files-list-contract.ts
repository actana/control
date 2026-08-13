// The listing contract, driven across the seam: `project.files.list()` from
// `@actana/sdk` against the Core's own `createCoreFilesRequestHandler`, in one
// process, over a real socket (#218).
//
// ## Why this file exists at all
//
// The SDK and the Core each shipped a listing URL — `?list=1` on the read route
// and `…/files/list` — each documented the choice at length, and neither knew
// the other had picked the opposite. Both suites were green the whole time, and
// that is the part worth fixing rather than the URL. The SDK's suite mounted a
// stand-in that answered the SDK's own URL by construction; the Core's suite
// called its own route by hand. Each side proved itself against its own idea of
// the other, so **nothing either side could write would have gone red.**
//
// A test that only exercises one half cannot catch that class of drift, no
// matter how thorough it is. This one dials the real client method and lets the
// real handler answer, so the URL is agreed on by two modules rather than
// asserted twice against a constant.
//
// ## Why it is a function rather than a suite
//
// It has to fail on **both** sides' CI, which in this repository means both
// packages' suites: `pnpm --filter @actana/core test` and
// `pnpm --filter @actana/sdk test` (the root `pnpm test` runs both). A test
// living in one package is a test the other package's author does not run
// before pushing — and either author can break this contract. So the body lives
// here once and two one-line `.test.ts` files register it, one in each package:
//
//   packages/sdk/src/__tests__/core-files-list-contract.test.ts
//   packages/core/src/__tests__/core-files-list-contract.test.ts
//
// Delete either registration and half the seam stops being watched, which is
// the state this ticket found the repository in.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { CoreFilesRequestError } from "../core-files-http";
import type { CoreClient } from "../core-client";
import type { CoreFileEntry } from "../core-files";
import { cleanupRoots, connectedClient, startFilesRig, type FilesRig } from "./files-rig";

/** Register the contract in the calling package's suite. */
export function describeFilesListContract(): void {
  let rig: FilesRig | null = null;
  let client: CoreClient | null = null;
  let closeCoreRig: (() => void) | null = null;

  afterEach(async () => {
    client?.close();
    client = null;
    closeCoreRig?.();
    closeCoreRig = null;
    await rig?.close();
    rig = null;
  });

  afterAll(() => cleanupRoots());

  /** A connected client over a real Core file surface holding `seed`. */
  async function open(seed: Record<string, string>): Promise<CoreClient> {
    rig = await startFilesRig({ seed });
    const connected = await connectedClient(rig);
    client = connected.client;
    closeCoreRig = () => connected.coreRig.close();
    return connected.client;
  }

  async function listing(
    core: CoreClient,
    opts: Parameters<ReturnType<CoreClient["project"]>["files"]["list"]>[0] = {},
  ): Promise<CoreFileEntry[]> {
    const entries: CoreFileEntry[] = [];
    for await (const entry of core.project(rig!.projectId).files.list(opts)) entries.push(entry);
    return entries;
  }

  describe("the listing contract, SDK to Core, in process", () => {
    it("round-trips a tree: what the client asks for is what the Core lists", async () => {
      const core = await open({ "a.txt": "aaa", "src/b.txt": "bb", "src/deep/c.txt": "c" });

      const entries = await listing(core);

      // Sorted before comparison: the walk hands entries back in the
      // filesystem's order on purpose, because sorting a directory means
      // holding all of it.
      expect(entries.map((entry) => entry.path).sort()).toEqual([
        "a.txt",
        "src",
        "src/b.txt",
        "src/deep",
        "src/deep/c.txt",
      ]);
      expect(entries.find((entry) => entry.path === "src")).toMatchObject({ kind: "directory" });
      expect(entries.find((entry) => entry.path === "a.txt")).toMatchObject({
        kind: "file",
        size: 3,
      });

      // The old failure had no exception in it, which is why it survived
      // review: `?list=1` was a valid *read* of the Project root, so the Core
      // streamed a tar and this reader fed it to the NDJSON line parser. Naming
      // the field the tar could never have carried is what makes this
      // assertion about the URL rather than about the parser.
      for (const entry of entries) {
        expect(typeof entry.mtime).toBe("number");
        expect(entry.sha256).toBeNull();
      }
    });

    it("dials a URL the Core dispatches to its listing handler, not to its read handler", async () => {
      const core = await open({ "src/b.txt": "bb" });
      await listing(core, { path: "src" });

      // The URL the client actually put on the wire — not one this test wrote
      // out again, which would only prove the constant equals itself. Replaying
      // it asks the Core the question that matters: *given this URL, which
      // handler answers?*
      const [request] = rig!.requests;
      expect(request).toBeDefined();
      const replay = await fetch(`${rig!.baseUrl}${request!.url}`, { method: "HEAD" });

      expect(replay.status).toBe(200);
      expect(replay.headers.get("x-actana-transfer-kind")).toBe("listing");
      expect(replay.headers.get("content-type")).toBe("application/x-ndjson");
    });

    it("keeps listing a folder and downloading a folder on separate URLs", async () => {
      // The Core's stated reason for a path segment: the two requests answer
      // with entirely different things, and a query parameter a proxy or a
      // hand-edited URL can drop would silently turn the cheap one into the
      // expensive one. That is only true while the two URLs actually differ, so
      // it is pinned here rather than left to the comment that argues for it.
      const core = await open({ "src/b.txt": "bb" });
      const project = core.project(rig!.projectId);

      const entries = await listing(core, { path: "src" });
      const download = await project.files.download({ path: "src" });
      await download.stream.cancel();

      expect(entries.map((entry) => entry.path)).toEqual(["src/b.txt"]);
      expect(download.kind).toBe("tar");

      const [listRequest, readRequest] = rig!.requests;
      expect(listRequest!.url).not.toBe(readRequest!.url);
      expect(new URL(listRequest!.url, rig!.baseUrl).pathname).not.toBe(
        new URL(readRequest!.url, rig!.baseUrl).pathname,
      );
    });

    it("carries `depth` across as the Core reads it", async () => {
      const core = await open({ "a.txt": "a", "src/b.txt": "b", "src/deep/c.txt": "c" });

      const entries = await listing(core, { path: "src", depth: 1 });

      // Both sides have to agree that `1` means the immediate children, not
      // "one level below them" — an off-by-one no single-sided suite can see.
      expect(entries.map((entry) => entry.path).sort()).toEqual(["src/b.txt", "src/deep"]);
    });

    it("carries `sha256` across, and leaves it null when nobody asked", async () => {
      const core = await open({ "a.txt": "aaa" });

      const asked = await listing(core, { sha256: true });
      expect(asked[0]!.sha256).toBe(createHash("sha256").update("aaa").digest("hex"));

      const unasked = await listing(core);
      // Not a digest the client skipped reading — a digest the Core never
      // computed, which is the whole of why the parameter exists (ADR 0027 D6).
      expect(unasked[0]!.sha256).toBeNull();
    });

    it("refuses a path that is not there, rather than yielding an empty tree", async () => {
      const core = await open({ "a.txt": "a" });

      const failure = await core
        .project(rig!.projectId)
        .files.list({ path: "nope" })
        .next()
        .then(() => null, (err: unknown) => err);

      // An empty listing and a missing directory are different answers, and a
      // caller diffing against the first would read it as "everything here was
      // deleted".
      expect(failure).toBeInstanceOf(CoreFilesRequestError);
      expect(failure).toMatchObject({ status: 404, code: "not-found" });
    });
  });
}
