// Fetching release bytes — the port, and the real `fetch` behind it.
//
// Its own module because both halves of `actana` reach the release channel:
// the operator's `update` and `install` verbs download and verify a tarball
// through it (`packages/cli/src/actana-release.ts` re-exports both names), and
// the Core daemon's once-a-day update notice asks the same channel what the
// latest version is (`packages/core/src/core-update-notice.ts`). #288 D2's
// rule — both halves use it, so it belongs to neither.
//
// Nothing here knows what a release *is*: no target mapping, no asset names,
// no checksums. That is `actana-release.ts`'s, on the operator's side, where
// it belongs with the verbs that act on it.

import * as fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Fetching bytes — the only impure thing in the update path's release half. */
export type ReleaseFetcher = {
  /** GET a URL as text. Throws when the request fails or answers non-2xx. */
  fetchText(url: string): Promise<string>;
  /** GET a URL into a file. Throws rather than leaving a partial file behind. */
  download(url: string, destPath: string): Promise<void>;
};

/**
 * GitHub's API rejects requests without one, and a named agent is what shows
 * up in rate-limit and abuse reports if an update loop ever misbehaves.
 */
const USER_AGENT = "actana-cli";

/**
 * The real fetcher: `fetch` over the network.
 *
 * A download lands on `<dest>.part` and is renamed into place, so a connection
 * that drops halfway can never leave a file that looks like a complete tarball
 * — the digest would catch it anyway, but a half-file that survives a crash
 * would be a puzzle rather than a retry.
 */
export function nodeReleaseFetcher(): ReleaseFetcher {
  const get = async (url: string): Promise<Response> => {
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return response;
  };

  return {
    async fetchText(url) {
      return (await get(url)).text();
    },
    async download(url, destPath) {
      const response = await get(url);
      if (!response.body) throw new Error("the release server sent an empty response");
      const partial = `${destPath}.part`;
      try {
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
        fs.renameSync(partial, destPath);
      } catch (err) {
        fs.rmSync(partial, { force: true });
        throw err;
      }
    },
  };
}
