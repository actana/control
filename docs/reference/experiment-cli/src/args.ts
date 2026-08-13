// Argument parsing, and the context object every command receives.

/**
 * Flags that take a value. Everything else is boolean, so the token after it is
 * a positional and must not be swallowed.
 */
export const VALUE_FLAGS = new Set([
  "--core",
  "--harness",
  "--model",
  "--title",
  "--lines",
  "--cols",
  "--rows",
  "--name",
  "--since",
  "--kind",
]);

export function positionalArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      if (VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

export type Ctx = {
  /** Every argument after the resource name, flags included. */
  argv: string[];
  /** The same, with flags and their values removed. `[0]` is the verb. */
  positional: string[];
  /** Value of `--name`, or undefined. */
  flag: (name: string) => string | undefined;
  /** Whether a boolean flag is present. */
  has: (name: string) => boolean;
  /**
   * Set by commands that keep streaming after they return, so the runner does
   * not close the socket out from under them.
   */
  keepOpen: boolean;
};

export function makeCtx(argv: string[]): Ctx {
  return {
    argv,
    positional: positionalArgs(argv),
    flag: (name: string) => {
      const i = argv.indexOf(`--${name}`);
      return i === -1 ? undefined : argv[i + 1];
    },
    has: (name: string) => argv.includes(`--${name}`),
    keepOpen: false,
  };
}

/** Thrown when arguments are wrong; the runner turns it into help output. */
export class UsageError extends Error {
  resource: string | undefined;
  constructor(message: string, resource?: string) {
    super(message);
    this.resource = resource;
  }
}
