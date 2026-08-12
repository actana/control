// The `latest` guard (ADR 0023 D28), which is the one that reaches end users.
//
// `:latest` is a pointer with no history and `/releases/latest` is what
// `install.sh` installs by default. Move either of them backwards — publish
// `1.2.4` after `1.4.0` — and every 1.4.x user is told an older version is
// available, silently, with no red build anywhere. The bug is dormant until
// the first backport, which is precisely the release nobody wants to be
// improvising during.
//
// So the rule is tested here rather than exercised in CI, because exercising
// it in CI would mean cutting a real backport of a real old line. The claims
// below are the ones D28 makes:
//
//   * a backport is *structurally* incapable of emitting `latest` — not
//     "loses the comparison", but never reaches it, for any version and any
//     ladder including one where it would win
//   * the Docker tag list, the `gh release --latest` flag and the npm dist-tag
//     are one decision rendered three times and cannot drift apart
//   * a prerelease publishes its own version and nothing else (D30)
//   * `latest` follows an explicit highest-version test, which is the test the
//     old `tags="$version latest"` did not have

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertNeverLatest,
  compareReleaseVersions,
  isHighestRelease,
  npmDistTag,
  parseReleaseVersion,
  publishedVersionsFromTags,
  resolveReleaseTags,
} from "../lib/release-latest.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const LADDER = ["v1.0.0", "v1.2.3", "v1.3.0", "v1.4.0", "v1.5.0-rc.1"];

describe("backport mode is structurally incapable of emitting latest (D28)", () => {
  it("withholds latest from the backport that would otherwise move it backwards", () => {
    const decision = resolveReleaseTags({ mode: "backport", version: "1.2.4", published: LADDER });
    expect(decision.latest).toBe(false);
    expect(decision.tags).toEqual(["1.2.4"]);
    expect(decision.reason).toMatch(/backport/);
  });

  // The load-bearing one. A backport that *wins* the highest-version test —
  // there is no higher tag in the ladder at all — still publishes no `latest`,
  // which is what makes this structural rather than a comparison that happens
  // to come out right. If the mode check were reordered below the comparison,
  // every other test in this file would still pass and this one would fail.
  it("withholds latest even when the backport is the highest version there is", () => {
    const decision = resolveReleaseTags({
      mode: "backport",
      version: "9.9.9",
      published: ["v1.0.0"],
    });
    expect(isHighestRelease("9.9.9", ["v1.0.0"])).toBe(true);
    expect(decision.latest).toBe(false);
    expect(decision.tags).toEqual(["9.9.9"]);
  });

  // Every version against every ladder: no arrangement of the inputs, and no
  // bug in the comparison the mode check sits above, produces `latest`.
  it("emits no latest for any version against any ladder", () => {
    const versions = ["0.0.1", "1.2.4", "1.4.1", "1.5.0", "2.0.0", "9.9.9", "1.2.4-rc.1"];
    const ladders = [[], ["v1.4.0"], LADDER, ["v0.0.1"], ["v9.9.9", "v1.2.3"]];
    for (const version of versions) {
      for (const published of ladders) {
        const decision = resolveReleaseTags({ mode: "backport", version, published });
        expect(decision.latest, `${version} against [${published}]`).toBe(false);
        expect(decision.tags, `${version} against [${published}]`).toEqual([version]);
        // The third surface, held to the same standard: not "usually not
        // latest" but never, for any version against any ladder.
        expect(decision.npmTag, `${version} against [${published}]`).not.toBe("latest");
      }
    }
  });

  it("throws rather than publishes if a backport ever arrives carrying latest", () => {
    expect(() => assertNeverLatest({ mode: "backport", tags: ["1.2.4", "latest"], latest: true }))
      .toThrow(/never move `latest`/);
    // Any surface alone is enough to fail it: the tag list, the flag and the
    // dist-tag are checked independently, because a half-applied guard is the
    // failure this assertion exists to catch.
    expect(() => assertNeverLatest({ mode: "backport", tags: ["1.2.4"], latest: true })).toThrow();
    expect(() =>
      assertNeverLatest({ mode: "backport", tags: ["1.2.4", "latest"], latest: false }),
    ).toThrow();
    expect(() =>
      assertNeverLatest({ mode: "backport", tags: ["1.2.4"], latest: false, npmTag: "latest" }),
    ).toThrow(/npm i @actana\/sdk/);
    expect(() => assertNeverLatest({ mode: "backport", tags: ["1.2.4"], latest: false })).not.toThrow();
    expect(() =>
      assertNeverLatest({ mode: "backport", tags: ["1.2.4"], latest: false, npmTag: "release-1.2" }),
    ).not.toThrow();
    // Not a backport, not this assertion's business.
    expect(() =>
      assertNeverLatest({ mode: "promote", tags: ["1.4.0", "latest"], latest: true }),
    ).not.toThrow();
  });
});

