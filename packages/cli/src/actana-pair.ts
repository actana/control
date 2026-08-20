// `actana pair` — the Core-side operator's half of short-code enrollment (#283).
//
//   actana pair new [--label <label>] [--ttl <duration>]
//   actana pair ls [--json]
//   actana pair revoke <target>
//
// **This runs on the machine that IS the Core.** That sentence is in the help
// text and it is in this header for the same reason: there are two pairing
// commands in one binary and they belong to opposite ends of the exchange.
// `actana pair` mints a code on this Core and takes one back; `actana core
// pair` (#285) is the *client* command that spends a code somebody read out to
// you. One binary now carries both (#288), so the only thing separating them
// is which words the operator types — the help on each has to make the machine
// obvious or the mistake is silent.
//
// **The code exists in exactly one place: the terminal `pair new` printed it
// on.** What is persisted is a keyed digest (`hashPairingCode`), so `pair ls`
// *cannot* print a code — there is none in the store to print. That is the
// design working, not an omission, and `pair-command.test.ts` asserts it rather
// than trusting it.
//
// **What the fingerprint is for.** `pair new` prints the CA fingerprint beside
// the code because the client's first dial is the one dial it cannot verify any
// other way: it holds no certificate, so it has nothing pinned. A human reads
// both out, and the client checks the CA it is presented against the
// fingerprint *before* it sends the code (#280 step 3, #284). Printing it in
// the conventional colon-separated upper-case hex is therefore part of the
// contract — see `certFingerprintSha256`.
//
// The store is the one in `@actana/shared/pairing-store`, which lives there
// rather than in `packages/core` precisely so this command and the daemon can
// both drive it: this process mints sessions and revokes clients, the daemon
// redeems them and enforces the revocations. Neither imports the other.

import { randomUUID } from "node:crypto";
import { certFingerprintSha256 } from "@actana/shared/core-cert-material";
import { loadMaterialFromFile } from "@actana/shared/core-material-store";
import { generatePairingCode } from "@actana/shared/pairing-code";
import {
  createPairingSession,
  canRedeem,
  isConsumed,
  isRevoked,
  PAIRING_SESSION_TTL_MS,
  type PairingSession,
} from "@actana/shared/pairing-session";
import {
  derivePairingCodeKey,
  hashPairingCode,
  pairingStorePath,
  PairingStore,
  PAIRING_SESSION_RETENTION_MS,
  type PairedClient,
} from "@actana/shared/pairing-store";
import {
  LOCAL_OPERATOR_PEER,
  pairingAuditor,
  type PairingAuditSink,
} from "@actana/shared/pairing-audit";
import { formatJson, formatTable } from "./cli-output.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";

export const PAIR_HELP = `actana pair — enroll a client on THIS machine's Core

**You are on the Core.** These verbs mint and take back the pairing codes this
Core hands out. The client end of the same exchange is \`actana core pair\`, and
it runs on the machine being paired — not here.

Usage
  actana pair new [--label <name>] [--ttl <duration>]
                                  mint a one-time code and print it
  actana pair ls [--json]         pending codes, and the clients already paired
  actana pair revoke <target>     unpair a client, or cancel a pending code

Flags
  --label <name>   what to call the machine being paired (default: unnamed)
  --ttl <duration> how long the code stays good — \`30s\`, \`5m\`, \`2h\`
                   (default: ${describeDuration(PAIRING_SESSION_TTL_MS)})
  --json           machine-readable output — \`ls\`
  -h, --help       show this help

Minting a code
  \`pair new\` prints three things: the code, this Core's CA fingerprint, and
  when the code expires. Read the code AND the fingerprint out to whoever is at
  the client — the client checks the fingerprint against the certificate this
  Core presents before it sends the code, which is what makes that first dial
  verifiable when the client has nothing pinned yet.

  The code is printed once and never stored. This Core keeps only a keyed
  digest of it, so nothing — including \`pair ls\` — can print it again. A lost
  code is re-minted, not recovered.

Revoking
  \`revoke\` takes a certificate serial, a session id, or a label that matches
  exactly one of either. Pointed at a paired client it unpairs the machine and
  its credential stops working, including any core link it has open right now.
  Pointed at a pending code it cancels the code before anyone spends it.`;

