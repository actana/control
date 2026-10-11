/**
 * What an API key may do (#688). A key is created with a set of these and the
 * set never changes afterwards: every REST route a key may call and every MCP
 * tool names the one permission it needs, and a key without it gets a 403.
 *
 * - `read`: every GET route and every read-only tool (Cores, Agents, Tasks,
 *   comments, a Core's Shared folder).
 * - `tasks:write`: create a Task, move it (assigned / draft), comment on it.
 * - `agents:write`: create and delete Agents.
 *
 * The permissions are independent: a key with `tasks:write` alone can write
 * Tasks but read nothing, which is what it says. Keys that existed before this
 * set did have every permission, and keep it (the migration gives them the
 * full set), so nothing that worked stops working.
 */
export const API_KEY_PERMISSIONS = ["read", "tasks:write", "agents:write"] as const;

export type ApiKeyPermission = (typeof API_KEY_PERMISSIONS)[number];

/** Every permission there is: what a key made before #688 has. */
export const ALL_API_KEY_PERMISSIONS: readonly ApiKeyPermission[] = API_KEY_PERMISSIONS;

export function isApiKeyPermission(value: unknown): value is ApiKeyPermission {
  return typeof value === "string" && (API_KEY_PERMISSIONS as readonly string[]).includes(value);
}

/** The permissions in their canonical order, each once, for a row or a label. */
export function normalizeApiKeyPermissions(permissions: Iterable<ApiKeyPermission>): ApiKeyPermission[] {
  const set = new Set(permissions);
  return API_KEY_PERMISSIONS.filter((p) => set.has(p));
}

/** What each permission is called and allows, for the dialog and the key list. */
export const API_KEY_PERMISSION_LABELS: Record<ApiKeyPermission, { title: string; detail: string }> = {
  read: { title: "Read", detail: "List and read Cores, Agents, Tasks, comments and Shared folders." },
  "tasks:write": { title: "Write Tasks", detail: "Create Tasks, assign them, comment on them." },
  "agents:write": { title: "Write Agents", detail: "Create and delete Agents." },
};
