// `actana pair` — the Core-side operator's half of short-code enrollment (#283).
//
//   actana pair new [--label <label>] [--ttl <duration>] [--public-host <addr>]
//   actana pair ls [--json]
//   actana pair revoke <target>
//
// **`--public-host` chooses an address, it never introduces one** (#347). A
// Core's certificate covers the addresses `ACTANA_PUBLIC_HOST` named, and this
// flag picks which of *those* the code's redemption hands back — so one Core
// can pair its Panel to the compose service name and a host-machine CLI to the
// LAN address, out of one certificate. An address that is not on the list is
// refused here, with the list printed, because a pairing code that handed back
// a name the certificate does not cover would hand its client a credential that
// fails TLS hostname verification on the first dial.
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
// **`pair new` has two shapes, and `isatty(stdout)` is the whole of the
// switch** (#357). Down a pipe it is the labelled lines below, byte for byte
// what 0.4.2 printed, because they are a screen-scraping contract. At a
// terminal it is a framed handout that also says what to click in the Panel and
// what to paste on the other machine. There is deliberately no `--json` and no
// flag: a second way to ask is a second thing to keep true. See "the operator's
// shape" further down for what is drawn and why.
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
import * as path from "node:path";
import {
  CONTAINER_PORT_ENV,
  CONTAINER_PUBLIC_HOST_ENV,
  DEFAULT_CONTAINER_PORT,
  inContainer,
} from "@actana/shared/actana-container-contract";
import { coreNameError } from "@actana/shared/blob-registry";
import { certFingerprintSha256 } from "@actana/shared/core-cert-material";
import {
  formatPublicHosts,
  isConfiguredPublicHost,
  primaryPublicHost,
} from "@actana/shared/public-hosts";
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
import { readActanaConfig } from "./actana-config.ts";
import {
  ANSI,
  clip,
  displayWidth,
  frameEdge,
  FRAME_CONTENT_WIDTH,
  FRAME_HEADING,
  frameRow,
  style,
  useColor,
  wrapText,
} from "./cli-frame.ts";
import { formatJson, formatTable } from "./cli-output.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";

// The frame's own vocabulary, re-exported because it is part of what this
// module prints and `actana-pair.test.ts` measures the handout with it. The
// definitions moved to `cli-frame.ts` when `actana core pair` grew a frame of
// its own (#360) — there is one border width in this program, not two.
export { displayWidth, FRAME_WIDTH } from "./cli-frame.ts";

