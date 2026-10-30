import { describe, expect, it } from "vitest";
import { applyCtrl, keySequence } from "../terminal-keys";

describe("terminal keys", () => {
  it("keySequence maps Esc, Tab and the arrows", () => {
    expect(keySequence("esc")).toBe("\x1b");
    expect(keySequence("tab")).toBe("\t");
    expect(keySequence("up")).toBe("\x1b[A");
    expect(keySequence("down")).toBe("\x1b[B");
    expect(keySequence("right")).toBe("\x1b[C");
    expect(keySequence("left")).toBe("\x1b[D");
  });
  it("keySequence uses SS3 arrows in application cursor mode", () => {
    expect(keySequence("up", { applicationCursor: true })).toBe("\x1bOA");
  });
  it("applyCtrl turns a letter into its control character", () => {
    expect(applyCtrl("c")).toBe("\x03");
    expect(applyCtrl("C")).toBe("\x03");
    expect(applyCtrl("[")).toBe("\x1b");
    expect(applyCtrl("@")).toBe("\x00");
    expect(applyCtrl(" ")).toBe("\x00");
  });
  it("applyCtrl leaves multi-char data unchanged", () => {
    expect(applyCtrl("ab")).toBe("ab");
    expect(applyCtrl("\x1b[A")).toBe("\x1b[A");
    expect(applyCtrl("1")).toBe("1");
  });
});
