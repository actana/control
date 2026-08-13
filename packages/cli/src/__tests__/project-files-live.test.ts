// `project cp` and `project files`, against the **Core's own file routes** on a
// real socket over a real disk (#168).
//
// Every other suite for these verbs replaces the gateway, which is the right
// trade for a table, an exit code or a flag. It is the wrong one for the two
// claims that are about a *format* rather than about this program:
//
//   - the archive this CLI packs is one the Core's unpacker accepts, and the
//     executable bit survives the trip onto the Core's disk
//   - the archive the Core packs is one this CLI unpacks, and the bit survives
//     coming back
//
// A tar that only round-trips through its own codec proves neither, and the
// failure mode is the worst kind: green here, and a corrupt-archive refusal the
// first time somebody copies a folder to a real Core.
//
// So the whole path is real except one link. `createCoreFilesRequestHandler` is
// the Core's actual handler, mounted the way `core-files-wiring.ts` mounts it;
// the SDK's `CoreFiles` is the real client; `undici` really dials loopback. Only
// the core link is stubbed, because the single thing this CLI uses it for on
// this path is turning the name `api` into a Project id, and standing a whole
// PTY server up to answer one frame would not make the tar any more real.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createCoreFilesRequestHandler } from "@actana/core/core-files-routes";
import { CoreFiles } from "@actana/sdk/core-files.ts";
import { createCoreFilesFetch } from "@actana/sdk/core-files-http.ts";
import { makeCliFixture, sentinelBlobText, type CliFixture } from "./cli-harness.ts";
import { bindProjectFiles, type OpenProjectFilesFn } from "../project-files-gateway.ts";
import { EXIT_FAILURE, EXIT_OK } from "../exit-codes.ts";

let fixture: CliFixture | null = null;
function cli(): CliFixture {
  fixture ??= makeCliFixture();
  return fixture;
}

const temporary: string[] = [];
const servers: http.Server[] = [];

function scratch(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "actana-live-")));
  temporary.push(dir);
  return dir;
}

afterEach(async () => {
  fixture?.cleanup();
  fixture = null;
  while (servers.length > 0) {
    const server = servers.pop()!;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (temporary.length > 0) fs.rmSync(temporary.pop()!, { recursive: true, force: true });
});

const PROJECT = { projectId: "proj_live", name: "api", path: "" };

/** The Core's file surface on loopback, and a `deps.openFiles` pointed at it. */
async function startCore(): Promise<{ root: string; open: OpenProjectFilesFn }> {
  const root = scratch();
  const routes = createCoreFilesRequestHandler({
    filesPort: { projectRoot: (id) => (id === PROJECT.projectId ? root : null) },
  });
  const server = http.createServer((req, res) => {
    if (routes.handle(req, res)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "not-found", error: "no route" }));
  });
  server.on("checkContinue", (req, res) => {
    if (routes.handleContinue(req, res)) return;
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the Core did not bind a port");

  const files = new CoreFiles({
    projectId: PROJECT.projectId,
    baseUrl: `http://127.0.0.1:${address.port}`,
    bearer: null,
    // A loopback Core authenticates neither its link nor its routes, which is
    // the trade `core-files-wiring.ts` states out loud.
    availability: () => ({ available: true }),
    fetch: createCoreFilesFetch(null),
  });

  return {
    root,
    open: async () => ({
      project: async () => bindProjectFiles(files, { ...PROJECT, path: root }),
      close: () => {},
    }),
  };
}

async function withRegisteredCore(): Promise<void> {
  expect((await cli().run(["core", "add", "prod"], { stdin: sentinelBlobText() })).code).toBe(EXIT_OK);
}

/** A folder with an executable in it, which is the point of the ticket. */
function buildTree(root: string): string {
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "readme.md"), "hello\n");
  fs.writeFileSync(path.join(root, "bin", "deploy"), "#!/bin/sh\necho hi\n");
  fs.chmodSync(path.join(root, "bin", "deploy"), 0o755);
  return root;
}

describe("a folder copies both ways through a real Core, and keeps its executable bits", () => {
  it("lands on the Core's disk with the modes it left with", async () => {
    await withRegisteredCore();
    const core = await startCore();
    const source = buildTree(scratch());

    const run = await cli().run(["project", "cp", source, "api:build"], { files: core.open });

    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    // On the Core's disk, written by the Core's own unpacker out of the archive
    // this CLI packed. This is the assertion the faked suites cannot make.
    expect(fs.readFileSync(path.join(core.root, "build", "readme.md"), "utf8")).toBe("hello\n");
    expect(fs.statSync(path.join(core.root, "build", "bin", "deploy")).mode & 0o777).toBe(0o755);
  });

  it("comes back with them, out of the archive the Core packed", async () => {
    await withRegisteredCore();
    const core = await startCore();
    buildTree(path.join(core.root, "build"));
    const dest = path.join(scratch(), "pulled");

    const run = await cli().run(["project", "cp", "api:build", dest], { files: core.open });

    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    expect(fs.readFileSync(path.join(dest, "readme.md"), "utf8")).toBe("hello\n");
    expect(fs.statSync(path.join(dest, "bin", "deploy")).mode & 0o777).toBe(0o755);
  });

  it("round-trips a single file with its mode", async () => {
    await withRegisteredCore();
    const core = await startCore();
    const source = scratch();
    fs.writeFileSync(path.join(source, "run.sh"), "#!/bin/sh\n");
    fs.chmodSync(path.join(source, "run.sh"), 0o755);

    expect(
      (await cli().run(["project", "cp", path.join(source, "run.sh"), "api:bin/run.sh"], {
        files: core.open,
      })).code,
    ).toBe(EXIT_OK);
    expect(fs.statSync(path.join(core.root, "bin", "run.sh")).mode & 0o777).toBe(0o755);

    const back = path.join(scratch(), "run.sh");
    expect((await cli().run(["project", "cp", "api:bin/run.sh", back], { files: core.open })).code).toBe(
      EXIT_OK,
    );
    expect(fs.readFileSync(back, "utf8")).toBe("#!/bin/sh\n");
    expect(fs.statSync(back).mode & 0o777).toBe(0o755);
  });
});

