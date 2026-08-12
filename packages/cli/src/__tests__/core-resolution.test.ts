// Credential resolution, in the order #129 D9 fixes it in:
//
//   --core <name>  →  ACTANA_CORE_BLOB  →  the `current` pointer
//
// The order is the decision. Each test below pins one step of it by making the
// *later* sources answer differently, so a regression that reorders them fails
// here rather than in whichever command happens to be run with two sources set.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registryPaths, writeCoreBlob, writeCurrentCore } from "../blob-registry.ts";
import { CORE_BLOB_ENV, resolveCore } from "../core-resolution.ts";
import { sentinelBlobText } from "./cli-harness.ts";

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "actana-resolve-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** A registry holding `flagged` and `pointed`, with `current` at `pointed`. */
function populated() {
  const root = tempRoot();
  const paths = registryPaths({ XDG_CONFIG_HOME: root }, root);
  writeCoreBlob(paths, "flagged", sentinelBlobText("wss://flagged.test:9444"));
  writeCoreBlob(paths, "pointed", sentinelBlobText("wss://pointed.test:9444"));
  writeCurrentCore(paths, "pointed");
  return { root, paths };
}

describe("the resolution order", () => {
  it("takes --core first, over both the environment and the pointer", () => {
    const { root, paths } = populated();
    const result = resolveCore({
      paths,
      env: { [CORE_BLOB_ENV]: sentinelBlobText("wss://env.test:9444") },
      home: root,
      coreFlag: "flagged",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.core.source).toBe("flag");
    expect(result.core.name).toBe("flagged");
    expect(result.core.blob.endpoint).toBe("wss://flagged.test:9444");
  });

  it("takes ACTANA_CORE_BLOB second, over the pointer", () => {
    const { root, paths } = populated();
    const result = resolveCore({
      paths,
      env: { [CORE_BLOB_ENV]: sentinelBlobText("wss://env.test:9444") },
      home: root,
      coreFlag: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.core.source).toBe("env");
    expect(result.core.blob.endpoint).toBe("wss://env.test:9444");
    // Single-Core mode has no registry entry, so there is no name to report and
    // none is invented.
    expect(result.core.name).toBeNull();
  });

  it("falls back to the `current` pointer last", () => {
    const { root, paths } = populated();
    const result = resolveCore({ paths, env: {}, home: root, coreFlag: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.core.source).toBe("current");
    expect(result.core.name).toBe("pointed");
  });

  it("ignores an empty ACTANA_CORE_BLOB rather than failing on it", () => {
    // An exported-but-empty variable is what a shell profile leaves behind when
    // the thing that was meant to set it did not run. Treating it as "set" turns
    // that into an error the operator cannot act on.
    const { root, paths } = populated();
    const result = resolveCore({ paths, env: { [CORE_BLOB_ENV]: "   " }, home: root, coreFlag: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.core.source).toBe("current");
  });
});

describe("ACTANA_CORE_BLOB takes a paste or a path", () => {
  it("reads an absolute path", () => {
    const root = tempRoot();
    const paths = registryPaths({ XDG_CONFIG_HOME: root }, root);
    const file = path.join(root, "blob.txt");
    writeFileSync(file, `${sentinelBlobText("wss://file.test:9444")}\n`);

    const result = resolveCore({ paths, env: { [CORE_BLOB_ENV]: file }, home: root, coreFlag: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.core.blob.endpoint).toBe("wss://file.test:9444");
  });

  it("expands a leading ~ against the home it was given", () => {
    const root = tempRoot();
    const paths = registryPaths({ XDG_CONFIG_HOME: root }, root);
    writeFileSync(path.join(root, "blob.txt"), sentinelBlobText("wss://tilde.test:9444"));

    const result = resolveCore({
      paths,
      env: { [CORE_BLOB_ENV]: "~/blob.txt" },
      home: root,
      coreFlag: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.core.blob.endpoint).toBe("wss://tilde.test:9444");
  });

  it("names the path, and only the path, when the file cannot be read", () => {
    const root = tempRoot();
    const paths = registryPaths({ XDG_CONFIG_HOME: root }, root);
    const result = resolveCore({
      paths,
      env: { [CORE_BLOB_ENV]: "/nowhere/blob.txt" },
      home: root,
      coreFlag: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("/nowhere/blob.txt");
    expect(result.error).toContain("ENOENT");
  });
});

describe("when nothing resolves", () => {
  it("names all three sources, in order", () => {
    const root = tempRoot();
    const paths = registryPaths({ XDG_CONFIG_HOME: root }, root);
    const result = resolveCore({ paths, env: {}, home: root, coreFlag: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("--core");
    expect(result.error).toContain(CORE_BLOB_ENV);
    expect(result.error).toContain("actana core use");
  });

  it("says which source was bad when ACTANA_CORE_BLOB will not decode", () => {
    const root = tempRoot();
    const paths = registryPaths({ XDG_CONFIG_HOME: root }, root);
    const result = resolveCore({
      paths,
      env: { [CORE_BLOB_ENV]: "bm90LWpzb24=" },
      home: root,
      coreFlag: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(CORE_BLOB_ENV);
  });

  it("does not silently fall through to the pointer when --core names nothing", () => {
    // The flag was typed for this invocation. Answering it with a different
    // Core's credential would be the worst possible kind of helpful.
    const { root, paths } = populated();
    const result = resolveCore({ paths, env: {}, home: root, coreFlag: "absent" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("absent");
  });
});
