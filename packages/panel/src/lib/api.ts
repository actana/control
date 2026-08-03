import type { Group, Project, Task, UserTerminal } from "~/db/schema";
import type { TaskAgent, TaskStatus } from "@actana/shared/domain";
import type { ProjectPathStatus, ProjectWithCounts } from "~/shared/projects";
import type { CoreListResponse, CoreWithDial } from "~/shared/cores";
import { DEV_SERVER_ORIGIN } from "~/shared/dev-server";
import type { Binding, BindingMap, HotkeyAction } from "~/lib/keybindings/types";
import type { UsageSummary } from "~/shared/token-usage";
import type { ClaudeUsageLimits } from "~/shared/claude-usage-limits";
import type { ProviderUsageId, ProviderUsageResponse } from "~/shared/provider-usage";
import type { AgentLauncherConfig } from "~/shared/agent-launcher-config";
import type { AgentAccountStatus, AgentLatestVersion } from "~/shared/agent-launchers";
import type { PendingQuestion } from "~/shared/agent-questions";
import type {
  AiModelId,
  AiRuntimeHarness,
  AiRuntimeModelsResponse,
} from "@actana/shared/ai-runtime-defaults";
import type { ProjectsDashboardView } from "~/shared/ui-preferences";
import type { TerminalZoomLevel } from "~/shared/terminal-zoom";
import type { SessionHeaderButtonVisibility } from "~/shared/session-header-buttons";
import type { HeaderButtonVisibility } from "~/shared/header-buttons";
import { pruneStoredSessionFinishNotifications } from "~/lib/session-notification-store";
import { HTTP_NO_CONTENT } from "~/shared/http-status";

