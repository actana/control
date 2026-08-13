// The `<project>:<path>` parse, which #168 asks to have *decided and tested*
// rather than left to whatever a regex does.
//
// Two arguments in the wild contain a colon and are not remote — a Windows path
// and a filename with a colon in it — and getting either wrong sends an
// operator's files somewhere they did not ask for. So the four rules in
// `project-file-target.ts` are pinned here one at a time, and the two hazards
// get a block each.

import { describe, it, expect } from "vitest";
import {
  parseTransferTarget,
  remoteFileDestination,
  transferDirection,
} from "../project-file-target.ts";

describe("a plain path is local", () => {
  it.each([
    "dist",
    "./dist",
    "../dist",
    "/srv/work/dist",
    "~/dist",
    ".",
    "",
  ])("reads %o as this machine", (token) => {
    expect(parseTransferTarget(token)).toEqual({ kind: "local", path: token, token });
  });
});

describe("a Windows path is local, not a Project called C", () => {
  // The first hazard, and the one that would be silent: `C:\Users\me\dist` read
  // as a Project would go looking for one called `C` and fail with a confusing
  // "no such Project" — or, on a Core that happens to have one, succeed.
  it.each(["C:\\Users\\me\\dist", "c:\\dist", "D:/build", "Z:\\"])("reads %o as this machine", (token) => {
    expect(parseTransferTarget(token).kind).toBe("local");
  });

  it("still lets a one-character Project name through, because the rule needs both halves", () => {
    // A drive letter is followed by a separator. A Project-relative path is not,
    // so `x:src/main.ts` is unambiguous and stays reachable — the rule is not
    // "one letter means Windows", which would make a whole class of Project
    // names untypeable.
    expect(parseTransferTarget("x:src/main.ts")).toEqual({
      kind: "remote",
      project: "x",
      path: "src/main.ts",
      token: "x:src/main.ts",
    });
  });

  it("reads a colon inside a Windows path as part of it", () => {
    // `C:\logs\a:b` — the drive rule fires on the *first* colon, and everything
    // after it is one local path.
    expect(parseTransferTarget("C:\\logs\\a:b").kind).toBe("local");
  });
});

describe("a drive-relative Windows path — C:dist and a bare C: — is remote, and that is the trade", () => {
  // The one collision rule 3 does not close, pinned here under the spelling a
  // future reader will search for rather than by proxy through `x:src/main.ts`.
  //
  // `C:dist` is a real, if rare, Windows form: the current directory *on drive
  // C*. It has no separator after the colon, so it is indistinguishable from a
  // Project called `C` with a path called `dist`, and this parse chooses the
  // Project. That is deliberate. Closing it would mean rule 3 firing on a
  // single letter alone, which would make every one-character Project name
  // untypeable — a live cost paid by everyone, to buy off a form that is
  // ambiguous in the shell too and that `./C:dist` already escapes. `scp` makes
  // exactly this trade.
  //
  // If this ever needs to change, it changes here first: this test failing is
  // the decision being revisited, not a regression.
  it.each(["C:dist", "C:", "c:build\\out", "Z:relative/path"])(
    "reads %o as a Project, not as this machine's drive",
    (token) => {
      expect(parseTransferTarget(token).kind).toBe("remote");
    },
  );

  it("names the Project as the drive letter, so the failure that follows is legible", () => {
    // The consolation: nothing is silently copied to the wrong place. The Core
    // is asked for a Project literally called `C`, and "no such Project: C" is
    // an error an operator can act on.
    expect(parseTransferTarget("C:dist")).toEqual({
      kind: "remote",
      project: "C",
      path: "dist",
      token: "C:dist",
    });
  });

  it("is escaped the documented way, with the same ./ that escapes a colon in a filename", () => {
    expect(parseTransferTarget("./C:dist").kind).toBe("local");
    expect(parseTransferTarget(".\\C:dist").kind).toBe("local");
  });
});

describe("a file whose name contains a colon", () => {
  // The second hazard, and the one with an escape hatch rather than a rule:
  // `notes:draft.md` really is ambiguous — it is a legal Project reference and
  // a legal filename — so the parse picks the remote reading and `./` is how an
  // operator says they meant the file. That is `scp`'s answer, and it has the
  // advantage of already being in people's fingers.
  it("is remote when it is bare, which is the documented reading", () => {
    expect(parseTransferTarget("notes:draft.md")).toEqual({
      kind: "remote",
      project: "notes",
      path: "draft.md",
      token: "notes:draft.md",
    });
  });

  it.each(["./notes:draft.md", "docs/notes:draft.md", "/srv/notes:draft.md", ".\\notes:draft.md"])(
    "is local the moment a separator comes before the colon — %o",
    (token) => {
      expect(parseTransferTarget(token)).toEqual({ kind: "local", path: token, token });
    },
  );

  it("leaves a colon inside the remote path alone: only the first one is structural", () => {
    expect(parseTransferTarget("api:src/a:b.txt")).toEqual({
      kind: "remote",
      project: "api",
      path: "src/a:b.txt",
      token: "api:src/a:b.txt",
    });
  });

  it("reads a leading colon as a local name, since no Project is called the empty string", () => {
    expect(parseTransferTarget(":weird").kind).toBe("local");
  });
});

describe("a Project reference", () => {
  it("keeps an empty path, which is the Project root", () => {
    expect(parseTransferTarget("api:")).toEqual({
      kind: "remote",
      project: "api",
      path: "",
      token: "api:",
    });
  });

  it("takes a Project id as readily as a name — resolution is the Core's answer, not this one's", () => {
    expect(parseTransferTarget("p-api:src")).toMatchObject({ kind: "remote", project: "p-api" });
  });
});

describe("the direction is read off the pair", () => {
  it("is an upload when the destination carries the Project", () => {
    const direction = transferDirection("./dist", "api:build");
    expect(direction).toMatchObject({ ok: true, direction: "upload", local: "./dist" });
  });

  it("is a download when the source does", () => {
    const direction = transferDirection("api:build", "./dist");
    expect(direction).toMatchObject({ ok: true, direction: "download", local: "./dist" });
  });

  it("refuses two local sides, and says which command that is", () => {
    const direction = transferDirection("./a", "./b");
    expect(direction.ok).toBe(false);
    if (!direction.ok) expect(direction.error).toContain("one side must be <project>:<path>");
  });

  it("refuses two remote sides rather than routing a Core-to-Core copy through this laptop", () => {
    const direction = transferDirection("api:build", "web:public");
    expect(direction.ok).toBe(false);
    if (!direction.ok) expect(direction.error).toContain("A transfer has one local side");
  });
});

describe("a single file pointed at a folder takes its own name", () => {
  // Path *shaping*, not path validation: nothing here asks whether the
  // destination exists on the Core or is legal there. It decides what string to
  // send when the operator's ended in a separator, which is what `cp` does.
  it("appends the basename when the remote path ends in a slash", () => {
    expect(remoteFileDestination("docs/", "./notes.md")).toBe("docs/notes.md");
  });

  it("appends it when the remote path is the Project root", () => {
    expect(remoteFileDestination("", "./notes.md")).toBe("notes.md");
  });

  it("leaves a named destination exactly as typed, including a rename", () => {
    expect(remoteFileDestination("docs/readme.md", "./notes.md")).toBe("docs/readme.md");
  });
});
