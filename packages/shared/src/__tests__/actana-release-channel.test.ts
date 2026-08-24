// The channel's shapes, and the line vocabulary ADR 0036 D6 puts beside them.
//
// The two are tested in one file on purpose: the point of D6 is that a
// `ReleaseChannel` — which repository, which hosts — and a *line* — `x.y.z`,
// resolving to its release or its beta — are different things that live next
// to each other, and a reader who sees them tested together is less likely to
// collapse them back into one.

import { describe, expect, it } from "vitest";
import {
  BETA_SUFFIX,
  betaVersionForLine,
  DEFAULT_API_BASE,
  DEFAULT_DOWNLOAD_BASE,
  DEFAULT_REPO,
  isBetaVersion,
  latestReleaseUrl,
  lineOf,
  parseLatestTag,
  releaseChannel,
  releaseTagUrl,
  resolveLine,
} from "../actana-release-channel";

describe("releaseChannel", () => {
  it("defaults to the public repository and GitHub's two hosts", () => {
    expect(releaseChannel({})).toEqual({
      repo: DEFAULT_REPO,
      apiBase: DEFAULT_API_BASE,
      downloadBase: DEFAULT_DOWNLOAD_BASE,
    });
  });

  it("points both hosts at one baseUrl, as install.sh's --base-url does", () => {
    expect(releaseChannel({ repo: "me/fork", baseUrl: "http://releases.test/" })).toEqual({
      repo: "me/fork",
      apiBase: "http://releases.test",
      downloadBase: "http://releases.test",
    });
  });
});

describe("release URLs", () => {
  const channel = releaseChannel({ baseUrl: "http://releases.test" });

  it("names the latest-release endpoint", () => {
    expect(latestReleaseUrl(channel)).toBe(
      "http://releases.test/repos/actana/control/releases/latest",
    );
  });

  it("names one release by its tag, release and beta alike", () => {
    expect(releaseTagUrl(channel, "0.4.1")).toBe(
      "http://releases.test/repos/actana/control/releases/tags/v0.4.1",
    );
    expect(releaseTagUrl(channel, "0.4.1-beta")).toBe(
      "http://releases.test/repos/actana/control/releases/tags/v0.4.1-beta",
    );
  });
});

describe("parseLatestTag", () => {
  it("reads the bare version out of a release payload", () => {
    expect(parseLatestTag(JSON.stringify({ tag_name: "v0.4.1" }))).toBe("0.4.1");
  });

  it("answers null for anything that is not a release", () => {
    expect(parseLatestTag("not json")).toBe(null);
    expect(parseLatestTag(JSON.stringify({ message: "Not Found" }))).toBe(null);
    expect(parseLatestTag(JSON.stringify({ tag_name: "" }))).toBe(null);
  });
});

describe("a line and its beta", () => {
  it("spells a line's beta as exactly x.y.z-beta", () => {
    expect(BETA_SUFFIX).toBe("-beta");
    expect(betaVersionForLine("0.4.1")).toBe("0.4.1-beta");
  });

  it("recognises a beta, and nothing else", () => {
    expect(isBetaVersion("0.4.1-beta")).toBe(true);
    expect(isBetaVersion("0.4.1")).toBe(false);
    // A counter is not a shape this project publishes (ADR 0036 D7 — the tag
    // moves per cut instead), so it is not a beta by this name either.
    expect(isBetaVersion("0.4.1-beta.1")).toBe(false);
    expect(isBetaVersion("-beta")).toBe(false);
  });

  it("reads a version back to the line it belongs to", () => {
    expect(lineOf("0.4.1-beta")).toBe("0.4.1");
    expect(lineOf("0.4.1")).toBe("0.4.1");
    expect(lineOf("v0.4.1-beta")).toBe("0.4.1");
    expect(lineOf("1.2.4-rc.1")).toBe("1.2.4");
  });
});

// ADR 0036 D2, step by step. The inputs are existence answers about two named
// tags and nothing else — there is no listing here to order or to mis-read.
describe("resolveLine", () => {
  it("takes an explicit pin over everything, and strips its v", () => {
    const pinned = { line: "0.4.1", releaseExists: true, betaExists: true };
    expect(resolveLine({ ...pinned, requested: "0.3.0" })).toEqual({
      kind: "pinned",
      version: "0.3.0",
    });
    expect(resolveLine({ ...pinned, requested: "v0.3.0" })).toEqual({
      kind: "pinned",
      version: "0.3.0",
    });
  });

  it("takes the line's release when that Release exists — main after promotion", () => {
    expect(resolveLine({ line: "0.4.1", releaseExists: true, betaExists: true })).toEqual({
      kind: "release",
      version: "0.4.1",
    });
  });

  it("takes the line's beta when only that exists — a train", () => {
    expect(resolveLine({ line: "0.4.1", releaseExists: false, betaExists: true })).toEqual({
      kind: "beta",
      version: "0.4.1-beta",
    });
  });

  it("falls back to /releases/latest for a line that has published nothing", () => {
    expect(resolveLine({ line: "0.4.1", releaseExists: false, betaExists: false })).toEqual({
      kind: "latest",
    });
  });

  // The rule is per line by construction: it is told about `v<line>` and
  // `v<line>-beta` and can never reach another line's beta, which is exactly
  // what enumerating releases newest-first across all lines would risk.
  it("never resolves to a version outside the line it was given", () => {
    for (const releaseExists of [true, false]) {
      for (const betaExists of [true, false]) {
        const resolved = resolveLine({ line: "0.4.1", releaseExists, betaExists });
        if (resolved.kind === "latest") continue;
        expect(lineOf(resolved.version)).toBe("0.4.1");
      }
    }
  });
});
