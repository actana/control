import { describe, expect, it } from "vitest";
import {
  formatTaskTimeLimit,
  formatTaskTimeLimitAdjective,
  formatTaskTimeLimitChangeComment,
  formatTaskTimeoutReason,
  isValidTaskTimeoutMinutes,
  TASK_TIME_LIMIT_PRESETS,
} from "../tasks";

describe("formatTaskTimeLimit", () => {
  it.each([
    [null, "No limit"],
    [1, "1 min"],
    [30, "30 min"],
    [59, "59 min"],
    [90, "90 min"],
    [60, "1 hour"],
    [240, "4 hours"],
    [480, "8 hours"],
    [1440, "24 hours"],
    [2880, "2 days"],
    [43200, "30 days"],
    [1500, "25 hours"],
  ])("%j -> %s", (m, text) => {
    expect(formatTaskTimeLimit(m)).toBe(text);
  });

  it("labels each preset", () => {
    expect(TASK_TIME_LIMIT_PRESETS.map(formatTaskTimeLimit)).toEqual(["30 min", "1 hour", "4 hours", "8 hours", "24 hours"]);
  });
});

describe("formatTaskTimeLimitAdjective", () => {
  it.each([
    [1, "1-minute"],
    [30, "30-minute"],
    [90, "90-minute"],
    [60, "1-hour"],
    [240, "4-hour"],
    [2880, "2-day"],
  ])("%j -> %s", (m, text) => {
    expect(formatTaskTimeLimitAdjective(m)).toBe(text);
  });
});

describe("formatTaskTimeoutReason", () => {
  it("names the limit, how to change it, and keeps the phrase the dispatcher looks for", () => {
    const text = formatTaskTimeoutReason(240);
    expect(text).toBe(
      "The agent wrote no result within its 4-hour time limit. To give it longer, change the time limit or set No limit, then run it again.",
    );
    expect(text).toContain("wrote no result within");
  });
});

describe("formatTaskTimeLimitChangeComment", () => {
  it("reads from and to", () => {
    expect(formatTaskTimeLimitChangeComment({ from: 60, to: null, changedBy: "Mehdi" })).toBe(
      "Time limit changed from 1 hour to No limit by Mehdi.",
    );
  });
});

describe("isValidTaskTimeoutMinutes", () => {
  it.each([null, 1, 60, 43200])("accepts %j", (v) => expect(isValidTaskTimeoutMinutes(v)).toBe(true));
  it.each([0, 43201, -5, 1.5, "60", undefined, Number.NaN, Infinity, {}])("refuses %j", (v) =>
    expect(isValidTaskTimeoutMinutes(v)).toBe(false),
  );
});
