#!/usr/bin/env node
// End-to-end test — the Panel on a phone (#836, feature #829).
//
// Boots the *built* Panel service and a real Core exactly as
// `scripts/e2e-panel-smoke.mjs` does, then drives the Panel in Chrome with a
// 390 x 844 touch screen (puppeteer), the way an Operator holding a phone
// would: what it taps is what is on screen at that width, found by the roles,
// labels and text the mobile UI really has. Nothing here imports the Panel's own
// code.
//
// Setting up the Operator and pairing the Core are not what this test is about,
// so they go over HTTP, as in the smoke. Everything after — sign in, Fleet, the
// Cores drawer, a Core, a terminal, a Task, Settings — is done through the
// phone's UI.
//
// The legs, in order, each followed by a check that the page does not scroll
// sideways:
//
//   1. open the Panel      — the sign-in screen, then Fleet;
//   2. open a Core         — Cores drawer → the Core's page, its tab bar;
//   3. open a terminal     — New session sheet (and Cancel), then the Core's
//                            Terminals screen: a new shell prints what is typed;
//   4. create a Task       — Tasks tab → New Task sheet → Save as draft → the
//                            Task's detail opens → Back → the card is on the board;
//   5. open Task detail    — tap the card; the detail page shows the title;
//   6. Settings and an API key — Cores drawer → Settings → API & integrations →
//                            Create API key → the key is shown once, and works.
//
// Why a *shell* terminal and a *draft* Task: a bare CI runner has no harness
// CLI (claude, codex, …), so New session cannot start a Session there and a
// Task cannot be assigned to an Agent. The Core's own Terminals screen needs
// neither — it is a login shell on the Core's machine — and a draft needs only
// a title. See each leg.
//
// Why the Core's Shared folder row is deleted after pairing: a Core paired from
// the Panel is "pending" until its Shared folder (S3) is attached, and the Panel
// shows the pairing wizard instead of the app while it is (`FirstRunGate`). A
// runner has no S3; a Core without the row is what a CLI-paired Core looks like
// (`isPairingFinished`), and it is the app the phone legs are about.
//
// Usage:
//   node scripts/e2e-panel-phone.mjs [--panel-entry <file>] [--core-entry <file>]
//                                    [--screenshots <dir>]
//
// Build first (CI does, in the `pnpm panel:e2e` step before this one):
//   pnpm --filter @actana/core build && pnpm --filter @actana/panel build
//
// Exit codes: 0 on pass, non-zero on any failed leg. On failure the tail of the
// Panel's, the Core's and the page's output is printed and a screenshot of the
// failing screen is written (to --screenshots, or a temp directory named in the
// log). With --screenshots, a picture of every leg that passed is kept too.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import puppeteer from "puppeteer";

import { makeDie } from "./lib/core-smoke.mjs";
import { startLocalCore } from "./lib/core-fixture.mjs";
import { allocatePanelDatabase, ensurePanelDatabase, queryPanelDatabase } from "./lib/postgres-fixture.mjs";
import { delay, pickFreePort, pollUntil, startPanelService } from "./lib/panel-e2e.mjs";
import {
  CHROME_ARGS,
  LegError,
  PHONE_USER_AGENT,
  PHONE_VIEWPORT,
  formatLegFailure,
  hasHorizontalOverflow,
  legFileName,
  looksLikeApiKey,
  parsePhoneArgs,
  runLeg,
  shellEchoCommand,
} from "./lib/panel-phone-e2e.mjs";

const die = makeDie("panel-phone-e2e");
const log = (message) => console.log(`[panel-phone-e2e] ${message}`);

const OPERATOR_NAME = "phone-operator";
const OPERATOR_PASSWORD = "correct-horse-battery-staple";

/** One wait for one thing on screen (a button to appear, a sheet to close). */
const ACTION_TIMEOUT_MS = 20_000;
/** Booting a Core, a Panel and a Chrome. */
const DIAL_TIMEOUT_MS = 30_000;
/** A new shell printing what was typed into it: spawn, PTY frames, xterm. */
const SHELL_ATTEMPT_TIMEOUT_MS = 5_000;
const SHELL_ATTEMPTS = 6;
/** The backstop for a whole leg; every wait inside has a bound of its own. */
const LEG_TIMEOUT_MS = 150_000;