/** What every verb here needs from the install: where this Core's material is. */
export type PairCommandContext = {
  /**
   * Resolve the absolute path to this Core's `material.json`, or `null` after
   * saying there is no Core installed here.
   *
   * A thunk rather than a string, so that the *order* lives in one place. Help
   * is a question about this program and not about this machine — `actana pair
   * --help` has to answer on a laptop that has never run `actana setup`, the
   * same way `actana --help` does — and a context that had already resolved an
   * install would have refused before this function was reached.
   */
  materialPath: () => string | null;
  /**
   * Where a revocation's audit record goes.
   *
   * Defaults to this CLI's stderr, and that default is the whole reason the
   * seam exists. The daemon's auditor writes through `@actana/shared/log`,
   * which is `console.log` — stdout. In a one-shot CLI whose stdout is a
   * pairing code an operator may be piping, an audit line on stdout would be a
   * line in the middle of the credential. So the record is the same record,
   * built by the same `pairingAuditor` and reduced by the same field list, and
   * only the sink differs.
   */
  audit?: PairingAuditSink;
};

/** Dispatch a `pair` sub-verb. `argv` is everything after `pair`. */
export function runPairCommand(
  deps: ActanaCliDeps,
  argv: string[],
  ctx: PairCommandContext,
): number {
  const [verb, ...rest] = argv;

  if (verb === undefined || verb === "--help" || verb === "-h" || verb === "help") {
    deps.out(PAIR_HELP);
    // No verb is a question, not a mistake — the same answer `actana core`
    // gives, and the same exit code: usage when nothing was asked for.
    return verb === undefined ? EXIT_USAGE : EXIT_OK;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    deps.out(PAIR_HELP);
    return EXIT_OK;
  }

  switch (verb) {
    case "new":
      return pairNew(deps, rest, ctx);
    case "ls":
    case "list":
      return pairLs(deps, rest, ctx);
    case "revoke":
      return pairRevoke(deps, rest, ctx);
    default:
      deps.err(`actana pair: unknown verb "${verb}".`);
      deps.err("Verbs: new, ls, revoke. `actana pair --help` lists them.");
      return EXIT_USAGE;
  }
}

// ─── new ────────────────────────────────────────────────────────────────────

function pairNew(deps: ActanaCliDeps, rest: string[], ctx: PairCommandContext): number {
  const flags = readFlags(rest, { label: "value", ttl: "value" });
  if ("error" in flags) {
    deps.err(`actana pair new: ${flags.error}.`);
    return EXIT_USAGE;
  }
  // `actana pair new laptop` used to mint an *unlabelled* code and exit 0. The
  // operator then reads that code out believing it is called `laptop`, `pair
  // ls` shows `(unnamed)`, and `pair revoke laptop` says nothing matches. An
  // argument this verb has no use for is a mistake, exactly as an unknown flag
  // is.
  if (flags.positionals.length > 0) {
    deps.err(`actana pair new: unexpected argument "${flags.positionals[0]}".`);
    deps.err(`The name goes in a flag — \`actana pair new --label ${flags.positionals[0]}\`.`);
    return EXIT_USAGE;
  }

  const rawTtl = valueFlag(flags.values, "ttl");
  const ttl = rawTtl === undefined ? PAIRING_SESSION_TTL_MS : parseDuration(rawTtl);
  if (typeof ttl !== "number") {
    deps.err(`actana pair new: ${ttl.error}.`);
    return EXIT_USAGE;
  }

  const materialPath = ctx.materialPath();
  if (materialPath === null) return EXIT_FAILURE;

  const material = loadMaterialFromFile(materialPath);
  if (!material) {
    deps.err(`actana pair new: this Core has no pairing material at ${materialPath}.`);
    deps.err("Run `actana setup` — pairing needs a CA to sign against.");
    return EXIT_FAILURE;
  }

  const store = openStore(deps, materialPath, "new");
  if (!store) return EXIT_FAILURE;

  const now = deps.now();
  const label = valueFlag(flags.values, "label") ?? "";
  const sessionId = randomUUID();
  const code = generatePairingCode();
  const session = createPairingSession({
    id: sessionId,
    label,
    // The digest, never the code. The key is derived from this Core's bearer
    // secret, which is in `material.json` and not in the pairing file — so a
    // copy of the pairing file alone cannot be brute-forced back into codes.
    codeHash: hashPairingCode({
      key: derivePairingCodeKey(material.bearerSecret),
      sessionId,
      code,
    }),
    now,
    ttlMs: ttl,
  });

  store.createSession(session, now);

  // stdout: the three facts a human reads out. stderr: everything explaining
  // them, so a `pair new` that is being piped or screen-scraped stays three
  // labelled lines and nothing else.
  deps.err("Read the code AND the fingerprint out to the machine you are pairing.");
  deps.err("The code is printed once — this Core keeps only a digest of it.");
  deps.out(`Pairing code   ${code}`);
  deps.out(`CA fingerprint ${certFingerprintSha256(material.caCert)}`);
  deps.out(`Expires        ${absoluteTime(session.expiresAt)} (${relativeTime(session.expiresAt, now)})`);
  if (label) deps.out(`Label          ${label}`);
  deps.out(`Session        ${sessionId}`);
  deps.err(`Cancel it before it is used with \`actana pair revoke ${sessionId}\`.`);
  return EXIT_OK;
}

