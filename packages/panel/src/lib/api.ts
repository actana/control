import type { Session, UserTerminal } from "~/db/schema";
import type { Harness, SessionStatus } from "@actana/shared/domain";
import type { CoreListResponse, CoreWithDial } from "~/shared/cores";
import type { CorePairingIdentityResponse } from "~/shared/core-pairing";
import type { SharedConnectionResult, StorageConfigInput, StorageConfigView } from "~/shared/storage-wire";
import { DEV_SERVER_ORIGIN } from "~/shared/dev-server";
import { LOGIN_PATH, isAuthPath, withCarriedQuery } from "~/lib/auth-paths";
import type { Binding, BindingMap, HotkeyAction } from "~/lib/keybindings/types";
import type { UsageSummary } from "~/shared/token-usage";
import type { ClaudeUsageLimits } from "~/shared/claude-usage-limits";
import type { ProviderUsageId, ProviderUsageResponse } from "~/shared/provider-usage";
import type { HarnessLauncherConfig } from "~/shared/harness-launcher-config";
import type { HarnessAccountStatus, HarnessLatestVersion } from "~/shared/harness-launchers";
import type { PendingQuestion } from "~/shared/harness-questions";
import type { AiModelId, AiRuntimeModelsResponse } from "@actana/shared/ai-runtime-defaults";
import type { UpdateCheck } from "@actana/shared/actana-update-check";
import type { TerminalZoomLevel } from "~/shared/terminal-zoom";
import type { SessionHeaderButtonVisibility } from "~/shared/session-header-buttons";
import type { HeaderButtonVisibility } from "~/shared/header-buttons";
import { pruneStoredSessionFinishNotifications } from "~/lib/session-notification-store";
import { HTTP_NO_CONTENT } from "~/shared/http-status";
import type { TaskStatus } from "~/shared/tasks";
import type {
  SharedDownloadUrl,
  SharedFileDetails,
  SharedFilesListing,
  SharedFilesSearchResult,
  SharedFilesSummary,
} from "~/shared/shared-files";
import type {
  AgentDto,
  NewTaskCommentRequest,
  NewTaskRequest,
  TaskCommentDto,
  TaskDto,
} from "~/shared/task-wire";

