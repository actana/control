import { describe, it, expect } from "vitest";
import {
  CORE_LINK_PROTOCOL_VERSION,
  coreLinkProtocolCompatible,
  parseCoreLinkRequestFrame,
  serializeCoreLinkFrame,
  type CoreLinkEvent,
  type CoreLinkRequestFrame,
  type CoreLinkServerFrame,
} from "../core-link-frames";

describe("core-link-frames", () => {
  describe("parseCoreLinkRequestFrame", () => {
    it("parses a valid spawn frame", () => {
      const frame: CoreLinkRequestFrame = {
        type: "spawn",
        reqId: "r1",
        opts: {
          taskId: "t1",
          cwd: "/tmp",
          command: "claude",
          agent: "claude-code",
        },
      };
      const parsed = parseCoreLinkRequestFrame(JSON.stringify(frame));
      expect(parsed).toEqual(frame);
    });

    it("parses write/resize/kill/replay/findByTask frames", () => {
      const frames: CoreLinkRequestFrame[] = [
        { type: "write", reqId: "r1", ptyId: "p1", data: "ls\n" },
        { type: "resize", reqId: "r2", ptyId: "p1", cols: 120, rows: 40 },
        { type: "kill", reqId: "r3", ptyId: "p1" },
        { type: "replay", reqId: "r4", ptyId: "p1" },
        { type: "findByTask", reqId: "r5", taskId: "t1" },
        {
          type: "killLaunchProcesses",
          reqId: "r7",
          cwd: "/tmp/proj",
          commands: ["vite"],
          ports: [5173],
        },
      ];
      for (const frame of frames) {
        const parsed = parseCoreLinkRequestFrame(JSON.stringify(frame));
        expect(parsed).toEqual(frame);
      }
    });

    it("parses a subscribe frame carrying the lastEventId cursor", () => {
      const frame: CoreLinkRequestFrame = {
        type: "subscribe",
        reqId: "r1",
        lastEventId: 42,
      };
      const parsed = parseCoreLinkRequestFrame(JSON.stringify(frame));
      expect(parsed).toEqual(frame);
    });

    it("parses a subscribe frame with lastEventId 0 (full replay)", () => {
      const frame: CoreLinkRequestFrame = {
        type: "subscribe",
        reqId: "r2",
        lastEventId: 0,
      };
      const parsed = parseCoreLinkRequestFrame(JSON.stringify(frame));
      expect(parsed).toEqual(frame);
    });

    it("parses task/session/hook op frames", () => {
      const frames: CoreLinkRequestFrame[] = [
        { type: "tasksList", reqId: "r1", projectId: "p1" },
        { type: "tasksList", reqId: "r2" },
        {
          type: "tasksMutate",
          reqId: "r3",
          mutation: { op: "update", taskId: "t1", status: "running" },
        },
        { type: "sessionsList", reqId: "r4", projectId: "p1" },
        { type: "hooksOp", reqId: "r5", hook: { op: "list", taskId: "t1" } },
        { type: "hooksOp", reqId: "r6", hook: { op: "enable", hookId: "h1" } },
        { type: "projectsList", reqId: "r7" },
      ];
      for (const frame of frames) {
        const parsed = parseCoreLinkRequestFrame(JSON.stringify(frame));
        expect(parsed).toEqual(frame);
      }
    });

    it("parses a shellSession (VM shell) spawn frame with no agent and no cwd", () => {
      const frame: CoreLinkRequestFrame = {
        type: "spawn",
        reqId: "r1",
        opts: { shellSession: true, taskId: "vm1" },
      };
      const parsed = parseCoreLinkRequestFrame(JSON.stringify(frame));
      expect(parsed).toEqual(frame);
    });

    it("parses a shellSession spawn frame with an optional starting command", () => {
      const frame: CoreLinkRequestFrame = {
        type: "spawn",
        reqId: "r2",
        opts: { shellSession: true, taskId: "vm2", command: "htop" },
      };
      const parsed = parseCoreLinkRequestFrame(JSON.stringify(frame));
      expect(parsed).toEqual(frame);
    });

    it("returns null for malformed JSON", () => {
      expect(parseCoreLinkRequestFrame("not json")).toBeNull();
    });

    it("returns null for non-object JSON", () => {
      expect(parseCoreLinkRequestFrame("42")).toBeNull();
      expect(parseCoreLinkRequestFrame("null")).toBeNull();
      expect(parseCoreLinkRequestFrame('"string"')).toBeNull();
    });

    it("returns null for an unknown frame type", () => {
      expect(parseCoreLinkRequestFrame(JSON.stringify({ type: "bogus" }))).toBeNull();
    });

    it("returns null for a missing type field", () => {
      expect(parseCoreLinkRequestFrame(JSON.stringify({ reqId: "r1" }))).toBeNull();
    });

    it("does not accept server-only frame types as requests", () => {
      // `data`, `exit`, `ready`, `spawned`, `event`, `eventsReplayed` etc. are
      // server→client only.
      expect(
        parseCoreLinkRequestFrame(JSON.stringify({ type: "data", ptyId: "p1", data: "x", seq: 1 })),
      ).toBeNull();
      expect(
        parseCoreLinkRequestFrame(JSON.stringify({ type: "ready", version: "0.2.0" })),
      ).toBeNull();
      expect(
        parseCoreLinkRequestFrame(
          JSON.stringify({ type: "eventsReplayed", lastEventId: 5 }),
        ),
      ).toBeNull();
    });
  });

  describe("serializeCoreLinkFrame", () => {
    it("round-trips a data frame", () => {
      const frame: CoreLinkServerFrame = {
        type: "data",
        ptyId: "p1",
        data: "hello",
        seq: 42,
      };
      const parsed = JSON.parse(serializeCoreLinkFrame(frame));
      expect(parsed).toEqual(frame);
    });

    it("round-trips a ready frame with the protocol version", () => {
      const frame: CoreLinkServerFrame = {
        type: "ready",
        version: CORE_LINK_PROTOCOL_VERSION,
      };
      const parsed = JSON.parse(serializeCoreLinkFrame(frame));
      expect(parsed).toEqual(frame);
    });

    it("round-trips a subscribeAck response", () => {
      const frame: CoreLinkServerFrame = {
        type: "subscribeAck",
        reqId: "r1",
        fromEventId: 42,
      };
      const parsed = JSON.parse(serializeCoreLinkFrame(frame));
      expect(parsed).toEqual(frame);
    });

    it("round-trips an event frame carrying a CoreLinkEvent", () => {
      const event: CoreLinkEvent = {
        eventId: 7,
        ts: 1_700_000_000_000,
        kind: "task:updated",
        ptyId: null,
        taskId: "t1",
        payload: '{"status":"running"}',
      };
      const frame: CoreLinkServerFrame = { type: "event", event };
      const parsed = JSON.parse(serializeCoreLinkFrame(frame));
      expect(parsed).toEqual(frame);
    });

    it("round-trips an eventsReplayed marker", () => {
      const frame: CoreLinkServerFrame = {
        type: "eventsReplayed",
        lastEventId: 99,
      };
      const parsed = JSON.parse(serializeCoreLinkFrame(frame));
      expect(parsed).toEqual(frame);
    });

    it("round-trips a tasksListResult response", () => {
      const frame: CoreLinkServerFrame = {
        type: "tasksListResult",
        reqId: "r1",
        tasks: [
          {
            taskId: "t1",
            projectId: "p1",
            title: "fix bug",
            agent: "claude-code",
            status: "running",
            pinned: false,
            archived: false,
            icon: null,
            updatedAt: 1,
          },
        ],
      };
      const parsed = JSON.parse(serializeCoreLinkFrame(frame));
      expect(parsed).toEqual(frame);
    });

    it("round-trips a projectsListResult response carrying project snapshots", () => {
      const frame: CoreLinkServerFrame = {
        type: "projectsListResult",
        reqId: "r1",
        projects: [
          {
            projectId: "p1",
            name: "mission-control",
            path: "/home/op/mission-control",
            icon: "MC",
            iconColor: "#7ce58a",
            pinned: true,
            updatedAt: 1_700_000_000_000,
          },
          {
            projectId: "p2",
            name: "scratch",
            path: "/home/op/scratch",
            icon: "SC",
            iconColor: "#e5484d",
            pinned: false,
            updatedAt: 1_700_000_000_001,
          },
        ],
      };
      const parsed = JSON.parse(serializeCoreLinkFrame(frame));
      expect(parsed).toEqual(frame);
    });

    it("round-trips a spawned response", () => {
      const frame: CoreLinkServerFrame = {
        type: "spawned",
        reqId: "r1",
        ptyId: "pty-abc",
      };
      const parsed = JSON.parse(serializeCoreLinkFrame(frame));
      expect(parsed).toEqual(frame);
    });

    it("round-trips a replayResult", () => {
      const frame: CoreLinkServerFrame = {
        type: "replayResult",
        reqId: "r1",
        data: "buffered output",
        nextSeq: 100,
      };
      const parsed = JSON.parse(serializeCoreLinkFrame(frame));
      expect(parsed).toEqual(frame);
    });
  });

  describe("directory browsing frames", () => {
    it("parses dirList frames, with and without an explicit path", () => {
      const frames: CoreLinkRequestFrame[] = [
        { type: "dirList", reqId: "r1", path: "/srv/projects" },
        { type: "dirList", reqId: "r2", path: null },
        { type: "dirList", reqId: "r3" },
      ];
      for (const frame of frames) {
        expect(parseCoreLinkRequestFrame(JSON.stringify(frame))).toEqual(frame);
      }
    });

    it("parses a dirCreate frame", () => {
      const frame: CoreLinkRequestFrame = {
        type: "dirCreate",
        reqId: "r1",
        parent: "/srv/projects",
        name: "warehouse",
      };
      expect(parseCoreLinkRequestFrame(JSON.stringify(frame))).toEqual(frame);
    });

    it("round-trips a dirListResult", () => {
      const frame: CoreLinkServerFrame = {
        type: "dirListResult",
        reqId: "r1",
        listing: {
          path: "/srv/projects",
          parent: "/srv",
          home: "/home/operator",
          roots: [{ label: "Home", path: "/home/operator" }],
          entries: [{ name: "warehouse", childCount: 3 }],
          truncated: false,
        },
      };
      const parsed = JSON.parse(serializeCoreLinkFrame(frame));
      expect(parsed).toEqual(frame);
    });

    it("round-trips a dirCreateResult", () => {
      const frame: CoreLinkServerFrame = {
        type: "dirCreateResult",
        reqId: "r1",
        path: "/srv/projects/warehouse",
      };
      const parsed = JSON.parse(serializeCoreLinkFrame(frame));
      expect(parsed).toEqual(frame);
    });
  });

  describe("CORE_LINK_PROTOCOL_VERSION", () => {
    it("is a semver string", () => {
      expect(CORE_LINK_PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe("coreLinkProtocolCompatible", () => {
    it("accepts the version this build speaks", () => {
      expect(coreLinkProtocolCompatible(CORE_LINK_PROTOCOL_VERSION)).toBe(true);
    });

    const [major, minor] = CORE_LINK_PROTOCOL_VERSION.split(".").map(Number);

    it("accepts a patch difference — patches never change the wire", () => {
      expect(coreLinkProtocolCompatible(`${major}.${minor}.99`)).toBe(true);
    });

    it("rejects an older minor", () => {
      expect(coreLinkProtocolCompatible(`${major}.${minor - 1}.0`)).toBe(false);
    });

    it("rejects a newer minor — a Panel behind its fleet is drift too", () => {
      expect(coreLinkProtocolCompatible(`${major}.${minor + 1}.0`)).toBe(false);
    });

    it("rejects a different major", () => {
      expect(coreLinkProtocolCompatible(`${major + 1}.${minor}.0`)).toBe(false);
    });

    it("rejects an unparseable or absent version", () => {
      expect(coreLinkProtocolCompatible("")).toBe(false);
      expect(coreLinkProtocolCompatible("banana")).toBe(false);
      expect(coreLinkProtocolCompatible(null)).toBe(false);
      expect(coreLinkProtocolCompatible(undefined)).toBe(false);
    });
  });
});
