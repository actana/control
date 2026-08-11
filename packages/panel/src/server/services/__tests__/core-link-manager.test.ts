import { beforeEach, describe, expect, it } from "vitest";
import type { Core } from "~/shared/cores";
import type { CoreSecrets } from "../cores";
import { CoreLinkManager, type CoreCursor, type CoreLinkClientLike } from "../core-link-manager";

/**
 * The manager is driven through its injected seams: a fake core-link client and
 * a fake registry. What's asserted is what an operator can see — the dial
 * status of each Core and where its replay cursor sits.
 */

type Emitters = {
  authOk: (msg: { coreId: string; exp: number }) => void;
  authError: (msg: { reason: "expired" | "bad-signature" | "malformed" }) => void;
  disconnected: (msg: { error?: string }) => void;
  protocolVersion: (msg: { version: string | null; compatible: boolean }) => void;
};

class FakeClient implements CoreLinkClientLike {
  readonly emit = {} as Emitters;
  closed = false;

  // The request/stream half of the interface exists for the panel-link router,
  // not for the manager. These are inert stubs so this fake keeps testing only
  // what the manager does with a link.
  request(): Promise<never> {
    throw new Error("not exercised by the manager");
  }
  onData() {
    return () => {};
  }
  onExit() {
    return () => {};
  }
  onEvent() {
    return () => {};
  }
  ptySubscribe() {
    return Promise.resolve();
  }
  ptyUnsubscribe() {
    return Promise.resolve();
  }

  onAuthOk(cb: Emitters["authOk"]) {
    this.emit.authOk = cb;
    return () => {};
  }
  onAuthError(cb: Emitters["authError"]) {
    this.emit.authError = cb;
    return () => {};
  }
  onDisconnected(cb: Emitters["disconnected"]) {
    this.emit.disconnected = cb;
    return () => {};
  }
  onProtocolVersion(cb: Emitters["protocolVersion"]) {
    this.emit.protocolVersion = cb;
    return () => {};
  }
  close() {
    this.closed = true;
  }
}

const SECRETS: CoreSecrets = {
  caCert: "ca",
  clientCert: "cert",
  clientKey: "key",
  bearer: "bearer",
};