export const PAIR_HELP = `actana pair — enroll a client on THIS machine's Core

**You are on the Core.** These verbs mint and take back the pairing codes this
Core hands out. The client end of the same exchange is \`actana core pair\`, and
it runs on the machine being paired — not here.

Usage
  actana pair new [--label <name>] [--ttl <duration>] [--public-host <addr>]
                                  mint a one-time code and print it
  actana pair ls [--json]         pending codes, and the clients already paired
  actana pair revoke <target>     unpair a client, or cancel a pending code

Flags
  --label <name>   what to call the machine being paired (default: unnamed)
  --ttl <duration> how long the code stays good — \`30s\`, \`5m\`, \`2h\`
                   (default: ${describeDuration(PAIRING_SESSION_TTL_MS)})
  --public-host <addr>
                   which of this Core's configured addresses THIS code hands
                   back as the endpoint (default: the first one). It has to be
                   one this Core's certificate already covers — \`pair new\`
                   lists them if you name one it does not
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

  **At a terminal it prints more than that.** Those facts come framed, with
  both ways to spend them under it: what to click in the Panel, and a command
  to paste on the machine being paired — \`actana core pair\` with this code,
  this session and this fingerprint already in it, one per address this Core
  answers on.

  Redirect stdout and you get the labelled lines and nothing else, which is
  what a script reads. That is the whole of the switch: there is no flag for
  it, and \`pair new > code.txt\` or \`pair new | …\` gives the plain shape.

Choosing an address
  A Core can be reachable more than one way at once — \`ACTANA_PUBLIC_HOST\` takes
  a comma-separated list, and every entry is in this Core's certificate. Pair a
  client that sits inside the Docker network under the service name, and a
  client on the host machine under the LAN address, from the same Core and
  without re-issuing anything:

    actana pair new --label panel  --public-host core
    actana pair new --label laptop --public-host 192.168.1.20

  Omit the flag and the code hands back the first configured address, which is
  what every code did before there was more than one.

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
  const flags = readFlags(rest, { label: "value", ttl: "value", "public-host": "value" });
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

  // Which address this one code hands back (#347). Resolved against the hosts
  // the material records its certificate was signed for — the SAN list itself,
  // rather than a config file that could have drifted from it — because the
  // whole property being kept is that a code can never name an address a client
  // would then fail hostname verification against.
  const endpointHost = chooseEndpointHost(deps, material.serverHosts, flags.values);
  if (endpointHost === REFUSED) return EXIT_USAGE;

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
    endpointHost,
  });

  store.createSession(session, now);

  const fingerprint = certFingerprintSha256(material.caCert);

  // stderr is the same in both shapes below. It is the prose, and prose is not
  // what a scraper reads — so the two sentences that explain the code are here
  // whether the frame was drawn or not.
  deps.err("Read the code AND the fingerprint out to the machine you are pairing.");
  deps.err("The code is printed once — this Core keeps only a digest of it.");

  if (deps.stdoutIsTty) {
    // The operator's shape (#357). Everything about it is cosmetic: it carries
    // the same facts the labelled lines do, plus the two ways to spend them,
    // and it is reachable only when there is a human at the other end.
    for (const line of pairingHandout({
      code,
      fingerprint,
      expiresAt: session.expiresAt,
      now,
      sessionId,
      label,
      hosts: handoutHosts(material.serverHosts, endpointHost),
      // What redemption will name, which is the chosen host when there is one
      // and this Core's primary when there is not — the same resolution
      // `core-pairing-wiring.ts` does, stated here so the block can say it.
      credentialHost: endpointHost ?? primaryPublicHost(material.serverHosts),
      port: corePort(deps, materialPath),
      color: useColor(deps),
    })) {
      deps.out(line);
    }
  } else {
    // stdout: the facts a human reads out, one labelled line each. **Not one
    // byte of this may move** — it is what every script that has ever wrapped
    // `pair new` reads, and the frame above exists precisely so that this does
    // not have to change to give an operator something better to look at.
    //
    // The one exception ever made to that rule is #414: `Endpoint host` became
    // `Address host`, because the Panel's form asks for an *address* and the
    // whole point of these labels is that an operator copies the right word
    // across. Column widths, order and the conditional are untouched, and the
    // rename is deliberate rather than drift — nothing else here may follow it.
    deps.out(`Pairing code   ${code}`);
    deps.out(`CA fingerprint ${fingerprint}`);
    deps.out(`Expires        ${absoluteTime(session.expiresAt)} (${relativeTime(session.expiresAt, now)})`);
    if (label) deps.out(`Label          ${label}`);
    // Only when it was chosen. A Core with one configured address has nothing to
    // say here, and a line that appeared on every `pair new` would be noise on
    // the terminal an operator is reading a credential off.
    if (endpointHost) deps.out(`Address host   ${endpointHost}`);
    deps.out(`Session        ${sessionId}`);
  }
  deps.err(`Cancel it before it is used with \`actana pair revoke ${sessionId}\`.`);
  return EXIT_OK;
}

/** What {@link chooseEndpointHost} returns when it has already said no. */
const REFUSED = Symbol("public-host-refused");

