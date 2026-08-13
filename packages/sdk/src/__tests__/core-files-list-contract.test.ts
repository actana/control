// The SDK's registration of the shared listing contract (#218).
//
// The body is in `files-list-contract.ts` and the Core's suite registers the
// same one, so a change to either half of the listing URL goes red on both
// sides. See that file for why it is shared rather than written twice.
import { describeFilesListContract } from "./files-list-contract";

describeFilesListContract();
