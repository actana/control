import { useEffect, useState, type CSSProperties } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistance } from "date-fns";
import { Btn } from "~/components/ui/Btn";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { FormErrorBox } from "~/components/ui/FormErrorBox";
import { Icon } from "~/components/ui/Icon";
import { Modal } from "~/components/ui/Modal";
import { TextField } from "~/components/ui/TextField";
import { CodeBlock, SettingsSection, useCopy } from "~/components/views/SettingsParts";
import { api, ApiError } from "~/lib/api";
import { formatRelativeTime } from "~/lib/format-relative-time";
import { useCores } from "~/lib/use-fleet";
import { queryKeys, useApiKeys, useWebhooks } from "~/queries";
import {
  mcpAddCommand,
  restApiBaseLine,
  type ApiKeyView,
  type WebhookDeliveryView,
  type WebhookView,
} from "~/shared/api-integrations-wire";
import {
  API_KEY_PERMISSIONS,
  API_KEY_PERMISSION_LABELS,
  normalizeApiKeyPermissions,
  type ApiKeyPermission,
} from "~/shared/api-key-permissions";
import { WEBHOOK_CHANGE_EVENT_TYPES } from "~/shared/webhooks";

/**
 * Settings › API & integrations (screen 09 of the 0.5.0 design; #572 / #573 / #574).
 *
 * An operator lists, creates (plaintext shown once), restricts to chosen Cores, gives
 * an optional expiry to (#689) and revokes API keys; copies the ready-made MCP
 * command; and manages webhooks (create with events and Core scope, see the last
 * delivery, send a ping, delete).
 *
 * A key is created with its permissions and its Core scope (#688): the dialog
 * preselects the narrowest permission (`read`) and no Core scope at all, so the
 * widest key is never the one that falls out of pressing Create. Both are shown
 * on every key in the list.
 *
 * The old page described the Core's hook token (`actana token regenerate`). That
 * token is still a Core concern (`actana status` on the Core; hookTokenQueryOptions
 * returns null here), and this page replaces that copy with the Panel REST / MCP /
 * webhook surface. The Core hook-token feature itself is unchanged.
 *
 * Plaintext keys and webhook secrets are handed to the shown-once dialog inside
 * `mutationFn` and never returned as mutation `data`, so React Query's mutation
 * cache holds none after Done. Never in a URL, never in storage.
 */

type ShownOnce =
  | { kind: "api-key"; name: string; value: string }
  | { kind: "webhook-secret"; url: string; value: string };

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function panelOrigin(): string {
  if (typeof window === "undefined") return "https://panel.example.com";
  return window.location.origin;
}

function coreScopeLabel(
  allCores: boolean,
  coreIds: string[],
  labels: Map<string, string>,
): string {
  if (allCores) return "All Cores";
  if (coreIds.length === 0) return "No Cores";
  return coreIds.map((id) => labels.get(id) ?? id).join(", ");
}

