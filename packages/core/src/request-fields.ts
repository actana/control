// What a request frame may carry now that Sessions belong to the Core alone (ADR 0041 D1, D2).
//
// Every Session starts in the Core's home. A spawn therefore names no cwd and
// no grouping of any kind: the Core takes the directory from itself, never from
// the frame. A client that still sends one has an older idea of what a Core is,
// and the answer it needs is a refusal that names the field, not a spawn that
// quietly starts somewhere other than where it asked.
//
// This is an allow-list rather than a deny-list of the two fields the old model
// had, so that the next field a client invents to steer the start directory is
// refused the same way instead of being ignored.
const SPAWN_FIELDS: ReadonlySet<string> = new Set([
  "sessionId",
  "command",
  "args",
  "agent",
  "dangerouslySkipPermissions",
  "initialInput",
  "shell",
  "shellSession",
  // A pre-0.5.0 shell terminal asked for the home directory explicitly. It is
  // what every spawn does now, so the flag is harmless and is let through.
  "home",
  "cols",
  "rows",
  "mcEnv",
  "missionControlTheme",
]);

/**
 * The message a `spawn` is refused with, or `null` when every field it carries
 * is one a spawn takes. Names the first offending field.
 */
export function spawnFieldRefusal(opts: object): string | null {
  for (const key of Object.keys(opts)) {
    if (!SPAWN_FIELDS.has(key)) {
      return refusedField("spawn", key);
    }
  }
  return null;
}

// A Session belongs to the Core, so a frame that lists Sessions has nothing to
// narrow by and a `create` has nothing to create the Session under. The same
// allow-list reasoning as above, per frame: the keys each frame has left.
const SESSION_FRAME_FIELDS: Record<string, ReadonlySet<string>> = {
  sessionRowsList: new Set(["type", "reqId"]),
  archivedSessionRowsList: new Set(["type", "reqId"]),
  sessionsList: new Set(["type", "reqId"]),
};
const SESSION_CREATE_FIELDS: ReadonlySet<string> = new Set(["op", "sessionId", "title", "agent", "status", "icon"]);

/**
 * The message a Session frame is refused with, or `null` when it carries only
 * what that frame takes. Looks at the three list frames and at the `create` of
 * `sessionsMutate`; every other frame is not this function's to judge.
 */
export function sessionFrameFieldRefusal(frame: {
  type: string;
  mutation?: unknown;
}): string | null {
  const allowed = SESSION_FRAME_FIELDS[frame.type];
  if (allowed) {
    const stray = Object.keys(frame).find((key) => !allowed.has(key));
    return stray === undefined ? null : refusedField(frame.type, stray);
  }
  if (frame.type === "sessionsMutate") {
    const mutation = frame.mutation as { op?: unknown } | null | undefined;
    if (mutation && typeof mutation === "object" && mutation.op === "create") {
      const stray = Object.keys(mutation).find((key) => !SESSION_CREATE_FIELDS.has(key));
      return stray === undefined ? null : refusedField("sessionsMutate create", stray);
    }
  }
  return null;
}

function refusedField(what: string, key: string): string {
  return `${what} does not take "${key}": a Session belongs to the Core and starts in its home directory`;
}
