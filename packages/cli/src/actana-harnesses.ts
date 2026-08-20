// Installing Harnesses the vendor's way — `actana setup`'s offer round and
// `actana harnesses install <id>`.
//
// The implementation lives in `@actana/shared/actana-harnesses` and is
// re-exported here so this stays the one Harness-install module the CLI
// imports. It is shared rather than the CLI's own because the Core daemon runs
// the very same installer when a Panel asks it to
// (`packages/core/src/harness-install-service.ts`, ADR 0021) — #288 D2's rule:
// both halves use it, so it belongs to neither.
//
// What is *not* shared is the port it runs commands through. The daemon has no
// terminal, so it passes its own non-interactive one; see
// `packages/core/src/core-harness-system.ts`.

export {
  harnessFlagNames,
  harnessFromFlagName,
  installAgentsNow,
  missingHarnesses,
  offerableHarnessIds,
  offerHarnessInstalls,
  resolveHarnessId,
  summarizeHarnessInstalls,
  supportedHarnessIdsSentence,
  type HarnessInstallOutcome,
  type HarnessInstallContext,
  type HarnessInstallStatus,
  type HarnessOfferOptions,
} from "@actana/shared/actana-harnesses";