/** `read · tasks:write`, in canonical order; a key from before #688 shows the full set. */
function permissionsLabel(permissions: ApiKeyPermission[]): string {
  return normalizeApiKeyPermissions(permissions).join(" · ");
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The expiry choices of the Create API key dialog (#689): a preset in days, a
 * date of the operator's own, or never. The server takes an epoch-ms instant,
 * so the choice is turned into one here, at Create.
 */
const API_KEY_EXPIRY_PRESET_DAYS = [7, 30, 90] as const;
type ExpiryChoice = "never" | `${(typeof API_KEY_EXPIRY_PRESET_DAYS)[number]}d` | "custom";

/** The instant a chosen expiry stands for, or null for never; undefined when a custom date is missing or not in the future. */
function expiryInstant(choice: ExpiryChoice, customDate: string, now = Date.now()): number | null | undefined {
  if (choice === "never") return null;
  if (choice === "custom") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(customDate);
    if (!m) return undefined;
    // The end of that day, local time: a key that "expires on the 31st" works through the 31st.
    const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime();
    return Number.isFinite(at) && at > now ? at : undefined;
  }
  return now + Number.parseInt(choice, 10) * DAY_MS;
}

/** The local calendar day of an instant, as YYYY-MM-DD: the same timezone a custom expiry date is read in. */
function isoDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Tomorrow's local day, the earliest a custom expiry can be picked (by calendar, not +24 h, so a DST day cannot skip it). */
function tomorrowDay(now = Date.now()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  return isoDay(d.getTime());
}

/** The expiry part of a key's status line: what it says, and whether the key has expired. */
function expiryLabel(expiresAt: number | null, now = Date.now()): { text: string; expired: boolean } {
  if (expiresAt === null) return { text: "no expiry", expired: false };
  if (expiresAt <= now) return { text: `expired ${isoDay(expiresAt)}`, expired: true };
  return { text: `expires ${isoDay(expiresAt)}`, expired: false };
}

/** Future retry due-time only — do not use formatRelativeTime (it maps clock-skew futures to "just now"). */
function formatRetryDue(nextAttemptAt: number, now = Date.now()): string {
  return formatDistance(new Date(nextAttemptAt), new Date(now), { addSuffix: true });
}

function lastDeliveryLabel(d: WebhookDeliveryView | null, now = Date.now()): string {
  if (!d) return "no deliveries yet";
  if (d.status === "delivered") {
    const code = d.lastStatusCode ?? 200;
    const when = d.deliveredAt ?? d.createdAt;
    return `last delivery ${code} · ${formatRelativeTime(when, now)}`;
  }
  if (d.status === "failed") {
    return `last delivery failed · ${formatRelativeTime(d.createdAt, now)}`;
  }
  if (d.status === "pending" && d.nextAttemptAt && d.nextAttemptAt > now) {
    return `last delivery failed · retry ${formatRetryDue(d.nextAttemptAt, now)}`;
  }
  if (d.status === "pending") {
    return `last delivery pending · ${formatRelativeTime(d.createdAt, now)}`;
  }
  return `last delivery ${d.status} · ${formatRelativeTime(d.createdAt, now)}`;
}

export function ApiSettingsPage() {
  const queryClient = useQueryClient();
  const { copied, copy } = useCopy();
  const { cores } = useCores();
  const coreLabels = new Map(cores.map((c) => [c.id, c.label]));

  const keysQuery = useApiKeys();
  const webhooksQuery = useWebhooks();
  const apiKeys = keysQuery.data ?? [];
  const webhooks = webhooksQuery.data ?? [];

  const [error, setError] = useState<string | null>(null);
  const [shownOnce, setShownOnce] = useState<ShownOnce | null>(null);
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [createWebhookOpen, setCreateWebhookOpen] = useState(false);
  const [revokeKey, setRevokeKey] = useState<ApiKeyView | null>(null);
  const [deleteHook, setDeleteHook] = useState<WebhookView | null>(null);
  const [expandedKeyId, setExpandedKeyId] = useState<string | null>(null);
  const [expandedHookId, setExpandedHookId] = useState<string | null>(null);

  const origin = panelOrigin();
  const restLine = restApiBaseLine(origin);
  const mcpLine = mcpAddCommand(origin);

  const refreshKeys = () => queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
  const refreshWebhooks = () => queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });

  // Plaintext must not become mutation `data` (R1). Hand it to the dialog here
  // and return only the view; reset on close so the cache retains nothing.
  const createKey = useMutation({
    mutationFn: async (input: { name: string; coreIds: string[] | null; permissions: ApiKeyPermission[]; expiresAt: number | null }) => {
      const res = await api.createApiKey(input);
      setShownOnce({ kind: "api-key", name: res.apiKey.name, value: res.key });
      return res.apiKey;
    },
    onSuccess: async () => {
      setCreateKeyOpen(false);
      await refreshKeys();
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeApiKey(id),
    onSuccess: async () => {
      setRevokeKey(null);
      await refreshKeys();
    },
  });

  const createHook = useMutation({
    mutationFn: async (input: { url: string; events: string[]; coreIds: string[] | null }) => {
      const res = await api.createWebhook(input);
      setShownOnce({ kind: "webhook-secret", url: res.webhook.url, value: res.secret });
      return res.webhook;
    },
    onSuccess: async () => {
      setCreateWebhookOpen(false);
      await refreshWebhooks();
    },
  });

  const removeHook = useMutation({
    mutationFn: (id: string) => api.deleteWebhook(id),
    onSuccess: async () => {
      setDeleteHook(null);
      await refreshWebhooks();
    },
  });

  const ping = useMutation({
    mutationFn: (id: string) => api.pingWebhook(id),
    onSuccess: async () => {
      await refreshWebhooks();
    },
    onError: (err) => setError(messageOf(err)),
  });

  const closeShownOnce = () => {
    setShownOnce(null);
    createKey.reset();
    createHook.reset();
  };

  return (
    <>
      <SettingsSection
        title="REST API"
        subtitle="Everything the Panel does is available here and in the SDK – Studio uses the same calls."
        headingLevel="h1"
      >
        <CodeBlock
          value={restLine}
          onCopy={() => copy(restLine, "rest")}
          copied={copied === "rest"}
          monoSize={11}
        />
      </SettingsSection>

      <SettingsSection
        title="API keys"
        subtitle="Shown once, stored as a hash. Each key has the permissions and the Cores you give it."
      >
        {(keysQuery.isError || webhooksQuery.isError || error) && (
          <div role="alert" style={{ color: "var(--danger)", fontSize: 12 }}>
            {error ??
              (keysQuery.error instanceof Error
                ? keysQuery.error.message
                : webhooksQuery.error instanceof Error
                  ? webhooksQuery.error.message
                  : "Could not load API settings")}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {apiKeys.map((key) => (
            <ApiKeyRow
              key={key.id}
              apiKey={key}
              coreLabels={coreLabels}
              expanded={expandedKeyId === key.id}
              onToggle={() => setExpandedKeyId((id) => (id === key.id ? null : key.id))}
              onRevoke={() => {
                revoke.reset();
                setRevokeKey(key);
              }}
            />
          ))}
          {apiKeys.length === 0 && !keysQuery.isLoading && (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>No API keys yet.</div>
          )}
        </div>
        <Btn
          variant="accent"
          icon="plus"
          onClick={() => {
            setError(null);
            createKey.reset();
            setCreateKeyOpen(true);
          }}
        >
          Create API key
        </Btn>
      </SettingsSection>

      <SettingsSection
        title="MCP server"
        subtitle="Tasks as tools: list_cores, list_agents, get_tasks, get_task, create_task, assign_task, comment_task."
      >
        <CodeBlock
          value={mcpLine}
          onCopy={() => copy(mcpLine, "mcp")}
          copied={copied === "mcp"}
          monoSize={11}
        />
      </SettingsSection>

      <SettingsSection
        title="Webhooks"
        subtitle="Signed with HMAC-SHA256 · https only · private addresses refused · retried 1m → 6h."
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {webhooks.map((hook) => (
            <WebhookRow
              key={hook.id}
              webhook={hook}
              coreLabels={coreLabels}
              expanded={expandedHookId === hook.id}
              onToggle={() => setExpandedHookId((id) => (id === hook.id ? null : hook.id))}
              onPing={() => {
                setError(null);
                ping.mutate(hook.id);
              }}
              onDelete={() => {
                removeHook.reset();
                setDeleteHook(hook);
              }}
              pinging={ping.isPending && ping.variables === hook.id}
            />
          ))}
          {webhooks.length === 0 && !webhooksQuery.isLoading && (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>No webhooks yet.</div>
          )}
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <Btn
            variant="accent"
            icon="plus"
            onClick={() => {
              setError(null);
              createHook.reset();
              setCreateWebhookOpen(true);
            }}
          >
            Add webhook
          </Btn>
          {webhooks[0] && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                ping.mutate(webhooks[0]!.id);
              }}
              style={{
                background: "none",
                border: "none",
                color: "var(--accent)",
                fontFamily: "var(--mono)",
                fontSize: 12,
                cursor: "pointer",
                padding: 0,
              }}
            >
              Send test
            </button>
          )}
        </div>
      </SettingsSection>

      {createKeyOpen && (
        <CreateApiKeyDialog
          cores={cores.map((c) => ({ id: c.id, label: c.label }))}
          loading={createKey.isPending}
          error={createKey.error ? messageOf(createKey.error) : null}
          onClose={() => {
            createKey.reset();
            setCreateKeyOpen(false);
          }}
          onCreate={(input) => {
            createKey.reset();
            createKey.mutate(input);
          }}
        />
      )}

      {createWebhookOpen && (
        <CreateWebhookDialog
          cores={cores.map((c) => ({ id: c.id, label: c.label }))}
          loading={createHook.isPending}
          error={createHook.error ? messageOf(createHook.error) : null}
          onClose={() => {
            createHook.reset();
            setCreateWebhookOpen(false);
          }}
          onCreate={(input) => {
            createHook.reset();
            createHook.mutate(input);
          }}
        />
      )}

      <ShownOnceDialog shown={shownOnce} onClose={closeShownOnce} copy={copy} copied={copied} />

      <ConfirmDialog
        open={!!revokeKey}
        onClose={() => {
          revoke.reset();
          setRevokeKey(null);
        }}
        onConfirm={() => {
          if (revokeKey) revoke.mutate(revokeKey.id);
        }}
        title="Revoke API key?"
        confirmLabel="Revoke"
        variant="danger"
        loading={revoke.isPending}
      >
        {revokeKey && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-dim)", lineHeight: 1.5 }}>
              Revoke <strong style={{ color: "var(--text)" }}>{revokeKey.name}</strong> (
              {revokeKey.prefix}…). Revocation is final; callers get 401 at once.
            </p>
            <FormErrorBox error={revoke.error ? messageOf(revoke.error) : null} />
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!deleteHook}
        onClose={() => {
          removeHook.reset();
          setDeleteHook(null);
        }}
        onConfirm={() => {
          if (deleteHook) removeHook.mutate(deleteHook.id);
        }}
        title="Delete webhook?"
        confirmLabel="Delete"
        variant="danger"
        loading={removeHook.isPending}
      >
        {deleteHook && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-dim)", lineHeight: 1.5 }}>
              Delete <strong style={{ color: "var(--text)" }}>{deleteHook.url}</strong>? Deliveries
              already queued keep their schedule; no new events are sent.
            </p>
            <FormErrorBox error={removeHook.error ? messageOf(removeHook.error) : null} />
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}

