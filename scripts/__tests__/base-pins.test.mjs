import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DOCKERFILE_FILENAME_REGEX,
  NOT_COVERED,
  SHIPPED_DOCKERFILES,
  dockerUpdateDirectories,
  formatReport,
  isCovered,
  latestVersionForMajor,
  parseFromLines,
  readNodeVersionArg,
  setNodeVersionArg,
  splitImageRef,
  updateStrategyFor,
} from "../lib/base-pins.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

describe("splitImageRef", () => {
  it("splits a tag-and-digest reference", () => {
    expect(splitImageRef(`ubuntu:24.04@sha256:${"a".repeat(64)}`)).toEqual({
      registry: null,
      name: "ubuntu",
      tag: "24.04",
      digest: `sha256:${"a".repeat(64)}`,
    });
  });

  it("splits a tagless digest reference on a private registry", () => {
    expect(splitImageRef(`gcr.io/distroless/nodejs24@sha256:${"b".repeat(64)}`)).toEqual({
      registry: "gcr.io",
      name: "distroless/nodejs24",
      tag: null,
      digest: `sha256:${"b".repeat(64)}`,
    });
  });

  it("splits a bare tag reference", () => {
    expect(splitImageRef("node:24.15.0-trixie")).toEqual({
      registry: null,
      name: "node",
      tag: "24.15.0-trixie",
      digest: null,
    });
  });

  it("does not mistake a registry port for a tag", () => {
    expect(splitImageRef("localhost:5000/panel:edge")).toMatchObject({
      registry: "localhost:5000",
      name: "panel",
      tag: "edge",
    });
  });
});

describe("parseFromLines", () => {
  it("finds every stage, with its line number", () => {
    const text = [
      "# a comment mentioning FROM nowhere:1.0",
      "FROM node:24.15.0-trixie AS build",
      "RUN echo hi",
      `FROM --platform=$BUILDPLATFORM gcr.io/distroless/nodejs24@sha256:${"c".repeat(64)}`,
    ].join("\n");

    expect(parseFromLines(text)).toEqual([
      { line: 2, name: "node", registry: null, tag: "24.15.0-trixie", digest: null, stage: "build" },
      {
        line: 4,
        name: "distroless/nodejs24",
        registry: "gcr.io",
        tag: null,
        digest: `sha256:${"c".repeat(64)}`,
        stage: null,
      },
    ]);
  });

  it("ignores a FROM that is only mentioned in prose", () => {
    expect(parseFromLines("# DO NOT simplify this to FROM ubuntu:24.04\n")).toEqual([]);
  });
});

describe("updateStrategyFor", () => {
  // The three shapes matter because Dependabot resolves each from a different
  // place — see docker/lib/dependabot/docker/update_checker.rb.
  it("resolves a tagless digest pin from the `latest` tag", () => {
    const ref = { tag: null, digest: `sha256:${"d".repeat(64)}` };
    expect(updateStrategyFor(ref)).toEqual({ kind: "digest-only", resolvesFrom: "latest" });
  });

  it("resolves a tag-and-digest pin from its own tag", () => {
    const ref = { tag: "24.04", digest: `sha256:${"e".repeat(64)}` };
    expect(updateStrategyFor(ref)).toEqual({ kind: "tag-and-digest", resolvesFrom: "24.04" });
  });

  it("calls an unpinned tag what it is", () => {
    expect(updateStrategyFor({ tag: "24.04", digest: null })).toEqual({
      kind: "tag-only",
      resolvesFrom: "24.04",
    });
  });
});

describe("dockerUpdateDirectories", () => {
  it("reads the directory of every docker ecosystem entry", () => {
    const yaml = [
      "version: 2",
      "updates:",
      '  - package-ecosystem: "npm"',
      "    directories:",
      '      - "/"',
      '      - "/packages/*"',
      '  - package-ecosystem: "docker"',
      '    directory: "/deploy"',
      "    schedule:",
      '      interval: "weekly"',
    ].join("\n");

    expect(dockerUpdateDirectories(yaml)).toEqual(["/deploy"]);
  });

  it("reads a docker entry that uses the plural form", () => {
    const yaml = [
      "updates:",
      "  - package-ecosystem: docker",
      "    directories:",
      "      - /deploy",
      "      - /deploy/dev",
    ].join("\n");

    expect(dockerUpdateDirectories(yaml)).toEqual(["/deploy", "/deploy/dev"]);
  });

  it("is empty when nothing covers docker", () => {
    expect(dockerUpdateDirectories('updates:\n  - package-ecosystem: "npm"\n    directory: "/"\n')).toEqual(
      [],
    );
  });
});

describe("isCovered", () => {
  it("covers a Dockerfile sitting directly in a listed directory", () => {
    expect(isCovered(["/deploy"], "deploy/core.Dockerfile")).toBe(true);
  });

  it("does not cover a subdirectory — Dependabot does not recurse", () => {
    expect(isCovered(["/deploy"], "deploy/dev/core.Dockerfile")).toBe(false);
  });

  it("covers through a single-segment glob", () => {
    expect(isCovered(["/packages/*"], "packages/panel/Dockerfile")).toBe(true);
  });

  it("does not cover a file whose name Dependabot's fetcher would skip", () => {
    expect(isCovered(["/deploy"], "deploy/compose.yaml")).toBe(false);
  });
});

