import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_SESSION_HEADER_BUTTON_VISIBILITY } from "~/shared/session-header-buttons";
import { DEFAULT_HEADER_BUTTON_VISIBILITY } from "~/shared/header-buttons";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-settings-test-"));
process.env.AC_USER_DATA_DIR = tmpRoot;

const { handleApiRequest } = await import("../api-router");
const { getDb } = await import("~/db/client");
const { appSettings } = await import("~/db/schema");
const { getOrCreateApiToken } = await import("../services/settings");
const { operatorSessionCookie } = await import("./_operator-session");

async function jsonBody(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

function authedRequest(input: string | URL, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("cookie")) headers.set("cookie", operatorSessionCookie());
  return new Request(input, { ...init, headers });
}

describe("settings API", () => {
  beforeEach(() => {
    getDb().delete(appSettings).run();
  });

  it("keeps mouse gradients enabled by default", async () => {
    const response = await handleApiRequest(
      authedRequest("http://localhost/api/settings"),
    );

    expect(response?.status).toBe(200);
    expect(await jsonBody(response!)).toMatchObject({
      mouseGradientDisabled: false,
    });
  });

  it("starts the terminal at the default zoom level", async () => {
    const response = await handleApiRequest(
      authedRequest("http://localhost/api/settings"),
    );

    expect(response?.status).toBe(200);
    expect(await jsonBody(response!)).toMatchObject({
      terminalZoomLevel: 0,
    });
  });

  it("keeps Claude usage limits off by default, with both windows shown", async () => {
    const response = await handleApiRequest(
      authedRequest("http://localhost/api/settings"),
    );

    expect(response?.status).toBe(200);
    expect(await jsonBody(response!)).toMatchObject({
      claudeUsageLimitsEnabled: false,
      claudeUsageLimitsShowSession: true,
      claudeUsageLimitsShowWeekly: true,
      providerUsageEnabled: false,
      providerUsageIds: ["claude", "codex", "cursor"],
    });
  });

  it("persists Claude usage limit toggles", async () => {
    const update = await handleApiRequest(
      authedRequest("http://localhost/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claudeUsageLimitsEnabled: true,
          claudeUsageLimitsShowWeekly: false,
        }),
      }),
    );
    expect(update?.status).toBe(200);

    const read = await handleApiRequest(
      authedRequest("http://localhost/api/settings"),
    );
    expect(await jsonBody(read!)).toMatchObject({
      claudeUsageLimitsEnabled: true,
      claudeUsageLimitsShowSession: true,
      claudeUsageLimitsShowWeekly: false,
    });
  });

  it("persists multi-provider usage toggles", async () => {
    const update = await handleApiRequest(
      authedRequest("http://localhost/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerUsageEnabled: true,
          providerUsageIds: ["claude", "codex"],
        }),
      }),
    );
    expect(update?.status).toBe(200);

    const read = await handleApiRequest(
      authedRequest("http://localhost/api/settings"),
    );
    expect(await jsonBody(read!)).toMatchObject({
      providerUsageEnabled: true,
      providerUsageIds: ["claude", "codex"],
      claudeUsageLimitsEnabled: true,
    });
  });

  it("defaults the agent launcher config to all agents visible in canonical order", async () => {
    const response = await handleApiRequest(authedRequest("http://localhost/api/settings"));
    expect(response?.status).toBe(200);
    expect(await jsonBody(response!)).toMatchObject({
      harnessLauncherConfig: {
        order: ["claude-code", "codex", "cursor-cli", "opencode"],
        hidden: [],
      },
    });
  });

  it("persists a reordered agent launcher config and normalizes unknown ids", async () => {
    const update = await handleApiRequest(
      authedRequest("http://localhost/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          harnessLauncherConfig: {
            order: ["codex", "made-up-agent", "claude-code"],
            hidden: ["opencode", "also-fake"],
          },
        }),
      }),
    );
    const read = await handleApiRequest(authedRequest("http://localhost/api/settings"));

    expect(update?.status).toBe(200);
    const expected = {
      order: ["codex", "claude-code", "cursor-cli", "opencode"],
      hidden: ["opencode"],
    };
    expect(await jsonBody(update!)).toMatchObject({ harnessLauncherConfig: expected });
    expect(await jsonBody(read!)).toMatchObject({ harnessLauncherConfig: expected });
  });

  it("refuses to hide every launcher agent", async () => {
    const update = await handleApiRequest(
      authedRequest("http://localhost/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          harnessLauncherConfig: {
            order: ["cursor-cli", "codex", "claude-code", "opencode"],
            hidden: ["claude-code", "codex", "cursor-cli", "opencode"],
          },
        }),
      }),
    );

    expect(update?.status).toBe(200);
    const body = await jsonBody(update!);
    const config = body.harnessLauncherConfig as { order: string[]; hidden: string[] };
    expect(config.hidden).not.toContain("cursor-cli");
    expect(config.order.filter((id) => !config.hidden.includes(id))).toEqual(["cursor-cli"]);
  });

  it("rejects a malformed agent launcher config payload", async () => {
    const update = await handleApiRequest(
      authedRequest("http://localhost/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ harnessLauncherConfig: "codex-first" }),
      }),
    );
    expect(update?.status).toBe(400);
  });

  it("persists the default terminal zoom level", async () => {
    const update = await handleApiRequest(
      authedRequest("http://localhost/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ terminalZoomLevel: 2 }),
      }),
    );
    const read = await handleApiRequest(
      authedRequest("http://localhost/api/settings"),
    );

    expect(update?.status).toBe(200);
    expect(await jsonBody(update!)).toMatchObject({ terminalZoomLevel: 2 });
    expect(await jsonBody(read!)).toMatchObject({ terminalZoomLevel: 2 });
  });

  it("hides the zoom session button by default and shows the rest", async () => {
    const response = await handleApiRequest(authedRequest("http://localhost/api/settings"));
    expect(await jsonBody(response!)).toMatchObject({
      sessionHeaderButtons: DEFAULT_SESSION_HEADER_BUTTON_VISIBILITY,
    });
    expect(DEFAULT_SESSION_HEADER_BUTTON_VISIBILITY).toMatchObject({
      rename: true,
      zoom: false,
      clone: true,
    });
  });

  it("persists session button visibility, merging a partial payload over defaults", async () => {
    const update = await handleApiRequest(
      authedRequest("http://localhost/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Only send the two the user changed; unknown keys are dropped and the
        // rest fall back to their defaults.
        body: JSON.stringify({ sessionHeaderButtons: { zoom: true, clone: false, bogus: true } }),
      }),
    );
    const read = await handleApiRequest(authedRequest("http://localhost/api/settings"));

    expect(update?.status).toBe(200);
    const expected = { rename: true, zoom: true, clone: false };
    expect(await jsonBody(update!)).toMatchObject({ sessionHeaderButtons: expected });
    expect(await jsonBody(read!)).toMatchObject({ sessionHeaderButtons: expected });
  });

  it("shows every top-bar and project-header button by default", async () => {
    const response = await handleApiRequest(authedRequest("http://localhost/api/settings"));
    expect(await jsonBody(response!)).toMatchObject({
      headerButtons: DEFAULT_HEADER_BUTTON_VISIBILITY,
    });
    expect(DEFAULT_HEADER_BUTTON_VISIBILITY).toMatchObject({
      notifications: true,
      gridView: true,
    });
  });

  it("persists header button visibility, merging a partial payload over defaults", async () => {
    const update = await handleApiRequest(
      authedRequest("http://localhost/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Only the two the user hid; unknown keys are dropped and the rest
        // fall back to their defaults.
        body: JSON.stringify({
          headerButtons: { notifications: false, bogus: true },
        }),
      }),
    );
    const read = await handleApiRequest(authedRequest("http://localhost/api/settings"));

    expect(update?.status).toBe(200);
    const expected = {
      ...DEFAULT_HEADER_BUTTON_VISIBILITY,
      notifications: false,
    };
    const persisted = await jsonBody(read!);
    expect(await jsonBody(update!)).toMatchObject({ headerButtons: expected });
    expect(persisted).toMatchObject({ headerButtons: expected });
    expect(persisted.headerButtons).not.toHaveProperty("bogus");
  });

  it("shows the group switcher and the project header group tag by default", async () => {
    const response = await handleApiRequest(authedRequest("http://localhost/api/settings"));
    expect(await jsonBody(response!)).toMatchObject({
      showGroupSwitcher: true,
      showProjectHeaderGroup: true,
    });
  });

  it("persists hiding the group switcher and the project header group tag", async () => {
    const update = await handleApiRequest(
      authedRequest("http://localhost/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ showGroupSwitcher: false, showProjectHeaderGroup: false }),
      }),
    );
    const read = await handleApiRequest(authedRequest("http://localhost/api/settings"));

    expect(update?.status).toBe(200);
    expect(await jsonBody(update!)).toMatchObject({
      showGroupSwitcher: false,
      showProjectHeaderGroup: false,
    });
    expect(await jsonBody(read!)).toMatchObject({
      showGroupSwitcher: false,
      showProjectHeaderGroup: false,
    });
  });

  it("rejects an unsafe default model value", async () => {
    const update = await handleApiRequest(
      authedRequest("http://localhost/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaultModel: "gpt-4; rm -rf /" }),
      }),
    );
    expect(update?.status).toBe(400);
  });

  it("defaults Ship to Claude Code with the sync prompt until customized", async () => {
    const response = await handleApiRequest(authedRequest("http://localhost/api/settings"));
    expect(await jsonBody(response!)).toMatchObject({
      shipHarness: "claude-code",
      shipModel: null,
      shipPrompt:
        "commit my changes, then push my latest branch changes to remote, and if upstream changes exist, pull them, fix conflict, and push when resolved.",
    });
  });

  it("rejects an unsafe ship model value", async () => {
    const update = await handleApiRequest(
      authedRequest("http://localhost/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shipModel: "gpt-4; rm -rf /" }),
      }),
    );
    expect(update?.status).toBe(400);
  });

  it("persists the mouse gradient preference", async () => {
    const update = await handleApiRequest(
      authedRequest("http://localhost/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mouseGradientDisabled: true }),
      }),
    );
    const read = await handleApiRequest(
      authedRequest("http://localhost/api/settings"),
    );

    expect(update?.status).toBe(200);
    expect(await jsonBody(update!)).toMatchObject({
      mouseGradientDisabled: true,
    });
    expect(await jsonBody(read!)).toMatchObject({
      mouseGradientDisabled: true,
    });
  });

  it("keeps notification sound enabled by default", async () => {
    const response = await handleApiRequest(
      authedRequest("http://localhost/api/settings"),
    );

    expect(response?.status).toBe(200);
    expect(await jsonBody(response!)).toMatchObject({
      notificationSoundEnabled: true,
    });
  });

  it("persists the notification sound preference", async () => {
    const update = await handleApiRequest(
      authedRequest("http://localhost/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notificationSoundEnabled: false }),
      }),
    );
    const read = await handleApiRequest(
      authedRequest("http://localhost/api/settings"),
    );

    expect(update?.status).toBe(200);
    expect(await jsonBody(update!)).toMatchObject({
      notificationSoundEnabled: false,
    });
    expect(await jsonBody(read!)).toMatchObject({
      notificationSoundEnabled: false,
    });
  });

  it("leaves durable UI preferences unset by default", async () => {
    const response = await handleApiRequest(
      authedRequest("http://localhost/api/settings"),
    );

    expect(response?.status).toBe(200);
    expect(await jsonBody(response!)).toMatchObject({
      projectsDashboardView: null,
    });
  });

  it("keeps the question overlay enabled", async () => {
    const response = await handleApiRequest(authedRequest("http://localhost/api/settings"));
    expect(await jsonBody(response!)).toMatchObject({ questionOverlayEnabled: true });
  });

  it("ignores attempts from older clients to disable the question overlay", async () => {
    const update = await handleApiRequest(
      authedRequest("http://localhost/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionOverlayEnabled: false }),
      }),
    );
    const read = await handleApiRequest(authedRequest("http://localhost/api/settings"));

    expect(update?.status).toBe(200);
    expect(await jsonBody(update!)).toMatchObject({ questionOverlayEnabled: true });
    expect(await jsonBody(read!)).toMatchObject({ questionOverlayEnabled: true });
  });

  it("persists durable UI preferences", async () => {
    const update = await handleApiRequest(
      authedRequest("http://localhost/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectsDashboardView: "table",
        }),
      }),
    );
    const read = await handleApiRequest(
      authedRequest("http://localhost/api/settings"),
    );

    expect(update?.status).toBe(200);
    expect(await jsonBody(update!)).toMatchObject({
      projectsDashboardView: "table",
    });
    expect(await jsonBody(read!)).toMatchObject({
      projectsDashboardView: "table",
    });
  });

  // Spec 12: the theming keys are gone from the settings surface. A stale
  // renderer writing any of them must fail loudly (strict schema -> 400), not
  // silently no-op — mirrors the spec-07 dropped-key cases above.
  it.each([
    ["accentColor", "teal"],
    ["themeStyle", "flat"],
    ["minimalTheme", true],
    ["surfaceTint", "subtle"],
    ["backgroundImage", null],
    ["showBackgroundGrid", false],
    ["interfaceFontFamily", null],
    ["interfaceFontScale", 1],
    ["terminalFontFamily", null],
    ["terminalFontWeight", 400],
    ["terminalFontWeightBold", 700],
    ["terminalLineHeight", 1.0],
    ["terminalLetterSpacing", 0],
    ["launchOverlayEnabled", true],
  ] as const)(
    "rejects the removed theming key %s with 400",
    async (key, value) => {
      const update = await handleApiRequest(
        authedRequest("http://localhost/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ [key]: value }),
        }),
      );
      expect(update?.status).toBe(400);
    },
  );

  it("omits the removed theming keys and themeChosen from the GET payload", async () => {
    const response = await handleApiRequest(
      authedRequest("http://localhost/api/settings"),
    );
    const body = await jsonBody(response!);
    for (const key of [
      "accentColor",
      "themeStyle",
      "minimalTheme",
      "themeChosen",
      "surfaceTint",
      "backgroundImage",
      "showBackgroundGrid",
      "interfaceFontFamily",
      "interfaceFontScale",
      "terminalFontFamily",
      "terminalFontWeight",
      "terminalFontWeightBold",
      "terminalLineHeight",
      "terminalLetterSpacing",
      "launchOverlayEnabled",
    ]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  // Regression: GET /api/settings used to anonymously return the machine hook
  // token in the JSON body, collapsing the entire auth tier.
  // See todos/bugs/done/02-api-settings-leaks-bearer-token.md.
  it("never returns the agent hook token over HTTP", async () => {
    const token = getOrCreateApiToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const getResponse = await handleApiRequest(
      authedRequest("http://localhost/api/settings"),
    );
    const getBody = await jsonBody(getResponse!);
    expect(getResponse?.status).toBe(200);
    expect(getBody).not.toHaveProperty("apiToken");
    expect(JSON.stringify(getBody)).not.toContain(token);

    const postResponse = await handleApiRequest(
      authedRequest("http://localhost/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ regenerate: true }),
      }),
    );
    // The schema rejects `regenerate` outright (strict object) so the request
    // never reaches a code path that could rotate or echo the token.
    expect(postResponse?.status).toBe(400);
    const postBody = await jsonBody(postResponse!);
    expect(postBody).not.toHaveProperty("apiToken");
    expect(JSON.stringify(postBody)).not.toContain(token);

    const tokenAfterRegenerateAttempt = getOrCreateApiToken();
    expect(tokenAfterRegenerateAttempt).toBe(token);
  });
});
