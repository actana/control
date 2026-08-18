import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelLinkClient, type PanelLinkSocketLike } from "../panel-link-client";
import { PANEL_LINK_CLIENT_PARAM, readPanelLinkClientId } from "~/shared/panel-link";

/**
 * The browser half of issue 242: the id a tab calls itself by, and the storage
 * discipline that keeps it to exactly one tab.
 *
 * Driven through a stand-in `window`, because the property under test is not
 * "what does `sessionStorage` do" but "what does the *next page in this tab*
 * find, and what does a page that copied this tab's storage find" — and those
 * are two different readers of one store, which is a thing a test can build and
 * a browser is not.
 */

class FakeSocket implements PanelLinkSocketLike {
  static opened: FakeSocket[] = [];
  readyState = 0;
  readonly sent: string[] = [];
  private handlers = new Map<string, Array<(arg: never) => void>>();

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.fire("close");
  }
  addEventListener(type: string, cb: (arg: never) => void) {
    const list = this.handlers.get(type) ?? [];
    list.push(cb);
    this.handlers.set(type, list);
  }
  private fire(type: string) {
    for (const cb of this.handlers.get(type) ?? []) (cb as () => void)();
  }
  accept() {
    this.readyState = 1;
    this.fire("open");
  }
  drop() {
    this.readyState = 3;
    this.fire("close");
  }
}

/** One tab's `sessionStorage`, which a "Duplicate tab" copies wholesale. */
class FakeStore {
  private readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  /** What a browser hands the duplicate: a snapshot of this store as it stands. */
  duplicate(): FakeStore {
    const copy = new FakeStore();
    for (const [key, value] of this.items) copy.setItem(key, value);
    return copy;
  }
}

