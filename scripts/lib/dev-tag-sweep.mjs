// What the `-dev` tag sweep is allowed to delete, and why (ADR 0023 D45, and
// D38 — *the delete-capable credential*, the first of the two clauses numbered
// D38).
//
// Docker Hub has no automatic tag garbage collection and no undelete. This
// module is the whole decision — which repository may be swept, which tag
// names are recognised, and which of those are stale — kept pure and away from
// the network so every branch of it is testable. `scripts/sweep-dev-tags.mjs`
// does the HTTP and nothing else.
//
// ── The guard, and why it is the only one ────────────────────────────────────
//
// ADR 0023 D38 specified *two* independent guards on the delete credential: a
// token scoped to the two `-dev` repositories, plus a hard-coded allowlist
// here. The first is not available. Docker Hub personal access tokens carry an
// account-wide permission level, not a repository list; per-repository scoping
// needs an Organization Access Token on a Team or Business plan, and
// `container-image.yml` already documents that OATs cannot authenticate
// against the description API — so the account needs a PAT regardless.
//
// `DOCKERHUB_CLEANUP_TOKEN` can therefore delete from `actana/panel` and
// `actana/core` as well, and **this list is the only thing that stops it.**
// That is why the checks below are shaped the way they are:
//
//   * exact string equality, never a glob or a prefix — `panel*` matches
//     `panel` as happily as `panel-dev`
//   * an empty or missing list refuses to run rather than defaulting to
//     "everything"; a sweep that deletes nothing is a bad config, a sweep that
//     deletes anything is an incident
//   * the caller re-asserts it immediately before *every* delete call, not
//     once at startup, so a repository reaching the delete path by any route —
//     a later edit, a merged loop, a copied helper — is still checked
//
// ── The tag namespace ────────────────────────────────────────────────────────
//
// Three classes live in `panel-dev` / `core-dev`, and each is matched by a
// regex anchored at both ends rather than by a prefix. A bare `pr-`/`sha-`
// prefix test would be fine today and catastrophic the day someone pushes a
// release-shaped tag into a `-dev` repository by mistake; anchoring means an
// unrecognised name is *skipped and reported*, which is the safe default.
//
//   pr-<number><YYYYMM>   the PR image (D10). Moves per push; the month suffix
//                         is fixed-width so the PR id parses from the right.
//   pr-<number>-<arch>    per-architecture build scaffolding (D12), left
//                         behind by container-image.yml's manifest stitch.
//   sha-<short>           the immutable commit pin published on a train merge
//                         (D11).
//
// Anything else — `latest`, `0.1.0`, `beta-0.1.0`, a hand-pushed experiment —
// is not this sweep's to delete.

/**
 * The repositories this sweep may touch. Literal, exact-match, and short on
 * purpose: it is the safety boundary, not a convenience default.
 *
 * Repository *names* rather than `namespace/name` pairs, because the namespace
 * is a repository variable a fork can change while these two names are fixed
 * by D36. The release repositories are `panel` and `core`, which cannot equal
 * either of these under string equality.
 */
export const SWEEPABLE_REPOSITORIES = ["panel-dev", "core-dev"];

/** How long a tag nobody is using is kept before it is swept. */
export const DEFAULT_MAX_AGE_DAYS = 30;

/** The architectures container-image.yml builds, and so the scaffolding suffixes. */
export const ARCHITECTURES = ["amd64", "arm64"];

const PR_IMAGE_TAG = /^pr-([1-9]\d*)(20\d{2})(0[1-9]|1[0-2])$/;
const PR_SCAFFOLD_TAG = new RegExp(`^pr-([1-9]\\d*)-(${ARCHITECTURES.join("|")})$`);
const SHA_TAG = /^sha-[0-9a-f]{7,40}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Refuse to act on a repository that is not on the list.
 *
 * Throws rather than returning false: a caller that forgets to check a boolean
 * still deletes, and the whole point of this function is that forgetting is
 * not survivable. Every rejection path names the repository, so the log says
 * what was refused rather than only that something was.
 */
export function assertSweepable(repository, allowlist = SWEEPABLE_REPOSITORIES) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    throw new Error(
      "the sweep allowlist is empty or unset — refusing to run. " +
        "A sweep that deletes nothing is a configuration mistake; one that deletes anything is an incident.",
    );
  }
  if (!allowlist.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new Error("the sweep allowlist must be a list of non-empty repository names");
  }
  if (typeof repository !== "string" || repository.length === 0) {
    throw new Error("refusing to sweep an unnamed repository");
  }
  // Exact equality. Not `startsWith`, not a glob, not a regex — `panel` must
  // never be reachable from a list that contains `panel-dev`.
  if (!allowlist.includes(repository)) {
    throw new Error(
      `refusing to sweep '${repository}': it is not one of ${allowlist.join(", ")}. ` +
        "DOCKERHUB_CLEANUP_TOKEN can delete from the release repositories too, and this list is the only guard.",
    );
  }
  return repository;
}

