// One version-precedence rule, implemented twice, pinned together here.
//
// `scripts/lib/release-latest.mjs` decides the tag ladder inside the release
// workflows; `packages/shared/src/semver.ts` decides what `actana update` and
// the in-product update check do on an operator's machine. They cannot share a
// file — the script half is plain `.mjs` that `node` runs in a workflow step
// with no build in front of it, and the TypeScript half is compiled into the
// Core tarball and the Panel bundle — so ADR 0036 D8's requirement that the
// version parsers agree is held by this test instead.
//
// This is the only suite that can see both: the root vitest project is the one
// that spans `scripts/**` and `packages/**`. If the two rules ever answer
// differently for any ordered pair below, this goes red and names the pair.

import { describe, expect, it } from "vitest";

import { compareReleaseVersions, isPrerelease } from "../lib/release-latest.mjs";
import { isNewerSemver, isPrereleaseVersion } from "../../packages/shared/src/semver.ts";

/**
 * The strings both halves accept, spanning every branch of §11.4 that either
 * one can reach.
 *
 * Deliberately bare and `+`-free: the script half rejects `+build` metadata
 * outright, because `+` is not a legal Docker tag character, while the product
 * half ignores it for precedence per semver §10. That is the one place the two
 * accepted domains differ by design, and it is asserted by name at the bottom
 * rather than left for this table to trip over.
 */
const VERSIONS = [
  "0.4.0",
  "0.4.1-beta",
  "0.4.1",
  "0.4.2-beta",
  "0.4.2",
  "0.5.0",
  "1.0.0",
  "1.2.4-alpha",
  "1.2.4-alpha.1",
  "1.2.4-rc.1",
  "1.2.4-rc.2",
  "1.2.4-rc.2.1",
  "1.2.4-rc.10",
  "1.2.4",
  "1.10.0",
  "2.0.0",
];

/** `isNewerSemver` read back as the `-1`/`0`/`1` the script half returns. */
const productSign = (a, b) => (isNewerSemver(a, b) ? 1 : isNewerSemver(b, a) ? -1 : 0);

describe("the two version rules agree (ADR 0036 D8)", () => {
  it("answers identically for every ordered pair", () => {
    const disagreements = [];
    for (const a of VERSIONS) {
      for (const b of VERSIONS) {
        const script = Math.sign(compareReleaseVersions(a, b));
        const product = productSign(a, b);
        if (script !== product) {
          disagreements.push(`${a} vs ${b}: release-latest ${script}, semver.ts ${product}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("agrees on which versions are prereleases", () => {
    for (const version of VERSIONS) {
      expect([version, isPrereleaseVersion(version)]).toEqual([version, isPrerelease(version)]);
    }
  });

  // The clause both bugs in #322 turned on, asserted on both halves rather
  // than only through the cross-product above, so a reader looking for it
  // finds it stated.
  it("puts a beta below its own line's release, on both sides", () => {
    expect(compareReleaseVersions("0.4.1-beta", "0.4.1")).toBe(-1);
    expect(isNewerSemver("0.4.1", "0.4.1-beta")).toBe(true);
    expect(isNewerSemver("0.4.1-beta", "0.4.1")).toBe(false);
  });

  // A guard on the guard: the cross-product only means something if a change
  // to either rule could actually move an answer in this table. Two versions
  // whose order is decided by each distinct branch, so no branch is untested.
  it("covers the branches a divergence would hide in", () => {
    // major/minor/patch, numerically rather than as strings
    expect(productSign("1.10.0", "1.2.4")).toBe(1);
    // prerelease below its own release
    expect(productSign("1.2.4-rc.1", "1.2.4")).toBe(-1);
    // numeric identifiers numerically
    expect(productSign("1.2.4-rc.2", "1.2.4-rc.10")).toBe(-1);
    // numeric identifier below alphanumeric
    expect(productSign("1.2.4-alpha", "1.2.4-rc.1")).toBe(-1);
    // a shorter run of otherwise equal identifiers is lower
    expect(productSign("1.2.4-rc.2", "1.2.4-rc.2.1")).toBe(-1);
  });
});

describe("where the two accepted domains differ, on purpose", () => {
  it("the script half rejects build metadata; the product half ignores it", () => {
    expect(() => compareReleaseVersions("1.0.0+build.42", "1.0.0")).toThrow(/not a version/);
    expect(isNewerSemver("1.0.0+build.42", "1.0.0")).toBe(false);
    expect(isNewerSemver("1.0.1+build.42", "1.0.0")).toBe(true);
  });

  it("the product half accepts a v prefix, and answers the same either way", () => {
    expect(isNewerSemver("v0.4.1", "0.4.1-beta")).toBe(true);
    expect(isNewerSemver("0.4.1", "v0.4.1-beta")).toBe(true);
  });

  // Unparseable throws on the script half — a release workflow wants to stop —
  // and answers `false` on the product half, because a background update check
  // has nowhere useful to put an exception.
  it("differs on how each half refuses a string neither can parse", () => {
    expect(() => compareReleaseVersions("nightly", "1.0.0")).toThrow(/not a version/);
    expect(isNewerSemver("nightly", "1.0.0")).toBe(false);
  });
});
