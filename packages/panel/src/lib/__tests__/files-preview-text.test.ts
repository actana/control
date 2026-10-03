import { describe, expect, it } from "vitest";
import { firstLines, prettyJson } from "../files-preview-text";

describe("JSON previews", () => {
  it("prints a whole JSON file with two-space indents", () => {
    expect(prettyJson('{"surface/bg":"#0b1220","brand":{"accent":"#38bdf8"}}', false)).toBe(
      '{\n  "surface/bg": "#0b1220",\n  "brand": {\n    "accent": "#38bdf8"\n  }\n}',
    );
  });

  it("leaves a cut-off file as it is: a prefix has no structure to print", () => {
    expect(prettyJson('{"a":1,"b":', true)).toBe('{"a":1,"b":');
  });

  it("leaves a file that is not JSON as it is", () => {
    expect(prettyJson("{not json", false)).toBe("{not json");
  });
});

describe("firstLines", () => {
  it("keeps the top of a text", () => {
    expect(firstLines("a\nb\nc\nd", 2)).toBe("a\nb");
    expect(firstLines("a", 5)).toBe("a");
  });
});
