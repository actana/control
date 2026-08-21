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

/**
 * What the panel says when *this* comparison failed.
 *
 * Its own string rather than `pairingFailureMessage("fingerprint-mismatch")`,
 * because this is the one place that can promise the code has not moved: no
 * request has been made with it, and the button that would make one is not
 * rendered. The shared sentence has to cover a mismatch the server returned,
 * where the code may already have been spent, so it cannot promise that.
 */
const LOCAL_MISMATCH_MESSAGE =
  "That machine is not the Core you were read a fingerprint for. The pairing code has not been sent and will not be — find out why the two differ before going any further.";

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
   * Retyping the address drops everything that was true of the old one — the
   * fingerprint read off it, the fingerprint typed against it, **and the code**.
   *
   * The badge is the obvious half: an operator who checked one machine and then
   * pointed the box at another would otherwise be looking at a "verified" badge
   * earned by a Core they are no longer talking to. The code is the half that
   * matters. It lives on this component rather than on the `{verified && …}`
   * subtree, so unmounting step 3 does not clear it, and without this an
   * operator could check machine A, type A's code, point the box at machine B,
   * verify B's fingerprint, and find A's still-redeemable code waiting in a
   * re-enabled form — one click from posting A's pairing secret to B, which
   * could then spend it against A.
   *
   * A code is minted for one machine and is a secret to every other. Nothing
   * about it survives a change of address.
   */
  const changeAddress = (next: string) => {
    setAddress(next);
    setIdentity(null);
    setExpected("");
    setSessionId("");
    setCode("");
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
        // Editing what was typed does not clear a refusal. A server-returned
        // mismatch is a statement about the certificate that machine presented,
        // and retyping the expected fingerprint does not change it — the
        // warning stands until the next attempt or the next address.
        onExpectedChange={setExpected}
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

      {/* The refusal box is suppressed for exactly one reason: `FingerprintPanel`
          is already showing this refusal, in more detail, with both
          fingerprints side by side. That is true when the *local* comparison
          failed — and only then. A `fingerprint-mismatch` the server returned
          while the local check says verified is a different animal: the CA on
          the pairing dial was not the CA the inspect dial presented, or the CA
          in the response was not the one in the handshake. Neither is visible
          here, and a suppression keyed on the failure code rather than on the
          local state would leave the operator with a green badge and silence —
          on the one refusal in this flow that must never be quiet. */}
      {refusal && check !== "mismatch" && <RefusalBox refusal={refusal} />}

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
            {LOCAL_MISMATCH_MESSAGE}
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
      {/* The server's own sentence first. `~/shared/core-pairing` fills `error`
          in precisely so a caller reading only that field still gets prose, and
          it is the only text that can be right for a refusal the renderer's
          compiled-in union does not know about — where `pairingFailureMessage`,
          an exhaustive switch with no default, would return nothing and paint
          an empty red box. */}
      {refusal.error || pairingFailureMessage(refusal.failure, refusal)}
    </div>
  );
}

/**
 * Read a refusal out of whatever the call threw.
 *
 * Three cases, in order of how much the server managed to tell us:
 *
 *   1. A `CorePairingRefusal` body — the pairing endpoint's own answer, with a
 *      failure code to switch on and fingerprints where there are any.
 *   2. Any other `ApiError`. Most often the registry refusing an endpoint it
 *      already holds, which `pairCore` deliberately lets past its own catch so
 *      that the registry gets to explain itself. `ApiError.message` is carrying
 *      that explanation, and it is used verbatim: writing a pairing sentence
 *      over it would tell an operator whose code was redeemed perfectly well
 *      that the Core failed and to mint a fresh one — four false claims in one
 *      sentence, and the exact outcome the server went out of its way to avoid.
 *   3. Anything else — a proxy in the way, a socket that hung up, a Panel that
 *      fell over. `core-error` is the arm whose advice is true of every failure
 *      that never got an answer out of the Panel.
 *
 * `core-error` is the failure code in case 2 as well, because there is no
 * pairing failure to name; only the sentence comes from the server.
 */
function refusalOf(err: unknown): CorePairingRefusal {
  if (err instanceof ApiError) {
    if (isRefusal(err.body)) return err.body;
    if (err.message.trim() !== "") return { failure: "core-error", error: err.message };
  }
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
