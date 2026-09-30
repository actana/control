import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CORE_LINK_PROTOCOL_VERSION, serializeCoreLinkFrame } from "../sdk-link-frames";

// `sdk-link-frames.ts` is safe in a browser only while the leaf it re-exports
// imports nothing. Pinned so an SDK update that changes that fails here.
describe("sdk-link-frames", () => {
  const leaf = path.resolve(import.meta.dirname, "../../node_modules/@actana/sdk/dist/core/link-frames.js");

  it("re-exports the frames", () => {
    expect(CORE_LINK_PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof serializeCoreLinkFrame).toBe("function");
  });

  it("re-exports a leaf with no imports of its own", () => {
    const source = fs.readFileSync(leaf, "utf8");
    const imports = source.split("\n").filter((line) => /^\s*(import\s|export\s.*\sfrom\s)/.test(line));
    expect(imports).toEqual([]);
  });
});
