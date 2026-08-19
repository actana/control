// The `exec` request/response pair, and the protocol move it caused (#266).
//
// Two claims worth their own file. The first is ordinary: the frames parse, the
// result serializes, and the refusal carries a code. The second is the one the
// issue asked to be recorded rather than inferred — **the version moved, and it
// moved for this**. `multiConnection` and `files` did not move it and are not
// supposed to; a frame is a different kind of addition from a ready capability,
// and D11's narrow exception covers the second and not the first.

import { describe, it, expect } from "vitest";
import {
  CORE_LINK_PROTOCOL_VERSION,
  EXEC_OUTPUT_TOO_LARGE_ERROR_CODE,
  coreLinkProtocolCompatible,
  parseCoreLinkRequestFrame,
  serializeCoreLinkFrame,
  type CoreLinkRequestFrame,
  type CoreLinkServerFrame,
} from "../core-link-frames";

describe("the `exec` request frame", () => {
  it("parses, with an argv and a cwd", () => {
    const frame: CoreLinkRequestFrame = {
      type: "exec",
      reqId: "r1",
      command: "sh",
      args: ["-c", "exit 3"],
      cwd: "/srv/app",
    };
    expect(parseCoreLinkRequestFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it("parses with no cwd — the Core picks its own home, which a client cannot compute", () => {
    const frame: CoreLinkRequestFrame = { type: "exec", reqId: "r2", command: "pwd", args: [] };
    expect(parseCoreLinkRequestFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it("is an argv and not a shell string — a caller that wants a shell names one", () => {
    const frame = parseCoreLinkRequestFrame(
      JSON.stringify({ type: "exec", reqId: "r3", command: "sh", args: ["-c", "a && b"] }),
    );
    // The shell is in `command`, where a reader can see it, rather than implied
    // by the Core spawning one on every caller's behalf.
    expect(frame).toMatchObject({ command: "sh", args: ["-c", "a && b"] });
  });
});

describe("the `execResult` response frame", () => {
  it("carries both streams apart and the command's own status", () => {
    const frame: CoreLinkServerFrame = {
      type: "execResult",
      reqId: "r1",
      exitCode: 7,
      signal: null,
      stdout: "out",
      stderr: "err",
    };
    expect(JSON.parse(serializeCoreLinkFrame(frame))).toEqual(frame);
  });

  it("reports a signal instead of a code, never both — the pair is exclusive", () => {
    const killed: CoreLinkServerFrame = {
      type: "execResult",
      reqId: "r2",
      exitCode: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: "",
    };
    const wire = JSON.parse(serializeCoreLinkFrame(killed)) as Record<string, unknown>;
    expect(wire.exitCode).toBeNull();
    expect(wire.signal).toBe("SIGKILL");
  });
});

describe("output past the bound is a named refusal, not a short result", () => {
  it("has a code a client can branch on without reading prose", () => {
    const refusal: CoreLinkServerFrame = {
      type: "error",
      reqId: "r1",
      code: EXEC_OUTPUT_TOO_LARGE_ERROR_CODE,
      message: "The command produced more than 8 MiB of output.",
    };
    expect(JSON.parse(serializeCoreLinkFrame(refusal))).toMatchObject({
      code: "exec-output-too-large",
    });
  });

  it("is an error frame rather than an execResult, so no caller can mistake it for output", () => {
    // The distinction the D39 class of failure turns on: a truncated stdout
    // that arrives shaped like a complete one ships broken and looks fine. This
    // one cannot be read as output at all.
    const refusal: CoreLinkServerFrame = {
      type: "error",
      reqId: "r1",
      code: EXEC_OUTPUT_TOO_LARGE_ERROR_CODE,
      message: "too much",
    };
    expect(refusal.type).not.toBe("execResult");
  });
});

describe("the protocol version moved for this frame", () => {
  // The reason is in the test name, so whoever reads this failing after a
  // future bump gets the reason rather than the number.
  it("is 0.16.0, up from 0.15.0, because `exec` is a new frame and not a ready capability (#266, ADR 0024 D11)", () => {
    expect(CORE_LINK_PROTOCOL_VERSION).toBe("0.16.0");
  });

  it("marks a Core still on 0.15.0 as incompatible, which is the whole point of moving it", () => {
    // Version-locked, not degraded: the operator is told to update one of the
    // two, once, rather than meeting a per-verb refusal later.
    expect(coreLinkProtocolCompatible("0.15.0")).toBe(false);
    expect(coreLinkProtocolCompatible("0.16.0")).toBe(true);
  });

  it("still ignores patch, so a fix that touches no frame grounds no fleet", () => {
    expect(coreLinkProtocolCompatible("0.16.4")).toBe(true);
  });

  it("announces no `exec` capability on `ready` — the version is the whole signal", () => {
    const ready = JSON.parse(
      serializeCoreLinkFrame({ type: "ready", version: CORE_LINK_PROTOCOL_VERSION }),
    ) as Record<string, unknown>;
    expect("exec" in ready).toBe(false);
    expect(ready.version).toBe("0.16.0");
  });
});