function core(id: string, overrides: Partial<Core> = {}): Core {
  return {
    id,
    endpoint: `wss://${id}.example.test:7777`,
    label: id,
    lastEventId: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

type Fixture = {
  manager: CoreLinkManager;
  clients: Map<string, FakeClient>;
  cores: Map<string, Core>;
  secrets: Map<string, CoreSecrets | null>;
  cursors: Map<string, number>;
};

function fixture(): Fixture {
  const clients = new Map<string, FakeClient>();
  const cores = new Map<string, Core>();
  const secrets = new Map<string, CoreSecrets | null>();
  const cursors = new Map<string, number>();
  const manager = new CoreLinkManager({
    createClient: (entry) => {
      const client = new FakeClient();
      clients.set(entry.id, client);
      return client;
    },
    listCores: () => [...cores.values()],
    resolveCore: (id) => cores.get(id) ?? null,
    resolveSecrets: (id) => (secrets.has(id) ? secrets.get(id)! : SECRETS),
    resolveCursor: (id) => cursors.get(id) ?? 0,
    advanceCursor: (id, lastEventId) => {
      cursors.set(id, Math.max(cursors.get(id) ?? 0, lastEventId));
    },
  });
  return { manager, clients, cores, secrets, cursors };
}

let h: Fixture;

beforeEach(() => {
  h = fixture();
  h.cores.set("core_a", core("core_a"));
});

describe("core-link manager", () => {
  it("reports a Core as connecting the moment it starts dialing", () => {
    h.manager.dial("core_a");
    expect(h.manager.status("core_a")).toMatchObject({
      coreId: "core_a",
      state: "connecting",
      lastSeenAt: null,
    });
  });

  it("reports connected once the Core accepts the bearer", () => {
    h.manager.dial("core_a");
    h.clients.get("core_a")!.emit.authOk({ coreId: "core_a", exp: Date.now() + 60_000 });
    const status = h.manager.status("core_a");
    expect(status.state).toBe("connected");
    expect(status.lastSeenAt).toBeGreaterThan(0);
  });

  it("reports unreachable on a drop, remembering when the Core was last seen", () => {
    h.manager.dial("core_a");
    const client = h.clients.get("core_a")!;
    client.emit.authOk({ coreId: "core_a", exp: Date.now() + 60_000 });
    const seenAt = h.manager.status("core_a").lastSeenAt;
    client.emit.disconnected({ error: "ECONNREFUSED" });
    expect(h.manager.status("core_a")).toMatchObject({
      state: "unreachable",
      lastSeenAt: seenAt,
      detail: "ECONNREFUSED",
    });
  });

  it("reports a rejected bearer as an auth error, not a flaky network", () => {
    h.manager.dial("core_a");
    h.clients.get("core_a")!.emit.authError({ reason: "expired" });
    expect(h.manager.status("core_a")).toMatchObject({ state: "auth-error", detail: "expired" });
  });

  it("reports a Core whose sealed secrets cannot be read, and does not dial it", () => {
    h.secrets.set("core_a", null);
    h.manager.dial("core_a");
    expect(h.clients.has("core_a")).toBe(false);
    expect(h.manager.status("core_a").state).toBe("auth-error");
  });

  it("dials every registered Core at boot, with no browser involved", () => {
    h.cores.set("core_b", core("core_b"));
    h.manager.start();
    expect([...h.clients.keys()].sort()).toEqual(["core_a", "core_b"]);
    expect(h.manager.statuses().map((s) => s.coreId).sort()).toEqual(["core_a", "core_b"]);
  });

  it("does not open a second link for a Core it is already dialing", () => {
    h.manager.dial("core_a");
    const first = h.clients.get("core_a");
    h.manager.dial("core_a");
    expect(h.clients.get("core_a")).toBe(first);
  });

  // The version gate (issue 07). A Core speaking a protocol this Panel does not
  // share is a chore with a command attached, not a link to half-use: the state
  // is its own, it survives the auth handshake that would otherwise call it
  // connected, and it clears itself the moment the updated Core reconnects.
  describe("the protocol version gate", () => {
    it("marks a Core on an older protocol as needing an update", () => {
      h.manager.dial("core_a");
      h.clients.get("core_a")!.emit.protocolVersion({ version: "0.1.0", compatible: false });
      expect(h.manager.status("core_a")).toMatchObject({
        coreId: "core_a",
        state: "needs-update",
        coreVersion: "0.1.0",
      });
    });

    it("keeps needs-update through the auth handshake that follows", () => {
      h.manager.dial("core_a");
      const client = h.clients.get("core_a")!;
      client.emit.protocolVersion({ version: "0.1.0", compatible: false });
      client.emit.authOk({ coreId: "core_a", exp: Date.now() + 60_000 });
      expect(h.manager.status("core_a").state).toBe("needs-update");
    });

    it("marks needs-update even when auth landed first", () => {
      h.manager.dial("core_a");
      const client = h.clients.get("core_a")!;
      client.emit.authOk({ coreId: "core_a", exp: Date.now() + 60_000 });
      client.emit.protocolVersion({ version: "0.1.0", compatible: false });
      expect(h.manager.status("core_a").state).toBe("needs-update");
    });

    it("clears needs-update when the updated Core reconnects", () => {
      h.manager.dial("core_a");
      const client = h.clients.get("core_a")!;
      client.emit.protocolVersion({ version: "0.1.0", compatible: false });
      client.emit.disconnected({ error: "restarting" });
      // Same link object, new connection: the updated Core's ready frame.
      client.emit.protocolVersion({ version: "0.8.0", compatible: true });
      client.emit.authOk({ coreId: "core_a", exp: Date.now() + 60_000 });
      expect(h.manager.status("core_a").state).toBe("connected");
    });

    it("pushes the needs-update change to status watchers", () => {
      const seen: string[] = [];
      h.manager.onStatusChange((status) => seen.push(status.state));
      h.manager.dial("core_a");
      h.clients.get("core_a")!.emit.protocolVersion({ version: "0.1.0", compatible: false });
      expect(seen).toContain("needs-update");
    });

    it("leaves a matching Core alone", () => {
      h.manager.dial("core_a");
      const client = h.clients.get("core_a")!;
      client.emit.protocolVersion({ version: "0.8.0", compatible: true });
      client.emit.authOk({ coreId: "core_a", exp: Date.now() + 60_000 });
      expect(h.manager.status("core_a").state).toBe("connected");
    });

    it("still reports a dropped link as unreachable, not as needing an update", () => {
      h.manager.dial("core_a");
      const client = h.clients.get("core_a")!;
      client.emit.protocolVersion({ version: "0.1.0", compatible: false });
      client.emit.disconnected({ error: "ECONNREFUSED" });
      expect(h.manager.status("core_a").state).toBe("unreachable");
    });
  });

  describe("the Panel-owned cursor", () => {
    /** Dial and capture the cursor handle the manager gave the client. */
    function dialCapturingCursor(): CoreCursor {
      let captured: CoreCursor | null = null;
      const manager = new CoreLinkManager({
        createClient: (_core, _secrets, cursor) => {
          captured = cursor;
          return new FakeClient();
        },
        listCores: () => [...h.cores.values()],
        resolveCore: (id) => h.cores.get(id) ?? null,
        resolveSecrets: () => SECRETS,
        resolveCursor: (id) => h.cursors.get(id) ?? 0,
        advanceCursor: (id, lastEventId) => {
          h.cursors.set(id, Math.max(h.cursors.get(id) ?? 0, lastEventId));
        },
      });
      manager.dial("core_a");
      if (!captured) throw new Error("the manager gave the client no cursor");
      return captured;
    }

    it("reads the stored position, so a reconnect resumes from it", () => {
      h.cursors.set("core_a", 42);
      expect(dialCapturingCursor().read()).toBe(42);
    });

    it("writes back to the registry as the client advances", () => {
      const cursor = dialCapturingCursor();
      cursor.write(17);
      expect(h.cursors.get("core_a")).toBe(17);
    });

    it("belongs to the Core, not the connection — it survives a redial", () => {
      dialCapturingCursor().write(17);
      h.manager.hangup("core_a");
      expect(dialCapturingCursor().read()).toBe(17);
    });
  });

  describe("hangup", () => {
    it("closes the link and forgets the Core's status", () => {
      h.manager.dial("core_a");
      const client = h.clients.get("core_a")!;
      h.manager.hangup("core_a");
      expect(client.closed).toBe(true);
      expect(h.manager.statuses()).toEqual([]);
    });

    it("is a no-op for a Core that was never dialed", () => {
      expect(() => h.manager.hangup("core_nope")).not.toThrow();
    });
  });

  it("closes every link on dispose", () => {
    h.cores.set("core_b", core("core_b"));
    h.manager.start();
    h.manager.dispose();
    expect([...h.clients.values()].every((c) => c.closed)).toBe(true);
    expect(h.manager.statuses()).toEqual([]);
  });

  it("ignores a dial for a Core that isn't registered", () => {
    h.manager.dial("core_ghost");
    expect(h.clients.size).toBe(0);
    expect(h.manager.statuses()).toEqual([]);
  });

  it("reports an unknown Core as unreachable rather than throwing", () => {
    expect(h.manager.status("core_ghost")).toMatchObject({
      coreId: "core_ghost",
      state: "unreachable",
      lastSeenAt: null,
    });
  });
});

describe("core-link manager · dial failures", () => {
  it("surfaces a client that throws on construction as unreachable", () => {
    const manager = new CoreLinkManager({
      createClient: () => {
        throw new Error("no route to host");
      },
      listCores: () => [core("core_a")],
      resolveCore: () => core("core_a"),
      resolveSecrets: () => SECRETS,
      resolveCursor: () => 0,
      advanceCursor: () => {},
    });
    manager.dial("core_a");
    expect(manager.status("core_a")).toMatchObject({
      state: "unreachable",
      detail: "no route to host",
    });
  });

  it("retries a Core that never got a client, so a fixed key file takes effect", () => {
    // A data directory restored without its secrets key: nothing to dial with.
    h.secrets.set("core_a", null);
    h.manager.dial("core_a");
    expect(h.manager.status("core_a").state).toBe("auth-error");

    // The operator puts the key back. The next dial must actually try again
    // rather than short-circuit on the status left behind by the last one.
    h.secrets.delete("core_a");
    h.manager.dial("core_a");
    expect(h.clients.has("core_a")).toBe(true);
    expect(h.manager.status("core_a").state).toBe("connecting");
  });
});
