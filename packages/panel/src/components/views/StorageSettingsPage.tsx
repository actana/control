import { useCallback, useEffect, useState } from "react";
import { Btn } from "~/components/ui/Btn";
import { TextField } from "~/components/ui/TextField";
import { SettingsSection, ToggleRow } from "~/components/views/SettingsParts";
import { api, ApiError } from "~/lib/api";
import {
  connectionPassed,
  DEFAULT_UPLOAD_SIZE_LIMIT_BYTES,
  STORAGE_BACKEND_KINDS,
  type SharedConnectionResult,
  type StorageBackendKind,
  type StorageConfigInput,
  type StorageConfigView,
  type StorageCoreFolderView,
} from "~/shared/storage-wire";

/**
 * Settings › Storage (screen 08 of the 0.5.0 design; #566 / #565). SeaweedFS is the default backend.
 * The master key is write-only: the page shows only that one is set and when it was rotated; Rotate
 * replaces it via PUT and the Panel re-issues Core keys. Test connection reuses the pairing isolation
 * probe. Per-Core rows show folder size and key expiry from the server.
 */

const BACKENDS: { id: StorageBackendKind; label: string; sub?: string }[] = [
  { id: "seaweedfs", label: "SeaweedFS" },
  { id: "sts", label: "S3 STS", sub: "AWS · Ceph · RustFS" },
  { id: "supabase", label: "Supabase" },
  { id: "r2", label: "Cloudflare R2" },
];

type Fields = {
  endpoint: string;
  bucket: string;
  prefix: string;
  region: string;
  oidcIssuer: string;
  oidcAudience: string;
  keyId: string;
  roleArn: string;
  accountId: string;
  parentAccessKeyId: string;
  anonKey: string;
  uploadSizeLimitLabel: string;
};

const EMPTY_FIELDS: Fields = {
  endpoint: "",
  bucket: "",
  prefix: "cores",
  region: "us-east-1",
  oidcIssuer: "",
  oidcAudience: "actana-shared",
  keyId: "",
  roleArn: "",
  accountId: "",
  parentAccessKeyId: "",
  anonKey: "",
  uploadSizeLimitLabel: "512 MB",
};

function fieldsFrom(storage: StorageConfigView): Fields {
  return {
    endpoint: storage.endpoint ?? "",
    bucket: storage.bucket ?? "",
    prefix: storage.prefix ?? "cores",
    region: storage.region ?? "us-east-1",
    oidcIssuer: storage.oidcIssuer ?? "",
    oidcAudience: storage.oidcAudience ?? "actana-shared",
    keyId: storage.keyId ?? "",
    roleArn: storage.roleArn ?? "",
    accountId: storage.accountId ?? "",
    parentAccessKeyId: storage.parentAccessKeyId ?? "",
    anonKey: storage.anonKey ?? "",
    uploadSizeLimitLabel: formatLimitLabel(storage.uploadSizeLimitBytes ?? DEFAULT_UPLOAD_SIZE_LIMIT_BYTES),
  };
}

