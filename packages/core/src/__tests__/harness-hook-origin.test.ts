import { describe, expect, it } from "vitest";
import {
  MAX_HOOK_PROCESS_HOPS,
  harnessLauncherShape,
  parseProcStat,
  parseReportedPid,
  verifyHookProcess,
  type ProcessEntry,
  type SpawnedProcess,
} from "../harness-hook-origin";

// The decision behind issue 460: is the process that ran a hook the harness
// this Core spawned for the Session, or something started underneath it? The
// tables below are the shapes measured on real Cores: Claude Code 2.1.295 on
// Debian (/bin/sh = dash) with a `claude -p` started from inside a Bash tool,
// and Codex 0.162.0 installed by npm, whose `bin/codex.js` wrapper runs the
// native binary as its child (node wrapper pid 101931 → codex pid 101939).

const HARNESS_PID = 1000;
/** A spawn whose process is the harness itself: Claude Code, Cursor, OpenCode, Pi, a native Codex. */
const HARNESS: SpawnedProcess = { pid: HARNESS_PID, launcher: "harness" };
/** A spawn whose process is the npm `codex` wrapper, the harness one below it. */
const WRAPPER: SpawnedProcess = { pid: HARNESS_PID, launcher: "wrapper" };

function table(entries: Record<number, ProcessEntry>) {
  return (pid: number) => entries[pid] ?? null;
}