/**
 * Everything to tear down, newest first, whatever happens. Synchronous on
 * purpose: a failed leg ends the run through `die()` → `process.exit`, and an
 * `exit` handler cannot await.
 */
const teardown = [];

/** What the page said while the legs ran: console errors, page errors, failed requests. */
const pageNotes = [];

async function main() {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  let options;
  try {
    options = parsePhoneArgs(process.argv.slice(2), repoRoot);
  } catch (err) {
    die(err.message);
  }
  const panelBin = path.join(repoRoot, "packages", "panel", "bin", "panel.mjs");
  const { panelEntry, coreEntry, screenshotsDir } = options;
  if (!fs.existsSync(panelEntry)) die(`no built Panel at ${panelEntry} — run \`pnpm build:web\` first`);
  if (!fs.existsSync(coreEntry)) {
    die(`no built Core at ${coreEntry} — run \`pnpm --filter @actana/core build\` first`);
  }

  log(`node=${process.execPath} (${process.version})`);
  log(`panel=${panelEntry}`);
  log(`core=${coreEntry}`);

  const core = await startLocalCore({ entry: coreEntry, log }).catch((err) =>
    die(`core fixture failed to boot: ${err.message}`, err.logLines),
  );
  teardown.push(() => core.stop());

  // The Panel refuses to start without a Postgres (#567); one runs beside it.
  teardown.push(await ensurePanelDatabase({ name: `ac-e2e-phone-pg-${process.pid}`, log }));
  const { url: databaseUrl } = await allocatePanelDatabase({ label: "phone", log });

  const dataDir = tempDir("ac-e2e-phone-");
  const port = await pickFreePort();
  const panel = await startPanelService({
    bin: panelBin,
    serverEntry: panelEntry,
    dataDir,
    port,
    extra: { AC_PANEL_DATABASE_URL: databaseUrl },
    log,
  }).catch((err) => die(`panel failed to boot: ${err.message}`, err.logLines));
  teardown.push(() => panel.kill());

  const tail = () => [...panel.logLines(), ...core.logLines(), ...pageNotes];
  const fail = (message) => die(message, tail());

  const paired = await setUpOperatorAndPairCore({ panel, core, databaseUrl }).catch((err) =>
    fail(`setup failed: ${err.message}`),
  );

  const browser = await puppeteer.launch({ headless: true, args: [...CHROME_ARGS] }).catch((err) =>
    fail(
      `Chrome failed to launch: ${err.message} — puppeteer downloads it on install ` +
        "(`pnpm install`, or `npx puppeteer browsers install chrome`)",
    ),
  );
  teardown.push(() => browser.process()?.kill("SIGKILL"));
  log(`chrome ${await browser.version()}`);

  const page = await browser.newPage();
  await page.setViewport({ ...PHONE_VIEWPORT });
  await page.setUserAgent(PHONE_USER_AGENT);
  watchPage(page);

  const ctx = {
    page,
    origin: panel.origin,
    coreId: paired.coreId,
    coreLabel: paired.coreLabel,
    taskTitle: `Phone e2e task ${randomBytes(3).toString("hex")}`,
    apiKeyName: `phone-e2e-${randomBytes(3).toString("hex")}`,
    shellId: randomBytes(4).toString("hex"),
  };

  const legs = [
    ["open the Panel", legOpenThePanel],
    ["open a Core", legOpenACore],
    ["open a terminal", legOpenATerminal],
    ["create a Task", legCreateATask],
    ["open Task detail", legOpenTaskDetail],
    ["open Settings and create an API key", legSettingsAndApiKey],
  ];
  let index = 0;
  for (const [name, run] of legs) {
    index += 1;
    try {
      await runLeg({ index, name, run: () => run(ctx), timeoutMs: LEG_TIMEOUT_MS, log });
      await assertNoHorizontalScroll(page, `the end of leg ${index} (${name})`);
      if (screenshotsDir) await screenshot(page, path.join(screenshotsDir, legFileName(index, name)));
    } catch (err) {
      const leg = err instanceof LegError ? err : new LegError({ index, name, cause: err });
      const shot = await screenshot(
        page,
        path.join(screenshotsDir ?? path.join(os.tmpdir(), `panel-phone-e2e-${process.pid}`), legFileName(index, name, { failed: true })),
      );
      log(`screenshot of the failing screen: ${shot ?? "(could not be taken)"}`);
      fail(`${formatLegFailure(leg)} — page: ${await describePage(page)}`);
    }
  }

  await browser.close().catch(() => undefined);
  await panel.stop();
  log("OK — the Panel works on a phone, end to end");
}

