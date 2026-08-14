// `<project>:<path>` — one argument that names a place on a **Core**, and how
// it is told apart from a place on this laptop (#129 F12, #168).
//
// `actana project cp` takes two arguments and exactly one of them is remote.
// There is no `--to` / `--from` flag and no `--remote` marker: the direction is
// read off which side carries a colon, which is the shape `scp` and `rsync`
// established and the shape an operator's fingers already know.
//
// That shape has one famous hazard and this module exists to answer it. Two
// perfectly ordinary local paths contain a colon:
//
//     C:\Users\me\dist        a Windows path — drive letter, then a colon
//     notes:draft.md          a file whose *name* has a colon in it
//
// Read naively, the first is a Project called `C` and the second a Project
// called `notes`, and both would send an operator's files somewhere they did
// not ask for. So the parse is decided here, written down, and pinned by
// `project-file-target.test.ts` rather than left to whatever the first regex
// happened to do.
//
// ## The rules, in the order they are applied
//
//   1. **No colon at all → local.** The overwhelming majority of arguments.
//   2. **A path separator before the colon → local.** `./notes:draft.md`,
//      `dist/a:b`, `/srv/a:b`, `.\a:b`. A Project name cannot contain `/` or
//      `\`, so a separator on the left of the colon settles it — and this is
//      the **escape hatch**: any local file whose name contains a colon becomes
//      unambiguous by writing `./` in front of it, which is exactly the advice
//      `scp` has given for thirty years.
//   3. **A single letter, then a colon, then a separator → local.** `C:\dist`
//      and `C:/dist`. A one-character Project name is legal and reachable —
//      `x:src/main.ts` is a Project — because the rule needs *both* halves: a
//      drive letter is followed by a separator, and a Project's path is
//      relative and is not.
//   4. **Anything else with a colon → remote**, split at the **first** colon.
//      `api:src/a:b.txt` is the Project `api` and the path `src/a:b.txt`; a
//      colon inside a Project-relative path needs no escaping because only the
//      first one is structural.
//
// What is deliberately *not* here: any judgement about whether the remote path
// is legal. Absolute, `..`, too long, outside the root — every one of those is
// the Core's to answer (F3, F11, ADR 0027 D5) and it answers them with a code
// and a sentence. A client that pre-validated would be a second implementation
// of a rule it cannot see the disk for, and the two would drift.

import path from "node:path";

/** One side of a `cp`, once it is known which machine it names. */
export type TransferTarget =
  | {
      kind: "remote";
      /** A Project name or id, exactly as it was typed. Resolved against the Core, not here. */
      project: string;
      /** Project-relative, and possibly empty — the empty string is the Project root. */
      path: string;
      /** What the operator actually typed, for error messages that quote them. */
      token: string;
    }
  | { kind: "local"; path: string; token: string };

/**
 * Which machine one `cp` argument names.
 *
 * Total: every string is one or the other, and nothing throws. An argument that
 * cannot be acted on — two local sides, two remote sides — is a fact about the
 * *pair*, and {@link transferDirection} is where that is decided.
 */
export function parseTransferTarget(token: string): TransferTarget {
  const colon = token.indexOf(":");
  if (colon === -1) return { kind: "local", path: token, token };

  const head = token.slice(0, colon);
  const tail = token.slice(colon + 1);

  // A leading colon (`:path`) names no Project. Local rather than an error: it
  // is a legal, if odd, relative filename, and refusing it here would be this
  // module deciding something about a disk it can see perfectly well.
  if (head.length === 0) return { kind: "local", path: token, token };

  // Rule 2 — a separator on the left of the colon.
  if (head.includes("/") || head.includes("\\")) return { kind: "local", path: token, token };

  // Rule 3 — a Windows drive: one letter, a colon, then a separator.
  if (head.length === 1 && /^[A-Za-z]$/.test(head) && (tail.startsWith("\\") || tail.startsWith("/"))) {
    return { kind: "local", path: token, token };
  }

  return { kind: "remote", project: head, path: tail, token };
}

/** A `cp` that can be performed: one local side, one remote side, and a direction. */
export type TransferDirection =
  | { ok: true; direction: "upload"; local: string; remote: Extract<TransferTarget, { kind: "remote" }> }
  | { ok: true; direction: "download"; local: string; remote: Extract<TransferTarget, { kind: "remote" }> }
  | { ok: false; error: string };

/**
 * Read the direction off the pair, or say why there is none.
 *
 * Both errors quote the arguments back and name the escape hatch, because both
 * of them are usually rule 2 in disguise: somebody meant a remote path and
 * typed a bare name, or meant a local file with a colon in it and did not know
 * `./` was load-bearing.
 */
export function transferDirection(sourceToken: string, destToken: string): TransferDirection {
  const source = parseTransferTarget(sourceToken);
  const dest = parseTransferTarget(destToken);

  if (source.kind === "local" && dest.kind === "local") {
    return {
      ok: false,
      error:
        `neither "${sourceToken}" nor "${destToken}" names a Project — one side must be <project>:<path>. ` +
        "Copying one local folder to another is your operating system's `cp`",
    };
  }
  if (source.kind === "remote" && dest.kind === "remote") {
    return {
      ok: false,
      error:
        `both "${sourceToken}" and "${destToken}" name a Project. A transfer has one local side: ` +
        "Core-to-Core would put every byte through this laptop, so it is two commands and a folder in between",
    };
  }
  if (source.kind === "remote") {
    return { ok: true, direction: "download", local: dest.path, remote: source };
  }
  return { ok: true, direction: "upload", local: source.path, remote: (dest as Extract<TransferTarget, { kind: "remote" }>) };
}

/**
 * The Project-relative destination for a **single file**, when the operator
 * pointed at a folder rather than at a name.
 *
 * `actana project cp ./notes.md api:docs/` is a sentence people type, and the
 * Core would take it literally: `docs/` is a path, and writing a file at it is
 * either a refusal or a file with an odd name. Appending the source's basename
 * is what `cp` and `scp` do, and it is the one piece of path *shaping* this
 * client does.
 *
 * It is not path validation, which is the thing #168 says not to add: nothing
 * here asks whether the path exists on the Core, whether it escapes the root or
 * whether it is legal. Those stay the Core's answers. This only decides what
 * string to send when the operator's ends in a separator or is empty.
 */
export function remoteFileDestination(remotePath: string, localSource: string): string {
  const base = path.basename(localSource);
  if (remotePath === "") return base;
  if (remotePath.endsWith("/")) return `${remotePath}${base}`;
  return remotePath;
}

/** The same shaping in the other direction, and it stays a `/` path for the Core. */
export function remoteDirectorySource(remotePath: string): string {
  return remotePath.replace(/\/+$/, "");
}