// ─── ls ─────────────────────────────────────────────────────────────────────

function pairLs(deps: ActanaCliDeps, rest: string[], ctx: PairCommandContext): number {
  const flags = readFlags(rest, { json: "boolean" });
  if ("error" in flags) {
    deps.err(`actana pair ls: ${flags.error}.`);
    return EXIT_USAGE;
  }
  if (flags.positionals.length > 0) {
    deps.err(`actana pair ls: unexpected argument "${flags.positionals[0]}".`);
    deps.err("`ls` takes no arguments — it lists everything.");
    return EXIT_USAGE;
  }

  const materialPath = ctx.materialPath();
  if (materialPath === null) return EXIT_FAILURE;

  const store = openStore(deps, materialPath, "ls");
  if (!store) return EXIT_FAILURE;

  const now = deps.now();
  const pending = store.listSessions().filter((session) => canRedeem(session, now).ok);
  const clients = store.listClients();

  if (flags.values.json) {
    // Field by field rather than a spread of the row, for the reason
    // `redactPairingAuditEvent` is a list: a spread would publish whatever the
    // stored shape grows next, and what it stores includes `codeHash`.
    deps.out(
      formatJson({
        pending: pending.map((session) => ({
          id: session.id,
          label: session.label,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          attempts: session.attempts,
          attemptCap: session.attemptCap,
        })),
        clients: clients.map((client) => ({
          certSerial: client.certSerial,
          certSubject: client.certSubject,
          label: client.label,
          pairedAt: client.pairedAt,
          certNotAfter: client.certNotAfter,
          revokedAt: client.revokedAt,
        })),
      }),
    );
    return EXIT_OK;
  }

  deps.out("Pending codes");
  if (pending.length === 0) {
    deps.out("  None. `actana pair new` mints one.");
  } else {
    for (const line of formatTable(
      ["LABEL", "CREATED", "EXPIRES", "ATTEMPTS", "SESSION"],
      pending.map((session) => [
        session.label || "(unnamed)",
        absoluteTime(session.createdAt),
        `${absoluteTime(session.expiresAt)} (${relativeTime(session.expiresAt, now)})`,
        `${session.attempts} of ${session.attemptCap}`,
        session.id,
      ]),
    )) {
      deps.out(`  ${line}`);
    }
  }

  deps.out("");
  deps.out("Paired clients");
  if (clients.length === 0) {
    deps.out("  None. A client appears here once it redeems a code.");
  } else {
    for (const line of formatTable(
      ["LABEL", "SUBJECT", "PAIRED", "STATUS", "SERIAL"],
      clients.map((client) => [
        client.label || "(unnamed)",
        client.certSubject,
        absoluteTime(client.pairedAt),
        client.revokedAt === null ? "paired" : `revoked ${absoluteTime(client.revokedAt)}`,
        client.certSerial,
      ]),
    )) {
      deps.out(`  ${line}`);
    }
  }
  return EXIT_OK;
}

