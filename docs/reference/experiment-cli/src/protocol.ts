// The core-link wire protocol, as the Core defines it.
//
// Mirrors packages/shared/src/core-link-frames.ts in the mission-control-updated
// repo. Frames are one JSON object per WebSocket message; the envelope is flat
// and correlated by `reqId`. There is no `payload` wrapper.

export const PROTOCOL_VERSION = "0.15.0";

export type Harness = "claude-code" | "codex" | "cursor-cli" | "opencode";

export const HARNESSES: Harness[] = ["claude-code", "codex", "cursor-cli", "opencode"];

/** Decoded pairing token. Everything needed to open and authenticate a socket. */
export type RegistrationBlob = {
  endpoint: string; // wss://host:port — no path
  label?: string;
  caCert: string;
  clientCert: string;
  clientKey: string;
  bearer: string;
};

export type Frame = { type: string; reqId?: string; [key: string]: unknown };

export type SpawnOptions = {
  taskId: string;
  cwd: string;
  command: string;
  args?: string[];
  cols?: number;
  rows?: number;
  agent?: Harness;
  dangerouslySkipPermissions?: boolean;
  initialInput?: string;
};

// The snapshots name their own key — `projectId`/`taskId`, never a bare `id`.

export type Project = { projectId: string; name: string; path: string };

export type Task = {
  taskId: string;
  projectId: string;
  title: string;
  agent: string;
  status: string;
  /** The harness's own session id, or null before one has been observed. This
   *  is what `--resume` needs, so a task without it cannot be resumed. */
  claudeSessionId: string | null;
};

/** `ptyId` is null once the process is gone — that is what "still running" means. */
export type Session = { taskId: string; ptyId: string | null; status: string; updatedAt: number };

export type HarnessAvailability = {
  status: string;
  version?: string;
  requiredVersion?: string;
  path?: string;
};

export type DirListing = {
  path: string;
  entries: { name: string; isDirectory: boolean }[];
};

/**
 * Which result frame answers which request, and where the payload sits on it.
 *
 * The Core replies with a differently-named frame per request rather than a
 * generic envelope, so this table is what lets one `request()` serve them all.
 */
export const RESULT_OF: Record<string, { type: string; field?: string }> = {
  projectsList: { type: "projectsListResult", field: "projects" },
  projectsMutate: { type: "projectsMutateResult", field: "project" },
  tasksList: { type: "tasksListResult", field: "tasks" },
  tasksMutate: { type: "tasksMutateResult", field: "task" },
  sessionsList: { type: "sessionsListResult", field: "sessions" },
  agentsAvailabilityList: { type: "agentsAvailabilityListResult", field: "availability" },
  harnessInstall: { type: "harnessInstallAck" },
  dirList: { type: "dirListResult", field: "listing" },
  dirCreate: { type: "dirCreateResult", field: "path" },
  spawn: { type: "spawned" },
  write: { type: "writeResult", field: "ok" },
  resize: { type: "resizeResult", field: "ok" },
  kill: { type: "killResult", field: "ok" },
  findByTask: { type: "findByTaskResult", field: "ptyId" },
  replay: { type: "replayResult" },
  subscribe: { type: "subscribeAck" },
};
