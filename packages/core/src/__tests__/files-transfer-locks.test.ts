import { describe, expect, it } from "vitest";
import { ProjectWriteLocks } from "../files-transfer-locks";

// One write transfer per Project, refused rather than queued (#165 F8).

describe("one write transfer per Project", () => {
  it("hands the first caller a lease", () => {
    const locks = new ProjectWriteLocks();
    expect(locks.acquire("p1", "src").ok).toBe(true);
  });

  it("refuses the second caller and says which transfer holds it", () => {
    const locks = new ProjectWriteLocks();
    locks.acquire("p1", "src/vendor", 1_700_000_000_000);

    const second = locks.acquire("p1", "docs");

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.held).toEqual({ projectId: "p1", path: "src/vendor", startedAt: 1_700_000_000_000 });
  });

  it("refuses without waiting — the answer is the refusal, not a promise", () => {
    // The whole point of F8 is that this is synchronous. A queue would return
    // something to await, and an operator's second `project cp` would sit there
    // producing nothing for as long as the first one runs.
    const locks = new ProjectWriteLocks();
    locks.acquire("p1", "a");
    const second = locks.acquire("p1", "b");
    expect(second).not.toBeInstanceOf(Promise);
    expect(second.ok).toBe(false);
  });

  it("lets a different Project through at the same time", () => {
    const locks = new ProjectWriteLocks();
    locks.acquire("p1", "a");
    expect(locks.acquire("p2", "a").ok).toBe(true);
  });

  it("lets the next caller in once the lease is released", () => {
    const locks = new ProjectWriteLocks();
    const first = locks.acquire("p1", "a");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    first.lease.release();

    expect(locks.acquire("p1", "b").ok).toBe(true);
  });

  it("survives a double release without stranding the successor", () => {
    const locks = new ProjectWriteLocks();
    const first = locks.acquire("p1", "a");
    if (!first.ok) throw new Error("unreachable");
    first.lease.release();

    const second = locks.acquire("p1", "b");
    if (!second.ok) throw new Error("unreachable");

    // The stale lease releasing a second time must not delete the entry the
    // *new* transfer is holding.
    first.lease.release();

    expect(locks.current("p1")).toMatchObject({ path: "b" });
    expect(locks.acquire("p1", "c").ok).toBe(false);
  });

  it("reports nothing held for a Project nobody is writing", () => {
    const locks = new ProjectWriteLocks();
    expect(locks.current("p1")).toBeNull();
    expect(locks.all()).toEqual([]);
  });

  it("lists every in-flight transfer across Projects", () => {
    const locks = new ProjectWriteLocks();
    locks.acquire("p1", "a", 1);
    locks.acquire("p2", "b", 2);
    expect(locks.all()).toEqual([
      { projectId: "p1", path: "a", startedAt: 1 },
      { projectId: "p2", path: "b", startedAt: 2 },
    ]);
  });

  it("gives two tables of their own — a Core does not share this with another Core", () => {
    const one = new ProjectWriteLocks();
    const two = new ProjectWriteLocks();
    one.acquire("p1", "a");
    expect(two.acquire("p1", "a").ok).toBe(true);
  });
});