export type AppSettings = {
  agentSystemBannerDisabled: boolean;
  mouseGradientDisabled: boolean;
  sessionFinishToastEnabled: boolean;
  sessionFinishOsNotificationEnabled: boolean;
  /** Ding when a session-finish notification arrives. */
  notificationSoundEnabled: boolean;
  /** Legacy compatibility field; native Claude Code question popups are always enabled. */
  questionOverlayEnabled: boolean;
  /** Default terminal text zoom (-2 … +2). Per-pane overrides live in localStorage. */
  terminalZoomLevel: TerminalZoomLevel;
  /**
   * Which discretionary session-pane header buttons are shown. Zoom is hidden
   * by default (it's driven by keyboard shortcuts); the rest default on.
   */
  sessionHeaderButtons: SessionHeaderButtonVisibility;
  /**
   * Which discretionary top-bar / Core-header buttons are shown. All default
   * on; each action keeps its keyboard shortcut while hidden.
   */
  headerButtons: HeaderButtonVisibility;
  /**
   * Default core/model for spawned agents when the caller doesn't name one.
   * `null` means "not set" — don't pass a model flag, so the CLI uses its own default.
   */
  defaultHarness: Harness;
  defaultModel: AiModelId | null;
  /**
   * Core/model/prompt for the Ship button, which opens an AI session to push
   * and sync with remote (pull/rebase/conflict fix when needed).
   */
  shipHarness: Harness;
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
  harnessLauncherConfig: HarnessLauncherConfig;
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
  const { pathname, search } = window.location;
  if (isAuthPath(pathname)) return;
  // The third leg of the same round trip `documentAuthRedirect` and the two
  // auth pages make, so it carries the query for the same reason (#406): an
  // expiry under an open `/?step=redeem` should come back to `/?step=redeem`.
  window.location.assign(withCarriedQuery(LOGIN_PATH, search));
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

/** `/api/cores/:coreId/shared/files[/leaf]`: the Files tab's routes (#565). */
const sharedFilesUrl = (coreId: string, leaf = "") =>
  `/api/cores/${encodeURIComponent(coreId)}/shared/files${leaf ? `/${leaf}` : ""}`;
const pathQuery = (path: string) => `?path=${encodeURIComponent(path)}`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** An image or PDF of the Shared folder, streamed by the Panel: a URL for an `<img>` or an `<object>`, with no key in it. */
export const sharedFileMediaUrl = (coreId: string, path: string): string =>
  `${sharedFilesUrl(coreId, "media")}${pathQuery(path)}`;

/** The upload URL for one file: the body is the file's bytes, sent with `XMLHttpRequest` for progress. */
export const sharedFileUploadUrl = (coreId: string, path: string): string =>
  `${sharedFilesUrl(coreId, "upload")}${pathQuery(path)}`;

export const api = {
  /** A folder of a Core's Shared folder, read from S3 (the Core may be offline). */
  listSharedFiles: (coreId: string, path: string) =>
    req<SharedFilesListing>(`${sharedFilesUrl(coreId)}${pathQuery(path)}`),
  getSharedFileDetails: (coreId: string, path: string) =>
    req<SharedFileDetails>(`${sharedFilesUrl(coreId, "details")}${pathQuery(path)}`),
  searchSharedFiles: (coreId: string, query: string) =>
    req<SharedFilesSearchResult>(`${sharedFilesUrl(coreId, "search")}?q=${encodeURIComponent(query)}`),
  getSharedFilesSummary: (coreId: string, since: number) =>
    req<SharedFilesSummary>(`${sharedFilesUrl(coreId, "summary")}?since=${since}`),
  /** A URL for this one file, good for five minutes: the browser downloads from it. */
  sharedFileDownloadUrl: (coreId: string, path: string) =>
    req<SharedDownloadUrl>(sharedFilesUrl(coreId, "download-url"), post({ path })),
  makeSharedFolder: (coreId: string, path: string) =>
    req<{ path: string }>(sharedFilesUrl(coreId, "mkdir"), post({ path })),
  renameSharedFile: (coreId: string, path: string, name: string) =>
    req<{ path: string }>(sharedFilesUrl(coreId, "rename"), post({ path, name })),
  moveSharedFile: (coreId: string, path: string, to: string) =>
    req<{ path: string }>(sharedFilesUrl(coreId, "move"), post({ path, to })),
  deleteSharedFile: (coreId: string, path: string) =>
    req<{ ok: true }>(sharedFilesUrl(coreId, "delete"), post({ path })),
  /** Every Task the owner has, across Cores. */
  listTasks: () => req<{ tasks: TaskDto[] }>("/api/tasks"),
  getTask: (id: string) =>
    req<{ task: TaskDto; comments: TaskCommentDto[] }>(`/api/tasks/${encodeURIComponent(id)}`),
  createTask: (body: NewTaskRequest) =>
    req<{ task: TaskDto }>("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  /** Assign or send back to draft. The server decides whether the move is legal. */
  setTaskStatus: (id: string, status: TaskStatus) =>
    req<{ task: TaskDto }>(`/api/tasks/${encodeURIComponent(id)}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
  /** A comment; with `reassign`, the service's single Comment & re-assign call. */
  commentOnTask: (id: string, body: NewTaskCommentRequest) =>
    req<{ comment?: TaskCommentDto; task?: TaskDto; comments?: TaskCommentDto[] }>(
      `/api/tasks/${encodeURIComponent(id)}/comments`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** One Core's Agents, from the Agents service. */
  listCoreAgents: (coreId: string) =>
    req<{ agents: AgentDto[] }>(`/api/cores/${encodeURIComponent(coreId)}/agents`),
  /** The fleet: every registered Core with the service's live view of its link. */
  listCores: () => req<CoreListResponse>("/api/cores"),
  /**
   * Rename a Core. The alias is the Panel's own name for the machine, so this
   * writes to the registry and stops there — nothing reaches the Core. The
   * response carries the normalized label (trimmed, 120 chars, endpoint host
   * when empty), which is what to render rather than what was typed.
   */
  renameCore: (id: string, label: string) =>
    req<{ core: CoreWithDial }>(`/api/cores/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ label }),
    }),
  /**
   * Ask the Panel server what certificate authority a Core presents (#286).
   *
   * No code goes in this request, which is what makes it safe to make against
   * an address nobody has verified yet: the answer is the fingerprint the
   * operator compares against what `actana pair new` printed, and the dial
   * that produced it sent nothing.
   */
  inspectCoreForPairing: (address: string) =>
    req<CorePairingIdentityResponse>("/api/cores/pairing/inspect", {
      method: "POST",
      body: JSON.stringify({ address }),
    }),
  /**
   * Pair with a Core by short code. The server dials, checks the fingerprint
   * again, redeems the code and registers what comes back — the key it now
   * holds was generated there and never crossed the wire, in either direction.
   *
   * A refusal is an ApiError whose `body` is a `CorePairingRefusal`: switch on
   * `failure` to say what to do next rather than rendering `message` alone.
   */
  pairCore: (body: {
    address: string;
    code: string;
    sessionId?: string;
    expectedFingerprint: string;
    label?: string;
  }) =>
    req<{ core: CoreWithDial }>("/api/cores/pairing", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Unpair: the Core is told to detach (it keeps `~/shared`), then forgotten. The S3 prefix stays. */
  removeCore: (id: string) => req<void>(`/api/cores/${id}`, { method: "DELETE" }),
  /** The Shared-folder storage config. The master key is never in the answer, only whether one is set. */
  getStorage: () => req<{ storage: StorageConfigView }>("/api/storage"),
  /** Write-only for the master key: send it to set or rotate it, leave it out to keep the stored one. */
  putStorage: (body: StorageConfigInput) =>
    req<{ storage: StorageConfigView }>("/api/storage", { method: "PUT", body: JSON.stringify(body) }),
  /** Pairing step 4: issue a 1-hour key for this Core and prove it reaches its own folder and no other. */
  testSharedFolder: (coreId: string) =>
    req<{ result: SharedConnectionResult }>(`/api/cores/${encodeURIComponent(coreId)}/shared/test`, {
      method: "POST",
    }),
  /** Pairing step 4: attach the Core's Shared folder. The pairing is not finished until this succeeds. */
  finishCorePairing: (coreId: string) =>
    req<{ core: CoreWithDial }>(`/api/cores/${encodeURIComponent(coreId)}/pairing/finish`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  /** Delete the Core and empty its S3 prefix; `confirmPrefix` must be exactly the prefix. */
  deleteCoreWithStorage: (coreId: string, confirmPrefix: string) =>
    req<{ prefix: string | null; removed: number }>(`/api/cores/${encodeURIComponent(coreId)}/delete`, {
      method: "POST",
      body: JSON.stringify({ confirmPrefix }),
    }),

  getSession: (id: string) => req<{ session: Session }>(`/api/sessions/${id}`),
  getSessionQuestion: (id: string) =>
    req<{ question: PendingQuestion | null }>(`/api/sessions/${id}/question`),
  archiveSession: (id: string) =>
    req<{ session: Session }>(`/api/sessions/${id}/archive`, { method: "POST" }),
  restoreSession: (id: string) =>
    req<{ session: Session }>(`/api/sessions/${id}/restore`, { method: "POST" }),
  updateSessionStatus: (id: string, body: { status?: SessionStatus; preview?: string; lines?: number; prompt?: string }) =>
    req<{ session: Session }>(`/api/sessions/${id}/status`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateSession: (
    id: string,
    body: {
      title?: string;
      pinned?: boolean;
      claudeSessionId?: string | null;
      claudeSkipPermissions?: boolean;
      claudeBareSession?: boolean;
    }
  ) =>
    req<{ session: Session }>(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteSession: async (id: string) => {
    await req<void>(`/api/sessions/${id}`, { method: "DELETE" });
    pruneStoredSessionFinishNotifications({ type: "session", sessionId: id });
  },

  // The Panel's only terminal rows (issue 266). Every terminal the Panel opens
  // is a VM Shell Session on a Core and persists here, whichever route opened
  // it.
  listHomeTerminals: () =>
    req<{ terminals: UserTerminal[] }>("/api/home/user-terminals"),
  createHomeTerminal: (body: {
    id?: string;
    name?: string;
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
        | "sessionFinishToastEnabled"
        | "sessionFinishOsNotificationEnabled"
        | "notificationSoundEnabled"
        | "questionOverlayEnabled"
        | "terminalZoomLevel"
        | "sessionHeaderButtons"
        | "headerButtons"
        | "defaultHarness"
        | "defaultModel"
        | "shipHarness"
        | "shipModel"
        | "shipPrompt"
        | "claudeUsageLimitsEnabled"
        | "claudeUsageLimitsShowSession"
        | "claudeUsageLimitsShowWeekly"
        | "providerUsageEnabled"
        | "providerUsageIds"
        | "harnessLauncherConfig"
      >
    >,
  ) =>
    req<AppSettings>("/api/settings", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  listAiRuntimeModels: (agent: Harness) =>
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
  getHarnessAccounts: () =>
    req<{ accounts: HarnessAccountStatus[] }>("/api/harness-launchers/accounts"),
  getHarnessLatestVersions: (agents?: readonly Harness[], opts?: { refresh?: boolean }) => {
    const params = new URLSearchParams();
    if (agents && agents.length > 0) params.set("harnesses", agents.join(","));
    if (opts?.refresh) params.set("refresh", "1");
    const q = params.size > 0 ? `?${params.toString()}` : "";
    return req<{ versions: HarnessLatestVersion[] }>(`/api/harness-launchers/latest-versions${q}`);
  },
  /**
   * Whether a newer Actana release exists than the one this Panel is running.
   * Alert-only — there is no companion call that would apply it.
   */
  getUpdateCheck: () => req<UpdateCheck>("/api/update-check"),
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
