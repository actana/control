/**
 * Commitlint configuration — enforces Conventional Commits v1.0.0.
 * Keep the `type-enum` list in sync with:
 *   - .github/workflows/conventions.yml (PR title check)
 *   - CONTRIBUTING.md (documentation)
 *
 * Self-contained on purpose: conventions.yml copies *this file alone* into
 * RUNNER_TEMP beside a throwaway commitlint install, so the rule below is an
 * inline plugin rather than an import. One file, one place to change it.
 */

/**
 * Tokens that genuinely open a footer. Everything else on a line of its own is
 * prose — see TRAILER_PATTERN. Case-insensitive; keep the list tight, because
 * a word added here becomes a word contributors can no longer start a wrapped
 * body line with.
 */
const TRAILER_TOKENS = [
  'BREAKING[ -]CHANGE',
  'Refs?',
  'References',
  'Closes?',
  'Closed',
  'Fix(es|ed)?',
  'Resolves?',
  'Resolved',
  'Reverts?',
  'Co-authored-by',
  'Signed-off-by',
  'Reviewed-by',
  'Acked-by',
  'Tested-by',
  'Reported-by',
  'Suggested-by',
  'Helped-by',
  'Cc',
];

/**
 * A real trailer is one of those tokens followed by `: ` or ` #<digits>`.
 * Requiring the separator is what keeps `Fixes the crash under Podman` — a
 * sentence — from being read as a `Fixes` footer.
 */
const TRAILER_PATTERN = new RegExp(`^(${TRAILER_TOKENS.join('|')})(:[ \t]|[ \t]#\\d)`, 'i');

/**
 * `footer-leading-blank`, minus the false positives.
 *
 * The stock rule asks conventional-commits-parser where the footer starts, and
 * that parser calls any line shaped like `token: value` a footer — including a
 * body sentence that happens to wrap onto `that: it is absent under Podman…`
 * or `to: different arrival, different PID 1…`. Three commits on PR #66 failed
 * CI that way with nothing wrong in them, and a check that fails on correct
 * input is a check people learn to wave through.
 *
 * So we find the footer ourselves: the first line that opens with a *known*
 * trailer token (`Refs #39`, `Co-authored-by:`, `BREAKING CHANGE:`) starts the
 * footer, and that line must have a blank line above it. Prose is left alone.
 *
 * The trade is a missed report when someone jams an exotic trailer straight
 * onto the body. That is the cheaper failure: the tokens this repo actually
 * uses are all covered, and a false negative costs a blank line while a false
 * positive costs a red required check on a good commit.
 */
const trailerLeadingBlank = (parsed) => {
  const lines = String(parsed.raw ?? '').split('\n');

  // Start at 1: line 0 is the header, which has no line above it to be blank.
  for (let i = 1; i < lines.length; i += 1) {
    if (!TRAILER_PATTERN.test(lines[i])) continue;
    if (lines[i - 1].trim() === '') return [true];
    return [
      false,
      `footer must have leading blank line — "${lines[i].slice(0, 40)}" follows body text directly`,
    ];
  }

  return [true];
};

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
      ],
    ],
    // Off, not "never sentence-case". This repo's subjects legitimately open
    // with a ticket id — `test(actana/web-panel): E10 — black-box Panel e2e`
    // — and every case rule here would reject that.
    'subject-case': [0],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    // 120, not the conventional 72: 84 of the 120 commits before this rule
    // landed were longer than 72, and 33 were longer than 100. A limit the
    // project's own history fails is a limit people learn to bypass. This one
    // catches a runaway subject without arguing with the house style.
    'header-max-length': [2, 'always', 120],
    'body-max-line-length': [2, 'always', 100],
    'body-leading-blank': [2, 'always'],
    // Off in favour of `trailer-leading-blank` above it — same intent, without
    // mistaking a wrapped body sentence for a footer.
    'footer-leading-blank': [0],
    'trailer-leading-blank': [2, 'always'],
  },
  plugins: [{ rules: { 'trailer-leading-blank': trailerLeadingBlank } }],
  ignores: [
    // Allow auto-generated merge/revert messages from GitHub UI
    (message) => message.startsWith('Merge '),
  ],
};
