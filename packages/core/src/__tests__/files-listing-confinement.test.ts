// Confinement on the **listing** route (#166, F3 restated for a new surface).
//
// #166 asks for the routes ticket's confinement rules to hold here and to be
// **tested independently rather than inherited on trust**, and this file is
// that clause. It does not import `confineToProjectRoot`, does not assert what
// it returns, and would not notice if it were replaced — every case goes in as
// an HTTP request and is judged by what comes back out. That is the point: the
// listing route sharing a confinement call with the read route today is not a
// guarantee about tomorrow, and the failure this guards against is somebody
// adding a third route, wiring it to a plausible-looking helper, and finding
// that the suite proving confinement never went near their code.
//
// **These are accident-guard tests, not sandbox-escape tests** (ADR 0027 D5).
// They assert a mistake is refused with a reason an operator can read. They do
// not assert containment against someone who wants out: whoever can reach this
// surface holds a registration blob, and a registration blob opens `core
// shell`, which is the sanctioned way onto that machine's disk with no path
// check anywhere near it. This suite must not be read as claiming otherwise.
//
// There is one rule here the write side does not have, and it is the reason
// this file exists as much as the independence is: a listing **walks**. The
// read route resolves one path and is done, while a listing keeps producing
// paths for as long as the tree lasts, and confinement has to hold for every
// one of them — which is what "never descend through a symlink" buys.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreFilesRequestHandler, type CoreFilesPort } from "../core-files-routes";
import { cleanupTrees, makeTree } from "./files-fixture";

let server: http.Server;
let base: string;
let projects: Record<string, string> = {};

const filesPort: CoreFilesPort = { projectRoot: (id) => projects[id] ?? null };

