// What pins the container images to, and who is responsible for moving each
// pin. ADR 0016 D5, D10, D20 and D26; ADR 0016 D10 as changed by #825.
//
// Three inputs decide what OS and what Node end up inside a published image,
// and no single mechanism moves all three:
//
//   `ubuntu:24.04@sha256:…`               deploy/core.Dockerfile   a person, by hand
//   `gcr.io/distroless/nodejs24@sha256:…` deploy/panel.Dockerfile  a person, by hand
//   `ARG NODE_VERSION=…`                  deploy/core.Dockerfile   the base-pins PR
//
// scripts/check-base-pins.mjs, run weekly from housekeeping.yml's `base-pins`
// job, resolves each pin against its upstream. A drifted digest becomes an
// issue a person acts on; no bot opens a pull request for it. The last row is
// the one no registry can help with: it is a tarball fetched from nodejs.org
// (D8), not an image reference, so the same job bumps it and opens the PR.
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
// Which tag a digest is resolved from is the rule the checker applies. It is
// the conventional rule of image-update tooling, and it is spelled out here
// because it is not documented for a digest pin that carries no tag:
//
//   if tag    → the tag's own digest
//   elsif digest → the digest of `latest`
//
// That second branch is why the two pins are written in different shapes —
// the argument for each shape is in docs/ci-cd.md § "The two digests are
// pinned in different shapes on purpose", and is not repeated here.

/** The Dockerfiles that build a published image. Both are checked. */
export const SHIPPED_DOCKERFILES = ["deploy/core.Dockerfile", "deploy/panel.Dockerfile"];

/** The Node major the Core image installs. Bumping this is an ADR change (D8). */
export const NODE_MAJOR = 24;

/**
 * Core base digests a *released* image was found pinning after the `24.04`
 * tag had moved on (#548). Each is the pin a promoted Core image shipped
 * with, keyed by the digest, with the point release it named and the report
 * that found it stale.
 *
 * A pin moves forward and never back: once a digest is here, a Dockerfile
 * that pins it again is a regression, not a choice. The weekly rebuild only
 * detects drift (ADR 0023 D42), so the fix for a row in this map is always a
 * forward bump in a patch release — which is what the test reading this map
 * holds the shipped Dockerfile to.
 */
export const RETIRED_CORE_BASE_DIGESTS = {
  "sha256:561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea": {
    tag: "noble-20260730.1",
    report: "#548 — pinned by core 0.4.5 after ubuntu:24.04 had moved to noble-20260911",
  },
};

const CORE_BASE_NOTE = /^#\s*ubuntu:24\.04\s*==\s*(\S+)\s+at the time of writing\.\s*$/;

/**
 * The point release the Core base digest was taken from, read from the note
 * the Dockerfile keeps on the line above its `FROM`.
 *
 * The digest alone says nothing a reader can date; the note is what lets
 * the next person see at a glance how far behind the tag the pin is. It has
 * to be *beside* the pin — a note elsewhere in the file is one nobody
 * updates with the digest. Returns `null` when there is no note, or when it
 * is not directly above the first `FROM`.
 */
export function readCoreBaseNote(text) {
  const lines = text.split("\n");
  const from = parseFromLines(text)[0];
  if (!from) return null;

  const match = CORE_BASE_NOTE.exec(lines[from.line - 2] ?? "");
  if (!match) return null;

  return { tag: match[1], line: from.line - 1 };
}

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
 * Which tag the checker resolves this reference's upstream digest from.
 *
 * `resolvesFrom` is the tag whose digest the pin is compared with — literally
 * `"latest"` for a tagless digest, which is the whole reason this function
 * exists rather than a boolean.
 */
export function updateStrategyFor({ tag, digest }) {
  if (digest && !tag) return { kind: "digest-only", resolvesFrom: "latest" };
  if (digest) return { kind: "tag-and-digest", resolvesFrom: tag };
  return { kind: "tag-only", resolvesFrom: tag };
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

// ---------------------------------------------------------------------------
// The Panel runtime pin (#733) — the distroless counterpart of #548's Core fix.

/**
 * Panel runtime digests a *released* image was found pinning after
 * `gcr.io/distroless/nodejs24:latest` had moved on. Each is the pin a
 * promoted Panel image shipped with, keyed by the digest, with the date the
 * drift was reported and the report that found it.
 *
 * Same rule as the Core map: a pin moves forward and never back. The weekly
 * rebuild only detects drift (ADR 0023 D42), so the fix for a row here is a
 * forward bump in a release, and the test reading this map holds the shipped
 * Dockerfile to that.
 */
export const RETIRED_PANEL_RUNTIME_DIGESTS = {
  "sha256:2e3b3a96d1d7286c3e4727f9c84b4dc32b6b33e7d7d4425c5a5c8186ad85fa93": {
    reported: "2026-08-24",
    report: "#312 / #733 — pinned by panel 0.3.3 through 0.4.5 after distroless/nodejs24:latest had moved",
  },
};

const PANEL_RUNTIME_NOTE =
  /^#\s*gcr\.io\/distroless\/nodejs24:latest\s*==\s*this digest on (\d{4}-\d{2}-\d{2})\.\s*$/;

/**
 * The date the Panel runtime digest was read off the `latest` tag, from the
 * note the Dockerfile keeps on the line above the runtime `FROM`.
 *
 * Distroless publishes no versioned tags (D20), so unlike the Core's
 * `noble-…` point release there is nothing else to date the pin by. The note
 * must sit directly above the pin so it is updated with it. Returns `null`
 * when there is no note, or no `FROM`.
 */
export function readPanelRuntimeNote(text) {
  const lines = text.split("\n");
  const runtime = parseFromLines(text).at(-1);
  if (!runtime) return null;

  const match = PANEL_RUNTIME_NOTE.exec(lines[runtime.line - 2] ?? "");
  if (!match) return null;

  return { date: match[1], line: runtime.line - 1 };
}
