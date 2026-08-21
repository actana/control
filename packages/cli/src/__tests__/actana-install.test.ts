// `actana install` — a CLI with no tarball around it puts a Core on this
// machine (#288 D8), and wires it to itself on the way (#288 D9).
//
// Two claims, and both are about what is on disk afterwards rather than about
// what was printed:
//
//   1. **A failed install leaves nothing installed.** The fetch half writes
//      only into a temporary directory, so a wrong checksum aborts before a
//      byte has been written under `~/.local/share/actana`. That is the same
//      no-op-on-failure property `actana-update.ts`'s header already claims,
//      and it is claimed by both because both go through
//      `actana-fetch-release.ts`.
//   2. **A Core installed here is one this machine's `actana core ls` already
//      knows about, and the one it means by default.** No token hand-carried
//      from one half of this command into the other, on one box.
//
// The release server is `release-fixture.ts`: real tarballs, real `tar -czf`,
// real SHA-256 over the bytes served, and `corrupt` flips one of them while
// leaving `SHA256SUMS` truthful — so the integrity failure under test is a
// genuine one rather than an arranged one.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runActanaCli } from "../actana-cli.ts";
import type { ActanaCliDeps } from "../cli-deps.ts";
import { releaseAssetName, releaseChannel } from "../actana-release.ts";
import { resolveActanaLayout } from "../actana-layout.ts";
import {
  listCoreNames,
  readCoreBlobText,
  readCurrentCore,
  registryPaths,
  writeCoreBlob,
  writeCurrentCore,
} from "../blob-registry.ts";
import { decodeRegistrationBlob } from "@actana/shared/registration-blob";
import { fakeSystem, realTar, stubClientHalf } from "./machine-fixture.ts";
import { fixtureFetcher, writeRelease } from "./release-fixture.ts";

const VERSION = "0.9.0";
const TARGET = "linux-x64";
const BASE_URL = "http://releases.test";
const CHANNEL = releaseChannel({ baseUrl: BASE_URL });
const NOW = 1_700_000_000_000;

let tmp: string;
let home: string;
let releaseDir: string;
let out: string[];
let err: string[];

function layout() {
  return resolveActanaLayout({ HOME: home }, home, "linux");
}

function paths() {
  return registryPaths({ HOME: home }, home);
}

function deps(argv: string[], over: Partial<ActanaCliDeps> = {}): ActanaCliDeps {
  return {
    ...stubClientHalf(() => NOW),
    argv,
    env: { HOME: home, PATH: layout().binDir },
    home,
    hostname: "vm-1",
    networkInterfaces: { eth0: [{ address: "10.0.0.5", family: "IPv4", internal: false }] },
    platform: "linux",
    arch: "x64",
    user: "op",
    uid: 501,
    // The whole point of this suite: no extracted tarball anywhere near this
    // CLI. An `npm i -g @actana/cli` is not standing in one.
    installRoot: "",
    interactive: false,
    system: fakeSystem({}, realTar),
    fetcher: fixtureFetcher(releaseDir, CHANNEL),
    now: () => NOW,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    debug: () => {},
    probeHarnesses: () => ({ "claude-code": { status: "available", version: "2.1.0" } }),
    runDaemon: async () => {
      throw new Error("this test did not expect to start a daemon");
    },
    ...over,
  };
}

