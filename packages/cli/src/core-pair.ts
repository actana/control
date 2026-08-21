// `actana core pair <name> <address> <code>` — enrollment from the client's
// side (#280, #285).
//
// **You are on the machine being paired.** Somebody on the Core ran `actana
// pair new` and read out three things: a pairing code, that Core's CA
// fingerprint, and the session the code belongs to. This is what this machine
// does with them, and it is the exact counterpart of `actana-pair.ts`, which is
// the *Core* end of the same exchange and lives in the same binary (#288). The
// help text on each says which machine it runs on, because the only thing
// separating the two commands is which words the operator types.
//
// **What this verb is, structurally: the old `actana core add` with a different
// way of coming by the credential.** Everything after the credential lands is
// deliberately unchanged — the same `writeCoreBlob` at mode 0600 under the same
// cores directory, the same `current` pointer rule, the same name validation,
// the same replace-in-place behaviour. `core-resolution.ts`, `core-connection.ts`
// and every verb built on them could not tell a paired credential from a pasted
// one, and that was the whole design: #285 replaced a *gesture*, not a storage
// format, which is what let #287 delete the paste path outright and leave every
// verb below untouched. **This is now the only way a credential enters this
// registry from outside the machine.**
//
// **No crypto happens in this file.** The key pair is born inside the SDK call,
// on this machine, and its private half never crosses the wire — see
// `@actana/sdk/core-pairing.ts`, which is also where the fingerprint comparison
// and the pinned second connection live. This module supplies an address, a
// code and an expected fingerprint, and turns whatever comes back into a
// registry entry, a sentence and an exit code. The one piece of parsing it does
// reach for is the SDK's own `parsePairingTicket`, which is the normaliser from
// #281 as a client sees it: hyphens and case are the operator's business and
// the Core's alphabet is nobody's business here.
//
// **The fingerprint is never assumed.** Either the operator passes
// `--fingerprint`, or — on a terminal — this prints the one the Core presents
// and asks them to compare it with what `actana pair new` printed. There is no
// third path and no flag that skips it: an unconfirmed fingerprint refuses with
// {@link EXIT_PAIR_FINGERPRINT_UNCONFIRMED} and, as the SDK's own contract puts
// it, **absent is not waived**. The code is not sent in either refusal.
//
// **Nothing secret reaches an output sink, `--verbose` included** — not the
// credential, not the private key, and not the pairing code. The code is the
// one addition to that rule this ticket makes: it is a bearer secret for as
// long as its session is open, so it is not echoed back in a confirmation, not
// quoted in a diagnostic, and not written into a verbose line. That is why the
// two shape errors below are worded here rather than relayed from the SDK,
// whose `bad-code` message quotes what it was handed — correct for a library
// whose caller decides where text goes, wrong for a CLI whose stderr is a
// terminal, a CI log and a shell history at once.

import {
  CorePairingError,
  fetchCorePairingIdentity,
  pairWithCore,
  parsePairingTicket,
  type CorePairingErrorDetail,
  type CorePairingFailure,
  type CorePairingIdentity,
  type PairWithCoreOptions,
} from "@actana/sdk/core-pairing.ts";
import type { CoreRegistrationBlob } from "@actana/sdk/core-registration-blob.ts";
import {
  coreExists,
  coreNameError,
  readCurrentCore,
  writeCoreBlob,
  writeCurrentCore,
  type RegistryPaths,
} from "./blob-registry.ts";
import { encodeRegistrationBlobText } from "./registration-blob-file.ts";
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_PAIR_CERTIFICATE_INVALID,
  EXIT_PAIR_CORE_ERROR,
  EXIT_PAIR_FINGERPRINT_MISMATCH,
  EXIT_PAIR_FINGERPRINT_UNCONFIRMED,
  EXIT_PAIR_HOSTNAME_MISMATCH,
  EXIT_PAIR_MALFORMED_RESPONSE,
  EXIT_PAIR_NO_CA,
  EXIT_PAIR_NOT_PAIRABLE,
  EXIT_PAIR_RATE_LIMITED,
  EXIT_PAIR_REFUSED,
  EXIT_PAIR_REJECTED,
  EXIT_PAIR_UNREACHABLE,
  EXIT_USAGE,
} from "./exit-codes.ts";
import type { ActanaCliDeps } from "./cli-deps.ts";
import type { ParsedArgs } from "./cli-args.ts";