// ─── Setup over HTTP ─────────────────────────────────────────────────────────

/** The Operator and a paired, connected Core — the smoke's setup, and what the phone then finds. */
async function setUpOperatorAndPairCore({ panel, core, databaseUrl }) {
  const setup = await panel.client.post("/api/auth/setup", { name: OPERATOR_NAME, password: OPERATOR_PASSWORD });
  if (setup.status !== 200) throw new Error(`setup: expected 200, got ${setup.status} (${setup.text.slice(0, 200)})`);

  const inspected = await panel.client.post("/api/cores/pairing/inspect", { address: core.address });
  if (inspected.status !== 200) {
    throw new Error(`pairing inspect: expected 200, got ${inspected.status} (${inspected.text.slice(0, 200)})`);
  }
  if (inspected.body?.identity?.fingerprint !== core.caFingerprint) {
    throw new Error(`the Panel was presented ${inspected.body?.identity?.fingerprint}, expected ${core.caFingerprint}`);
  }
  const { code, sessionId } = core.newPairing();
  const added = await panel.client.post("/api/cores/pairing", {
    address: core.address,
    code,
    sessionId,
    expectedFingerprint: core.caFingerprint,
    label: "e2e-core",
  });
  if (added.status !== 201) throw new Error(`pair Core: expected 201, got ${added.status} (${added.text.slice(0, 200)})`);
  const coreId = added.body?.core?.id;
  const coreLabel = added.body?.core?.label;
  if (typeof coreId !== "string" || !coreId) throw new Error(`pairing returned no id: ${added.text.slice(0, 200)}`);
  if (typeof coreLabel !== "string" || !coreLabel) throw new Error(`pairing returned no label: ${added.text.slice(0, 200)}`);

  // See the header: without this the Panel shows the pairing wizard, not the app.
  await queryPanelDatabase(databaseUrl, "delete from core_shared_folders where core_id = $1", [coreId]);

  await pollUntil(`Core ${coreId} to reach connected`, DIAL_TIMEOUT_MS, async () => {
    const listed = await panel.client.get("/api/cores");
    const row = listed.body?.cores?.find((c) => c.id === coreId);
    return row?.dial?.state === "connected" && row.sharedFolder === undefined ? row : null;
  });
  log(`paired Core "${coreLabel}" (${coreId}), connected`);
  return { coreId, coreLabel };
}

// ─── Legs ────────────────────────────────────────────────────────────────────

/** Leg 1 — the sign-in screen on a phone, then Fleet. (AuthCard.tsx, login.tsx, FleetView.tsx, MobileTopBar.tsx) */
async function legOpenThePanel({ page, origin, coreLabel }) {
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT_MS });

  // The unauthenticated document is sent to /login (documentAuthRedirect).
  const password = await waitFor(page, "the sign-in password field", {
    css: 'form input[type="password"]',
  });
  const phone = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    isPhone: window.matchMedia("(max-width: 767px)").matches,
  }));
  if (phone.innerWidth !== PHONE_VIEWPORT.width || !phone.isPhone) {
    throw new Error(`the page is not on the phone breakpoint: ${JSON.stringify(phone)}`);
  }
  await waitFor(page, "the Sign in heading", { css: "h1", text: "Sign in" });
  await assertNoHorizontalScroll(page, "the sign-in screen");

  await typeInto(page, password, OPERATOR_PASSWORD);
  await tap(page, "the Sign in button", { css: 'form button[type="submit"]', text: "Sign in" });

  // A full page load follows (login.tsx), so the next waits ride out a navigation.
  await waitFor(page, "Fleet for the phone (data-fleet-compact=phone) listing the one Core", {
    css: '[data-fleet-compact="phone"]',
    match: "across 1 Core\\b",
  });
  await waitFor(page, 'the top bar saying "Fleet"', { css: "header.mc-mobile-topbar", match: "Fleet" });
  await waitFor(page, `the Fleet button "Open ${coreLabel}"`, { css: "button", text: `Open ${coreLabel}` });
}

