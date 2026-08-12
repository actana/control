// Output helpers: a column-aligned table, and the JSON writer.
//
// Both exist so that "every list command emits `--json`" (#129 D10) is one
// decision made once. A noun renders rows; it does not decide how a table is
// spaced or how JSON is terminated, and it cannot accidentally emit a table on
// the `--json` path.

/** Render a header row plus body rows as a left-aligned, space-padded table. */
export function formatTable(header: string[], rows: string[][]): string[] {
  const all = [header, ...rows];
  const widths = header.map((_, column) =>
    all.reduce((wide, row) => Math.max(wide, (row[column] ?? "").length), 0),
  );
  return all.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join("  ")
      .trimEnd(),
  );
}

/**
 * Serialize a `--json` payload.
 *
 * Two spaces and a trailing newline, matching every other JSON this repository
 * writes. Machine-readable does not mean unreadable, and a payload a human can
 * skim in a terminal is what makes `--json` the flag people reach for when they
 * are debugging rather than only when they are scripting.
 */
export function formatJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}
