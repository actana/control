import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The Panel's container release surface as data: where the deploy assets
 * live, the constants the assets must agree on, and fact extractors over the
 * Dockerfile / compose file so tests (and the smoke script) assert invariants
 * against parsed structure instead of grepping raw text in five places.
 *
 * The extractors are deliberately shaped to the files we author here — a
 * strict two-space-indented compose file, a plain Dockerfile — not general
 * parsers. If the files grow beyond that shape, grow the extractor with them.
 */

export const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/** Where `docker compose up` serves the Panel and the proxy dials it. */
export const PANEL_PORT = 7420;

/**
 * The Panel image's Dockerfile, repo-relative. It lives in `deploy/` beside
 * the Core's rather than at the repo root: two container images should not
 * mean finding one at the root and one two directories down. The build
 * context stays the repo root — only the file moved.
 */
export const PANEL_DOCKERFILE = "deploy/panel.Dockerfile";

/**
 * The published image, tag-less. The compose file pins `:latest`, the release
 * workflow pushes the version tag and `latest`, and the smoke script builds a
 * local tag — all against this one name.
 */
export const PANEL_IMAGE = "actana/panel";

/** The single directory inside the container that must be a mounted volume. */
export const PANEL_DATA_DIR = "/data";

/**
 * The uid:gid the Panel container runs as, and the owner `/data` is copied in
 * with (ADR 0016 D21). 65532 is distroless's `nonroot`, which every variant
 * carries in `/etc/passwd` — so the default tag drops privilege without
 * needing `:nonroot`. Numeric rather than a name because Kubernetes'
 * `runAsNonRoot` admission check cannot resolve a username and fails the pod
 * rather than the check.
 */
export const PANEL_RUNTIME_USER = "65532:65532";

/**
 * Where node lives in the distroless runtime, absolutely. It is the image's
 * ENTRYPOINT, so nothing that goes *through* the entrypoint needs it — but
 * anything with its own argv does, because `/nodejs/bin` is not on `PATH`
 * and a bare `node` is simply not found (ADR 0016 D23). The healthcheck and
 * every `docker exec` into this image are the argv cases.
 */
export const PANEL_NODE_BIN = "/nodejs/bin/node";

/**
 * Every table `panel-db.ts` migrates into `<data dir>/panel.db`. The smoke
 * script reads them back out of a real container to prove that better-sqlite3
 * — compiled in the build stage, against a different Node and a different
 * glibc — actually loads under the distroless runtime. A booted Panel that
 * answers `/api/healthz` does not prove that; a migrated schema does.
 */
export const PANEL_TABLES = Object.freeze([
  "operator",
  "panel_sessions",
  "cores",
  "core_secrets",
]);

/** The Core's default core-link port — `EXPOSE` and `ACTANA_PORT` share it. */
export const CORE_PORT = 8443;

/**
 * The published Core image, tag-less — the counterpart to `PANEL_IMAGE`. The
 * reference compose pulls `:latest` so a clean checkout brings the pair up
 * without building either one.
 */
export const CORE_IMAGE = "actana/core";

/** Where the Core image extracts the release tarball (ADR 0016 D13). */
export const CORE_APP_ROOT = "/opt/actana";

/** The single directory the Core image keeps all of its state under (D19). */
export const CORE_HOME = "/home/core";

/**
 * The lifecycle verbs the image owns, which refuse in a container and name the
 * Docker command that does the same job instead (ADR 0016 D16).
 *
 * A copy of `DOCKER_EQUIVALENT`'s keys in
 * `packages/core/src/actana-container.ts`, and deliberately a copy: the image
 * smoke runs `actana <verb>` inside a container and cannot import the Core's
 * TypeScript. The list is held to the original by a test, so a verb added
 * there without being added here fails in CI rather than going unsmoked.
 */
export const CORE_REFUSED_VERBS = Object.freeze([
  "setup",
  "start",
  "stop",
  "restart",
  "update",
  "uninstall",
  "logs",
]);

/**
 * The Core image's apt set, exactly (ADR 0016 D6) — this list is where the
 * CVE number actually moves, so it is asserted element-for-element rather
 * than as a subset. `zip`, `wget`, `gnupg` and every systemd package are out;
 * `lsof` is in because `pty-manager.ts`'s port-conflict probe is silently a
 * no-op without it.
 */
export const CORE_PACKAGES = Object.freeze([
  "bash",
  "sudo",
  "ca-certificates",
  "curl",
  "git",
  "openssh-client",
  "build-essential",
  "python3",
  "ripgrep",
  "jq",
  "less",
  "vim-tiny",
  "unzip",
  "lsof",
  "xz-utils",
  "tini",
]);

