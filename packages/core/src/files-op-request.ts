// Checking a {@link FilesOpRequest} that arrived as JSON.
//
// The daemon builds the request from an HTTP call it has already checked; the helper
// checks it again, because it cannot trust whoever started it. Anything that is not
// exactly one of the shapes is refused. A path is only checked for being a string
// here: confinement decides what it may name.

import type { FilesOpRequest } from "./files-ops";

const MAX_PATH_CHARS = 4096;

function pathField(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length > MAX_PATH_CHARS) throw new Error(`${key} must be a string of at most ${MAX_PATH_CHARS} characters`);
  return value;
}

function boolField(raw: Record<string, unknown>, key: string): boolean {
  const value = raw[key];
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function numberOrNull(raw: Record<string, unknown>, key: string): number | null {
  const value = raw[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number or null`);
  return value;
}

export function parseFilesOpRequest(raw: unknown): FilesOpRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("the request is not an object");
  const r = raw as Record<string, unknown>;
  switch (r.op) {
    case "read":
      return { op: "read", path: pathField(r, "path"), headOnly: boolField(r, "headOnly") };
    case "list": {
      const request: Extract<FilesOpRequest, { op: "list" }> = {
        op: "list",
        path: pathField(r, "path"),
        headOnly: boolField(r, "headOnly"),
      };
      if (r.depth !== undefined) {
        if (typeof r.depth !== "number" || !Number.isInteger(r.depth) || r.depth < 1) throw new Error("depth must be a whole number of 1 or more");
        request.depth = r.depth;
      }
      if (r.sha256 !== undefined) request.sha256 = boolField(r, "sha256");
      return request;
    }
    case "write":
      return {
        op: "write",
        path: pathField(r, "path"),
        tar: boolField(r, "tar"),
        contentLength: numberOrNull(r, "contentLength"),
        fileMode: numberOrNull(r, "fileMode"),
        fileMtime: numberOrNull(r, "fileMtime"),
      };
    case "delete":
      return { op: "delete", path: pathField(r, "path") };
    case "mkdir":
      return { op: "mkdir", path: pathField(r, "path") };
    case "move":
      return { op: "move", from: pathField(r, "from"), to: pathField(r, "to") };
    default:
      throw new Error(`unknown operation ${JSON.stringify(r.op)}`);
  }
}