export type AppSettings = {
  agentSystemBannerDisabled: boolean;
  mouseGradientDisabled: boolean;
  /** Show the active-group switcher pill in the top bar breadcrumb. */
  showGroupSwitcher: boolean;
  /** Show the group tag (colored dot + group name) in an open project's header. */
  showProjectHeaderGroup: boolean;
  sessionFinishToastEnabled: boolean;
  sessionFinishOsNotificationEnabled: boolean;
  /** Ding when a session-finish notification arrives. */
  notificationSoundEnabled: boolean;
  /** Legacy compatibility field; native Claude Code question popups are always enabled. */
  questionOverlayEnabled: boolean;
  /** Projects dashboard layout — cards (default) or table. */
  projectsDashboardView: ProjectsDashboardView | null;
  /**
   * Globally active project group scoping the dashboard, left rail, and
   * project picker: "ungrouped", a group id, or null for "all projects".
   */
  activeProjectGroup: string | null;
  /** Collapsed dashboard section keys — group ids plus "pinned"/"ungrouped". */
  collapsedProjectGroups: string[] | null;
  /** Default terminal text zoom (-2 … +2). Per-pane overrides live in localStorage. */
  terminalZoomLevel: TerminalZoomLevel;
  /**
   * Which discretionary session-pane header buttons are shown. Zoom is hidden
   * by default (it's driven by keyboard shortcuts); the rest default on.
   */
  sessionHeaderButtons: SessionHeaderButtonVisibility;
  /**
   * Which discretionary top-bar / project-header buttons are shown. All default
   * on; each action keeps its keyboard shortcut while hidden.
   */
  headerButtons: HeaderButtonVisibility;
  /**
   * Default harness/model for spawned agents when the caller doesn't name one.
   * `null` means "not set" — don't pass a model flag, so the CLI uses its own default.
   */
  defaultAgent: AiRuntimeHarness;
  defaultModel: AiModelId | null;
  /**
   * Harness/model/prompt for the Ship button, which opens an AI session to push
   * and sync with remote (pull/rebase/conflict fix when needed).
   */
  shipAgent: AiRuntimeHarness;
  shipModel: AiModelId | null;
  shipPrompt: string;
  /**
   * Show Claude Code's live session (5h) + weekly usage limits in the top bar.
   * Off by default — enabling it makes the app fetch usage from Anthropic using
   * the user's Claude login. The two `show*` flags toggle each window.
   * Kept for backward compatibility; multi-provider uses `providerUsage*`.
   */
  claudeUsageLimitsEnabled: boolean;
  claudeUsageLimitsShowSession: boolean;
  claudeUsageLimitsShowWeekly: boolean;
  /**
   * Multi-provider usage (CodexBar fork): master toggle + which providers appear
   * in the compact top-bar control. Off by default so the chrome stays quiet.
   */
  providerUsageEnabled: boolean;
  providerUsageIds: ProviderUsageId[];
  /** New Session picker: agent display order + hidden agents (never all hidden). */
  agentLauncherConfig: AgentLauncherConfig;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * A session that died under an open tab (logout elsewhere, password change,
 * expiry) surfaces as a 401 on the next call. Send the browser to the login
 * page rather than letting the shell sit there rendering empty queries.
 */
function redirectToLoginOnce(): void {
  if (typeof window === "undefined") return;
  const { pathname } = window.location;
  if (pathname === "/login" || pathname === "/setup") return;
  window.location.assign("/login");
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  // Node's fetch (used during TanStack Start SSR) rejects relative URLs.
  // In the browser the page origin is implicit; on the server, prepend the
  // Vite dev origin so loader prefetches resolve correctly.
  const resolved =
    typeof window === "undefined" && url.startsWith("/")
      ? DEV_SERVER_ORIGIN + url
      : url;
  const baseHeaders: Record<string, string> = { "content-type": "application/json" };
  const res = await fetch(resolved, {
    // Explicit: every one of these calls is authenticated by the Operator's
    // session cookie, and by nothing else.
    credentials: "same-origin",
    ...init,
    headers: {
      ...baseHeaders,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    if (res.status === 401) redirectToLoginOnce();
    const text = await res.text().catch(() => "");
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON — keep as text
    }
    const message =
      (body && typeof body === "object" && "error" in body && typeof (body as any).error === "string"
        ? (body as any).error
        : null) ?? `${res.status} ${res.statusText}: ${text}`;
    throw new ApiError(message, res.status, body);
  }
  if (res.status === HTTP_NO_CONTENT) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  /** The fleet: every registered Core with the service's live view of its link. */
  listCores: () => req<CoreListResponse>("/api/cores"),
  /**
   * Register a Core. The blob is the whole base64 line `harness install`
   * printed ("pairing token" in what the UI says); the service decodes it,
   * seals the credentials, and starts dialing. A bad paste comes back as an
   * ApiError whose message is what to show the operator.
   */
  addCore: (registrationBlob: string) =>
    req<{ core: CoreWithDial }>("/api/cores", {
      method: "POST",
      body: JSON.stringify({ registrationBlob }),
    }),
  removeCore: (id: string) => req<void>(`/api/cores/${id}`, { method: "DELETE" }),

  listProjects: () => req<{ projects: ProjectWithCounts[] }>("/api/projects"),
  getProject: (id: string) => req<{ project: ProjectWithCounts }>(`/api/projects/${id}`),
  getProjectPathStatus: (id: string) =>
    req<{ status: ProjectPathStatus }>(`/api/projects/${id}/path-status`),
  createProject: (body: {
    name?: string;
    path: string;
    githubUrl?: string;
    icon?: string;
    iconColor?: string;
    groupId?: string | null;
    savedAgent?: Project["savedAgent"] | null;
    rememberAgentSettings?: boolean;
    defaultGridView?: boolean;
    pinned?: boolean;
  }) =>
    req<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateProject: (id: string, body: Record<string, unknown>) =>
    req<{ project: Project }>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  /** Upload a project's card image. The Panel service stores the bytes and
   *  returns the updated row. */
  uploadProjectImage: async (id: string, file: File) => {
    const { project } = await req<{ project: Project }>(
      `/api/projects/${id}/image`,
      {
        method: "PUT",
        headers: { "content-type": file.type },
        body: file,
      },
    );
    return project;
  },
  deleteProjectImage: (id: string) =>
    req<{ project: Project }>(`/api/projects/${id}/image`, { method: "DELETE" }),
  updateProjectLaunchUrl: (id: string, launchUrl: string | null) =>
    req<{ project: Project }>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ launchUrl }),
    }),
  togglePin: (id: string) =>
    req<{ project: Project }>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ togglePin: true }),
    }),
  reorderPinnedProjects: (order: string[]) =>
    req<{ projects: ProjectWithCounts[] }>("/api/projects/pinned-order", {
      method: "PATCH",
      body: JSON.stringify({ order }),
    }),
  deleteProject: async (id: string) => {
    await req<void>(`/api/projects/${id}`, { method: "DELETE" });
    pruneStoredSessionFinishNotifications({ type: "project", projectId: id });
  },

  listGroups: () => req<{ groups: Group[] }>("/api/groups"),
  createGroup: (body: { name: string; color?: string }) =>
    req<{ group: Group }>("/api/groups", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateGroup: (id: string, body: { name?: string; color?: string }) =>
    req<{ group: Group }>(`/api/groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  reorderGroups: (order: string[]) =>
    req<{ groups: Group[] }>("/api/groups/order", {
      method: "PATCH",
      body: JSON.stringify({ order }),
    }),
  deleteGroup: (id: string) =>
    req<void>(`/api/groups/${id}`, { method: "DELETE" }),

  listTasks: (projectId: string) =>
    req<{ tasks: Task[] }>(`/api/projects/${projectId}/tasks`),
  getTask: (id: string) => req<{ task: Task }>(`/api/tasks/${id}`),
  getTaskQuestion: (id: string) =>
    req<{ question: PendingQuestion | null }>(`/api/tasks/${id}/question`),
  archiveTask: (id: string) =>
    req<{ task: Task }>(`/api/tasks/${id}/archive`, { method: "POST" }),
  restoreTask: (id: string) =>
    req<{ task: Task }>(`/api/tasks/${id}/restore`, { method: "POST" }),
  updateTaskStatus: (id: string, body: { status?: TaskStatus; preview?: string; lines?: number; prompt?: string }) =>
    req<{ task: Task }>(`/api/tasks/${id}/status`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  createTaskInternal: (
    projectId: string,
    body: {
      id?: string;
      title: string;
      agent: TaskAgent;
      claudeSessionId?: string | null;
      claudeSkipPermissions?: boolean;
      claudeBareSession?: boolean;
    },
  ) =>
    req<{ task: Task }>(`/api/projects/${projectId}/tasks`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateTask: (
    id: string,
    body: {
      title?: string;
      pinned?: boolean;
      claudeSessionId?: string | null;
      claudeSkipPermissions?: boolean;
      claudeBareSession?: boolean;
    }
  ) =>
    req<{ task: Task }>(`/api/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteTask: async (id: string) => {
    await req<void>(`/api/tasks/${id}`, { method: "DELETE" });
    pruneStoredSessionFinishNotifications({ type: "task", taskId: id });
  },

  listUserTerminals: (projectId: string) =>
    req<{ terminals: UserTerminal[] }>(`/api/projects/${projectId}/user-terminals`),
  createUserTerminal: (
    projectId: string,
    body: {
      id?: string;
      name?: string;
      cwd?: string | null;
      startCommand?: string | null;
    },
  ) =>
    req<{ terminal: UserTerminal }>(`/api/projects/${projectId}/user-terminals`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  renameUserTerminal: (id: string, name: string) =>
    req<{ terminal: UserTerminal }>(`/api/user-terminals/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  deleteUserTerminal: (id: string) =>
    req<void>(`/api/user-terminals/${id}`, { method: "DELETE" }),

  // Project-less "home" terminals (the dashboard terminals). Returned shaped as
  // UserTerminal (sentinel projectId) so the same terminal store/panel render them.
  listHomeTerminals: () =>
    req<{ terminals: UserTerminal[] }>("/api/home/user-terminals"),
  createHomeTerminal: (body: {
    id?: string;
    name?: string;
    cwd?: string | null;
  }) =>
    req<{ terminal: UserTerminal }>("/api/home/user-terminals", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  renameHomeTerminal: (id: string, name: string) =>
    req<{ terminal: UserTerminal }>(`/api/home/user-terminals/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  deleteHomeTerminal: (id: string) =>
    req<void>(`/api/home/user-terminals/${id}`, { method: "DELETE" }),

  getKeybindings: () => req<{ bindings: BindingMap }>("/api/keybindings"),
  setKeybinding: (action: HotkeyAction, binding: Binding) =>
    req<{ bindings: BindingMap }>("/api/keybindings", {
      method: "PUT",
      body: JSON.stringify({ action, binding }),
    }),
  resetKeybinding: (action: HotkeyAction) =>
    req<{ bindings: BindingMap }>(`/api/keybindings?action=${encodeURIComponent(action)}`, {
      method: "DELETE",
    }),
  resetAllKeybindings: () =>
    req<{ bindings: BindingMap }>("/api/keybindings", { method: "DELETE" }),

  getSettings: () => req<AppSettings>("/api/settings"),

  updateSettings: (
    body: Partial<
      Pick<
        AppSettings,
        | "agentSystemBannerDisabled"
        | "mouseGradientDisabled"
        | "showGroupSwitcher"
        | "showProjectHeaderGroup"
        | "sessionFinishToastEnabled"
        | "sessionFinishOsNotificationEnabled"
        | "notificationSoundEnabled"
        | "questionOverlayEnabled"
        | "projectsDashboardView"
        | "activeProjectGroup"
        | "collapsedProjectGroups"
        | "terminalZoomLevel"
        | "sessionHeaderButtons"
        | "headerButtons"
        | "defaultAgent"
        | "defaultModel"
        | "shipAgent"
        | "shipModel"
        | "shipPrompt"
        | "claudeUsageLimitsEnabled"
        | "claudeUsageLimitsShowSession"
        | "claudeUsageLimitsShowWeekly"
        | "providerUsageEnabled"
        | "providerUsageIds"
        | "agentLauncherConfig"
      >
    >,
  ) =>
    req<AppSettings>("/api/settings", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  listAiRuntimeModels: (agent: AiRuntimeHarness) =>
    req<AiRuntimeModelsResponse>(
      `/api/ai-runtime/models?agent=${encodeURIComponent(agent)}`,
    ),

  getUsage: (days: number = 30) =>
    req<UsageSummary>(`/api/usage?days=${days}`),
  getClaudeUsageLimits: () =>
    req<ClaudeUsageLimits>("/api/claude-usage-limits"),
  getProviderUsage: (providerIds?: readonly string[]) => {
    const q =
      providerIds && providerIds.length > 0
        ? `?providers=${encodeURIComponent(providerIds.join(","))}`
        : "";
    return req<ProviderUsageResponse>(`/api/provider-usage${q}`);
  },
  getAgentAccounts: () =>
    req<{ accounts: AgentAccountStatus[] }>("/api/agent-launchers/accounts"),
  getAgentLatestVersions: (agents?: readonly TaskAgent[], opts?: { refresh?: boolean }) => {
    const params = new URLSearchParams();
    if (agents && agents.length > 0) params.set("agents", agents.join(","));
    if (opts?.refresh) params.set("refresh", "1");
    const q = params.size > 0 ? `?${params.toString()}` : "";
    return req<{ versions: AgentLatestVersion[] }>(`/api/agent-launchers/latest-versions${q}`);
  },
  getAuthState: () => req<AuthStateResponse>("/api/auth/state"),
  setupOperator: (body: { name: string; password: string }) =>
    req<{ operator: { name: string } }>("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  login: (password: string) =>
    req<{ operator: { name: string } | null }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  logout: () => req<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    req<{ ok: true }>("/api/auth/password", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export type AuthStateResponse = {
  needsSetup: boolean;
  authenticated: boolean;
  operator: { name: string } | null;
};
