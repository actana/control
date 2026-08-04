import type { Harness } from "@actana/shared/domain";

/** Wire type for GET /api/harness-launchers/accounts. Display identifier only — never a token. */
export type HarnessAccountStatus = {
  agent: Harness;
  connected: boolean;
  identifier: string | null;
};

/** Wire type for GET /api/harness-launchers/latest-versions. */
export type HarnessLatestVersion = {
  agent: Harness;
  /** False when the CLI has no public registry to query (Cursor). */
  supported: boolean;
  latestVersion: string | null;
  checkedAt: string;
  error?: string;
};
