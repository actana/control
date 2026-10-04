import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { harnessHomePathSuffixes } from "@actana/shared/harness-cli-config";

// #559: the image's login shells get the Harness directories from a root-owned
// /etc/profile.d file (the daemon does not write core's profile). The file is a
// copy of the registry's list and must not drift from it.

const deploy = path.resolve(__dirname, "../../../../deploy");

describe("deploy/core-harness-path.sh", () => {
  const script = fs.readFileSync(path.join(deploy, "core-harness-path.sh"), "utf8");
  const listed = [...script.matchAll(/for actana_dir in ([^;]+); do/g)][0]?.[1] ?? "";
  const dirs = [...listed.matchAll(/"\$HOME\/([^"]+)"/g)].map((match) => match[1]);

  it("lists exactly the directories the Harness registry installs into", () => {
    expect([...dirs].sort()).toEqual([...harnessHomePathSuffixes("linux")].sort());
  });

  it("puts .local/bin in front last, so it leads like a Session's PATH", () => {
    expect(dirs.at(-1)).toBe(".local/bin");
  });

  it("is installed by the Dockerfile as a root-owned profile.d file", () => {
    const dockerfile = fs.readFileSync(path.join(deploy, "core.Dockerfile"), "utf8");
    expect(dockerfile).toContain("COPY core-harness-path.sh /etc/profile.d/actana-harness-path.sh");
    expect(dockerfile).toMatch(/chown root:root \/etc\/profile\.d\/actana-harness-path\.sh/);
  });
});