/** One page instance in one tab, with the listeners the client hangs on it. */
class FakePage {
  private readonly listeners = new Map<string, Array<() => void>>();
  constructor(readonly sessionStorage: FakeStore) {}
  addEventListener(type: string, cb: () => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  removeEventListener() {}
  /** The page is going away — a reload, or a navigation out of it. */
  pagehide() {
    for (const cb of this.listeners.get("pagehide") ?? []) cb();
  }
  /** The page came back out of the back/forward cache. */
  pageshow() {
    for (const cb of this.listeners.get("pageshow") ?? []) cb();
  }
}

let page: FakePage | null = null;

/** Load a page in a tab whose storage is `store`, and open its link. */
function loadPage(store: FakeStore): { page: FakePage; client: PanelLinkClient } {
  const loaded = new FakePage(store);
  page = loaded;
  (globalThis as { window?: unknown }).window = loaded;
  const client = new PanelLinkClient({
    url: "ws://panel.test/panel-link?v=1",
    createSocket: (url) => new FakeSocket(url),
    reconnectInitialMs: 10,
    reconnectMaxMs: 10,
  });
  return { page: loaded, client };
}

/** The client id on the last socket that was dialled. */
function dialledClientId(): string | null {
  const socket = FakeSocket.opened.at(-1);
  if (!socket) return null;
  return new URL(socket.url).searchParams.get(PANEL_LINK_CLIENT_PARAM);
}

beforeEach(() => {
  FakeSocket.opened = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  page = null;
  delete (globalThis as { window?: unknown }).window;
});

describe("the id a tab presents on its panel link", () => {
  it("is on the upgrade, where the service can read it before the tab says anything", () => {
    loadPage(new FakeStore());
    expect(dialledClientId()).toMatch(/^tab-/);
  });

  it("is the same on every socket the page opens, so a dropped link is not a new tab", () => {
    loadPage(new FakeStore());
    const first = dialledClientId();
    FakeSocket.opened.at(-1)!.drop();
    vi.advanceTimersByTime(50);

    expect(FakeSocket.opened).toHaveLength(2);
    expect(dialledClientId()).toBe(first);
  });

  it("survives the reload it exists for", () => {
    const store = new FakeStore();
    const { page: first } = loadPage(store);
    const before = dialledClientId();

    // The reload: the old page goes away, a new one loads on the same tab's
    // storage. That is the whole mechanism — nothing else carries across.
    first.pagehide();
    loadPage(store);

    expect(dialledClientId()).toBe(before);
  });

  it("survives a same-tab navigation out of the app and back", () => {
    const store = new FakeStore();
    const { page: first } = loadPage(store);
    const before = dialledClientId();

    first.pagehide();
    loadPage(store);
    page!.pagehide();
    loadPage(store);

    expect(dialledClientId()).toBe(before);
  });

  it("is not shared with a tab that duplicated this one", () => {
    const store = new FakeStore();
    loadPage(store);
    const original = dialledClientId();

    // "Duplicate tab" copies `sessionStorage` as it stands *while the page is
    // running* — and the id is not in it then, because the page claimed it on
    // load. Two live tabs presenting one id would reap each other's sockets on
    // every reconnect and neither would ever settle.
    loadPage(store.duplicate());

    expect(dialledClientId()).not.toBe(original);
    expect(dialledClientId()).toMatch(/^tab-/);
  });

  it("is not shared with a tab duplicated after this one came back from the bfcache", () => {
    const store = new FakeStore();
    const { page: first } = loadPage(store);
    const original = dialledClientId();

    // Into the back/forward cache and out again: `pagehide` parked the id, and
    // the restore has to claim it back or a duplicate taken now would copy it.
    first.pagehide();
    first.pageshow();
    loadPage(store.duplicate());

    expect(dialledClientId()).not.toBe(original);
  });

  it("is minted fresh when the tab crashed without parking it", () => {
    const store = new FakeStore();
    loadPage(store);
    const original = dialledClientId();

    // No `pagehide` — the tab died. The next page has nothing to reclaim, which
    // is the pre-242 behaviour and costs a keyboard first-come hands straight
    // back, never a wrong answer.
    loadPage(store);

    expect(dialledClientId()).not.toBe(original);
  });

  it("is minted fresh where there is no storage to park it in", () => {
    loadPage(new FakeStore());
    const withStorage = dialledClientId();
    delete (globalThis as { window?: unknown }).window;

    new PanelLinkClient({
      url: "ws://panel.test/panel-link?v=1",
      createSocket: (url) => new FakeSocket(url),
    });

    expect(dialledClientId()).toMatch(/^tab-/);
    expect(dialledClientId()).not.toBe(withStorage);
  });

  it("is appended to a url that already carries a query, not pasted over it", () => {
    loadPage(new FakeStore());
    const url = new URL(FakeSocket.opened.at(-1)!.url);

    expect(url.searchParams.get("v")).toBe("1");
    expect(url.searchParams.get(PANEL_LINK_CLIENT_PARAM)).toMatch(/^tab-/);
  });
});

describe("what the service will take off an upgrade", () => {
  it("takes the id the browser mints", () => {
    expect(readPanelLinkClientId("tab-6f3c1b2a-0000-4000-8000-000000000000")).toBe(
      "tab-6f3c1b2a-0000-4000-8000-000000000000",
    );
  });

  it("reads an absent id as 'this socket is its own client'", () => {
    expect(readPanelLinkClientId(null)).toBeNull();
    expect(readPanelLinkClientId("")).toBeNull();
    expect(readPanelLinkClientId(undefined)).toBeNull();
  });

  it("refuses one it would have to repair rather than repairing it", () => {
    // A trimmed or truncated id no longer equals the one the tab believes it
    // holds, so it would reclaim nothing and the tab would have no way to know.
    expect(readPanelLinkClientId(" tab-a ")).toBeNull();
    expect(readPanelLinkClientId("tab a")).toBeNull();
    expect(readPanelLinkClientId("tab/../a")).toBeNull();
    expect(readPanelLinkClientId(`tab-${"x".repeat(200)}`)).toBeNull();
  });
});
