// A Core installed here is wired to the CLI here (#288 D9).
//
// Before 0.4.0 an operator who ran `actana setup` on their own machine had to
// take the pairing token setup printed and hand it back to the *same* machine's
// `actana core add` before any client noun would work — a blob copied from one
// half of a split command into the other half, on one box, by hand. Both ends
// of that copy are gone now (#287); this is what replaced the near end.
//
// The two sides already met on disk, which is what makes this a wiring job
// rather than a new protocol: `blob-registry.ts` stores one credential per
// named Core under `$XDG_CONFIG_HOME/actana/cores/`, which is the same
// directory setup writes this Core's own `material.json` into, and deliberately
// so. So setup hands the credential it just minted straight to this module and
// points `current` at it.
//
// **The encoding at rest is this module's business, and only this module's.**
// Callers pass a credential *object*; the base64 a registry file holds is
// written here. That is a deliberate move from #287: while `actana setup`
// encoded the blob itself, "the artifact setup emits" and "the bytes the
// registry stores" were the same expression in the same function, and deleting
// the first meant reasoning about the second. They are now two things in two
// places, and setup names neither codec.
//
// **Two programs do the wiring, because two programs install a Core.** On metal
// it is `actana setup` (`packages/cli/src/actana-setup.ts`). In a container the
// image *is* the install and `setup` is refused there (ADR 0016 D13), so the
// daemon does it for itself on boot — `packages/core/src/core-self-register.ts`
// — and that is why this module and the registry beside it live in the package
// both halves may import rather than in the CLI's own source.
//
// **A selection the operator made is not overwritten.** If `current` already
// names a *different* Core, the local one is registered and the pointer is left
// where it is, with a line saying so — the same "no clobber, no silent win"
// rule the launcher path follows one module over. On the machine this
// criterion is about, a Core with a CLI that has never selected anything, the
// local Core becomes the default target, which is what D9 asks for.
//
// A CLI with no local Core is untouched by any of this: `actana core pair`
// wires remote Cores and nothing about that path changes.

import {
  coreNameError,
  readCurrentCore,
  writeCoreBlob,
  writeCurrentCore,
  type RegistryPaths,
} from "./blob-registry";
import { encodeRegistrationBlob, type RegistrationBlob } from "./registration-blob";

/** What {@link wireLocalCore} did. */
export type LocalCoreWiring = {
  /** The registry name the local Core was stored under. */
  name: string;
  /** Whether `current` now points at it. */
  selected: boolean;
  /** The Core `current` points at instead, when it was left alone. */
  keptSelection: string | null;
};

/** Where a label that cannot be a registry name falls back to. */
const FALLBACK_NAME = "local";

/**
 * A registry name for this machine's own Core, derived from its label.
 *
 * The label is free text — a hostname, or whatever `--label` said — and a
 * registry name is a path segment. Anything the name rules refuse is replaced
 * rather than rejected: a run of unusable characters becomes a single `-`, so
 * a Core its operator called `web 01` is registered as `web-01`. Refusing to
 * wire it at all would be a worse answer, and the label the Panel shows is
 * unaffected either way.
 */
export function localCoreName(label: string): string {
  const cleaned = label
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .slice(0, 64)
    .replace(/[-.]+$/, "");
  return coreNameError(cleaned) === null ? cleaned : FALLBACK_NAME;
}

/**
 * Register this machine's own Core, and select it unless something else is.
 *
 * `credential` is the object, never text: nothing outside this module needs an
 * opinion about how a registry entry is encoded, and nothing outside it has
 * one.
 */
export function wireLocalCore(
  paths: RegistryPaths,
  label: string,
  credential: RegistrationBlob,
): LocalCoreWiring {
  const name = localCoreName(label);
  const previous = readCurrentCore(paths);
  writeCoreBlob(paths, name, encodeRegistrationBlob(credential));

  if (previous === null || previous === name) {
    writeCurrentCore(paths, name);
    return { name, selected: true, keptSelection: null };
  }
  return { name, selected: false, keptSelection: previous };
}
