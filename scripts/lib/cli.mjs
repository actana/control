/** Build a `fail(message)` that logs `[prefix] message` to stderr and exits 1. */
export function makeFail(prefix) {
  return (message) => {
    console.error(`[${prefix}] ${message}`);
    process.exit(1);
  };
}

/**
 * Parse `--key value` / `--flag` argv into `{ ...flags, _: positionals }`.
 *
 * A flag followed by another flag (or nothing) is `true`; anything else is the
 * string that followed it. Tokens not consumed as a flag's value land in `_`,
 * so a script that takes no positionals can reject them itself.
 */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/**
 * Read a flag that must carry a value, failing through `fail` when it was
 * passed bare (`--out-dir --version 1.2.3` silently losing a directory is the
 * bug this exists to prevent).
 */
export function stringFlag(args, name, fail, fallback) {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "string") fail(`--${name} needs a value`);
  return value;
}