/**
 * How this verb reaches a Core it has no credential for yet. Injected, for the
 * same reason `probe` and `connect` are: the surface — flags, prompts, output,
 * exit codes, what lands in the registry — is exercised without a Core.
 *
 * One port with two calls rather than two ports, because the two calls are one
 * exchange and the SDK is explicit that they must agree: the fingerprint an
 * operator confirms through {@link CorePairingPort.identify} has to be computed
 * by the same code that later enforces it inside {@link CorePairingPort.pair},
 * and a fake that answered one without the other would be testing a flow that
 * cannot happen.
 */
export type CorePairingPort = {
  /** Dial with nothing trusted and report the CA presented. Sends no code. */
  identify: (opts: { address: string; timeoutMs?: number }) => Promise<CorePairingIdentity>;
  /** Verify the fingerprint, then redeem the code. Returns the issued credential. */
  pair: (opts: PairWithCoreOptions) => Promise<CoreRegistrationBlob>;
};

/** The real port: the SDK's two functions, bound and nothing else. */
export const sdkCorePairing: CorePairingPort = {
  identify: fetchCorePairingIdentity,
  pair: pairWithCore,
};

/**
 * `actana core pair <name> <address> <code>`.
 *
 * `rest` is the positionals after `pair`. The order is the order it is read
 * out: what this machine will call the Core, where the Core is, and the code.
 */
export async function runCorePair(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  paths: RegistryPaths,
  rest: string[],
): Promise<number> {
  const [name, address, code, ...extra] = rest;
  if (name === undefined || address === undefined || code === undefined) {
    deps.err("actana core pair: a name, an address and a code are required.");
    deps.err("  actana core pair <name> <host:port> <code> --fingerprint <sha256>");
    deps.err("`actana pair new` on the Core prints the code and the fingerprint.");
    return EXIT_USAGE;
  }
  if (extra.length > 0) {
    // Never the value: an operator who typed the code twice, or put it after
    // the address a second time, would have it echoed back at them.
    deps.err("actana core pair: too many arguments — expected <name> <address> <code>.");
    return EXIT_USAGE;
  }

  // The registry's own name validation, first and with its own wording: a name
  // this registry will not take is a name none of `ls`, `use`,
  // `rm`, `status`, `shell` or `exec` could reach afterwards.
  const nameError = coreNameError(name);
  if (nameError) {
    deps.err(`actana core pair: ${nameError}.`);
    return EXIT_USAGE;
  }

  // The ticket first, before anything is dialled and before an operator is
  // asked to compare a fingerprint: a code that cannot be a code will not
  // become one after a round trip, and failing here means it never spends one
  // of the five attempts the Core's session has.
  const ticket = readTicket(deps, code, args.session);
  if (!ticket.ok) return ticket.exit;
  deps.verbose(`pairing session ${ticket.sessionId}`);

  const confirmed = await confirmFingerprint(deps, args, address);
  if (!confirmed.ok) return confirmed.exit;

  let blob: CoreRegistrationBlob;
  try {
    deps.verbose(`redeeming the code at ${address} over a connection pinned to that certificate authority`);
    blob = await deps.pairing.pair({
      address,
      // The normalised code, not what was typed: `parsePairingTicket` is the
      // SDK's public door onto #281's normaliser, and passing its answer back
      // in is what makes "hyphenated or not, upper or lower case" one rule
      // rather than two implementations of one.
      code: ticket.code,
      sessionId: ticket.sessionId,
      expectedCaFingerprint: confirmed.fingerprint,
      // What this machine will be called in the operator's `actana pair ls`.
      // The hostname is the honest default: the Core lists it beside a
      // certificate serial, and "unnamed" beside three of them is a list an
      // operator cannot revoke from.
      label: args.label ?? deps.hostname,
      platform: deps.platform,
    });
  } catch (err) {
    return reportPairingFailure(deps, err);
  }

  // Past here the credential exists on this machine and nowhere else it did not
  // already exist: the private key was generated locally and the Core never had
  // it. What is left is the storage half.
  const replacing = coreExists(paths, name);
  // The label goes to the Core and stops there. `pairWithCore` copies whatever
  // label it was handed straight into the blob it returns, and the LABEL column
  // of `actana core ls` means *the Core's* own alias — the one `actana setup`
  // puts in the entry it writes for a machine's own Core. Storing this machine's
  // name there would put the
  // client's hostname in a column about the other end of the link, so a paired
  // credential is stored with no alias at all and the column stays empty until
  // a Core has something to say for itself.
  writeCoreBlob(paths, name, encodeRegistrationBlobText({ ...blob, label: "" }));
  deps.verbose(`stored at ${paths.coresDir}/${name}.txt, mode 0600`);

  const current = readCurrentCore(paths);
  if (current === null) writeCurrentCore(paths, name);

  deps.out(`${replacing ? "Replaced" : "Paired"} Core "${name}" → ${blob.endpoint}`);
  if (current === null) deps.out(`\`current\` now points at "${name}".`);
  else if (current !== name) {
    deps.out(`\`current\` is still "${current}" — \`actana core use ${name}\` to switch.`);
  }
  return EXIT_OK;
}

