// Prove harness-cli-config stays Node-free for the Panel browser bundle.
//
// #518 part 3 originally called piHomeMarkers() while building HARNESS_CLI_CONFIG,
// which pulled node:os / node:path into every client chunk that imported the
// table. Vite externalised those to `{}`, and `os.homedir` threw at runtime.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function walkRelativeImports(entry: string, seen = new Set<string>()): string[] {
  const abs = path.resolve(ROOT, entry);
  if (seen.has(abs)) return [];
  seen.add(abs);
  if (!existsSync(abs)) return [];

  const src = readFileSync(abs, "utf8");
  const files = [abs];
  for (const match of src.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
    const spec = match[1]!;
    const candidate = path.resolve(path.dirname(abs), spec);
    const withTs = candidate.endsWith(".ts") ? candidate : `${candidate}.ts`;
    const target = existsSync(withTs)
      ? withTs
      : existsSync(candidate)
        ? candidate
        : `${candidate}/index.ts`;
    files.push(...walkRelativeImports(path.relative(ROOT, target), seen));
  }
  return files;
}

describe("harness-cli-config stays Node-free (#518 part 3)", () => {
  it("imports no node: module in its relative graph", () => {
    const files = walkRelativeImports("harness-cli-config.ts");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, path.relative(ROOT, file)).not.toMatch(/\bfrom\s+["']node:/);
      expect(src, path.relative(ROOT, file)).not.toMatch(/\bimport\s+["']node:/);
      expect(src, path.relative(ROOT, file)).not.toMatch(/require\(\s*["']node:/);
    }
  });
});
