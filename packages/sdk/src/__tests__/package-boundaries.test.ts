// The two boundaries this package is only useful if it keeps (issue 153).
//
// Both are traps rather than preferences, and both cost a debugging session
// rather than a lint warning when they break.

import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import { DurableCoreClient } from "../durable-core-client";
import { startCoreRig, type CoreRig } from "./fake-core-link";

const SRC = path.resolve(import.meta.dirname, "..");

/**
 * Every shipped module — the package's own source at any depth, tests excluded.
 *
 * **Recursive on purpose.** This package is flat today, and a sweep of the top
 * level only would have gone on passing the day somebody added
 * `src/transport/…` — silently, and with no failure to point at the module that
 * had just imported the world. A guardrail whose whole reason for existing is
 * one import rule has to see every file the rule applies to.
 *
 * `__tests__` is the one directory left out, and it is left out rather than
 * overlooked: the suites here drive the real Core server and the real bearer
 * helpers through the test-only aliases in `vitest.config.ts` (see below), so
 * they import exactly what shipped code may not.
 */
function shippedSources(dir: string = SRC): string[] {
  const files: string[] = [];
  // Sorted, so what the sweep reports is the same list in the same order on
  // every machine — a failure naming a different file each run is a failure
  // nobody trusts.
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
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
 * The import specifiers in a source file, however they were quoted.
 *
 * Double, single and backtick all count. TypeScript treats them as one thing and
 * a formatter can rewrite between them, so a check that read only one of the
 * three would be a guardrail with a documented way around it.
 */
function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/(?:^|[\s(])(?:from|import)\s*\(?\s*(["'`])([^"'`]+)\1/gm),
  ].map((m) => m[2]!);
}

/**
 * Comments out, so prose is not read as code. These files carry a lot of it, and
 * a sentence like `tell "locked" from "gone"` is a perfectly good import
 * statement to a regex that never learned the difference.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every import in these files that is neither a relative path nor `ws`. */
function offendingImports(files: string[]): string[] {
  const offences: string[] = [];
  for (const file of files) {
    const source = withoutComments(readFileSync(file, "utf8"));
    for (const specifier of importSpecifiers(source)) {
      const allowed =
        specifier.startsWith("./") || specifier.startsWith("../") || specifier === "ws";
      if (!allowed) offences.push(`${path.basename(file)} imports ${specifier}`);
    }
  }
  return offences;
}

/** Fixture trees the sweep-of-the-sweep plants, removed when the file is done. */
const temporaryDirs: string[] = [];

afterAll(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
  temporaryDirs.length = 0;
});

describe("package boundaries", () => {
  it("imports nothing but its own modules and `ws`", () => {
    // `@actana/shared` is private and stays private (ADR 0025 D4), so an import
    // of it here would make the one package this effort exists to publish
    // unresolvable outside this repository. `@actana/core` is the *server* and
    // depends on this package (D2) — importing it back would be a cycle. Both
    // are available to the suites in this directory and to nothing else, which is
    // what the test-only aliases in `vitest.config.ts` are for.
    const offences = offendingImports(shippedSources());
    expect(offences).toEqual([]);
  });

  it("sweeps subdirectories and every quote style — the guardrail on the guardrail", () => {
    // The check above passes on a clean package either way, so it cannot tell a
    // sweep that looked everywhere from one that looked at the top level for
    // double quotes. This plants what each miss would have let through — a
    // module one directory down, and a single-quoted specifier — and asserts
    // both are caught. Without the recursion and the quote-agnostic regex above,
    // this test fails; that is what makes them load-bearing rather than tidy.
    const root = mkdtempSync(path.join(tmpdir(), "sdk-boundaries-"));
    temporaryDirs.push(root);
    mkdirSync(path.join(root, "transport"), { recursive: true });
    mkdirSync(path.join(root, "__tests__"), { recursive: true });
    writeFileSync(path.join(root, "ok.ts"), 'import { a } from "./a";\nimport WS from "ws";\n');
    writeFileSync(path.join(root, "single.ts"), "import { z } from 'zod';\n");
    writeFileSync(path.join(root, "transport", "nested.ts"), 'import x from "@actana/shared/x";\n');
    // Left out on both counts: a test directory, and a `.test.ts` file beside
    // shipped code. Neither is shipped, and both import what shipped code cannot.
    writeFileSync(path.join(root, "__tests__", "rig.ts"), 'import c from "@actana/core/pty";\n');
    writeFileSync(path.join(root, "ok.test.ts"), 'import c from "@actana/core/pty";\n');

    const offences = offendingImports(shippedSources(root));

    expect(offences).toEqual([
      "single.ts imports zod",
      "nested.ts imports @actana/shared/x",
    ]);
  });

  describe("the cursor store is injected, never reached for", () => {
    let rig: CoreRig | null = null;
    let client: DurableCoreClient | null = null;
    const SECRET = "boundaries-suite-secret-32-bytes-xx";

    afterEach(() => {
      client?.close();
      client = null;
      rig?.close();
      rig = null;
      delete (globalThis as { localStorage?: unknown }).localStorage;
    });

    it("leaves a global localStorage untouched even when one exists", async () => {
      // The Panel satisfies `CoreLinkCursorStorage` with the browser's
      // `localStorage`, and a Node package that reached for that global would
      // drag a DOM dependency into a process that has no DOM — or, worse, work in
      // the Panel and silently keep no cursor at all anywhere else. So: a global
      // is planted, a client is built with no `storage` at all, and the cursor
      // still has to advance without the global being consulted once.
      const getItem = vi.fn(() => null);
      const setItem = vi.fn();
      Object.defineProperty(globalThis, "localStorage", {
        value: { getItem, setItem },
        configurable: true,
        writable: true,
      });

      rig = startCoreRig({ authVerifier: (bearer) => verifyBearer(bearer, SECRET) });
      rig.eventLog.appendEvent("task:created", "{}", { taskId: "t1" });
      const dial = rig.dialer();
      client = new DurableCoreClient({
        url: "wss://core.test:9444",
        bearer: signBearer({ coreId: "core_1", exp: Date.now() + 60_000 }, SECRET),
        createSocket: dial.createSocket,
        reconnectInitialMs: 5,
        reconnectMaxMs: 5,
      });

      await client.connect();
      const connected = client;
      await vi.waitFor(() => expect(connected.getLastEventId()).toBe(1));

      expect(getItem).not.toHaveBeenCalled();
      expect(setItem).not.toHaveBeenCalled();
    });
  });
});
