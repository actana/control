// What `actana core pair` says when it is done — the success block, and every
// class of refusal (#360).
//
// **The client end of #357.** `actana pair new` grew two shapes on the Core:
// labelled lines down a pipe, a framed handout at a terminal, with `isatty`
// as the whole of the switch. This is the same command one machine over. The
// operator has just carried a code, a fingerprint and a session across the
// room, and the moment they find out whether it worked is the moment that most
// needs to say what to do next — on success because there is a Core to use now
// and nothing on the screen saying how, and on failure because "refused" is
// the same word for an expired code, a spent one and a typo.
//
// **Everything here is pure: values in, lines out.** No `deps`, no clock, no
// filesystem, no decision about whether to draw. `core-pair.ts` owns the one
// `if` that reads `stdoutIsTty`, and this module cannot see it — which is what
// lets the suite assert on a frame without a terminal, and what keeps the
// piped path provably a different set of strings rather than the same strings
// with the ornaments stripped off.
//
// **The piped contract lives in `core-pair.ts`, not here.** Nothing in this
// file is ever printed when stdout is not a terminal: down a pipe the command
// emits exactly the lines 0.4.2 emitted, and `core-pair.test.ts` asserts them
// whole against a literal. Adding a line here cannot move a byte of that.
//
// **Nothing secret reaches these strings.** Not the credential, not the private
// key, and not the pairing code — the code is a bearer secret for as long as
// its session is open, so it is not echoed in a confirmation and not quoted in
// a diagnostic. That is why every "mint a fresh one" step below names the
// command rather than the value, and why the success block says where the
// credential landed and never what is in it.

