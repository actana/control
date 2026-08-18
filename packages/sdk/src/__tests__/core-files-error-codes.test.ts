// The SDK's registration of the shared refusal-code contract (#224).
//
// This package owns `CORE_FILES_ERROR_CODES`, so this is the suite where a
// change to the vocabulary is made — and the one that has to notice when
// `docs/external-api.md` was not brought along with it. The body is in
// `files-error-code-contract.ts` beside this file, and the Core registers the
// same body in its own suite; see that file for why both. Do not "tidy" either
// registration away.
import { describeFilesErrorCodeContract } from "./files-error-code-contract";

describeFilesErrorCodeContract();
