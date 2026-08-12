// The stable Core client id, across the connections it exists to span (ADR 0024
// D9, issue 146).
//
// The two detectors the Panel's `client-id-reclaim.test.ts` held and #156's
// deletion did not replace — section 2 of #195's review names both. The rest of
// that file came across with the migration: the id on the wire once the link is
// up (`core-client.test.ts`), ahead of the replay tail and the PTY resend and
// withheld until the bearer is accepted (`durable-core-client.test.ts`), the
// caller-supplied id, and one id per client. What had no home is the property
// the whole feature rests on and the one failure it has to survive:
//
//  1. **The id does not move.** It is the same string on every reconnect,
//     because a reconnect is exactly what it spans. An id that changed with the
//     socket would reclaim nothing, every time, and the defect would be
//     invisible — the Core would answer politely and the ghost connection would
//     hold this client's Sessions for the full 45-second heartbeat timeout.
//     Safe by construction today (`readonly clientId`, assigned once, read at
//     one send site), which is an argument for keeping it that way and not one
//     for leaving it unpinned.
//  2. **A refused reclaim is survivable.** It is fire-and-forget by design: the
//     answer costs the heartbeat timeout it was shortening, never correctness,
//     so a Core that refuses it must not take anything else down with it.

import { describe, it, expect, vi, afterEach } from "vitest";
import { signBearer, verifyBearer } from "@actana/shared/core-link-bearer";
import { DurableCoreClient } from "../durable-core-client";
import { handDrivenDialer, startCoreRig, type CoreRig } from "./fake-core-link";

const SECRET = "client-id-suite-secret-32-bytes-xx";
const URL_A = "wss://core-a.test:9444";

function bearerFor(coreId = "core_test"): string {
  return signBearer({ coreId, exp: Date.now() + 60_000 }, SECRET);
}

describe("the SDK client's Core client id (ADR 0024 D9)", () => {
  let rig: CoreRig | null = null;
  let client: DurableCoreClient | null = null;

  afterEach(() => {
    client?.close();
    client = null;
    rig?.close();
    rig = null;
  });

  it("is the same string on every reconnect — the property the feature rests on", async () => {
    rig = startCoreRig({ authVerifier: (bearer) => verifyBearer(bearer, SECRET) });
    const dial = rig.dialer();
    client = new DurableCoreClient({
      url: URL_A,
      bearer: bearerFor(),
      createSocket: dial.createSocket,
      reconnectInitialMs: 5,
      reconnectMaxMs: 5,
      heartbeat: false,
    });
    const durable = client;

    await durable.connect();
    // Three connections, each a genuinely new socket the Core accepted and each
    // presenting this client's id for the reaping of the one before it.
    for (let connection = 1; connection <= 3; connection++) {
      await vi.waitFor(() => expect(dial.pairs).toHaveLength(connection));
      await vi.waitFor(() =>
        expect(dial.last().client.framesOfType("reclaim")).toHaveLength(1),
      );
      if (connection < 3) dial.last().server.close();
    }

    const presented = dial.pairs.flatMap((pair) =>
      pair.client.framesOfType("reclaim").map((frame) => frame.clientId),
    );
    expect(presented).toEqual([durable.clientId, durable.clientId, durable.clientId]);
    expect(durable.clientId).toMatch(/^sdk-/);
  });

  it("carries on when the Core refuses the reclaim", async () => {
    // Hand-driven, because the Core's reclaim handler cannot fail: there is no
    // server path that answers this frame with an `error`, and the client's
    // tolerance of one is otherwise asserted by nothing.
    const dial = handDrivenDialer();
    client = new DurableCoreClient({
      url: URL_A,
      bearer: bearerFor(),
      createSocket: dial.createSocket,
      reconnectInitialMs: 10_000,
      reconnectMaxMs: 10_000,
      heartbeat: false,
    });
    const durable = client;
    const reclaimed = vi.fn();
    durable.onReclaimed(reclaimed);

    const connecting = durable.connect();
    await vi.waitFor(() => expect(dial.last().framesOfType("auth")).toHaveLength(1));
    dial.ready({ multiConnection: { version: 1 } });
    dial.authOk();
    await connecting;

    expect(dial.last().framesOfType("reclaim")).toHaveLength(1);
    dial.answerLast("reclaim", { type: "error", message: "nope" });

    // The link is still a link: the next request goes out and is answered.
    const found = durable.findByTask("task_1");
    await vi.waitFor(() => expect(dial.last().framesOfType("findByTask")).toHaveLength(1));
    dial.answerLast("findByTask", { type: "findByTaskResult", ptyId: "pty_1" });

    await expect(found).resolves.toEqual({ ptyId: "pty_1" });
    // And nothing was reported as reclaimed, because nothing was.
    expect(reclaimed).not.toHaveBeenCalled();
  });
});
