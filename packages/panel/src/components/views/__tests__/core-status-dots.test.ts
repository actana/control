import { describe, expect, it } from "vitest";
import { getCoreStatusDots } from "../core-status-dots";

describe("getCoreStatusDots", () => {
  it("fills the four-dot list with running sessions before finished sessions", () => {
    expect(getCoreStatusDots({ running: 2, finished: 4 })).toEqual([
      "running",
      "running",
      "finished",
      "finished",
    ]);
  });

  it("reserves all slots for running sessions when there are more than four", () => {
    expect(getCoreStatusDots({ running: 5, finished: 3 })).toEqual([
      "running",
      "running",
      "running",
      "running",
    ]);
  });

  it("shows finished sessions when there are no running sessions", () => {
    expect(getCoreStatusDots({ running: 0, finished: 6 })).toEqual([
      "finished",
      "finished",
      "finished",
      "finished",
    ]);
  });
});
