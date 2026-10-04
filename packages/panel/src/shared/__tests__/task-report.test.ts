import { describe, expect, it } from "vitest";
import { REPORT_END_MARKER as CORE_END_MARKER } from "@actana/core/prompt-standard-block";
import {
  REPORT_END_MARKER,
  archivedTaskName,
  classifyTaskEntry,
  reportIsComplete,
  reportWithoutMarker,
  statusForResult,
  taskAttemptLogPath,
  taskFolder,
  taskResultPath,
} from "../task-report";

/**
 * The Task report contract is client PR 41's (`packages/cli/src/core/session-report.ts`, merge `ef8b3ff`):
 * these are its paths and names, pinned as literals so that a change here fails a test.
 */
describe("the report contract (client PR 41)", () => {
  it("uses the Core's end marker", () => {
    expect(REPORT_END_MARKER).toBe("ACT-REPORT-END");
    expect(REPORT_END_MARKER).toBe(CORE_END_MARKER);
  });

  it("puts a Task's results in tasks/<id>/ under the names success.md, fail.md and partial-<n>.md", () => {
    expect(taskFolder("task_1")).toBe("tasks/task_1/");
    expect(taskResultPath("task_1", { kind: "success" })).toBe("tasks/task_1/success.md");
    expect(taskResultPath("task_1", { kind: "fail" })).toBe("tasks/task_1/fail.md");
    expect(taskResultPath("task_1", { kind: "partial", n: 2 })).toBe("tasks/task_1/partial-2.md");
    expect(taskAttemptLogPath("task_1", 3)).toBe("tasks/task_1/attempt-3.log");
  });

  it("renames an older result to attempt-<n>-<name>", () => {
    expect(archivedTaskName(1, "success.md")).toBe("attempt-1-success.md");
    expect(archivedTaskName(2, "partial-1.md")).toBe("attempt-2-partial-1.md");
  });

  it.each([
    ["success.md", { kind: "result", result: { kind: "success" } }],
    ["fail.md", { kind: "result", result: { kind: "fail" } }],
    ["partial-1.md", { kind: "result", result: { kind: "partial", n: 1 } }],
    ["partial-12.md", { kind: "result", result: { kind: "partial", n: 12 } }],
    ["attempt-2.log", { kind: "log", attempt: 2 }],
    ["attempt-1-success.md", { kind: "archived", attempt: 1, result: { kind: "success" } }],
    ["attempt-3-partial-2.md", { kind: "archived", attempt: 3, result: { kind: "partial", n: 2 } }],
    ["partial-0.md", { kind: "other" }],
    ["partial-.md", { kind: "other" }],
    ["success.md.bak", { kind: "other" }],
    ["notes.md", { kind: "other" }],
  ])("tells %s apart", (name, entry) => {
    expect(classifyTaskEntry(name)).toEqual(entry);
  });

  it("finishes a report only on an end marker that is the last non-blank line", () => {
    expect(reportIsComplete("done\n\nACT-REPORT-END\n")).toBe(true);
    expect(reportIsComplete("done\r\nACT-REPORT-END  \r\n\r\n")).toBe(true);
    expect(reportIsComplete("ACT-REPORT-END\nmore")).toBe(false);
    expect(reportIsComplete("done ACT-REPORT-END")).toBe(false);
    expect(reportIsComplete("")).toBe(false);
  });

  it("gives the report without its closing marker line", () => {
    expect(reportWithoutMarker("# Done\n\nIt works.\n\nACT-REPORT-END\n")).toBe("# Done\n\nIt works.");
    expect(reportWithoutMarker("no marker here")).toBe("no marker here");
  });

  it("maps each result to the Task status it moves to", () => {
    expect(statusForResult({ kind: "success" })).toBe("done");
    expect(statusForResult({ kind: "fail" })).toBe("failed");
    expect(statusForResult({ kind: "partial", n: 4 })).toBe("partial");
  });
});
