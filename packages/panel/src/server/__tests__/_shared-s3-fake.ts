// An S3 gateway in memory, as a `fetch`, for the Panel's Shared-folder tests (#564). It is the Core's
// `shared-s3-fake.ts` (#562) copied below this header (one type cast added), because a test file of one package is not
// importable from another. It answers only for a key the fake issued, under the prefix that key was issued for,
// and says S3's own 403 for anything else. The real thing is `shared-folders-seaweedfs.test.ts`, in CI.
//
export type FakeKey = { accessKeyId: string; sessionToken: string; prefix: string; expiresAt: number };

export type FakeRequest = { method: string; key: string; accessKeyId: string; status: number };

type Stored = { bytes: Uint8Array; modified: number };

const xml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export class FakeS3 {
  readonly bucket: string;
  readonly objects = new Map<string, Stored>();
  readonly keys = new Map<string, FakeKey>();
  readonly requests: FakeRequest[] = [];
  /** The fake's clock: what keys expire against and what `LastModified` says. */
  clock: () => number = Date.now;
  /** Held requests: a test sets one to pause matching requests until it calls `release`. */
  private gate: { match: (r: { method: string; key: string }) => boolean; reached: () => void; open: Promise<void> } | null = null;

  constructor(bucket = "actana-shared") {
    this.bucket = bucket;
  }

  issue(key: FakeKey): void {
    this.keys.set(key.accessKeyId, key);
  }

  /** Put an object as if another client had, outside any key. */
  seed(key: string, content: string | Uint8Array, modified = this.clock()): void {
    this.objects.set(key, { bytes: typeof content === "string" ? new TextEncoder().encode(content) : content, modified });
  }

  text(key: string): string | undefined {
    const o = this.objects.get(key);
    return o ? new TextDecoder().decode(o.bytes) : undefined;
  }

  /** Pause the next request that matches, until the returned `release` is called. `reached` resolves when one is paused. */
  hold(match: (r: { method: string; key: string }) => boolean): { reached: Promise<void>; release: () => void } {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((r) => (reached = r));
    const open = new Promise<void>((r) => (release = r));
    this.gate = { match, reached, open };
    return { reached: reachedPromise, release };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const parts = decodeURIComponent(url.pathname).split("/").filter((_, i) => i > 0);
    const [bucket = "", ...rest] = parts;
    const key = rest.join("/");
    const credential = /Credential=([^/]+)\//.exec(headers.get("authorization") ?? "")?.[1] ?? "";
    // A listing has no key; its prefix is what it asks about, so that is what is recorded.
    const logKey = url.searchParams.get("list-type") === "2" ? (url.searchParams.get("prefix") ?? "") : key;
    const log = (status: number): void => void this.requests.push({ method, key: logKey, accessKeyId: credential, status });

    const gate = this.gate;
    if (gate && gate.match({ method, key })) {
      this.gate = null;
      gate.reached();
      await gate.open;
    }

    const issued = this.keys.get(credential);
    const deny = (status: number, code: string): Response => {
      log(status);
      return new Response(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`, { status });
    };
    if (!issued || headers.get("x-amz-security-token") !== issued.sessionToken || bucket !== this.bucket) {
      return deny(403, "AccessDenied");
    }
    if (this.clock() >= issued.expiresAt) return deny(400, "ExpiredToken");

    const allowedRoot = `${issued.prefix.replace(/\/+$/, "")}/`;
    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      // The role's list condition: the prefix asked for must be inside the key's own.
      if (!prefix.startsWith(allowedRoot)) return deny(403, "AccessDenied");
      const delimiter = url.searchParams.get("delimiter");
      const under = [...this.objects.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1));
      // With a delimiter, what is below the first one after the prefix is a folder (a CommonPrefix), as S3 lists it.
      const folders = new Set<string>();
      const leaves: [string, Stored][] = [];
      for (const [k, o] of under) {
        const at = delimiter ? k.slice(prefix.length).indexOf(delimiter) : -1;
        if (at >= 0) folders.add(prefix + k.slice(prefix.length, prefix.length + at + 1));
        else leaves.push([k, o]);
      }
      const contents =
        [...folders].map((f) => `<CommonPrefixes><Prefix>${xml(f)}</Prefix></CommonPrefixes>`).join("") +
        leaves
          .map(
            ([k, o]) =>
              `<Contents><Key>${xml(k)}</Key><Size>${o.bytes.length}</Size><LastModified>${new Date(o.modified).toISOString()}</LastModified><ETag>"${o.modified}-${o.bytes.length}"</ETag></Contents>`,
          )
          .join("");
      log(200);
      return new Response(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`, {
        status: 200,
      });
    }

    if (!key.startsWith(allowedRoot)) return deny(403, "AccessDenied");

    if (method === "GET" || method === "HEAD") {
      const o = this.objects.get(key);
      if (!o) {
        log(404);
        return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      }
      log(200);
      return new Response(method === "HEAD" ? null : (o.bytes as BodyInit), {
        status: 200,
        headers: { "last-modified": new Date(o.modified).toUTCString() },
      });
    }
    if (method === "PUT" && headers.get("x-amz-copy-source")) {
      // A server-side copy: the source must be inside the key's own folder too.
      const source = decodeURIComponent(headers.get("x-amz-copy-source")!).replace(/^\/+/, "").slice(`${this.bucket}/`.length);
      const from = this.objects.get(source);
      if (!source.startsWith(allowedRoot)) return deny(403, "AccessDenied");
      if (!from) return deny(404, "NoSuchKey");
      this.objects.set(key, { bytes: from.bytes, modified: this.clock() });
      log(200);
      return new Response("<CopyObjectResult/>", { status: 200 });
    }
    if (method === "PUT") {
      const body = init?.body;
      const bytes =
        body === undefined || body === null ? new Uint8Array() : typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body as Uint8Array);
      this.objects.set(key, { bytes, modified: this.clock() });
      log(200);
      return new Response("", { status: 200 });
    }
    if (method === "DELETE") {
      this.objects.delete(key);
      log(204);
      return new Response(null, { status: 204 });
    }
    return deny(405, "MethodNotAllowed");
  };
}