/**
 * The two addresses every server certificate carries and no pairing code may
 * choose (ADR 0032 D9, ADR 0038 D4).
 *
 * Named here only so the refusal can tell the truth about them. They are *not*
 * an exception list the membership check consults — the check is against the
 * operator's configured hosts and these are not on it, which is the policy.
 * What they are is the one case where "not one of this Core's configured public
 * hosts" and "not in this Core's certificate" come apart, and an operator told
 * the second about `127.0.0.1` has been told something false.
 *
 * **Not the same set as `LOOPBACK_HOSTS` in `packages/core/src/core-boot-refusals.ts`,
 * and deliberately so.** That one answers "does binding this address reach off
 * this machine?" for the daemon's plaintext-exposure refusal, so it is as wide
 * as it can be made and fails closed — `::1`, the whole of `127.0.0.0/8`, an
 * empty value. This one is exactly the pair ADR 0038 D4 puts on every
 * certificate, and it is a *record of what was signed*, not a policy: adding
 * `::1` here would claim coverage the certificate does not carry. Two questions,
 * two answers, and neither list may be swapped for the other.
 */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1"];

/**
 * Which configured address this code hands back, or {@link REFUSED}.
 *
 * `undefined` — the flag was not given — is the primary, and that is not
 * spelled here: an absent `endpointHost` on the session already means the
 * primary, resolved on the daemon side at redemption time against whatever the
 * Core is configured with *then*. Pinning the primary into the session at mint
 * would freeze an answer the operator did not choose.
 *
 * **The membership check is the design, not input validation.** A pairing code
 * may only hand back an address this Core's certificate already covers, so the
 * candidate is checked against the SAN list recorded in `material.json` — the
 * record of what was actually signed. Anything else is refused, and the refusal
 * prints the list, because an operator who typed the wrong address needs the
 * right ones more than they need to be told they were wrong.
 */
function chooseEndpointHost(
  deps: ActanaCliDeps,
  configured: readonly string[],
  values: Record<string, string | true | undefined>,
): string | undefined | typeof REFUSED {
  const requested = valueFlag(values, "public-host");
  if (requested === undefined) return undefined;

  const wanted = requested.trim();
  if (wanted.length === 0) {
    deps.err("actana pair new: --public-host needs an address.");
    return REFUSED;
  }
  if (configured.length === 0) {
    // Material written before the SAN list was recorded (pre-#347, or pre-D18).
    // There is nothing here to check membership against, and guessing would be
    // the one thing this flag exists to prevent.
    deps.err(
      "actana pair new: this Core's material does not record which addresses its " +
        "certificate covers, so --public-host cannot be checked against them.",
    );
    deps.err("Re-run `actana setup` (or restart the container) — it records them.");
    return REFUSED;
  }
  if (!isConfiguredPublicHost(configured, wanted)) {
    deps.err(
      `actana pair new: ${JSON.stringify(wanted)} is not one of this Core's configured ` +
        "public hosts.",
    );
    deps.err(
      "A pairing code can only hand back an address this Core was configured to answer " +
        `on, so that the certificate is guaranteed to cover it — otherwise the client it ` +
        "pairs would fail hostname verification on its first dial.",
    );
    // Named for wherever the operator can actually go and change it, which is
    // not the same place on both shapes of Core. In a container it is the
    // `ACTANA_PUBLIC_HOST` in their compose file; on metal that variable exists
    // nowhere at all — the list came from `--public-host` at setup and lives in
    // `actana.json` and in the unit. `core-entry.ts` keys the same choice on
    // container mode for the same reason: naming a variable the operator cannot
    // find is worse than naming none.
    const configuredBy = inContainer(deps.env)
      ? CONTAINER_PUBLIC_HOST_ENV
      : "actana setup --public-host";
    deps.err(`Configured (${configuredBy}): ${formatPublicHosts(configured)}`);
    deps.err(
      `Omit --public-host to use ${primaryPublicHost(configured)}, the first of them.`,
    );
    // `localhost` and `127.0.0.1` are on every certificate this Core signs (ADR
    // 0032 D9) and are still not selectable, so the sentence above would be
    // false about them if it were left to stand alone. The policy is deliberate
    // — ADR 0038 D4 — and the reason is reachability rather than coverage: a
    // loopback address handed to a client on another machine names that
    // client's own machine.
    if (LOOPBACK_HOSTS.includes(wanted)) {
      deps.err(
        `${wanted} is in this Core's certificate, and it is deliberately not selectable: ` +
          "handed to a client on another machine it would name that machine, not this Core. " +
          "The machine this Core runs on already reaches it on loopback without pairing.",
      );
    }
    return REFUSED;
  }
  return wanted;
}

