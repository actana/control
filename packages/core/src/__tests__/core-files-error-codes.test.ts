// The Core's registration of the shared refusal-code contract (#224).
//
// The body lives beside this file, in `files-error-code-contract.ts`. It used to
// live in the SDK's test tree; the vocabulary it reads (`CORE_FILES_ERROR_CODES`)
// is now exported by the published `@actana/sdk`, and the check moved here with
// the Core half it guards.
//
// It runs here as well as there on purpose, for the reason the listing contract
// beside it gives: a new refusal code is *written* in this package —
// `core-files-routes.ts` refuses the request, `files-tar.ts` refuses the entry —
// by an author who may run `pnpm --filter @actana/core test` and nothing else.
// A documentation check that only the SDK's suite runs is one this package's
// author does not run before pushing, and this package's author is exactly who
// needs it. Do not "tidy" this file away.
import { describeFilesErrorCodeContract } from "./files-error-code-contract";

describeFilesErrorCodeContract();
