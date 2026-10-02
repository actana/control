import { describe, expect, it } from "vitest";

import { spawnSync } from "node:child_process";
import * as path from "node:path";

import config, { LEGACY_LONG_HEADERS } from "../../commitlint.config.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/** Lint one message through the real commitlint, the way scripts/check-conventions.sh does. */
function lint(message) {
  return spawnSync(path.join(repoRoot, "node_modules", ".bin", "commitlint"), ["--config", path.join(repoRoot, "commitlint.config.mjs"), "--cwd", repoRoot], {
    input: message,
    encoding: "utf8",
    timeout: 60_000,
  });
}

const rule = config.plugins[0].rules["trailer-leading-blank"];
const check = (raw) => rule({ raw });

// The three PR #66 commits that failed CI with nothing wrong in them. Trimmed
// to the header plus the paragraph that tripped the stock rule — the offending
// line is the wrapped continuation of the sentence above it.
const PROSE_THAT_LOOKS_LIKE_A_FOOTER = [
  [
    "a body sentence wrapping onto `that:`",
    [
      "feat(core): container mode — the env contract and the verbs Docker owns",
      "",
      "Nothing reads `/.dockerenv`, and a walk over the package's sources guards",
      'that: it is absent under Podman and nerdctl, it answers "did some runtime',
      'start this?" rather than "is this our image?", and it is a path anyone can',
      "bind-mount into place.",
      "",
      "Refs #39",
    ],
  ],
  [
    "a body sentence wrapping onto `to:`",
    [
      "test(core-image): boot the image and assert what the operator contract owes",
      "",
      "A tarball install and an image install answer different questions end",
      "to: different arrival, different PID 1, different service management,",
      "and CI is what boots it.",
      "",
      "Co-Authored-By: Someone <someone@example.com>",
    ],
  ],
  [
    "a body sentence opening with a GitHub-style `issue #N`",
    [
      "build(panel): tighten the distroless image and gate it on CVEs",
      "",
      "The Panel image should carry no shell and no package manager, and",
      "issue #43 asked for exactly that, and a Panel that answers /api/healthz",
      "the measured figure is OS 174 -> 12.",
      "",
      "Co-Authored-By: Someone <someone@example.com>",
    ],
  ],
];

describe("trailer-leading-blank", () => {
  it.each(PROSE_THAT_LOOKS_LIKE_A_FOOTER)("passes %s", (_name, lines) => {
    expect(check(lines.join("\n"))).toEqual([true]);
  });

  it("passes a message with no footer at all", () => {
    expect(check("docs(readme): fix a typo\n\nOne paragraph, nothing else.")).toEqual([true]);
  });

  it("passes a properly separated footer block", () => {
    const raw = [
      "fix(core): stop the daemon before rewriting material",
      "",
      "The old identity stays live until the restart.",
      "",
      "Refs #39",
      "Co-authored-by: Someone <someone@example.com>",
    ].join("\n");
    expect(check(raw)).toEqual([true]);
  });

  it("passes a properly separated BREAKING CHANGE footer", () => {
    const raw = [
      "feat(core)!: require ACTANA_PUBLIC_HOST",
      "",
      "The guessed host lands in the cert SAN.",
      "",
      "BREAKING CHANGE: set ACTANA_PUBLIC_HOST before starting the container.",
    ].join("\n");
    expect(check(raw)).toEqual([true]);
  });

  it("fails a `Refs #N` footer jammed onto the body", () => {
    const raw = [
      "fix(core): stop the daemon before rewriting material",
      "",
      "The old identity stays live until the restart.",
      "Refs #39",
    ].join("\n");
    const [ok, message] = check(raw);
    expect(ok).toBe(false);
    expect(message).toContain("Refs #39");
  });

  it("fails a `Co-authored-by:` trailer jammed onto the body", () => {
    const raw = [
      "fix(core): stop the daemon before rewriting material",
      "",
      "The old identity stays live until the restart.",
      "Co-authored-by: Someone <someone@example.com>",
    ].join("\n");
    expect(check(raw)[0]).toBe(false);
  });

  it("fails a `BREAKING CHANGE:` footer jammed onto the body", () => {
    const raw = [
      "feat(core)!: require ACTANA_PUBLIC_HOST",
      "",
      "The guessed host lands in the cert SAN.",
      "BREAKING CHANGE: set ACTANA_PUBLIC_HOST before starting the container.",
    ].join("\n");
    expect(check(raw)[0]).toBe(false);
  });

  it("leaves a trailer token alone when it opens a sentence rather than a trailer", () => {
    const raw = [
      "fix(core): survive a missing /.dockerenv",
      "",
      "The detection walked the wrong path under Podman, so it never fired.",
      "Fixes the crash by reading the baked ACTANA_CONTAINER instead.",
    ].join("\n");
    expect(check(raw)).toEqual([true]);
  });
});

describe("commitlint config wiring", () => {
  it("keeps the stock footer-leading-blank off so the two cannot both fire", () => {
    expect(config.rules["footer-leading-blank"]).toEqual([0]);
  });

  it("enforces the replacement at error level", () => {
    expect(config.rules["trailer-leading-blank"]).toEqual([2, "always"]);
  });
});

describe("the header length limit and its two legacy exemptions (#552)", () => {
  it("is still 120: the limit was not raised to make room for them", () => {
    expect(config.rules["header-max-length"]).toEqual([2, "always", 120]);
  });

  it("exempts exactly the two merged squash commits 87daa0a and 79b752a, and nothing else", () => {
    expect(LEGACY_LONG_HEADERS.map(({ sha }) => sha)).toEqual(["87daa0a", "79b752a"]);
    expect(LEGACY_LONG_HEADERS.map(({ header }) => header.length)).toEqual([125, 122]);
    for (const { header } of LEGACY_LONG_HEADERS) expect(header.length).toBeGreaterThan(120);
  });

  it.each(LEGACY_LONG_HEADERS.map(({ sha, header }) => [sha, header]))("passes %s's header through commitlint", (_sha, header) => {
    const run = lint(`${header}\n\nBody.\n\nRefs #580`);
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  });

  it("still fails a new header over 120 characters, with the length named", () => {
    const header = `feat(ci): ${"a long subject that nobody shortened ".repeat(4)}(#999)`;
    expect(header.length).toBeGreaterThan(120);
    const run = lint(`${header}\n\nRefs #580`);
    expect(run.status).toBe(1);
    expect(`${run.stdout}${run.stderr}`).toMatch(/header must not be longer than 120 characters/);
  });

  it("still fails a header that only starts like an exempt one", () => {
    const [{ header }] = LEGACY_LONG_HEADERS;
    const run = lint(`${header} and then some more words\n\nRefs #580`);
    expect(run.status).toBe(1);
    expect(`${run.stdout}${run.stderr}`).toMatch(/header must not be longer than 120 characters/);
  });
});