function ApiKeyRow({
  apiKey,
  coreLabels,
  expanded,
  onToggle,
  onRevoke,
}: {
  apiKey: ApiKeyView;
  coreLabels: Map<string, string>;
  expanded: boolean;
  onToggle: () => void;
  onRevoke: () => void;
}) {
  const revoked = apiKey.revokedAt !== null;
  const expiry = expiryLabel(apiKey.expiresAt);
  const expired = !revoked && expiry.expired;
  const scope = coreScopeLabel(apiKey.allCores, apiKey.coreIds, coreLabels);
  const permissions = permissionsLabel(apiKey.permissions);
  const status = revoked
    ? `${scope} · revoked ${isoDay(apiKey.revokedAt!)}`
    : `${scope} · created ${formatRelativeTime(apiKey.createdAt)} · ${expiry.text}`;

  return (
    <div
      data-api-key-id={apiKey.id}
      data-revoked={revoked ? "true" : "false"}
      data-expired={expired ? "true" : "false"}
      style={{
        background: "var(--surface-0)",
        border: "1px solid var(--border)",
        borderRadius: 7,
        opacity: revoked || expired ? 0.55 : 1,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          color: "var(--text)",
        }}
      >
        <Icon name="folder" size={13} style={{ color: "var(--text-dim)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              textDecoration: revoked ? "line-through" : undefined,
            }}
          >
            {apiKey.name}
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
            {apiKey.prefix}…
          </div>
        </div>
        {expired && (
          <span
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              color: "var(--danger)",
              border: "1px solid var(--danger)",
              borderRadius: 4,
              padding: "1px 6px",
            }}
          >
            Expired
          </span>
        )}
        <div style={{ fontSize: 11, color: "var(--text-dim)", textAlign: "right" }}>
          <div data-api-key-permissions style={{ fontFamily: "var(--mono)" }}>{permissions}</div>
          <div data-api-key-scope>{status}</div>
        </div>
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
      </button>
      {expanded && !revoked && (
        <div style={{ padding: "0 12px 12px", display: "flex", justifyContent: "flex-end" }}>
          <Btn variant="danger" size="sm" onClick={onRevoke}>
            Revoke
          </Btn>
        </div>
      )}
    </div>
  );
}