// ─── revoke ─────────────────────────────────────────────────────────────────

function pairRevoke(deps: ActanaCliDeps, rest: string[], ctx: PairCommandContext): number {
  const flags = readFlags(rest, {});
  if ("error" in flags) {
    deps.err(`actana pair revoke: ${flags.error}.`);
    return EXIT_USAGE;
  }
  const [target, ...extra] = flags.positionals;
  // Blank as well as absent, and that is not tidiness. `""` prefix-matches
  // every serial and every session id, so `actana pair revoke "$SERIAL"` in a
  // script where `SERIAL` is unset matches everything — and on a Core with
  // exactly one client the ambiguity check below does not fire, so it revokes
  // it and exits 0. That check is the whole defence against revoking the wrong
  // machine, and this is the input that walks straight past it.
  if (target === undefined || target.trim() === "") {
    deps.err("actana pair revoke: a target is required — `actana pair revoke <serial|session|label>`.");
    return EXIT_USAGE;
  }
  if (extra.length > 0) {
    deps.err(`actana pair revoke: unexpected argument "${extra[0]}".`);
    return EXIT_USAGE;
  }

  const materialPath = ctx.materialPath();
  if (materialPath === null) return EXIT_FAILURE;

  const store = openStore(deps, materialPath, "revoke");
  if (!store) return EXIT_FAILURE;

  const now = deps.now();
  const audit = pairingAuditor(ctx.audit ?? ((record) => deps.err(`pairing.revoke ${formatJson(record)}`)));

  const clients = store.listClients().filter((client) => client.revokedAt === null);
  const sessions = store.listSessions().filter((session) => canRedeem(session, now).ok);
  const matched = [
    ...clients.filter((client) => matchesClient(client, target)).map((client) => ({ client })),
    ...sessions.filter((session) => matchesSession(session, target)).map((session) => ({ session })),
  ];

  if (matched.length === 0) {
    deps.err(`actana pair revoke: nothing here matches "${target}".`);
    deps.err("`actana pair ls` lists the pending codes and the paired clients.");
    return EXIT_FAILURE;
  }
  if (matched.length > 1) {
    // Never guess. Two machines paired under one label is the ordinary way this
    // happens, and revoking the wrong one is not something an operator finds
    // out about until the machine they meant to keep stops working.
    deps.err(`actana pair revoke: "${target}" matches ${matched.length} of them.`);
    for (const match of matched) {
      deps.err(
        "  " +
          ("client" in match
            ? `client ${match.client.certSerial} (${match.client.label || "unnamed"})`
            : `pending code ${match.session.id} (${match.session.label || "unnamed"})`),
      );
    }
    deps.err("Name the serial or the session id.");
    return EXIT_FAILURE;
  }

  const only = matched[0]!;
  if ("client" in only) {
    const revoked = store.revokeClient(only.client.certSerial, now);
    if (!revoked) {
      deps.err(`actana pair revoke: ${only.client.certSerial} is no longer paired here.`);
      return EXIT_FAILURE;
    }
    audit({
      outcome: "revoked",
      reason: "client",
      sessionId: revoked.sessionId,
      label: revoked.label,
      peer: LOCAL_OPERATOR_PEER,
      certSerial: revoked.certSerial,
      at: now,
    });
    deps.out(`Unpaired ${revoked.label || "the client"} (${revoked.certSubject}, serial ${revoked.certSerial}).`);
    // Said rather than implied. The daemon is a different process: it notices
    // the revocation from the store and drops the link, and until it has, the
    // certificate is still one its CA signed. "Stops working" is a promise this
    // command cannot keep on its own, so it names who keeps it.
    deps.out("Its certificate and its bearer stop working, and this Core closes any link it has open.");
    return EXIT_OK;
  }

  const cancelled = store.cancelSession(only.session.id, now);
  if (!cancelled || !isRevoked(cancelled)) {
    deps.err(
      cancelled && isConsumed(cancelled)
        ? `actana pair revoke: ${only.session.id} was already redeemed — revoke the client instead.`
        : `actana pair revoke: ${only.session.id} is no longer pending here.`,
    );
    return EXIT_FAILURE;
  }
  audit({
    outcome: "revoked",
    reason: "pending-session",
    sessionId: cancelled.id,
    label: cancelled.label,
    peer: LOCAL_OPERATOR_PEER,
    attempts: cancelled.attempts,
    at: now,
  });
  deps.out(`Cancelled the pending code for ${cancelled.label || "an unnamed machine"} (${cancelled.id}).`);
  deps.out("It cannot be redeemed. `actana pair new` mints another.");
  return EXIT_OK;
}

