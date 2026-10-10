import { afterAll, describe, expect, it } from "vitest";

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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

// ── The `gate` type (#499, ADR 0023 D46) ─────────────────────────────────────
//
// A sub-train gate — `fix/... → beta/x.y.z-fN`, or `beta/x.y.z-fN →
// beta/x.y.z` — is titled `gate: …`, and PR #495 went red on `Conventions`
// for that alone. The fix is a commit type and not a second title-lint
// exemption, because a gate is squash-merged: the title becomes a commit on
// the train that the next pull request's `Lint commits in PR` reads, so an
// exemption would move the same red one pull request downstream. What has to
// hold is therefore the title *and* the commit it becomes, through the real
// commitlint and the real script, on both gate shapes — and that nothing
// about ordinary pull requests loosened.
describe("the gate type (#499, ADR 0023 D46)", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gate-499-"));
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const GATE_INTO_SUB_BETA = "gate: beta/0.4.5-f1 — prompt delivery and the send path";
  const MERGE_BACK = "gate: merge back beta/0.4.5-f3 into beta/0.4.5";

  /** The title step's exact pipe: `printf '%s' "$title" | sh scripts/check-conventions.sh message -`. */
  const lintTitle = (title) =>
    spawnSync("sh", [path.join(repoRoot, "scripts", "check-conventions.sh"), "message", "-"], {
      input: title,
      encoding: "utf8",
      cwd: repoRoot,
      timeout: 60_000,
    });

  it("is in the type-enum, once, and the list is otherwise what it was", () => {
    const types = config.rules["type-enum"][2];
    expect(types.filter((t) => t === "gate")).toEqual(["gate"]);
    expect(types.filter((t) => t !== "gate")).toEqual([
      "feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert",
    ]);
  });

  it.each([
    ["a gate into a -fN train", GATE_INTO_SUB_BETA],
    ["a -fN merge-back into its train", MERGE_BACK],
    ["a gate with a scope", "gate(0.4.5-f2): Pi as a first-class harness"],
  ])("passes %s's title through the title step's pipe", (_name, title) => {
    const run = lintTitle(title);
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  });

  it.each([
    ["the gate into the -fN train", GATE_INTO_SUB_BETA, 495],
    ["the merge-back", MERGE_BACK, 528],
  ])("passes the squash commit %s becomes through a range lint, as the next pull request's commit lint reads it", (_name, title, pr) => {
    // A squash's subject is the title plus ` (#NNN)` (COMMIT_OR_PR_TITLE), and
    // its body is the branch's commit messages (COMMIT_MESSAGES) — which, on a
    // merge-back, are the sub-train's gate squashes in turn.
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
    const repo = path.join(scratch, `range-${pr}`);
    fs.mkdirSync(repo);
    const git = (...args) => spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    git("init", "-b", "beta/0.4.5");
    git("commit", "--allow-empty", "-m", "chore: seed");
    const base = git("rev-parse", "HEAD").stdout.trim();
    const body = `* ${GATE_INTO_SUB_BETA} (#495)\n\n* fix(panel): a returning page reads the Session's current status (#488)`;
    git("commit", "--allow-empty", "-m", `${title} (#${pr})`, "-m", body);
    const head = git("rev-parse", "HEAD").stdout.trim();
    const run = spawnSync(
      path.join(repoRoot, "node_modules", ".bin", "commitlint"),
      ["--config", path.join(repoRoot, "commitlint.config.mjs"), "--cwd", repo, "--from", base, "--to", head],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  });

  it("still fails an ordinary title with a type outside the list, naming the list", () => {
    const run = lintTitle("wip: something half done");
    expect(run.status).toBe(1);
    expect(`${run.stdout}${run.stderr}`).toMatch(/type must be one of \[.*gate\]/);
  });

  it.each([
    ["an empty subject", "gate:"],
    ["an upper-case type", "Gate: beta/0.4.5-f1 — prompt delivery"],
    ["a trailing full stop", "gate: merge back beta/0.4.5-f1 into beta/0.4.5."],
  ])("holds a gate title to every other rule — %s fails", (_name, title) => {
    expect(lintTitle(title).status).toBe(1);
  });

  it("is a commit type and not a branch type", () => {
    const branch = spawnSync("sh", [path.join(repoRoot, "scripts", "check-conventions.sh"), "branch", "gate/0-4-5-f1"], {
      encoding: "utf8",
      cwd: repoRoot,
    });
    expect(branch.status).toBe(1);
    expect(branch.stderr).toContain("violates the convention");
  });

  it("the title lint in ci.yml is still skipped on the promotion alone — the rule lives here, not in a second exemption", () => {
    const ci = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const step = ci.slice(ci.indexOf("- name: Lint the PR title"), ci.indexOf("- name: Lint commits in PR"));
    const condition = /if: \$\{\{ (.+) \}\}/.exec(step);
    expect(condition).not.toBeNull();
    expect(condition[1]).toBe(
      "github.event_name == 'pull_request' && !(github.base_ref == 'main' && startsWith(github.head_ref, 'beta/'))",
    );
    expect(step).toContain("scripts/check-conventions.sh message -");
  });

  it("is stated where the branch conventions live", () => {
    const contributing = fs.readFileSync(path.join(repoRoot, "CONTRIBUTING.md"), "utf8");
    const commits = contributing.slice(contributing.indexOf("## Commits and PRs"));
    expect(commits).toContain("`gate` is for sub-train gate pull requests");
    expect(commits).toContain("#499");
    // The branch-type list in CONTRIBUTING.md is the script's, and has no `gate` in it.
    const allowed = /Allowed types: ([^.]+)\./.exec(contributing)[1].match(/`([a-z]+)`/g).map((t) => t.replaceAll("`", ""));
    const script = fs.readFileSync(path.join(repoRoot, "scripts/check-conventions.sh"), "utf8");
    expect(allowed).toEqual(/branch_types='([^']+)'/.exec(script)[1].split("|"));
    expect(allowed).not.toContain("gate");

    const cicd = fs.readFileSync(path.join(repoRoot, "docs/ci-cd.md"), "utf8");
    const subBeta = cicd.slice(cicd.indexOf("#### Taking a fix onto a frozen train"));
    expect(subBeta).toContain('--title "gate: merge back beta/0.4.5-f1 into beta/0.4.5"');
    expect(subBeta).toContain("`gate` is a commit type");

    const adr = fs.readFileSync(path.join(repoRoot, "docs/adr/0023-release-trains-and-digest-promotion.md"), "utf8");
    expect(adr).toContain("`gate` is a commit type.**");
  });
});
