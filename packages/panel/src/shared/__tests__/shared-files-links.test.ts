import { describe, expect, it } from "vitest";
import { findPullRequestUrls, pullRequestLabel, sessionIdOfPath, SYNC_CLOCK_SKEW_MS, syncStateOf } from "../shared-files";

describe("who wrote a file, from where it is", () => {
  it("names the Session whose folder it is in, and no other path", () => {
    expect(sessionIdOfPath("sessions/t-munykjig/screens/report-1.md")).toBe("t-munykjig");
    expect(sessionIdOfPath("sessions/t-munykjig")).toBe("t-munykjig");
    expect(sessionIdOfPath("tasks/T-1/success.md")).toBeNull();
    expect(sessionIdOfPath("uploads/sessions/x/a.md")).toBeNull();
    expect(sessionIdOfPath("sessionsx/a.md")).toBeNull();
  });
});

describe("pull request links", () => {
  const PR = "https://github.com/acme/app/pull/581";

  it("finds a full GitHub pull request URL, once, first seen first", () => {
    expect(findPullRequestUrls(`${PR} and (${PR}) and https://github.com/acme/app/pull/7.`)).toEqual([PR, "https://github.com/acme/app/pull/7"]);
  });

  it("does not take a bare PR number, another scheme, another host, an issue or a repository page", () => {
    for (const text of [
      "PR 581",
      "#581",
      "http://github.com/acme/app/pull/1",
      "https://gitlab.com/acme/app/pull/1",
      "https://github.com.evil.test/acme/app/pull/1",
      "https://github.com/acme/app/issues/1",
      "https://github.com/acme/app",
      "https://github.com/acme/app/pull/0",
      "https://github.com/acme/app/pull/12x",
    ]) {
      expect(findPullRequestUrls(text), text).toEqual([]);
    }
  });

  it("rebuilds the link from the match, so a query, a fragment or markup after it cannot come along", () => {
    expect(findPullRequestUrls(`[x](${PR}?a=1#files) <${PR}"onmouseover="alert(1)>`)).toEqual([PR]);
  });

  it("stops at the number asked for", () => {
    const text = Array.from({ length: 9 }, (_, i) => `https://github.com/a/b/pull/${i + 1}`).join(" ");
    expect(findPullRequestUrls(text)).toHaveLength(5);
    expect(findPullRequestUrls(text, 2)).toHaveLength(2);
  });

  it("labels a link as owner/repo#number", () => {
    expect(pullRequestLabel(PR)).toBe("acme/app#581");
  });
});

describe("sync state", () => {
  const T = 1_000_000;
  const entry = { size: 3482, modifiedAt: T };

  it("is synced when the store has the size the Core wrote and is not older than the Core's write", () => {
    expect(syncStateOf(entry, { size: 3482, mtime: T - 500, deleted: false }, true)).toEqual({ kind: "synced", label: "synced to S3" });
    expect(syncStateOf(entry, { size: 3482, mtime: T, deleted: false }, true).kind).toBe("synced");
  });

  it("allows the two clocks to differ by the skew, and no more", () => {
    expect(syncStateOf(entry, { size: 3482, mtime: T + SYNC_CLOCK_SKEW_MS, deleted: false }, true).kind).toBe("synced");
    expect(syncStateOf(entry, { size: 3482, mtime: T + SYNC_CLOCK_SKEW_MS + 1, deleted: false }, true).kind).toBe("syncing");
  });

  it("is syncing for a same-size rewrite the store has not received: the stored copy is older than the Core's write", () => {
    expect(syncStateOf(entry, { size: 3482, mtime: T + 60_000, deleted: false }, true)).toEqual({ kind: "syncing", label: "syncing with the Core" });
  });

  it("is syncing when the sizes differ, or the Core says the file is gone", () => {
    expect(syncStateOf(entry, { size: 10, mtime: T, deleted: false }, true).kind).toBe("syncing");
    expect(syncStateOf(entry, { size: 3482, mtime: T, deleted: true }, true).kind).toBe("syncing");
  });

  it("is synced again once the store's copy is newer than the Core's write, whatever the size path took", () => {
    expect(syncStateOf({ size: 20, modifiedAt: T + 15_000 }, { size: 20, mtime: T, deleted: false }, true).kind).toBe("synced");
  });

  it("is only in storage when the Core has said nothing, and says why when it is not connected", () => {
    expect(syncStateOf(entry, undefined, true)).toEqual({ kind: "in-storage", label: "in storage" });
    expect(syncStateOf(entry, undefined, false).label).toBe("in storage · Core not connected");
  });

  it("judges a stored entry with no time, and a file with no size, on what it has", () => {
    expect(syncStateOf({ size: 5 }, { size: 5, mtime: T, deleted: false }, true).kind).toBe("synced");
    expect(syncStateOf({}, { size: 0, mtime: T, deleted: false }, true).kind).toBe("synced");
  });
});
