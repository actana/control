// The Core's registration of the shared listing contract (#218).
//
// The body lives beside this file, in `files-list-contract.ts`, with the rig
// that stands this surface up (`files-rig.ts`). It used to live in the SDK's
// test tree; the SDK now ships from actana/client, so the contract body moved
// here with the Core half it exercises. The published `@actana/sdk` client is
// what it drives.
//
// It runs here as well as there on purpose. This package owns one half of the
// listing URL and the SDK owns the other; the two disagreed for two merged pull
// requests without a single red test, because each suite proved its own half
// against its own idea of the other. A contract test that only the SDK's suite
// runs is one this package's author does not run before pushing — which is the
// arrangement that let #218 happen. Do not "tidy" this file away.
import { describeFilesListContract } from "./files-list-contract";

describeFilesListContract();
