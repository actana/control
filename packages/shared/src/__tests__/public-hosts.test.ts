import { describe, it, expect } from "vitest";
import {
  formatPublicHosts,
  isConfiguredPublicHost,
  parsePublicHosts,
  primaryPublicHost,
  samePublicHosts,
} from "../public-hosts";

// `ACTANA_PUBLIC_HOST` became a comma-separated list in #347. The rules this
// suite pins are the ones an operator can trip over from a compose file: a
// single value that must keep meaning exactly what it meant, spaces a human
// would write, and a doubled comma that must be refused rather than quietly
// read as a shorter list.

describe("parsePublicHosts", () => {
  // The compatibility promise of the whole ticket, at the layer that decides
  // it: a compose file that sets one host must not need editing, and every
  // downstream decision (the SAN, the endpoint, the primary) is taken from the
  // list this returns.
  it("reads a single value as a list of one", () => {
    expect(parsePublicHosts("core", "ACTANA_PUBLIC_HOST")).toEqual({ ok: true, hosts: ["core"] });
    expect(primaryPublicHost(["core"])).toBe("core");
  });

  it("splits a comma-separated list, first entry first", () => {
    expect(parsePublicHosts("core,10.0.0.5", "ACTANA_PUBLIC_HOST")).toEqual({
      ok: true,
      hosts: ["core", "10.0.0.5"],
    });
  });

  it("trims the whitespace around entries a human would type", () => {
    expect(parsePublicHosts(" core , 10.0.0.5 ", "ACTANA_PUBLIC_HOST")).toEqual({
      ok: true,
      hosts: ["core", "10.0.0.5"],
    });
  });

  it("collapses a repeated address, keeping its first position", () => {
    expect(parsePublicHosts("core,10.0.0.5,core", "ACTANA_PUBLIC_HOST")).toEqual({
      ok: true,
      hosts: ["core", "10.0.0.5"],
    });
  });

  // A doubled or trailing comma is a typo. Reading it as the shorter list it
  // resembles would mint a certificate the operator did not ask for and say
  // nothing about the entry they thought they had written.
  it("refuses an empty entry and names the variable", () => {
    const doubled = parsePublicHosts("core,,10.0.0.5", "ACTANA_PUBLIC_HOST");
    expect(doubled.ok).toBe(false);
    if (doubled.ok) throw new Error("unreachable");
    expect(doubled.error).toContain("ACTANA_PUBLIC_HOST");
    expect(doubled.error).toContain("empty entry");

    expect(parsePublicHosts("core,", "ACTANA_PUBLIC_HOST").ok).toBe(false);
    expect(parsePublicHosts(",core", "ACTANA_PUBLIC_HOST").ok).toBe(false);
    expect(parsePublicHosts("core, ,10.0.0.5", "ACTANA_PUBLIC_HOST").ok).toBe(false);
  });

  it("names whichever variable carried the value", () => {
    const flag = parsePublicHosts("core,,10.0.0.5", "--public-host");
    if (flag.ok) throw new Error("unreachable");
    expect(flag.error).toContain("--public-host");
    expect(flag.error).not.toContain("ACTANA_PUBLIC_HOST");
  });

  it("refuses a value that is nothing at all, and names the variable", () => {
    const blank = parsePublicHosts("   ", "ACTANA_PUBLIC_HOST");
    expect(blank.ok).toBe(false);
    if (blank.ok) throw new Error("unreachable");
    expect(blank.error).toContain("ACTANA_PUBLIC_HOST");
  });

  // No address has a space in it, so `core, my host` was meant to be three
  // entries or one — and either way it is not what it says.
  it("refuses whitespace inside an entry", () => {
    const spaced = parsePublicHosts("core,my host", "ACTANA_PUBLIC_HOST");
    expect(spaced.ok).toBe(false);
    if (spaced.ok) throw new Error("unreachable");
    expect(spaced.error).toContain("ACTANA_PUBLIC_HOST");
    expect(spaced.error).toContain("my host");
  });
});

describe("the primary", () => {
  it("is the first entry", () => {
    expect(primaryPublicHost(["core", "10.0.0.5"])).toBe("core");
  });

  // Never `undefined` in a `wss://${host}:${port}` template. An empty list is a
  // caller's bug, and a loopback Core is a far better answer to it than an
  // endpoint nobody can debug.
  it("falls back to localhost for an empty list", () => {
    expect(primaryPublicHost([])).toBe("localhost");
  });
});

describe("membership — what a pairing code may name", () => {
  it("accepts a configured host and refuses anything else", () => {
    expect(isConfiguredPublicHost(["core", "10.0.0.5"], "10.0.0.5")).toBe(true);
    expect(isConfiguredPublicHost(["core", "10.0.0.5"], "10.0.0.9")).toBe(false);
    expect(isConfiguredPublicHost([], "core")).toBe(false);
  });

  it("trims the candidate, because the configured list was trimmed too", () => {
    expect(isConfiguredPublicHost(["core"], "  core ")).toBe(true);
  });
});

describe("samePublicHosts", () => {
  it("is order-sensitive, because the first entry is the primary", () => {
    expect(samePublicHosts(["core", "10.0.0.5"], ["core", "10.0.0.5"])).toBe(true);
    // A reordered list is a Core whose endpoint changed, which is a move.
    expect(samePublicHosts(["core", "10.0.0.5"], ["10.0.0.5", "core"])).toBe(false);
    expect(samePublicHosts(["core"], ["core", "10.0.0.5"])).toBe(false);
  });
});

describe("formatPublicHosts", () => {
  // No space after the comma, and that is the whole assertion: everything this
  // prints is read by an operator who may paste it straight back, and
  // `--public-host core, 10.0.0.5` is two shell words of which the flag sees
  // one. A list this function printed has to be a list the flag accepts.
  it("renders a list an operator can paste back into the variable", () => {
    expect(formatPublicHosts(["core", "10.0.0.5"])).toBe("core,10.0.0.5");
    expect(formatPublicHosts(["core"])).toBe("core");
  });

  it("round-trips through the parser it is the inverse of", () => {
    const hosts = ["core", "10.0.0.5", "core.example.test"];
    expect(parsePublicHosts(formatPublicHosts(hosts), "--public-host")).toEqual({
      ok: true,
      hosts,
    });
  });
});
