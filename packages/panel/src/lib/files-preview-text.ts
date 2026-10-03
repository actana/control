/**
 * A JSON file as an operator reads it: parsed and printed with two-space indents, when the whole file is there and is
 * JSON. A cut-off preview or a file that does not parse is shown as it is: pretty-printing a prefix would invent a
 * structure the file does not have.
 */
export function prettyJson(text: string, truncated: boolean): string {
  if (truncated) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** The first `lines` lines of a text, for a card's snippet. */
export function firstLines(text: string, lines: number): string {
  return text.split("\n").slice(0, lines).join("\n");
}