/** Leg 2 — the Cores drawer, then the Core's page with its bottom tab bar. (MobileTopBar.tsx, CoresDrawer.tsx, CorePage.tsx, CoreTabBar.tsx) */
async function legOpenACore({ page, coreId, coreLabel }) {
  await tap(page, "the top bar's Open Cores menu button", {
    css: 'header.mc-mobile-topbar button[aria-label="Open Cores menu"]',
  });
  await waitFor(page, "the Cores drawer", { css: '[role="dialog"][aria-label="Cores"]' });
  await assertNoHorizontalScroll(page, "the Cores drawer");
  await tap(page, `the drawer row for ${coreLabel}`, {
    css: `a[href="/cores/${coreId}"]`,
    within: '[role="dialog"][aria-label="Cores"]',
  });

  await waitUntil(page, `the route to be /cores/${coreId}`, (id) => window.location.pathname === `/cores/${id}`, coreId);
  await waitForGone(page, "the Cores drawer to close", { css: '[role="dialog"][aria-label="Cores"]' });
  await waitFor(page, `the top bar saying "${coreLabel}"`, { css: "header.mc-mobile-topbar", match: escapeRegExp(coreLabel) });
  // "online · shared —": the link state is the first word of the status line.
  await waitFor(page, "the Core's status line to say online", { css: "[data-core-status-line]", match: "^online\\b" });
  const sections = "nav[aria-label='Core sections']";
  for (const tab of ["Sessions", "Files", "Tasks"]) {
    await waitFor(page, `the ${tab} tab of the bottom tab bar`, { css: `${sections} button`, text: tab });
  }
  await waitFor(page, "the Sessions tab to be the current one", {
    css: `${sections} button[aria-current="page"]`,
    text: "Sessions",
  });
}

/**
 * Leg 3 — the New session sheet, then a shell on the Core's machine.
 * (CorePage.tsx, NewHarnessDialog.tsx, FullScreenSheet.tsx, UserTerminalPanel.tsx,
 * UserTerminalPane.tsx, TerminalKeyRow.tsx)
 *
 * New session is only opened and cancelled: a runner has no harness CLI to
 * start a Session with. The Terminals screen is a login shell on the Core.
 */
