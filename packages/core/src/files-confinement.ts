// Confining a client-supplied path to a Project root (#165 F3).
//
// **This is an accident guard, not a security boundary.** It exists so that a
// `project cp` with a fat-fingered `../../etc` writes nothing, and so that a
// Panel drag-drop cannot land bytes outside the folder the operator was looking
// at. It is not a sandbox and must not be read as one: whoever holds a
// registration blob already has `core shell`, which is the sanctioned way off
// the Project root and runs as the same user with the same disk. A guard that
// stops a mistake is worth having; a guard advertised as containment when the
// sanctioned escape hatch sits next to it is worse than none, because someone
// will build on the claim. See ADR 0029.
//
// **One machine validates paths: this one** (#129 F11). The Panel is a dumb
// pipe and validates nothing, because it cannot — a Project's path is a VM path
// and only the Core's OS can resolve it. If it ever looks convenient to do a
// bit of this in the Panel, that is the bug.
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Why a path was refused. Distinct constants rather than one "bad path",
 * because the three the ticket names — an absolute path, a `..` escape, a
 * symlink resolving outside — are three different operator mistakes and read
 * back as three different sentences.
 */
export type FileConfinementRefusal =
  | "absolute-path"
  | "dot-dot-segment"
  | "outside-project-root"
  | "malformed-path";

export type ConfinedPath =
  | { ok: true; absolute: string; relative: string }
  | { ok: false; reason: FileConfinementRefusal; message: string };

/**
 * Is `candidate` the root itself, or underneath it?
 *
 * The `+ path.sep` matters: without it `/srv/app` contains `/srv/application`,
 * which is the prefix bug this check exists to not have. Mirrors `withinRoot`
 * in `pty-spawn-policy.ts`, which makes the same test for a spawn's cwd.
 */
export function withinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * `fs.realpathSync` for a path that may not exist yet.
 *
 * An upload names a path that is *about* to exist, so realpath-ing it outright
 * throws ENOENT and there is nothing to check. Instead: walk up to the deepest
 * ancestor that does exist, resolve *that* through every symlink, and re-join
 * the literal tail. The result is where the write would actually land.
 *
 * This is the whole reason confinement is checked **after** resolution rather
 * than before. A path made only of harmless-looking segments — no `..`, nothing
 * absolute — still lands outside the root when one of its parents is a symlink
 * pointing there, and a check that ran on the string would have passed it.
 */
export function resolveDeepestExisting(target: string): string {
  const segments: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...segments.reverse());
    } catch {
      const parent = path.dirname(current);
      // `dirname("/")` is `"/"`. Nothing above the filesystem root exists to
      // resolve, so stop rather than loop: the caller's containment check will
      // refuse whatever this returns.
      if (parent === current) return path.resolve(target);
      segments.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve a client-supplied relative path against a Project root, or say why
 * not.
 *
 * `requested` is relative, POSIX-shaped and rooted at the Project — `""` and
 * `"."` both mean the Project root itself. Everything about it is treated as
 * hostile input, because the Panel forwarded it unexamined and that is the
 * Panel's job (#129 F11).
 *
 * The string checks below (absolute, `..`, NUL) are early exits that produce a
 * better message; they are not what makes this correct. The load-bearing check
 * is the last one, against the resolved path.
 *
 * **Every symlink is followed, the last component included.** That is what a
 * read wants: `GET path=link.txt` on a link into the Project should hand back
 * the file it names. A *write* wants the other answer — see
 * {@link confineWriteTarget}.
 */
export function confineToProjectRoot(root: string, requested: string): ConfinedPath {
  // Backslashes are not separators on the platforms a Core runs on (Linux and
  // macOS), so a `..\..` is a legal file name here rather than an escape. It is
  // still refused inside `stringRefusal`: nothing legitimate names a file that
  // way, and letting it through would make this module's answer differ from a
  // reader's expectation for no gain.
  const stringCheck = stringRefusal(requested);
  if (stringCheck) return stringCheck;

  const segments = requested
    .trim()
    .split("/")
    .filter((s) => s.length > 0 && s !== ".");

  // The root is realpath'd too. A Project registered at a path that runs
  // through a symlink — `/home/op/work` → `/mnt/data/work` — would otherwise
  // fail every containment check, because the candidate resolves to the real
  // location and the root does not.
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(path.resolve(root));
  } catch {
    return {
      ok: false,
      reason: "outside-project-root",
      message: `the Project root ${root} does not resolve on this machine`,
    };
  }

  const absolute = resolveDeepestExisting(path.join(realRoot, ...segments));
  if (!withinRoot(absolute, realRoot)) {
    return {
      ok: false,
      reason: "outside-project-root",
      message:
        `path resolves to ${absolute}, which is outside the Project root ${realRoot} — ` +
        "a symlink or mount along the way points out of it",
    };
  }

  return { ok: true, absolute, relative: segments.join("/") };
}

