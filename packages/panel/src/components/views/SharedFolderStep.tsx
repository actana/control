import { useEffect, useState } from "react";
import { Btn } from "~/components/ui/Btn";
import { TextField } from "~/components/ui/TextField";
import { api, ApiError } from "~/lib/api";
import {
  connectionPassed,
  derivedFolder,
  type SharedConnectionResult,
  type StorageConfigInput,
} from "~/shared/storage-wire";
import type { CoreWithDial } from "~/shared/cores";

/**
 * Step 4 of pairing from the Panel: the Shared folder (#564, screen 05 of the 0.5.0 design). It is mandatory: the Core
 * is paired when this step has attached its folder, and not before, so there is no skip and no way past a failed test.
 *
 * **The master key is write-only here.** The box is a password field that is empty on every render: the Panel's answer
 * says only whether a key is set, so there is nothing to fill it with. What is typed goes out in the one request that
 * saves the config and is dropped from this component's state as soon as that request returns. The Core is never
 * handed it, and this page says so.
 *
 * The test writes the config first (when it was edited) and then asks the Panel to issue a 1-hour key for this Core
 * and check it reaches its own folder and no other. Finish stays disabled until a test with the current fields passed.
 */

const DEFAULTS = { endpoint: "", bucket: "", prefix: "cores", oidcIssuer: "", oidcAudience: "actana-shared", keyId: "" };

type Fields = typeof DEFAULTS;

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
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [result, setResult] = useState<SharedConnectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Edits after a passed test invalidate it: Finish belongs to the fields that were tested.
  const [tested, setTested] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getStorage()
      .then(({ storage }) => {
        if (!alive) return;
        setMasterKeySet(storage.masterKeySet);
        if (storage.endpoint) {
          setFields({
            endpoint: storage.endpoint ?? "",
            bucket: storage.bucket ?? "",
            prefix: storage.prefix ?? "cores",
            oidcIssuer: storage.oidcIssuer ?? "",
            oidcAudience: storage.oidcAudience ?? DEFAULTS.oidcAudience,
            keyId: storage.keyId ?? "",
          });
        }
      })
      .catch((err: unknown) => alive && setError(messageOf(err)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const edit = (key: keyof Fields) => (value: string) => {
    setFields((f) => ({ ...f, [key]: value }));
    setTested(false);
    setResult(null);
  };

  const ready =
    fields.endpoint.trim() !== "" &&
    fields.bucket.trim() !== "" &&
    fields.prefix.trim() !== "" &&
    fields.oidcIssuer.trim() !== "" &&
    fields.keyId.trim() !== "" &&
    (masterKeySet || masterKey.trim() !== "");

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    setResult(null);
    setTested(false);
    try {
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

  const busy = loading || testing || finishing;
  const passed = result !== null && tested;

  return (
    <div
      data-step="shared-folder"
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
      </div>

      <TextField label="Backend" value="SeaweedFS (S3 STS)" onChange={() => {}} disabled mono />
      <TextField label="S3 endpoint" value={fields.endpoint} onChange={edit("endpoint")} placeholder="https://s3.panel.internal:8333" mono disabled={busy} spellCheck={false} autoComplete="off" />
      <TextField label="Bucket" value={fields.bucket} onChange={edit("bucket")} placeholder="actana-shared" mono disabled={busy} spellCheck={false} autoComplete="off" />
      <TextField label="Prefix" value={fields.prefix} onChange={edit("prefix")} placeholder="cores/" mono disabled={busy} spellCheck={false} autoComplete="off" />
      <TextField label="This Core's folder" value={derivedFolder(fields.prefix, core.id)} onChange={() => {}} disabled mono />
      <TextField label="OIDC issuer" value={fields.oidcIssuer} onChange={edit("oidcIssuer")} placeholder="the issuer SeaweedFS trusts" mono disabled={busy} spellCheck={false} autoComplete="off" />
      <TextField label="OIDC audience" value={fields.oidcAudience} onChange={edit("oidcAudience")} mono disabled={busy} spellCheck={false} autoComplete="off" />
      <TextField label="Key id" value={fields.keyId} onChange={edit("keyId")} placeholder="the kid in the Panel's JWKS" mono disabled={busy} spellCheck={false} autoComplete="off" />
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

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
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
        Required when pairing with a Panel. Unpair later and the S3 link is removed while ~/shared stays. Delete the Core and the
        Core, its Shared folder and its S3 folder are removed.
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