async function legOpenATerminal({ page, shellId }) {
  await waitFor(page, 'the empty Sessions state ("No Sessions yet")', { css: "h1,h2,h3,div,p", text: "No Sessions yet" });
  await tap(page, "the New session button", { css: "button", text: "New session" });
  await waitFor(page, 'the "Start a new session" sheet', { css: ".mc-sheet-title", text: "Start a new session" });
  await assertNoHorizontalScroll(page, "the New session sheet");
  await tap(page, "the sheet's Cancel button", { css: ".mc-sheet-header button", text: "Cancel" });
  await waitForGone(page, "the New session sheet to close", { css: "[data-full-screen-sheet]" });

  await tap(page, "the Terminals button of the Sessions toolbar", {
    css: '[data-sessions-toolbar] button[aria-label="Terminals"]',
  });
  const screen = "[data-user-terminal-screen]";
  await waitFor(page, "the Terminals screen", { css: screen });
  await tap(page, "the New Terminal (+) button of the terminal tab strip", {
    css: 'button[aria-label="New Terminal"]',
    within: screen,
  });
  const input = await waitFor(page, "the terminal's keyboard input (xterm)", {
    css: ".xterm-helper-textarea",
    within: screen,
    react: false,
  });
  await waitFor(page, "the terminal key row (Esc, Tab, Ctrl, arrows, paste)", {
    css: '[role="toolbar"][aria-label="Terminal keys"]',
  });
  await assertNoHorizontalScroll(page, "the terminal screen");

  // What is typed before the shell has started is dropped (the pane wires its
  // input once the PTY exists), and a login shell may print no prompt a test
  // could wait for — so type, then wait for the output; if it never came, type
  // again. The command is idempotent.
  const { marker, typed } = shellEchoCommand(shellId);
  for (let attempt = 1; attempt <= SHELL_ATTEMPTS; attempt++) {
    await input.focus();
    await page.keyboard.type(typed);
    await page.keyboard.press("Enter");
    const seen = await page
      .waitForFunction(
        (needle) => {
          const rows = document.querySelector("[data-user-terminal-screen] .xterm-rows");
          return !!rows && rows.textContent.includes(needle);
        },
        { timeout: SHELL_ATTEMPT_TIMEOUT_MS, polling: 100 },
        marker,
      )
      .then(() => true, () => false);
    if (seen) break;
    if (attempt === SHELL_ATTEMPTS) {
      const shown = await page.evaluate(
        () => document.querySelector("[data-user-terminal-screen] .xterm-rows")?.textContent ?? "(no .xterm-rows — not the DOM renderer?)",
      );
      throw new Error(
        `timed out after ${SHELL_ATTEMPTS * SHELL_ATTEMPT_TIMEOUT_MS}ms waiting for the shell to print ${marker} ` +
          `(typed ${SHELL_ATTEMPTS} times); the terminal showed: ${JSON.stringify(shown.slice(0, 300))}`,
      );
    }
  }
  log(`the shell printed ${marker}`);

  await tap(page, "the terminal screen's Back button", { css: 'button[aria-label="Back"]', within: screen });
  await waitForGone(page, "the Terminals screen to close", { css: screen });
  await waitFor(page, "the Core's Sessions page again", { css: "[data-core-status-line]" });
}

/**
 * Leg 4 — a draft Task from the Core's Tasks tab. (CoreTabBar.tsx, TasksBoard.tsx
 * with its New Task button, NewTaskDialog.tsx, FullScreenSheet.tsx, TaskDetail.tsx, TaskCard.tsx)
 *
 * "Save as draft", not "Create & assign": assigning needs a runnable Agent on
 * the Core, which a runner without a harness CLI does not have.
 */
async function legCreateATask({ page, taskTitle }) {
  await tap(page, "the Tasks tab of the bottom tab bar", {
    css: "nav[aria-label='Core sections'] button",
    text: "Tasks",
  });
  await waitFor(page, "the Tasks board's column tabs", { css: '[role="tablist"][aria-label="Board column"]' });
  await tap(page, "the New Task button", { css: "button.mc-tasks-fab", text: "New Task" });

  const sheet = "[data-full-screen-sheet]";
  await waitFor(page, 'the "New Task" sheet', { css: ".mc-sheet-title", text: "New Task", within: sheet });
  await assertNoHorizontalScroll(page, "the New Task sheet");
  const title = await waitFor(page, "the sheet's Title field", { css: 'input[aria-label="Title"]', within: sheet });
  await typeInto(page, title, taskTitle);
  await tap(page, 'the "Save as draft" button', { css: "button", text: "Save as draft", within: sheet });

  // Creating a Task opens its detail (TasksBoard: onCreated → setOpen).
  await waitForGone(page, "the New Task sheet to close", { css: sheet });
  const detail = '[role="dialog"][aria-label="Task detail"]';
  await waitFor(page, `the new Task's detail page titled "${taskTitle}"`, { css: "h2", text: taskTitle, within: detail });
  await tap(page, "the Task detail's Back button", { css: 'button[aria-label="Back"]', within: detail });
  await waitForGone(page, "the Task detail to close", { css: detail });
  await waitFor(page, `the Task card "${taskTitle}" on the board`, { css: `[data-task-card][aria-label="Open task ${taskTitle}"]` });
}

