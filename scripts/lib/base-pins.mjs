// What pins the container images to, and who is responsible for moving each
// pin. ADR 0016 D5, D10, D20 and D26.
//
// Three inputs decide what OS and what Node end up inside a published image,
// and no single mechanism moves all three:
//
//   `ubuntu:24.04@sha256:…`               deploy/core.Dockerfile   Dependabot
//   `gcr.io/distroless/nodejs24@sha256:…` deploy/panel.Dockerfile  Dependabot
//   `ARG NODE_VERSION=…`                  deploy/core.Dockerfile   nobody, until now
//
// The last row is the one no registry can help with: it is a tarball fetched
// from nodejs.org (D8), so it is not an image reference and Dependabot's
// docker ecosystem cannot see it. It is bumped by scripts/check-base-pins.mjs,
// run weekly from base-pins.yml.
//
// What that bump does and does not buy, stated the way D10's own amendment
// corrects it: it collects Node's security fixes, and it does **not** clear
// the Core image's fixable CRITICAL/HIGH. Those live in the system Node's
// vendored npm tree, no released npm clears them, and D11's amendment scopes
// that path out of the gate. Anyone reading "bump Node to go green" here has
// been misled — the reason to stay current is Node itself.
//
// Everything here is pure so the rules can be tested against fixtures and
// against the repository's own files. The network lives in the CLI.
//
// ---------------------------------------------------------------------------
// The Dependabot behaviour encoded below is read off dependabot-core, not
// inferred from its documentation, because the documentation does not say what
// happens to a digest pin that carries no tag — and that is exactly the shape
// the Panel runtime has to use.
//
//   Which files it fetches   docker/lib/dependabot/docker/file_fetcher.rb
//                            `DOCKER_REGEXP = /dockerfile|containerfile/i`,
//                            matched against the *file name*, over the listed
//                            directory's own contents. It does not recurse.
//
//   What it updates them to  docker/lib/dependabot/docker/update_checker.rb,
//                            `updated_requirements`:
//
//                              if tag    → bump the tag, then re-resolve the
//                                          digest for whatever tag it landed on
//                              elsif digest → digest_of("latest")
//
// That second branch is why the two pins are written in different shapes —
// the argument for each shape is in docs/ci-cd.md § "The two digests are
// pinned in different shapes on purpose", and is not repeated here.

import * as path from "node:path";

/**
 * The names Dependabot's docker file fetcher recognises.
 *
 * Copied from `DOCKER_REGEXP` in dependabot-core. It is a substring match on
 * the file name, which is the reason `core.Dockerfile` and `panel.Dockerfile`
 * are picked up at all despite not being called `Dockerfile`.
 */
export const DOCKERFILE_FILENAME_REGEX = /dockerfile|containerfile/i;

/** The Dockerfiles that build a published image. Both must stay covered. */
export const SHIPPED_DOCKERFILES = ["deploy/core.Dockerfile", "deploy/panel.Dockerfile"];

/**
 * Dockerfiles deliberately left outside the docker ecosystem's directories,
 * each with the reason. A new entry here is a decision, not a build fix — the
 * test that reads this map exists so that adding a Dockerfile and forgetting
 * about its base is a red test rather than an image nobody updates.
 */
export const NOT_COVERED = {
  "deploy/dev/core.Dockerfile":
    "A local dev fixture, published nowhere, and deleted entirely by ADR 0016 D40. " +
    "Covering it would only produce PRs proposing Ubuntu's next LTS for a container " +
    "whose whole job is to imitate the 24.04 machine the installer e2es run against.",
};

/** The Node major the Core image installs. Bumping this is an ADR change (D8). */
export const NODE_MAJOR = 24;

/**
 * Split an image reference into its parts.
 *
 * The one subtlety is the port: `localhost:5000/panel` has a colon that is not
 * a tag separator. A colon introduces a tag only when nothing after it is a
 * path separator, which is the same rule the registry clients use.
 */
