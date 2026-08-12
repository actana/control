// The registry's three promises: where it puts files, what mode it puts them
// at, and what a name is allowed to be (#129 D9).

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BLOB_FILE_MODE,
  clearCurrentCore,
  coreBlobPath,
  coreNameError,
  listCoreNames,
  loadCoreBlob,
  readCurrentCore,
  readRegistry,
  registryPaths,
  removeCoreBlob,
  writeCoreBlob,
  writeCurrentCore,
} from "../blob-registry.ts";
import { sentinelBlobText } from "./cli-harness.ts";

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "actana-registry-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("where the registry lives", () => {
  it("honours XDG_CONFIG_HOME", () => {
    const paths = registryPaths({ XDG_CONFIG_HOME: "/xdg/config" }, "/home/someone");
    expect(paths.root).toBe("/xdg/config/actana");
    expect(paths.coresDir).toBe("/xdg/config/actana/cores");
    expect(paths.currentPointer).toBe("/xdg/config/actana/current.txt");
  });

  it("falls back to ~/.config when it is unset", () => {
    const paths = registryPaths({}, "/home/someone");
    expect(paths.coresDir).toBe("/home/someone/.config/actana/cores");
  });

  it("ignores a relative XDG_CONFIG_HOME rather than resolving it against the cwd", () => {
    // A registry whose location depends on where the operator was standing is a
    // registry that loses Cores.
    const paths = registryPaths({ XDG_CONFIG_HOME: "relative/config" }, "/home/someone");
    expect(paths.coresDir).toBe("/home/someone/.config/actana/cores");
  });

  it("puts the `current` pointer beside `cores/`, so a Core may be named `current`", () => {
    const paths = registryPaths({ XDG_CONFIG_HOME: "/xdg" }, "/home/someone");
    expect(coreBlobPath(paths, "current")).toBe("/xdg/actana/cores/current.txt");
    expect(paths.currentPointer).not.toBe(coreBlobPath(paths, "current"));
  });
});

describe("a blob is a credential", () => {
  it("writes it at mode 0600, in a directory only its owner can read", () => {
    const paths = registryPaths({ XDG_CONFIG_HOME: tempRoot() }, "/unused");
    writeCoreBlob(paths, "prod", sentinelBlobText());

    expect(statSync(coreBlobPath(paths, "prod")).mode & 0o777).toBe(BLOB_FILE_MODE);
    expect(statSync(paths.coresDir).mode & 0o777).toBe(0o700);
  });

  it("re-tightens the mode when it overwrites a file something else loosened", () => {
    // `writeFileSync`'s `mode` only applies on create, so the explicit chmod is
    // what makes 0600 a post-condition rather than a happy path.
    const paths = registryPaths({ XDG_CONFIG_HOME: tempRoot() }, "/unused");
    mkdirSync(paths.coresDir, { recursive: true });
    const file = coreBlobPath(paths, "prod");
    writeFileSync(file, "stale");
    chmodSync(file, 0o644);

    writeCoreBlob(paths, "prod", sentinelBlobText());
    expect(statSync(file).mode & 0o777).toBe(BLOB_FILE_MODE);
  });

  it("reports a loose mode in the registry rather than silently repairing it", () => {
    const paths = registryPaths({ XDG_CONFIG_HOME: tempRoot() }, "/unused");
    writeCoreBlob(paths, "prod", sentinelBlobText());
    chmodSync(coreBlobPath(paths, "prod"), 0o644);

    const [row] = readRegistry(paths);
    expect(row!.insecureMode).toBe(true);
  });
});

describe("what a Core may be named", () => {
  it("accepts ordinary names", () => {
    for (const name of ["prod", "dev-core", "core_2", "Core.EU", "a"]) {
      expect(coreNameError(name), name).toBeNull();
    }
  });

  it("refuses anything that could become a different path", () => {
    for (const name of ["..", ".", "../etc/passwd", "a/b", "a\\b", ".hidden", "", " prod"]) {
      expect(coreNameError(name), name).not.toBeNull();
    }
  });

  it("refuses a name too long to tabulate", () => {
    expect(coreNameError("a".repeat(65))).not.toBeNull();
    expect(coreNameError("a".repeat(64))).toBeNull();
  });
});

describe("listing and the current pointer", () => {
  it("lists nothing, rather than throwing, before anything is registered", () => {
    const paths = registryPaths({ XDG_CONFIG_HOME: tempRoot() }, "/unused");
    expect(listCoreNames(paths)).toEqual([]);
    expect(readRegistry(paths)).toEqual([]);
    expect(readCurrentCore(paths)).toBeNull();
  });

  it("sorts, so two runs print the same table", () => {
    const paths = registryPaths({ XDG_CONFIG_HOME: tempRoot() }, "/unused");
    for (const name of ["zeta", "alpha", "mid"]) writeCoreBlob(paths, name, sentinelBlobText());
    expect(listCoreNames(paths)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("reads a pointer at a Core that has since been removed as `nothing selected`", () => {
    const paths = registryPaths({ XDG_CONFIG_HOME: tempRoot() }, "/unused");
    writeCoreBlob(paths, "prod", sentinelBlobText());
    writeCurrentCore(paths, "prod");
    expect(readCurrentCore(paths)).toBe("prod");

    removeCoreBlob(paths, "prod");
    expect(readCurrentCore(paths)).toBeNull();
  });

  it("clears cleanly when there is no pointer to clear", () => {
    const paths = registryPaths({ XDG_CONFIG_HOME: tempRoot() }, "/unused");
    expect(() => clearCurrentCore(paths)).not.toThrow();
  });

  it("surfaces a corrupt entry as a row with a reason, not as a missing row", () => {
    const paths = registryPaths({ XDG_CONFIG_HOME: tempRoot() }, "/unused");
    writeCoreBlob(paths, "good", sentinelBlobText());
    writeCoreBlob(paths, "broken", "not-a-blob!!");

    const rows = readRegistry(paths);
    expect(rows.map((r) => r.name)).toEqual(["broken", "good"]);
    expect(rows[0]!.error).toBeTruthy();
    expect(rows[0]!.summary).toBeNull();
    expect(rows[1]!.summary?.endpoint).toBe("wss://core.test:9444");
  });
});

describe("loading a blob for the SDK", () => {
  it("returns the blob object, with no path or encoding on it (#129 D9)", () => {
    const paths = registryPaths({ XDG_CONFIG_HOME: tempRoot() }, "/unused");
    writeCoreBlob(paths, "prod", sentinelBlobText());

    const loaded = loadCoreBlob(paths, "prod");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(Object.keys(loaded.blob).sort()).toEqual([
      "bearer",
      "caCert",
      "clientCert",
      "clientKey",
      "endpoint",
      "label",
    ]);
  });

  it("names the Core rather than the file when there is nothing stored", () => {
    const paths = registryPaths({ XDG_CONFIG_HOME: tempRoot() }, "/unused");
    const loaded = loadCoreBlob(paths, "absent");
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain("absent");
  });

  it("stores the blob text as given, with one trailing newline", () => {
    const paths = registryPaths({ XDG_CONFIG_HOME: tempRoot() }, "/unused");
    const text = sentinelBlobText();
    writeCoreBlob(paths, "prod", `  ${text}\n\n`);
    expect(readFileSync(coreBlobPath(paths, "prod"), "utf8")).toBe(`${text}\n`);
  });
});