/** Leg 5 — tap the card; the detail page shows the Task. (TaskCard.tsx, TaskDetail.tsx) */
async function legOpenTaskDetail({ page, taskTitle }) {
  await tap(page, `the Task card "${taskTitle}"`, { css: `[data-task-card][aria-label="Open task ${taskTitle}"]` });
  const detail = '[role="dialog"][aria-label="Task detail"]';
  await waitFor(page, "the Task detail page", { css: detail });
  await waitFor(page, `the Task's title "${taskTitle}" in the detail`, { css: "h2", text: taskTitle, within: detail });
  await waitFor(page, "the Task's id line (TASK · …)", { css: '[data-testid="task-detail-body"]', match: "TASK ·", within: detail });
  await assertNoHorizontalScroll(page, "the Task detail");
  await tap(page, "the Task detail's Back button", { css: 'button[aria-label="Back"]', within: detail });
  await waitForGone(page, "the Task detail to close", { css: detail });
}

/**
 * Leg 6 — Settings from the drawer, API & integrations, Create API key.
 * (CoresDrawer.tsx, SettingsPanel.tsx PhoneSettings, ApiSettingsPage.tsx)
 *
 * The key is shown once in a sheet; it is then used as a Bearer token to read
 * the Tasks, which proves the Panel really minted it.
 */
async function legSettingsAndApiKey({ page, origin, taskTitle, apiKeyName }) {
  const drawer = '[role="dialog"][aria-label="Cores"]';
  await tap(page, "the top bar's Open Cores menu button", {
    css: 'header.mc-mobile-topbar button[aria-label="Open Cores menu"]',
  });
  await waitFor(page, "the Cores drawer", { css: drawer });
  await tap(page, "the drawer's Settings button", { css: "button", text: "Settings", within: drawer });

  const overlay = "[data-settings-overlay]";
  await waitFor(page, "the Settings list", { css: "nav[aria-label='Settings'] button.mc-settings-row", within: overlay });
  await assertNoHorizontalScroll(page, "the Settings list");
  await tap(page, 'the "API & integrations" row', {
    css: "nav[aria-label='Settings'] button.mc-settings-row",
    text: "API & integrations",
    within: overlay,
  });
  const apiPage = '[data-settings-page="api"]';
  await waitFor(page, "the API & integrations page", { css: "h1,h2,h3,h4", text: "API keys", within: apiPage });
  await assertNoHorizontalScroll(page, "the API & integrations page");

  await tap(page, "the Create API key button", { css: "button", text: "Create API key", within: apiPage });
  const sheet = "[data-full-screen-sheet]";
  await waitFor(page, 'the "Create API key" sheet', { css: ".mc-sheet-title", text: "Create API key", within: sheet });
  await assertNoHorizontalScroll(page, "the Create API key sheet");
  const name = await waitFor(page, "the sheet's Name field", { labelFor: "Name", within: sheet });
  await typeInto(page, name, apiKeyName);
  // A Core scope must be chosen: All Cores is never the silent default (#688).
  await tap(page, 'the "All Cores" choice', { css: "[data-core-scope] label", text: "All Cores", within: sheet });
  await tap(page, "the sheet's Create button", { css: ".mc-sheet-action-primary", text: "Create", within: sheet });

  const shown = '[data-shown-once="api-key"]';
  await waitFor(page, 'the "Copy your API key" sheet', { css: ".mc-sheet-title", text: "Copy your API key" });
  const keyHandle = await waitFor(page, "the key shown once", { css: "pre", within: shown });
  const key = (await keyHandle.evaluate((el) => el.textContent ?? "")).trim();
  if (!looksLikeApiKey(key)) throw new Error(`the key shown does not look like a Panel API key: ${JSON.stringify(key.slice(0, 12))}…`);
  await assertNoHorizontalScroll(page, "the shown-once key sheet");
  await tap(page, "the shown-once sheet's Done button", { css: ".mc-sheet-footer button", text: "Done" });
  await waitForGone(page, "the shown-once sheet to close", { css: "[data-full-screen-sheet]" });
  await waitFor(page, `the new key "${apiKeyName}" in the API keys list`, { css: "div,span", match: escapeRegExp(apiKeyName), within: apiPage });

  const read = await fetch(`${origin}/api/v1/tasks`, { headers: { authorization: `Bearer ${key}` } });
  const body = await read.text();
  if (read.status !== 200 || !body.includes(taskTitle)) {
    throw new Error(`the new API key could not read the Tasks: ${read.status} ${body.slice(0, 200)}`);
  }
  log(`the key ${apiKeyName} works: GET /api/v1/tasks listed "${taskTitle}"`);
}

