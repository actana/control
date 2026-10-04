import { describe, expect, it } from "vitest";
import { WorkspaceWriteLocks } from "../files-transfer-locks";

// One write transfer into the workspace, refused rather than queued (#165 F8).

describe("one write transfer into the workspace", () => {
  it("hands the first caller a lease", () => {
    const locks = new WorkspaceWriteLocks();
    expect(locks.acquire("src").ok).toBe(true);
  });

  it("refuses the second caller and says which transfer holds it", () => {
    const locks = new WorkspaceWriteLocks();
    locks.acquire("src/vendor", 1_700_000_000_000);

    const second = locks.acquire("docs");

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.held).toEqual({ path: "src/vendor", startedAt: 1_700_000_000_000 });
  });

  it("refuses without waiting — the answer is the refusal, not a promise", () => {
    // The whole point of F8 is that this is synchronous. A queue would return
    // something to await, and an operator's second `cp` would sit there
    // producing nothing for as long as the first one runs.
    const locks = new WorkspaceWriteLocks();
    locks.acquire("a");
    const second = locks.acquire("b");
    expect(second).not.toBeInstanceOf(Promise);
    expect(second.ok).toBe(false);
  });

  it("lets the next caller in once the lease is released", () => {
    const locks = new WorkspaceWriteLocks();
    const first = locks.acquire("a");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    first.lease.release();

    expect(locks.acquire("b").ok).toBe(true);
  });

  it("survives a double release without stranding the successor", () => {
    const locks = new WorkspaceWriteLocks();
    const first = locks.acquire("a");
    if (!first.ok) throw new Error("unreachable");
    first.lease.release();

    const second = locks.acquire("b");
    if (!second.ok) throw new Error("unreachable");

    // The stale lease releasing a second time must not clear the entry the
    // *new* transfer is holding.
    first.lease.release();

    expect(locks.current()).toMatchObject({ path: "b" });
    expect(locks.acquire("c").ok).toBe(false);
  });

  it("reports nothing held when nobody is writing", () => {
    const locks = new WorkspaceWriteLocks();
    expect(locks.current()).toBeNull();
  });

  it("gives two tables of their own — a Core does not share this with another Core", () => {
    const one = new WorkspaceWriteLocks();
    const two = new WorkspaceWriteLocks();
    one.acquire("a");
    expect(two.acquire("a").ok).toBe(true);
  });
});
