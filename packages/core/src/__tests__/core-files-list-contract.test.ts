// The Core's registration of the shared listing contract (#218).
//
// The body lives in the SDK's test tree — `packages/sdk/src/__tests__/
// files-list-contract.ts` — because that is where the rig that stands this
// surface up already lives, and it is reached here by package name through the
// same test-only alias `@actana/sdk` already uses.
//
// It runs here as well as there on purpose. This package owns one half of the
// listing URL and the SDK owns the other; the two disagreed for two merged pull
// requests without a single red test, because each suite proved its own half
// against its own idea of the other. A contract test that only the SDK's suite
// runs is one this package's author does not run before pushing — which is the
// arrangement that let #218 happen. Do not "tidy" this file away.
import { describeFilesListContract } from "@actana/sdk/__tests__/files-list-contract";

describeFilesListContract();