// ─── Driving the page ────────────────────────────────────────────────────────

/**
 * Find one element on screen. Runs in the page (puppeteer serialises it), so
 * it is self-contained.
 *
 * - `css` (+ `within`): candidates, optionally only inside a visible container;
 * - `text`: the whole text, whitespace-collapsed, equals this; `match`: a
 *   regular expression (source) the text must match;
 * - `labelFor`: instead of `css`, the field a visible <label> with this text
 *   points at;
 * - it must be visible, and (unless `enabled: false`) not disabled;
 * - `gone`: the other way round — resolves once nothing matches;
 * - and React must own it (unless `react: false`) — an element that is in the
 *   server-rendered HTML but not yet hydrated has no handlers, and a tap on it
 *   would do what a plain <form> or <button> does without JavaScript.
 */
function findInPage(spec) {
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  const hydrated = (el) => Object.keys(el).some((k) => k.startsWith("__reactProps$"));
  const roots = spec.within ? [...document.querySelectorAll(spec.within)].filter(visible) : [document];
  const matcher = spec.match === undefined ? null : new RegExp(spec.match);
  for (const root of roots) {
    let candidates;
    if (spec.labelFor !== undefined) {
      candidates = [...root.querySelectorAll("label")]
        .filter((label) => visible(label) && norm(label.textContent) === spec.labelFor)
        .map((label) => (label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector("input,textarea,select")))
        .filter(Boolean);
    } else {
      candidates = [...root.querySelectorAll(spec.css)];
    }
    for (const el of candidates) {
      if (!visible(el)) continue;
      if (spec.text !== undefined && norm(el.textContent) !== spec.text) continue;
      if (matcher && !matcher.test(norm(el.textContent))) continue;
      if (spec.enabled !== false && (el.disabled || el.getAttribute("aria-disabled") === "true")) continue;
      if (spec.react !== false && !hydrated(el)) continue;
      return spec.gone ? null : el;
    }
  }
  // `gone`: true (truthy) once nothing matches.
  return spec.gone ? true : null;
}

function describeSpec(spec) {
  const parts = [spec.labelFor !== undefined ? `label "${spec.labelFor}"` : spec.css];
  if (spec.within) parts.push(`in ${spec.within}`);
  if (spec.text !== undefined) parts.push(`text "${spec.text}"`);
  if (spec.match !== undefined) parts.push(`text /${spec.match}/`);
  return parts.join(" ");
}

const NAVIGATION_RACE = /Execution context was destroyed|Cannot find context|detached|Target closed|Session closed/i;

