import { describe, expect, it } from "vitest";
import {
  MAX_HOOK_PROCESS_HOPS,
  parseProcStat,
  parseReportedPid,
  verifyHookProcess,
  type ProcessEntry,
} from "../harness-hook-origin";

// The decision behind issue 460: is the process that ran a hook the harness
// this Core spawned for the Session, or something started underneath it? The
// tables below are the shapes measured on a real Core (Claude Code 2.1.295,
// Debian /bin/sh = dash, and a `claude -p` started from inside a Bash tool).

const HARNESS = 1000;

function table(entries: Record<number, ProcessEntry>) {
  return (pid: number) => entries[pid] ?? null;
}

describe("verifyHookProcess (issue 460)", () => {
  it("owns a hook whose shell is a direct child of the spawned process", () => {
    // /bin/sh is bash: `sh -c "sh -c '…'"` execs, and $PPID is the harness.
    expect(verifyHookProcess(HARNESS, HARNESS, table({}))).toBe("owned");
  });

  it("owns a hook one shell below the spawned process", () => {
    // /bin/sh is dash: the outer shell forks, $PPID is that shell.
    const t = table({ 1001: { comm: "sh", ppid: HARNESS } });
    expect(verifyHookProcess(1001, HARNESS, t)).toBe("owned");
  });

  it("owns a hook under any chain of shells, however they are spelled", () => {
    const t = table({
      1001: { comm: "bash", ppid: HARNESS },
      1002: { comm: "dash", ppid: 1001 },
      1003: { comm: "/bin/zsh", ppid: 1002 },
      1004: { comm: "sh", ppid: 1003 },
    });
    expect(verifyHookProcess(1004, HARNESS, t)).toBe("owned");
  });

  it("refuses a hook from a harness nested inside the Session", () => {
    // sh → claude(nested) → bash → claude(spawned): the nested harness is a
    // process that is not a shell, and that is where the climb stops.
    const t = table({
      1100: { comm: "bash", ppid: HARNESS },
      1101: { comm: "claude", ppid: 1100 },
      1102: { comm: "sh", ppid: 1101 },
    });
    expect(verifyHookProcess(1102, HARNESS, t)).toBe("foreign");
    // Reporting the nested harness's own pid (a plugin family) is the same answer.
    expect(verifyHookProcess(1101, HARNESS, t)).toBe("foreign");
  });

  it("refuses a nested harness even when bash execs it straight under the spawned one", () => {
    const t = table({
      1101: { comm: "node", ppid: HARNESS },
      1102: { comm: "sh", ppid: 1101 },
    });
    expect(verifyHookProcess(1102, HARNESS, t)).toBe("foreign");
  });

  it("refuses a hook from a process that never reaches the spawned one", () => {
    // A headless helper the Core itself ran, or a stranger with the env.
    const t = table({
      2001: { comm: "sh", ppid: 2000 },
      2000: { comm: "sh", ppid: 1 },
    });
    expect(verifyHookProcess(2001, HARNESS, t)).toBe("foreign");
  });

  it("refuses a hook whose process is already gone", () => {
    expect(verifyHookProcess(3000, HARNESS, table({}))).toBe("foreign");
  });

  it("refuses a hook that reported no pid, and one with no spawned pid to hold it to", () => {
    expect(verifyHookProcess(null, HARNESS, table({}))).toBe("foreign");
    expect(verifyHookProcess(HARNESS, null, table({}))).toBe("foreign");
    expect(verifyHookProcess(0, HARNESS, table({}))).toBe("foreign");
    expect(verifyHookProcess(-5, HARNESS, table({}))).toBe("foreign");
  });

  it("gives up on a chain longer than the hop bound", () => {
    const entries: Record<number, ProcessEntry> = {};
    let pid = 5000;
    for (let i = 0; i <= MAX_HOOK_PROCESS_HOPS; i += 1) {
      entries[pid] = { comm: "sh", ppid: pid + 1 };
      pid += 1;
    }
    entries[pid] = { comm: "sh", ppid: HARNESS };
    expect(verifyHookProcess(5000, HARNESS, table(entries))).toBe("foreign");
  });

  it("does not spin on a process table that loops", () => {
    const t = table({ 1: { comm: "sh", ppid: 2 }, 2: { comm: "sh", ppid: 3 }, 3: { comm: "sh", ppid: 2 } });
    expect(verifyHookProcess(3, HARNESS, t)).toBe("foreign");
  });

  it("is unverifiable, never foreign, where the platform cannot answer", () => {
    expect(verifyHookProcess(1001, HARNESS, () => undefined)).toBe("unverifiable");
    // Equality needs no table at all.
    expect(verifyHookProcess(HARNESS, HARNESS, () => undefined)).toBe("owned");
  });
});

describe("parseProcStat", () => {
  it("reads the name and parent from a /proc stat line", () => {
    expect(parseProcStat("157234 (bash) S 150650 157234 157234 0 -1 4194560 261")).toEqual({
      comm: "bash",
      ppid: 150650,
    });
  });

  it("is not fooled by a name with spaces or parentheses in it", () => {
    expect(parseProcStat("7 (my (odd) name) S 3 7 7 0")).toEqual({ comm: "my (odd) name", ppid: 3 });
  });

  it("answers null for a line it cannot read", () => {
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("7 (sh)")).toBeNull();
  });
});

describe("parseReportedPid", () => {
  it("takes a positive integer and nothing else", () => {
    expect(parseReportedPid("4242")).toBe(4242);
    expect(parseReportedPid(null)).toBeNull();
    expect(parseReportedPid("")).toBeNull();
    expect(parseReportedPid("0")).toBeNull();
    expect(parseReportedPid("-1")).toBeNull();
    expect(parseReportedPid("12abc")).toBeNull();
    expect(parseReportedPid("$PPID")).toBeNull();
  });
});
