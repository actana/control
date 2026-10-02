import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A package that imports better-sqlite3 must declare it itself. It used to be
// found through the root manifest, so removing it there broke packages/shared's
// tests with "Cannot find package 'better-sqlite3'" (#643, review R1).

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']better-sqlite3["']/;

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist") return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mjs|js)$/.test(entry.name) ? [full] : [];
  });
}

describe("better-sqlite3 is declared where it is imported", () => {
  const packages = fs.readdirSync(path.join(repoRoot, "packages"));

  for (const name of packages) {
    const dir = path.join(repoRoot, "packages", name);
    const manifestPath = path.join(dir, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    const importers = sourceFiles(dir).filter((file) => IMPORT.test(fs.readFileSync(file, "utf8")));
    if (importers.length === 0) continue;

    it(`packages/${name} lists it in its own manifest`, () => {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const declared = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
      expect(Object.keys(declared)).toContain("better-sqlite3");
    });
  }

  it("finds the Core and shared as importers (the scan is not vacuous)", () => {
    const hits = ["core", "shared"].filter((name) =>
      sourceFiles(path.join(repoRoot, "packages", name)).some((file) => IMPORT.test(fs.readFileSync(file, "utf8"))),
    );
    expect(hits).toEqual(["core", "shared"]);
  });
});
