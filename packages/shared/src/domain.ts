import { safeJsonParse } from "./safe-json";

export const HARNESSES = ["claude-code", "codex", "cursor-cli", "opencode", "pi"] as const;
export type Harness = (typeof HARNESSES)[number];

export const SESSION_STATUSES = [
  "ready",
  "running",
  "needs-input",
  "interrupted",
  "finished",
  "terminated",
  "disconnected",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const DEFAULT_SESSION_STATUS: SessionStatus = "ready";
export const DEFAULT_BRANCH = "main";

export type SessionStatusMeta = {
  label: string;
  color: string;
  dot: boolean;
  shimmer: boolean;
  displayOrder: number;
  selectionPriority: number;
  countsAsActive: boolean;
  isTerminal: boolean;
};

export const SESSION_STATUS_META: Record<SessionStatus, SessionStatusMeta> = {
  ready: {
    label: "Ready",
    color: "var(--status-ready)",
    dot: true,
    shimmer: false,
    displayOrder: 1,
    selectionPriority: 2,
    countsAsActive: true,
    isTerminal: false,
  },
  running: {
    label: "Running",
    color: "var(--status-running)",
    dot: true,
    shimmer: true,
    displayOrder: 2,
    selectionPriority: 1,
    countsAsActive: true,
    isTerminal: false,
  },
  "needs-input": {
    label: "Needs input",
    color: "var(--status-needs)",
    dot: true,
    shimmer: false,
    displayOrder: 0,
    selectionPriority: 0,
    countsAsActive: true,
    isTerminal: false,
  },
  interrupted: {
    label: "Interrupted",
    color: "var(--status-interrupted)",
    dot: true,
    shimmer: false,
    displayOrder: 0.5,
    selectionPriority: 0.5,
    countsAsActive: true,
    isTerminal: false,
  },
  finished: {
    label: "Finished",
    color: "var(--status-done)",
    dot: true,
    shimmer: false,
    displayOrder: 3,
    selectionPriority: 3,
    countsAsActive: true,
    isTerminal: false,
  },
  terminated: {
    label: "Terminated",
    color: "var(--status-idle)",
    dot: false,
    shimmer: false,
    displayOrder: 4,
    selectionPriority: 4,
    countsAsActive: false,
    isTerminal: true,
  },
  disconnected: {
    label: "Disconnected",
    color: "var(--status-idle)",
    dot: true,
    shimmer: false,
    displayOrder: 5,
    selectionPriority: 5,
    countsAsActive: true,
    isTerminal: false,
  },
};

export const STATUS_DISPLAY_ORDER = [...SESSION_STATUSES].sort(
  (a, b) => SESSION_STATUS_META[a].displayOrder - SESSION_STATUS_META[b].displayOrder
);

export const STATUS_SELECTION_PRIORITY = [...SESSION_STATUSES].sort(
  (a, b) => SESSION_STATUS_META[a].selectionPriority - SESSION_STATUS_META[b].selectionPriority
);

export const ACTIVE_STATUSES = SESSION_STATUSES.filter((s) => SESSION_STATUS_META[s].countsAsActive);
export const TERMINAL_STATUSES = SESSION_STATUSES.filter((s) => SESSION_STATUS_META[s].isTerminal);

export const isHarness = (value: unknown): value is Harness =>
  typeof value === "string" && (HARNESSES as readonly string[]).includes(value);

export const isSessionStatus = (value: unknown): value is SessionStatus =>
  typeof value === "string" && (SESSION_STATUSES as readonly string[]).includes(value);

export const isActiveStatus = (s: SessionStatus) => SESSION_STATUS_META[s].countsAsActive;
export const isTerminalStatus = (s: SessionStatus) => SESSION_STATUS_META[s].isTerminal;

