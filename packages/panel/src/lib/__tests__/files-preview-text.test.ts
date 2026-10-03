import { describe, expect, it } from "vitest";
import { firstLines, prettyJson } from "../files-preview-text";

describe("JSON previews", () => {
  it("prints a whole JSON file with two-space indents", () => {
    expect(prettyJson('{"surface/bg":"#0b1220","brand":{"accent":"#38bdf8"}}', false)).toBe(
      '{\n  "surface/bg": "#0b1220",\n  "brand": {\n    "accent": "#38bdf8"\n  }\n}',
    );
  });

  it("never changes a value: big integers, trailing zeros, exponents, repeated keys and escapes come out as written", () => {
    const text = '{"id":12345678901234567890,"price":1.50,"tiny":1E-7,"neg":-0,"k":1,"k":2,"s":"a\\u00e9\\n\\"q\\" {x}, [y]: z"}';
    const out = prettyJson(text, false);
    expect(out).toContain('"id": 12345678901234567890');
    expect(out).toContain('"price": 1.50');
    expect(out).toContain('"tiny": 1E-7');
    expect(out).toContain('"neg": -0');
    expect(out).toContain('"k": 1,\n  "k": 2');
    expect(out).toContain('"s": "a\\u00e9\\n\\"q\\" {x}, [y]: z"');
    // Only whitespace between tokens differs: strip it from both and the two are the same text.
    const strip = (t: string) => t.replace(/("(?:\\.|[^"\\])*")|\s+/g, (_m, str) => str ?? "");
    expect(strip(out)).toBe(strip(text));
  });

  it("keeps empty objects and arrays on one line and indents nesting and arrays", () => {
    expect(prettyJson('{"a":{},"b":[],"c":[1,[2,{"d":null}]],"e":true}', false)).toBe(
      '{\n  "a": {},\n  "b": [],\n  "c": [\n    1,\n    [\n      2,\n      {\n        "d": null\n      }\n    ]\n  ],\n  "e": true\n}',
    );
  });

  it("re-indents text that already has its own whitespace, and handles a scalar file", () => {
    expect(prettyJson('  {\n\t"a" :   1 ,\r\n "b":[ ] }  ', false)).toBe('{\n  "a": 1,\n  "b": []\n}');
    expect(prettyJson("42", false)).toBe("42");
    expect(prettyJson('"x"', false)).toBe('"x"');
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
