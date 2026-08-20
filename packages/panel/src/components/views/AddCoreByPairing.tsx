import { useState } from "react";
import { Btn } from "~/components/ui/Btn";
import { TextField } from "~/components/ui/TextField";
import { api, ApiError } from "~/lib/api";
import {
  fingerprintCheck,
  normalizePairingCode,
  pairingFailureMessage,
  type CorePairingIdentity,
  type CorePairingRefusal,
  type FingerprintCheck,
} from "~/shared/core-pairing";
import type { CoreWithDial } from "~/shared/cores";

/**
 * Adding a Core by short code (#280, #286) — address, then fingerprint, then
 * code, in that order and never in another.
 *
 * The Panel is the one client that can *show* the operator a fingerprint rather
 * than make them type one into a terminal, so this is a two-step: the first
 * request carries no code and comes back with the certificate authority the
 * machine presents, and the second is only reachable once what the operator was
 * read out and what the machine presented are the same string.
 *
 * **The comparison here is a gate, not the enforcement.** The Panel server runs
 * it again inside `pairWithCore`, against the certificate on the connection it
 * is about to send the code over, and refuses there too. What this component
 * owns is that an operator is never *asked* for a code before they have looked
 * at a fingerprint, and that a mismatch stops rather than warns.
 *
 * **Nothing secret is kept.** The code lives in this component's state for as
 * long as it takes to post it and nowhere else — no preference store, no URL,
 * no toast, no error message. The credential the pairing returns never comes
 * back to the browser at all: the server seals it and answers with a registry
 * row.
 */

/** What each fingerprint state looks like, and what it is called out loud. */
const FINGERPRINT_STATES: Record<
  FingerprintCheck,
  { label: string; color: string; border: string }
> = {
  unchecked: { label: "Not checked", color: "var(--text-dim)", border: "var(--border)" },
  verified: { label: "Verified", color: "var(--accent-ink)", border: "var(--accent)" },
  mismatch: { label: "Mismatch", color: "var(--danger, #e5484d)", border: "var(--danger, #e5484d)" },
};

export function AddCoreByPairing({ onPaired }: { onPaired: (core: CoreWithDial) => Promise<void> }) {
  const [address, setAddress] = useState("");
  const [identity, setIdentity] = useState<CorePairingIdentity | null>(null);
  const [inspecting, setInspecting] = useState(false);

  const [expected, setExpected] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [pairing, setPairing] = useState(false);

  const [refusal, setRefusal] = useState<CorePairingRefusal | null>(null);

  const check = fingerprintCheck(expected, identity?.fingerprint ?? null);
  const verified = check === "verified";
  const codeReady = normalizePairingCode(code) !== null && sessionId.trim() !== "";

  /**
   * Retyping the address drops the fingerprint that was read off the old one.
   *
   * Without this, an operator who checked one machine and then pointed the box
   * at another would be looking at a "verified" badge earned by a Core they are
   * no longer talking to — the exact confusion the fingerprint exists to
   * prevent.
   */
  const changeAddress = (next: string) => {
    setAddress(next);
    setIdentity(null);
    setRefusal(null);
  };

  const handleInspect = async () => {
    if (!address.trim()) return;
    setInspecting(true);
    setRefusal(null);
    setIdentity(null);
    try {
      const { identity: next } = await api.inspectCoreForPairing(address.trim());
      setIdentity(next);
    } catch (err) {
      setRefusal(refusalOf(err));
    } finally {
      setInspecting(false);
    }
  };

  const handlePair = async () => {
    if (!verified || !codeReady) return;
    setPairing(true);
    setRefusal(null);
    try {
      const { core } = await api.pairCore({
        address: address.trim(),
        code,
        sessionId: sessionId.trim(),
        expectedFingerprint: expected,
        label: name.trim(),
      });
      reset();
      await onPaired(core);
    } catch (err) {
      const next = refusalOf(err);
      setRefusal(next);
      // A code the Core has already looked at is spent, dead, or was never
      // right: keeping it in the box invites a second attempt that can only
      // burn another of the session's five, and keeps a secret in memory that
      // has no further use.
      if (next.failure === "refused") setCode("");
    } finally {
      setPairing(false);
    }
  };

  const reset = () => {
    setAddress("");
    setIdentity(null);
    setExpected("");
    setSessionId("");
    setCode("");
    setName("");
    setRefusal(null);
  };

  return (
    <div
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
      <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--text-dim)" }}>
        On the machine, run <code>actana pair new</code>. It prints a one-time pairing code, this
        Core&apos;s CA fingerprint, and a session id. Enter the address first and compare the
        fingerprint — the Panel does not send the code until they match.
      </div>

      {/* Step 1 — reach the machine. Nothing secret is sent by this. */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <TextField
            label="Core address"
            value={address}
            onChange={changeAddress}
            placeholder="prod-vm-1.internal:7777"
            hint="Host and TLS port, as the Core was set up. Pairing needs the TLS port."
            mono
            autoComplete="off"
            spellCheck={false}
            disabled={inspecting || pairing}
          />
        </div>
        <Btn
          variant="frame"
          size="md"
          onClick={() => void handleInspect()}
          disabled={inspecting || pairing || !address.trim()}
        >
          {inspecting ? "Checking…" : "Check fingerprint"}
        </Btn>
      </div>

      {/* Step 2 — the three states, told apart by colour, by wording, and by
          whether step 3 exists at all. */}
      <FingerprintPanel
        check={check}
        identity={identity}
        expected={expected}
        onExpectedChange={(next) => {
          setExpected(next);
          if (refusal?.failure === "fingerprint-mismatch") setRefusal(null);
        }}
        busy={inspecting || pairing}
      />

      {/* Step 3 — the code, reachable only past a verified fingerprint. */}
      {verified && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <TextField
            label="Session"
            value={sessionId}
            onChange={setSessionId}
            placeholder="the Session line from `actana pair new`"
            mono
            autoComplete="off"
            spellCheck={false}
            disabled={pairing}
          />
          <TextField
            label="Pairing code"
            value={code}
            onChange={(next) => {
              setCode(next);
              if (refusal) setRefusal(null);
            }}
            placeholder="XXXX-XXXX"
            hint="Eight characters. Hyphen and case are yours to get wrong."
            mono
            autoComplete="off"
            spellCheck={false}
            disabled={pairing}
          />
          <TextField
            label="Name in this Panel (optional)"
            value={name}
            onChange={setName}
            placeholder="the machine's host, if you leave this empty"
            autoComplete="off"
            disabled={pairing}
          />
        </div>
      )}

      {refusal && refusal.failure !== "fingerprint-mismatch" && (
        <RefusalBox refusal={refusal} />
      )}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Btn
          variant="primary"
          size="sm"
          icon="plus"
          onClick={() => void handlePair()}
          disabled={pairing || !verified || !codeReady}
        >
          {pairing ? "Pairing…" : "Pair Core"}
        </Btn>
      </div>
    </div>
  );
}

