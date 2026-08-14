/**
 * The environment variable names a harness's lifecycle hooks read to find this
 * Core's receiver.
 *
 * Their own module because both hook writers need them and neither may import
 * the other: `harness-hooks.ts` owns the registry and calls into
 * `harness-hooks-opencode.ts`, which needs the same three names to bake into
 * the plugin it writes.
 *
 * The names are in the *file* a hook writer produces and the *environment* the
 * spawn path sets, and the reason the value is never in the file is that a
 * workspace may be committed and a restart mints a new token (see the rules at
 * the top of `harness-hooks.ts`).
 */
export const HOOK_URL_ENV = "AC_HOOK_URL";
export const HOOK_TOKEN_ENV = "AC_HOOK_TOKEN";
export const HOOK_TASK_ID_ENV = "AC_HOOK_TASK_ID";
