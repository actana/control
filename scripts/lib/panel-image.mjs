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
 * The published image, tag-less. The compose file pins `:latest`, the release
 * workflow pushes the version tag and `latest`, and the smoke script builds a
 * local tag — all against this one name.
 */
export const PANEL_IMAGE = "ghcr.io/actana/actana-panel";

/** The single directory inside the container that must be a mounted volume. */
export const PANEL_DATA_DIR = "/data";

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
    env: {},
    volumes: [],
    users: [],
    cmd: null,
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
        facts.exposes.push(...rest.split(/\s+/).map((p) => Number(p.split("/")[0])));
        break;
      case "ENV":
        for (const match of rest.matchAll(/([A-Z0-9_]+)=(\S+)/g)) {
          facts.env[match[1]] = match[2];
        }
        break;
      case "VOLUME":
        facts.volumes.push(...rest.replace(/[[\]",]/g, " ").split(/\s+/).filter(Boolean));
        break;
      case "USER":
        facts.users.push(rest.trim());
        break;
      case "CMD":
        facts.cmd = rest.trim();
        break;
    }
  }
  return facts;
}

/**
 * Extract services and top-level volumes from the reference compose file.
 * Understands exactly the shape we write: two-space indents, `services:` and
 * `volumes:` at the top level, scalar `image:`, and list-form `ports:` /
 * `volumes:` / `environment:` under each service.
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
      services[service] = { image: null, ports: [], volumes: [], environment: [] };
      field = null;
    } else if (indent === 4 && service) {
      const [key, ...rest] = body.split(":");
      const value = rest.join(":").trim();
      if (key === "image") {
        services[service].image = value;
        field = null;
      } else if (key === "ports" || key === "volumes" || key === "environment") {
        field = key;
      } else {
        field = null;
      }
    } else if (indent >= 6 && service && field && body.startsWith("- ")) {
      services[service][field].push(body.slice(2).replace(/^["']|["']$/g, ""));
    }
  }
  return { services, volumes };
}
