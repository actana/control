// What an operator has to do on the *other* machine before this Panel is
// worth anything — as data, so the first-run wizard and any future surface
// print the same commands.
//
// The Panel's whole shape is that the machine doing the work is somewhere
// else. Every string in this file is therefore a **Core-side** command: it is
// pasted into a terminal on the machine being paired, never run by the Panel
// and never run by the browser. That is why they live beside `cores.ts`'s
// `CORE_UPDATE_COMMAND` rather than in a component — a command an operator
// pastes on another machine is a fact about the product, and it belongs
// somewhere a test can read it.
//
// Their source of truth is the repository's own install documentation
// (`README.md` §Quickstart, `INSTALL.md` §Step 1–3) and, for the `pair new`
// output block, `packages/cli/src/actana-pair.ts` itself. When those change,
// these change with them; a wizard that teaches a command the docs no longer
// print, or describes output the CLI no longer emits, is worse than no wizard
// at all. `__tests__/core-onboarding.test.ts` reads the CLI's own pinned
// contract rather than a copy of this file, so that drift is a red suite.

/** One documented way to put a Core on a machine. */
export type CoreInstallPath = {
  /** Stable handle, used as a React key and as a test's grip on the block. */
  id: "installer" | "compose";
  /** What this path is, in the operator's terms. */
  title: string;
  /** Which machine it suits — the choice, not the mechanics. */
  blurb: string;
  /** The lines to paste, in order. Each is copyable on its own. */
  commands: readonly string[];
  /** The one thing that trips people up on this path, or null. */
  note: string | null;
};

/**
 * The image tag the Compose file should be pinned to, for a Panel on this
 * version.
 *
 * `deploy/docker-compose.yml` defaults both services to `:latest`, and
 * `README.md` §Quickstart is explicit that `:latest` 404s until the first
 * release is published — the images publish as `beta-x.y.z` off the open train
 * and are retagged `x.y.z` plus `latest` only when that train is released. So
 * the wizard prints a tag rather than the bare default, and it prints *this
 * Panel's own line*: pairing a Core built from a different line than the Panel
 * driving it is the one thing `ACTANA_TAG` exists to prevent
 * (`deploy/docker-compose.yml`, "one variable, both services").
 *
 * Derived rather than hard-coded, so the wizard cannot go stale against the
 * train it ships on.
 */
export function coreImageTag(panelVersion: string): string {
  return `beta-${panelVersion}`;
}

/** The Compose line that brings up **only the Core**, pinned to that tag. */
export function composeUpCoreCommand(panelVersion: string): string {
  return `ACTANA_TAG=${coreImageTag(panelVersion)} docker compose -f deploy/docker-compose.yml up -d core`;
}

/**
 * The two install paths, in the order the README offers them.
 *
 * Both are here rather than one being chosen for the operator, because the
 * choice is about their machine and the Panel cannot see their machine. The
 * blurbs are the README's own "Which one?" paragraph, split in two.
 *
 * **The Compose path brings up `core` and nothing else.** `README.md`'s
 * `docker compose … up -d` starts the whole file — a Panel *and* a Core — which
 * is the right command in the README, where the reader has no Panel yet, and
 * the wrong one here, where by definition they are already looking at one. Left
 * bare it would either clash with their Panel on 7420 or shadow it, and the
 * screen would have told them to do it. Naming the `core` service is the whole
 * difference (`deploy/docker-compose.yml`, the `core:` service).
 */
