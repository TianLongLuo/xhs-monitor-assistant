"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const content = readFileSync(join(__dirname, "../content.js"), "utf8").replace(/\r\n/g, "\n");
const panelSource = readFileSync(join(__dirname, "../sidepanel.js"), "utf8").replace(/\r\n/g, "\n");
function declaration(source, name, indent = "") {
  const start = source.search(new RegExp(`^${indent}(?:async )?function ${name}\\(`, "m"));
  const end = source.indexOf(`\n${indent}}`, start);
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start, end + indent.length + 2);
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function configHarness() {
  const h = { scans: 0 };
  h.context = vm.createContext({
    config: { enabled: true, targetKeywords: ["old"] }, DEFAULT_CONFIG: { targetKeywords: ["default"] },
    lastAutoScanFingerprint: "old", lastAutoScanResult: { ok: true }, lastAutoScanFetchedAt: 12,
    isCommentLocatorSurface: () => Boolean(h.locator), scanStatusGeneration: 0, scheduleScan: () => h.scans++
  });
  vm.runInContext(declaration(content, "onContentConfigChanged", "  "), h.context);
  return h;
}
test("100 progress/geometry/preferences writes cause zero content scans", () => {
  const h = configHarness();
  for (let i = 0; i < 100; i++) h.context.onContentConfigChanged({
    batchCommentSyncState: { newValue: { current: i } }, syncAlertPreferencesV1: { newValue: {} },
    floatingBounds: { newValue: {} }
  }, "local");
  assert.equal(h.scans, 0); assert.equal(h.context.scanStatusGeneration, 0);
});
test("actual local scan config changes invalidate cached decisions and schedule one scan", () => {
  const h = configHarness();
  h.context.onContentConfigChanged({ targetKeywords: { newValue: ["new"] }, enabled: { newValue: false } }, "local");
  assert.equal(h.scans, 1); assert.equal(h.context.config.enabled, false);
  assert.equal(h.context.config.targetKeywords[0], "new");
  assert.equal(h.context.lastAutoScanResult, null); assert.equal(h.context.scanStatusGeneration, 1);
});
test("similarly named sync/session keys do not alter local config", () => {
  const h = configHarness();
  for (const area of ["sync", "session"]) h.context.onContentConfigChanged({ enabled: { newValue: false } }, area);
  assert.equal(h.scans, 0); assert.equal(h.context.config.enabled, true);
});

function statusHarness() {
  const h = { requests: [], applied: [], retries: 0, renders: 0 };
  const panel = { dataset: { noteId: "n1" }, querySelector: () => null, _processNote: {} };
  const context = vm.createContext({
    processPanel: panel, activePageRead: null, PROCESS_PANEL_CLASS: "process", Date,
    sendRuntime: () => { const gate = deferred(); h.requests.push(gate); return gate.promise; },
    retryProcessPanelStatus: () => h.retries++,
    renderProcessPanel: () => h.renders++,
    applyFreshStatusToCard: (_, status) => h.applied.push(status),
    invalidateScanStatusCache: () => {}, cachedPulledStatus: () => false,
    clearTimeout: () => {}
  });
  vm.runInContext(declaration(content, "refreshProcessPanelStatus", "  "), context);
  h.context = context; h.panel = panel;
  h.run = () => context.refreshProcessPanelStatus(panel, { noteId: "n1" });
  return h;
}
test("slow magnetic-panel status reads are single-flight across repeated DOM updates", async () => {
  const h = statusHarness(), first = h.run();
  h.panel._statusFetchedAt -= 5000;
  await Promise.all(Array.from({ length: 30 }, () => h.run()));
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ ok: true, inExcel: false, pullStatus: "not_started" });
  await first; assert.equal(h.applied.length, 1); assert.equal(h.panel._statusRequest, null);
});
test("post-write invalidation rejects a slow stale answer and fetches one fresh status", async () => {
  const h = statusHarness(), first = h.run();
  h.panel._statusFetchedAt = 0;
  await Promise.all(Array.from({ length: 20 }, () => h.run()));
  h.requests[0].resolve({ ok: true, inExcel: false, status: "old" });
  await first; await tick();
  assert.equal(h.applied.length, 0); assert.equal(h.requests.length, 2);
  h.requests[1].resolve({ ok: true, inExcel: false, status: "fresh" }); await tick();
  assert.equal(h.applied.length, 1); assert.equal(h.applied[0].status, "fresh");
  assert.equal(h.panel._statusRequest, null);
});
test("switching to another magnetic panel discards the previous panel's status response", async () => {
  const h = statusHarness(), first = h.run();
  h.context.processPanel = { dataset: { noteId: "n2" } };
  h.requests[0].resolve({ ok: true, inExcel: true }); await first;
  assert.equal(h.applied.length, 0); assert.equal(h.renders, 0);
  assert.equal(h.panel._statusRequest, null);
});
test("failed magnetic-panel status reads release the guard and allow recovery", async () => {
  const h = statusHarness(), first = h.run();
  h.requests[0].reject(new Error("offline")); await first;
  assert.equal(h.retries, 1); assert.equal(h.panel._statusRequest, null);
  h.panel._statusFetchedAt = 0;
  const second = h.run(); assert.equal(h.requests.length, 2);
  h.requests[1].resolve({ ok: true, inExcel: false }); await second;
  assert.equal(h.applied.length, 1);
});