describe("verifyHookProcess (issue 460)", () => {
  it("owns a hook whose shell is a direct child of the spawned process", () => {
    // /bin/sh is bash: `sh -c "sh -c '…'"` execs, and $PPID is the harness.
    expect(verifyHookProcess(HARNESS_PID, HARNESS, table({}))).toBe("owned");
  });

  it("owns a hook one shell below the spawned process", () => {
    // /bin/sh is dash: the outer shell forks, $PPID is that shell.
    const t = table({ 1001: { comm: "sh", ppid: HARNESS_PID } });
    expect(verifyHookProcess(1001, HARNESS, t)).toBe("owned");
  });

  it("owns a hook under any chain of shells, however they are spelled", () => {
    const t = table({
      1001: { comm: "bash", ppid: HARNESS_PID },
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
      1100: { comm: "bash", ppid: HARNESS_PID },
      1101: { comm: "claude", ppid: 1100 },
      1102: { comm: "sh", ppid: 1101 },
    });
    expect(verifyHookProcess(1102, HARNESS, t)).toBe("foreign");
    // Reporting the nested harness's own pid (a plugin family) is the same answer.
    expect(verifyHookProcess(1101, HARNESS, t)).toBe("foreign");
  });

  it("refuses a non-shell straight under a spawn that is the harness itself", () => {
    // A program the harness started without a shell: nothing the harness runs
    // this way is its hook, and no family whose spawn is the harness has a
    // wrapper above it to make an exception for.
    const t = table({
      1101: { comm: "node", ppid: HARNESS_PID },
      1102: { comm: "sh", ppid: 1101 },
    });
    expect(verifyHookProcess(1102, HARNESS, t)).toBe("foreign");
  });

  describe("a Codex spawned through the npm wrapper", () => {
    // What node-pty spawned is `node bin/codex.js`; the harness that runs the
    // hooks is the native `codex` it spawned, one level below.
    const CODEX = 1200;

    it("owns the wrapper chain: sh → codex(native) → node(spawned)", () => {
      // /bin/sh is bash: the hook's shell is a direct child of the native codex.
      const t = table({
        [CODEX]: { comm: "codex", ppid: HARNESS_PID },
        1201: { comm: "sh", ppid: CODEX },
      });
      expect(verifyHookProcess(1201, WRAPPER, t)).toBe("owned");
    });

    it("owns it one shell deeper, where /bin/sh forks: sh → sh → codex → node", () => {
      const t = table({
        [CODEX]: { comm: "codex", ppid: HARNESS_PID },
        1201: { comm: "sh", ppid: CODEX },
        1202: { comm: "sh", ppid: 1201 },
      });
      expect(verifyHookProcess(1202, WRAPPER, t)).toBe("owned");
    });

    it("does not match the wrapper's child by name: node 24 reports its own thread as MainThread", () => {
      const t = table({
        [CODEX]: { comm: "MainThread", ppid: HARNESS_PID },
        1201: { comm: "sh", ppid: CODEX },
      });
      expect(verifyHookProcess(1201, WRAPPER, t)).toBe("owned");
    });

    it("still refuses a harness nested under a Bash tool inside the Codex Session", () => {
      // sh → claude(nested) → bash → codex(native) → node(spawned): the nested
      // claude is a non-shell whose parent is the native codex, not the wrapper.
      const t = table({
        [CODEX]: { comm: "codex", ppid: HARNESS_PID },
        1210: { comm: "bash", ppid: CODEX },
        1211: { comm: "claude", ppid: 1210 },
        1212: { comm: "sh", ppid: 1211 },
      });
      expect(verifyHookProcess(1212, WRAPPER, t)).toBe("foreign");
      expect(verifyHookProcess(1211, WRAPPER, t)).toBe("foreign");
    });

    it("still refuses a harness the native codex started without a shell", () => {
      // sh → claude(nested) → codex(native) → node(spawned): two non-shells
      // deep. The exception is one process wide, and it is the wrapper's child.
      const t = table({
        [CODEX]: { comm: "codex", ppid: HARNESS_PID },
        1221: { comm: "claude", ppid: CODEX },
        1222: { comm: "sh", ppid: 1221 },
      });
      expect(verifyHookProcess(1222, WRAPPER, t)).toBe("foreign");
    });

    it("refuses the same wrapper chain for a spawn that is the harness itself", () => {
      // The exception is a fact of the spawn, not of the family: a native
      // Codex spawned directly gets no non-shell crossing at all.
      const t = table({
        [CODEX]: { comm: "codex", ppid: HARNESS_PID },
        1201: { comm: "sh", ppid: CODEX },
      });
      expect(verifyHookProcess(1201, HARNESS, t)).toBe("foreign");
    });

    it("keeps owning a hook that reaches the wrapper pid through shells only", () => {
      // A launcher that `exec`s the binary keeps the pid; recording it as a
      // wrapper widens nothing for the chain that was already owned.
      const t = table({ 1230: { comm: "sh", ppid: HARNESS_PID } });
      expect(verifyHookProcess(HARNESS_PID, WRAPPER, t)).toBe("owned");
      expect(verifyHookProcess(1230, WRAPPER, t)).toBe("owned");
    });
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

  it("refuses a hook that reported no pid, and one with no spawned process to hold it to", () => {
    expect(verifyHookProcess(null, HARNESS, table({}))).toBe("foreign");
    expect(verifyHookProcess(HARNESS_PID, null, table({}))).toBe("foreign");
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
    entries[pid] = { comm: "sh", ppid: HARNESS_PID };
    expect(verifyHookProcess(5000, HARNESS, table(entries))).toBe("foreign");
  });

  it("does not spin on a process table that loops", () => {
    const t = table({ 1: { comm: "sh", ppid: 2 }, 2: { comm: "sh", ppid: 3 }, 3: { comm: "sh", ppid: 2 } });
    expect(verifyHookProcess(3, HARNESS, t)).toBe("foreign");
  });

  it("is unverifiable, never foreign, where the platform cannot answer", () => {
    expect(verifyHookProcess(1001, HARNESS, () => undefined)).toBe("unverifiable");
    // Equality needs no table at all.
    expect(verifyHookProcess(HARNESS_PID, HARNESS, () => undefined)).toBe("owned");
  });
});

describe("harnessLauncherShape: what the Core is about to spawn", () => {
  it("is a wrapper for Codex when PATH resolved to a script — the npm bin/codex.js", () => {
    expect(harnessLauncherShape("codex", true)).toBe("wrapper");
  });

  it("is the harness for a Codex that is the native binary (Homebrew, Codex.app)", () => {
    expect(harnessLauncherShape("codex", false)).toBe("harness");
  });

  it("is the harness for every other family, script launcher or not", () => {
    // Cursor's launcher is a shell script that execs node; Pi is a node
    // script that is the harness; Claude Code and OpenCode are binaries.
    for (const agent of ["claude-code", "cursor-cli", "opencode", "pi"]) {
      expect(harnessLauncherShape(agent, true)).toBe("harness");
      expect(harnessLauncherShape(agent, false)).toBe("harness");
    }
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
