import * as fs from "node:fs";
import * as path from "node:path";
import { getSqlite } from "~/db/client";
import {
  TASK_STATUSES,
  isActiveStatus,
  isTaskStatus,
} from "@actana/shared/domain";
import { normalizeRepoRemote } from "~/shared/repo-key";
import type { TaskStatus } from "@actana/shared/domain";
import type { Project, Task } from "~/db/schema";
import type { ProjectPathStatus, ProjectWithCounts } from "~/shared/projects";
import { events } from "../events";
import { ValidationError } from "../errors";
import {
  deleteProjectRow,
  findAllProjects,
  findProjectById,
  insertProject,
  updateProjectRow,
} from "../repositories/projects.repo";
import { findTasksByProjectId } from "../repositories/tasks.repo";
import { deleteAllProjectImagesFor } from "./project-images";
import { newId } from "./_ids";
import { getPinnedProjects, nextPinnedOrder, validatePinnedReorder } from "~/lib/pinned-project-order";

export type { ProjectWithCounts } from "~/shared/projects";

function validateWorkingDirectory(dir: string): string {
  const trimmed = dir.trim();
  if (!trimmed) throw new ValidationError("Working directory is required");
  if (!fs.existsSync(trimmed)) throw new ValidationError("Working directory does not exist");
  const stat = fs.statSync(trimmed);
  if (!stat.isDirectory()) throw new ValidationError("Working directory must be a directory");
  try {
    fs.accessSync(trimmed, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new ValidationError("Working directory is not readable");
  }
  return trimmed;
}

function pathStatusFor(target: string): ProjectPathStatus {
  try {
    if (!fs.existsSync(target)) {
      return {
        ok: false,
        path: target,
        reason: "missing",
        message: "Actana Control cannot find this project folder.",
      };
    }
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        path: target,
        reason: "not-directory",
        message: "This path exists, but it is not a directory.",
      };
    }
    fs.accessSync(target, fs.constants.R_OK | fs.constants.X_OK);
    return { ok: true, path: target };
  } catch {
    return {
      ok: false,
      path: target,
      reason: "unreadable",
      message: "Actana Control cannot read this working directory.",
    };
  }
}

export function getProjectPathStatus(id: string): ProjectPathStatus | null {
  const project = findProjectById(id);
  if (!project) return null;
  return pathStatusFor(project.path);
}

// readOriginRemoteUrl runs inside decorate() (feeding both githubUrl and the
// repoKey field), which fires for every project on every listProjects();
// /api/projects re-lists on each project:*/task:* SSE event,
// so a burst of agent activity re-read and re-parsed each .git/config many
// times a minute. Cache the raw origin url per path, keyed by the config
// file's mtime so an external remote change still refreshes. The statSync
// itself is cheap and runs every call — only the read + regex is skipped on a
// hit. `mtimeMs: -1` records a "no config" result (missing file, or a checkout
// whose .git is a file) so repeated misses don't churn; it invalidates the
// moment a real config appears with a genuine mtime.
type OriginUrlCacheEntry = { mtimeMs: number; url: string | null };
const originUrlCache = new Map<string, OriginUrlCacheEntry>();

/** Test seam: drop cached origin-url reads so a test can force a re-read. */
export function _resetGithubUrlCache(): void {
  originUrlCache.clear();
}

/** Raw `origin` remote url from a repo's .git/config, or null. Cached by mtime. */
function readOriginRemoteUrl(dir: string): string | null {
  const cfg = path.join(dir, ".git", "config");
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(cfg).mtimeMs;
  } catch {
    // Missing config, or .git is a file (linked checkout) — matches the pre-cache
    // behavior of returning null for anything that isn't a readable config.
    originUrlCache.set(dir, { mtimeMs: -1, url: null });
    return null;
  }
  const cached = originUrlCache.get(dir);
  if (cached && cached.mtimeMs === mtimeMs) return cached.url;
  let url: string | null;
  try {
    const text = fs.readFileSync(cfg, "utf8");
    const m = text.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
    url = m ? m[1].trim() : null;
  } catch {
    url = null;
  }
  originUrlCache.set(dir, { mtimeMs, url });
  return url;
}

/** Normalize a raw origin url to https://github.com/owner/repo, or null. Pure. */
function githubUrlFromRemote(url: string | null): string | null {
  if (!url) return null;
  // git@github.com:owner/repo(.git)
  const ssh = url.match(/^git@github\.com:([^/]+\/[^/\s]+?)(?:\.git)?$/);
  if (ssh) return `https://github.com/${ssh[1]}`;
  // ssh://git@github.com/owner/repo(.git) or https://github.com/owner/repo(.git)
  const https = url.match(/^(?:https?|ssh):\/\/(?:[^@]+@)?github\.com\/([^/]+\/[^/\s]+?)(?:\.git)?$/);
  if (https) return `https://github.com/${https[1]}`;
  return null;
}

