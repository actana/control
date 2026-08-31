import { useState } from "react";
import { Btn } from "~/components/ui/Btn";
import { Icon } from "~/components/ui/Icon";
import { TextField } from "~/components/ui/TextField";
import { AddCoreByPairing } from "~/components/views/AddCoreByPairing";
import {
  CORE_INSTALL_PATHS,
  PAIR_NEW_OUTPUT,
  composePairNewCommand,
  pairNewCommand,
} from "~/shared/core-onboarding";
import type { CoreWithDial } from "~/shared/cores";

/**
 * The first-run pairing wizard (#358) — what a Panel with no Cores shows
 * instead of a dashboard.
 *
 * **This is composition, not a second pairing implementation.** Step 3 mounts
 * the very `AddCoreByPairing` that Settings → Cores → Add Core mounts, with the
 * same props and the same `onPaired` contract, so the fingerprint-before-code
 * ordering, the mismatch refusal, and every failure sentence are that
 * component's, once. Nothing about redeeming a code is decided here. What this
 * file adds is the two things a fresh operator is missing and a settings page
 * cannot give them: the order to do things in, and the commands to run on the
 * *other* machine.
 *
 * **There is no way out of it that is not a paired Core.** No skip, no "later",
 * no dismiss, and no route past it — see `FirstRunGate`, which renders this
 * instead of the app shell rather than over it. That is not a stance about
 * onboarding; it is what the product is. A Panel is a window onto machines it
 * is paired with, and paired with none it has nothing to draw. An empty
 * dashboard would be a screen whose every affordance is dead.
 *
 * Moving between steps 1, 2 and 3 is free, in both directions. Steps 1 and 2
 * are reference — an operator who already installed the Core last week should
 * not have to scroll past its install command — and moving between them
 * reaches the Panel's dashboard exactly as often as standing still does: never.
 */

/** The three steps, in the order the machine has to do them. */
const STEPS = [
  { id: "install", title: "Install the Core", blurb: "on the machine you want to drive" },
  { id: "mint", title: "Mint a pairing code", blurb: "on that machine, in its terminal" },
  { id: "redeem", title: "Redeem it here", blurb: "in this Panel, with what it printed" },
] as const;

type StepIndex = 0 | 1 | 2;

export function FirstRunWizard({
  onPaired,
  registryError = null,
}: {
  /**
   * The same contract `CoresSettingsPage` fulfils: the Core the redemption
   * produced, and a promise the pairing form waits on before it lets go of its
   * busy state. The gate resolves it once it has re-read the registry, so the
   * form stays visibly mid-pairing until the dashboard is genuinely unlocked
   * rather than blinking through an empty wizard on the way.
   */
  onPaired: (core: CoreWithDial) => Promise<void>;
  /**
   * Why the Core registry could not be read, if it could not be. Shown rather
   * than swallowed: "no Cores" and "could not ask" look identical from here,
   * and an operator who is about to be told to install a Core deserves to know
   * which of the two they are looking at.
   */
  registryError?: string | null;
}) {
  const [step, setStep] = useState<StepIndex>(0);
  // The name this Panel will be called on the Core, folded live into the mint
  // command. Kept here rather than inside step 2 so stepping away and back
  // does not silently drop what was typed.
  const [label, setLabel] = useState("");

  return (
    <div
      data-first-run-wizard
      style={{
        position: "fixed",
        inset: 0,
        overflowY: "auto",
        background: "var(--surface-1)",
        color: "var(--text)",
      }}
    >
      <div
        style={{
          maxWidth: 780,
          margin: "0 auto",
          padding: "48px 24px 64px",
          display: "flex",
          flexDirection: "column",
          gap: 22,
        }}
      >
        <Header />
        {registryError && <RegistryErrorBox message={registryError} />}
        <StepRail step={step} onStep={setStep} />

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {step === 0 && <InstallStep />}
          {step === 1 && <MintStep label={label} onLabel={setLabel} />}
          {step === 2 && <RedeemStep onPaired={onPaired} />}
        </div>

        <Footer step={step} onStep={setStep} />
      </div>
    </div>
  );
}

