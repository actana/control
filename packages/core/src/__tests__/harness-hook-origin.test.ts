import { describe, expect, it } from "vitest";
import {
  MAX_HOOK_PROCESS_HOPS,
  parseProcStat,
  parsePsTable,
  parseReportedPid,
  verifyHookProcess,
  type ProcessEntry,
} from "../harness-hook-origin";

// The decision behind issue 460: is the process that ran a hook the harness
// this Core spawned for the Session, or something started underneath it? The
// tables below are the shapes measured on a real Core: Claude Code 2.1.295
// (one native binary, Debian /bin/sh = dash), a `claude -p` started from
// inside a Bash tool, and `@openai/codex@0.162.0` installed by npm, whose
// `bin/codex.js` node wrapper (comm `MainThread` on node 24) spawns the native
// `codex` and stays alive as its parent.

/** What node-pty spawned: the root of the Session's process tree. */
const ROOT = 1000;

function table(entries: Record<number, ProcessEntry>) {
  return (pid: number) => entries[pid] ?? null;
}

const owned = (harnessPid: number) => ({ verdict: "owned", harnessPid });
const foreign = (reason: string) => ({ verdict: "foreign", reason });

describe("verifyHookProcess (issue 460) — the Session's own harness", () => {
  it("owns a hook whose shell is a direct child of the root", () => {
    // /bin/sh is bash: `sh -c "sh -c '…'"` execs, and $PPID is the harness.
    expect(verifyHookProcess(ROOT, ROOT, null, table({}))).toEqual(owned(ROOT));
  });

  it("owns a hook one shell below the root", () => {
    // /bin/sh is dash: the outer shell forks, $PPID is that shell.
    const t = table({ 1001: { comm: "sh", ppid: ROOT } });
    expect(verifyHookProcess(1001, ROOT, null, t)).toEqual(owned(ROOT));
  });

  it("owns a hook under any chain of shells, however they are spelled", () => {
    const t = table({
      1001: { comm: "bash", ppid: ROOT },
      1002: { comm: "dash", ppid: 1001 },
      1003: { comm: "/bin/zsh", ppid: 1002 },
      1004: { comm: "sh", ppid: 1003 },
    });
    expect(verifyHookProcess(1004, ROOT, null, t)).toEqual(owned(ROOT));
  });

  it("owns the Codex chain: the hook's program is the native child of the npm wrapper", () => {
    // sh → codex(native) → node(bin/codex.js, spawned). The wrapper is a
    // program above the harness, and the climb crosses programs freely.
    const t = table({
      [ROOT]: { comm: "MainThread", ppid: 9 },
      1101: { comm: "codex", ppid: ROOT },
      1102: { comm: "sh", ppid: 1101 },
    });
    expect(verifyHookProcess(1102, ROOT, null, t)).toEqual(owned(1101));
    // A hook runner that execs: $PPID is the native codex itself.
    expect(verifyHookProcess(1101, ROOT, null, t)).toEqual(owned(1101));
    // And the same answer once the native codex is the bound harness.
    expect(verifyHookProcess(1102, ROOT, 1101, t)).toEqual(owned(1101));
  });

  it("owns a harness under any depth of launcher wrappers, by shape and never by name", () => {
    const t = table({
      1201: { comm: "whatever-launcher", ppid: ROOT },
      1202: { comm: "another", ppid: 1201 },
      1203: { comm: "harness", ppid: 1202 },
      1204: { comm: "sh", ppid: 1203 },
    });
    expect(verifyHookProcess(1204, ROOT, null, t)).toEqual(owned(1203));
  });

  it("stays owned when the bound harness has gone and a program above it posts", () => {
    const t = table({ 1301: { comm: "codex", ppid: ROOT } });
    expect(verifyHookProcess(1301, ROOT, 7777, t)).toEqual(owned(1301));
  });
});