export function detectGithubUrl(dir: string): string | null {
  return githubUrlFromRemote(readOriginRemoteUrl(dir));
}

function emptyStatusCounts(): Record<TaskStatus, number> {
  return TASK_STATUSES.reduce(
    (acc, s) => {
      acc[s] = 0;
      return acc;
    },
    {} as Record<TaskStatus, number>,
  );
}

export function listProjects(): ProjectWithCounts[] {
  const rows = findAllProjects();
  // Aggregate non-archived task counts per (project, status) in SQLite instead
  // of loading every task row and filtering it per project in JS (was O(P×T)).
  type Agg = { counts: Record<TaskStatus, number>; total: number; activeNonDone: number };
  const aggByProject = new Map<string, Agg>();
  const statusCountRows = getSqlite()
    .prepare(
      `SELECT project_id AS projectId, status, COUNT(*) AS c
         FROM tasks
        WHERE archived = 0
        GROUP BY project_id, status`,
    )
    .all() as { projectId: string; status: string; c: number }[];
  for (const r of statusCountRows) {
    let agg = aggByProject.get(r.projectId);
    if (!agg) {
      agg = { counts: emptyStatusCounts(), total: 0, activeNonDone: 0 };
      aggByProject.set(r.projectId, agg);
    }
    agg.total += r.c;
    if (isTaskStatus(r.status)) {
      agg.counts[r.status] = r.c;
      if (isActiveStatus(r.status) && r.status !== "finished") agg.activeNonDone += r.c;
    }
  }

  // Preview text mirrors decorate()'s `active.find(running) ?? active.find(needs-input)`
  // over the rowid-ordered task scan: the earliest-inserted running task wins,
  // else the earliest needs-input task. Only active session rows qualify — a
  // tiny set — so this narrow query stays cheap.
  const runningPreview = new Map<string, string>();
  const needsInputPreview = new Map<string, string>();
  const previewRows = getSqlite()
    .prepare(
      `SELECT project_id AS projectId, status, preview
         FROM tasks
        WHERE archived = 0 AND status IN ('running', 'needs-input')
        ORDER BY rowid`,
    )
    .all() as { projectId: string; status: string; preview: string }[];
  for (const r of previewRows) {
    const target = r.status === "running" ? runningPreview : needsInputPreview;
    if (!target.has(r.projectId)) target.set(r.projectId, r.preview);
  }

  return rows.map((p) => {
    const agg = aggByProject.get(p.id);
    const counts = agg?.counts ?? emptyStatusCounts();
    const preview = runningPreview.get(p.id) ?? needsInputPreview.get(p.id) ?? null;
    // Same origin read as decorate() — repoKey ships on the list endpoint too.
    const originRemote = readOriginRemoteUrl(p.path);
    return {
      ...p,
      taskCounts: { ...counts, total: agg?.total ?? 0, activeNonDone: agg?.activeNonDone ?? 0 },
      preview,
      githubUrl: githubUrlFromRemote(originRemote),
      repoKey: normalizeRepoRemote(originRemote),
    };
  });
}

export function getProject(id: string): ProjectWithCounts | null {
  const p = findProjectById(id);
  if (!p) return null;
  return decorate(p, findTasksByProjectId(id));
}

function decorate(p: Project, ts: Task[]): ProjectWithCounts {
  const active = ts.filter((t) => !t.archived);
  const counts = TASK_STATUSES.reduce(
    (acc, s) => {
      acc[s] = 0;
      return acc;
    },
    {} as Record<TaskStatus, number>
  );
  let activeNonDone = 0;
  for (const t of active) {
    counts[t.status]++;
    if (isActiveStatus(t.status) && t.status !== "finished") activeNonDone++;
  }
  const previewSource =
    active.find((t) => t.status === "running") ?? active.find((t) => t.status === "needs-input");
  // Read .git/config once and derive both the GitHub url and the (any-host)
  // repo key from it, rather than reading + parsing the file twice per project.
  const originRemote = readOriginRemoteUrl(p.path);
  return {
    ...p,
    taskCounts: { ...counts, total: active.length, activeNonDone },
    preview: previewSource?.preview ?? null,
    githubUrl: githubUrlFromRemote(originRemote),
    repoKey: normalizeRepoRemote(originRemote),
  };
}

