// A just-enough terminal screen, for reading what a harness has drawn.
//
// The Core never gets the screen, it gets the bytes that paint it. A TUI that
// lays itself out with cursor addressing (`ESC[7;3H`, `ESC[12G`) has no line
// breaks in those bytes at all, so deleting the escapes — what a text match
// wants — glues the lines of a dialog into one. This replays the bytes onto a
// grid of lines instead: cursor moves, erases, carriage returns and line feeds
// are honoured, colour, modes and titles are dropped. It is not a terminal
// (no scroll regions, no wide-character width, no alternate buffer): it keeps
// the characters and the lines they are on, which is all a dialog rule reads.

const MAX_LINES = 400;
const MAX_COLS = 400;

/** Replay `raw` terminal output and return the screen's lines, top to bottom. */
export function renderScreenLines(raw: string): string[] {
  const rows: string[][] = [[]];
  let row = 0;
  let col = 0;
  const ensureRow = (): void => {
    while (rows.length <= row) rows.push([]);
    if (rows.length > MAX_LINES) {
      const drop = rows.length - MAX_LINES;
      rows.splice(0, drop);
      row -= drop;
    }
  };
  const put = (ch: string): void => {
    ensureRow();
    if (col >= MAX_COLS) return;
    const line = rows[row];
    while (line.length < col) line.push(" ");
    line[col] = ch;
    col += 1;
  };
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\u001b") {
      const next = raw[i + 1];
      if (next === "[") {
        let j = i + 2;
        while (j < raw.length && !/[@-~]/.test(raw[j])) j += 1;
        const params = raw.slice(i + 2, j);
        const final = raw[j] ?? "";
        const nums = params
          .replace(/^[?>=!]/, "")
          .split(";")
          .map((n) => (n === "" ? NaN : Number.parseInt(n, 10)));
        const n1 = Number.isNaN(nums[0] ?? NaN) ? 1 : nums[0];
        const private_ = /^[?>=!]/.test(params);
        if (!private_) {
          if (final === "H" || final === "f") {
            row = (Number.isNaN(nums[0] ?? NaN) ? 1 : nums[0]) - 1;
            col = (Number.isNaN(nums[1] ?? NaN) ? 1 : nums[1]) - 1;
            row = Math.max(0, row);
            col = Math.max(0, col);
            ensureRow();
          } else if (final === "G") col = Math.max(0, n1 - 1);
          else if (final === "C") col += n1;
          else if (final === "D") col = Math.max(0, col - n1);
          else if (final === "A") row = Math.max(0, row - n1);
          else if (final === "B" || final === "E") {
            row += n1;
            if (final === "E") col = 0;
            ensureRow();
          } else if (final === "K") {
            ensureRow();
            const mode = Number.isNaN(nums[0] ?? NaN) ? 0 : nums[0];
            if (mode === 2) rows[row] = [];
            else if (mode === 1) for (let c = 0; c <= col && c < rows[row].length; c += 1) rows[row][c] = " ";
            else rows[row].length = Math.min(rows[row].length, col);
          } else if (final === "J") {
            ensureRow();
            const mode = Number.isNaN(nums[0] ?? NaN) ? 0 : nums[0];
            if (mode === 2 || mode === 3) {
              rows.length = 0;
              rows.push([]);
              row = 0;
              col = 0;
            } else if (mode === 0) {
              rows[row].length = Math.min(rows[row].length, col);
              rows.length = row + 1;
            }
          }
        }
        i = j + 1;
        continue;
      }
      if (next === "]") {
        // OSC: up to BEL or ST.
        let j = i + 2;
        while (j < raw.length && raw[j] !== "\u0007" && !(raw[j] === "\u001b" && raw[j + 1] === "\\")) j += 1;
        i = raw[j] === "\u001b" ? j + 2 : j + 1;
        continue;
      }
      // Two-byte escapes (ESC M, ESC 7 …) and charset selects (ESC ( B).
      i += next === "(" || next === ")" ? 3 : 2;
      continue;
    }
    if (ch === "\r") col = 0;
    else if (ch === "\n") {
      row += 1;
      ensureRow();
    } else if (ch === "\u0008") col = Math.max(0, col - 1);
    else if (ch >= " " && ch !== "\u007f") put(ch);
    i += 1;
  }
  return rows.map((r) => r.join("").replace(/\s+$/, ""));
}

/** The screen as text: its lines joined, trailing blank lines dropped. */
export function renderScreenText(raw: string): string {
  const lines = renderScreenLines(raw);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * Where in `chunk` the last full-screen clear ends, or -1: everything before
 * it was wiped by the harness. Same sequences prompt delivery treats as a
 * clear, kept here so the Core's dialog watch and `renderScreenText` agree.
 */
const CLEAR = /\u001b\[[23]J|\u001b\[\?(?:47|1047|1049)[hl]|\u001b\[(?:1;1)?H\u001b\[0?J|(?:\u001b\[2K(?:\u001b\[[0-9]*G)?\u001b\[[0-9]*A){5,}/g;
export function lastClearEnd(chunk: string): number {
  let end = -1;
  CLEAR.lastIndex = 0;
  for (let m = CLEAR.exec(chunk); m; m = CLEAR.exec(chunk)) end = m.index + m[0].length;
  return end;
}
