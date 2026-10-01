// Nothing on the Files API leaves `~` (issue 557): `..`, an absolute path and a symlink
// inside the home that points out, on every operation, and in both places the operations run
// (in the daemon, and in the helper as `core`). Each case is refused with the status and code
// the client branches on, and the tree outside the home is byte-for-byte what it was.
//
// The home is its own folder so that `..` really does name something: its sibling, `outside`,
// is the folder a successful escape would reach.
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoreFilesRequestHandler } from "../core-files-routes";
import { packDirectory } from "../files-tar";
import { cleanupTrees, collect, makeTree, readTree } from "./files-fixture";

let workDir: string;
let bundle: string;
let sandbox: string;
let home: string;
let outside: string;
let server: http.Server;
let base: string;

beforeAll(async () => {
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "core-files-escape-")));
  bundle = path.join(workDir, "core-files-op.cjs");
  await build({
    entryPoints: [path.resolve(__dirname, "../core-files-op-entry.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    logLevel: "silent",
    external: ["better-sqlite3", "node-pty", "ws", "selfsigned"],
  });
}, 60_000);
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

type Mode = "in the daemon" | "as core, in the helper";

async function startServer(mode: Mode): Promise<void> {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(workDir, "box-")));
  home = path.join(sandbox, "home");
  outside = path.join(sandbox, "outside");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(outside, "folder"), { recursive: true });
  fs.writeFileSync(path.join(outside, "precious.txt"), "keep me");
  fs.writeFileSync(path.join(outside, "folder", "inner.txt"), "keep me too");
  fs.writeFileSync(path.join(sandbox, "sibling.txt"), "next to the home");

  // Links a Session could have planted inside the home.
  fs.symlinkSync(outside, path.join(home, "out")); //          a folder outside
  fs.symlinkSync(path.join(outside, "precious.txt"), path.join(home, "file-out")); // a file outside
  fs.symlinkSync("..", path.join(home, "up")); //              the home's parent
  fs.symlinkSync("/etc", path.join(home, "etc")); //           an absolute target
  fs.mkdirSync(path.join(home, "shared"));
  fs.symlinkSync(outside, path.join(home, "shared", "out")); // one level down
  fs.writeFileSync(path.join(home, "inside.txt"), "inside");

  if (mode === "as core, in the helper") {
    vi.stubEnv("AC_CORE_HOME", home);
    vi.stubEnv("AC_CORE_UID", String(process.getuid?.() ?? 1000));
    vi.stubEnv("AC_CORE_GID", String(process.getgid?.() ?? 1000));
  }
  const routes = createCoreFilesRequestHandler({
    filesPort: { workspaceRoot: () => home },
    helper: {
      helperPath: bundle,
      exists: () => true,
      wrap: (spec) => ({ ...spec, args: spec.args as string[], cwd: home, env: { HOME: home, PATH: process.env.PATH ?? "" } }),
    },
  });
  server = http.createServer();
  server.on("request", (req, res) => {
    if (!routes.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(sandbox, { recursive: true, force: true });
  cleanupTrees();
});

type Answer = { status: number; code: string | undefined; text: string };

function call(method: string, url: string, body?: Buffer | string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${url}`, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let code: string | undefined;
        try {
          code = (JSON.parse(text) as { code?: string }).code;
        } catch {
          // an NDJSON stream is not one JSON document; its code, if any, is on an error line
          code = text
            .split("\n")
            .map((line) => {
              try {
                return (JSON.parse(line) as { code?: string }).code;
              } catch {
                return undefined;
              }
            })
            .find((c) => c !== undefined);
        }
        resolve({ status: res.statusCode ?? 0, code, text });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

const enc = encodeURIComponent;
const post = (url: string, value: unknown) => call("POST", url, JSON.stringify(value), { "content-type": "application/json" });

/** Every way out, on every operation: [what it tries, how it asks, the code it must be refused with]. */
function escapes(): Array<[string, () => Promise<Answer>, string]> {
  const tarOfOne = collect(packDirectory(makeTree({ "payload.txt": "owned" })));
  return [
    // ── dot-dot
    ["read ..", () => call("GET", `/v1/files?path=${enc("../sibling.txt")}`), "dot-dot-segment"],
    ["read a/../../", () => call("GET", `/v1/files?path=${enc("shared/../../sibling.txt")}`), "dot-dot-segment"],
    ["read %2e%2e", () => call("GET", "/v1/files?path=%2e%2e%2fsibling.txt"), "dot-dot-segment"],
    ["list ..", () => call("GET", `/v1/files/list?path=${enc("..")}`), "dot-dot-segment"],
    ["write ..", () => call("PUT", `/v1/files?path=${enc("../pwned.txt")}`, "owned"), "dot-dot-segment"],
    ["tar into ..", async () => call("PUT", `/v1/files?path=${enc("..")}`, await tarOfOne, { "content-type": "application/x-tar" }), "dot-dot-segment"],
    ["delete ..", () => call("DELETE", `/v1/files?path=${enc("../sibling.txt")}`), "dot-dot-segment"],
    ["delete ../ (a folder)", () => call("DELETE", `/v1/files?path=${enc("../outside/")}`), "dot-dot-segment"],
    ["mkdir ..", () => call("POST", `/v1/files/folder?path=${enc("../made")}`), "dot-dot-segment"],
    ["move from ..", () => post("/v1/files/move", { from: "../sibling.txt", to: "stolen.txt" }), "dot-dot-segment"],
    ["move to ..", () => post("/v1/files/move", { from: "inside.txt", to: "../gone.txt" }), "dot-dot-segment"],
    // ── absolute
    ["read /", () => call("GET", `/v1/files?path=${enc(path.join(outside, "precious.txt"))}`), "absolute-path"],
    ["list /", () => call("GET", `/v1/files/list?path=${enc(outside)}`), "absolute-path"],
    ["write /", () => call("PUT", `/v1/files?path=${enc(path.join(outside, "pwned.txt"))}`, "owned"), "absolute-path"],
    ["delete /", () => call("DELETE", `/v1/files?path=${enc(path.join(outside, "precious.txt"))}`), "absolute-path"],
    ["delete / (a folder)", () => call("DELETE", `/v1/files?path=${enc(outside + "/")}`), "absolute-path"],
    ["mkdir /", () => call("POST", `/v1/files/folder?path=${enc(path.join(outside, "made"))}`), "absolute-path"],
    ["move from /", () => post("/v1/files/move", { from: path.join(outside, "precious.txt"), to: "stolen.txt" }), "absolute-path"],
    ["move to /", () => post("/v1/files/move", { from: "inside.txt", to: path.join(outside, "gone.txt") }), "absolute-path"],
    // ── a symlink inside the home that points out
    ["read through a link to a folder", () => call("GET", "/v1/files?path=out%2Fprecious.txt"), "outside-project-root"],
    ["read through a link one level down", () => call("GET", "/v1/files?path=shared%2Fout%2Fprecious.txt"), "outside-project-root"],
    ["read the folder a link names", () => call("GET", "/v1/files?path=out"), "outside-project-root"],
    ["read a link to a file", () => call("GET", "/v1/files?path=file-out"), "outside-project-root"],
    ["read through ./up", () => call("GET", "/v1/files?path=up%2Fsibling.txt"), "outside-project-root"],
    ["read through a link to /etc", () => call("GET", "/v1/files?path=etc%2Fpasswd"), "outside-project-root"],
    ["list a link to a folder", () => call("GET", "/v1/files/list?path=out"), "outside-project-root"],
    ["write through a link to a folder", () => call("PUT", "/v1/files?path=out%2Fpwned.txt", "owned"), "outside-project-root"],
    ["write through a link one level down", () => call("PUT", "/v1/files?path=shared%2Fout%2Fpwned.txt", "owned"), "outside-project-root"],
    ["tar into a link to a folder", async () => call("PUT", "/v1/files?path=out", await tarOfOne, { "content-type": "application/x-tar" }), "outside-project-root"],
    ["tar below a link to a folder", async () => call("PUT", "/v1/files?path=out%2Fsub", await tarOfOne, { "content-type": "application/x-tar" }), "outside-project-root"],
    ["delete through a link", () => call("DELETE", "/v1/files?path=out%2Fprecious.txt"), "outside-project-root"],
    ["delete a folder through a link", () => call("DELETE", "/v1/files?path=out%2Ffolder%2F"), "outside-project-root"],
    ["mkdir through a link", () => call("POST", "/v1/files/folder?path=out%2Fmade"), "outside-project-root"],
    ["move from through a link", () => post("/v1/files/move", { from: "out/precious.txt", to: "stolen.txt" }), "outside-project-root"],
    ["move to through a link", () => post("/v1/files/move", { from: "inside.txt", to: "out/gone.txt" }), "outside-project-root"],
  ];
}

describe.each<Mode>(["in the daemon", "as core, in the helper"])("nothing leaves the home, %s", (mode) => {
  beforeEach(async () => {
    await startServer(mode);
  });

  it.each(escapes().map(([name], index) => [index, name] as const))("refuses: %s", async (index, name) => {
    const [, ask, expectedCode] = escapes()[index]!;
    const beforeOutside = readTree(outside);
    const beforeSibling = fs.readFileSync(path.join(sandbox, "sibling.txt"), "utf8");
    const beforeHome = readTree(home);

    const answer = await ask();

    // Where the refusal surfaces: the status and the `code` a client branches on, with the path's
    // own words in the message and none of the file's bytes in the body.
    expect(answer.status, name).toBe(400);
    expect(answer.code, name).toBe(expectedCode);
    expect(answer.text).not.toContain("keep me");
    expect(answer.text).not.toContain("next to the home");
    // And on the disk: nothing outside moved, and nothing was written in the home either.
    expect(readTree(outside)).toEqual(beforeOutside);
    expect(fs.readFileSync(path.join(sandbox, "sibling.txt"), "utf8")).toBe(beforeSibling);
    expect(readTree(home)).toEqual(beforeHome);
    expect(fs.existsSync(path.join(sandbox, "pwned.txt"))).toBe(false);
    expect(fs.existsSync(path.join(sandbox, "made"))).toBe(false);
  });

  it("deletes a link as a link: what it points at survives", async () => {
    const answer = await call("DELETE", "/v1/files?path=file-out");

    expect(answer.status).toBe(200);
    expect(fs.existsSync(path.join(home, "file-out"))).toBe(false);
    expect(fs.readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe("keep me");

    const folderLink = await call("DELETE", "/v1/files?path=out");
    expect(folderLink.status).toBe(200);
    expect(fs.existsSync(path.join(home, "out"))).toBe(false);
    expect(fs.readFileSync(path.join(outside, "folder", "inner.txt"), "utf8")).toBe("keep me too");
  });

  it("does not follow a link inside a folder it deletes", async () => {
    // `shared/` holds `out -> outside`. Deleting `shared/` removes the link, not the folder it names.
    const answer = await call("DELETE", "/v1/files?path=shared%2F");

    expect(answer.status).toBe(200);
    expect(fs.existsSync(path.join(home, "shared"))).toBe(false);
    expect(fs.readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe("keep me");
    expect(fs.readFileSync(path.join(outside, "folder", "inner.txt"), "utf8")).toBe("keep me too");
  });

  it("refuses a link spelt as a folder, which would otherwise be read as the folder it names", async () => {
    const answer = await call("DELETE", "/v1/files?path=out%2F");

    expect(answer.status).toBe(400);
    expect(fs.existsSync(path.join(outside, "folder", "inner.txt"))).toBe(true);
    expect(fs.lstatSync(path.join(home, "out")).isSymbolicLink()).toBe(true);
  });

  it("replaces a link to a file outside rather than writing through it", async () => {
    const answer = await call("PUT", "/v1/files?path=file-out", "replacement");

    expect(answer.status).toBe(200);
    expect(fs.readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe("keep me");
    expect(fs.lstatSync(path.join(home, "file-out")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(home, "file-out"), "utf8")).toBe("replacement");
  });

  it("moves a link as a link: what it points at is not moved", async () => {
    const answer = await post("/v1/files/move", { from: "file-out", to: "renamed" });

    expect(answer.status).toBe(200);
    expect(fs.lstatSync(path.join(home, "renamed")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe("keep me");
  });

  it("still serves a link that stays inside the home", async () => {
    fs.symlinkSync("inside.txt", path.join(home, "alias.txt"));

    const answer = await call("GET", "/v1/files?path=alias.txt");

    expect(answer.status).toBe(200);
    expect(answer.text).toBe("inside");
  });
});
