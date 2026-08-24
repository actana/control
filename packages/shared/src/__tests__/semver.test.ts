import { describe, expect, it } from "vitest";
import {
  isNewerSemver,
  isPrereleaseVersion,
  stripVersionPrefix,
  versionCore,
} from "../semver";

describe("stripVersionPrefix", () => {
  it("removes a leading v prefix", () => {
    expect(stripVersionPrefix("v1.2.3")).toBe("1.2.3");
    expect(stripVersionPrefix("V0.48.4")).toBe("0.48.4");
  });

  it("trims surrounding whitespace", () => {
    expect(stripVersionPrefix("  v1.0.0  ")).toBe("1.0.0");
  });
});

describe("versionCore", () => {
  it("drops prerelease and build suffixes", () => {
    expect(versionCore("v1.2.3-beta.1")).toBe("1.2.3");
    expect(versionCore("2026.05.20-2b5dd59")).toBe("2026.05.20");
    expect(versionCore("1.0.0+build.42")).toBe("1.0.0");
  });
});

describe("isPrereleaseVersion", () => {
  it("is true for a beta and for a release candidate", () => {
    expect(isPrereleaseVersion("0.4.1-beta")).toBe(true);
    expect(isPrereleaseVersion("v0.4.1-beta")).toBe(true);
    expect(isPrereleaseVersion("1.2.4-rc.1")).toBe(true);
  });

  it("is false for a release, and for anything that does not parse", () => {
    expect(isPrereleaseVersion("0.4.1")).toBe(false);
    expect(isPrereleaseVersion("v0.4.1")).toBe(false);
    expect(isPrereleaseVersion("not-a-version")).toBe(false);
    expect(isPrereleaseVersion("")).toBe(false);
  });
});

describe("isNewerSemver", () => {
  it("compares normalized semver triplets", () => {
    expect(isNewerSemver("v0.49.0", "0.48.4")).toBe(true);
    expect(isNewerSemver("0.48.4", "0.48.4")).toBe(false);
    expect(isNewerSemver("0.48.3", "0.48.4")).toBe(false);
  });

  // Every pair the ticket names, and only pairs that can actually occur: a beta
  // version is exactly `x.y.z-beta`, with no counter, no `.N` and no suffix
  // (ADR 0036 D1, D7 — the tag moves per cut, so the string never changes).
  describe("a beta and its line", () => {
    it("ranks a release above its own beta, and never the other way round", () => {
      expect(isNewerSemver("0.4.1", "0.4.1-beta")).toBe(true);
      expect(isNewerSemver("0.4.1-beta", "0.4.1")).toBe(false);
    });

    it("ranks a beta above the previous release — the downgrade this stops", () => {
      expect(isNewerSemver("0.4.1-beta", "0.4.0")).toBe(true);
      expect(isNewerSemver("0.4.0", "0.4.1-beta")).toBe(false);
    });

    it("still lets the next line's release win", () => {
      expect(isNewerSemver("0.4.2", "0.4.1-beta")).toBe(true);
    });

    // A beta tag is re-cut at a new commit on every beta cut of the line, and
    // the version string it publishes is the same one. Nothing in this
    // comparison may read that as an upgrade — the machine would reinstall on
    // every check, forever.
    it("does not call a re-cut beta newer than itself", () => {
      expect(isNewerSemver("0.4.1-beta", "0.4.1-beta")).toBe(false);
    });
  });

  // A `-beta` string has one identifier and no second field to compare, so the
  // numeric branch of §11.4 needs a shape that does. The backport release
  // candidate ADR 0023 D30 publishes is that shape.
  describe("numeric identifier precedence (semver §11.4)", () => {
    it("compares identifiers numerically rather than as strings", () => {
      expect(isNewerSemver("1.2.4-rc.2", "1.2.4-rc.10")).toBe(false);
      expect(isNewerSemver("1.2.4-rc.10", "1.2.4-rc.2")).toBe(true);
    });

    it("ranks a numeric identifier below an alphanumeric one", () => {
      expect(isNewerSemver("1.2.4-alpha", "1.2.4-1")).toBe(true);
      expect(isNewerSemver("1.2.4-1", "1.2.4-alpha")).toBe(false);
    });

    it("ranks a shorter run of otherwise equal identifiers lower", () => {
      expect(isNewerSemver("1.2.4-rc.2.1", "1.2.4-rc.2")).toBe(true);
      expect(isNewerSemver("1.2.4-rc.2", "1.2.4-rc.2.1")).toBe(false);
    });

    it("orders alphanumeric identifiers by ASCII", () => {
      expect(isNewerSemver("1.2.4-beta", "1.2.4-alpha")).toBe(true);
      expect(isNewerSemver("1.2.4-alpha", "1.2.4-beta")).toBe(false);
    });
  });

  // The answers this function has always given, kept: the prerelease clause is
  // an addition below the numeric comparison, not a replacement for it.
  describe("plain x.y.z pairs answer exactly as they did", () => {
    it("orders major, then minor, then patch", () => {
      expect(isNewerSemver("1.0.0", "0.99.99")).toBe(true);
      expect(isNewerSemver("0.99.99", "1.0.0")).toBe(false);
      expect(isNewerSemver("0.5.0", "0.4.99")).toBe(true);
      expect(isNewerSemver("0.4.99", "0.5.0")).toBe(false);
      expect(isNewerSemver("0.4.1", "0.4.0")).toBe(true);
      expect(isNewerSemver("0.4.0", "0.4.1")).toBe(false);
      expect(isNewerSemver("0.4.0", "0.4.0")).toBe(false);
    });

    it("compares components numerically, not as strings", () => {
      expect(isNewerSemver("0.10.0", "0.9.0")).toBe(true);
      expect(isNewerSemver("0.9.0", "0.10.0")).toBe(false);
    });

    it("ignores build metadata, as semver §10 says to", () => {
      expect(isNewerSemver("1.0.1+build.42", "1.0.0")).toBe(true);
      expect(isNewerSemver("1.0.0+build.42", "1.0.0")).toBe(false);
    });
  });

  describe("anything unparseable", () => {
    it("answers false rather than throwing", () => {
      expect(isNewerSemver("not-a-version", "0.4.0")).toBe(false);
      expect(isNewerSemver("0.4.0", "not-a-version")).toBe(false);
      expect(isNewerSemver("1.2", "1.1")).toBe(false);
      expect(isNewerSemver("1.2.3.4", "1.2.3")).toBe(false);
      expect(isNewerSemver("", "")).toBe(false);
      // The Panel and the daemon both call this on a background path; an
      // exception there would be a crash nobody asked for.
      expect(() => isNewerSemver(undefined as unknown as string, "0.4.0")).not.toThrow();
    });
  });
});