export function coreInstallPaths(panelVersion: string): readonly CoreInstallPath[] {
  return [
    {
      id: "installer",
      title: "Installer — a machine that already has your code",
      blurb:
        "Linux, or macOS on arm64, as your own user and without sudo. Two commands, because installing is not activating: the first places the Core bundle and the `actana` CLI, the second turns the machine into a Core.",
      commands: [
        "curl -fsSL https://raw.githubusercontent.com/actana/control/main/install.sh | bash",
        "actana setup",
      ],
      note: "The installer prints the exact `actana setup` line to run — run the line it printed, not this one, if the two differ.",
    },
    {
      id: "compose",
      title: "Docker Compose — a Core beside this Panel",
      blurb:
        "A Core on the same Compose file as this Panel, and only the Core: the file also defines a `panel` service, and you are already looking at a Panel. Quickest way to see a Session run if this Panel is itself a container.",
      commands: [
        "git clone https://github.com/actana/control && cd control",
        composeUpCoreCommand(panelVersion),
      ],
      note: `\`ACTANA_TAG\` pins both services to one line, and it is set here because the file's default is \`:latest\`, which does not resolve until a release is published. \`${coreImageTag(panelVersion)}\` is the line this Panel is on. Once a release exists, that line's tag is \`${panelVersion}\`.`,
    },
  ];
}

/** The Compose prefix that runs a Core-side command inside the Core container. */
export const COMPOSE_EXEC_PREFIX = "docker compose -f deploy/docker-compose.yml exec core";

/**
 * The wizard's three steps, as ids, in the order the machine has to do them.
 *
 * Here rather than in the component because {@link firstRunStepFromSearch}
 * parses them out of a URL and a link in `deploy/docker-compose.yml` writes one
 * of them by hand. Three places naming the same three strings is how a deep
 * link starts pointing at a step that no longer exists.
 */
export const FIRST_RUN_STEP_IDS = ["install", "mint", "redeem"] as const;
export type FirstRunStepId = (typeof FIRST_RUN_STEP_IDS)[number];

/** The query parameter that opens the wizard on a given step. */
export const FIRST_RUN_STEP_PARAM = "step";

/**
 * Which step a URL asks for, or null for "start at the beginning".
 *
 * **This chooses a starting position and can do nothing else.** Every step is
 * already reachable by clicking the rail, so a link that opens step 3 is a
 * shortcut past two screens of reading and not a way around anything: the gate
 * is a live Core count (`FirstRunGate`), the redemption is still a fingerprint
 * comparison the operator performs, and a Panel with no paired Core lands back
 * here on the next load whatever the URL said. Nothing downstream may read this
 * value, and nothing about pairing may become easier because it was set.
 *
 * Both spellings are accepted because both are natural to type and neither is
 * ambiguous: the step's id (`?step=redeem`) reads at a glance in the Compose
 * file, and its 1-based position (`?step=3`) is what someone who has just been
 * told "jump to the third step" will try. An unknown value is null rather than
 * an error — a stale bookmark should open the wizard, not break it.
 */
export function firstRunStepFromSearch(search: string): 0 | 1 | 2 | null {
  const raw = new URLSearchParams(search).get(FIRST_RUN_STEP_PARAM);
  if (raw === null) return null;
  const wanted = raw.trim().toLowerCase();

  const byId = FIRST_RUN_STEP_IDS.indexOf(wanted as FirstRunStepId);
  if (byId >= 0) return byId as 0 | 1 | 2;

  // 1-based, because the rail is labelled "Step 1", "Step 2", "Step 3" and a
  // person reading a URL off that screen counts from one.
  if (/^[123]$/.test(wanted)) return (Number(wanted) - 1) as 0 | 1 | 2;

  return null;
}

/**
 * The deep link that opens the wizard on the redeem step.
 *
 * Relative, and deliberately not built from an origin: a Panel is reached at
 * whatever address its operator put in front of it — `localhost:7420`, a LAN
 * name, a reverse proxy — and this module has no business guessing which.
 */
export const REDEEM_STEP_LINK = `?${FIRST_RUN_STEP_PARAM}=redeem`;

/**
 * The disclaimer the wizard shows above the rail, for the operator whose Core
 * is already running.
 *
 * `deploy/docker-compose.yml` brings up a `panel` **and** a `core` on one
 * network, so an operator who came that way has done step 1 before they ever
 * saw this screen — the machine is provisioned and the daemon is up. What they
 * have not done is mint a code, which is one `exec` away, and the wizard's
 * first two screens are two screens of install advice they do not need.
 *
 * **It is a disclaimer, not a detection.** Nothing in the Panel can tell that
 * it came up under Compose: the container has no marker for it, the
 * environment carries no flag, and inventing one would be a runtime dependency
 * on a deployment shape the product does not otherwise care about. So the bar
 * states the condition and lets the operator recognise themselves in it — which
 * is also why it never hides a step or preselects one, and why the rail behind
 * it keeps all three reachable.
 */