export function readRepoFile(relative) {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

/**
 * Parse the instructions the image contract cares about out of a Dockerfile.
 * Continuation lines (`\`) are folded first so a wrapped RUN or CMD reads as
 * one instruction.
 */
export function dockerfileFacts(text) {
  const folded = text.replace(/\\\r?\n/g, " ");
  const facts = {
    froms: [],
    exposes: [],
    // `EXPOSE ${ACTANA_PORT}` is the point of D15, so the unresolved text has
    // to survive alongside the number `exposes` would turn into NaN.
    exposesRaw: [],
    env: {},
    args: {},
    runs: [],
    volumes: [],
    users: [],
    // `{ from, chown, sources, dest }` per COPY. `/data`'s ownership is
    // carried by the COPY's own --chown and nothing else (D22), so the flags
    // have to survive parsing rather than be dropped as noise.
    copies: [],
    entrypoint: null,
    cmd: null,
    healthcheck: null,
  };
  for (const raw of folded.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [, instruction, rest] = line.match(/^(\S+)\s+(.*)$/s) ?? [];
    if (!instruction) continue;
    switch (instruction.toUpperCase()) {
      case "FROM": {
        const [image, , alias] = rest.split(/\s+/);
        facts.froms.push({ image, alias: alias ?? null });
        break;
      }
      case "EXPOSE":
        facts.exposesRaw.push(...rest.split(/\s+/).map((p) => p.split("/")[0]));
        facts.exposes.push(...rest.split(/\s+/).map((p) => Number(p.split("/")[0])));
        break;
      case "ENV":
        for (const match of rest.matchAll(/([A-Z0-9_]+)=(\S+)/g)) {
          facts.env[match[1]] = match[2];
        }
        break;
      case "ARG": {
        const [, name, value = null] = rest.trim().match(/^([A-Za-z0-9_]+)(?:=(.*))?$/s) ?? [];
        if (name) facts.args[name] = value;
        break;
      }
      case "RUN":
        facts.runs.push(rest.replace(/\s+/g, " ").trim());
        break;
      case "ENTRYPOINT":
        facts.entrypoint = rest.trim();
        break;
      case "VOLUME":
        facts.volumes.push(...rest.replace(/[[\]",]/g, " ").split(/\s+/).filter(Boolean));
        break;
      case "USER":
        facts.users.push(rest.trim());
        break;
      case "COPY": {
        const flags = [...rest.matchAll(/(?:^|\s)--([a-z-]+)=(\S+)/g)];
        const operands = rest
          .replace(/(?:^|\s)--[a-z-]+=\S+/g, " ")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        const flag = (name) => flags.find(([, key]) => key === name)?.[2] ?? null;
        facts.copies.push({
          from: flag("from"),
          chown: flag("chown"),
          sources: operands.slice(0, -1),
          dest: operands.at(-1) ?? null,
        });
        break;
      }
      case "CMD":
        facts.cmd = rest.trim();
        break;
      case "HEALTHCHECK":
        facts.healthcheck = rest.replace(/\s+/g, " ").trim();
        break;
    }
  }
  return facts;
}

/**
 * The packages a folded `RUN` installs with apt, in the order it names them.
 * Reads the operands between `apt-get install` and the next `&&`, dropping
 * flags. A RUN that installs nothing yields an empty list.
 */
export function aptPackages(run) {
  const install = run.match(/apt-get\s+install\s+(.*?)(?:&&|$)/s)?.[1] ?? "";
  return install.split(/\s+/).filter((token) => token && !token.startsWith("-"));
}

/**
 * The copy-paste block for a second Core, lifted out of the reference
 * compose's comments and uncommented.
 *
 * D41's "nothing here is a singleton" is only worth writing down if the block
 * an operator would actually paste is a working service — so the block is
 * fenced in the file and read back here, rather than eyeballed. Returns the
 * YAML as if it had been uncommented in place, indentation intact.
 */
export function secondCoreBlock(text) {
  const fenced = text.match(/^# >>> second Core\n([\s\S]*?)^# <<< second Core$/m);
  if (!fenced) return null;
  return fenced[1]
    .split("\n")
    .filter((line) => line.startsWith("#"))
    .map((line) => line.replace(/^#[ ]?/, ""))
    .join("\n");
}

/**
 * Extract services and top-level volumes from the reference compose file.
 * Understands exactly the shape we write: two-space indents, `services:` and
 * `volumes:` at the top level, scalar keys such as `image:` and `restart:`,
 * and list-form `ports:` / `volumes:` / `environment:` under each service.
 *
 * Scalars land in `scalars` as well, unparsed. That is what lets a test say
 * `privileged` is absent — a key nobody models cannot be asserted missing.
 */
export function composeFacts(text) {
  const services = {};
  const volumes = [];
  let section = null; // "services" | "volumes" | other top-level key
  let service = null;
  let field = null; // current list field inside a service

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    if (indent === 0) {
      section = body.replace(/:$/, "");
      service = null;
      field = null;
      continue;
    }
    if (section === "volumes" && indent === 2) {
      volumes.push(body.replace(/:.*$/, ""));
      continue;
    }
    if (section !== "services") continue;

    if (indent === 2) {
      service = body.replace(/:$/, "");
      services[service] = { image: null, ports: [], volumes: [], environment: [], scalars: {} };
      field = null;
    } else if (indent === 4 && service) {
      const [key, ...rest] = body.split(":");
      const value = rest.join(":").trim();
      if (key === "ports" || key === "volumes" || key === "environment") {
        field = key;
      } else {
        // Everything else this file uses is a scalar. `image` keeps its own
        // named slot because every caller already reads it there.
        if (key === "image") services[service].image = value;
        services[service].scalars[key] = value;
        field = null;
      }
    } else if (indent >= 6 && service && field && body.startsWith("- ")) {
      services[service][field].push(body.slice(2).replace(/^["']|["']$/g, ""));
    }
  }
  return { services, volumes };
}
