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
// (`README.md` §Quickstart, `INSTALL.md` §Step 1–3). When those change, these
// change with them; a wizard that teaches a command the docs no longer print
// is worse than no wizard at all.

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
 * The two install paths, in the order the README offers them.
 *
 * Both are here rather than one being chosen for the operator, because the
 * choice is about their machine and the Panel cannot see their machine. The
 * blurbs are the README's own "Which one?" paragraph, split in two.
 */
export const CORE_INSTALL_PATHS: readonly CoreInstallPath[] = [
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
      "The whole product on one host, which is the quickest way to see a Session run. The Core comes up on the same network as the Panel you are looking at.",
    commands: [
      "git clone https://github.com/actana/control && cd control",
      "docker compose -f deploy/docker-compose.yml up -d",
    ],
    note: null,
  },
];

/** The Compose prefix that runs a Core-side command inside the Core container. */
export const COMPOSE_EXEC_PREFIX = "docker compose -f deploy/docker-compose.yml exec core";

/**
 * What `actana pair new --label <name>` writes to stdout, as an operator will
 * see it, and what each line is for.
 *
 * A sample rather than live values, because the Panel is on the wrong machine
 * to have any: nothing here has been minted, and the point of showing it is
 * that the person watching the Panel recognises the four facts when they scroll
 * past on the Core's terminal. Three of them are typed back into the redeem
 * step; the fourth is a deadline.
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
      "That Core's certificate authority. You compare it against the fingerprint this Panel shows you *before* the code is sent, which is what makes the pairing safe over a network you do not trust.",
  },
  {
    label: "Expires",
    sample: "2026-08-31 14:32 UTC (in 5 minutes)",
    meaning:
      "The deadline. Five minutes by default; `--ttl` moves it. Past it, mint another.",
  },
  {
    label: "Session",
    sample: "ps_7f2c1a9e",
    meaning: "The pairing session the code belongs to. It goes in the Session box below.",
  },
];

/**
 * The mint command, with the operator's chosen name folded in.
 *
 * `--label` is what the Core will call this Panel in `actana pair ls`, so the
 * name is worth choosing rather than defaulting; an empty box therefore prints
 * the placeholder rather than dropping the flag, because a wizard that teaches
 * `actana pair new` teaches an operator to skip the one thing that makes their
 * pairing list readable later.
 */
export function pairNewCommand(label: string): string {
  return `actana pair new --label ${labelArgument(label)}`;
}

/** The same command, for a Core that came up under Compose. */
export function composePairNewCommand(label: string): string {
  return `${COMPOSE_EXEC_PREFIX} ${pairNewCommand(label)}`;
}

/**
 * The `--label` argument: a placeholder when nothing is typed, and otherwise
 * the name, quoted only when a shell would need it.
 *
 * Quoting matters because this string is going to be pasted into a terminal.
 * A name with a space in it silently becomes two arguments, and `pair new`
 * would take the first and reject the second — a failure the operator would
 * blame on the Panel, having pasted exactly what it printed.
 */
function labelArgument(label: string): string {
  const trimmed = label.trim();
  if (trimmed === "") return "<name>";
  if (/^[A-Za-z0-9._:@%+,/=-]+$/.test(trimmed)) return trimmed;
  return `'${trimmed.replace(/'/g, `'\\''`)}'`;
}
