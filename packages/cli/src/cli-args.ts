// Flag parsing.
//
// Small on purpose, and hand-written rather than a dependency: a published CLI
// whose only runtime dependency is the SDK is a CLI whose install is one
// package deep, and the flag surface #129 D10 describes is a dozen booleans and
// two values. The moment that stops being true the trade changes; it is not
// true yet.
//
// Flags may appear before or after positionals — `actana core ls --json` and
// `actana --json core ls` both work — because a person who has just been told
// the flag exists will type it wherever they are looking. `--` ends flag
// parsing, so a value that starts with a dash can still be passed.

/** Global flags plus whatever was left over. */
export type ParsedArgs = {
  /** The nouns and verbs, in order, with flags removed. */
  positionals: string[];
  /** `--json`: machine-readable output. */
  json: boolean;
  /** `--verbose`: explain the steps. Never prints credentials — see the CLI header. */
  verbose: boolean;
  /** `-h` / `--help`. */
  help: boolean;
  /** `-V` / `--version`. */
  version: boolean;
  /** `--core <name>`, or null when the flag was absent. */
  core: string | null;
  /**
   * `--since <eventId>` — where `events tail` starts, overriding the stored
   * cursor. Kept as the raw string: "what the operator typed" and "a number" are
   * different things, and the verb that reads it is the one that can say what a
   * bad value means (`--since start` is a word, not a number).
   */
  since: string | null;
  /** `--kind <k>`, repeatable — the event kinds `events tail` prints. Empty means all. */
  kind: string[];
  /** `--limit <n>` — stop after this many rows. Raw, for the same reason as `since`. */
  limit: string | null;
  /** Flags this build does not know, in the order they appeared. */
  unknown: string[];
  /** A flag that takes a value and was given none, or null. */
  missingValue: string | null;
};

/** Flags that take a value. */
const VALUE_FLAGS = new Set(["--core", "--since", "--kind", "--limit"]);

/** Parse `process.argv.slice(2)`. Never throws; malformed input is reported in the result. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    positionals: [],
    json: false,
    verbose: false,
    help: false,
    version: false,
    core: null,
    since: null,
    kind: [],
    limit: null,
    unknown: [],
    missingValue: null,
  };

  let flagsEnded = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (flagsEnded || arg === "-" || !arg.startsWith("-")) {
      // A bare `-` is a positional: it is the conventional name for stdin, and
      // `actana core add prod -` is a sentence somebody will type.
      parsed.positionals.push(arg);
      continue;
    }

    if (arg === "--") {
      flagsEnded = true;
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);

    if (VALUE_FLAGS.has(name)) {
      const value = inlineValue ?? argv[++i] ?? null;
      if (value === null || value === "") {
        parsed.missingValue ??= name;
        continue;
      }
      if (name === "--core") parsed.core = value;
      else if (name === "--since") parsed.since = value;
      // Repeatable, unlike the other three: `--kind task:created --kind
      // pty:exit` is a filter somebody will build up, and the alternative — one
      // comma-joined string — puts a second syntax inside a flag value.
      else if (name === "--kind") parsed.kind.push(value);
      else if (name === "--limit") parsed.limit = value;
      continue;
    }

    switch (name) {
      case "--json":
        parsed.json = true;
        break;
      case "--verbose":
        parsed.verbose = true;
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "-V":
      case "--version":
        parsed.version = true;
        break;
      default:
        parsed.unknown.push(name);
    }
  }

  return parsed;
}
