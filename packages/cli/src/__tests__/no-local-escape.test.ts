// The boundary that makes this a CLI: it cannot start a process (#129 D9).
//
// The ticket's wording is the argument in full — *`actana core add` accepts a
// file or stdin. Never `docker exec` — a CLI that shells into a container to
// fetch its own credentials is not a CLI.* A client that gets its credential by
// running a command on the Core's host only works when the Core is on this
// machine, which is the case that matters least; it makes a container runtime a
// dependency of a program whose whole purpose is to not need one; and it turns
// "paste this once" into a standing privilege.
//
// Nothing in the source says `docker`, which is why this test does not grep for
// it: a string is renameable and the *capability* is not. What it asserts is
// that no shipped module imports a way to start a process at all. That covers
// the container shell-out, and it covers the four other shapes the same
// temptation takes — scp'ing a blob off a host, running `ssh core 'actana
// token'` internally, calling a package manager, shelling out to `curl`.
//
// The one verb that will legitimately want a subprocess is `core shell` (#162),
// and it is the exception that proves the rule: it hands the operator a
// terminal on the *Core*, over the core link, rather than running anything
// locally on their behalf.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "..");

/**
 * Every shipped module — this package's own source at any depth, tests
 * excluded. Recursive, so a `src/commands/…` added later is covered without
 * anybody remembering to extend this.
 */
function shippedSources(dir: string = SRC): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      files.push(...shippedSources(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Source with its comments removed.
 *
 * The sweep below reads what a module *does*, and every file in this package
 * carries a header explaining which packages it may not import — prose that
 * names `@actana/shared` and `child_process` on purpose. Scanning it would make
 * the documentation of a rule indistinguishable from a breach of it.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[^\n"'`]*\/\/[^\n]*$/gm, "");
}

/**
 * The import specifiers in a source file.
 *
 * Double and single quotes both count — TypeScript treats them as one thing and
 * a formatter may rewrite between them. Backticks are deliberately excluded: a
 * static import cannot use one, and the prose in these headers is full of
 * package names in backticks.
 */
function importSpecifiers(source: string): string[] {
  return [
    ...withoutComments(source).matchAll(/(?:^|[\s(])(?:from|import)\s*\(?\s*(["'])([^"']+)\1/gm),
  ].map((m) => m[2]!);
}

/** Modules that can start a process, under either specifier spelling. */
const PROCESS_STARTERS = ["child_process", "node:child_process", "node:worker_threads", "worker_threads"];

describe("the CLI cannot shell out (#129 D9)", () => {
  it("has sources to sweep", () => {
    // A sweep over an empty list passes and proves nothing. This is the guard
    // on the guard.
    expect(shippedSources().length).toBeGreaterThan(5);
  });

  it("imports nothing that can start a process", () => {
    for (const file of shippedSources()) {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        expect(
          PROCESS_STARTERS,
          `${path.relative(SRC, file)} imports ${specifier} — a CLI that shells out to fetch its own credentials is not a CLI (#129 D9)`,
        ).not.toContain(specifier);
      }
    }
  });

  it("does not reach for the process-starting globals either", () => {
    // `process.binding`, and a dynamic `require("child_" + "process")`, are the
    // two ways around an import sweep that do not need a new import.
    for (const file of shippedSources()) {
      const source = withoutComments(readFileSync(file, "utf8"));
      expect(source, `${path.relative(SRC, file)} calls process.binding`).not.toMatch(
        /process\s*\.\s*binding/,
      );
      expect(source, `${path.relative(SRC, file)} builds a require specifier`).not.toMatch(
        /require\s*\(\s*[^)"']*\+/,
      );
    }
  });
});

describe("the published CLI is the client half (#129 D8)", () => {
  it("carries no daemon: nothing here imports the Core package", () => {
    // `actana daemon` stays in `packages/core`. An import of it would put a Node
    // daemon, `better-sqlite3` and `node-pty` in the dependency graph of a
    // package whose entire job is to need none of them.
    for (const file of shippedSources()) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        expect(
          specifier.startsWith("@actana/core"),
          `${path.relative(SRC, file)} imports ${specifier}`,
        ).toBe(false);
      }
    }
  });

  it("carries no private package: nothing here imports @actana/shared", () => {
    // `packages/shared` is private and stays private (ADR 0025 D4). This is the
    // package #129 exists to publish, so a `@actana/shared` import would be a
    // dependency nobody outside this repository can resolve — the exact
    // arrangement ADR 0025 rejected for the SDK.
    for (const file of shippedSources()) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        expect(
          specifier.startsWith("@actana/shared"),
          `${path.relative(SRC, file)} imports ${specifier}`,
        ).toBe(false);
      }
    }
  });

  it("declares only the SDK and its socket library as runtime dependencies", () => {
    const manifest = JSON.parse(
      readFileSync(path.resolve(SRC, "..", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string>; bin: Record<string, string> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@actana/sdk", "ws"]);
  });
});

describe("the command is `actana` (#129 D8)", () => {
  it("is the bin name the package installs, whatever the package is called", () => {
    const manifest = JSON.parse(
      readFileSync(path.resolve(SRC, "..", "package.json"), "utf8"),
    ) as { name: string; bin: Record<string, string> };

    expect(manifest.name).toBe("@actana/cli");
    // One binary name, split by noun. Not `actana-cli`, not `ac`, and not a
    // second command to remember: `npm i -g @actana/cli` puts `actana` on the
    // PATH the same way `npm i -g npm` puts `npm` there.
    expect(Object.keys(manifest.bin)).toEqual(["actana"]);
    expect(manifest.bin.actana).toBe("bin/actana.mjs");
  });
});