/** A ticket that parsed, or the exit code for the sentence already printed. */
type TicketResult = { ok: true; sessionId: string; code: string } | { ok: false; exit: number };

/**
 * Read the code and the session it names — without ever printing either.
 *
 * Two spellings, because #283 prints the session id on its own line and an
 * operator may be handed either it or a joined `<session>:<XXXX-XXXX>` string.
 * Which of the two they get is #280's to settle; both work here, and the SDK
 * accepts both for the same reason.
 */
function readTicket(deps: ActanaCliDeps, code: string, session: string | null): TicketResult {
  // The two session ids, read the way `parsePairingTicket` reads them. Split
  // out here rather than inferred from `code.includes(":")`, because a
  // `bad-code` covers two different mistakes and the operator has to be told
  // which of them they made: "the ids disagree" and "that is not a code" have
  // opposite fixes, and sending somebody to drop a `--session` that was right
  // all along is worse than saying nothing.
  const separator = code.indexOf(":");
  const carried = separator === -1 ? "" : code.slice(0, separator).trim();
  const explicit = session?.trim() ?? "";

  if (carried === "" && explicit === "") {
    deps.err("actana core pair: a pairing code names the pairing session it belongs to.");
    deps.err("Pass `--session <id>` — `actana pair new` prints it beside the code — or the <session>:<code> form.");
    return { ok: false, exit: EXIT_USAGE };
  }
  if (carried !== "" && explicit !== "" && carried !== explicit) {
    deps.err("actana core pair: the code names one pairing session and `--session` names another.");
    deps.err("Drop `--session`, or pass the bare code beside it — they have to agree.");
    return { ok: false, exit: EXIT_USAGE };
  }

  try {
    const ticket = parsePairingTicket(code, session ?? undefined);
    return { ok: true, sessionId: ticket.sessionId, code: ticket.code };
  } catch (err) {
    // Every remaining `bad-code` is a shape, the ids having been checked above.
    if (err instanceof CorePairingError && err.failure === "bad-code") return { ok: false, exit: badCode(deps) };
    throw err;
  }
}

/**
 * The one sentence this package writes about a code that is not one.
 *
 * It is written here rather than relayed from the SDK, whose message ends
 * `— "ABCD-2345" is not`: correct for a library whose caller decides where text
 * goes, and wrong for a CLI whose stderr is a terminal, a CI log and a shell
 * history at once. One function for it because there are two ways to arrive —
 * the ticket read here, and a `bad-code` raised inside `pairWithCore`, which
 * parses the ticket again — and a rule kept in one of two places is a rule that
 * holds until somebody touches the other.
 */