function WebhookRow({
  webhook,
  coreLabels,
  expanded,
  onToggle,
  onPing,
  onDelete,
  pinging,
}: {
  webhook: WebhookView;
  coreLabels: Map<string, string>;
  expanded: boolean;
  onToggle: () => void;
  onPing: () => void;
  onDelete: () => void;
  pinging: boolean;
}) {
  const scope = coreScopeLabel(webhook.allCores, webhook.coreIds, coreLabels);
  const events = webhook.events.join(", ");
  const delivery = lastDeliveryLabel(webhook.lastDelivery);

  return (
    <div
      data-webhook-id={webhook.id}
      style={{
        background: "var(--surface-0)",
        border: "1px solid var(--border)",
        borderRadius: 7,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          color: "var(--text)",
        }}
      >
        <Icon name="folder" size={13} style={{ color: "var(--text-dim)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 12,
              fontWeight: 600,
              wordBreak: "break-all",
            }}
          >
            {webhook.url}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
            {events} · {scope} · {delivery}
          </div>
        </div>
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
      </button>
      {expanded && (
        <div
          style={{
            padding: "0 12px 12px",
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
          <Btn variant="gray-frame" size="sm" onClick={onPing} disabled={pinging}>
            {pinging ? "Sending…" : "Send test"}
          </Btn>
          <Btn variant="danger" size="sm" onClick={onDelete}>
            Delete
          </Btn>
        </div>
      )}
    </div>
  );
}

function ShownOnceDialog({
  shown,
  onClose,
  copy,
  copied,
}: {
  shown: ShownOnce | null;
  onClose: () => void;
  copy: (text: string, label: string) => void;
  copied: string | null;
}) {
  // Hold the secret only while the dialog is open. Closing clears parent state;
  // this effect also zeros any residual so tests can assert nothing remains.
  const [local, setLocal] = useState<ShownOnce | null>(shown);
  useEffect(() => {
    setLocal(shown);
  }, [shown]);

  const close = () => {
    setLocal(null);
    onClose();
  };

  const value = local?.value ?? "";
  const title =
    local?.kind === "api-key"
      ? "Copy your API key"
      : local?.kind === "webhook-secret"
        ? "Copy your webhook secret"
        : "";

  return (
    <Modal
      open={!!local}
      onClose={close}
      title={title}
      width={520}
      footer={
        <Btn variant="accent" onClick={close}>
          Done
        </Btn>
      }
    >
      {local && (
        <div data-shown-once={local.kind} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-dim)", lineHeight: 1.5 }}>
            {local.kind === "api-key" ? (
              <>
                This is the only time the key for <strong style={{ color: "var(--text)" }}>{local.name}</strong>{" "}
                is shown. Copy it now; the Panel stores only a hash.
              </>
            ) : (
              <>
                Signing secret for <strong style={{ color: "var(--text)" }}>{local.url}</strong>. Shown
                once; copy it now.
              </>
            )}
          </p>
          <CodeBlock
            value={value}
            onCopy={() => copy(value, "shown-once")}
            copied={copied === "shown-once"}
            monoSize={11}
          />
        </div>
      )}
    </Modal>
  );
}

function CreateApiKeyDialog({
  cores,
  loading,
  error,
  onClose,
  onCreate,
}: {
  cores: { id: string; label: string }[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (input: { name: string; coreIds: string[] | null; permissions: ApiKeyPermission[]; expiresAt: number | null }) => void;
}) {
  const [name, setName] = useState("");
  // No Core scope is chosen until the operator chooses one (#688): All Cores is never the silent default.
  const [allCores, setAllCores] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [permissions, setPermissions] = useState<Set<ApiKeyPermission>>(new Set<ApiKeyPermission>(["read"]));
  const [expiry, setExpiry] = useState<ExpiryChoice>("never");
  const [customDate, setCustomDate] = useState("");

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const togglePermission = (p: ApiKeyPermission) => {
    setPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  const scopeChosen = allCores === true || (allCores === false && selected.size > 0);
  const expiresAt = expiryInstant(expiry, customDate);
  const canSubmit = name.trim().length > 0 && permissions.size > 0 && scopeChosen && expiresAt !== undefined;

  return (
    <Modal
      open
      onClose={onClose}
      title="Create API key"
      width={480}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </Btn>
          <Btn
            variant="accent"
            disabled={!canSubmit || loading}
            onClick={() =>
              onCreate({
                name: name.trim(),
                coreIds: allCores ? null : [...selected],
                permissions: normalizeApiKeyPermissions(permissions),
                expiresAt: expiresAt ?? null,
              })
            }
          >
            {loading ? "Creating…" : "Create"}
          </Btn>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <TextField label="Name" value={name} onChange={setName} placeholder="ci-deploy" autoFocus />
        <PermissionPicker selected={permissions} onToggle={togglePermission} />
        <CoreScopePicker
          cores={cores}
          allCores={allCores}
          selected={selected}
          onAllCores={setAllCores}
          onToggle={toggle}
        />
        <ExpiryPicker
          choice={expiry}
          customDate={customDate}
          onChoice={setExpiry}
          onCustomDate={setCustomDate}
          invalidCustom={expiry === "custom" && expiresAt === undefined && customDate !== ""}
        />
        <FormErrorBox error={error} />
      </div>
    </Modal>
  );
}

function CreateWebhookDialog({
  cores,
  loading,
  error,
  onClose,
  onCreate,
}: {
  cores: { id: string; label: string }[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (input: { url: string; events: string[]; coreIds: string[] | null }) => void;
}) {
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<Set<string>>(new Set(["task.status_changed"]));
  const [allCores, setAllCores] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleEvent = (event: string) => {
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(event)) next.delete(event);
      else next.add(event);
      return next;
    });
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const canSubmit =
    url.trim().length > 0 && events.size > 0 && (allCores || selected.size > 0);

  return (
    <Modal
      open
      onClose={onClose}
      title="Add webhook"
      width={520}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </Btn>
          <Btn
            variant="accent"
            disabled={!canSubmit || loading}
            onClick={() =>
              onCreate({
                url: url.trim(),
                events: [...events],
                coreIds: allCores ? null : [...selected],
              })
            }
          >
            {loading ? "Creating…" : "Create"}
          </Btn>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <TextField
          label="URL"
          value={url}
          onChange={setUrl}
          placeholder="https://hooks.example.com/actana"
          mono
          autoFocus
        />
        <div>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10.5,
              fontWeight: 500,
              color: "var(--text-dim)",
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Events
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {WEBHOOK_CHANGE_EVENT_TYPES.map((event) => (
              <label
                key={event}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  color: "var(--text)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={events.has(event)}
                  onChange={() => toggleEvent(event)}
                />
                {event}
              </label>
            ))}
          </div>
        </div>
        <CoreScopePicker
          cores={cores}
          allCores={allCores}
          selected={selected}
          onAllCores={setAllCores}
          onToggle={toggle}
        />
        <FormErrorBox error={error} />
      </div>
    </Modal>
  );
}

const pickerHeading: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 10.5,
  fontWeight: 500,
  color: "var(--text-dim)",
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  marginBottom: 6,
};

const pickerChoice: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  color: "var(--text)",
  cursor: "pointer",
  marginBottom: 6,
};