// The third surface, added by #159. `npm publish` with no `--tag` takes
// `latest` — the same unwritten default as `gh release create`'s `make_latest`
// and the same one the old `resolve` had in its docker tag list. It differs in
// one way that shapes the function: a dist-tag is mandatory, so withholding
// `latest` means naming a replacement rather than passing nothing.
describe("the npm dist-tag is decided, never defaulted (D28, D30)", () => {
  it("gives latest to the release that moves latest, and to nothing else", () => {
    expect(resolveReleaseTags({ mode: "promote", version: "1.5.0", published: LADDER }).npmTag).toBe(
      "latest",
    );
    // Not the highest — a promote that loses the comparison is still not latest
    // on npm, which is the case a `mode === "backport"` shortcut would miss.
    expect(resolveReleaseTags({ mode: "promote", version: "1.3.0", published: LADDER }).npmTag).toBe(
      "release-1.3",
    );
  });

  it("puts a backport on its own line's tag rather than on latest", () => {
    const decision = resolveReleaseTags({ mode: "backport", version: "1.2.4", published: LADDER });
    expect(decision.npmTag).toBe("release-1.2");
    // Which is the point: `npm i @actana/sdk@release-1.2` is how somebody
    // pinned to that line gets the patch, and `npm i @actana/sdk` does not.
    expect(decision.npmTag).not.toBe("latest");
  });

  // A prerelease on main and an rc of an old line are not the same channel, and
  // `next` for both would put a backport's rc where a consumer tracking main's
  // prereleases would find it.
  it("separates a main-line prerelease from a backport's rc", () => {
    expect(
      resolveReleaseTags({ mode: "promote", version: "2.0.0-rc.1", published: LADDER }).npmTag,
    ).toBe("next");
    expect(
      resolveReleaseTags({ mode: "backport", version: "1.2.4-rc.1", published: LADDER }).npmTag,
    ).toBe("release-1.2-next");
  });

  // npm rejects a dist-tag that parses as a semver range, which would fail the
  // publish after both images had shipped. None of the three non-`latest`
  // names can: each starts with `release-` or is the bare word `next`.
  it("emits a name npm will accept, for every mode and every version", () => {
    const versions = ["0.0.1", "1.2.4", "1.4.1", "9.9.9", "1.2.4-rc.1", "2.0.0-beta.7"];
    for (const mode of ["promote", "backport"]) {
      for (const version of versions) {
        const tag = resolveReleaseTags({ mode, version, published: LADDER }).npmTag;
        expect(tag, `${mode} ${version}`).toMatch(/^(latest|next|release-\d+\.\d+(-next)?)$/);
        // A dist-tag npm reads as a version or a range is refused at publish.
        expect(parseReleaseVersion(tag), `${mode} ${version}`).toBeNull();
      }
    }
  });

  it("is a pure function of the decision, callable on its own", () => {
    expect(npmDistTag({ mode: "promote", version: "1.5.0", latest: true, prerelease: false })).toBe(
      "latest",
    );
    expect(npmDistTag({ mode: "backport", version: "0.1.5", latest: false, prerelease: false })).toBe(
      "release-0.1",
    );
    expect(() => npmDistTag({ mode: "promote", version: "not-a-version", latest: false })).toThrow(
      /not a version/,
    );
  });
});

describe("the highest-version test gates latest on both surfaces (D28)", () => {
  it("gives latest to a promotion that is the highest version", () => {
    const decision = resolveReleaseTags({ mode: "promote", version: "1.5.0", published: LADDER });
    expect(decision).toMatchObject({ latest: true, prerelease: false, tags: ["1.5.0", "latest"] });
  });

  it("gives latest to the very first release, whose ladder is empty", () => {
    expect(resolveReleaseTags({ mode: "promote", version: "0.1.0", published: [] }).latest).toBe(
      true,
    );
  });

  it("counts the release's own tag, which is pushed before the run (D40)", () => {
    // `v1.5.0` is already on origin by the time `resolve` reads the ladder.
    const decision = resolveReleaseTags({
      mode: "promote",
      version: "1.5.0",
      published: [...LADDER, "v1.5.0"],
    });
    expect(decision.latest).toBe(true);
  });

  it("withholds latest from a re-release of an older version", () => {
    const decision = resolveReleaseTags({ mode: "promote", version: "1.3.0", published: LADDER });
    expect(decision.latest).toBe(false);
    expect(decision.reason).toMatch(/not the highest/);
    expect(decision.reason).toContain("1.4.0");
  });

  it("ignores prereleases in the ladder — nobody runs an rc as their latest", () => {
    expect(isHighestRelease("1.4.1", ["v1.5.0-rc.1", "v1.4.0"])).toBe(true);
  });

  // The two surfaces are one boolean rendered twice. A tag list carrying
  // `latest` while the flag says false — or the reverse — is the drift D28
  // asks for the guard on both sides to prevent.
  it("keeps the docker tag and the gh release flag in agreement, always", () => {
    for (const mode of ["promote", "backport"]) {
      for (const version of ["1.2.4", "1.5.0", "2.0.0", "1.5.0-rc.1"]) {
        for (const published of [[], LADDER, ["v9.0.0"]]) {
          const decision = resolveReleaseTags({ mode, version, published });
          expect(decision.tags.includes("latest"), `${mode} ${version}`).toBe(decision.latest);
        }
      }
    }
  });
});

