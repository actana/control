import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The Panel's `dependencies` are what `pnpm deploy --prod` puts in the image
// (deploy/panel.Dockerfile). `@tanstack/react-start` used to sit there, and
// with it vite, postcss, @babel/core, esbuild and lightningcss: 417 packages
// and 480 MB of deployed tree, against 280 and 363 MB without it. Vite inlines
// react-start into dist/server, so the runtime never imports it (#25).

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const panelDir = path.join(repoRoot, "packages", "panel");
const manifest = JSON.parse(fs.readFileSync(path.join(panelDir, "package.json"), "utf8"));

const BUILD_ONLY = [
  "@tanstack/react-start",
  "@tanstack/router-plugin",
  "@tailwindcss/vite",
  "@vitejs/plugin-react",
  "@babel/core",
  "esbuild",
  "postcss",
  "tailwindcss",
  "typescript",
  "vite",
];

/** The package name of a bare specifier: `react-icons/si` → `react-icons`. */
function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Bare specifiers a built ES module imports, statically or with `import("…")`. */
function bareImports(source) {
  const found = new Set();
  const patterns = [
    /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) found.add(specifier);
    }
  }
  return [...found];
}

function isBuiltin(specifier) {
  return specifier.startsWith("node:") || builtinModules.includes(specifier.split("/")[0]);
}

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

describe("the Panel ships no build toolchain (#25)", () => {
  it("lists @tanstack/react-start as a devDependency, not a dependency", () => {
    expect(Object.keys(manifest.dependencies)).not.toContain("@tanstack/react-start");
    expect(Object.keys(manifest.devDependencies)).toContain("@tanstack/react-start");
  });

  it("keeps every build-only package out of the runtime dependencies", () => {
    const leaked = BUILD_ONLY.filter((name) => name in manifest.dependencies);
    expect(leaked).toEqual([]);
  });

  it("has a lockfile that agrees with the manifest", () => {
    const lock = fs.readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");
    const importer = lock.split(/\n {2}packages\/panel:\n/)[1].split(/\n {2}\S/)[0];
    const [deps, devDeps] = importer.split(/\n {4}devDependencies:\n/);
    expect(deps).not.toContain("'@tanstack/react-start':");
    expect(devDeps).toContain("'@tanstack/react-start':");
  });

  it("reads the bare imports out of bundled code", () => {
    const source = [
      'import { createRequire } from "node:module";',
      'import "react";',
      'import { SiGo } from "react-icons/si";',
      'export { x } from "./assets/chunk.js";',
      'const m = await import("@actana/sdk/core");',
      'var MAGIC = Buffer.from("AC1", "utf8");',
    ].join("\n");
    expect(bareImports(source).sort()).toEqual(["@actana/sdk/core", "node:module", "react", "react-icons/si"]);
    expect(packageName("@actana/sdk/core")).toBe("@actana/sdk");
    expect(packageName("react-icons/si")).toBe("react-icons");
  });

  const serverDist = path.join(panelDir, "dist", "server");
  it.skipIf(!fs.existsSync(serverDist))(
    "imports only node builtins and runtime dependencies from the built server",
    () => {
      const imported = new Set(
        jsFiles(serverDist).flatMap((file) => bareImports(fs.readFileSync(file, "utf8"))),
      );
      const undeclared = [...imported]
        .filter((specifier) => !isBuiltin(specifier))
        .map(packageName)
        .filter((name) => !(name in manifest.dependencies));
      expect([...new Set(undeclared)]).toEqual([]);
      expect(imported.has("react")).toBe(true);
    },
  );
});
