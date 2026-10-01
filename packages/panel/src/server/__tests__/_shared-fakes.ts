import { createPublicKey, createVerify, randomBytes, type KeyObject } from "node:crypto";
import type { CoreLinkRequestFrame, CoreLinkResponseFrame, CoreLinkSharedMountStatus } from "@actana/shared/sdk-link-frames";
import type { SharedLink, Timer } from "../services/shared-folders";
import type { FakeS3 } from "./_shared-s3-fake";

/** A clock that only moves when a test says so, with the timers that were set on it. */
export class FakeClock {
  current: number;
  private nextId = 1;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  constructor(start = Date.UTC(2026, 9, 2, 12, 0, 0)) {
    this.current = start;
  }
  readonly now = (): number => this.current;
  readonly setTimer = (fn: () => void, ms: number): Timer => {
    const id = this.nextId++;
    this.pending.set(id, { at: this.current + ms, fn });
    return id as unknown as Timer;
  };
  readonly clearTimer = (t: Timer): void => void this.pending.delete(t as unknown as number);
  /** The delays (ms from now) of every timer still set. */
  delays(): number[] {
    return [...this.pending.values()].map((t) => t.at - this.current).sort((a, b) => a - b);
  }
  /** Move time forward, firing each due timer in order, and give what they started a chance to finish. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, t]) => t.at <= target).sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.current = Math.max(this.current, due[1].at);
      due[1].fn();
      await settle();
    }
    this.current = target;
  }
}

/** Let promises, database round trips and timers-of-zero finish. */
export async function settle(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
}

/**
 * SeaweedFS STS, as a `fetch`: it checks the token's RS256 signature against the public half of the master key the
 * Panel was configured with (so a key signed by anything else is refused), then hands out a 1-hour key limited to
 * `<prefix>/<sub>` and registers it with the fake S3. `leaky` hands out a key for the whole prefix instead, the
 * broken role that the connection test exists to catch.
 */
export function fakeSts(opts: { s3: FakeS3; masterPublic: KeyObject | string; prefix: string; clock: FakeClock; leaky?: boolean }) {
  const publicKey = typeof opts.masterPublic === "string" ? createPublicKey(opts.masterPublic) : opts.masterPublic;
  const issued: { sub: string; accessKeyId: string; expiresAt: number }[] = [];
  const state = { fail: false, leaky: opts.leaky === true };
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    if (state.fail) return new Response("<Error><Code>InternalFailure</Code><Message>down</Message></Error>", { status: 500 });
    const form = new URLSearchParams(String(init?.body));
    const token = form.get("WebIdentityToken") ?? "";
    const [h, c, sig] = token.split(".");
    const verifier = createVerify("sha256");
    verifier.update(`${h}.${c}`);
    if (!verifier.verify(publicKey, Buffer.from(sig ?? "", "base64url"))) {
      return new Response("<Error><Code>AccessDenied</Code><Message>bad signature</Message></Error>", { status: 403 });
    }
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString()) as { sub: string };
    const accessKeyId = `AKIA${randomBytes(6).toString("hex")}`;
    const secretAccessKey = randomBytes(16).toString("hex");
    const sessionToken = `st-${randomBytes(8).toString("hex")}`;
    const expiresAt = opts.clock.now() + 3_600_000;
    opts.s3.issue({ accessKeyId, sessionToken, prefix: state.leaky ? opts.prefix : `${opts.prefix}/${claims.sub}`, expiresAt });
    issued.push({ sub: claims.sub, accessKeyId, expiresAt });
    return new Response(
      `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>${accessKeyId}</AccessKeyId><SecretAccessKey>${secretAccessKey}</SecretAccessKey><SessionToken>${sessionToken}</SessionToken><Expiration>${new Date(expiresAt).toISOString()}</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
      { status: 200 },
    );
  };
  return { fetch, issued, state };
}

/**
 * A Core as the Panel talks to it: it answers the three Shared-folder frames with a `sharedStatus`, keeps the key it
 * was last given, and records every frame it received (as the text that went over the wire).
 */
export class FakeCoreLink implements SharedLink {
  readonly frames: CoreLinkRequestFrame[] = [];
  readonly wire: string[] = [];
  attached = false;
  key: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiresAt: string } | null = null;
  capability: { version: 1 } | null = { version: 1 };
  /** The key it holds has run out: a detach is refused until a new key is pushed, as the Core's sync does. */
  expired = false;
  /** Throw this many requests before answering. */
  failures = 0;
  /** Answer the next request with this status instead. */
  answer: CoreLinkSharedMountStatus | null = null;

  sharedCapability = (): { version: 1 } | null => this.capability;

  request = async (frame: CoreLinkRequestFrame): Promise<CoreLinkResponseFrame> => {
    this.frames.push(frame);
    this.wire.push(JSON.stringify(frame));
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("core-link request timed out");
    }
    const reqId = (frame as { reqId: string }).reqId;
    const reply = (status: CoreLinkSharedMountStatus): CoreLinkResponseFrame => ({ type: "sharedStatus", reqId, status });
    if (this.answer) {
      const status = this.answer;
      this.answer = null;
      return reply(status);
    }
    if (frame.type === "sharedAttach") {
      if (this.attached) return reply({ state: "error", code: "already-attached", message: "already attached" });
      this.attached = true;
      this.key = { ...frame.credentials, expiresAt: frame.expiresAt };
      return reply({ state: "attached", expiresAt: frame.expiresAt });
    }
    if (frame.type === "sharedCredentials") {
      if (!this.attached) return reply({ state: "error", code: "not-attached", message: "not attached" });
      this.expired = false;
      this.key = { ...frame.credentials, expiresAt: frame.expiresAt };
      return reply({ state: "attached", expiresAt: frame.expiresAt });
    }
    if (frame.type === "sharedDetach") {
      if (!this.attached) return reply({ state: "error", code: "not-attached", message: "not attached" });
      if (this.expired) {
        return reply({ state: "error", code: "mount-failed", message: "the key has expired, so S3 cannot be copied: push credentials, then detach" });
      }
      this.attached = false;
      this.key = null;
      return reply({ state: "detached", keptLocalCopy: true });
    }
    throw new Error(`unexpected frame ${frame.type}`);
  };

  ofType<T extends CoreLinkRequestFrame["type"]>(type: T): Extract<CoreLinkRequestFrame, { type: T }>[] {
    return this.frames.filter((f): f is Extract<CoreLinkRequestFrame, { type: T }> => f.type === type);
  }
}