describe("prerelease tags publish their version and never move latest (D30)", () => {
  it("publishes 1.2.4-rc.1 under its own version only", () => {
    const decision = resolveReleaseTags({
      mode: "backport",
      version: "1.2.4-rc.1",
      published: LADDER,
    });
    expect(decision).toMatchObject({
      tags: ["1.2.4-rc.1"],
      latest: false,
      prerelease: true,
    });
  });

  // The rc path is a backport's first step (D30), but the prerelease rule is
  // its own: a promote-mode rc must not take `latest` either, and that holds
  // without the mode check doing the work.
  it("withholds latest from a prerelease promoted as the highest version", () => {
    const decision = resolveReleaseTags({ mode: "promote", version: "9.9.9-rc.1", published: [] });
    expect(decision.latest).toBe(false);
    expect(decision.prerelease).toBe(true);
    expect(decision.reason).toMatch(/prerelease/);
  });
});

describe("version parsing", () => {
  it("takes three components and an optional prerelease", () => {
    expect(parseReleaseVersion("1.2.4")).toEqual({
      major: 1,
      minor: 2,
      patch: 4,
      prerelease: null,
    });
    expect(parseReleaseVersion("1.2.4-rc.1")?.prerelease).toBe("rc.1");
  });

  it("rejects what has no Docker tag or would misread as a release", () => {
    // `+` is not legal in a Docker tag, and `1.0.0+abc` does not read as a
    // prerelease — it would move `:latest`.
    for (const bad of ["v1.2.4", "1.2", "1", "1.0.0+abc", "latest", "", null]) {
      expect(parseReleaseVersion(bad), String(bad)).toBeNull();
    }
    expect(() => resolveReleaseTags({ mode: "promote", version: "1.0.0+abc" })).toThrow(
      /not a release version/,
    );
  });

  it("rejects an unknown mode rather than guessing one", () => {
    expect(() => resolveReleaseTags({ mode: "hotfix", version: "1.0.0" })).toThrow(
      /unknown release mode/,
    );
  });

  it("orders versions by semver precedence, prereleases below their release", () => {
    const sorted = ["1.2.4", "1.2.4-rc.2", "1.10.0", "1.2.4-rc.1", "1.3.0", "2.0.0"].sort(
      compareReleaseVersions,
    );
    expect(sorted).toEqual(["1.2.4-rc.1", "1.2.4-rc.2", "1.2.4", "1.3.0", "1.10.0", "2.0.0"]);
  });

  it("reads the ladder as git prints it, dropping anything that is not a version", () => {
    expect(publishedVersionsFromTags(["v1.2.3", "", "  v1.3.0  ", "nightly", "v1.4"])).toEqual([
      "1.2.3",
      "1.3.0",
    ]);
    expect(publishedVersionsFromTags("v1.2.3\nv1.3.0\n")).toEqual(["1.2.3", "1.3.0"]);
  });
});

// The contract `release.yml` depends on: stdout is `key=value` lines and
// nothing else, because the step pipes it into `$GITHUB_OUTPUT`. A stray
// `console.log` here would write an arbitrary line into a job's outputs.
describe("the CLI's $GITHUB_OUTPUT contract", () => {
  const run = (args) =>
    execFileSync("node", [path.join(repoRoot, "scripts/release-tags.mjs"), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  it("prints only key=value lines on stdout", () => {
    const stdout = run(["--mode", "promote", "--version", "1.5.0", "--published", LADDER.join(" ")]);
    expect(stdout.split("\n").filter(Boolean)).toEqual([
      "mode=promote",
      "tags=1.5.0 latest",
      "latest=true",
      "prerelease=false",
      "npm_tag=latest",
    ]);
  });

  it("renders a backport with no latest on either surface", () => {
    const stdout = run([
      "--mode",
      "backport",
      "--version",
      "1.2.4",
      "--published",
      LADDER.join(" "),
    ]);
    expect(stdout).toContain("tags=1.2.4\n");
    expect(stdout).toContain("latest=false");
    expect(stdout).not.toContain("latest\n");
    // The third surface `release.yml` reads off this stdout. `npm_tag=latest`
    // here is the backport downgrade, delivered by `npm i`.
    expect(stdout).toContain("npm_tag=release-1.2\n");
    expect(stdout).not.toContain("npm_tag=latest");
  });

  it("exits non-zero rather than emitting a decision it could not make", () => {
    expect(() => run(["--mode", "promote", "--version", "1.2"])).toThrow();
    expect(() => run(["--mode", "sideways", "--version", "1.2.3"])).toThrow();
  });
});
