// The daemon's shutdown handler logs `core.shutdown` before it tears anything
// down (issue 559). The image smoke stops the container and looks for that line,
// which is the only proof that tini forwarded SIGTERM to the daemon rather than
// the container simply ending. core-entry cannot be booted in a unit test, so this
// reads the source, the way the other guards in this folder do.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve(__dirname, "../core-entry.ts"), "utf8");

describe("the daemon's shutdown handler", () => {
  const start = source.indexOf("const shutdown = (signal: string) => {");
  const body = start < 0 ? "" : source.slice(start, source.indexOf("process.on(\"SIGINT\"", start));

  it("logs core.shutdown with the signal, before it kills anything", () => {
    expect(start).toBeGreaterThan(0);
    expect(body).toContain('log.info("core.shutdown", { signal })');
    expect(body.indexOf("core.shutdown")).toBeLessThan(body.indexOf("core.killAll()"));
  });

  it("exits 0, so `docker stop` is a clean exit", () => {
    expect(body).toContain("process.exit(0)");
  });

  it("is the handler for both SIGTERM and SIGINT", () => {
    expect(source).toContain('process.on("SIGTERM", () => shutdown("SIGTERM"))');
    expect(source).toContain('process.on("SIGINT", () => shutdown("SIGINT"))');
  });
});
