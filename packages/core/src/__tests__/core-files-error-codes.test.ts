// The Core's registration of the shared refusal-code contract (#224).
//
// The body lives in the SDK's test tree — `packages/sdk/src/__tests__/
// files-error-code-contract.ts` — because that is where the vocabulary it reads
// is defined, and it is reached here by package name through the same test-only
// alias `@actana/sdk` already uses.
//
// It runs here as well as there on purpose, for the reason the listing contract
// beside it gives: a new refusal code is *written* in this package —
// `core-files-routes.ts` refuses the request, `files-tar.ts` refuses the entry —
// by an author who may run `pnpm --filter @actana/core test` and nothing else.
// A documentation check that only the SDK's suite runs is one this package's
// author does not run before pushing, and this package's author is exactly who
// needs it. Do not "tidy" this file away.
import { describeFilesErrorCodeContract } from "@actana/sdk/__tests__/files-error-code-contract";

describeFilesErrorCodeContract();
