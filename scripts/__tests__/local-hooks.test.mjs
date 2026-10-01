// #614 — a bad commit message or branch name is refused on the developer's
// machine, by the same script CI runs. Every case drives real git against a
// scratch clone, because the thing under test is what git does with the hook's
// exit code, and what lands on stderr where the developer reads it.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-614-"));
afterAll(() => fs.rmSync(scratchRoot, { recursive: true, force: true }));

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

const run = (cwd, cmd, args, input) =>
  spawnSync(cmd, args, { cwd, env, input, encoding: "utf8" });
const git = (cwd, ...args) => run(cwd, "git", args);

const GOOD = "chore(hooks): refuse bad commits locally\n\nWhy the change exists.\n\nRefs #614\n";
const LONG_LINE = "x".repeat(133);

let n = 0;
// A clone with the hooks and the shared script installed the way a fresh
// checkout has them, a bare remote to push to, and one good commit pushed.
const scratchClone = () => {
  n += 1;
  const dir = path.join(scratchRoot, `case-${n}`);
  const remote = path.join(dir, "remote.git");
  const work = path.join(dir, "work");
  fs.mkdirSync(work, { recursive: true });
  git(dir, "init", "--bare", "-b", "feat/0.5.0", remote);
  git(work, "init", "-b", "feat/0.5.0");
  for (const f of ["commitlint.config.mjs", "scripts/check-conventions.sh", ".husky/commit-msg", ".husky/pre-push"]) {
    fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, f), path.join(work, f));
    fs.chmodSync(path.join(work, f), 0o755);
  }
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(work, "node_modules"));
  git(work, "remote", "add", "origin", remote);
  fs.writeFileSync(path.join(work, "a.txt"), "a\n");
  git(work, "add", ".");
  // Hooks are off for the seed commit and the push: they are not what is tested.
  git(work, "commit", "--no-verify", "-m", "chore: seed");
  expect(git(work, "push", "--no-verify", "origin", "feat/0.5.0").status).toBe(0);
  git(work, "config", "core.hooksPath", ".husky");
  return { work, remote };
};

const commit = (work, message, ...extra) => {
  fs.appendFileSync(path.join(work, "a.txt"), `${Math.random()}\n`);
  git(work, "add", ".");
  fs.writeFileSync(path.join(work, "msg.txt"), message);
  return git(work, "commit", ...extra, "-F", "msg.txt");
};

const remoteRefs = (remote) => git(remote, "for-each-ref", "--format=%(refname:short)").stdout.trim().split("\n");

