// The Task half of the report contract (actana/client#8, merged as client PR 41), as pure functions:
// where a Task's result files live in the Core's Shared folder, which file names are results, and
// when a report is finished.
//
// **These are client PR 41's, word for word** (`packages/cli/src/core/session-report.ts`, merge commit
// `ef8b3ff`): the same paths, the same names, the same end marker. They are copied rather than imported
// because the CLI is not a dependency of the Panel and the issue forbids a new one;
// `__tests__/task-report.test.ts` pins every string, so a drift on either side fails a test here.
//
//   a Task                 tasks/<task-id>/success.md | fail.md | partial-<n>.md, and attempt-<n>.log
//   a re-run               the older results are renamed to attempt-<n>-<name>
//
// Paths are relative to the Shared folder, which is what `CoreShared` takes. A harness is told the same
// file from its home as `~/shared/…`.

/** The fixed last line a report ends with. A watcher settles on it. */
export const REPORT_END_MARKER = "ACT-REPORT-END";

/** A Task's folder, relative to the Shared folder. */
export function taskFolder(taskId: string): string {
  return `tasks/${taskId}/`;
}

export type TaskResult = { kind: "success" } | { kind: "fail" } | { kind: "partial"; n: number };

/** The file a Task's result is written to: `success.md`, `fail.md` or `partial-<n>.md`. */
export function taskResultPath(taskId: string, result: TaskResult): string {
  const name =
    result.kind === "partial" ? `partial-${result.n}.md` : result.kind === "success" ? "success.md" : "fail.md";
  return `tasks/${taskId}/${name}`;
}

/** The log of one attempt of a Task. */
export function taskAttemptLogPath(taskId: string, attempt: number): string {
  return `tasks/${taskId}/attempt-${attempt}.log`;
}

/** What an older result is renamed to when a Task runs again: `success.md` becomes `attempt-1-success.md`. */
export function archivedTaskName(attempt: number, name: string): string {
  return `attempt-${attempt}-${name}`;
}

/** A Task folder entry, told apart: a current result, an archived one, an attempt log, or none of these. */
export type TaskEntry =
  | { kind: "result"; result: TaskResult }
  | { kind: "archived"; attempt: number; result: TaskResult }
  | { kind: "log"; attempt: number }
  | { kind: "other" };

function taskResultOfName(name: string): TaskResult | null {
  if (name === "success.md") return { kind: "success" };
  if (name === "fail.md") return { kind: "fail" };
  const partial = /^partial-([1-9][0-9]*)\.md$/.exec(name);
  return partial === null ? null : { kind: "partial", n: Number(partial[1]) };
}

export function classifyTaskEntry(name: string): TaskEntry {
  const current = taskResultOfName(name);
  if (current !== null) return { kind: "result", result: current };
  const log = /^attempt-([1-9][0-9]*)\.log$/.exec(name);
  if (log !== null) return { kind: "log", attempt: Number(log[1]) };
  const archived = /^attempt-([1-9][0-9]*)-(.+)$/.exec(name);
  if (archived !== null) {
    const result = taskResultOfName(archived[2]!);
    if (result !== null) return { kind: "archived", attempt: Number(archived[1]), result };
  }
  return { kind: "other" };
}

/** Is this the body of a finished report: its last non-blank line exactly the end marker? */
export function reportIsComplete(body: string): boolean {
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.replace(/\r$/, "").trimEnd();
    if (line === "") continue;
    return line === REPORT_END_MARKER;
  }
  return false;
}

/** The report as a reader wants it: the body without its closing end-marker line, which is protocol, not prose. */
export function reportWithoutMarker(body: string): string {
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]!.replace(/\r$/, "").trimEnd() === "") continue;
    if (lines[i]!.replace(/\r$/, "").trimEnd() === REPORT_END_MARKER) lines.splice(i, 1);
    break;
  }
  return lines.join("\n").trim();
}

/** The Task status a result file moves the Task to (ADR 0041; the legal moves are `TASK_TRANSITIONS`). */
export function statusForResult(result: TaskResult): "done" | "failed" | "partial" {
  return result.kind === "success" ? "done" : result.kind === "fail" ? "failed" : "partial";
}