export function splitImageRef(ref) {
  let rest = ref;
  let digest = null;

  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }

  let tag = null;
  const colon = rest.lastIndexOf(":");
  if (colon !== -1 && !rest.slice(colon + 1).includes("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }

  let registry = null;
  const slash = rest.indexOf("/");
  if (slash !== -1) {
    const head = rest.slice(0, slash);
    if (head.includes(".") || head.includes(":") || head === "localhost") {
      registry = head;
      rest = rest.slice(slash + 1);
    }
  }

  return { registry, name: rest, tag, digest };
}

const FROM_LINE = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i;

/**
 * Every `FROM` in a Dockerfile, in order, with its 1-based line number.
 *
 * Anchored at the start of the line so a `FROM` inside one of this repo's
 * long explanatory comments is prose and not a dependency.
 */
export function parseFromLines(text) {
  const refs = [];

  text.split("\n").forEach((raw, index) => {
    const match = FROM_LINE.exec(raw);
    if (!match) return;

    refs.push({ line: index + 1, ...splitImageRef(match[1]), stage: match[2] ?? null });
  });

  return refs;
}

/**
 * How Dependabot will move this reference, and what it reads to decide.
 *
 * `resolvesFrom` is the tag whose digest becomes the new pin — literally
 * `"latest"` for a tagless digest, which is the whole reason this function
 * exists rather than a boolean.
 */
export function updateStrategyFor({ tag, digest }) {
  if (digest && !tag) return { kind: "digest-only", resolvesFrom: "latest" };
  if (digest) return { kind: "tag-and-digest", resolvesFrom: tag };
  return { kind: "tag-only", resolvesFrom: tag };
}

const ECOSYSTEM_LINE = /^(\s*)-\s*package-ecosystem:\s*["']?([\w-]+)["']?\s*$/;
const DIRECTORY_LINE = /^\s*directory:\s*["']?(\S+?)["']?\s*$/;
const DIRECTORIES_LINE = /^\s*directories:\s*$/;
const LIST_ITEM = /^\s*-\s*["']?(\S+?)["']?\s*$/;

/**
 * The directories every `docker` entry in a dependabot.yml covers.
 *
 * Hand-rolled rather than a YAML parse: this reads one file with one shape,
 * and the alternative is a dependency in the root manifest for a build script
 * that runs once a week. It understands both `directory:` and `directories:`
 * because the two are interchangeable in the config and a future edit may well
 * switch forms.
 */
export function dockerUpdateDirectories(yaml) {
  const lines = yaml.split("\n");
  const directories = [];

  let inDocker = false;
  let inList = false;

  for (const line of lines) {
    const ecosystem = ECOSYSTEM_LINE.exec(line);
    if (ecosystem) {
      inDocker = ecosystem[2] === "docker";
      inList = false;
      continue;
    }
    if (!inDocker) continue;

    if (DIRECTORIES_LINE.test(line)) {
      inList = true;
      continue;
    }

    const single = DIRECTORY_LINE.exec(line);
    if (single) {
      directories.push(single[1]);
      inList = false;
      continue;
    }

    if (inList) {
      const item = LIST_ITEM.exec(line);
      if (item) {
        directories.push(item[1]);
        continue;
      }
      inList = false;
    }
  }

  return directories;
}

/**
 * Would Dependabot fetch this repo-relative path under those directories?
 *
 * Two conditions, both of which have bitten real repositories: the file name
 * has to match the fetcher's regex, and the file has to be *directly* in a
 * listed directory. A `*` segment matches one path segment, as it does in the
 * config's own `directories` globs.
 */
export function isCovered(directories, filePath) {
  if (!DOCKERFILE_FILENAME_REGEX.test(path.basename(filePath))) return false;

  const parent = path.dirname(filePath).split(path.sep).filter((s) => s !== ".");

  return directories.some((directory) => {
    const pattern = directory.split("/").filter(Boolean);
    if (pattern.length !== parent.length) return false;
    return pattern.every((segment, i) => segment === "*" || segment === parent[i]);
  });
}

/** The highest release inside a major, from nodejs.org's index.json. */
export function latestVersionForMajor(index, major) {
  const versions = index
    .map((release) => release.version.replace(/^v/, ""))
    .filter((version) => Number(version.split(".")[0]) === major)
    .map((version) => version.split(".").map(Number));

  if (versions.length === 0) return null;

  versions.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  return versions[0].join(".");
}

const NODE_VERSION_ARG = /^ARG\s+NODE_VERSION=(\S+)\s*$/;

/** The `ARG NODE_VERSION=…` a Dockerfile declares, with its line number. */
export function readNodeVersionArg(text) {
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const match = NODE_VERSION_ARG.exec(lines[i]);
    if (match) return { version: match[1], line: i + 1 };
  }

  return null;
}

/**
 * Rewrite that ARG and nothing else.
 *
 * It throws rather than returning the text unchanged: the caller is an
 * automation that goes on to open a pull request, and a silent no-op there
 * looks exactly like "already up to date".
 */
export function setNodeVersionArg(text, version) {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => NODE_VERSION_ARG.test(line));

  if (at === -1) throw new Error("no `ARG NODE_VERSION=` line to rewrite");

  lines[at] = `ARG NODE_VERSION=${version}`;
  return lines.join("\n");
}

/** True when a row's pin no longer matches what upstream serves. */
export function hasDrifted({ pinned, upstream }) {
  return upstream != null && pinned !== upstream;
}

/**
 * A human-readable drift report. The count line is the part CI reads back to
 * the operator, so it says how many of how many rather than just listing.
 */
export function formatReport(rows) {
  const drifted = rows.filter(hasDrifted);
  const width = Math.max(...rows.map((row) => row.label.length));

  const body = rows.map((row) => {
    const mark = hasDrifted(row) ? "!" : "=";
    const detail = hasDrifted(row) ? `${row.pinned} → ${row.upstream}` : row.pinned;
    return `  ${mark} ${row.label.padEnd(width)}  ${detail}`;
  });

  return [
    ...body,
    "",
    `${drifted.length} of ${rows.length} pin${rows.length === 1 ? "" : "s"} have drifted.`,
  ].join("\n");
}