/**
 * Where the operator stands against the fingerprint they were read out.
 *
 * All three states render here rather than one of them being an absence: an
 * operator who has not checked yet should see that they have not checked yet,
 * in the same place a verified check would appear, so the badge is read as an
 * answer rather than as chrome that failed to load.
 */
function FingerprintPanel({
  check,
  identity,
  expected,
  onExpectedChange,
  busy,
}: {
  check: FingerprintCheck;
  identity: CorePairingIdentity | null;
  expected: string;
  onExpectedChange: (next: string) => void;
  busy: boolean;
}) {
  const state = FINGERPRINT_STATES[check];
  return (
    <div
      data-fingerprint-state={check}
      role={check === "mismatch" ? "alert" : "status"}
      aria-label={`Fingerprint ${state.label}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "12px 14px",
        background: "var(--surface-1)",
        border: `1px solid ${state.border}`,
        borderRadius: 7,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            color: state.color,
            border: `1px solid ${state.border}`,
            borderRadius: 4,
            padding: "2px 6px",
          }}
        >
          {state.label}
        </span>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          {identity === null
            ? "No machine checked yet — enter an address and check its fingerprint."
            : check === "unchecked"
              ? "Now type the CA fingerprint `actana pair new` printed on that machine."
              : check === "verified"
                ? "This is the machine you were read a fingerprint for."
                : "This is NOT the machine you were read a fingerprint for."}
        </span>
      </div>

      {identity !== null && (
        <>
          <Fingerprint
            caption={`Presented by ${identity.httpsOrigin}`}
            value={identity.fingerprint}
            color={state.color}
          />
          <TextField
            label="CA fingerprint from `actana pair new`"
            value={expected}
            onChange={onExpectedChange}
            placeholder="AA:BB:CC:…"
            mono
            autoComplete="off"
            spellCheck={false}
            ariaInvalid={check === "mismatch"}
            disabled={busy}
          />
        </>
      )}

      {check === "mismatch" && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: "10px 12px",
            background: "var(--surface-0)",
            border: `1px solid ${state.border}`,
            borderRadius: 6,
          }}
        >
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: state.color,
              lineHeight: 1.5,
            }}
          >
            {pairingFailureMessage("fingerprint-mismatch")}
          </div>
          <Fingerprint caption="Expected" value={expected} color={state.color} />
          <Fingerprint
            caption="Presented"
            value={identity?.fingerprint ?? ""}
            color={state.color}
          />
        </div>
      )}
    </div>
  );
}

/** One fingerprint, wrapped rather than truncated — every byte is the point. */
function Fingerprint({
  caption,
  value,
  color,
}: {
  caption: string;
  value: string;
  color: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10.5,
          fontWeight: 500,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          color: "var(--text-dim)",
        }}
      >
        {caption}
      </div>
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11.5,
          color,
          wordBreak: "break-all",
          lineHeight: 1.5,
        }}
      >
        {value}
      </div>
    </div>
  );
}

/** A refusal that is not a mismatch — one sentence, and what to do next. */
function RefusalBox({ refusal }: { refusal: CorePairingRefusal }) {
  return (
    <div
      role="alert"
      data-pairing-failure={refusal.failure}
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
      {pairingFailureMessage(refusal.failure, refusal)}
    </div>
  );
}

/**
 * Read a refusal out of whatever the call threw.
 *
 * A `CorePairingRefusal` body is the expected shape; anything else — a proxy
 * in the way, a Panel that fell over — is reported as `core-error`, which is
 * the arm whose advice ("nothing was paired, try again") is true of every
 * failure that never reached the pairing endpoint.
 */
function refusalOf(err: unknown): CorePairingRefusal {
  if (err instanceof ApiError && isRefusal(err.body)) return err.body;
  return { failure: "core-error", error: pairingFailureMessage("core-error") };
}

function isRefusal(body: unknown): body is CorePairingRefusal {
  return (
    !!body &&
    typeof body === "object" &&
    typeof (body as { failure?: unknown }).failure === "string" &&
    typeof (body as { error?: unknown }).error === "string"
  );
}
