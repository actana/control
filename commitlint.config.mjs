/**
 * Commitlint configuration — enforces Conventional Commits v1.0.0.
 * Keep the `type-enum` list in sync with:
 *   - .github/workflows/conventions.yml (PR title check)
 *   - CONTRIBUTING.md (documentation)
 */
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
    'footer-leading-blank': [2, 'always'],
  },
  ignores: [
    // Allow auto-generated merge/revert messages from GitHub UI
    (message) => message.startsWith('Merge '),
  ],
};
