import { describe, expect, it } from "vitest";
import {
  PROJECT_PATH_DRAG_MIME,
  formatPathForTerminalPaste,
  isProjectPathDrag,
  readProjectPathFromDragEvent,
  setProjectPathDragData,
} from "../project-path-drag";

describe("formatPathForTerminalPaste", () => {
  it("leaves simple paths unquoted", () => {
    expect(formatPathForTerminalPaste("/Users/dev/project")).toBe("/Users/dev/project");
  });

  it("single-quotes paths with spaces and leaves double quotes literal", () => {
    expect(formatPathForTerminalPaste('/Users/dev/my "app"')).toBe(
      `'/Users/dev/my "app"'`,
    );
  });

  it("escapes an embedded single quote the POSIX way", () => {
    expect(formatPathForTerminalPaste("/tmp/a'b")).toBe(`'/tmp/a'\\''b'`);
  });
});

describe("formatPathForTerminalPaste shell metacharacters", () => {
  it("single-quotes a path with dollar-paren so the shell cannot expand it", () => {
    expect(formatPathForTerminalPaste("/srv/$(id)")).toBe("'/srv/$(id)'");
  });

  it("single-quotes a path with a backtick so the shell cannot expand it", () => {
    expect(formatPathForTerminalPaste("/srv/`id`")).toBe("'/srv/`id`'");
  });

  it("single-quotes a path with a semicolon so it stays one word", () => {
    expect(formatPathForTerminalPaste("/srv/a;id")).toBe("'/srv/a;id'");
  });

  it("refuses a path with a control character (write nothing)", () => {
    expect(formatPathForTerminalPaste("/srv/a\u0015;id\r")).toBeNull();
    expect(formatPathForTerminalPaste("/srv/a\nid")).toBeNull();
  });
});

describe("formatPathForTerminalPaste backslashes", () => {
  it("single-quotes a path with a backslash so a trailing one cannot swallow a quote", () => {
    expect(formatPathForTerminalPaste("/tmp/a b\\")).toBe("'/tmp/a b\\'");
    expect(formatPathForTerminalPaste('/tmp/a\\"b')).toBe(`'/tmp/a\\"b'`);
  });
});

describe("project path drag payload", () => {
  it("sets custom and plain-text mime types", () => {
    const data = new Map<string, string>();
    const dataTransfer = {
      setData(type: string, value: string) {
        data.set(type, value);
      },
      getData(type: string) {
        return data.get(type) ?? "";
      },
      types: [] as string[],
      effectAllowed: "",
    } as unknown as DataTransfer;

    setProjectPathDragData(dataTransfer, "/Users/dev/project");
    expect(data.get(PROJECT_PATH_DRAG_MIME)).toBe("/Users/dev/project");
    expect(data.get("text/plain")).toBe("/Users/dev/project");
    expect(dataTransfer.effectAllowed).toBe("copy");
  });

  it("detects and reads project path drags", () => {
    const event = {
      dataTransfer: {
        types: [PROJECT_PATH_DRAG_MIME],
        getData(type: string) {
          if (type === PROJECT_PATH_DRAG_MIME) return "/Users/dev/project";
          return "";
        },
      },
    } as unknown as DragEvent;

    expect(isProjectPathDrag(event)).toBe(true);
    expect(readProjectPathFromDragEvent(event)).toBe("/Users/dev/project");
  });
});