beforeEach(async () => {
  projects = {};
  const routes = createCoreFilesRequestHandler({ filesPort });
  server = http.createServer();
  server.on("request", (req, res) => {
    if (routes.handle(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupTrees();
});

type Listing = { status: number; body: Buffer };

function list(query: string, projectId = "p1"): Promise<Listing> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}/v1/projects/${projectId}/files/list${query}`,
      { method: "GET", agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function refusal(res: Listing): { code?: unknown; error?: unknown } {
  return JSON.parse(res.body.toString("utf8")) as { code?: unknown; error?: unknown };
}

function lines(res: Listing): Array<Record<string, unknown>> {
  return res.body
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const paths = (res: Listing): string[] =>
  lines(res)
    .filter((line) => line.type === "entry")
    .map((line) => String(line.path));

function project(id: string, tree: Parameters<typeof makeTree>[0] = {}): string {
  const root = makeTree(tree);
  projects[id] = root;
  return root;
}

/** A directory outside every Project, with something worth not listing in it. */
function outsideTree(): string {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "actana-outside-")));
  fs.writeFileSync(path.join(outside, "secret.txt"), "not the Project's");
  fs.mkdirSync(path.join(outside, "private"));
  fs.writeFileSync(path.join(outside, "private", "deeper.txt"), "also not");
  outsides.push(outside);
  return outside;
}

const outsides: string[] = [];
afterEach(() => {
  for (const dir of outsides.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ─── The three cases the routes ticket names ─────────────────────────────────

describe("an absolute path is refused", () => {
  it("refuses `/etc`, naming what it got", async () => {
    project("p1", { "a.txt": "a" });

    const res = await list("?path=/etc");

    expect(res.status).toBe(400);
    expect(refusal(res).code).toBe("absolute-path");
  });

  it("refuses an absolute path that happens to point back inside the Project", async () => {
    // Refused on shape rather than on where it lands: every path on this
    // surface is Project-relative, and accepting an absolute one would make
    // the address space two things at once (ADR 0027 D2).
    const root = project("p1", { "src/a.txt": "a" });

    const res = await list(`?path=${encodeURIComponent(path.join(root, "src"))}`);

    expect(res.status).toBe(400);
    expect(refusal(res).code).toBe("absolute-path");
  });
});

describe("a `..` escape is refused", () => {
  it("refuses a leading `..`", async () => {
    project("p1");

    const res = await list("?path=../..");

    expect(res.status).toBe(400);
    expect(refusal(res).code).toBe("dot-dot-segment");
  });

  it("refuses a `..` buried mid-path, which is the one that reads as harmless", async () => {
    project("p1", { "src/": "" });

    const res = await list("?path=src/../..");

    expect(res.status).toBe(400);
    expect(refusal(res).code).toBe("dot-dot-segment");
  });

  it("refuses a `..` that would have cancelled out and stayed inside", async () => {
    project("p1", { "src/a.txt": "a" });

    const res = await list("?path=src/../src");

    expect(res.status).toBe(400);
    expect(refusal(res).code).toBe("dot-dot-segment");
  });
});

describe("a symlink resolving outside the Project is refused", () => {
  it("refuses the link itself as a listing path", async () => {
    const root = project("p1");
    fs.symlinkSync(outsideTree(), path.join(root, "escape"));

    const res = await list("?path=escape");

    expect(res.status).toBe(400);
    expect(refusal(res).code).toBe("outside-project-root");
  });

  it("refuses innocent-looking segments underneath a symlinked parent", async () => {
    // Nothing in `escape/private` is absolute and nothing is `..`. A check
    // over the string would pass it; only resolution catches it, which is why
    // confinement resolves first and judges after.
    const root = project("p1");
    fs.symlinkSync(outsideTree(), path.join(root, "escape"));

    const res = await list("?path=escape/private");

    expect(res.status).toBe(400);
    expect(refusal(res).code).toBe("outside-project-root");
  });

  it("names the resolved location in the refusal, so an operator can see where it went", async () => {
    const root = project("p1");
    const outside = outsideTree();
    fs.symlinkSync(outside, path.join(root, "escape"));

    const res = await list("?path=escape");

    expect(String(refusal(res).error)).toContain(outside);
  });
});

// ─── The rules that make the third one real ──────────────────────────────────

describe("a malformed path is refused before anything touches the disk", () => {
  it("refuses a NUL byte", async () => {
    project("p1");

    const res = await list(`?path=${encodeURIComponent("a\0b")}`);

    expect(res.status).toBe(400);
    expect(refusal(res).code).toBe("malformed-path");
  });

  it("refuses a backslash, which is a legal file name here and never what was meant", async () => {
    project("p1");

    const res = await list(`?path=${encodeURIComponent("..\\..\\etc")}`);

    expect(res.status).toBe(400);
    expect(refusal(res).code).toBe("malformed-path");
  });
});

describe("a Project whose own root runs through a symlink still lists", () => {
  it("lists it, rather than refusing every path in it", async () => {
    // `/home/op/work` → `/mnt/data/work` is an ordinary way to register a
    // Project. Every candidate under it resolves to the real location, so a
    // containment check that compared against the unresolved root would refuse
    // the whole Project.
    const real = makeTree({ "a.txt": "a", "src/b.txt": "b" });
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), "actana-linked-"));
    outsides.push(holder);
    const link = path.join(holder, "project");
    fs.symlinkSync(real, link);
    projects.p1 = link;

    const res = await list("");

    expect(res.status).toBe(200);
    expect(paths(res).sort()).toEqual(["a.txt", "src", "src/b.txt"]);
  });
});

// ─── The rule a walk needs and a single-path read does not ───────────────────

describe("a walk stays inside for every path it produces, not just the one it was given", () => {
  it("lists a symlink that points out of the Project without following it", async () => {
    const root = project("p1", { "a.txt": "a" });
    const outside = outsideTree();
    fs.symlinkSync(outside, path.join(root, "escape"));

    const res = await list("");

    // The link is a fact about this Project and is reported as one. What is on
    // the other end of it is not this Project's, and none of it appears.
    expect(paths(res).sort()).toEqual(["a.txt", "escape"]);
    expect(lines(res)).toContainEqual(expect.objectContaining({ path: "escape", kind: "symlink" }));
    expect(paths(res).some((p) => p.includes("secret"))).toBe(false);
  });

  it("emits no path that leaves the Project, however deep the tree gets", async () => {
    const root = project("p1", { "one/two/three/a.txt": "a", "b.txt": "b" });
    const outside = outsideTree();
    fs.symlinkSync(outside, path.join(root, "one/two/escape"));
    fs.symlinkSync("/etc", path.join(root, "one/etc-link"));

    const res = await list("");

    for (const entry of paths(res)) {
      expect(path.posix.isAbsolute(entry)).toBe(false);
      expect(entry.split("/")).not.toContain("..");
      // The load-bearing one: resolve each reported path the way a client
      // would — Project root plus the string — and it must still be inside.
      const resolved = path.resolve(root, entry);
      expect(resolved === root || resolved.startsWith(`${root}${path.sep}`)).toBe(true);
    }
    // And nothing from the other side of either link is in the listing at all.
    expect(paths(res).some((p) => p.includes("secret") || p.includes("passwd"))).toBe(false);
    expect(paths(res).sort()).toEqual([
      "b.txt",
      "one",
      "one/etc-link",
      "one/two",
      "one/two/escape",
      "one/two/three",
      "one/two/three/a.txt",
    ]);
  });

  it("digests a symlink's target string rather than reading the file it points at", async () => {
    // The digest is the other way bytes from outside the Project could reach a
    // client, and it is closed by the same rule: a link's content *is* its
    // target string, so that is what is hashed.
    const root = project("p1");
    const outside = outsideTree();
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));

    const res = await list("?sha256=1");

    const target = path.join(outside, "secret.txt");
    const entry = lines(res).find((line) => line.kind === "symlink")!;
    expect(entry.size).toBe(target.length);
    expect(entry.sha256).toBe(createHash("sha256").update(target).digest("hex"));
    // Said the other way round, which is the half that matters: the bytes of
    // the file outside the Project were never read, so they cannot be inferred
    // from what came back.
    expect(entry.sha256).not.toBe(createHash("sha256").update("not the Project's").digest("hex"));
  });

  it("keeps a listing of a subtree inside that subtree", async () => {
    const root = project("p1", { "src/a.txt": "a", "elsewhere/b.txt": "b" });
    fs.symlinkSync(path.join(root, "elsewhere"), path.join(root, "src", "sideways"));

    const res = await list("?path=src");

    // `sideways` points at a legitimate part of the same Project, so it is not
    // a confinement refusal — but it is still not walked, so a listing of `src`
    // reports `src/sideways` and nothing under it.
    expect(paths(res).sort()).toEqual(["src/a.txt", "src/sideways"]);
  });
});
