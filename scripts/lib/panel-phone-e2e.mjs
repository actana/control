import * as path from "node:path";

// Pure helpers of the phone e2e (scripts/e2e-panel-phone.mjs).
//
// Nothing here touches a browser, a socket or the file system: the constants
// the page is emulated with, the overflow predicate, argument parsing, the leg
// runner and its failure text. They live apart so `scripts/__tests__` can pin
// them without Chrome — the browser half is only ever exercised in CI.

/** The phone the card names: 390 x 844 CSS px, 3x, touch. */
export const PHONE_VIEWPORT = Object.freeze({
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

/** An iPhone's user agent — the Panel does not sniff it, but a real phone sends one. */
export const PHONE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/**
 * Chrome's launch flags.
 *
 * `--no-sandbox`: GitHub's ubuntu-24.04 images restrict unprivileged user
 * namespaces, so Chrome's own sandbox cannot start there.
 *
 * `--disable-gpu --disable-3d-apis`: the Panel's terminals use xterm's WebGL
 * renderer when `canvas.getContext("webgl2")` works (lib/terminal-webgl.ts) and
 * its DOM renderer otherwise. WebGL paints to a canvas, whose text the test
 * cannot read; the DOM renderer writes real rows. A runner has no GPU anyway.
 */
export const CHROME_ARGS = Object.freeze([
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-3d-apis",
]);

/**
 * Is the page wider than the window? `scrollWidth` is the document's
 * scrolling element's, `innerWidth` the window's. A measurement that is not a
 * number counts as overflow: the check must fail loudly, not pass on `NaN`.
 */
export function hasHorizontalOverflow({ scrollWidth, innerWidth }) {
  if (!Number.isFinite(scrollWidth) || !Number.isFinite(innerWidth)) return true;
  return scrollWidth > innerWidth;
}

const KNOWN_FLAGS = new Set(["panel-entry", "core-entry", "screenshots"]);

/**
 * `--panel-entry <file> --core-entry <file> [--screenshots <dir>]`, the smoke's
 * two flags plus the directory screenshots are written to. Throws on anything
 * else: a mistyped `--screenshot` that quietly kept no pictures would only be
 * noticed on the run that needed them.
 */
export function parsePhoneArgs(argv, repoRoot) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (!KNOWN_FLAGS.has(key)) throw new Error(`unknown flag: ${token}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`--${key} needs a value`);
    args[key] = next;
    i++;
  }
  if (args._.length > 0) throw new Error(`unexpected argument: ${args._[0]}`);
  return {
    panelEntry: path.resolve(
      args["panel-entry"] ?? path.join(repoRoot, "packages", "panel", "dist", "server", "server.js"),
    ),
    coreEntry: path.resolve(
      args["core-entry"] ?? path.join(repoRoot, "packages", "core", "dist", "core-entry.cjs"),
    ),
    screenshotsDir: args.screenshots ? path.resolve(args.screenshots) : null,
  };
}

/** A leg that failed: carries the leg's number and name so the log can say where. */
export class LegError extends Error {
  constructor({ index, name, cause, message }) {
    super(message ?? (cause instanceof Error ? cause.message : String(cause)), { cause });
    this.name = "LegError";
    this.index = index;
    this.leg = name;
  }
}

/**
 * Run one leg under a time budget.
 *
 * Every wait inside a leg is bounded and names what it awaited; this is the
 * backstop for the leg as a whole, so a wait that forgot its own bound still
 * ends the run with the leg's name on it rather than at the job's timeout.
 */
export async function runLeg({ index, name, run, timeoutMs, log }) {
  log(`leg ${index}: ${name}`);
  let timer;
  const budget = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new LegError({ index, name, message: `leg "${name}" exceeded ${timeoutMs}ms` })),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([Promise.resolve().then(run), budget]);
  } catch (err) {
    throw err instanceof LegError ? err : new LegError({ index, name, cause: err });
  } finally {
    clearTimeout(timer);
  }
}

/** The one line a failed run opens its report with. */
export function formatLegFailure(err) {
  if (err instanceof LegError) return `leg ${err.index} "${err.leg}" failed: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** `03-open-a-session-terminal.png`, or `…-FAILED.png` for the picture taken on failure. */
export function legFileName(index, name, { failed = false } = {}) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${String(index).padStart(2, "0")}-${slug}${failed ? "-FAILED" : ""}.png`;
}

/**
 * A command that makes a shell print `PHONE-<id>` — typed with the marker split
 * across two quoted halves (`"PH""ONE-…"`). The shell joins them when it runs
 * the line, but the echo of the *typed* line still has the quotes in it, so
 * only the command's own output contains the marker whole. (The same trick as
 * the smoke's PTY leg.)
 */
export function shellEchoCommand(id) {
  const marker = `PHONE-${id}`;
  return { marker, typed: `echo "${marker.slice(0, 2)}""${marker.slice(2)}"` };
}

/** The shape of a key the Panel mints: `ak_<owner>_<base64url secret>`. */
export function looksLikeApiKey(value) {
  return /^ak_\d+_[A-Za-z0-9_-]{16,}$/.test(value);
}