describe("commit-msg hook", () => {
  let c;
  beforeEach(() => {
    c = scratchClone();
  });

  it("accepts a conforming message", () => {
    const r = commit(c.work, GOOD);
    expect(r.status).toBe(0);
  });

  it("refuses a message that is not Conventional Commits, naming the rule on stderr", () => {
    const r = commit(c.work, "fixed some stuff\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("commit-msg: refused");
    expect(r.stderr).toContain("commitlint.config.mjs");
    expect(r.stderr).toMatch(/type may not be empty|subject may not be empty/);
  });

  it("refuses a type outside the allowed list", () => {
    const r = commit(c.work, "wip(core): half a thing\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("type must be one of");
  });

  it("refuses a body line over 132 characters", () => {
    const r = commit(c.work, `chore: ok subject\n\n${LONG_LINE}\n`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("body's lines must not be longer than 132");
  });

  it("accepts a body line of exactly 132 characters", () => {
    const r = commit(c.work, `chore: ok subject\n\n${"x".repeat(132)}\n`);
    expect(r.status).toBe(0);
  });

  it("refuses a footer jammed onto the body without a blank line", () => {
    const r = commit(c.work, "chore: ok subject\n\nA sentence of body.\nRefs #614\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("footer must have leading blank line");
  });

  it("does not mistake prose that ends in a colon for a footer", () => {
    const r = commit(c.work, "chore: ok subject\n\nA sentence that wraps onto\nthat: it is prose.\n");
    expect(r.status).toBe(0);
  });

  it("refuses when commitlint is not installed, and says how to fix it", () => {
    fs.rmSync(path.join(c.work, "node_modules"));
    const r = commit(c.work, GOOD);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("commitlint is not installed");
    expect(r.stderr).toContain("corepack pnpm install");
  });
});

describe("pre-push hook", () => {
  let c;
  beforeEach(() => {
    c = scratchClone();
  });

  const push = (branch) => git(c.work, "push", "origin", `HEAD:refs/heads/${branch}`);

  it("refuses a branch type outside the allowed list and pushes nothing", () => {
    commit(c.work, GOOD);
    const r = push("build/600-bad-type");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("pre-push: refused");
    expect(r.stderr).toContain("git branch -m");
    expect(remoteRefs(c.remote)).not.toContain("build/600-bad-type");
  });

  it.each(["Chore/614-upper", "chore/614--double", "chore/trail-", "just-a-name"])("refuses the branch name %s", (name) => {
    commit(c.work, GOOD);
    const r = push(name);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("violates the convention");
    expect(remoteRefs(c.remote)).not.toContain(name);
  });

  it.each(["chore/614-local-commit-hooks", "feat/0.5.0", "beta/0.5.0", "beta/0.5.0-f2", "dependabot/npm_and_yarn/x-1.2.3"])(
    "accepts the branch name %s",
    (name) => {
      commit(c.work, GOOD);
      const r = push(name);
      expect(r.status).toBe(0);
      expect(remoteRefs(c.remote)).toContain(name);
    },
  );

  it("refuses a new branch carrying a commit with a body line over 132 characters", () => {
    commit(c.work, GOOD);
    commit(c.work, `chore: late commit\n\n${LONG_LINE}\n`, "--no-verify");
    const r = push("chore/614-long-line");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("breaks the commit rules");
    expect(r.stderr).toContain("body's lines must not be longer than 132");
    expect(remoteRefs(c.remote)).not.toContain("chore/614-long-line");
  });

  it("refuses an update whose new commit has a footer in the wrong place, and leaves the remote where it was", () => {
    commit(c.work, GOOD);
    expect(push("chore/614-update").status).toBe(0);
    const before = git(c.remote, "rev-parse", "chore/614-update").stdout;
    commit(c.work, "chore: second\n\nBody text.\nCloses #614\n", "--no-verify");
    const r = push("chore/614-update");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("footer must have leading blank line");
    expect(git(c.remote, "rev-parse", "chore/614-update").stdout).toBe(before);
  });

  it("accepts an update whose new commits conform", () => {
    commit(c.work, GOOD);
    expect(push("chore/614-ok").status).toBe(0);
    commit(c.work, GOOD);
    expect(push("chore/614-ok").status).toBe(0);
  });

  it("lints the commits being pushed, not the ones already on the remote", () => {
    // A bad commit that is already on origin's feat/0.5.0 must not block a
    // branch that merely sits on top of it.
    commit(c.work, `chore: old\n\n${LONG_LINE}\n`, "--no-verify");
    expect(git(c.work, "push", "--no-verify", "origin", "feat/0.5.0").status).toBe(0);
    git(c.work, "fetch", "origin");
    commit(c.work, GOOD);
    expect(push("chore/614-on-top").status).toBe(0);
  });

  // The base gains a commit that breaks a rule (a squash that predates the
  // hooks, say) and the branch merges it in: the one way to update a branch
  // when force-push is not allowed. CI's base..head never holds that commit,
  // so the hook must not either.
  const baseGainsBadCommit = () => {
    git(c.work, "checkout", "-q", "feat/0.5.0");
    // Empty, so merging it into the branch cannot conflict with the branch's edits.
    git(c.work, "commit", "--no-verify", "--allow-empty", "-m", "chore: base commit", "-m", LONG_LINE);
    expect(git(c.work, "push", "--no-verify", "origin", "feat/0.5.0").status).toBe(0);
  };

  it("accepts a new branch that merged in a base commit that breaks a rule", () => {
    git(c.work, "checkout", "-q", "-b", "chore/614-merged-new");
    commit(c.work, GOOD);
    baseGainsBadCommit();
    git(c.work, "checkout", "-q", "chore/614-merged-new");
    expect(git(c.work, "merge", "--no-edit", "feat/0.5.0").status).toBe(0);
    const r = push("chore/614-merged-new");
    expect(r.status, r.stderr).toBe(0);
    expect(remoteRefs(c.remote)).toContain("chore/614-merged-new");
  });

  it("accepts an update that merged in a base commit that breaks a rule", () => {
    git(c.work, "checkout", "-q", "-b", "chore/614-merged-update");
    commit(c.work, GOOD);
    expect(push("chore/614-merged-update").status).toBe(0);
    baseGainsBadCommit();
    git(c.work, "checkout", "-q", "chore/614-merged-update");
    expect(git(c.work, "merge", "--no-edit", "feat/0.5.0").status).toBe(0);
    commit(c.work, GOOD);
    const r = push("chore/614-merged-update");
    expect(r.status, r.stderr).toBe(0);
  });

  it("still refuses the branch's own bad commit after the base was merged in", () => {
    git(c.work, "checkout", "-q", "-b", "chore/614-merged-bad");
    baseGainsBadCommit();
    git(c.work, "checkout", "-q", "chore/614-merged-bad");
    git(c.work, "merge", "--no-edit", "feat/0.5.0");
    commit(c.work, `chore: mine\n\n${LONG_LINE}\n`, "--no-verify");
    const r = push("chore/614-merged-bad");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("body's lines must not be longer than 132");
    expect(remoteRefs(c.remote)).not.toContain("chore/614-merged-bad");
  });

  it("does not check a branch deletion", () => {
    commit(c.work, GOOD);
    expect(push("chore/614-del").status).toBe(0);
    const r = git(c.work, "push", "origin", ":chore/614-del");
    expect(r.status).toBe(0);
  });
});

describe("check-conventions.sh branch", () => {
  const check = (name, extraEnv = {}) =>
    spawnSync("sh", [path.join(repoRoot, "scripts/check-conventions.sh"), "branch", name], {
      env: { ...env, ...extraEnv },
      encoding: "utf8",
    });

  it.each(["release/v1.4.0", "feat/proj-123-oauth-device-flow", "revert/abc"])("accepts %s", (name) => {
    expect(check(name).status).toBe(0);
  });

  it.each(["beta/0.5", "beta/0.5.0.1", "main", "feat/-lead", "feat/trail-", "docs/Upper"])("refuses %s on stderr with exit 1", (name) => {
    const r = check(name);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("violates the convention");
  });
});

describe("one rule source for local and CI", () => {
  const ci = fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const conventions = ci.slice(ci.indexOf("  conventions:"), ci.indexOf("  train-rules:"));

  it("the Conventions job runs the shared script for the title, the commits and the branch", () => {
    expect(conventions).toContain("scripts/check-conventions.sh message -");
    expect(conventions).toContain("check-conventions.sh)");
    expect(conventions).toContain('scripts/check-conventions.sh branch "$BRANCH"');
  });

  it("the Conventions job holds no rule of its own", () => {
    expect(conventions).not.toContain("PATTERN=");
    expect(conventions).not.toMatch(/node_modules\/\.bin\/commitlint"? *\\?\n *--config/);
  });

  it("both hooks call the shared script", () => {
    for (const hook of ["commit-msg", "pre-push"]) {
      expect(fs.readFileSync(path.join(repoRoot, ".husky", hook), "utf8")).toContain("scripts/check-conventions.sh");
    }
  });

  it("CI installs the commitlint version the repo pins", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    for (const dep of ["@commitlint/cli", "@commitlint/config-conventional"]) {
      expect(pkg.devDependencies[dep]).toMatch(/^\d+\.\d+\.\d+$/);
      expect(conventions).toContain(`devDependencies['${dep}']`);
    }
  });
});

describe("prepare script", () => {
  const prepare = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).scripts.prepare;

  it("points core.hooksPath at .husky in a git checkout", () => {
    const dir = path.join(scratchRoot, "prepare-git");
    fs.mkdirSync(dir);
    git(dir, "init");
    const r = run(dir, "sh", ["-c", prepare]);
    expect(r.status).toBe(0);
    expect(git(dir, "config", "core.hooksPath").stdout.trim()).toBe(".husky");
  });

  it("works in a linked worktree, where .git is a file", () => {
    const main = path.join(scratchRoot, "prepare-wt-main");
    fs.mkdirSync(main);
    git(main, "init", "-b", "main");
    git(main, "commit", "--allow-empty", "-m", "chore: seed");
    const wt = path.join(scratchRoot, "prepare-wt");
    git(main, "worktree", "add", "-b", "chore/x", wt);
    expect(run(wt, "sh", ["-c", prepare]).status).toBe(0);
    expect(git(wt, "config", "core.hooksPath").stdout.trim()).toBe(".husky");
  });

  it("succeeds silently where there is no .git, as in the image build", () => {
    const dir = path.join(scratchRoot, "prepare-nogit");
    fs.mkdirSync(dir);
    const r = run(dir, "sh", ["-c", prepare]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("succeeds where git itself is absent", () => {
    const dir = path.join(scratchRoot, "prepare-nogit-bin");
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    const r = spawnSync("/bin/sh", ["-c", prepare], { cwd: dir, env: { ...env, PATH: "/nonexistent" }, encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});