/**
 * Where a *write* to `requested` must land: parents resolved, last component
 * left alone.
 *
 * The difference from {@link confineToProjectRoot} is one component and it is
 * the whole reason both exist. An archive entry named `notes.txt` says "there
 * is a file called `notes.txt`". If `notes.txt` is already a symlink and the
 * write follows it, the bytes land in whatever it names and `notes.txt` is
 * still a symlink — the operator asked to replace a file and silently
 * overwrote a different one. So the final component is joined literally, and
 * the caller removes whatever is sitting there before creating the real thing.
 *
 * The parents *are* resolved, because that is where the accident guard lives:
 * `vendor/lib.js` under a `vendor` that points out of the Project is refused
 * here, including when the symlink was planted by an earlier entry of the same
 * archive. Refusing the last component too would be the wrong trade — it would
 * make a perfectly ordinary "overwrite this file that happens to be a link"
 * into an error, and it buys nothing, because the literal join cannot leave a
 * directory that has already been proven to be inside.
 */
export function confineWriteTarget(root: string, requested: string): ConfinedPath {
  const stringCheck = stringRefusal(requested);
  if (stringCheck) return stringCheck;

  const segments = requested
    .trim()
    .split("/")
    .filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0) return confineToProjectRoot(root, "");

  const base = segments[segments.length - 1]!;
  const parent = confineToProjectRoot(root, segments.slice(0, -1).join("/"));
  if (!parent.ok) return parent;

  const absolute = path.join(parent.absolute, base);
  // The join cannot leave `parent.absolute`, which is already known to be
  // inside — `base` is a single segment and is neither `..` nor absolute. The
  // check is kept anyway: it costs a string comparison, and it is the one line
  // a reader of this function looks for.
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(path.resolve(root));
  } catch {
    return { ok: false, reason: "outside-project-root", message: `the Project root ${root} does not resolve on this machine` };
  }
  if (!withinRoot(absolute, realRoot)) {
    return {
      ok: false,
      reason: "outside-project-root",
      message: `path resolves to ${absolute}, which is outside the Project root ${realRoot}`,
    };
  }
  return { ok: true, absolute, relative: segments.join("/") };
}

/** The checks that need no disk: NUL, backslash, absolute, `..`. */
function stringRefusal(requested: string): { ok: false; reason: FileConfinementRefusal; message: string } | null {
  if (requested.includes("\0")) {
    return { ok: false, reason: "malformed-path", message: "path contains a NUL byte" };
  }
  if (requested.includes("\\")) {
    return { ok: false, reason: "malformed-path", message: "path contains a backslash — separators are `/`" };
  }
  const trimmed = requested.trim();
  if (path.posix.isAbsolute(trimmed) || path.isAbsolute(trimmed)) {
    return {
      ok: false,
      reason: "absolute-path",
      message: `path must be relative to the Project root, got ${JSON.stringify(requested)}`,
    };
  }
  if (trimmed.split("/").some((s) => s === "..")) {
    return {
      ok: false,
      reason: "dot-dot-segment",
      message: `path may not contain a \`..\` segment, got ${JSON.stringify(requested)}`,
    };
  }
  return null;
}

/**
 * Bytes available on the filesystem holding `target`, or null when the question
 * cannot be answered.
 *
 * Null is a real answer and the caller must treat it as "do not know", never as
 * zero: `statfs` is unavailable on some filesystems and some container runtimes
 * report nonsense. A precheck that refuses an upload because it could not
 * measure the disk is worse than one that lets the write fail on ENOSPC, which
 * is the outcome the precheck was only ever an early, cheaper version of.
 */
export async function freeSpaceBytes(target: string): Promise<number | null> {
  try {
    const stats = await fs.promises.statfs(target);
    const available = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(available) && available >= 0 ? available : null;
  } catch {
    return null;
  }
}