describe("the Core names the overwrites, and the CLI prints what it named", () => {
  it("reports a second copy over the first as overwrites, by path", async () => {
    await withRegisteredCore();
    const core = await startCore();
    const source = buildTree(scratch());

    expect((await cli().run(["project", "cp", source, "api:build"], { files: core.open })).code).toBe(
      EXIT_OK,
    );
    const second = await cli().run(["project", "cp", source, "api:build", "--json"], {
      files: core.open,
    });

    expect(second.code).toBe(EXIT_OK);
    const payload = JSON.parse(second.out.join("\n"));
    // The Core decided these, entry by entry, and they arrived on its NDJSON
    // progress stream. Nothing here guessed — and the paths are the Core's
    // own, which is to say **Project-relative** rather than relative to the
    // archive: `build/readme.md` is what an operator would type back into
    // `project files`, and it is what the Core reports.
    expect(payload.overwritten).toContain("build/readme.md");
    expect(payload.overwritten).toContain("build/bin/deploy");
    expect(payload.written).toBe(payload.entries - payload.overwritten.length);
  });
});

describe("project files reads the Core's real listing route", () => {
  it("lists the tree with modes, and --json is one array", async () => {
    await withRegisteredCore();
    const core = await startCore();
    buildTree(core.root);

    const run = await cli().run(["project", "files", "api", "--json"], { files: core.open });

    expect(run.code, run.err.join("\n")).toBe(EXIT_OK);
    const payload = JSON.parse(run.out.join("\n")) as Array<{
      path: string;
      kind: string;
      mode: number;
      sha256: string | null;
    }>;
    const deploy = payload.find((row) => row.path === "bin/deploy");
    expect(deploy).toBeDefined();
    expect(deploy!.mode & 0o777).toBe(0o755);
    expect(payload.find((row) => row.path === "bin")?.kind).toBe("directory");
    // Off unless asked for: a listing has no bytes in hand (ADR 0027 D6).
    expect(payload.every((row) => row.sha256 === null)).toBe(true);
  });

  it("asks the Core for digests when --sha256 is typed, and gets them", async () => {
    await withRegisteredCore();
    const core = await startCore();
    fs.writeFileSync(path.join(core.root, "a.txt"), "hello\n");

    const run = await cli().run(["project", "files", "api", "--sha256", "--json"], {
      files: core.open,
    });

    const [row] = JSON.parse(run.out.join("\n")) as Array<{ sha256: string | null }>;
    // sha256 of "hello\n".
    expect(row!.sha256).toBe("5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03");
  });

  it("descends only as far as --depth says", async () => {
    await withRegisteredCore();
    const core = await startCore();
    buildTree(core.root);

    const run = await cli().run(["project", "files", "api", "--depth", "1", "--json"], {
      files: core.open,
    });

    const paths = (JSON.parse(run.out.join("\n")) as Array<{ path: string }>).map((row) => row.path);
    expect(paths).toContain("bin");
    expect(paths).not.toContain("bin/deploy");
  });
});

describe("the Core answers for its own disk, and the CLI does not pre-empt it", () => {
  it("passes a `..` path through and reports the Core's refusal", async () => {
    await withRegisteredCore();
    const core = await startCore();
    const source = buildTree(scratch());

    const run = await cli().run(["project", "cp", source, "api:../escape"], { files: core.open });

    expect(run.code).toBe(EXIT_FAILURE);
    // The Core's code and the Core's words — this side had no opinion, which is
    // what F3 and F11 ask of it.
    expect(run.err.join("\n")).toContain("dot-dot-segment");
    expect(fs.existsSync(path.join(path.dirname(core.root), "escape"))).toBe(false);
  });

  it("reports a path that is not there rather than inventing an empty listing", async () => {
    await withRegisteredCore();
    const core = await startCore();

    const run = await cli().run(["project", "files", "api:nope"], { files: core.open });

    expect(run.code).toBe(EXIT_FAILURE);
    expect(run.err.join("\n")).toContain("actana project files:");
  });
});