function badCode(deps: ActanaCliDeps): number {
  const outcome = corePairingOutcome("bad-code");
  deps.err("actana core pair: that was not accepted as a pairing code — hyphen and case do not matter, its shape does.");
  deps.err(outcome.next);
  return outcome.exit;
}

/** A fingerprint the operator stands behind, or the exit code for the refusal. */
type FingerprintResult = { ok: true; fingerprint: string } | { ok: false; exit: number };

/**
 * Get the fingerprint the operator was read out — from the flag, or from them.
 *
 * The flag is the scriptable path and the prompt is the interactive one, and
 * there is no third. With neither, this refuses rather than pairing: the SDK
 * would refuse too, and refusing here costs an operator on a pipe one dial less
 * and says the same thing.
 *
 * The prompt is a comparison, not a decision: what is printed is the
 * fingerprint *this Core presents*, and the question is whether it matches the
 * one on the Core's terminal. An operator who answers yes has done the check
 * that makes the first dial verifiable; one who answers no has caught either an
 * impersonation or a Core that has been reissued since they wrote the
 * fingerprint down, and either way no code has been sent.
 */
async function confirmFingerprint(
  deps: ActanaCliDeps,
  args: ParsedArgs,
  address: string,
): Promise<FingerprintResult> {
  if (args.fingerprint !== null) {
    deps.verbose("checking the certificate authority against the fingerprint given on the command line");
    return { ok: true, fingerprint: args.fingerprint };
  }
  if (!deps.interactive) {
    deps.err("actana core pair: no fingerprint was given and there is no terminal to confirm one on.");
    deps.err(corePairingOutcome("fingerprint-unconfirmed").next);
    return { ok: false, exit: EXIT_PAIR_FINGERPRINT_UNCONFIRMED };
  }

  let identity: CorePairingIdentity;
  try {
    deps.verbose(`dialling ${address} with nothing trusted yet, to read the certificate authority it presents`);
    identity = await deps.pairing.identify({ address });
  } catch (err) {
    // Nothing has been sent on this connection and nothing was going to be:
    // the failure is the same failure `pair` would have reported one dial
    // later, so it is reported the same way.
    return { ok: false, exit: reportPairingFailure(deps, err) };
  }

  deps.out(`${identity.httpsOrigin} presents a certificate authority with this fingerprint:`);
  deps.out(`  ${identity.fingerprint}`);
  const matches = await deps.system.confirm(
    "Is that the fingerprint `actana pair new` printed on the Core?",
    false,
  );
  if (!matches) {
    deps.err("actana core pair: the fingerprint was not confirmed, so the pairing code was not sent.");
    deps.err(corePairingOutcome("fingerprint-mismatch").next);
    // A human comparing two strings and saying they differ is a mismatch, and
    // it exits as one: the operator has performed exactly the check the SDK
    // performs when it is given a fingerprint to hold the Core to.
    return { ok: false, exit: EXIT_PAIR_FINGERPRINT_MISMATCH };
  }
  // The confirmed value is handed back to `pair`, which dials again and
  // re-computes it: what the operator agreed to is enforced on the connection
  // the code actually crosses, not merely on the one they were shown.
  return { ok: true, fingerprint: identity.fingerprint };
}

/**
 * Turn a failed pairing into one sentence, one next step and one exit code.
 *
 * Everything but a `CorePairingError` is a defect rather than an operator
 * error, and it is reported as {@link EXIT_FAILURE} without a next step to
 * offer: there is nothing for an operator to do differently about a bug here.
 */
function reportPairingFailure(deps: ActanaCliDeps, err: unknown): number {
  if (!(err instanceof CorePairingError)) {
    const message = err instanceof Error ? err.message : String(err);
    deps.err(`actana core pair: pairing failed — ${message}`);
    return EXIT_FAILURE;
  }
  // `bad-code` is the one failure whose message is not relayed, because the
  // SDK's quotes the code — see {@link badCode}. Reaching it from here means
  // `pairWithCore` refused a ticket this file had already normalised, which
  // nothing does today and something will the moment the SDK tightens its shape
  // check (it says as much, and calls the stop deliberate). The rule should not
  // wait for that.
  if (err.failure === "bad-code") return badCode(deps);

  const outcome = corePairingOutcome(err.failure, err.detail);
  deps.err(`actana core pair: ${err.message}`);
  deps.err(outcome.next);
  return outcome.exit;
}

