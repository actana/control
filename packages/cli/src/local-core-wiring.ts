// A Core installed here is wired to the CLI here (#288 D9).
//
// Before 0.4.0 an operator who ran `actana setup` on their own machine had to
// take the pairing token setup printed and hand it back to the *same* machine's
// `actana core add` before any client noun would work — a blob copied from one
// half of a split command into the other half, on one box, by hand. Both ends
// of that copy are gone now (#287); this is what replaced the near end.
//
// The implementation lives in `@actana/shared/local-core-wiring` and is
// re-exported here so `actana-setup.ts` keeps importing one name from one
// place. It is shared rather than the CLI's own because two programs install a
// Core and both have to do this wiring the same way: `setup` on metal, and the
// daemon itself in a container, where the image is the install and `setup` is
// refused (`packages/core/src/core-self-register.ts`, ADR 0016 D13). #288 D2's
// rule again — both halves use it, so it belongs to neither.
//
// The rules it carries are unchanged: the registry lives in the same directory
// setup writes `material.json` into, and **a selection the operator made is not
// overwritten** — if `current` already names a different Core, the local one is
// registered and the pointer is left where it is.

export { localCoreName, wireLocalCore, type LocalCoreWiring } from "@actana/shared/local-core-wiring";
