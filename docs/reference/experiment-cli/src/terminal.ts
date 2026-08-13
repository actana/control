// A minimal terminal emulator, so session output can be read as text.

/**
 * Replay raw PTY output into a screen buffer and read back what a terminal
 * would be showing.
 *
 * Stripping escape codes does not work on a TUI. Claude Code paints by moving
 * the cursor and overwriting cells — the spaces between words are cursor jumps,
 * not space characters, and a spinner rewrites the same cell hundreds of times.
 * Cut the escapes out and every frame of every redraw concatenates into one
 * line of soup.
 *
 * So this interprets the sequences instead: cursor moves, erases, line
 * insert/delete, and scrolling. Lines pushed off the top are kept in a
 * scrollback array, which is where the conversation transcript ends up — the
 * visible screen only ever holds the last `rows` lines.
 *
 * Colour (SGR) is parsed and discarded: the output is meant to be read, and the
 * cell attributes are not needed to know what the session said.
 */
export function renderTerminal(data: string, cols: number, rows: number): string[] {
  const blankRow = (): string[] => new Array(cols).fill(" ");
  const screen: string[][] = Array.from({ length: rows }, blankRow);
  const scrollback: string[][] = [];
  let cx = 0;
  let cy = 0;
  let savedX = 0;
  let savedY = 0;

  const clampX = (): void => {
    cx = Math.max(0, Math.min(cols - 1, cx));
  };
  const clampY = (): void => {
    cy = Math.max(0, Math.min(rows - 1, cy));
  };
  const scrollUp = (): void => {
    scrollback.push(screen.shift() ?? blankRow());
    screen.push(blankRow());
  };
  const newline = (): void => {
    cy++;
    if (cy >= rows) {
      scrollUp();
      cy = rows - 1;
    }
  };

  for (let i = 0; i < data.length; i++) {
    const ch = data[i];

    if (ch === "\x1b") {
      const next = data[i + 1];

      // CSI — the sequences that actually move and erase.
      if (next === "[") {
        let j = i + 2;
        while (j < data.length && !/[@-~]/.test(data[j])) j++;
        const final = data[j];
        const params = data.slice(i + 2, j).replace(/^[?>!]/, "");
        const nums = params.split(";").map((p) => Number.parseInt(p, 10));
        const arg = (index: number, fallback: number): number =>
          Number.isFinite(nums[index]) && nums[index] > 0 ? nums[index] : fallback;
        i = j;

        switch (final) {
          case "H":
          case "f":
            cy = arg(0, 1) - 1;
            cx = arg(1, 1) - 1;
            clampX();
            clampY();
            break;
          case "A":
            cy -= arg(0, 1);
            clampY();
            break;
          case "B":
            cy += arg(0, 1);
            clampY();
            break;
          case "C":
            cx += arg(0, 1);
            clampX();
            break;
          case "D":
            cx -= arg(0, 1);
            clampX();
            break;
          case "G":
            cx = arg(0, 1) - 1;
            clampX();
            break;
          case "d":
            cy = arg(0, 1) - 1;
            clampY();
            break;
          case "E":
            cy += arg(0, 1);
            cx = 0;
            clampY();
            break;
          case "F":
            cy -= arg(0, 1);
            cx = 0;
            clampY();
            break;
          case "J": {
            // Erase in display. Mode 2/3 is the full-screen repaint a TUI does
            // on resize; a real terminal drops those cells, so this does too.
            const mode = Number.isFinite(nums[0]) ? nums[0] : 0;
            if (mode === 0) {
              for (let x = cx; x < cols; x++) screen[cy][x] = " ";
              for (let y = cy + 1; y < rows; y++) screen[y] = blankRow();
            } else if (mode === 1) {
              for (let x = 0; x <= cx; x++) screen[cy][x] = " ";
              for (let y = 0; y < cy; y++) screen[y] = blankRow();
            } else {
              for (let y = 0; y < rows; y++) screen[y] = blankRow();
            }
            break;
          }
          case "K": {
            const mode = Number.isFinite(nums[0]) ? nums[0] : 0;
            if (mode === 0) for (let x = cx; x < cols; x++) screen[cy][x] = " ";
            else if (mode === 1) for (let x = 0; x <= cx; x++) screen[cy][x] = " ";
            else screen[cy] = blankRow();
            break;
          }
          case "L": {
            // Insert blank lines at the cursor, pushing the rest down.
            for (let n = 0; n < arg(0, 1); n++) {
              screen.splice(cy, 0, blankRow());
              screen.pop();
            }
            break;
          }
          case "M": {
            for (let n = 0; n < arg(0, 1); n++) {
              screen.splice(cy, 1);
              screen.push(blankRow());
            }
            break;
          }
          case "P": {
            // Delete characters, pulling the rest of the line left.
            for (let n = 0; n < arg(0, 1); n++) {
              screen[cy].splice(cx, 1);
              screen[cy].push(" ");
            }
            break;
          }
          case "X": {
            for (let n = 0, x = cx; n < arg(0, 1) && x < cols; n++, x++) screen[cy][x] = " ";
            break;
          }
          case "S":
            for (let n = 0; n < arg(0, 1); n++) scrollUp();
            break;
          case "s":
            savedX = cx;
            savedY = cy;
            break;
          case "u":
            cx = savedX;
            cy = savedY;
            break;
          default:
            // SGR (m), mode set/reset (h/l), scroll region (r), device queries —
            // nothing that changes which characters are on screen.
            break;
        }
        continue;
      }

      // OSC — window title and friends. Runs to BEL or String Terminator.
      if (next === "]") {
        let j = i + 2;
        while (j < data.length && data[j] !== "\x07" && !(data[j] === "\x1b" && data[j + 1] === "\\")) j++;
        i = data[j] === "\x1b" ? j + 1 : j;
        continue;
      }

      if (next === "7") {
        savedX = cx;
        savedY = cy;
        i++;
        continue;
      }
      if (next === "8") {
        cx = savedX;
        cy = savedY;
        i++;
        continue;
      }
      if (next === "M") {
        // Reverse index — scroll down at the top of the screen.
        if (cy === 0) {
          screen.unshift(blankRow());
          screen.pop();
        } else cy--;
        i++;
        continue;
      }
      // Charset selection and other two-byte escapes.
      i++;
      continue;
    }

    if (ch === "\n") {
      newline();
      continue;
    }
    if (ch === "\r") {
      cx = 0;
      continue;
    }
    if (ch === "\b") {
      cx = Math.max(0, cx - 1);
      continue;
    }
    if (ch === "\t") {
      cx = Math.min(cols - 1, (cx + 8) & ~7);
      continue;
    }
    if (ch < " ") continue; // other control bytes paint nothing

    if (cx >= cols) {
      cx = 0;
      newline();
    }
    screen[cy][cx] = ch;
    cx++;
  }

  return [...scrollback, ...screen].map((row) => row.join("").replace(/\s+$/, ""));
}
