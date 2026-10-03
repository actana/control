import { useEffect, useState } from "react";
import { Btn } from "~/components/ui/Btn";
import { TextField } from "~/components/ui/TextField";
import { api, ApiError } from "~/lib/api";
import {
  connectionPassed,
  derivedFolder,
  type SharedConnectionResult,
  type StorageBackendKind,
  type StorageConfigInput,
  type StorageConfigView,
} from "~/shared/storage-wire";
import type { CoreWithDial } from "~/shared/cores";

/**
 * Step 4 of pairing from the Panel: the Shared folder (#564, screen 05 of the 0.5.0 design). It is mandatory: the Core
 * is paired when this step has attached its folder, and not before, so there is no skip and no way past a failed test.
 *
 * **When storage is already configured** (Settings › Storage, any backend), this step shows that config read-only
 * (backend, endpoint, bucket, prefix — never the key), runs only the connection test, and finishes. It must not write
 * storage: a typed key here would overwrite a stored R2 / STS / Supabase config with seaweedfs (D39).
 *
 * **When storage is not configured**, this is first-time setup: SeaweedFS fields plus a write-only master key, saved on
 * Test connection, then the same probe and finish.
 *
 * **A failed GET of the storage config is not "not configured".** Until the read succeeds, Test connection stays
 * disabled and there is no Master key box, so a transient failure cannot lead to putStorage overwriting a stored
 * backend. Retry reloads the config.
 *
 * **The master key is write-only.** On first-time setup the box is a password field that is empty on every render: the
 * Panel's answer says only whether a key is set, so there is nothing to fill it with. What is typed goes out in the one
 * request that saves the config and is dropped from this component's state as soon as that request returns. The Core is
 * never handed it, and this page says so. When storage is already configured the key field is not shown at all.
 *
 * Finish stays disabled until a test with the current fields (or the stored config) passed.
 */

const DEFAULTS = { endpoint: "", bucket: "", prefix: "cores", oidcIssuer: "", oidcAudience: "actana-shared", keyId: "" };

const BACKEND_LABELS: Record<StorageBackendKind, string> = {
  seaweedfs: "SeaweedFS (S3 STS)",
  sts: "S3 STS",
  supabase: "Supabase",
  r2: "Cloudflare R2",
};

type Fields = typeof DEFAULTS;
/** Outcome of GET /api/storage: unknown until it succeeds (ok) or fails (failed). */
type StorageLoad = "loading" | "ok" | "failed";

