// The seam between the SDK's file surface and the two verbs above it (#168).
//
// One thing is worth testing here and it is not the plumbing: **which SDK error
// becomes which kind, and whether the Core's sentence survives the trip.** The
// F8 refusal is the reason — #168 asks that a transfer refused by the
// one-write-per-Project rule *say who holds it, not just "busy"* — and the only
// place that can be lost is this mapping. Every verb's message is built from
// what comes out of here.

import { describe, it, expect } from "vitest";
import { ProjectFilesError, projectFilesErrorFrom } from "../project-files-gateway.ts";
import {
  CoreFilesConflictError,
  CoreFilesRequestError,
  CoreFilesStreamError,
  CoreFilesUnavailableError,
} from "@actana/sdk/core-files-http.ts";

/** The Core's real words, from `transferInProgress` in core-files-routes.ts. */
const CORE_CONFLICT =
  "another write transfer is already running on this Project " +
  "(vendor/, started 2026-08-13T09:15:00.000Z) — " +
  "one write at a time per Project; reads are unrestricted and concurrent";

describe("the F8 refusal keeps the only answer to `busy with what?`", () => {
  it("becomes a conflict, with the Core's sentence intact", () => {
    const translated = projectFilesErrorFrom(
      new CoreFilesConflictError(409, "transfer-in-progress", CORE_CONFLICT),
    );

    expect(translated).toBeInstanceOf(ProjectFilesError);
    const error = translated as ProjectFilesError;
    expect(error.kind).toBe("conflict");
    // Word for word. A client that shortened this to "the Project is busy"
    // would be discarding the path and the start time, which are the two facts
    // an operator can actually act on.
    expect(error.message).toBe(CORE_CONFLICT);
    expect(error.message).toContain("vendor/");
    expect(error.message).toContain("2026-08-13T09:15:00.000Z");
  });

  it("keeps the code a script branches on, separately from the prose", () => {
    // A message is a sentence somebody will reword; `transfer-in-progress` is
    // the contract.
    const error = projectFilesErrorFrom(
      new CoreFilesConflictError(409, "transfer-in-progress", CORE_CONFLICT),
    ) as ProjectFilesError;
    expect(error.code).toBe("transfer-in-progress");
  });

  it("keeps `directory-in-the-way` a conflict too — it shares the status and the rule", () => {
    const error = projectFilesErrorFrom(
      new CoreFilesConflictError(409, "directory-in-the-way", "config is a directory holding 4 entries"),
    ) as ProjectFilesError;
    expect(error.kind).toBe("conflict");
    expect(error.message).toContain("4 entries");
  });
});

describe("the rest of the taxonomy", () => {
  it("keeps a Core with no file surface distinguishable from an outage", () => {
    // Not a fault and not a needs-update: it is every Core that shipped before
    // the surface existed (F9), and the operator should be told that rather
    // than sent to check their network.
    const error = projectFilesErrorFrom(
      new CoreFilesUnavailableError("this Core announced no `files` capability"),
    ) as ProjectFilesError;
    expect(error.kind).toBe("unavailable");
    expect(error.message).toContain("no `files` capability");
  });

  it("separates a 404 from every other refusal", () => {
    const error = projectFilesErrorFrom(
      new CoreFilesRequestError(404, "not-found", "src/nope does not exist in this Project"),
    ) as ProjectFilesError;
    expect(error.kind).toBe("not-found");
    expect(error.code).toBe("not-found");
  });

  it("carries a path refusal through as the Core worded it, and does not second-guess it", () => {
    // The other half of "no client-side path validation": this side has no
    // opinion about `dot-dot-segment`, it just reports what came back.
    const error = projectFilesErrorFrom(
      new CoreFilesRequestError(400, "dot-dot-segment", "../escape leaves the Project root"),
    ) as ProjectFilesError;
    expect(error.kind).toBe("refused");
    expect(error.message).toContain("leaves the Project root");
  });

  it("says a stream failure was part-way through, because that changes what to do next", () => {
    const error = projectFilesErrorFrom(
      new CoreFilesStreamError("write-failed", "ENOSPC writing vendor/big.bin"),
    ) as ProjectFilesError;
    expect(error.kind).toBe("refused");
    // A retry after this one is resuming into a half-written tree, not starting
    // clean, and the operator is the one who has to decide about that.
    expect(error.message).toContain("part-way through");
    expect(error.message).toContain("ENOSPC");
  });

  it("passes an ordinary error through untouched rather than dressing it up", () => {
    const original = new Error("socket hang up");
    expect(projectFilesErrorFrom(original)).toBe(original);
  });

  it("does not re-wrap one of its own", () => {
    const already = new ProjectFilesError("no-such-project", 'this Core has no Project "nope"');
    expect(projectFilesErrorFrom(already)).toBe(already);
  });
});