/**
 * What kind of tag this name is, if any.
 *
 * `kind` is `"unrecognised"` rather than `null` so a caller cannot accidentally
 * treat "we do not know what this is" as falsy-therefore-sweepable.
 */
export function classifyTag(name) {
  const image = PR_IMAGE_TAG.exec(name);
  if (image) {
    return {
      kind: "pr-image",
      pullRequest: Number(image[1]),
      yearMonth: `${image[2]}${image[3]}`,
    };
  }

  const scaffold = PR_SCAFFOLD_TAG.exec(name);
  if (scaffold) {
    return { kind: "pr-scaffold", pullRequest: Number(scaffold[1]), arch: scaffold[2] };
  }

  if (SHA_TAG.test(name)) return { kind: "sha" };

  return { kind: "unrecognised" };
}

/** The `YYYYMM` a `pr-` tag pushed at this instant would carry, in UTC. */
export function yearMonthOf(date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function ageInDays(lastUpdated, now) {
  if (!lastUpdated) return null;
  const at = Date.parse(lastUpdated);
  if (Number.isNaN(at)) return null;
  return (now.getTime() - at) / DAY_MS;
}

/**
 * Delete this tag, or keep it, and say which and why.
 *
 * `openPullRequests` is the set of PR numbers currently open. It is required
 * rather than optional: "we could not list the pull requests" must not read as
 * "every pull request is closed", which is how a sweep deletes the images of
 * every open review at once.
 */
export function decideTag(tag, { openPullRequests, now, maxAgeDays = DEFAULT_MAX_AGE_DAYS }) {
  if (!(openPullRequests instanceof Set)) {
    throw new Error("decideTag needs the set of open pull request numbers");
  }

  const classification = classifyTag(tag.name);
  const age = ageInDays(tag.lastUpdated, now);
  const stale = age !== null && age > maxAgeDays;
  const aged = age === null ? "age unknown" : `${age.toFixed(0)}d old`;

  const keep = (reason) => ({ ...classification, name: tag.name, delete: false, reason });
  const remove = (reason) => ({ ...classification, name: tag.name, delete: true, reason });

  switch (classification.kind) {
    case "pr-image": {
      if (!openPullRequests.has(classification.pullRequest)) {
        return remove(`PR #${classification.pullRequest} is closed`);
      }
      // The previous month's tag for a pull request open across a boundary
      // (D10). It is dead the moment the month rolls: the next push publishes
      // `pr-<number><thisMonth>` and nothing points at the old name again.
      if (classification.yearMonth !== yearMonthOf(now)) {
        return remove(
          `PR #${classification.pullRequest} is open but this is ${classification.yearMonth}, not ${yearMonthOf(now)}`,
        );
      }
      if (stale) return remove(`${aged}`);
      return keep(`PR #${classification.pullRequest} is open, ${aged}`);
    }

    case "pr-scaffold": {
      if (!openPullRequests.has(classification.pullRequest)) {
        return remove(`build scaffolding, PR #${classification.pullRequest} is closed`);
      }
      // An open PR's scaffolding is left alone until it goes stale: it is
      // rewritten by every push, and deleting one mid-stitch would break the
      // manifest the run is assembling.
      if (stale) return remove(`build scaffolding, ${aged}`);
      return keep(`build scaffolding for open PR #${classification.pullRequest}, ${aged}`);
    }

    case "sha": {
      if (age === null) return keep("commit pin, age unknown");
      return stale ? remove(`commit pin, ${aged}`) : keep(`commit pin, ${aged}`);
    }

    default:
      // Not a name this sweep publishes, so not a name this sweep deletes.
      return keep("not a tag class this sweep owns");
  }
}

/**
 * The full decision for one repository: what goes, what stays, and why for
 * each.
 *
 * Both halves are returned rather than only the deletions, because a sweep
 * that reports only what it removed is indistinguishable from one whose tag
 * listing was silently truncated — "nothing to do" and "we never looked" print
 * the same.
 */
export function planSweep({ repository, tags, openPullRequests, now, maxAgeDays, allowlist }) {
  assertSweepable(repository, allowlist);

  const decisions = tags.map((tag) => decideTag(tag, { openPullRequests, now, maxAgeDays }));

  return {
    repository,
    deletes: decisions.filter((decision) => decision.delete),
    skips: decisions.filter((decision) => !decision.delete),
    considered: decisions.length,
  };
}

/** The log a person reads on a Monday: every tag, its verdict, and the reason. */
export function formatPlan(plan, { dryRun = false } = {}) {
  const verb = dryRun ? "would delete" : "deleted";
  const lines = [
    `${plan.repository}: ${plan.considered} tag(s) considered, ` +
      `${plan.deletes.length} ${verb}, ${plan.skips.length} kept`,
  ];
  for (const decision of plan.deletes) lines.push(`  - ${decision.name}  (${decision.reason})`);
  for (const decision of plan.skips) lines.push(`  = ${decision.name}  (${decision.reason})`);
  return lines.join("\n");
}