/**
 * What this screen is and why it is the whole screen.
 *
 * The second sentence is the one that matters: an operator who thinks the Panel
 * is broken will go looking for the way past it, and there isn't one. Saying so
 * plainly is cheaper than letting them find out.
 */
function Header() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-dim)",
        }}
      >
        Actana Control
      </div>
      <h1 style={{ fontSize: 24, fontWeight: 650, margin: 0, letterSpacing: "-0.01em" }}>
        Pair your first Core
      </h1>
      <p
        style={{
          margin: 0,
          fontSize: 13.5,
          lineHeight: 1.55,
          color: "var(--text-dim)",
          maxWidth: 620,
        }}
      >
        A Panel drives machines called Cores — this one is paired with none, so there is nothing
        for it to show yet. Three steps, run on the machine you want to drive and finished here.
        The Panel opens on the first Core that pairs.
      </p>
    </div>
  );
}

/** The registry read that failed, said out loud rather than read as emptiness. */
function RegistryErrorBox({ message }: { message: string }) {
  return (
    <div
      role="alert"
      data-first-run-registry-error
      style={{
        fontFamily: "var(--mono)",
        fontSize: 12,
        lineHeight: 1.5,
        color: "var(--danger, #e5484d)",
        padding: "10px 12px",
        background: "var(--surface-0)",
        border: "1px solid var(--danger, #e5484d)",
        borderRadius: 7,
      }}
    >
      This Panel could not read its own list of Cores, so it cannot tell an empty fleet from an
      unanswered question: {message}
    </div>
  );
}