export function createProject(input: {
  name?: string;
  path: string;
  icon?: string;
  iconColor?: string;
  groupId?: string | null;
  /** Default agent to launch for this project's sessions (create-time onboarding). */
  savedHarness?: Project["savedHarness"] | null;
  /** When true, "New session" launches savedHarness directly instead of prompting. */
  rememberHarnessSettings?: boolean;
  /** Layout the project first opens in: true = grid, false = list. */
  defaultGridView?: boolean;
  /** Pin the project to the top of the sidebar the moment it's created. */
  pinned?: boolean;
}): Project {
  const localPath = validateWorkingDirectory(input.path ?? "");

  const name = input.name?.trim() || path.basename(localPath) || "project";

  const now = Date.now();
  const id = newId("p");
  // Only remember an agent when one was actually chosen at create time — a bare
  // "remember" with no agent would make "New session" a no-op.
  const savedHarness = input.savedHarness ?? null;
  const rememberHarnessSettings = !!input.rememberHarnessSettings && !!savedHarness;
  const row = {
    id,
    name,
    path: localPath,
    icon: (input.icon || name.slice(0, 2)).toUpperCase().slice(0, 2),
    iconColor: input.iconColor || "#ff5a1f",
    imagePath: null,
    groupId: input.groupId ?? null,
    pinned: !!input.pinned,
    pinnedOrder: input.pinned ? nextPinnedOrder(findAllProjects()) : null,
    launchUrl: null,
    rememberHarnessSettings,
    savedHarness,
    savedSkipPermissions: false,
    savedBareSession: false,
    defaultGridView: !!input.defaultGridView,
    createdAt: now,
    updatedAt: now,
  };
  insertProject(row);
  events.emit("project:created", { id });
  return row;
}

export function updateProject(
  id: string,
  patch: Partial<
    Pick<
      Project,
      | "name"
      | "path"
      | "icon"
      | "iconColor"
      | "imagePath"
      | "groupId"
      | "pinned"
      | "pinnedOrder"
      | "launchUrl"
      | "rememberHarnessSettings"
      | "savedHarness"
      | "savedSkipPermissions"
      | "savedBareSession"
      | "defaultGridView"
    >
  >
): Project | null {
  const existing = findProjectById(id);
  if (!existing) return null;
  const rest = patch;
  const nextPath =
    rest.path !== undefined ? validateWorkingDirectory(rest.path) : undefined;
  const updated = {
    ...existing,
    ...rest,
    ...(rest.pinned !== undefined
      ? {
          pinned: rest.pinned,
          pinnedOrder: rest.pinned
            ? rest.pinnedOrder ??
              existing.pinnedOrder ??
              nextPinnedOrder(findAllProjects())
            : null,
        }
      : {}),
    ...(nextPath !== undefined ? { path: nextPath } : {}),
    updatedAt: Date.now(),
  };
  updateProjectRow(id, updated);
  events.emit("project:updated", { id });
  return updated;
}

export function togglePin(id: string): Project | null {
  const togglePinned = getSqlite().transaction(() => {
    const existing = findProjectById(id);
    if (!existing) return null;
    const pinning = !existing.pinned;
    const now = Date.now();
    const pinnedOrder = pinning ? nextPinnedOrder(findAllProjects()) : null;
    const next = { ...existing, pinned: pinning, pinnedOrder, updatedAt: now };
    updateProjectRow(id, { pinned: pinning, pinnedOrder, updatedAt: now });
    return next;
  });
  const next = togglePinned.immediate();
  if (next) events.emit("project:updated", { id });
  return next;
}

/**
 * Write the rail slot of every pinned project this Panel owns.
 *
 * `order` is the whole rail, not this Panel's share of it. Since issue 382 a
 * rail mixes the Panel's own pins with the pins each Core owns, and a Core's
 * row has no `projects` row here — it reaches the rail as a core-link snapshot
 * and its slot is written to its presentation row instead (see
 * `reorderCorePins`). Sending only the Panel's own ids would have been the
 * easier shape and the wrong one: `pinnedOrder` would then be dense over the
 * Panel's rows alone, with no integer left to place a Core's row *between* two
 * of them, and the merged rail would sort back into an order nobody chose.
 *
 * So the index written here is the row's index in the rail, and ids belonging
 * to nobody in this database hold their slot and are skipped.
 */
export function reorderPinnedProjects(order: string[]): ProjectWithCounts[] {
  let written: string[] = [];
  const updatePinnedOrder = getSqlite().transaction(() => {
    const all = findAllProjects();
    const pinned = getPinnedProjects(all);
    try {
      validatePinnedReorder(order, pinned, new Set(all.map((project) => project.id)));
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : "invalid pinned order");
    }
    const ours = new Set(pinned.map((project) => project.id));
    const now = Date.now();
    written = order.filter((id) => ours.has(id));
    for (let index = 0; index < order.length; index++) {
      const id = order[index]!;
      if (ours.has(id)) updateProjectRow(id, { pinnedOrder: index, updatedAt: now });
    }
  });
  updatePinnedOrder.immediate();
  for (const id of written) events.emit("project:updated", { id });
  return listProjects();
}

export function deleteProject(id: string): boolean {
  const changes = deleteProjectRow(id);
  if (changes > 0) deleteAllProjectImagesFor(id);
  events.emit("project:deleted", { id });
  return changes > 0;
}