export function StorageSettingsPage() {
  const [backend, setBackend] = useState<StorageBackendKind>("seaweedfs");
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS);
  const [masterKey, setMasterKey] = useState("");
  const [masterKeySet, setMasterKeySet] = useState(false);
  const [rotatedAt, setRotatedAt] = useState<number | null>(null);
  const [cores, setCores] = useState<StorageCoreFolderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SharedConnectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stsAccessKeyId, setStsAccessKeyId] = useState("");
  const [stsSecret, setStsSecret] = useState("");
  const [supabaseServiceRole, setSupabaseServiceRole] = useState("");
  const [supabaseJwtSecret, setSupabaseJwtSecret] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { storage, cores: nextCores } = await api.getStorage();
      setMasterKeySet(storage.masterKeySet);
      setRotatedAt(storage.masterKeyRotatedAt);
      setCores(nextCores);
      if (storage.backend && (STORAGE_BACKEND_KINDS as readonly string[]).includes(storage.backend)) {
        setBackend(storage.backend);
      } else {
        setBackend("seaweedfs");
      }
      if (storage.endpoint || storage.masterKeySet) setFields(fieldsFrom(storage));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = (key: keyof Fields) => (value: string) => {
    setFields((f) => ({ ...f, [key]: value }));
    setResult(null);
  };

  const buildMasterKey = (): string | undefined => {
    if (backend === "seaweedfs") return masterKey.trim() || undefined;
    if (backend === "sts") {
      if (!stsAccessKeyId.trim() && !stsSecret.trim()) return undefined;
      return JSON.stringify({ accessKeyId: stsAccessKeyId.trim(), secretAccessKey: stsSecret.trim() });
    }
    if (backend === "r2") return masterKey.trim() || undefined;
    if (backend === "supabase") {
      if (!supabaseServiceRole.trim() && !supabaseJwtSecret.trim()) return undefined;
      return JSON.stringify({ serviceRoleKey: supabaseServiceRole.trim(), jwtSecret: supabaseJwtSecret.trim() });
    }
    return undefined;
  };

  const buildInput = (withKey: boolean): StorageConfigInput => {
    const key = withKey ? buildMasterKey() : undefined;
    return {
      backend,
      endpoint: fields.endpoint,
      bucket: fields.bucket,
      prefix: fields.prefix,
      region: fields.region,
      oidcIssuer: fields.oidcIssuer,
      oidcAudience: fields.oidcAudience,
      keyId: fields.keyId,
      roleArn: fields.roleArn,
      accountId: fields.accountId,
      parentAccessKeyId: fields.parentAccessKeyId,
      anonKey: fields.anonKey,
      uploadSizeLimitBytes: parseLimitLabel(fields.uploadSizeLimitLabel),
      ...(key !== undefined ? { masterKey: key } : {}),
    };
  };

  const clearSecretBoxes = () => {
    setMasterKey("");
    setStsAccessKeyId("");
    setStsSecret("");
    setSupabaseServiceRole("");
    setSupabaseJwtSecret("");
  };

  const handleSave = async (rotate: boolean) => {
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const typedKey = buildMasterKey();
      if (!rotate && masterKeySet && typedKey !== undefined) {
        throw new Error("A typed master key is not saved with Save: use Rotate… to replace the stored key.");
      }
      const input = buildInput(rotate || !masterKeySet);
      if (rotate && input.masterKey === undefined) {
        throw new Error(
          backend === "seaweedfs"
            ? "Paste a new RSA private key to rotate."
            : backend === "sts"
              ? "Enter new access key credentials to rotate."
              : backend === "r2"
                ? "Paste a new Cloudflare API token to rotate."
                : "Enter new Supabase secrets to rotate.",
        );
      }
      const { storage } = await api.putStorage(input);
      clearSecretBoxes();
      setMasterKeySet(storage.masterKeySet);
      setRotatedAt(storage.masterKeyRotatedAt);
      setFields(fieldsFrom(storage));
      const refreshed = await api.getStorage();
      setCores(refreshed.cores);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    setResult(null);
    try {
      // Persist current fields first (and master key if typed), then probe isolation.
      const input = buildInput(true);
      if (!masterKeySet && input.masterKey === undefined) {
        throw new Error("Set the master key before testing the connection.");
      }
      await api.putStorage(input);
      clearSecretBoxes();
      setMasterKeySet(true);
      const { result: next } = await api.testStorage({});
      setResult(next);
      const refreshed = await api.getStorage();
      setCores(refreshed.cores);
      setRotatedAt(refreshed.storage.masterKeyRotatedAt);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setTesting(false);
    }
  };

  const busy = loading || saving || testing;
  const passed = result !== null && connectionPassed(result);

  return (
    <SettingsSection title="Shared folder storage" subtitle="Where each Core's ~/shared is stored." headingLevel="h1">
      <div
        role="tablist"
        aria-label="Storage backend"
        style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border)", marginBottom: 4 }}
      >
        {BACKENDS.map((b) => {
          const active = backend === b.id;
          return (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-backend={b.id}
              disabled={busy}
              onClick={() => {
                setBackend(b.id);
                setResult(null);
              }}
              style={{
                flex: 1,
                padding: "10px 8px 12px",
                background: "transparent",
                border: "none",
                borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                color: active ? "var(--text)" : "var(--text-dim)",
                fontFamily: "var(--mono)",
                fontSize: 12,
                fontWeight: 600,
                cursor: busy ? "default" : "pointer",
                textAlign: "center",
              }}
            >
              <div>{b.label}</div>
              {b.sub && (
                <div style={{ fontSize: 10, fontWeight: 500, color: "var(--text-dim)", marginTop: 2 }}>{b.sub}</div>
              )}
            </button>
          );
        })}
      </div>

      {(backend === "sts" || backend === "supabase") && (
        <div
          role="note"
          data-backend-limitation={backend}
          style={{
            fontFamily: "var(--mono)",
            fontSize: 12,
            lineHeight: 1.5,
            padding: "10px 12px",
            marginBottom: 8,
            background: "var(--surface-1)",
            border: "1px solid var(--border)",
            borderRadius: 7,
            color: "var(--text-dim)",
          }}
        >
          Not usable yet against a real service: one Endpoint field cannot be both the{" "}
          {backend === "sts" ? "STS AssumeRole URL and the S3 API host" : "Supabase project URL and the S3 API host"}.
          SeaweedFS and Cloudflare R2 work with the fields below.
        </div>
      )}

      <TextField
        label="Endpoint"
        value={fields.endpoint}
        onChange={edit("endpoint")}
        placeholder={
          backend === "supabase"
            ? "https://xyz.supabase.co"
            : backend === "r2"
              ? "https://<account>.r2.cloudflarestorage.com"
              : "https://s3.panel.internal:8333"
        }
        mono
        disabled={busy}
        spellCheck={false}
        autoComplete="off"
      />
      <TextField
        label="Bucket"
        value={fields.bucket}
        onChange={edit("bucket")}
        placeholder="actana-shared"
        mono
        disabled={busy}
        spellCheck={false}
        autoComplete="off"
      />
      <TextField
        label="Prefix"
        value={fields.prefix}
        onChange={edit("prefix")}
        placeholder="cores/"
        mono
        disabled={busy}
        spellCheck={false}
        autoComplete="off"
      />

      {backend === "seaweedfs" && (
        <>
          <TextField label="OIDC issuer" value={fields.oidcIssuer} onChange={edit("oidcIssuer")} mono disabled={busy} spellCheck={false} autoComplete="off" />
          <TextField label="OIDC audience" value={fields.oidcAudience} onChange={edit("oidcAudience")} mono disabled={busy} spellCheck={false} autoComplete="off" />
          <TextField label="Key id" value={fields.keyId} onChange={edit("keyId")} mono disabled={busy} spellCheck={false} autoComplete="off" />
          <TextField
            label="Master key"
            type="password"
            value={masterKey}
            onChange={(v) => {
              setMasterKey(v);
              setResult(null);
            }}
            placeholder={masterKeySet ? "stored in the Panel only; type a new one to rotate" : "RSA private key (PEM)"}
            hint="Write-only: the Panel stores it encrypted, never shows it again and never sends it to a Core."
            mono
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
        </>
      )}

      {backend === "sts" && (
        <>
          <TextField label="Region" value={fields.region} onChange={edit("region")} mono disabled={busy} spellCheck={false} autoComplete="off" />
          <TextField label="Role ARN" value={fields.roleArn} onChange={edit("roleArn")} placeholder="arn:aws:iam::…:role/ActanaCoreShared" mono disabled={busy} spellCheck={false} autoComplete="off" />
          <TextField
            label="Access key id"
            type="password"
            value={stsAccessKeyId}
            onChange={(v) => {
              setStsAccessKeyId(v);
              setResult(null);
            }}
            placeholder={masterKeySet ? "leave blank to keep the stored key" : "IAM access key that can AssumeRole"}
            mono
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
          <TextField
            label="Secret access key"
            type="password"
            value={stsSecret}
            onChange={(v) => {
              setStsSecret(v);
              setResult(null);
            }}
            placeholder={masterKeySet ? "leave blank to keep the stored key" : "matching secret"}
            hint="Write-only: sealed together as the master key; never returned."
            mono
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
        </>
      )}

      {backend === "r2" && (
        <>
          <TextField label="Account id" value={fields.accountId} onChange={edit("accountId")} mono disabled={busy} spellCheck={false} autoComplete="off" />
          <TextField label="Parent access key id" value={fields.parentAccessKeyId} onChange={edit("parentAccessKeyId")} mono disabled={busy} spellCheck={false} autoComplete="off" />
          <TextField
            label="API token"
            type="password"
            value={masterKey}
            onChange={(v) => {
              setMasterKey(v);
              setResult(null);
            }}
            placeholder={masterKeySet ? "stored in the Panel only; type a new one to rotate" : "Cloudflare API token"}
            hint="Write-only master material for R2 temporary credentials."
            mono
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
        </>
      )}

      {backend === "supabase" && (
        <>
          <TextField label="Anon key" value={fields.anonKey} onChange={edit("anonKey")} mono disabled={busy} spellCheck={false} autoComplete="off" />
          <TextField
            label="Service role key"
            type="password"
            value={supabaseServiceRole}
            onChange={(v) => {
              setSupabaseServiceRole(v);
              setResult(null);
            }}
            placeholder={masterKeySet ? "leave blank to keep the stored key" : "service-role key"}
            mono
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
          <TextField
            label="JWT secret"
            type="password"
            value={supabaseJwtSecret}
            onChange={(v) => {
              setSupabaseJwtSecret(v);
              setResult(null);
            }}
            placeholder={masterKeySet ? "leave blank to keep the stored key" : "JWT secret"}
            hint="Write-only: sealed together as the master key; never returned. Apply the SDK's RLS SQL on the project."
            mono
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
        </>
      )}

      <ToggleRow
        title="Key lifetime: 1 hour, refreshed 15 minutes early"
        description="If a Core cannot reach the Panel for more than an hour, its ~/shared goes read-only until the Panel reconnects."
        checked
        onChange={() => undefined}
        label="Key lifetime policy"
        disabled
      />

      <div
        data-master-key-status
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 14px",
          background: "var(--surface-0)",
          border: "1px solid var(--border)",
          borderRadius: 7,
          fontFamily: "var(--mono)",
          fontSize: 12,
          color: "var(--text-dim)",
        }}
      >
        <span>
          master key · held by the Panel only
          {masterKeySet && rotatedAt
            ? ` · last rotated ${formatRotatedAgo(rotatedAt)}`
            : masterKeySet
              ? " · set"
              : " · not set"}
        </span>
        <button
          type="button"
          disabled={busy || !masterKeySet}
          onClick={() => void handleSave(true)}
          style={{
            background: "none",
            border: "none",
            color: "var(--accent-ink, var(--accent))",
            fontFamily: "var(--mono)",
            fontSize: 12,
            cursor: busy || !masterKeySet ? "default" : "pointer",
            padding: 0,
          }}
        >
          Rotate…
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn variant="frame" size="md" onClick={() => void handleTest()} disabled={busy}>
          {testing ? "Testing…" : "Test connection"}
        </Btn>
        <Btn variant="primary" size="md" onClick={() => void handleSave(false)} disabled={busy}>
          {saving ? "Saving…" : "Save"}
        </Btn>
      </div>

      {result && (
        <div
          role="status"
          data-connection={passed ? "passed" : "failed"}
          style={{
            fontFamily: "var(--mono)",
            fontSize: 12,
            lineHeight: 1.6,
            padding: "10px 12px",
            background: "var(--surface-1)",
            border: `1px solid ${passed ? "var(--accent)" : "var(--danger, #e5484d)"}`,
            borderRadius: 7,
            color: "var(--text)",
          }}
        >
          <strong style={{ color: passed ? "var(--accent-ink)" : "var(--danger, #e5484d)" }}>{passed ? "PASSED" : "FAILED"}</strong>{" "}
          {passed
            ? `Issued a 1-hour key for ${result.folder} and checked it cannot list, read or write another Core's folder.`
            : `The key issued for ${result.folder} did not behave: it must read, write and list its own folder and reach no other.`}
        </div>
      )}

      {error && (
        <div role="alert" style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--danger, #e5484d)" }}>
          {error}
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-dim)",
            marginBottom: 4,
          }}
        >
          Per Core
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--text-dim)", marginBottom: 10 }}>
          Each Core owns {fields.prefix.replace(/\/+$/, "") || "cores"}/&lt;core&gt;/ and nothing else.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {cores.length === 0 && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)", padding: "8px 0" }}>
              No Cores yet.
            </div>
          )}
          {cores.map((c) => (
            <div
              key={c.coreId}
              data-core-folder={c.coreId}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "10px 12px",
                background: "var(--surface-0)",
                border: "1px solid var(--border)",
                borderRadius: 7,
                fontFamily: "var(--mono)",
                fontSize: 12,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ color: "var(--text)", fontWeight: 600 }}>{c.label}</div>
                <div style={{ color: "var(--text-dim)", marginTop: 2 }}>{c.prefix}</div>
              </div>
              <div style={{ textAlign: "right", color: "var(--text-dim)", flexShrink: 0 }}>
                <div>{c.sizeBytes === null ? "—" : formatBytes(c.sizeBytes)}</div>
                <div style={{ marginTop: 2, color: coreStatusColor(c) }}>{coreStatusLabel(c)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-dim)",
            marginBottom: 10,
          }}
        >
          Limits
        </div>
        <TextField
          label="Upload size limit"
          value={fields.uploadSizeLimitLabel}
          onChange={edit("uploadSizeLimitLabel")}
          placeholder="512 MB per file"
          hint="Applies to uploads from the Panel Files tab and the SDK."
          mono
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </SettingsSection>
  );
}