// ─── the operator's shape (#357) ────────────────────────────────────────────
//
// `pair new` has two audiences and they want opposite things. A script wants
// labelled lines it can cut a field out of and nothing else; the person
// standing at the Core wants to know what the code is *for* and what to type
// next, on the other machine, without reassembling `actana core pair` out of
// four separate lines by hand.
//
// **The switch is `isatty(stdout)` and nothing else.** No flag, no environment
// variable, and deliberately no `--json` (#357). A pipe, a file, a `$( )` and a
// CI log all get the labelled lines, byte for byte what 0.4.2 printed, and
// `actana-pair.test.ts` asserts that against a literal rather than trusting it.
// A terminal gets the frame below. Nothing else in this command reads the
// answer — the session that was minted, the digest that was stored and the
// exit code are identical either way, because a command that *did* something
// different at a terminal is a command no script can trust.
//
// Everything here is pure: values in, lines out. That is what lets the suite
// assert on the frame without a terminal, and what keeps the decision to draw
// one in exactly one `if`.

/**
 * Every fact the handout renders. Times arrive as epoch ms and the clock does
 * not: `now` is passed in, because this file reads the clock in exactly one
 * place and it is not here.
 */
export type PairingHandout = {
  code: string;
  /** The full colon-separated hex. Wrapped below, and never shortened. */
  fingerprint: string;
  expiresAt: number;
  now: number;
  sessionId: string;
  /** `""` when the code was minted without one. */
  label: string;
  /** The addresses to offer a pasteable command for, primary first. */
  hosts: readonly string[];
  /**
   * The address the **credential** will name, whichever of {@link hosts} was
   * dialled (#357 review B2).
   *
   * Not the same question as "which address do I dial", and conflating the two
   * is the bug this field exists to spell out. The endpoint a paired client
   * keeps comes off the stored session, never off the address it dialled:
   * `core-pairing-wiring.ts` reads `session.endpointHost` and falls back to the
   * Core's primary. So a code minted with `--public-host` carries that host,
   * and a code minted without one carries the primary for *every* command in
   * the block — including the ones that dial something else.
   */
  credentialHost: string;
  port: number;
  color: boolean;
};

/**
 * The framed block, the Panel path and the terminal path, as lines.
 *
 * The order is the order of the questions an operator asks: what is the code,
 * how long have I got, what do I compare the certificate against, which session
 * is it — and then, under the frame, what do I actually do with it.
 */