/** The three steps as a rail — where you are, and what is still ahead. */
function StepRail({ step, onStep }: { step: StepIndex; onStep: (next: StepIndex) => void }) {
  return (
    <ol
      style={{
        listStyle: "none",
        display: "flex",
        gap: 8,
        margin: 0,
        padding: 0,
      }}
    >
      {STEPS.map((entry, index) => {
        const active = index === step;
        return (
          <li key={entry.id} style={{ flex: 1, minWidth: 0 }}>
            <button
              type="button"
              onClick={() => onStep(index as StepIndex)}
              aria-current={active ? "step" : undefined}
              style={{
                width: "100%",
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                gap: 3,
                padding: "10px 12px",
                cursor: "pointer",
                background: active ? "var(--surface-0)" : "transparent",
                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 7,
                color: "inherit",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: active ? "var(--accent-ink)" : "var(--text-dim)",
                }}
              >
                Step {index + 1}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{entry.title}</span>
              <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{entry.blurb}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Step 1 — put a Core on a machine.
 *
 * Both documented paths, side by side, because the Panel cannot see the machine
 * and so cannot choose. The commands come from `~/shared/core-onboarding`,
 * which is the same place any other surface would read them from.
 */
function InstallStep() {
  return (
    <StepBody
      title="Install the Core on the machine you want to drive"
      lede="A Core is the daemon that owns the repository and runs the Harnesses. It goes on the machine with your code — a laptop, a workstation, a build box — not on this Panel. Pick whichever path fits that machine."
    >
      {CORE_INSTALL_PATHS.map((path) => (
        <div key={path.id} data-install-path={path.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{path.title}</div>
          <Prose>{path.blurb}</Prose>
          {path.commands.map((command) => (
            <CommandLine key={command} command={command} />
          ))}
          {path.note && <Aside>{path.note}</Aside>}
        </div>
      ))}
    </StepBody>
  );
}

/**
 * Step 2 — mint a code on that machine.
 *
 * The command is built from what the operator types, so `--label` is a thing
 * they have chosen rather than a flag they were shown and skipped. Under it,
 * the four lines `pair new` prints and what each one is for: three of them are
 * typed into step 3, and an operator who knows that reads the terminal once
 * instead of three times.
 */
function MintStep({ label, onLabel }: { label: string; onLabel: (next: string) => void }) {
  return (
    <StepBody
      title="Mint a pairing code on that machine"
      lede="Back on the Core's terminal. This prints a one-time code that this Panel redeems — it is single-use, it expires in five minutes by default, and the Core keeps only a digest of it, so it is printed exactly once."
    >
      <TextField
        label="Name this Panel will have on that Core"
        value={label}
        onChange={onLabel}
        placeholder="my-panel"
        hint="Optional, and worth setting: it is what `actana pair ls` calls this Panel on the Core later."
        autoComplete="off"
        spellCheck={false}
      />
      <CommandLine command={pairNewCommand(label)} />
      <Prose>Or, if that Core came up under Docker Compose:</Prose>
      <CommandLine command={composePairNewCommand(label)} />

      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>What it prints, and why</div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: "12px 14px",
          background: "var(--surface-0)",
          border: "1px solid var(--border)",
          borderRadius: 7,
        }}
      >
        {PAIR_NEW_OUTPUT.map((line) => (
          <div key={line.label} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11.5,
                color: "var(--text)",
                wordBreak: "break-all",
              }}
            >
              {line.label} <span style={{ color: "var(--accent-ink)" }}>{line.sample}</span>
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--text-dim)" }}>
              {line.meaning}
            </div>
          </div>
        ))}
      </div>
      <Aside>
        Those values are stand-ins — nothing has been minted for you. Read the real ones off that
        machine&apos;s terminal.
      </Aside>
    </StepBody>
  );
}

/**
 * Step 3 — the redemption, which is `AddCoreByPairing` and nothing else.
 *
 * The one thing this step adds is naming where the same form lives once the
 * wizard is gone. An operator who pairs a second Core next month should look
 * for Settings → Cores → Add Core and not for this screen, which they will
 * never see again unless they forget every Core they have.
 */
function RedeemStep({ onPaired }: { onPaired: (core: CoreWithDial) => Promise<void> }) {
  return (
    <StepBody
      title="Redeem the code here"
      lede="Give the Panel the Core's address, compare the fingerprint it is presented against the one on that terminal, and only then enter the code. The Panel does not send the code until the two match."
    >
      <AddCoreByPairing onPaired={onPaired} />
      <Aside>
        This is the same form as <strong>Settings → Cores → Add Core</strong>, which is where every
        Core after this one is paired. The gear icon in the top bar is waiting for you on the other
        side of this step.
      </Aside>
    </StepBody>
  );
}

/** Back / forward. There is no third button, and there never will be. */
function Footer({ step, onStep }: { step: StepIndex; onStep: (next: StepIndex) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <Btn
        variant="frame"
        size="sm"
        onClick={() => onStep((step - 1) as StepIndex)}
        disabled={step === 0}
      >
        Back
      </Btn>
      {step < 2 ? (
        <Btn variant="primary" size="sm" onClick={() => onStep((step + 1) as StepIndex)}>
          Next
        </Btn>
      ) : (
        <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--text-dim)" }}>
          The Panel opens as soon as a Core pairs.
        </span>
      )}
    </div>
  );
}

/** One step's frame: a heading, a sentence, and whatever the step is made of. */
function StepBody({
  title,
  lede,
  children,
}: {
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "18px 20px",
        background: "var(--surface-0)",
        border: "1px solid var(--border)",
        borderRadius: 9,
      }}
    >
      <h2 style={{ fontSize: 15.5, fontWeight: 650, margin: 0 }}>{title}</h2>
      <Prose>{lede}</Prose>
      {children}
    </section>
  );
}

function Prose({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "var(--text-dim)" }}>
      {children}
    </p>
  );
}

function Aside({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--mono)",
        fontSize: 11.5,
        lineHeight: 1.5,
        color: "var(--text-dim)",
      }}
    >
      {children}
    </div>
  );
}

/**
 * One pasteable command.
 *
 * A copy button rather than prose for the same reason `CoreNeedsUpdateNotice`
 * has one: the command is going to be pasted into a terminal on a *different*
 * machine, often read off a phone, and retyping a `curl … | bash` one-liner by
 * eye is how an operator ends up debugging their own typo.
 */
function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 9px",
        background: "var(--surface-1)",
        border: "1px solid var(--border)",
        borderRadius: 5,
      }}
    >
      <code
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: "var(--mono)",
          fontSize: 11.5,
          color: "var(--text)",
          overflowX: "auto",
          whiteSpace: "pre",
        }}
      >
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy: ${command}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "3px 7px",
          background: "transparent",
          border: "1px solid var(--border)",
          borderRadius: 4,
          color: "var(--text-dim)",
          fontFamily: "var(--mono)",
          fontSize: 10,
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={11} />
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}