export function SharedFolderStep({
  core,
  onFinished,
}: {
  core: CoreWithDial;
  onFinished: (core: CoreWithDial) => Promise<void>;
}) {
  const [fields, setFields] = useState<Fields>(DEFAULTS);
  const [masterKey, setMasterKey] = useState("");
  const [masterKeySet, setMasterKeySet] = useState(false);
  /** Set only after a successful getStorage when storage.configured is true. */
  const [stored, setStored] = useState<StorageConfigView | null>(null);
  const [storageLoad, setStorageLoad] = useState<StorageLoad>("loading");
  const [testing, setTesting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [result, setResult] = useState<SharedConnectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Edits after a passed test invalidate it: Finish belongs to the fields that were tested.
  const [tested, setTested] = useState(false);

  const applyStorage = (storage: StorageConfigView) => {
    setMasterKeySet(storage.masterKeySet);
    if (storage.configured) {
      setStored(storage);
      setFields({
        endpoint: storage.endpoint ?? "",
        bucket: storage.bucket ?? "",
        prefix: storage.prefix ?? "cores",
        oidcIssuer: storage.oidcIssuer ?? "",
        oidcAudience: storage.oidcAudience ?? DEFAULTS.oidcAudience,
        keyId: storage.keyId ?? "",
      });
    } else {
      setStored(null);
      setFields(DEFAULTS);
    }
    setStorageLoad("ok");
  };

  const loadStorage = async () => {
    setStorageLoad("loading");
    setError(null);
    setStored(null);
    setMasterKeySet(false);
    setFields(DEFAULTS);
    setTested(false);
    setResult(null);
    try {
      const { storage } = await api.getStorage();
      applyStorage(storage);
    } catch (err) {
      setStorageLoad("failed");
      setError(messageOf(err));
    }
  };

  useEffect(() => {
    let alive = true;
    setStorageLoad("loading");
    api
      .getStorage()
      .then(({ storage }) => {
        if (!alive) return;
        applyStorage(storage);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setStorageLoad("failed");
        setError(messageOf(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  const edit = (key: keyof Fields) => (value: string) => {
    setFields((f) => ({ ...f, [key]: value }));
    setTested(false);
    setResult(null);
  };

  const configured = storageLoad === "ok" && stored !== null;
  const firstTime = storageLoad === "ok" && stored === null;
  const ready =
    storageLoad === "ok" &&
    (configured
      ? true
      : fields.endpoint.trim() !== "" &&
        fields.bucket.trim() !== "" &&
        fields.prefix.trim() !== "" &&
        fields.oidcIssuer.trim() !== "" &&
        fields.keyId.trim() !== "" &&
        (masterKeySet || masterKey.trim() !== ""));

  const handleTest = async () => {
    if (storageLoad !== "ok") return;
    setTesting(true);
    setError(null);
    setResult(null);
    setTested(false);
    try {
      if (!configured) {
        const input: StorageConfigInput = {
          backend: "seaweedfs",
          endpoint: fields.endpoint,
          bucket: fields.bucket,
          prefix: fields.prefix,
          oidcIssuer: fields.oidcIssuer,
          oidcAudience: fields.oidcAudience,
          keyId: fields.keyId,
          ...(masterKey.trim() !== "" ? { masterKey } : {}),
        };
        await api.putStorage(input);
        // Sent once and dropped: from here on the Panel holds it and this page does not.
        setMasterKey("");
        setMasterKeySet(true);
      }
      const { result: next } = await api.testSharedFolder(core.id);
      setResult(next);
      setTested(connectionPassed(next));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setTesting(false);
    }
  };

  const handleFinish = async () => {
    setFinishing(true);
    setError(null);
    try {
      const { core: finished } = await api.finishCorePairing(core.id);
      await onFinished(finished);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setFinishing(false);
    }
  };

  const busy = storageLoad === "loading" || testing || finishing;
  const passed = result !== null && tested;
  const backendLabel =
    configured && stored.backend ? BACKEND_LABELS[stored.backend] : BACKEND_LABELS.seaweedfs;
  const folderPrefix = configured ? (stored.prefix ?? fields.prefix) : fields.prefix;
  const storageAttr =
    storageLoad === "failed" ? "unread" : configured ? "configured" : storageLoad === "ok" ? "first-time" : "loading";

  return (
    <div
      data-step="shared-folder"
      data-storage={storageAttr}
      style={{
        padding: "14px 16px",
        background: "var(--surface-0)",
        border: "1px solid var(--border)",
        borderRadius: 7,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
        4 · Connect the Shared folder
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.5 }}>
        <strong>{core.label}</strong> is paired but not finished. Every Core gets ~/shared; paired with a Panel it is stored in
        S3, so reports and uploads stay readable while the Core sleeps. The Panel keeps the master key; the Core only ever
        holds a 1-hour key for its own folder. The Core opens once its Shared folder is connected.
        {configured ? (
          <>
            {" "}
            Storage is already set; change it in Settings › Storage. This step only proves this Core's folder and attaches it.
          </>
        ) : null}
      </div>

      {storageLoad !== "failed" && (
        <>
          <TextField label="Backend" value={backendLabel} onChange={() => {}} disabled mono />
          <TextField
            label="S3 endpoint"
            value={configured ? (stored.endpoint ?? "") : fields.endpoint}
            onChange={configured || !firstTime ? () => {} : edit("endpoint")}
            placeholder="https://s3.panel.internal:8333"
            mono
            disabled={busy || configured || !firstTime}
            spellCheck={false}
            autoComplete="off"
          />
          <TextField
            label="Bucket"
            value={configured ? (stored.bucket ?? "") : fields.bucket}
            onChange={configured || !firstTime ? () => {} : edit("bucket")}
            placeholder="actana-shared"
            mono
            disabled={busy || configured || !firstTime}
            spellCheck={false}
            autoComplete="off"
          />
          <TextField
            label="Prefix"
            value={configured ? (stored.prefix ?? "") : fields.prefix}
            onChange={configured || !firstTime ? () => {} : edit("prefix")}
            placeholder="cores/"
            mono
            disabled={busy || configured || !firstTime}
            spellCheck={false}
            autoComplete="off"
          />
          <TextField label="This Core's folder" value={derivedFolder(folderPrefix, core.id)} onChange={() => {}} disabled mono />
        </>
      )}

      {firstTime && (
        <>
          <TextField
            label="OIDC issuer"
            value={fields.oidcIssuer}
            onChange={edit("oidcIssuer")}
            placeholder="the issuer SeaweedFS trusts"
            mono
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
          />
          <TextField
            label="OIDC audience"
            value={fields.oidcAudience}
            onChange={edit("oidcAudience")}
            mono
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
          />
          <TextField
            label="Key id"
            value={fields.keyId}
            onChange={edit("keyId")}
            placeholder="the kid in the Panel's JWKS"
            mono
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
          />
          <TextField
            label="Master key"
            type="password"
            value={masterKey}
            onChange={(v) => {
              setMasterKey(v);
              setTested(false);
              setResult(null);
            }}
            placeholder={masterKeySet ? "stored in the Panel only; type a new one to rotate it" : "RSA private key (PEM)"}
            hint="Write-only: the Panel stores it encrypted, never shows it again and never sends it to a Core."
            mono
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
        </>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        {storageLoad === "failed" && (
          <Btn variant="frame" size="md" onClick={() => void loadStorage()} disabled={busy}>
            Retry
          </Btn>
        )}
        <Btn variant="frame" size="md" onClick={() => void handleTest()} disabled={busy || !ready}>
          {testing ? "Testing…" : "Test connection"}
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
          <div>
            read {mark(result.read)} · write {mark(result.write)} · list own {mark(result.listOwn)} · reach other Core{" "}
            {result.reachOther ? "✓ (it must not)" : "✗ (expected)"}
          </div>
          <div>key expires {new Date(result.expiresAt).toLocaleTimeString()} · refreshed 15 min early</div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          style={{
            fontFamily: "var(--mono)",
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--danger, #e5484d)",
            padding: "8px 12px",
            background: "var(--surface-0)",
            border: "1px solid var(--border)",
            borderRadius: 7,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Btn variant="primary" size="sm" icon="plus" onClick={() => void handleFinish()} disabled={busy || !passed}>
          {finishing ? "Connecting…" : "Connect and finish pairing"}
        </Btn>
      </div>

      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
        Required when pairing with a Panel. Unpair later and the S3 link is removed while ~/shared stays. Deleting the Core removes it
        from the Panel, empties its S3 folder and empties ~/shared on the machine; if the Core is not connected, the delete waits until its key ends and then leaves ~/shared on the machine.
      </div>
    </div>
  );
}

function mark(ok: boolean): string {
  return ok ? "✓" : "✗";
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError && err.message.trim() !== "") return err.message;
  return err instanceof Error && err.message.trim() !== "" ? err.message : "The Panel could not be reached.";
}