/** `actana install`, pointed at the fixture release server. */
function install(over: Partial<ActanaCliDeps> = {}, extra: string[] = []): Promise<number> {
  return runActanaCli(deps(["install", "--base-url", BASE_URL, "--yes", ...extra], over));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actana-install-"));
  home = path.join(tmp, "home");
  releaseDir = path.join(tmp, "releases");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  writeRelease({ dir: releaseDir, version: VERSION, target: TARGET });
  out = [];
  err = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("actana install (#288 D8)", () => {
  it("resolves, downloads, verifies and installs a Core with no tarball in hand", async () => {
    const code = await install();
    if (code !== 0) throw new Error(`install failed: ${err.join("\n")}\n${out.join("\n")}`);

    const installed = layout();
    // The tree landed under the versioned root and `current` points at it.
    expect(fs.existsSync(path.join(installed.versionsDir, VERSION, "core-manifest.json"))).toBe(
      true,
    );
    expect(fs.realpathSync(installed.currentLink)).toBe(
      fs.realpathSync(path.join(installed.versionsDir, VERSION)),
    );
    expect(out.join("\n")).toContain(`Version    ${VERSION}`);
    // And it verified the download rather than trusting it.
    expect(out.join("\n")).toContain("Checksum verified");
  });

  it("aborts on a wrong checksum, leaving nothing installed", async () => {
    // The bytes are flipped; `SHA256SUMS` still describes the real ones, which
    // is exactly what a corrupted or tampered download looks like.
    const code = await install({
      fetcher: fixtureFetcher(releaseDir, CHANNEL, {
        corrupt: [releaseAssetName(VERSION, TARGET)],
      }),
    });

    expect(code).toBe(1);
    const said = err.join("\n");
    expect(said).toContain("checksum mismatch");

    // And it says so in this verb's own terms. The sentence used to be written
    // into `actana-fetch-release.ts` for `update`, so a first-time `install`
    // that failed here was told "the Core is still running the version it was.
    // Retry the update" — an account of a machine the operator does not have.
    // The caller supplies it now (#294 review), and this is the assertion that
    // keeps `update`'s wording from drifting back over `install`'s.
    expect(said).toContain("Nothing was installed. Retry the install");
    expect(said).not.toContain("still running the version it was");

    // The claim in full: not "it printed an error", but "nothing exists".
    const installed = layout();
    expect(fs.existsSync(installed.versionsDir)).toBe(false);
    expect(fs.existsSync(installed.currentLink)).toBe(false);
    expect(fs.existsSync(installed.binLink)).toBe(false);
    // Not even a registry entry, because setup never ran.
    expect(listCoreNames(paths())).toEqual([]);
  });

  it("leaves nothing behind when the release has no build for this machine", async () => {
    const code = await runActanaCli(
      deps(["install", "--base-url", BASE_URL, "--yes"], { arch: "riscv64" }),
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("no Core build for linux/riscv64");
    expect(fs.existsSync(layout().versionsDir)).toBe(false);
  });

  it("takes a pinned version without asking the channel what the latest is", async () => {
    writeRelease({ dir: releaseDir, version: "1.2.0", target: TARGET });
    const fetcher = fixtureFetcher(releaseDir, CHANNEL);

    expect(await install({ fetcher }, ["--version", VERSION])).toBe(0);
    expect(fs.existsSync(path.join(layout().versionsDir, VERSION))).toBe(true);
    // A pinned version costs no API call — an install that still asked would be
    // one API change away from quietly installing something else.
    expect(fetcher.asked.some((url) => url.includes("releases/latest"))).toBe(false);
  });

  it("leaves `install.sh` as the door for a machine with no Node", () => {
    // Not a behaviour test — a boundary one. The shell script does the same
    // three steps this verb does, and it stays because a bare machine has no
    // Node to run this verb with. Two doors, one implementation of the real
    // work: what would be wrong is `install.sh` growing a fourth step.
    const script = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../../../install.sh"),
      "utf8",
    );
    expect(script).toContain("fetch, verify, exec");
  });
});

describe("a Core installed here is wired to the CLI here (#288 D9)", () => {
  it("lists the local Core and selects it, with no blob pasted anywhere", async () => {
    expect(await install()).toBe(0);

    // `actana core ls` on this machine now knows about it…
    expect(listCoreNames(paths())).toEqual(["vm-1"]);
    // …and it is what a client noun means by default.
    expect(readCurrentCore(paths())).toBe("vm-1");

    // And the blob it stored is this Core's: same endpoint setup reported.
    const stored = readCoreBlobText(paths(), "vm-1") ?? "";
    expect(stored).not.toBe("");
    expect(decodeRegistrationBlob(stored.trim())?.endpoint).toBe("wss://10.0.0.5:8443");
  });

  it("stores the credential at 0600 and prints no copy of it anywhere", async () => {
    await install();
    const mode = fs.statSync(path.join(paths().coresDir, "vm-1.txt")).mode & 0o777;
    expect(mode).toBe(0o600);
    // The credential goes into this machine's own registry and nowhere else at
    // all: #287 removed the printed artifact, so a second copy on any output
    // sink is the hand-carry coming back.
    const wiringLine = out.find((line) => line.includes("Registered as"));
    expect(wiringLine).toBeDefined();
    expect(wiringLine ?? "").not.toContain("ey");
    const stored = (readCoreBlobText(paths(), "vm-1") ?? "").trim();
    const printed = [...out, ...err].join("\n");
    expect(printed).not.toContain(stored);
    expect(printed).not.toMatch(/BEGIN (CERTIFICATE|PRIVATE KEY)/);
  });

  it("does not steal a selection the operator already made", async () => {
    // The same "no clobber, no silent win" rule the launcher path follows: a
    // Core this machine deliberately selected stays selected, and the local one
    // is registered and named so `core use` is one command away.
    writeCoreBlob(paths(), "prod", "not-a-real-blob\n");
    writeCurrentCore(paths(), "prod");

    expect(await install()).toBe(0);

    expect(listCoreNames(paths())).toEqual(["prod", "vm-1"]);
    expect(readCurrentCore(paths())).toBe("prod");
    expect(out.join("\n")).toContain("actana core use vm-1");
  });

  it("re-selects the local Core when a re-install finds it already current", async () => {
    expect(await install()).toBe(0);
    expect(await install()).toBe(0);
    expect(readCurrentCore(paths())).toBe("vm-1");
    expect(listCoreNames(paths())).toEqual(["vm-1"]);
  });

  it("falls back to a usable name when the label cannot be one", async () => {
    // A label is free text and a registry name is a path segment. Refusing to
    // wire a Core because its operator called it `web 01` would be a worse
    // answer than calling it `web-01`.
    expect(await install({ hostname: "web 01" })).toBe(0);
    expect(listCoreNames(paths())).toEqual(["web-01"]);
  });
});
