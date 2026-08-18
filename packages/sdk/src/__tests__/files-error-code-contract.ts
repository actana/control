// The refusal vocabulary, held against the one copy of it that a compiler
// cannot reach: the operator-facing table in `docs/external-api.md` (#224).
//
// ## What this does and does not have to catch
//
// #224 removed the drift that had a mechanism: `CoreFilesErrorCode` was written
// out in both `packages/core` and `packages/sdk`, and the SDK's copy was checked
// by nothing, so a code added on one side and forgotten on the other would have
// been a type error nowhere. That is fixed by ownership rather than by a test —
// there is now one definition, `CORE_FILES_ERROR_CODES` in
// `@actana/sdk/core-files-error-codes`, and both packages import it. No test is
// needed to keep a module honest with itself.
//
// What ownership cannot fix is the third copy. `docs/external-api.md` states the
// same vocabulary in prose for people integrating against a Core, and prose does
// not typecheck. It is a legitimate copy — a table with a "Means" column is not
// something a union can generate — but "legitimate" is not the same as
// "maintained", and a documented surface that has quietly stopped listing two of
// the codes it answers is a support ticket that starts with an operator being
// told their tooling is wrong.
//
// So this is the half of #224's "adding a refusal code fails until every copy is
// updated" that needs a test rather than a compiler. Append a member to
// `CORE_FILES_ERROR_CODES` and this goes red until the table names it too.
//
// ## Why it is a function, and why it runs in both suites
//
// Same reason as `files-list-contract.ts`, and the same lesson behind it: #218
// and #219 shipped a listing URL the SDK and the Core disagreed about, through
// two green suites, because each side proved itself against its own idea of the
// other. **A test living in one package is a test the other package's author
// does not run before pushing.**
//
// That cuts exactly here. The vocabulary is now owned by `@actana/sdk`, but the
// behaviour it names is the *Core's* — a new refusal is written in
// `core-files-routes.ts` or `files-tar.ts`, by somebody working in the Core, who
// may reasonably run `pnpm --filter @actana/core test` and nothing else. If this
// check lived only in the SDK's suite it would be invisible to precisely the
// author most likely to need it. So the body lives here once and two one-line
// `.test.ts` files register it, one in each package:
//
//   packages/sdk/src/__tests__/core-files-error-codes.test.ts
//   packages/core/src/__tests__/core-files-error-codes.test.ts
//
// Delete either registration and half the audience stops being warned.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CORE_FILES_ERROR_CODES } from "../core-files-error-codes";

/**
 * `docs/external-api.md`, from this file's own location.
 *
 * Resolved from `import.meta.dirname` rather than `process.cwd()` because this
 * module is run from two packages' working directories and a relative path
 * would be correct in at most one of them.
 */
const EXTERNAL_API_DOC = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "docs",
  "external-api.md",
);

const START_MARKER = "<!-- refusal-codes: start";
const END_MARKER = "<!-- refusal-codes: end -->";

/**
 * The `Code` column of every table between the markers.
 *
 * Reads the header row to find which column is `Code` rather than assuming an
 * index, because the two tables in that region do not have the same shape — one
 * leads with `Status` and one does not — and a hard-coded column would silently
 * start reading prose the day either table gained a column.
 *
 * Only that column is read. The `Means` column is full of backticked things
 * that are not refusal codes (`PUT`, `sha256`, `…/files/list`), so a sweep of
 * every code span in the region would need an ever-growing list of exceptions —
 * which is a check that erodes rather than one that holds.
 */
function documentedCodes(markdown: string): string[] {
  const start = markdown.indexOf(START_MARKER);
  const end = markdown.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `the refusal-code markers are missing from ${EXTERNAL_API_DOC} — ` +
        "moving or deleting them switches this check off, which is the one " +
        "edit it cannot catch by itself",
    );
  }

  const codes: string[] = [];
  let codeColumn: number | null = null;

  for (const line of markdown.slice(start, end).split("\n")) {
    const row = line.trim();
    if (!row.startsWith("|")) {
      // A blank line or prose ends a table, so the next one gets to declare its
      // own header instead of inheriting the previous table's column index.
      codeColumn = null;
      continue;
    }
    const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
    if (codeColumn === null) {
      codeColumn = cells.indexOf("Code");
      if (codeColumn === -1) {
        throw new Error(`a table between the refusal-code markers has no \`Code\` column: ${row}`);
      }
      continue;
    }
    // The `| --- |` separator under every header.
    if (cells.every((cell) => /^-+$/.test(cell))) continue;

    const cell = cells[codeColumn] ?? "";
    for (const match of cell.matchAll(/`([^`]+)`/g)) codes.push(match[1]!);
  }

  return codes;
}

/** Register the contract in the calling package's suite. */
export function describeFilesErrorCodeContract(): void {
  describe("the refusal vocabulary and the API document say the same thing", () => {
    const markdown = readFileSync(EXTERNAL_API_DOC, "utf8");

    it("documents every code the surface can answer, and invents none", () => {
      // Set equality, deliberately, rather than "the doc mentions each code".
      // Both directions are real failures and they fail differently: a code in
      // the union and not the table is a refusal an integrator has no way to
      // look up, and a code in the table and not the union is worse — it sends
      // somebody writing a `catch` for something no Core will ever send.
      const documented = [...new Set(documentedCodes(markdown))].sort();
      const defined = [...CORE_FILES_ERROR_CODES].sort();

      expect(documented).toEqual(defined);
    });

    it("finds its own markers, so a silent switch-off is a failure", () => {
      // `documentedCodes` throws when the markers are gone. Asserting it here
      // means the guardrail's own load-bearing assumption is tested rather than
      // assumed: without this, deleting the markers would make the check pass
      // vacuously on an empty region if the equality above were ever relaxed to
      // a subset test.
      expect(() => documentedCodes("no markers here")).toThrow(/markers are missing/);
      expect(documentedCodes(markdown).length).toBeGreaterThan(0);
    });

    it("lists no code twice", () => {
      // A duplicated member is invisible in the derived type — a union collapses
      // it — and it would turn the comparison above into a puzzle: the doc is
      // deduplicated when it is read, so the mismatch would name a code that is
      // present in both places. Failing on the duplicate itself says what is
      // actually wrong.
      const seen = new Set(CORE_FILES_ERROR_CODES);
      expect([...seen].sort()).toEqual([...CORE_FILES_ERROR_CODES].sort());
    });
  });
}