/**
 * This Core's pairing store, or `null` after saying why it cannot be used.
 *
 * `readStrict` rather than `read`, and every verb here goes through it.
 * `PairingStore.read` answers an unreadable file with an empty store, and each
 * of these verbs would then do something wrong with that answer: `ls` would
 * report a Core that has paired nobody, `revoke` would say nothing matches, and
 * `new` would be worse than either — `createSession` reads the whole document,
 * adds a session and writes it back, so minting against a corrupt file
 * *replaces* it, taking the record of which clients are revoked with it.
 *
 * That last one is not hypothetical damage. The daemon fails closed on exactly
 * this file (`core-pairing-revocation.ts`), so a Core with an unreadable
 * `pairing.json` is refusing every client it ever paired — and a `pair new`
 * that quietly rewrote the file would end that refusal by forgetting who was
 * revoked, handing every revoked certificate its access back. Recovery has to
 * be repairing the file, so these verbs decline to be the thing that destroys
 * it.
 */
function openStore(deps: ActanaCliDeps, materialPath: string, verb: string): PairingStore | null {
  const store = new PairingStore(pairingStorePath(materialPath));
  try {
    store.readStrict();
  } catch (err) {
    deps.err(`actana pair ${verb}: ${err instanceof Error ? err.message : String(err)}.`);
    deps.err("While that file cannot be read, this Core refuses every client it has paired.");
    deps.err("Repair the JSON or restore it from a backup. Do not delete it — it is the record");
    deps.err("of which pairings were revoked, and deleting it would un-revoke every one of them.");
    return null;
  }
  return store;
}

/**
 * Does this target name this client?
 *
 * A serial matches on a prefix — serials are 32 hex characters and nobody
 * types one in full — but a label matches only in full. A label is prose the
 * operator chose, and `laptop` prefix-matching `laptop-2` would make the
 * ambiguity check above miss the very collision it exists to catch.
 */
function matchesClient(client: PairedClient, target: string): boolean {
  const wanted = target.toLowerCase();
  return (
    client.label.toLowerCase() === wanted ||
    client.certSerial.toLowerCase().startsWith(wanted) ||
    client.certSubject.toLowerCase() === wanted
  );
}

function matchesSession(session: PairingSession, target: string): boolean {
  const wanted = target.toLowerCase();
  return session.label.toLowerCase() === wanted || session.id.toLowerCase().startsWith(wanted);
}

// ─── flags, durations and times ─────────────────────────────────────────────

type FlagKind = "value" | "boolean";
type ReadFlags =
  | { values: Record<string, string | true | undefined>; positionals: string[] }
  | { error: string };

/**
 * Parse this verb's flags and positionals.
 *
 * `actana-cli.ts` has a `parseFlags` of its own and it is deliberately not
 * reused: that one rejects every positional, because none of the machine verbs
 * it was written for take one. `pair revoke <target>` does.
 */
function readFlags(argv: string[], spec: Record<string, FlagKind>): ReadFlags {
  const values: Record<string, string | true | undefined> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    // A single-dash token is a flag this build does not know, never a value.
    // Read as a positional, `actana pair new -l laptop` would have minted an
    // unlabelled code from two arguments that both look like they were used.
    if (!token.startsWith("--")) return { error: `unknown option: ${token}` };
    const eq = token.indexOf("=");
    const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    const kind = spec[name];
    if (!kind) return { error: `unknown option: ${token}` };
    if (kind === "boolean") {
      if (eq >= 0) return { error: `--${name} takes no value` };
      values[name] = true;
      continue;
    }
    const value = eq >= 0 ? token.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith("-")) return { error: `--${name} needs a value` };
    values[name] = value;
  }
  return { values, positionals };
}