/** Run a puppeteer wait, riding out a page navigation, with a failure message that says what was awaited. */
async function bounded(page, label, detail, timeoutMs, attempt) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    try {
      return await attempt(Math.max(remaining, 1));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (NAVIGATION_RACE.test(message) && Date.now() < deadline) {
        await delay(200); // a navigation is in flight: try again in the new document
        continue;
      }
      if (err?.name === "TimeoutError" || NAVIGATION_RACE.test(message)) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for ${label} [${detail}] — page: ${await describePage(page)}`);
      }
      throw err;
    }
  }
}

/** Wait for an element (see {@link findInPage}) and return its handle. */
async function waitFor(page, label, spec, { timeoutMs = ACTION_TIMEOUT_MS } = {}) {
  const handle = await bounded(page, label, describeSpec(spec), timeoutMs, (remaining) =>
    page.waitForFunction(findInPage, { timeout: remaining, polling: 100 }, spec),
  );
  return handle.asElement();
}

/** Wait until nothing on screen matches. */
async function waitForGone(page, label, spec, { timeoutMs = ACTION_TIMEOUT_MS } = {}) {
  await bounded(page, label, describeSpec(spec), timeoutMs, (remaining) =>
    page.waitForFunction(findInPage, { timeout: remaining, polling: 100 }, { ...spec, gone: true, enabled: false, react: false }),
  );
}

/** Wait until `predicate(arg)` is true in the page. */
async function waitUntil(page, label, predicate, arg, { timeoutMs = ACTION_TIMEOUT_MS } = {}) {
  await bounded(page, label, "condition in the page", timeoutMs, (remaining) =>
    page.waitForFunction(predicate, { timeout: remaining, polling: 100 }, arg),
  );
}

/** Wait for an element, then tap it with a finger. */
async function tap(page, label, spec, opts) {
  const handle = await waitFor(page, label, spec, opts);
  await handle.tap();
}

/** Tap a text field, type into it, and check every key arrived. */
async function typeInto(page, handle, text) {
  await handle.tap();
  await handle.focus();
  await page.keyboard.type(text);
  await bounded(page, `the field to hold what was typed (${text.length} characters)`, "input value", ACTION_TIMEOUT_MS, (remaining) =>
    page.waitForFunction((el, value) => el.value === value, { timeout: remaining, polling: 100 }, handle, text),
  );
}

/**
 * Fail if the page scrolls sideways: the document's scrolling element must be
 * no wider than the phone. Dialogs and sheets that are wider than themselves
 * are only reported — they clip, they do not scroll the page.
 */
async function assertNoHorizontalScroll(page, where) {
  const measured = await page.evaluate((phoneWidth) => {
    const scroller = document.scrollingElement ?? document.documentElement;
    const wide = [...document.querySelectorAll('[role="dialog"], [data-settings-overlay]')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0)
      .map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute("aria-label") ?? el.className}] ${el.scrollWidth}>${el.clientWidth}`);
    const beyond = [...document.body.querySelectorAll("*")]
      .filter((el) => el.getBoundingClientRect().right > phoneWidth + 1 && getComputedStyle(el).position !== "fixed")
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} right=${Math.round(el.getBoundingClientRect().right)}`);
    return { scrollWidth: scroller.scrollWidth, innerWidth: window.innerWidth, wide, beyond };
  }, PHONE_VIEWPORT.width);
  for (const note of measured.wide) log(`warning: wider than itself on ${where}: ${note}`);
  // Measured against the phone, not only the window: a page that makes Chrome zoom out has a wider window.
  if (hasHorizontalOverflow({ scrollWidth: measured.scrollWidth, innerWidth: Math.min(measured.innerWidth, PHONE_VIEWPORT.width) })) {
    throw new Error(
      `the page scrolls sideways on ${where}: scrollWidth ${measured.scrollWidth} > ${Math.min(measured.innerWidth, PHONE_VIEWPORT.width)}; ` +
        `elements past the right edge: ${measured.beyond.join("; ") || "(none found)"}`,
    );
  }
}

/** A short account of what is on screen, for failure messages. */
async function describePage(page) {
  try {
    const where = await page.evaluate(() => ({
      path: window.location.pathname + window.location.search,
      text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    }));
    return `${where.path} showing "${where.text}"`;
  } catch (err) {
    return `(page not readable: ${err instanceof Error ? err.message : err})`;
  }
}

function watchPage(page) {
  page.on("pageerror", (err) => pageNotes.push(`[page error] ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageNotes.push(`[page console.error] ${msg.text()}`);
  });
  page.on("requestfailed", (req) => pageNotes.push(`[page request failed] ${req.method()} ${req.url()} ${req.failure()?.errorText ?? ""}`));
  page.on("response", (res) => {
    if (res.status() >= 400) pageNotes.push(`[page response ${res.status()}] ${res.request().method()} ${res.url()}`);
  });
}

async function screenshot(page, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file });
    return file;
  } catch {
    return null;
  }
}

// ─── Plumbing ────────────────────────────────────────────────────────────────

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  teardown.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runTeardown() {
  for (const fn of teardown.reverse()) {
    try {
      fn();
    } catch {
      /* a failed cleanup must not mask the result */
    }
  }
  teardown.length = 0;
}

process.on("exit", runTeardown);
process.on("SIGINT", () => {
  runTeardown();
  process.exit(130);
});

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(`[panel-phone-e2e] unexpected error: ${err?.stack || err?.message || err}`);
  process.exit(1);
}