export const COMPOSE_SHORTCUT_NOTICE =
  "Came here from `docker compose up -d`? Then the Core is already installed and running beside this Panel at `core:8443` — step 1 is done. Mint a code with the one command below and jump ahead.";

/**
 * The label on the bar's jump.
 *
 * **Worded as a move between steps, never as a way out of them.** The wizard is
 * a gate — no skip, no dismiss, no later — and `first-run-gate.test.tsx` scans
 * every button on every step for exactly those words. This control is not an
 * exception to that rule: it goes *to* the step that pairs a Core, which is the
 * gate's only exit condition, so naming it "Skip…" would describe the opposite
 * of what it does and would rightly trip a guard that exists to catch an escape
 * hatch somebody added later.
 */
export const COMPOSE_SHORTCUT_ACTION = "Jump to step 3";

/**
 * What the canonical Add-a-Core surface is called, so the wizard and the
 * settings page name one place with one string (#358 asks for exactly that).
 *
 * `CoresSettingsPage` renders the field, and the wizard's redeem step points at
 * it; both read these rather than each spelling it out.
 */
export const ADD_CORE_FIELD_LABEL = "Add a Core";
export const ADD_CORE_LOCATION = `Settings → Cores → ${ADD_CORE_FIELD_LABEL}`;

/**
 * What `actana pair new --label <name>` writes to stdout, as an operator will
 * see it, and what each line is for.
 *
 * A sample rather than live values, because the Panel is on the wrong machine
 * to have any: nothing here has been minted, and the point of showing it is
 * that the person watching the Panel recognises these lines when they scroll
 * past on the Core's terminal. Four of them are typed back into the redeem
 * step or checked against it; one is a deadline.
 *
 * **The set is the set that command prints, not a shorter one.** `pair new`
 * emits `Label` whenever `--label` is given, and the wizard always teaches
 * `--label` — so `Label` belongs here, between `Expires` and `Session`, in the
 * order `packages/cli/src/actana-pair.ts` writes them. (`Endpoint host` is the
 * sixth line and is not here: it appears only for `--public-host`, which this
 * wizard does not teach.) The CLI's own suite pins that set for this exact
 * invocation, and `__tests__/core-onboarding.test.ts` reads it from there.
 *
 * **The shapes are what recognition runs on**, so they match the real printer
 * even though the values do not: an ISO-8601 expiry (`absoluteTime`), and a
 * 36-character UUID session (`randomUUID`). A short prefixed stand-in would
 * invite an operator to truncate a UUID into the Session box and fail a
 * redemption for a reason nothing on screen explains.
 *
 * The values are obvious fakes on purpose. An operator who pastes `K7RP-9X4T`
 * gets a refusal, which is the correct outcome and a cheaper one than a sample
 * that could be mistaken for a real code.
 */
export type PairNewOutputLine = {
  /** The label as `pair new` prints it, left-aligned in a fixed column. */
  label: string;
  /** A stand-in value — never a real credential. */
  sample: string;
  /** What the operator does with it. */
  meaning: string;
};

