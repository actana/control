/**
 * A JSON file as an operator reads it: re-indented with two spaces, when the whole file is there and is JSON. **Only the
 * whitespace between tokens changes.** Every string, number and literal is copied from the file as it is, so a number
 * above 2^53, `1.50`, a repeated key or an escape sequence shows exactly as the file has it (a parse and stringify would
 * change all of those). A cut-off preview or a file that does not parse is shown as it is: indenting a prefix would invent
 * a structure the file does not have.
 */
export function prettyJson(text: string, truncated: boolean): string {
  if (truncated) return text;
  try {
    JSON.parse(text); // validity only: the result is not used
  } catch {
    return text;
  }
  const indent = (depth: number) => "  ".repeat(depth);
  let out = "";
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      // A string runs to its closing quote; a backslash escapes the next character, whatever it is.
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "{" || c === "[") {
      let j = i + 1;
      while (/\s/.test(text[j] ?? "")) j += 1;
      if (text[j] === (c === "{" ? "}" : "]")) {
        out += c + text[j]; // an empty object or array stays on one line
        i = j + 1;
      } else {
        depth += 1;
        out += `${c}\n${indent(depth)}`;
        i += 1;
      }
    } else if (c === "}" || c === "]") {
      depth -= 1;
      out += `\n${indent(depth)}${c}`;
      i += 1;
    } else if (c === ",") {
      out += `,\n${indent(depth)}`;
      i += 1;
    } else if (c === ":") {
      out += ": ";
      i += 1;
    } else if (/\s/.test(c)) {
      i += 1;
    } else {
      // A number or a literal runs to the next structural character or space.
      let j = i;
      while (j < text.length && !/[\s,:\]}]/.test(text[j]!)) j += 1;
      out += text.slice(i, j);
      i = j;
    }
  }
  return out;
}

/** The first `lines` lines of a text, for a card's snippet. */
export function firstLines(text: string, lines: number): string {
  return text.split("\n").slice(0, lines).join("\n");
}