function coreStatusLabel(c: StorageCoreFolderView): string {
  if (c.offline && (c.keyExpiresAt === null || c.keyExpiresAt <= Date.now())) {
    return "offline · key expired – read-only";
  }
  if (c.state === "error") return c.error ? `error · ${c.error}` : "error";
  if (c.state === "pending") return "pending";
  if (c.keyExpiresAt) return `key expires ${new Date(c.keyExpiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return c.offline ? "offline" : "attached";
}

function coreStatusColor(c: StorageCoreFolderView): string {
  if (c.offline && (c.keyExpiresAt === null || c.keyExpiresAt <= Date.now())) return "var(--danger, #e5484d)";
  if (c.state === "error") return "var(--danger, #e5484d)";
  return "var(--text-dim)";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) {
    const mb = n / (1024 * 1024);
    return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
  }
  const gb = n / (1024 * 1024 * 1024);
  return `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`;
}

function formatRotatedAgo(at: number): string {
  const days = Math.floor((Date.now() - at) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function formatLimitLabel(bytes: number): string {
  if (bytes % (1024 * 1024 * 1024) === 0) return `${bytes / (1024 * 1024 * 1024)} GB`;
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KB`;
  return `${bytes} B`;
}

function parseLimitLabel(raw: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?(?:\s*per\s*file)?\s*$/i.exec(raw.trim());
  if (!m) return DEFAULT_UPLOAD_SIZE_LIMIT_BYTES;
  const n = Number(m[1]);
  const unit = (m[2] ?? "mb").toLowerCase();
  if (unit === "b") return Math.floor(n);
  if (unit === "kb") return Math.floor(n * 1024);
  if (unit === "gb") return Math.floor(n * 1024 * 1024 * 1024);
  return Math.floor(n * 1024 * 1024);
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError && err.message.trim() !== "") return err.message;
  return err instanceof Error && err.message.trim() !== "" ? err.message : "The Panel could not be reached.";
}