export const PAIR_NEW_OUTPUT: readonly PairNewOutputLine[] = [
  {
    label: "Pairing code",
    sample: "K7RP-9X4T",
    meaning:
      "The one-time code. Single-use, expires, and dies after five wrong guesses. It is printed once — the Core keeps only a digest — so a lost code is re-minted by running the command again.",
  },
  {
    label: "CA fingerprint",
    sample: "AA:BB:CC:…:99",
    meaning:
      "That Core's certificate authority, as 32 colon-separated bytes. You compare it against the fingerprint this Panel shows you *before* the code is sent, which is what makes the pairing safe over a network you do not trust.",
  },
  {
    label: "Expires",
    sample: "2026-08-31T14:32:07Z (in 5 minutes)",
    meaning:
      "The deadline, in UTC. Five minutes by default; `--ttl` moves it. Past it, mint another.",
  },
  {
    label: "Label",
    sample: "my-panel",
    meaning:
      "The name you passed to `--label`, echoed back. It is what that Core calls this Panel in `actana pair ls`, and it is the Core's record — not the name this Panel will show you, which you choose in the last box below.",
  },
  {
    label: "Session",
    sample: "7f2c1a9e-4b60-4c3d-9f21-8e5a7c0d1b34",
    meaning:
      "The pairing session the code belongs to — a full 36-character UUID. It goes in the Session box below, whole.",
  },
];

/**
 * Why a typed name cannot go into `--label`, or null if it can.
 *
 * There is exactly one such reason and it is not a style rule: `actana pair
 * new`'s option parser refuses any value that starts with `-`, in **both** flag
 * forms — `--label -panel` and `--label=-panel` hit the same guard
 * (`actana-pair.ts`, "needs a value"). Quoting does not help either, because
 * the shell strips the quotes before the CLI ever sees the token.
 *
 * So it has to be caught here, on the Panel side. Emitting the command anyway
 * would produce precisely the failure {@link pairNewCommand} exists to prevent:
 * an operator pasting exactly what the Panel printed and being refused by the
 * Core for it.
 */
export function labelRefusal(label: string): string | null {
  if (label.trim().startsWith("-")) {
    return "A name cannot start with “-”. `actana pair new` reads it as another option and refuses the command — in both `--label -x` and `--label=-x` form, and quoting does not help because the shell strips the quotes first.";
  }
  return null;
}

/**
 * The mint command, with the operator's chosen name folded in.
 *
 * `--label` is what the Core will call this Panel in `actana pair ls`, so the
 * name is worth choosing rather than defaulting; an empty box therefore prints
 * the placeholder rather than dropping the flag, because a wizard that teaches
 * `actana pair new` teaches an operator to skip the one thing that makes their
 * pairing list readable later. A name the Core would refuse
 * ({@link labelRefusal}) prints the placeholder too — never the refused form.
 */
export function pairNewCommand(label: string): string {
  return `actana pair new --label ${labelArgument(label)}`;
}

/** The same command, for a Core that came up under Compose. */
export function composePairNewCommand(label: string): string {
  return `${COMPOSE_EXEC_PREFIX} ${pairNewCommand(label)}`;
}

/**
 * The `--label` argument: a placeholder when nothing usable is typed, and
 * otherwise the name, quoted only when a shell would need it.
 *
 * Quoting matters because this string is going to be pasted into a terminal.
 * A name with a space in it silently becomes two arguments, and `pair new`
 * would take the first and reject the second — a failure the operator would
 * blame on the Panel, having pasted exactly what it printed.
 *
 * The placeholder is bare `NAME` for the same reason, and it is deliberately
 * the CLI's own `NAME_PLACEHOLDER` (`packages/cli/src/actana-pair.ts`, #357
 * review B3): `<name>` is not inert in a shell. Pasted into bash it parses as
 * redirections — read stdin from a file called `name`, write stdout to the
 * next word — so the command never runs and what the operator sees is
 * `bash: name: No such file or directory`, a message that names neither
 * `actana` nor the actual problem. This is the wizard's *default* state — an
 * empty name box, behind a one-click copy button — so it is the likeliest
 * thing of all to be pasted unedited. `NAME` reads as a slot just as clearly,
 * survives every shell, and pasted unedited it mints a code labelled `NAME`,
 * recoverable with one `actana core rm NAME`, which a shell error is not.
 */
function labelArgument(label: string): string {
  const trimmed = label.trim();
  if (trimmed === "" || labelRefusal(trimmed) !== null) return "NAME";
  if (/^[A-Za-z0-9._:@%+,/=-]+$/.test(trimmed)) return trimmed;
  return `'${trimmed.replace(/'/g, `'\\''`)}'`;
}