/** The permissions a new key gets (#688): one checkbox each, with what it allows. */
function PermissionPicker({
  selected,
  onToggle,
}: {
  selected: Set<ApiKeyPermission>;
  onToggle: (p: ApiKeyPermission) => void;
}) {
  return (
    <div data-permissions>
      <div style={pickerHeading}>Permissions</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {API_KEY_PERMISSIONS.map((p) => (
          <label key={p} style={{ ...pickerChoice, alignItems: "flex-start", marginBottom: 0 }}>
            <input
              type="checkbox"
              checked={selected.has(p)}
              onChange={() => onToggle(p)}
              aria-label={p}
              style={{ marginTop: 3 }}
            />
            <span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{p}</span>
              <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                {" "}
                · {API_KEY_PERMISSION_LABELS[p].detail}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

const pickerControl: CSSProperties = {
  padding: "7px 10px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "var(--surface-0)",
  color: "var(--text)",
  fontFamily: "var(--mono)",
  fontSize: 12,
};

/** Expiry (#689): never, a preset in days, or a date; an expired key answers 401 like a revoked one. */
function ExpiryPicker({
  choice,
  customDate,
  onChoice,
  onCustomDate,
  invalidCustom,
}: {
  choice: ExpiryChoice;
  customDate: string;
  onChoice: (choice: ExpiryChoice) => void;
  onCustomDate: (date: string) => void;
  invalidCustom: boolean;
}) {
  return (
    <div data-expiry>
      <div style={pickerHeading}>Expiry</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select
          aria-label="Expiry"
          value={choice}
          onChange={(e) => onChoice(e.target.value as ExpiryChoice)}
          style={pickerControl}
        >
          <option value="never">Never</option>
          {API_KEY_EXPIRY_PRESET_DAYS.map((days) => (
            <option key={days} value={`${days}d`}>
              {days} days
            </option>
          ))}
          <option value="custom">Custom date</option>
        </select>
        {choice === "custom" && (
          <input
            type="date"
            aria-label="Expiry date"
            aria-invalid={invalidCustom || undefined}
            value={customDate}
            min={tomorrowDay()}
            onChange={(e) => onCustomDate(e.target.value)}
            style={{ ...pickerControl, borderColor: invalidCustom ? "var(--danger)" : undefined }}
          />
        )}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>
        {choice === "never"
          ? "The key works until you revoke it."
          : invalidCustom
            ? "Pick a date after today."
            : "After this the key gets 401, like a revoked one. Expiry cannot be changed later."}
      </div>
    </div>
  );
}

/**
 * Which Cores a key or a webhook reaches. `allCores` null is "not chosen yet":
 * the key dialog starts there (#688), so the operator picks All Cores on
 * purpose or names the Cores; nothing is chosen for them.
 */
function CoreScopePicker({
  cores,
  allCores,
  selected,
  onAllCores,
  onToggle,
}: {
  cores: { id: string; label: string }[];
  allCores: boolean | null;
  selected: Set<string>;
  onAllCores: (all: boolean) => void;
  onToggle: (id: string) => void;
}) {
  return (
    <div data-core-scope>
      <div style={pickerHeading}>Core scope</div>
      <label style={pickerChoice}>
        <input
          type="radio"
          name="core-scope"
          checked={allCores === true}
          onChange={() => onAllCores(true)}
        />
        All Cores
      </label>
      <label style={pickerChoice}>
        <input
          type="radio"
          name="core-scope"
          checked={allCores === false}
          onChange={() => onAllCores(false)}
        />
        Only these Cores
      </label>
      {allCores === false && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 4 }}>
          {cores.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>No Cores paired yet.</div>
          )}
          {cores.map((core) => (
            <label
              key={core.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={selected.has(core.id)}
                onChange={() => onToggle(core.id)}
              />
              {core.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