function refreshHarness() {
  const h = { timers: [], calls: [] };
  const context = vm.createContext({
    ballMode: false, localDataRefreshTimer: null, localDataRefreshTask: null, localDataRefreshQueued: false,
    setTimeout: callback => { h.timers.push(callback); return h.timers.length; },
    refreshStats: () => { h.calls.push("stats"); return h.block ? h.block.promise : Promise.resolve(); },
    refreshPending: () => { h.calls.push("notes"); return Promise.resolve(); },
    loadPageInfo: () => { h.calls.push("page"); return Promise.resolve(); }
  });
  vm.runInContext(declaration(panelSource, "scheduleLocalDataRefresh"), context);
  h.context = context; h.schedule = () => context.scheduleLocalDataRefresh();
  h.flush = () => h.timers.shift()?.();
  return h;
}
test("100 end-of-batch notifications produce three UI refresh calls instead of 300", async () => {
  const h = refreshHarness(); for (let i = 0; i < 100; i++) h.schedule();
  assert.equal(h.timers.length, 1); h.flush(); await tick();
  assert.deepEqual(h.calls, ["stats", "notes", "page"]);
});
test("notifications during a refresh get one trailing refresh, never lost or overlapping", async () => {
  const h = refreshHarness(); h.block = deferred(); h.schedule(); h.flush();
  for (let i = 0; i < 100; i++) h.schedule();
  assert.equal(h.calls.length, 3); assert.equal(h.timers.length, 0);
  h.block.resolve(); await tick(); assert.equal(h.timers.length, 1);
  h.flush(); await tick(); assert.equal(h.calls.length, 6);
});
test("refresh failure and compact-ball mode do not create background refresh loops", async () => {
  const h = refreshHarness(); h.block = deferred(); h.schedule(); h.flush();
  h.block.reject(new Error("fixture unavailable")); await tick();
  assert.equal(h.context.localDataRefreshTask, null); assert.equal(h.timers.length, 0);
  h.block = null; h.schedule(); h.flush(); await tick(); assert.equal(h.calls.length, 6);
  h.context.ballMode = true; h.schedule(); assert.equal(h.timers.length, 0);
});

test("successful partial pull progress stays partial and unverified progress does not claim a write", () => {
  let handler;
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener: callback => { handler = callback; } } } },
    ballMode: false, currentDetailNote: { noteId: "n1", pullStatus: "not_started" },
    currentDetailPullingId: "n1", renderCurrentDetail() {}, elements: {}, setStatus() {}
  });
  const start = panelSource.indexOf("chrome.runtime.onMessage.addListener((message) => {");
  const end = panelSource.indexOf("\nasync function initSidePanel()", start);
  vm.runInContext(panelSource.slice(start, end), context);
  handler({ type: "pullProgress", noteId: "n1", done: true, ok: true, pullStatus: "synced" });
  assert.equal(context.currentDetailNote.pullStatus, "not_started");
  handler({ type: "pullProgress", noteId: "n1", done: true, ok: true, consistencyVerified: true, pullStatus: "partial" });
  assert.equal(context.currentDetailNote.pullStatus, "partial");
  handler({ type: "pullProgress", noteId: "n1", done: true, ok: true, consistencyVerified: true, pullStatus: "synced" });
  assert.equal(context.currentDetailNote.pullStatus, "synced");
});

test("a late grid scan cannot overwrite a post's fresh pulled status", async () => {
  const gate = deferred(), decorated = [];
  const fresh = { noteId: "n1", inExcel: true, pullStatus: "synced" };
  const context = vm.createContext({
    scanStatusGeneration: 0, lastAutoScanFingerprint: "", lastAutoScanFetchedAt: 0,
    lastAutoScanResult: { ok: true, statuses: [{ noteId: "n1", inExcel: false }] },
    pendingScan: false, bridgeReady: true, STATUS_CACHE_TTL_MS: 1500,
    shouldAutoScan: () => true, extractNotes: () => [{ noteId: "n1" }],
    relevanceMatch: () => ({ relevant: true }), scanFingerprint: () => "one-note",
    sendRuntime: () => gate.promise, currentKeyword: () => "fixture", location: { href: "https://fixture.test" },
    decorate: (_, statuses) => decorated.push(statuses),
    window: { dispatchEvent: () => assert.fail("stale response must not emit scan-complete") }
  });
  vm.runInContext(["runScan", "invalidateScanStatusCache"].map(name => declaration(content, name, "  ")).join("\n"), context);
  const running = context.runScan();
  context.invalidateScanStatusCache("n1", fresh);
  gate.resolve({ ok: true, statuses: [{ noteId: "n1", inExcel: false, pullStatus: "not_started" }] });
  const result = await running;
  assert.equal(result.superseded, true); assert.equal(result.statuses[0].inExcel, true);
  assert.equal(decorated.length, 0); assert.equal(context.pendingScan, true);
});

test("locator-only tab never starts a scan on config changes", () => {
  const h = configHarness(); h.locator = true;
  h.context.onContentConfigChanged({ enabled: { newValue: true } }, "local");
  assert.equal(h.scans, 0);
});
