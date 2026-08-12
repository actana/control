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
 * The verb exists in the tree and is not built yet.
 *
 * Distinct from {@link EXIT_USAGE} on purpose: "you typed something that is not
 * a command" and "you typed a command this build cannot do yet" are different
 * facts, and a script that reaches for `core shell` before #162 lands should be
 * able to tell them apart without parsing English off stderr.
 */
export const EXIT_UNIMPLEMENTED = 3;