/**
 * One value flag, as the string it can only be.
 *
 * The parsed bag is typed `string | true` because it holds both kinds of flag;
 * a `"value"` entry in the spec is never `true`, and this is where that fact is
 * asserted once instead of at each of its readers.
 */
function valueFlag(
  values: Record<string, string | true | undefined>,
  name: string,
): string | undefined {
  const raw = values[name];
  return typeof raw === "string" ? raw : undefined;
}

/**
 * The longest TTL this Core will mint, and it is not an arbitrary number.
 *
 * A pairing code is a pre-auth secret guarding CSR signing — #280 fixes its
 * default life at five minutes for exactly that reason — and the ceiling is
 * where "one-time code" stops describing the thing on the operator's screen. A
 * day is that point.
 *
 * It is spelled as the store's retention window rather than as a number of its
 * own so this file carries one day-long horizon instead of two. That is the
 * whole of the relationship: `prune` measures from `consumedAt ?? expiresAt`,
 * which is in the future for the entire life of a pending session, so a live
 * session is never a pruning candidate whatever its TTL.
 */
export const MAX_PAIRING_TTL_MS = PAIRING_SESSION_RETENTION_MS;

/**
 * Read `30s`, `5m`, `2h` as milliseconds, or say what is wrong with it.
 *
 * A unit is required. A bare `5` is the one input where a wrong guess is
 * invisible: read as seconds it is a code that dies before the operator
 * finishes reading it out, read as minutes it is a code that outlives the phone
 * call by four. Neither failure announces itself, so the parser asks instead.
 */
export function parseDuration(input: string): number | { error: string } {
  const match = /^(\d+)(s|m|h)$/.exec(input.trim());
  if (!match) {
    return { error: `--ttl wants a number and a unit — \`30s\`, \`5m\`, \`2h\` — not ${JSON.stringify(input)}` };
  }
  const scale = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 }[match[2] as "s" | "m" | "h"];
  const ms = Number(match[1]) * scale;
  if (ms <= 0) return { error: "--ttl must be longer than nothing" };
  if (ms > MAX_PAIRING_TTL_MS) {
    return { error: `--ttl cannot exceed ${describeDuration(MAX_PAIRING_TTL_MS)}` };
  }
  return ms;
}

/**
 * `300000` -> `5 minutes`, `5400000` -> `1 hour 30 minutes`.
 *
 * Two units and a floor, never a rounded one. Rounding to the largest unit that
 * fits made `--ttl 90m` print "in 2 hours" and `--ttl 90s` print "in 2 minutes"
 * — and the relative half is the half a human reads down a phone line, which is
 * the only reason it is printed beside an exact absolute time at all. A code
 * described as living longer than it does is a code the person at the other end
 * stops hurrying for.
 *
 * The second unit is dropped when it is zero, so the ordinary cases are the
 * short strings they were: "5 minutes", "30 seconds", "24 hours". Used by the
 * expiry lines, the help text's default and the ceiling's refusal alike.
 */
export function describeDuration(ms: number): string {
  const units: Array<[number, string]> = [
    [60 * 60 * 1000, "hour"],
    [60 * 1000, "minute"],
    [1000, "second"],
  ];
  for (let i = 0; i < units.length; i++) {
    const [size, name] = units[i]!;
    if (ms < size) continue;
    const whole = Math.floor(ms / size);
    const next = units[i + 1];
    const remainder = ms - whole * size;
    const tail = next && remainder >= next[0] ? ` ${countOf(Math.floor(remainder / next[0]), next[1])}` : "";
    return `${countOf(whole, name)}${tail}`;
  }
  return `${ms} ms`;
}

function countOf(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * The absolute half of an expiry, in UTC ISO 8601.
 *
 * UTC rather than the operator's local time, because the other half of this
 * exchange is a person on a different machine — often in a different timezone —
 * being read a time down a phone line. A local time is only unambiguous to
 * whoever is standing at the terminal that printed it.
 */
export function absoluteTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The relative half: `in 5 minutes`, `in 30 seconds`, `expired 2 minutes ago`. */
export function relativeTime(at: number, now: number): string {
  const delta = at - now;
  const magnitude = describeDuration(Math.abs(delta));
  return delta >= 0 ? `in ${magnitude}` : `expired ${magnitude} ago`;
}