export function pairingHandout(handout: PairingHandout): string[] {
  const { code, fingerprint, sessionId, label, color } = handout;
  const lines: string[] = [];

  lines.push(frameEdge("top", color));
  lines.push(frameRow([], color));
  lines.push(frameRow([{ text: "Pairing code", style: ANSI.dim }], color));
  lines.push(frameRow([], color));
  // The one line the whole command exists for, and the only one in bold cyan.
  lines.push(frameRow([{ text: `   ${code}`, style: ANSI.boldCyan }], color));
  lines.push(frameRow([], color));
  lines.push(
    frameRow(
      [
        { text: "Expires        ", style: ANSI.dim },
        {
          text: `${absoluteTime(handout.expiresAt)} (${relativeTime(handout.expiresAt, handout.now)})`,
        },
      ],
      color,
    ),
  );
  lines.push(frameRow([], color));

  /**
   * The address, in the box, because the Panel asks for it **first**.
   *
   * `PANEL_INSTRUCTION` sends the operator to a form whose first field is this
   * Core's address, and until this row the frame was the one surface that never
   * said what to put in it: `Address host` prints only down a pipe and only
   * for `--public-host`, so an operator at a terminal — the audience this
   * whole block exists for — read four values off a screen and then had to
   * work the fifth out for themselves. It sits above the fingerprint for the
   * same reason: address, then fingerprint, then session and code is the order
   * the form gates them in, and the frame should be readable top to bottom
   * into it.
   *
   * **It is `credentialHost`, not whichever address a command below dials.**
   * The endpoint a paired client keeps comes off the stored session — see
   * {@link PairingHandout.credentialHost} — so on a multi-address Core this row
   * is the one address that is true of the credential no matter which command
   * was pasted. The `# dial …` notes under `From a terminal` are what explain
   * the others; this row does not compete with them.
   */
  const credentialEndpoint = endpointAddress(handout.credentialHost, handout.port);
  const endpointLabel = "Address        ";
  const endpointRoom = FRAME_CONTENT_WIDTH - displayWidth(endpointLabel);
  if (displayWidth(credentialEndpoint) <= endpointRoom) {
    lines.push(
      frameRow([{ text: endpointLabel, style: ANSI.dim }, { text: credentialEndpoint }], color),
    );
  } else {
    // **Wrapped, never clipped**, on the same rule the fingerprint follows: an
    // address with an ellipsis in it is an address that fails to dial, and
    // `wrapText` breaks on the `:` and `.` a long hostname is built out of.
    lines.push(frameRow([{ text: "Address", style: ANSI.dim }], color));
    for (const chunk of wrapText(credentialEndpoint, FRAME_CONTENT_WIDTH - 3)) {
      lines.push(frameRow([{ text: `   ${chunk}` }], color));
    }
  }
  lines.push(frameRow([], color));
  // **Wrapped, never truncated.** The fingerprint is what the client checks the
  // certificate against before it sends the code, so a fingerprint with an
  // ellipsis in it is not a fingerprint — it is an invitation to guess.
  lines.push(frameRow([{ text: "CA fingerprint", style: ANSI.dim }], color));
  for (const chunk of wrapFingerprint(fingerprint)) {
    lines.push(frameRow([{ text: `   ${chunk}` }], color));
  }
  lines.push(frameRow([], color));
  lines.push(frameRow([{ text: "Session        ", style: ANSI.dim }, { text: sessionId }], color));
  if (label) {
    // The one row whose content has no bound: `--label` takes whatever an
    // operator wants to call a machine. Clipped to what the frame holds, and
    // it is *this* row that gives — a label is a name the operator already
    // knows and can read off `pair ls`, where the fingerprint is a value they
    // have to compare character by character (#357 review N1).
    const room = FRAME_CONTENT_WIDTH - displayWidth("Label          ");
    lines.push(
      frameRow([{ text: "Label          ", style: ANSI.dim }, { text: clip(label, room) }], color),
    );
  }
  lines.push(frameRow([], color));
  lines.push(frameEdge("bottom", color));
  lines.push("");

  // The canonical path first: most people pairing a Core are sitting in front
  // of a Panel, and the code goes straight into it.
  lines.push(style("From the Panel", FRAME_HEADING, color));
  lines.push(`  ${PANEL_INSTRUCTION}`);
  lines.push("");

  lines.push(style("From a terminal", FRAME_HEADING, color));
  lines.push("  npm i -g @actana/cli");
  lines.push("");
  // One command per address, **with the minted values already in it**. A
  // placeholder here would put the operator back where they started: reading
  // four fields off a screen and retyping them into a fifth thing.
  //
  // Each one says which endpoint the *credential* ends up naming, because for
  // every address but one that is not the address the command dials — see
  // {@link PairingHandout.credentialHost}. Saying only "reachable at X" would
  // hand an operator a command that pairs and then leaves their client pointed
  // somewhere it cannot reach, with nothing on the screen explaining why.
  // The same value the `Address` row above prints — computed once, so the box
  // and the notes can never disagree about which address the credential names.
  for (const [index, host] of handout.hosts.entries()) {
    const endpoint = endpointAddress(host, handout.port);
    for (const note of hostNotes(handout, host, endpoint, credentialEndpoint)) {
      lines.push(style(`  ${note}`, ANSI.dim, color));
    }
    lines.push(`  ${corePairCommand(handout, host)}`);
    if (index < handout.hosts.length - 1) lines.push("");
  }
  return lines;
}

