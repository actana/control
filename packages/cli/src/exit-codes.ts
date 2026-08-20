// Exit codes, named once.
//
// Three, because a caller can act on three: it worked, you typed it wrong, or
// it did not work. `EXIT_USAGE` is 2 to match `packages/core/src/actana-cli.ts`
// — one command name (#129 D8) whose two halves disagreed about what 2 means
// would be worse than either choice.

/** It worked. */
export const EXIT_OK = 0;

/** It did not work: a Core refused, a file was unreadable, a blob was bad. */
export const EXIT_FAILURE = 1;

/** The command line was wrong: unknown verb or flag, missing argument. */
export const EXIT_USAGE = 2;

/**
 * The noun or verb exists in the tree and is not built yet.
 *
 * Distinct from {@link EXIT_USAGE} on purpose: "you typed something that is not
 * a command" and "you typed a command this build cannot do yet" are different
 * facts, and a script that reaches for a name this phase has not finished
 * should be able to tell them apart without parsing English off stderr.
 *
 * **Every reserved name in the tree returns this, whether noun or verb.** The
 * `session` / `project` / `harness` / `events` nouns (#160, #161, #163), the
 * `core shell` verb (#162) and `project cp` / `project files` (#168) each
 * returned it until its build landed: they are one fact about one build, and
 * the nouns are what a script written against a later train hits first.
 * Splitting them — 3 for a verb, 2 for a noun — would have meant this comment
 * arguing for a distinction the command tree did not make.
 *
 * **Nothing in this build returns it.** #168 built the last two reservations,
 * so both tables are empty and every name in the tree either works or is a
 * typo. The code stays exported and documented because the mechanism is what
 * makes the *next* reservation cheap — `project rm` is #210 — and because a
 * script that already branches on 3 must keep meaning the same thing by it.
 *
 * What it is *not* for is a verb the protocol cannot carry. `project set-path`
 * exits {@link EXIT_USAGE}, because a Core-owned Project's path is immutable
 * (ADR 0022) and no later build makes that command appear.
 */
export const EXIT_UNIMPLEMENTED = 3;

/**
 * The link to the Core went away while a command was running on it, and this
 * CLI has no result (issue 266, `core exec`).
 *
 * **Never the command's own status, and never `0`.** The command keeps running
 * on the Core — that is what a non-interactive spawn does — so the honest
 * answer is *I do not know what happened*, and a script that read a
 * plausible-looking status would act on an outcome nobody has. Note the
 * asymmetry with `core shell`, which treats a dropped link as an ordinary
 * ending ({@link EXIT_FAILURE}) because a human is watching; nobody is watching
 * an exec.
 *
 * 125, following the one convention that already means exactly this: `docker
 * run` and `git bisect run` both reserve it for *the runner failed, not your
 * command*. The reservation is a convention rather than a proof — a command
 * can exit 125 like it can exit anything else in 0–255, and no POSIX exit
 * status is unreachable by a child process. What IS unambiguous is the
 * structured channel: `--json` reports `outcome: "link-lost"` with a null
 * exitCode, distinct from `outcome: "exited"` with an exitCode of 125, and a
 * script that must tell the two apart with certainty reads that rather than
 * `$?`. The sentence on stderr says which happened either way.
 */
export const EXIT_LINK_LOST = 125;

// ─── Pairing (#285) ─────────────────────────────────────────────────────────
//
// `actana core pair` is the one client verb whose failures an operator has to
// tell apart *without reading English*. A wrong code, a code somebody already
// spent, a Core that is not answering and a certificate authority that is not
// the one they were read out are four different situations with four different
// next actions — and the enrollment script that runs this across a fleet is not
// going to grep stderr to decide which of them happened.
//
// So every failure `@actana/sdk/core-pairing.ts` distinguishes gets a code of
// its own here, in one block, and `corePairingExit` in `core-pair.ts` switches
// over the SDK's union exhaustively — a failure added there stops compiling
// until it is given a number here, rather than quietly collapsing into
// {@link EXIT_FAILURE}.
//
// **10 upward, as a block.** It leaves 4–9 free for whatever the next
// *general* code turns out to be (the four above it are general facts about any
// verb), keeps well clear of the shell's own reservations at 126, 127 and
// 128+n, and clear of {@link EXIT_LINK_LOST}. Numbers here are contract: a
// script that branches on 14 must keep meaning "that was not the Core you were
// told about" forever.
//
// **What is deliberately NOT in this block**: a code, an address or a
// fingerprint that is malformed. Those never leave the machine and they are the
// command line being wrong, which is what {@link EXIT_USAGE} already means —
// giving them numbers here would be inventing a second answer to a question
// this CLI has answered the same way since #129.

/**
 * Nothing answered at the address, or the dial timed out.
 *
 * The one failure that is usually not about pairing at all: a Core that is
 * stopped, a port that is closed, a host that is somebody's typo.
 */
export const EXIT_PAIR_UNREACHABLE = 10;

/** Something answered, but it has no pairing endpoint — check it is a Core, and its version. */
export const EXIT_PAIR_NOT_PAIRABLE = 11;

/** The chain presented had no certificate authority in it, so there was nothing to compare. */
export const EXIT_PAIR_NO_CA = 12;

/**
 * No fingerprint was given and there was no terminal to confirm one on. **The
 * code was not sent.**
 *
 * Distinct from a mismatch because it is not an alarm: nobody has been
 * impersonated, the operator simply has not said what they expect yet. A script
 * that hits this is missing `--fingerprint`, not under attack.
 */
export const EXIT_PAIR_FINGERPRINT_UNCONFIRMED = 13;

/**
 * The certificate authority presented is not the one the operator was read out.
 * **The code was not sent.**
 *
 * The loud one, and the reason the whole exchange is shaped the way it is: this
 * is what a machine-in-the-middle on the first dial looks like from here. It is
 * also what a stale fingerprint from a Core that has been reissued looks like,
 * which is why the message says both.
 */
export const EXIT_PAIR_FINGERPRINT_MISMATCH = 14;

/**
 * The right certificate authority, on an address its certificate does not cover.
 *
 * Its own code rather than a mismatch, because it is not an attack and reporting
 * one would send an operator hunting for something that is not there: a Core's
 * certificate covers the host it was set up for plus loopback, so reaching it
 * over a second interface, a tunnel or a DNS name added later lands here with
 * the fingerprint matching perfectly.
 */
export const EXIT_PAIR_HOSTNAME_MISMATCH = 15;

/** The right certificate authority, and a certificate that is expired or otherwise unusable. */
export const EXIT_PAIR_CERTIFICATE_INVALID = 16;

/**
 * The Core refused the code: wrong, expired, already redeemed, or out of
 * attempts.
 *
 * One code for four situations because the *Core* answers all four with one
 * status and one body on purpose (#282, "every refusal is the same refusal") —
 * telling them apart on the wire would tell an attacker whether a session
 * exists and whether their last guess was closer. A CLI that exported four
 * codes here would be inventing three of them. The distinction is in the Core's
 * audit log, where #282 put it deliberately.
 */
export const EXIT_PAIR_REFUSED = 17;

/** Too many attempts from here, too fast. The message says how long to wait. */
export const EXIT_PAIR_RATE_LIMITED = 18;

/** The Core would not accept the request itself — a bug on this side, not an operator error. */
export const EXIT_PAIR_REJECTED = 19;

/** The Core failed while handling the redemption. Its logs have the reason; this side does not. */
export const EXIT_PAIR_CORE_ERROR = 20;

/** A 200 that was not a redemption response — something is answering that is not a Core. */
export const EXIT_PAIR_MALFORMED_RESPONSE = 21;