describe("verifyHookProcess (issue 460) — a harness nested inside the Session", () => {
  it("refuses a harness started by a shell the harness ran (a Bash tool call)", () => {
    // sh → claude(nested) → bash → claude(root): the program that ran the hook
    // sits under a shell, and a shell between a program and the root means
    // the harness started it through a tool.
    const t = table({
      1100: { comm: "bash", ppid: ROOT },
      1101: { comm: "claude", ppid: 1100 },
      1102: { comm: "sh", ppid: 1101 },
    });
    expect(verifyHookProcess(1102, ROOT, null, t)).toEqual(foreign("started-by-a-shell"));
    expect(verifyHookProcess(1102, ROOT, ROOT, t)).toEqual(foreign("started-by-a-shell"));
    // Reporting the nested harness's own pid (a plugin family) is the same answer.
    expect(verifyHookProcess(1101, ROOT, null, t)).toEqual(foreign("started-by-a-shell"));
  });

  it("refuses a harness nested under a wrapper-launched harness the same way", () => {
    // sh → codex(nested) → bash → codex(native) → node(spawned)
    const t = table({
      1101: { comm: "codex", ppid: ROOT },
      1110: { comm: "bash", ppid: 1101 },
      1111: { comm: "codex", ppid: 1110 },
      1112: { comm: "sh", ppid: 1111 },
    });
    expect(verifyHookProcess(1112, ROOT, 1101, t)).toEqual(foreign("started-by-a-shell"));
    expect(verifyHookProcess(1112, ROOT, null, t)).toEqual(foreign("started-by-a-shell"));
  });

  it("refuses a harness started by a program (an MCP server) once the Session's harness is bound", () => {
    // sh → claude(nested) → node(mcp server) → claude(root). From the tree
    // alone this is a launcher-wrapper shape; seniority tells them apart.
    const t = table({
      1400: { comm: "node", ppid: ROOT },
      1401: { comm: "claude", ppid: 1400 },
      1402: { comm: "sh", ppid: 1401 },
    });
    expect(verifyHookProcess(1402, ROOT, ROOT, t)).toEqual(foreign("nested-under-harness"));
    // Under a wrapper-launched harness too.
    const u = table({
      1101: { comm: "codex", ppid: ROOT },
      1410: { comm: "node", ppid: 1101 },
      1411: { comm: "codex", ppid: 1410 },
      1412: { comm: "sh", ppid: 1411 },
    });
    expect(verifyHookProcess(1412, ROOT, 1101, u)).toEqual(foreign("nested-under-harness"));
  });

  it("re-binds upward when the real harness speaks after a nested one bound first", () => {
    // The harness's own first POSTs were lost on a busy Core and the nested
    // one got in first. The real harness is an ANCESTOR of the bound program,
    // so it takes the binding over — and the nested one is then refused.
    const t = table({
      1400: { comm: "node", ppid: ROOT },
      1401: { comm: "claude", ppid: 1400 },
      1402: { comm: "sh", ppid: 1401 },
      1001: { comm: "sh", ppid: ROOT },
    });
    expect(verifyHookProcess(1402, ROOT, null, t)).toEqual(owned(1401));
    expect(verifyHookProcess(1001, ROOT, 1401, t)).toEqual(owned(ROOT));
    expect(verifyHookProcess(1402, ROOT, ROOT, t)).toEqual(foreign("nested-under-harness"));
  });

  it("refuses a program beside the bound harness, neither above nor below it", () => {
    const t = table({
      1501: { comm: "a", ppid: ROOT },
      1502: { comm: "b", ppid: ROOT },
    });
    expect(verifyHookProcess(1502, ROOT, 1501, t)).toEqual(foreign("beside-harness"));
  });

  it("refuses a hook from a process that never reaches the root", () => {
    // A headless helper the Core itself ran, the operator's claude from a
    // shell terminal, or a stranger with the env.
    const t = table({
      2001: { comm: "sh", ppid: 2000 },
      2000: { comm: "sh", ppid: 1 },
      2101: { comm: "sh", ppid: 2100 },
      2100: { comm: "claude", ppid: 2099 },
      2099: { comm: "bash", ppid: 1 },
    });
    expect(verifyHookProcess(2001, ROOT, null, t)).toEqual(foreign("not-under-root"));
    expect(verifyHookProcess(2101, ROOT, null, t)).toEqual(foreign("started-by-a-shell"));
  });

  it("refuses a hook whose process is already gone", () => {
    expect(verifyHookProcess(3000, ROOT, null, table({}))).toEqual(foreign("not-under-root"));
  });

  it("refuses a hook that reported no pid, and one with no root to hold it to", () => {
    expect(verifyHookProcess(null, ROOT, null, table({}))).toEqual(foreign("no-pid"));
    expect(verifyHookProcess(0, ROOT, null, table({}))).toEqual(foreign("no-pid"));
    expect(verifyHookProcess(-5, ROOT, null, table({}))).toEqual(foreign("no-pid"));
    expect(verifyHookProcess(ROOT, null, null, table({}))).toEqual(foreign("no-root"));
  });

  it("gives up on a chain longer than the hop bound, in either stretch", () => {
    const shells: Record<number, ProcessEntry> = {};
    let pid = 5000;
    for (let i = 0; i <= MAX_HOOK_PROCESS_HOPS; i += 1) {
      shells[pid] = { comm: "sh", ppid: pid + 1 };
      pid += 1;
    }
    shells[pid] = { comm: "sh", ppid: ROOT };
    expect(verifyHookProcess(5000, ROOT, null, table(shells))).toEqual(foreign("not-under-root"));

    const programs: Record<number, ProcessEntry> = {};
    pid = 6000;
    for (let i = 0; i <= MAX_HOOK_PROCESS_HOPS; i += 1) {
      programs[pid] = { comm: "prog", ppid: pid + 1 };
      pid += 1;
    }
    programs[pid] = { comm: "prog", ppid: ROOT };
    expect(verifyHookProcess(6000, ROOT, null, table(programs))).toEqual(foreign("not-under-root"));
  });

  it("does not spin on a process table that loops", () => {
    const t = table({ 1: { comm: "sh", ppid: 2 }, 2: { comm: "sh", ppid: 3 }, 3: { comm: "sh", ppid: 2 } });
    expect(verifyHookProcess(3, ROOT, null, t)).toEqual(foreign("not-under-root"));
    const u = table({ 11: { comm: "p", ppid: 12 }, 12: { comm: "p", ppid: 13 }, 13: { comm: "p", ppid: 12 } });
    expect(verifyHookProcess(11, ROOT, null, u)).toEqual(foreign("not-under-root"));
  });

  it("is unverifiable, never foreign, where the platform cannot answer", () => {
    expect(verifyHookProcess(1001, ROOT, null, () => undefined)).toEqual({ verdict: "unverifiable" });
    // Equality needs no table at all.
    expect(verifyHookProcess(ROOT, ROOT, null, () => undefined)).toEqual(owned(ROOT));
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

describe("parsePsTable", () => {
  it("indexes `ps -axo pid=,ppid=,comm=` output by pid, keyed on the executable's basename", () => {
    const t = parsePsTable(
      [
        "    1     0 /sbin/launchd",
        " 4242     1 /Users/me/.local/bin/claude",
        " 4300  4242 /bin/sh",
        " 4301  4300 sh",
        "garbage line",
        "",
      ].join("\n"),
    );
    expect(t.get(4242)).toEqual({ comm: "claude", ppid: 1 });
    expect(t.get(4300)).toEqual({ comm: "sh", ppid: 4242 });
    expect(t.get(4301)).toEqual({ comm: "sh", ppid: 4300 });
    expect(t.size).toBe(4);
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