/**
 * The comment lines above one pasteable command.
 *
 * Two shapes, and which one an address gets is the whole of #357 review B2:
 *
 *   - the address the credential will name — dial it, keep it, nothing to say;
 *   - any other configured address — dial it and the pairing works, but the
 *     client is left registered at `credentialEndpoint`, which on a machine
 *     that cannot reach that name is a successful pairing followed by an
 *     `actana core status` that fails for no visible reason.
 *
 * The second shape carries the fix rather than only the warning: one `pair new
 * --public-host <addr>` mints a code whose redemption hands back *that*
 * address, which is the workflow #347 and ADR 0038 designed and the one this
 * block should be teaching.
 */
function hostNotes(
  handout: PairingHandout,
  host: string,
  endpoint: string,
  credentialEndpoint: string,
): string[] {
  if (endpoint === credentialEndpoint) {
    return [`# dial ${endpoint} — and that is the endpoint this code registers`];
  }
  const label = handout.label && coreNameError(handout.label) === null ? ` --label ${handout.label}` : "";
  return [
    `# dial ${endpoint} — but this code still registers ${credentialEndpoint}`,
    `#   to register ${endpoint}: actana pair new${label} --public-host ${host}`,
  ];
}

/**
 * The Panel path, worded once, and worded from the form rather than from
 * memory (#357 review B1).
 *
 * `AddCoreByPairing.tsx` asks for things in a fixed order and gates them:
 * the **Core address** first, with a "Check fingerprint" button beside it;
 * then the **CA fingerprint**, typed and compared, and *"the Panel does not
 * send the code until they match"*; and only past a verified fingerprint does
 * step 3 exist at all — **Session**, then **Pairing code**, then an optional
 * name. An instruction that said "then enter the code" sent an operator to a
 * form that first wants an address this block never called a field, and then
 * wants the fingerprint they had just been told they did not need — while the
 * frame above prints that fingerprint prominently and never says what it is
 * for. The comparison is the security-relevant step of the whole exchange
 * (#280 step 3, #284); it is the one thing this line must not drop.
 *
 * The field is called **Add a Core**, not "Add Core": that is the string the
 * Panel renders it from (`packages/panel/src/shared/core-onboarding.ts`,
 * `ADD_CORE_FIELD_LABEL`), and this line is worded from the form. #357's issue
 * text said "Add Core" and was wrong about the field's name.
 *
 * A constant rather than an inline string because the wording is the spec, and
 * a test asserts this value rather than a regex that would go on passing after
 * somebody paraphrased it. `scripts/e2e-actana-setup-linux.mjs` pins it too:
 * both move with this line.
 */
export const PANEL_INSTRUCTION =
  "Settings (gear icon) -> Cores -> Add a Core: this Core's address, then compare the " +
  "CA fingerprint, then the session and the code";

/**
 * The line the operator pastes on the other machine.
 *
 * Every value is real: the label, the address, the code, the session and the
 * whole fingerprint. `--session` is not optional — `readTicket` on the client
 * refuses a bare code without it — and its absence from two usage strings is
 * the other half of #357.
 *
 * One line, not a backslash continuation. A continuation is one keystroke away
 * from being pasted into something that does not join it, and the whole promise
 * of this line is that it works when pasted.
 */
function corePairCommand(handout: PairingHandout, host: string): string {
  return [
    "actana core pair",
    handoutName(handout.label),
    endpointAddress(host, handout.port),
    handout.code,
    "--session",
    handout.sessionId,
    "--fingerprint",
    handout.fingerprint,
  ].join(" ");
}