import {
  ANSI,
  clip,
  frameEdge,
  FRAME_CONTENT_WIDTH,
  FRAME_HEADING,
  frameRow,
  style,
  wrapText,
  type Span,
} from "./cli-frame.ts";
import type { CorePairingErrorDetail, CorePairingFailure } from "@actana/sdk/core-pairing.ts";
import {
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

/**
 * One thing to do next: the line to type, and why.
 *
 * The command comes first and unstyled, because it is the thing that gets
 * selected with a mouse — dimming a line an operator is about to copy is how a
 * terminal theme turns an instruction into something unreadable. The note is
 * indented under it and dim, because it is read once.
 *
 * A step with no command is prose that earns its place: a warning, or a fact
 * that changes what the operator should type rather than being typed itself.
 */
export type CorePairStep = {
  /** The line to type, exactly as it should be typed. Never styled. */
  command?: string;
  /** What it is for. Wrapped, dim. */
  note: string;
};

/** How wide the prose under a frame may run. No border to keep it inside. */
const PROSE_WIDTH = 76;

/** The column the success block's values start in. */
const FIELD_WIDTH = 13;

/**
 * The command that mints a replacement, which is the answer to half the
 * failures below.
 *
 * One constant because it is one instruction: an expired code, a spent code, a
 * code the Core has never heard of and a fingerprint that has moved on all end
 * the same way — somebody walks back to the Core and mints a new one. The
 * three values that come back travel together, which is the part an operator
 * gets wrong: re-running with a new code and yesterday's `--session` fails in
 * exactly the way that sent them here.
 */
const REMINT = "actana pair new --label <name>";

/** The usage line, as `core-pair.ts` and `CORE_HELP` both print it. */
const PAIR_USAGE = "actana core pair <name> <host:port> <code> --session <id> --fingerprint <sha256>";

/** The same call with the session carried inside the code instead. */
const PAIR_USAGE_JOINED = "actana core pair <name> <host:port> <session>:<code> --fingerprint <sha256>";

/** The step every re-mint ends with. Stated once; it is the same mistake each time. */
const REMINT_RERUN: CorePairStep = {
  note:
    "Re-run with the NEW code, the NEW --session and the fingerprint printed beside them. A code and " +
    "its session are one credential — the old session will not redeem the new code.",
};

// ─── the success block ──────────────────────────────────────────────────────

/**
 * Everything the success block renders.
 *
 * `current` is the pointer **read back after the write**, not the name that was
 * just paired and not a guess about what the write did. `core pair` makes a
 * Core current only when nothing was, so on any machine with a Core already
 * registered the honest answer is "no" — and a block that congratulated an
 * operator on a `current` they do not have would send them to `core status`
 * against the wrong Core, which is the confusion this whole ticket is about.
 */
export type CorePairSuccess = {
  name: string;
  endpoint: string;
  /** Whether a Core of this name was already registered. Chooses one word. */
  replaced: boolean;
  /**
   * The name this machine put in the pairing request — `--label`, or its
   * hostname when the flag was not given.
   *
   * **A purely local fact, and the row is worded to claim nothing else**
   * (#366 review 2). The first version of this row said it was "this machine,
   * in the Core's `pair ls`", and that is false: `core-pairing-routes.ts`
   * builds `PairedClient.label` from **`session.label`** — the name the *Core*
   * operator typed at `actana pair new --label <name>` — and this value
   * reaches the Core only as the certificate CN, and only in the sub-case
   * where the session carried no label at all. `actana pair revoke` matches on
   * `client.label` and on a `CN=`-prefixed subject, so it would not have found
   * this name either. A row whose stated purpose was revocation and which
   * could not be revoked by is worse than no row.
   *
   * What it is good for is the case an operator did not choose: no `--label`,
   * so this machine sent its hostname and nothing on the screen said so. That
   * is a fact about **this** side, it is checkable here, and it is all this
   * row now says.
   */
  label: string;
  /** What `current` names now. `null` when nothing does. */
  current: string | null;
  /** Where the credential landed. The path, at mode 0600 — never the contents. */
  credentialPath: string;
  color: boolean;
};

/**
 * The framed confirmation, and the next steps under it.
 *
 * The frame answers "what just happened" and the section under it answers "what
 * do I do now", which is the same division `pair new`'s handout uses: facts
 * inside the border, commands outside it where they are long enough to need the
 * room and must survive being copied.
 */
export function corePairSuccessBlock(result: CorePairSuccess): string[] {
  const { color } = result;
  const isCurrent = result.current === result.name;
  const lines: string[] = [];

  lines.push(frameEdge("top", color));
  lines.push(frameRow([], color));
  lines.push(
    frameRow(
      [
        { text: "✓ ", style: ANSI.green },
        { text: `${result.replaced ? "Replaced" : "Paired"} Core "${result.name}"` },
      ],
      color,
    ),
  );
  lines.push(frameRow([], color));
  lines.push(...field("Address", result.endpoint, color));
  // "Sent as", not "Label", because there are two LABEL columns in this
  // program already — `core ls`'s, which means the *Core's* own alias, and
  // `pair ls`'s on the Core, which means the *session's*. This is neither. It
  // is what left this machine, and the row says only that.
  //
  // Clipped, and it is this row that gives: it is a name the operator either
  // typed or can read off `hostname`, where every other value here is one they
  // have to be able to copy.
  lines.push(...field("Sent as", `${clip(result.label, 30)} — the name this machine gave`, color));
  lines.push(...field("Current", currentSentence(result, isCurrent), color));
  // Reassurance, not a secret: the operator has just been told a credential
  // exists and has no way to see that it does. The path and the mode are the
  // whole of what can be said about it — the blob itself never reaches an
  // output sink, `--verbose` included.
  lines.push(...field("Credential", `${result.credentialPath} (mode 0600)`, color));
  lines.push(frameRow([], color));
  lines.push(frameEdge("bottom", color));
  lines.push("");

  lines.push(style("Next steps", FRAME_HEADING, color));
  lines.push(...stepLines(nextSteps(result, isCurrent), color));
  return lines;
}

/**
 * What the `Current` row says, which is a claim this block has to have earned.
 *
 * Three answers, and the middle one is the reason the field exists: pairing a
 * second Core on a machine that already has one changes nothing about
 * `current`, and the operator's very next command will talk to the other Core
 * unless this line tells them so.
 *
 * **The third is defensive and says so** (#366 review 7). `runCorePair` writes
 * the pointer when nothing holds it and then reads it back, so a `null` here
 * means the pointer was cleared between those two lines — a concurrent
 * `actana core rm`, or a registry that has gone missing underneath the write.
 * Rare, not impossible, and the honest thing to print is that nothing is
 * selected rather than a name that is not. It is unreachable through the verb,
 * so the suite renders it by calling this block directly: a branch nothing
 * exercises is a branch nobody knows the shape of.
 */
function currentSentence(result: CorePairSuccess, isCurrent: boolean): string {
  if (isCurrent) return `"${result.name}" — every later verb talks to this Core`;
  if (result.current === null) return "nothing is selected yet";
  return `still "${result.current}" — this pairing did not change it`;
}

/**
 * The four verbs a freshly paired Core exists for, in the order they are useful.
 *
 * Verify, then look around, then do something: `core status` is the one that
 * says the link works at all, `project ls` and `harness ls` are the two things
 * a Session needs to name, and `session start` is the first real action. An
 * operator who has just carried a code across a room has earned a screen that
 * does not make them go and read the help.
 */
function nextSteps(result: CorePairSuccess, isCurrent: boolean): CorePairStep[] {
  const steps: CorePairStep[] = [];
  if (!isCurrent) {
    // First, because every verb below it reads `current`, and running them
    // now would report on a Core the operator did not just pair.
    steps.push({
      command: `actana core use ${result.name}`,
      note: "Point `current` at it. Everything below talks to `current` until you do, or pass --core each time.",
    });
  }
  steps.push({
    command: "actana core status",
    note: "Reach the Core and report what it says. The check that the link works end to end.",
  });
  steps.push({
    command: "actana project ls",
    note: "The Projects on this Core. A Session needs one to run in.",
  });
  steps.push({
    command: "actana harness ls",
    note: "Which agents this Core can actually run right now, and which it is missing.",
  });
  steps.push({
    command: 'actana session start <project> "<prompt>"',
    note: "The first real thing to run on it. Prints the Session id and exits.",
  });
  // Named in #360 beside `session start` as the other first real action, and
  // dropped from the first cut of this list — silently, which is the part the
  // review was right about (#366 review 4). It is the interactive half of the
  // same idea: `session start` hands work to an agent, `core shell` puts the
  // operator on the machine themselves.
  steps.push({
    command: "actana core shell",
    note: "Or an interactive shell on the Core, to look around it yourself.",
  });
  steps.push({
    note:
      "The Panel pairs with this same Core from its Settings -> Cores screen, with a code of its own — " +
      "`actana pair new` on the Core mints that one too.",
  });
  return steps;
}

// ─── the refusals ───────────────────────────────────────────────────────────

/** A framed refusal: what happened, and what to do about it. */
export type CorePairRefusal = {
  /**
   * What went wrong, beside the marker.
   *
   * Wrapped rather than assumed to fit, because for most classes this is the
   * SDK's own sentence and the SDK writes for a library's caller, not for a
   * 74-column box. A headline that ran off the border would be the one line on
   * the screen an operator cannot read.
   */
  headline: string;
  /** Anything further, as paragraphs, wrapped inside the frame. May be empty. */
  detail: readonly string[];
  /** What to do next. Never empty — a refusal with no remedy is the bug #360 fixes. */
  steps: readonly CorePairStep[];
  color: boolean;
};

/**
 * The framed refusal, and the steps under it.
 *
 * The same shape as the success block on purpose. An operator who has seen one
 * has seen the other, and the marker is the only thing they have to read to
 * know which of the two they are looking at.
 */
export function corePairRefusalBlock(refusal: CorePairRefusal): string[] {
  const { color } = refusal;
  const lines: string[] = [];

  lines.push(frameEdge("top", color));
  lines.push(frameRow([], color));
  // The marker takes two columns, so the wrap is measured against what is left
  // and the continuations line up under the first word rather than under the ✗.
  const headline = wrapText(refusal.headline, FRAME_CONTENT_WIDTH - 2);
  for (const [index, line] of headline.entries()) {
    const spans: Span[] =
      index === 0 ? [{ text: "✗ ", style: ANSI.red }, { text: line }] : [{ text: `  ${line}` }];
    lines.push(frameRow(spans, color));
  }
  for (const paragraph of refusal.detail) {
    lines.push(frameRow([], color));
    for (const line of wrapText(paragraph, FRAME_CONTENT_WIDTH)) {
      lines.push(frameRow([{ text: line }], color));
    }
  }
  lines.push(frameRow([], color));
  lines.push(frameEdge("bottom", color));
  lines.push("");

  lines.push(style("What to do", FRAME_HEADING, color));
  lines.push(...stepLines(refusal.steps, color));
  return lines;
}

// ─── the failure table ──────────────────────────────────────────────────────

/** What an operator should do next about a failure, and what this process exits with. */
export type CorePairingOutcome = {
  /** The code from `exit-codes.ts`. Contract: a script may branch on it. */
  exit: number;
  /**
   * One line saying what to do next. Never quotes the code or any credential.
   *
   * **This is the piped shape and it may not move.** It is the second of the two
   * lines a redirected `core pair` writes to stderr, it is what every script
   * that has ever grepped a pairing failure reads, and the framed block exists
   * precisely so that it does not have to change to give an operator more.
   */
  next: string;
  /**
   * The same advice as commands, for the framed shape only.
   *
   * Every entry is reachable — a step that names a flag nobody has or a verb
   * that does not exist is worse than the prose it replaced, because prose does
   * not look like something to paste.
   */
  steps: readonly CorePairStep[];
};

/**
 * Every failure the SDK distinguishes, given a number, a next step and a remedy.
 *
 * One `switch` with no `default`, so a failure added to `CorePairingFailure`
 * stops this file compiling until somebody decides what an operator should do
 * about it — which is the only way a list like this stays honest.
 *
 * The `steps` are the #360 half. The rule they follow: **each distinguishable
 * failure gets its own concrete remedy**, not a shared one. "Ask for a fresh
 * code" and "check the port is open" are the correct answers to two different
 * problems, and a table that gave both answers to both would be back where the
 * prose started.
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
        steps: [
          {
            note:
              "An address is host:port and nothing else — not a URL, not a bare hostname, and not the " +
              "Panel's port.",
          },
          {
            command: "actana status",
            note: "On the Core: it reports the address and the TLS port that Core actually listens on.",
          },
        ],
      };
    case "bad-code":
      return {
        exit: EXIT_USAGE,
        next: "A pairing code is eight characters, written XXXX-XXXX. `actana pair new` prints a fresh one.",
        steps: [
          {
            note:
              "A pairing code is eight characters, written XXXX-XXXX. Hyphen and case are yours to get " +
              "wrong; the shape is not. Nothing was dialled and no attempt was spent.",
          },
          {
            command: REMINT,
            note: "On the Core: mints a fresh code and prints the session and fingerprint that belong to it.",
          },
          REMINT_RERUN,
        ],
      };
    case "bad-fingerprint":
      return {
        exit: EXIT_USAGE,
        next: "A fingerprint is 32 bytes of hex, as AA:BB:… — copy the line `actana pair new` printed.",
        steps: [
          {
            note:
              "A fingerprint is 32 bytes of hex written AA:BB:… — copy the whole line, colons included, " +
              "with nothing elided. `pair new` wraps it and never shortens it, so what is on that screen " +
              "is the whole value.",
          },
          { command: REMINT, note: "On the Core: prints the current fingerprint again if the line was lost." },
        ],
      };
    case "unreachable":
      return {
        exit: EXIT_PAIR_UNREACHABLE,
        next: "Check the Core is running and that address reaches it — `actana status` on the Core says where it listens.",
        steps: [
          {
            // The distinction the whole class turns on: a dial that never
            // landed has spent nothing, so the code in the operator's hand is
            // still good and re-minting one would be wasted effort.
            //
            // **Scoped, because this class is not only the dial** (#366 review
            // 3). `postRedemption` reports `transport` — and so `unreachable` —
            // from its error handler, which is armed across `req.end(body)` as
            // well as before it: one 15s timer covers the whole exchange
            // including the Core signing the certificate, so a slow Core or a
            // reset mid-flight lands here with the session already spent. A
            // block that promised the code was good would send that operator
            // back for a `refused` and a second trip.
            note:
              "Nothing answered at that address — a dial failure, not a refusal. If nothing answered, " +
              "nothing was sent: no attempt was spent and the code you were given is still good.",
          },
          {
            note:
              "If instead the connection dropped part-way through, the Core may have redeemed the code " +
              "before the answer was lost. A retry that comes back refused means exactly that — mint a " +
              "fresh one rather than reading it as a second network fault.",
          },
          { command: "getent hosts <host>", note: "Does the name resolve, and to the machine you mean?" },
          {
            command: "nc -vz <host> <port>",
            note:
              "Is the TLS port open from here? A firewall, a NAT, or a container port that was never " +
              "published all look exactly like this.",
          },
          {
            command: "actana status",
            note: "On the Core: whether it is running, and which address and port it is listening on.",
          },
          {
            note:
              "A proxy named in HTTPS_PROXY, or SNI rewritten by something in front of the Core, lands " +
              "here too — the dial reaches a machine, just not that one.",
          },
        ],
      };
    case "not-pairable":
      return {
        exit: EXIT_PAIR_NOT_PAIRABLE,
        next: "Something answered there but it has no pairing endpoint — check it is a Core, and update it if it is old.",
        steps: [
          {
            // The other side of `unreachable`: the dial worked. Something is
            // listening and it refused to be a Core, which is a different fix.
            note:
              "Something answered and it has no pairing endpoint. The dial worked — so this is not a " +
              "network problem: either that is not a Core, or it is one too old to pair.",
          },
          { command: "actana status", note: "On the Core: which version it is running." },
          { command: "actana update", note: "On the Core: brings it onto a build that pairs." },
          {
            note:
              "If it is not a Core, check the port. A reverse proxy or another service sitting on that " +
              "port answers in exactly this way.",
          },
        ],
      };
    case "no-ca-presented":
      return {
        exit: EXIT_PAIR_NO_CA,
        next: "Nothing was presented to compare against the fingerprint — check the address is the Core's own TLS port.",
        steps: [
          {
            note:
              "Nothing was presented to compare the fingerprint against, so there was nothing to pin and " +
              "the code was not sent.",
          },
          {
            note:
              "Check the address is the Core's own TLS port — a plain-HTTP port, or a proxy terminating " +
              "TLS in front of the Core with its own certificate, both end here.",
          },
          { command: "actana status", note: "On the Core: the TLS port it presents its own authority on." },
        ],
      };
    case "fingerprint-unconfirmed":
      return {
        exit: EXIT_PAIR_FINGERPRINT_UNCONFIRMED,
        next: "Pass `--fingerprint <sha256>` — the code is never sent to a certificate authority nobody confirmed.",
        steps: [
          {
            note:
              "The code is never sent to a certificate authority nobody confirmed, and there is no flag " +
              "that waives that. Absent is not waived.",
          },
          {
            command: PAIR_USAGE,
            note: "Pass the fingerprint `actana pair new` printed on the Core, whole and unedited.",
          },
          {
            note:
              "Or run this where there is a terminal: without --fingerprint it prints the authority the " +
              "Core presents and asks you to compare it yourself.",
          },
        ],
      };
    case "fingerprint-mismatch":
      return {
        exit: EXIT_PAIR_FINGERPRINT_MISMATCH,
        next:
          "Do not retry until you know why: either that is not the Core you were told about, or its credentials " +
          "were reissued and the fingerprint you have is stale. `actana pair new` prints the current one.",
        steps: [
          {
            note:
              "The SHA-256 fingerprint of the certificate authority that address presents was compared " +
              "against the one you gave, and the two differ. The code was not sent.",
          },
          {
            // The warning is the point of the class. Everything else in this
            // command is a convenience; this comparison is the security
            // argument, and the failure mode is an operator looking for a way
            // past it.
            note:
              "Do not look for a way around this. There is no flag that skips the comparison and none " +
              "will be added: an unverified authority is the exact thing pairing exists to rule out, and " +
              "a mismatch is either the wrong machine answering or somebody sitting between you and the " +
              "right one.",
          },
          {
            command: REMINT,
            note:
              "On the Core: prints the fingerprint that Core is presenting today. Compare it against " +
              "yours by eye before you retry — material reissued since you wrote yours down is " +
              "indistinguishable from an impostor at this end.",
          },
        ],
      };
    case "hostname-mismatch":
      return {
        exit: EXIT_PAIR_HOSTNAME_MISMATCH,
        next: "That is the right Core on an address its certificate does not cover — dial the one it was set up for.",
        steps: [
          {
            note:
              "The right Core, reached at an address its certificate does not cover. The authority " +
              "matched; the name did not.",
          },
          { command: "actana status", note: "On the Core: the addresses its certificate was issued for. Dial one of those." },
          {
            note:
              "If the address you need is genuinely missing, it has to be added to the certificate on " +
              "the Core — re-running `actana setup` with it is what does that.",
          },
        ],
      };
    case "certificate-invalid":
      return {
        exit: EXIT_PAIR_CERTIFICATE_INVALID,
        next: "The right Core, with a certificate that cannot be used — check the clock on both machines, then reissue it.",
        steps: [
          {
            note:
              "The right Core, with a certificate that cannot be used. Most often a clock: a certificate " +
              "is not yet valid, or has expired, according to whichever of the two machines is wrong.",
          },
          { command: "date -u", note: "On both machines. They should agree to within a minute." },
          {
            note:
              "If the clocks agree, the Core's material has genuinely expired and needs reissuing on the " +
              "Core before anything can pair with it.",
          },
        ],
      };
    case "refused":
      return {
        exit: EXIT_PAIR_REFUSED,
        next: "Ask for a fresh code — `actana pair new` on the Core. Its audit log says which of the four this was.",
        steps: [
          {
            // The Core deliberately will not say which of the four. Saying so
            // here is what stops an operator re-typing a code they think is
            // merely mistyped when it has in fact expired.
            note:
              "The Core would not redeem that code: expired, already spent, never issued, or out of " +
              "attempts. It does not say which — telling an unauthenticated caller apart from a guesser " +
              "is how codes get guessed. The Core's audit log says.",
          },
          {
            command: REMINT,
            note: "On the Core: mints a fresh code and prints the session and fingerprint beside it.",
          },
          REMINT_RERUN,
        ],
      };
    case "rate-limited":
      return {
        exit: EXIT_PAIR_RATE_LIMITED,
        next:
          detail.retryAfterSeconds === undefined
            ? "Wait, then try again with a fresh code."
            : `Wait ${detail.retryAfterSeconds} seconds, then try again with a fresh code.`,
        steps: [
          {
            note:
              detail.retryAfterSeconds === undefined
                ? "The Core is refusing redemptions from here for now. Wait before trying again."
                : `The Core is refusing redemptions from here for now. Wait ${detail.retryAfterSeconds} ` +
                  "seconds before trying again.",
          },
          {
            command: REMINT,
            note:
              "On the Core, after the wait: every failed redemption spends one of the session's five " +
              "attempts, so a fresh code is the retry that reliably works.",
          },
          REMINT_RERUN,
        ],
      };
    case "rejected":
      return {
        exit: EXIT_PAIR_REJECTED,
        next: "The Core would not accept the request itself — that is a bug on this side. Please report it.",
        steps: [
          {
            note:
              "The Core would not accept the request this build sent. That is a defect here, not " +
              "something to work around: no code, address or fingerprint changes it.",
          },
          {
            command: `${PAIR_USAGE} --verbose`,
            note:
              "Re-run with --verbose and report what it prints, with the exit code. It names the steps " +
              "and never prints the code, the key or the credential.",
          },
        ],
      };
    case "core-error":
      return {
        exit: EXIT_PAIR_CORE_ERROR,
        next: "The Core failed while handling this — `actana logs` on the Core has the reason; nothing here does.",
        steps: [
          {
            note:
              "The Core failed while handling this. Nothing on this side knows why, and nothing on this " +
              "side can be changed to fix it.",
          },
          { command: "actana logs", note: "On the Core: the reason will be there." },
        ],
      };
    case "malformed-response":
      return {
        exit: EXIT_PAIR_MALFORMED_RESPONSE,
        next: "Something answered that is not a Core, or is not one this build understands. Check the address.",
        steps: [
          {
            note:
              "Something answered and what came back was not a pairing response this build understands. " +
              "Either it is not a Core, or the two ends are too far apart in version.",
          },
          { command: "actana status", note: "On the Core: its version." },
          { command: "actana --version", note: "Here: this build's. Update whichever of the two is older." },
        ],
      };
  }
}

// ─── the refusals this file words itself ────────────────────────────────────
//
// Four shapes that never reach the SDK, because they are caught before anything
// is dialled. They are worded here rather than relayed for the reason the module
// header gives: the SDK's own messages quote what they were handed, which is
// correct for a library and wrong for a CLI whose stderr is a terminal, a CI
// log and a shell history at once.

/** The three positionals are missing, or one of them is. */
export const MISSING_ARGUMENTS_STEPS: readonly CorePairStep[] = [
  {
    command: PAIR_USAGE,
    note:
      "The order is the order they are read out: what this machine will call the Core, where the Core " +
      "is, and the code.",
  },
  {
    command: REMINT,
    note: "On the Core: prints the code, the session and the fingerprint — all three of the values this needs.",
  },
];

/** A fourth positional turned up. Never echoed — it may be the code. */
export const TOO_MANY_ARGUMENTS_STEPS: readonly CorePairStep[] = [
  {
    note:
      "Three positionals, then flags. A code pasted twice, or an address repeated after the code, lands " +
      "here. The extra word is not echoed back — it may be the code, and a code in a shell history is a " +
      "code that leaked.",
  },
  { command: PAIR_USAGE, note: "The shape it wants." },
];

/**
 * A bare code that does not name its pairing session.
 *
 * Both spellings, because both work and an operator has been handed one of
 * them: `pair new` prints the session on its own line, and the joined form is
 * what the framed handout pastes. Showing only the flag sends somebody holding
 * a joined string back to the Core for nothing.
 */
export const MISSING_SESSION_STEPS: readonly CorePairStep[] = [
  {
    command: PAIR_USAGE,
    note: "`actana pair new` prints the session id on its own line, beside the code. This is the form the usage line shows.",
  },
  {
    command: PAIR_USAGE_JOINED,
    note:
      "Or the joined <session>:<code> form, which carries the session inside the code — that is what the " +
      "pasteable command in `pair new`'s framed handout uses. Either works; both are the same two values.",
  },
];

/** The code names one session and `--session` names another. */
export const SESSION_DISAGREEMENT_STEPS: readonly CorePairStep[] = [
  {
    note:
      "The code carries one pairing session and --session names another. They have to agree, and this " +
      "will not guess which of the two you meant.",
  },
  { command: PAIR_USAGE, note: "The bare code, with the session beside it." },
  { command: PAIR_USAGE_JOINED, note: "Or the joined form on its own, with no --session at all." },
];

/** A name the registry will not take. */
export function badNameSteps(nameError: string): readonly CorePairStep[] {
  return [
    { note: `${nameError[0]?.toUpperCase() ?? ""}${nameError.slice(1)}.` },
    {
      note:
        "A name this registry will not take is a name `core ls`, `core use`, `core rm`, `core status`, " +
        "`core shell` and `core exec` could not reach afterwards, so it is refused before anything is " +
        "dialled.",
    },
    { command: PAIR_USAGE, note: "Pick another name. Nothing else about the pairing changes." },
  ];
}

/** Anything that is not a `CorePairingError` — a defect, not an operator error. */
export const DEFECT_STEPS: readonly CorePairStep[] = [
  {
    note:
      "That is not an operator error: it is a fault in this build, and no code, address or fingerprint " +
      "changes it.",
  },
  {
    command: `${PAIR_USAGE} --verbose`,
    note:
      "Re-run with --verbose and report what it prints, with the exit code. It never prints the code, " +
      "the key or the credential.",
  },
];

// ─── rendering ──────────────────────────────────────────────────────────────

/**
 * One framed field: a dim label in its column, the value beside it, wrapped.
 *
 * Continuations line up under the value rather than under the label, so a
 * wrapped endpoint still reads as one field. A value with no space in it — a
 * long path — runs past the border rather than being cut: `wrapText` cannot
 * shorten its input, and a ragged border is cheaper than a path an operator
 * cannot copy.
 */
function field(label: string, value: string, color: boolean): string[] {
  const room = FRAME_CONTENT_WIDTH - FIELD_WIDTH;
  const wrapped = wrapText(value, room);
  return wrapped.map((line, index) => {
    const spans: Span[] =
      index === 0
        ? [{ text: label.padEnd(FIELD_WIDTH), style: ANSI.dim }, { text: line }]
        : [{ text: " ".repeat(FIELD_WIDTH) }, { text: line }];
    return frameRow(spans, color);
  });
}

/**
 * The steps under a frame: the command flush and unstyled, the note under it.
 *
 * Unstyled because the command is what gets selected with a mouse, and a dim
 * escape around it is how a low-contrast terminal theme turns an instruction
 * into something that cannot be read. The note is dim because it is read once.
 */
function stepLines(steps: readonly CorePairStep[], color: boolean): string[] {
  const lines: string[] = [];
  for (const [index, step] of steps.entries()) {
    if (index > 0) lines.push("");
    if (step.command !== undefined) {
      lines.push(`  ${step.command}`);
      for (const line of wrapText(step.note, PROSE_WIDTH - 4)) {
        lines.push(style(`    ${line}`, ANSI.dim, color));
      }
    } else {
      for (const line of wrapText(step.note, PROSE_WIDTH - 2)) {
        lines.push(style(`  ${line}`, ANSI.dim, color));
      }
    }
  }
  return lines;
}
