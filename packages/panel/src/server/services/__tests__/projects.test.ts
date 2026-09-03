import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-test-"));
process.env.AC_USER_DATA_DIR = tmpRoot;

const {
  listProjects,
  createProject,
  getProject,
  togglePin,
  reorderPinnedProjects,
  deleteProject,
  updateProject,
  getProjectPathStatus,
  detectGithubUrl,
  _resetGithubUrlCache,
} = await import("../projects");
const { upsertProjectPresentation } = await import("../project-presentation");
const { getDb } = await import("~/db/client");
const { projects, tasks, groups, appSettings, projectPresentation } = await import("~/db/schema");

describe("projects service", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(tasks).run();
    db.delete(projectPresentation).run();
    db.delete(projects).run();
    db.delete(groups).run();
    db.delete(appSettings).run();
  });

  it("rejects nonexistent paths", () => {
    expect(() =>
      createProject({ name: "no-go", path: "/definitely/not/here/i/promise" })
    ).toThrow();
  });

  it("reports a missing persisted project path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-missing-"));
    const created = createProject({ name: "missing", path: dir });
    fs.rmSync(dir, { recursive: true, force: true });

    expect(getProjectPathStatus(created.id)).toMatchObject({
      ok: false,
      reason: "missing",
      path: dir,
    });
  });

  it("creates and lists a project", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-"));
    const created = createProject({ name: "alpha", path: dir });
    expect(created.id).toBeTruthy();

    const all = listProjects();
    expect(all.some((p) => p.id === created.id)).toBe(true);
  });

  it("toggles pin and updates fields", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-"));
    const c = createProject({ name: "beta", path: dir });
    const after = togglePin(c.id);
    expect(after?.pinned).toBe(true);
    expect(after?.pinnedOrder).toBe(0);
    const renamed = updateProject(c.id, { name: "beta-2" });
    expect(renamed?.name).toBe("beta-2");
  });

  it("appends newly pinned projects and clears order on unpin", () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-b-"));
    const a = createProject({ name: "alpha", path: dirA });
    const b = createProject({ name: "beta", path: dirB });
    togglePin(a.id);
    togglePin(b.id);
    const unpinned = togglePin(b.id);
    expect(unpinned?.pinned).toBe(false);
    expect(unpinned?.pinnedOrder).toBeNull();
    const repinned = togglePin(b.id);
    expect(repinned?.pinned).toBe(true);
    expect(repinned?.pinnedOrder).toBe(1);
  });

  it("persists pinned reorder across reads", () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-reorder-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-reorder-b-"));
    const a = createProject({ name: "alpha", path: dirA });
    const b = createProject({ name: "beta", path: dirB });
    togglePin(a.id);
    togglePin(b.id);
    reorderPinnedProjects([b.id, a.id]);
    expect(
      listProjects()
        .filter((project) => project.pinned)
        .sort((left, right) => (left.pinnedOrder ?? 0) - (right.pinnedOrder ?? 0))
        .map((project) => project.id),
    ).toEqual([b.id, a.id]);
  });

  // Issue 382. The rail mixes this Panel's pins with the pins each Core owns,
  // and a Core's row is not in this database at all. So the order handed here
  // is the whole rail: ids from no row here hold their slot in the numbering
  // and are skipped, and the index written for each of our own rows is its
  // slot on the RAIL — the only numbering in which a Core's pin can sit
  // between two of ours and still be there after a reload.
  it("numbers its own rows by their slot on a mixed rail", () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-mixed-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-mixed-b-"));
    const a = createProject({ name: "alpha", path: dirA });
    const b = createProject({ name: "beta", path: dirB });
    togglePin(a.id);
    togglePin(b.id);

    // Rail order: a, <a Core's pin>, b.
    reorderPinnedProjects([a.id, "p-owned-by-a-core", b.id]);

    const byId = new Map(listProjects().map((project) => [project.id, project]));
    expect(byId.get(a.id)?.pinnedOrder).toBe(0);
    expect(byId.get(b.id)?.pinnedOrder).toBe(2);
    // Nothing was invented for the passenger.
    expect(byId.has("p-owned-by-a-core")).toBe(false);
  });

  it("rejects a rail order that leaves out one of its own pinned rows", () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-partial-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-partial-b-"));
    const a = createProject({ name: "alpha", path: dirA });
    const b = createProject({ name: "beta", path: dirB });
    togglePin(a.id);
    togglePin(b.id);

    expect(() => reorderPinnedProjects([a.id, "p-owned-by-a-core"])).toThrow(/exactly once/);
    // ...and an unpinned row of its own is still a caller bug, not a passenger.
    const c = createProject({ name: "gamma", path: fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-partial-c-")) });
    expect(() => reorderPinnedProjects([a.id, b.id, c.id])).toThrow(/not pinned/);
  });

  // Issue 382 review. `projects.pinned_order` indexes a rail it now shares with
  // every Core's pins, whose slots live on presentation rows in this same
  // database. Maxing over the Panel's own rows alone handed a newly pinned
  // project a slot at or below one a Core pin already held, so it appeared in
  // the middle of the rail rather than at its end.
  it("pins a new project at the end of the whole rail, not the end of its own rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-railend-"));
    const a = createProject({ name: "alpha", path: dir });
    togglePin(a.id);
    expect(getProject(a.id)?.pinnedOrder).toBe(0);

    // A Core's pins take slots 1..4 on the same rail.
    upsertProjectPresentation("p-core-1", "core-a", { pinnedOrder: 4 });

    const b = createProject({
      name: "beta",
      path: fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-railend-b-")),
    });
    togglePin(b.id);
    expect(getProject(b.id)?.pinnedOrder).toBe(5);

    // Same rule on the create-pinned path.
    const c = createProject({
      name: "gamma",
      path: fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-railend-c-")),
      pinned: true,
    });
    expect(getProject(c.id)?.pinnedOrder).toBe(6);
  });

  it("rejects updating a project to a nonexistent path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-update-"));
    const c = createProject({ name: "beta", path: dir });

    expect(() =>
      updateProject(c.id, { path: "/definitely/not/here/i/promise" })
    ).toThrow(/Working directory does not exist/);
    expect(getProjectPathStatus(c.id)).toMatchObject({ ok: true, path: dir });
  });

  it("deletes cleanly", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-"));
    const c = createProject({ name: "gamma", path: dir });
    expect(deleteProject(c.id)).toBe(true);
    expect(listProjects().some((p) => p.id === c.id)).toBe(false);
  });

  it("derives name from folder basename when name is omitted", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-named-"));
    const c = createProject({ path: dir });
    expect(c.name).toBe(path.basename(dir));
  });

  it("aggregates task counts, total, activeNonDone and preview per project", async () => {
    const { isActiveStatus, TASK_STATUSES } = await import("@actana/shared/domain");
    const db = getDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-counts-"));
    const c = createProject({ name: "counts", path: dir });

    // Insert in a fixed order so implicit rowid ascends with insertion; the
    // earliest-inserted running task must supply the preview.
    let seq = 0;
    const addTask = (status: string, opts: { preview?: string; archived?: boolean } = {}) => {
      const now = Date.now() + seq;
      db.insert(tasks)
        .values({
          id: `t-${seq}`,
          projectId: c.id,
          title: `task-${seq}`,
          agent: "claude-code",
          status: status as never,
          preview: opts.preview ?? "",
          archived: opts.archived ? true : false,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      seq += 1;
    };

    addTask("ready");
    addTask("ready");
    addTask("running", { preview: "first-running" });
    addTask("running", { preview: "second-running" });
    addTask("needs-input", { preview: "waiting" });
    addTask("finished");
    addTask("interrupted");
    // Archived rows must be excluded entirely from counts and preview.
    addTask("running", { preview: "archived-running", archived: true });

    const listed = listProjects().find((p) => p.id === c.id);
    expect(listed).toBeTruthy();
    const counts = listed!.taskCounts;

    expect(counts.ready).toBe(2);
    expect(counts.running).toBe(2);
    expect(counts["needs-input"]).toBe(1);
    expect(counts.finished).toBe(1);
    expect(counts.interrupted).toBe(1);
    expect(counts.terminated).toBe(0);
    expect(counts.disconnected).toBe(0);
    // total = non-archived task count (the archived running row is excluded).
    expect(counts.total).toBe(7);

    const expectedActiveNonDone = TASK_STATUSES.filter(
      (s) => isActiveStatus(s) && s !== "finished",
    ).reduce((acc, s) => acc + counts[s], 0);
    expect(counts.activeNonDone).toBe(expectedActiveNonDone);

    // Earliest running task wins the preview over the later running + needs-input.
    expect(listed!.preview).toBe("first-running");
  });

  it("falls back to the needs-input preview when no task is running", () => {
    const db = getDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-preview-ni-"));
    const c = createProject({ name: "ni", path: dir });
    const now = Date.now();
    db.insert(tasks)
      .values({
        id: "ni-1",
        projectId: c.id,
        title: "waiting",
        agent: "claude-code",
        status: "needs-input" as never,
        preview: "needs you",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const listed = listProjects().find((p) => p.id === c.id);
    expect(listed!.preview).toBe("needs you");
  });

  it("reports zeroed counts and null preview for a project with no tasks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-proj-empty-"));
    const c = createProject({ name: "empty", path: dir });
    const listed = listProjects().find((p) => p.id === c.id);
    expect(listed!.taskCounts.total).toBe(0);
    expect(listed!.taskCounts.activeNonDone).toBe(0);
    expect(listed!.taskCounts.running).toBe(0);
    expect(listed!.preview).toBeNull();
  });

  it("caches the detected github url and re-reads only when .git/config mtime changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-gh-cache-"));
    fs.mkdirSync(path.join(dir, ".git"));
    const cfg = path.join(dir, ".git", "config");
    fs.writeFileSync(cfg, '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n');
    // Pin mtime to a whole-second value so the later exact comparison is stable
    // across filesystem timestamp granularities.
    const t0 = new Date(Math.floor(Date.now() / 1000) * 1000);
    fs.utimesSync(cfg, t0, t0);
    _resetGithubUrlCache();

    expect(detectGithubUrl(dir)).toBe("https://github.com/acme/widgets");

    // Rewrite the remote but restore the original mtime: a cache hit must serve
    // the old parse without re-reading the file.
    fs.writeFileSync(cfg, '[remote "origin"]\n\turl = git@github.com:acme/rebranded.git\n');
    fs.utimesSync(cfg, t0, t0);
    expect(detectGithubUrl(dir)).toBe("https://github.com/acme/widgets");

    // Advance the mtime: the cache invalidates and the new remote is parsed.
    const t1 = new Date(t0.getTime() + 5000);
    fs.utimesSync(cfg, t1, t1);
    expect(detectGithubUrl(dir)).toBe("https://github.com/acme/rebranded");
  });

  it("returns null (and caches) when there is no readable .git/config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-gh-none-"));
    _resetGithubUrlCache();
    expect(detectGithubUrl(dir)).toBeNull();
    // A later-created config with a real mtime must invalidate the null cache.
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(
      path.join(dir, ".git", "config"),
      '[remote "origin"]\n\turl = https://github.com/acme/later.git\n',
    );
    expect(detectGithubUrl(dir)).toBe("https://github.com/acme/later");
  });

});
