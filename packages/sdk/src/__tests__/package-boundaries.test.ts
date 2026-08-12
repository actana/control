// The two boundaries this package is only useful if it keeps (issue 153).
//
// Both are traps rather than preferences, and both cost a debugging session
// rather than a lint warning when they break.

import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import { DurableCoreClient } from "../durable-core-client";
import { startCoreRig, type CoreRig } from "./fake-core-link";

const SRC = path.resolve(import.meta.dirname, "..");

/** Every shipped module — the package's own source, tests excluded. */
function shippedSources(): string[] {
  return readdirSync(SRC, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => path.join(SRC, e.name));
}

/**
 * Comments out, so prose is not read as code. These files carry a lot of it, and
 * a sentence like `tell "locked" from "gone"` is a perfectly good import
 * statement to a regex that never learned the difference.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("package boundaries", () => {
  it("imports nothing but its own modules and `ws`", () => {
    // `@actana/shared` is private and stays private (ADR 0025 D4), so an import
    // of it here would make the one package this effort exists to publish
    // unresolvable outside this repository. `@actana/core` is the *server* and
    // depends on this package (D2) — importing it back would be a cycle. Both
    // are available to the suites in this directory and to nothing else, which is
    // what the test-only aliases in `vitest.config.ts` are for.
    const offences: string[] = [];
    for (const file of shippedSources()) {
      const source = withoutComments(readFileSync(file, "utf8"));
      const specifiers = [...source.matchAll(/(?:^|[\s(])(?:from|import)\s*\(?\s*"([^"]+)"/gm)].map(
        (m) => m[1]!,
      );
      for (const specifier of specifiers) {
        const allowed = specifier.startsWith("./") || specifier.startsWith("../") || specifier === "ws";
        if (!allowed) offences.push(`${path.basename(file)} imports ${specifier}`);
      }
    }
    expect(offences).toEqual([]);
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