/** What an operator should do next about a failure, and what this process exits with. */
export type CorePairingOutcome = {
  /** The code from `exit-codes.ts`. Contract: a script may branch on it. */
  exit: number;
  /** One line saying what to do next. Never quotes the code or any credential. */
  next: string;
};

/**
 * Every failure the SDK distinguishes, given a number and a next step.
 *
 * One `switch` with no `default`, so a failure added to `CorePairingFailure`
 * stops this file compiling until somebody decides what an operator should do
 * about it — which is the only way a list like this stays honest.
 */
export function corePairingOutcome(
  failure: CorePairingFailure,
  detail: CorePairingErrorDetail = {},
): CorePairingOutcome {
  switch (failure) {
    case "bad-address":
      return {
        exit: EXIT_USAGE,
        next: "An address is host:port — the Core's TLS port, the one `actana status` reports on the Core.",
      };
    case "bad-code":
      return {
        exit: EXIT_USAGE,
        next: "A pairing code is eight characters, written XXXX-XXXX. `actana pair new` prints a fresh one.",
      };
    case "bad-fingerprint":
      return {
        exit: EXIT_USAGE,
        next: "A fingerprint is 32 bytes of hex, as AA:BB:… — copy the line `actana pair new` printed.",
      };
    case "unreachable":
      return {
        exit: EXIT_PAIR_UNREACHABLE,
        next: "Check the Core is running and that address reaches it — `actana status` on the Core says where it listens.",
      };
    case "not-pairable":
      return {
        exit: EXIT_PAIR_NOT_PAIRABLE,
        next: "Something answered there but it has no pairing endpoint — check it is a Core, and update it if it is old.",
      };
    case "no-ca-presented":
      return {
        exit: EXIT_PAIR_NO_CA,
        next: "Nothing was presented to compare against the fingerprint — check the address is the Core's own TLS port.",
      };
    case "fingerprint-unconfirmed":
      return {
        exit: EXIT_PAIR_FINGERPRINT_UNCONFIRMED,
        next: "Pass `--fingerprint <sha256>` — the code is never sent to a certificate authority nobody confirmed.",
      };
    case "fingerprint-mismatch":
      return {
        exit: EXIT_PAIR_FINGERPRINT_MISMATCH,
        next:
          "Do not retry until you know why: either that is not the Core you were told about, or its credentials " +
          "were reissued and the fingerprint you have is stale. `actana pair new` prints the current one.",
      };
    case "hostname-mismatch":
      return {
        exit: EXIT_PAIR_HOSTNAME_MISMATCH,
        next: "That is the right Core on an address its certificate does not cover — dial the one it was set up for.",
      };
    case "certificate-invalid":
      return {
        exit: EXIT_PAIR_CERTIFICATE_INVALID,
        next: "The right Core, with a certificate that cannot be used — check the clock on both machines, then reissue it.",
      };
    case "refused":
      return {
        exit: EXIT_PAIR_REFUSED,
        next: "Ask for a fresh code — `actana pair new` on the Core. Its audit log says which of the four this was.",
      };
    case "rate-limited":
      return {
        exit: EXIT_PAIR_RATE_LIMITED,
        next:
          detail.retryAfterSeconds === undefined
            ? "Wait, then try again with a fresh code."
            : `Wait ${detail.retryAfterSeconds} seconds, then try again with a fresh code.`,
      };
    case "rejected":
      return {
        exit: EXIT_PAIR_REJECTED,
        next: "The Core would not accept the request itself — that is a bug on this side. Please report it.",
      };
    case "core-error":
      return {
        exit: EXIT_PAIR_CORE_ERROR,
        next: "The Core failed while handling this — `actana logs` on the Core has the reason; nothing here does.",
      };
    case "malformed-response":
      return {
        exit: EXIT_PAIR_MALFORMED_RESPONSE,
        next: "Something answered that is not a Core, or is not one this build understands. Check the address.",
      };
  }
}