describe("latestVersionForMajor", () => {
  const index = [
    { version: "v25.0.0" },
    { version: "v24.19.0" },
    { version: "v24.9.0" },
    { version: "v24.18.1" },
    { version: "v23.11.0" },
  ];

  it("picks the highest release inside the major", () => {
    expect(latestVersionForMajor(index, 24)).toBe("24.19.0");
  });

  it("compares numerically, not lexically", () => {
    expect(latestVersionForMajor([{ version: "v24.9.0" }, { version: "v24.10.0" }], 24)).toBe("24.10.0");
  });

  it("returns null when the major has no releases", () => {
    expect(latestVersionForMajor(index, 26)).toBe(null);
  });
});

describe("the NODE_VERSION ARG", () => {
  const text = "FROM ubuntu:24.04\nARG NODE_VERSION=24.18.1\nRUN true\n";

  it("is read back with its line number", () => {
    expect(readNodeVersionArg(text)).toEqual({ version: "24.18.1", line: 2 });
  });

  it("is rewritten in place, touching nothing else", () => {
    expect(setNodeVersionArg(text, "24.19.0")).toBe(
      "FROM ubuntu:24.04\nARG NODE_VERSION=24.19.0\nRUN true\n",
    );
  });

  it("refuses to rewrite a file that has no such ARG", () => {
    expect(() => setNodeVersionArg("FROM ubuntu:24.04\n", "24.19.0")).toThrow(/NODE_VERSION/);
  });
});

describe("formatReport", () => {
  it("names the drifted rows and only those", () => {
    const report = formatReport([
      { label: "ubuntu:24.04", pinned: "sha256:aaa", upstream: "sha256:aaa" },
      { label: "NODE_VERSION", pinned: "24.18.1", upstream: "24.19.0" },
    ]);

    expect(report).toMatch(/ubuntu:24\.04/);
    expect(report).toMatch(/NODE_VERSION\b.*\n?.*24\.19\.0/s);
    expect(report).toMatch(/1 of 2/);
  });
});

// The rest of this file is the demonstration the ticket asks for: the pins in
// the repository, checked against the rules Dependabot actually applies,
// rather than a configuration nobody proved reaches them.
describe("the shipped Dockerfiles", () => {
  it("are all named something Dependabot's docker fetcher will pick up", () => {
    for (const file of SHIPPED_DOCKERFILES) {
      expect(path.basename(file)).toMatch(DOCKERFILE_FILENAME_REGEX);
    }
  });

  it("sit in a directory the docker ecosystem covers", () => {
    const directories = dockerUpdateDirectories(read(".github/dependabot.yml"));
    expect(directories.length).toBeGreaterThan(0);

    for (const file of SHIPPED_DOCKERFILES) {
      expect(isCovered(directories, file), `${file} is not covered by ${directories.join(", ")}`).toBe(
        true,
      );
    }
  });

  it("pin every base by digest, so a moved base is a diff and not a surprise", () => {
    for (const file of SHIPPED_DOCKERFILES) {
      for (const ref of parseFromLines(read(file))) {
        if (ref.stage === "build") continue; // the build stage ships nothing — see D20
        expect(ref.digest, `${file}:${ref.line} pins ${ref.name} without a digest`).toMatch(
          /^sha256:[0-9a-f]{64}$/,
        );
      }
    }
  });

  it("pin the Panel runtime tagless, which is what makes `latest` the thing Dependabot follows", () => {
    const runtime = parseFromLines(read("deploy/panel.Dockerfile")).at(-1);
    expect(runtime.registry).toBe("gcr.io");
    expect(updateStrategyFor(runtime)).toEqual({ kind: "digest-only", resolvesFrom: "latest" });
  });

  it("pin the Core base tag-and-digest, so the LTS line cannot move on its own", () => {
    const base = parseFromLines(read("deploy/core.Dockerfile"))[0];
    expect(base.name).toBe("ubuntu");
    expect(updateStrategyFor(base)).toEqual({ kind: "tag-and-digest", resolvesFrom: "24.04" });
  });

  it("carry a NODE_VERSION that no registry can bump for them", () => {
    expect(readNodeVersionArg(read("deploy/core.Dockerfile")).version).toMatch(/^24\.\d+\.\d+$/);
  });
});

describe("every other Dockerfile in the tree", () => {
  it("is either covered or listed with a reason", () => {
    // `git ls-files`, not a directory walk: it is the tracked set, which is
    // the set Dependabot sees, and it does not descend into node_modules.
    const found = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .filter((file) => DOCKERFILE_FILENAME_REGEX.test(path.basename(file)));

    expect(found.length).toBeGreaterThan(0);

    for (const file of found) {
      const accounted = SHIPPED_DOCKERFILES.includes(file) || file in NOT_COVERED;
      expect(accounted, `${file} is neither shipped nor listed in NOT_COVERED`).toBe(true);
    }
  });
});