/**
 * What the pasted command calls the Core.
 *
 * The `--label` when there is one and the client's registry would accept it,
 * and {@link NAME_PLACEHOLDER} otherwise. The check is `coreNameError` — the
 * client's own rule — rather than a second opinion about names written here: a
 * label with a space in it is a fine label and not a Core name, and pasting it
 * would fail on the far machine with a message about a registry nobody
 * mentioned.
 */
function handoutName(label: string): string {
  if (!label || coreNameError(label) !== null) return NAME_PLACEHOLDER;
  return label;
}

/**
 * The name slot, when there is no usable label — and it is bare `NAME` rather
 * than `<name>` for one reason (#357 review B3).
 *
 * `<name>` is not inert in a shell. Pasted into bash it is a redirection: read
 * stdin from a file called `name`, and send stdout to a file named after the
 * next word. The command never runs, and what the operator sees is
 * `bash: name: No such file or directory` — a message that names neither
 * `actana` nor the actual problem, on the one line whose whole promise is that
 * it works when pasted. It fires on `actana pair new` with no `--label`, which
 * is the documented default.
 *
 * `NAME` reads as a slot just as clearly, survives every shell, and if it is
 * pasted unedited it registers a Core called `NAME` — recoverable with one
 * `actana core rm NAME`, which a shell error is not.
 */
export const NAME_PLACEHOLDER = "NAME";

/**
 * `host:port`, with an IPv6 literal bracketed.
 *
 * The same rule `endpointFor` applies in `actana-config.ts`, for the same
 * reason: `fe80::1:8443` is not an address anything can parse.
 */
function endpointAddress(host: string, port: number): string {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${bracketed}:${port}`;
}

/**
 * The fingerprint, broken across lines on its own separators.
 *
 * Split on the colons that are already in it and re-joined, so a wrapped
 * fingerprint reads as the same value with a line break in it: every line but
 * the last ends with the separator, which is what tells a reader there is more.
 * Nothing is dropped — this function cannot shorten its input, which is the
 * property that matters.
 */
export function wrapFingerprint(fingerprint: string, groupsPerLine = 16): string[] {
  const groups = fingerprint.split(":");
  const perLine = Math.max(1, groupsPerLine);
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i += perLine) {
    const last = i + perLine >= groups.length;
    lines.push(groups.slice(i, i + perLine).join(":") + (last ? "" : ":"));
  }
  return lines;
}

/**
 * The addresses the handout offers a command for, primary first.
 *
 * When `--public-host` chose one, it is the only one: the credential redemption
 * hands back carries *that* endpoint, and offering the others would be offering
 * commands whose paired client then dials an address this code did not choose.
 * Otherwise it is the whole configured list in the operator's order, which is
 * the order the primary is first in (#347).
 *
 * A Core whose material predates the SAN list having been recorded has no list
 * to offer, and falls back to what `primaryPublicHost` falls back to rather
 * than printing a command with an empty address in it.
 */
function handoutHosts(configured: readonly string[], chosen: string | undefined): string[] {
  if (chosen) return [chosen];
  return configured.length > 0 ? [...configured] : [primaryPublicHost(configured)];
}

/**
 * The port the pasteable command dials.
 *
 * In a container it is the one the contract names — `ACTANA_PORT`, or 8443
 * when it is unset — because there is no `actana.json` there. On metal it is
 * what `actana setup` recorded beside the material, which is the directory
 * `materialPath` points into. A config that cannot be read falls back to the
 * documented default rather than refusing to print the command: an operator
 * with a wrong port in front of them can fix it, and one with no command at all
 * cannot.
 */
function corePort(deps: ActanaCliDeps, materialPath: string): number {
  if (inContainer(deps.env)) {
    const raw = deps.env[CONTAINER_PORT_ENV]?.trim();
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
      ? parsed
      : DEFAULT_CONTAINER_PORT;
  }
  return readActanaConfig(path.dirname(materialPath))?.port ?? DEFAULT_CONTAINER_PORT;
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
