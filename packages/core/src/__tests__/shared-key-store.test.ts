import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSharedKeyStore,
  normalizePrefix,
  parseAttachment,
  SHARED_KEY_FILE,
  type SharedAttachment,
} from "../shared-key-store";

// The Shared folder's key store (#562, ADR 0041 D33). The point of the module is one
// fact: the key is in a file only the daemon's user can open. These tests hold it to
// the bits on disk. The kernel's answer, with two real users, is
// `shared-key-store-uids.test.ts`.

const KEY: SharedAttachment = {
  endpoint: "http://seaweedfs:8333",
  bucket: "actana-shared",
  prefix: "cores/core-a",
  region: "us-east-1",
  accessKeyId: "AKIA-TEST-ID",
  secretAccessKey: "SECRET-TEST-VALUE",
  sessionToken: "TOKEN-TEST-VALUE",
  expiresAt: 1_790_000_000_000,
};

let root: string;
let stateDir: string;
const oldUmask = process.umask();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-key-"));
  stateDir = path.join(root, "state");
});

afterEach(() => {
  process.umask(oldUmask);
  fs.rmSync(root, { recursive: true, force: true });
});

const mode = (p: string): number => fs.statSync(p).mode & 0o777;

describe("the key file's permissions", () => {
  it("is 0600 and the directory it makes is 0700, whatever the umask", () => {
    process.umask(0);
    const store = createSharedKeyStore(stateDir);
    store.save(KEY);
    expect(store.path).toBe(path.join(stateDir, SHARED_KEY_FILE));
    expect(mode(store.path).toString(8)).toBe("600");
    expect(mode(stateDir).toString(8)).toBe("700");
  });

  it("stays 0600 when a push replaces it, and leaves no temp file with the key in it", () => {
    process.umask(0);
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const store = createSharedKeyStore(stateDir);
    store.save(KEY);
    store.save({ ...KEY, sessionToken: "TOKEN-TWO", expiresAt: KEY.expiresAt + 1 });
    expect(mode(store.path).toString(8)).toBe("600");
    expect(fs.readdirSync(stateDir)).toEqual([SHARED_KEY_FILE]);
    expect(store.load()?.sessionToken).toBe("TOKEN-TWO");
  });

  it("holds the key nowhere but that one file", () => {
    const store = createSharedKeyStore(stateDir);
    store.save(KEY);
    const holders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (fs.readFileSync(full, "utf8").includes(KEY.secretAccessKey)) holders.push(full);
      }
    };
    walk(root);
    expect(holders).toEqual([store.path]);
  });
});

describe("the store", () => {
  it("round trips an attachment and forgets it on clear", () => {
    const store = createSharedKeyStore(stateDir);
    expect(store.load()).toBeNull();
    store.save(KEY);
    expect(store.load()).toEqual(KEY);
    store.clear();
    expect(store.load()).toBeNull();
    expect(fs.existsSync(store.path)).toBe(false);
    store.clear();
  });

  it("reads a damaged or foreign file as no attachment", () => {
    fs.mkdirSync(stateDir, { recursive: true });
    const store = createSharedKeyStore(stateDir);
    fs.writeFileSync(store.path, "not json");
    expect(store.load()).toBeNull();
    fs.writeFileSync(store.path, JSON.stringify({ ...KEY, prefix: "../other" }));
    expect(store.load()).toBeNull();
  });
});

describe("parseAttachment and normalizePrefix", () => {
  it("refuses a prefix that could leave the Core's own", () => {
    for (const bad of ["", "/", "..", "a/../b", "a//b", "a/./b", "a\\b"]) {
      expect(normalizePrefix(bad), bad).toBeNull();
    }
    expect(normalizePrefix("/cores/core-a/")).toBe("cores/core-a");
  });

  it("refuses an endpoint that is not http(s) and a key with a field missing", () => {
    expect(parseAttachment({ ...KEY, endpoint: "file:///etc" })).toBeNull();
    expect(parseAttachment({ ...KEY, endpoint: "nonsense" })).toBeNull();
    expect(parseAttachment({ ...KEY, sessionToken: "" })).toBeNull();
    expect(parseAttachment({ ...KEY, expiresAt: Number.NaN })).toBeNull();
    expect(parseAttachment(null)).toBeNull();
  });
});
