import { describe, it, expect } from "vitest";
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_GROUP_SIZE,
  PAIRING_CODE_LENGTH,
  formatPairingCode,
  generatePairingCode,
  normalisePairingCode,
  type CsprngPort,
} from "../pairing-code";

// The pairing code is the one thing a human carries between the Core and the
// client (#280): eight characters from an alphabet with no ambiguous glyphs,
// drawn from a CSPRNG with no modulo bias, printed `XXXX-XXXX`. The port makes
// the draw assertable without stubbing `node:crypto`.

/** A port that hands out a scripted byte sequence, one batch at a time. */
function scriptedCsprng(bytes: number[]): CsprngPort & { calls: number[] } {
  const queue = [...bytes];
  const calls: number[] = [];
  return {
    calls,
    bytes(n) {
      calls.push(n);
      return Uint8Array.from(queue.splice(0, n));
    },
  };
}

describe("pairing code", () => {
  describe("alphabet", () => {
    it("excludes the five ambiguous characters", () => {
      for (const ch of ["0", "O", "1", "I", "L"]) {
        expect(PAIRING_CODE_ALPHABET).not.toContain(ch);
      }
    });

    it("is 31 unique upper-case alphanumerics", () => {
      expect(PAIRING_CODE_ALPHABET).toHaveLength(31);
      expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(31);
      expect(PAIRING_CODE_ALPHABET).toMatch(/^[A-Z2-9]+$/);
    });
  });

  describe("generatePairingCode", () => {
    it("draws 8 characters grouped XXXX-XXXX", () => {
      const code = generatePairingCode();
      expect(code).toMatch(/^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/);
      expect(code.replace("-", "")).toHaveLength(PAIRING_CODE_LENGTH);
      expect(code[PAIRING_CODE_GROUP_SIZE]).toBe("-");
    });

    it("draws only from the alphabet, over many codes", () => {
      for (let i = 0; i < 200; i += 1) {
        for (const ch of generatePairingCode().replace("-", "")) {
          expect(PAIRING_CODE_ALPHABET).toContain(ch);
        }
      }
    });

    it("maps accepted bytes through the alphabet in order", () => {
      const csprng = scriptedCsprng([0, 1, 2, 30, 31, 32, 61, 62]);
      expect(generatePairingCode(csprng)).toBe("ABC9-AB9A");
    });

    it("asks for exactly the bytes it still needs", () => {
      const csprng = scriptedCsprng([0, 1, 2, 3, 4, 5, 6, 7]);
      generatePairingCode(csprng);
      expect(csprng.calls).toEqual([PAIRING_CODE_LENGTH]);
    });

    it("rejects and redraws the biased bytes instead of folding them", () => {
      // 248-255 are the byte values with no partner in the last cycle of 31.
      // Folding them with `%` would over-weight A-H; the draw must skip them
      // and come back for more bytes.
      const rejected = [248, 249, 250, 251, 252, 253, 254, 255];
      const csprng = scriptedCsprng([...rejected, 0, 1, 2, 3, 4, 5, 6, 7]);
      expect(generatePairingCode(csprng)).toBe("ABCD-EFGH");
      expect(csprng.calls).toEqual([8, 8]);
    });

    it("keeps a partially drawn code and asks only for the remainder", () => {
      const csprng = scriptedCsprng([0, 1, 2, 255, 3, 4, 5, 6, 7]);
      expect(generatePairingCode(csprng)).toBe("ABCD-EFGH");
      expect(csprng.calls).toEqual([8, 1]);
    });

    it("has no modulo bias: every accepted byte value is equally weighted", () => {
      // The whole accepted range, one character each. If the ceiling were wrong
      // — 256 instead of 248 — some characters would appear 9 times and others
      // 8, which is exactly the head start the rejection exists to remove.
      const accepted = Array.from({ length: 248 }, (_, b) => b);
      const csprng = scriptedCsprng(accepted);
      const counts = new Map<string, number>();
      for (let i = 0; i < accepted.length / PAIRING_CODE_LENGTH; i += 1) {
        for (const ch of generatePairingCode(csprng).replace("-", "")) {
          counts.set(ch, (counts.get(ch) ?? 0) + 1);
        }
      }
      expect(counts.size).toBe(PAIRING_CODE_ALPHABET.length);
      expect([...counts.values()]).toEqual(Array(PAIRING_CODE_ALPHABET.length).fill(8));
    });

    it("throws rather than spinning when the port yields nothing", () => {
      expect(() => generatePairingCode(scriptedCsprng([]))).toThrow(/no bytes/);
    });
  });

  describe("normalisePairingCode", () => {
    it("accepts the canonical form unchanged", () => {
      expect(normalisePairingCode("ABCD-EFGH")).toBe("ABCD-EFGH");
    });

    it("accepts the code without the hyphen", () => {
      expect(normalisePairingCode("ABCDEFGH")).toBe("ABCD-EFGH");
    });

    it("accepts mixed case", () => {
      expect(normalisePairingCode("aBcD-eFgH")).toBe("ABCD-EFGH");
      expect(normalisePairingCode("abcdefgh")).toBe("ABCD-EFGH");
    });

    it("accepts whitespace from a paste or a spoken grouping", () => {
      expect(normalisePairingCode("  ABCD EFGH \n")).toBe("ABCD-EFGH");
    });

    it("round-trips a generated code", () => {
      const code = generatePairingCode();
      expect(normalisePairingCode(code)).toBe(code);
      expect(normalisePairingCode(code.replace("-", "").toLowerCase())).toBe(code);
    });

    it("rejects the excluded characters rather than guessing at them", () => {
      for (const ch of ["0", "O", "1", "I", "L"]) {
        expect(normalisePairingCode(`ABCDEFG${ch}`)).toBeNull();
      }
    });

    it("rejects the wrong length and other junk", () => {
      expect(normalisePairingCode("ABCDEFG")).toBeNull();
      expect(normalisePairingCode("ABCDEFGHJ")).toBeNull();
      expect(normalisePairingCode("")).toBeNull();
      expect(normalisePairingCode("ABCD-EF!H")).toBeNull();
    });
  });

  describe("formatPairingCode", () => {
    it("groups a raw draw", () => {
      expect(formatPairingCode("ABCDEFGH")).toBe("ABCD-EFGH");
    });
  });
});
