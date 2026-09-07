"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const syncAlerts = require("../sync-alerts.js");

const content = readFileSync(join(__dirname, "../content.js"), "utf8");
const worker = readFileSync(join(__dirname, "../service-worker.js"), "utf8");
// Execute the production read entrypoints verbatim, with isolated page/DOM
// adapters. No Chrome APIs or local data stores are contacted by these tests.
const start = content.indexOf("  async function readNoteInPage(note = {}) {");
const end = content.indexOf("  function setEditableValue(", start);
assert.ok(start > 0 && end > start);
const entrypoint = content.slice(start, end);
const note = { noteId: "note12345", title: "测试帖子", content: "完整正文", allComments: true };
const sample = { comments: [{ commentId: "c1", noteId: note.noteId, content: "文字评论" }], expectedCount: 1,
  expandedCount: 1, explicitEmptyVerified: false, status: "likely_complete", commentError: "",
  collectionEvidence: { allCommentsRequested: true, expandersExhausted: true, scrollExhausted: true, stableRounds: 3 } };
function harness(result = sample) {
  const h = { calls: 0, restores: 0, waits: [], collectedOptions: null, routeId: note.noteId, rootId: note.noteId };
  const root = { isConnected: true, getAttribute: () => h.rootId };
  const context = vm.createContext({
    console, Promise, Date, Map, Set,
    CONTENT_VERSION: "test-version", __XHS_MONITOR_CONTENT_VERSION__: "test-version",
    activePageRead: null, processPanel: null, PROCESS_PANEL_CLASS: "test-process", DETAIL_READY_TIMEOUT_MS: 30,
    window: { scrollY: 0, scrollTo() {} }, location: { href: "https://www.xiaohongshu.com/explore/note12345" },
    clean: (value) => String(value || ""), noteIdFromUrl: () => h.routeId,
    detailRootForNote: () => h.detached ? null : root,
    currentDetailMatches: () => !h.detached,
    openDetailInPage: async () => ({ opened: false }),
    closeDetailInPage: async () => {}, waitFor: async () => {},
    extractCurrentDetail: (source) => ({ ok: true, note: { ...source, content: "完整正文" } }),
    ensureCommentIds: async (_, rows) => rows,
    sourceNoteSnapshot: (source) => source,
    pageAccessEvidence: () => ({ state: "accessible_surface" }),
    commentUtils: {
      createCollectionAdapter(_, source, callbacks) {
        h.adapter = { ...callbacks, restore: () => { h.restores += 1; } };
        return h.adapter;
      }
    },
    commentCollector: {
      async collect(adapter, options) {
        h.calls += 1; h.collectedOptions = options;
        if (h.block) await new Promise((resolve) => h.waits.push(resolve));
        if (adapter.interruption()) return { ...result, interrupted: true, commentError: "采集中断" };
        return result;
      }
    }
  });
  vm.runInContext(entrypoint + "\nthis.read = readNoteInPage;", context);
  h.context = context;
  h.read = (value = note) => context.read(value);
  return h;
}

test("pull/auto-sync entrypoint passes verified collector evidence unchanged", async () => {
  const h = harness();
  const result = await h.read();
  assert.equal(result.ok, true);
  assert.equal(result.status, "likely_complete");
  assert.equal(result.collectionEvidence, sample.collectionEvidence);
  assert.equal(result.comments, sample.comments);
  assert.equal(h.collectedOptions.allComments, true);
  assert.equal(h.collectedOptions.noteId, note.noteId);
  assert.equal(h.restores, 1);
});

test("verified empty comments keep exact zero and proof through the production read entrypoint", async () => {
  const empty = { ...sample, comments: [], expectedCount: 0, expectedCountKnown: true,
    explicitEmptyVerified: true, expandedCount: 0,
    collectionEvidence: { ...sample.collectionEvidence, expectedCountKnown: true,
      expectedCountSource: "native_empty_state", pendingLoads: false, unreadableCount: 0 } };
  const h = harness(empty);
  const result = await h.read({ ...note, commentCount: "0" });
  assert.equal(result.ok, true); assert.equal(result.status, "likely_complete");
  assert.equal(result.expectedCount, 0); assert.equal(result.expectedCountKnown, true);
  assert.equal(result.note.commentCount, "0"); assert.equal(result.explicitEmptyVerified, true);
  assert.equal(result.collectionEvidence, empty.collectionEvidence);
});

test("post comment metric uses exact native evidence and never scans unrelated counters", () => {
  const start = content.indexOf("  function processMetric(");
  const end = content.indexOf("  function processIpLocation(", start);
  const context = vm.createContext({
    commentUtils: { readCommentCount: () => context.count },
    clean: String
  });
  vm.runInContext(content.slice(start, end) + "\nthis.metric = processMetric;", context);
  const noFallback = new Proxy({}, { get: () => assert.fail("Unrelated DOM should not be scanned") });
  for (const [count, expected] of [
    [{ expectedCountKnown: true, expectedCount: 0, explicitEmpty: true }, "0"],
    [{ expectedCountKnown: true, expectedCount: 0 }, "未显示"],
    [{ expectedCountKnown: true, expectedCount: 17 }, "17"],
    [{ expectedCountKnown: false, expectedCount: 0 }, "未显示"],
    [{ expectedCountKnown: true, expectedCount: 17, countConflict: true }, "未显示"]
  ]) {
    context.count = count;
    assert.equal(context.metric(noFallback, ["comment", "评论"]), expected);
  }
});

test("a refreshed zero comment total replaces stale stored counts in post metadata", () => {
  const start = content.indexOf("  function extractCurrentDetail(");
  const end = content.indexOf("  function detailNoteId(", start);
  const root = { querySelector: selector => selector.includes("detail-title") ? { innerText: "已加载标题" } : null };
  const context = vm.createContext({
    detailRootForNote: () => root,
    detailDescription: () => ({ value: "已加载正文" }),
    document: { querySelector: () => null },
    clean: value => String(value || ""), location: { href: note.url || "" },
    noteIdFromUrl: () => note.noteId, detailNoteId: () => note.noteId,
    canonicalTitle: value => value, processDetailMetadata: () => ({}),
    detailMediaRoot: value => value, extractImageUrls: () => [], extractVideoUrls: () => [],
    noteUtils: { normalizeXhsUrl: value => value, preferredUrl: value => value },
    processAuthorId: () => "author", normalizeTagValues: () => [], extractMediaText: () => "",
    processMetric: (_, patterns) => patterns.includes("comment") ? "0" : "未显示",
    currentKeyword: () => ""
  });
  vm.runInContext(content.slice(start, end) + "\nthis.extract = extractCurrentDetail;", context);
  const result = context.extract({ ...note, commentCount: "88" });
  assert.equal(result.ok, true); assert.equal(result.note.commentCount, "0");
});

test("partial collector results do not get promoted during post-read refresh", async () => {
  const partial = { ...sample, expectedCount: 9, status: "partial", commentError: "数量不足，已自动重试",
    collectionEvidence: { ...sample.collectionEvidence, stableRounds: 0, reason: "stalled" } };
  const h = harness(partial);
  const result = await h.read();
  assert.equal(result.ok, true);
  assert.equal(result.status, "partial");
  assert.equal(result.expectedCount, 9);
  assert.equal(result.commentError, partial.commentError);
  assert.equal(result.collectionEvidence.stableRounds, 0);
});

test("overlapping reads of the same note share one comment collector", async () => {
  const h = harness(); h.block = true;
  const first = h.read();
  await new Promise(setImmediate);
  const second = h.read();
  assert.equal(h.calls, 1);
  h.waits.shift()();
  const results = await Promise.all([first, second]);
  assert.equal(results[0], results[1]); assert.equal(h.restores, 1);
  assert.equal(h.context.activePageRead, null);
});

test("cancellation and root/route changes never return a writable snapshot", async () => {
  for (const cause of ["cancelled", "route", "root", "detached", "version"]) {
    const h = harness(); h.block = true;
    const promise = h.read(); await new Promise(setImmediate);
    if (cause === "cancelled") h.context.activePageRead.cancelled = true;
    if (cause === "route") h.routeId = "othernote";
    if (cause === "root") h.rootId = "othernote";
    if (cause === "detached") h.detached = true;
    if (cause === "version") h.context.__XHS_MONITOR_CONTENT_VERSION__ = "another-version";
    h.waits.shift()();
    const result = await promise;
    assert.equal(result.ok, false, cause);
    assert.equal(result.cancelled, true, cause);
    assert.equal(result.comments, undefined, cause);
    assert.equal(h.context.activePageRead, null, cause);
  }
});

test("different-note requests wait until the prior collector is cancelled and settled", async () => {
  const h = harness(); h.block = true;
  const old = h.read(); await new Promise(setImmediate);
  const next = { ...note, noteId: "another-note" };
  const fresh = h.read(next);
  assert.equal(h.context.activePageRead.cancelled, true);
  h.routeId = next.noteId; h.rootId = next.noteId;
  h.block = false; h.waits.shift()();
  assert.equal((await old).ok, false);
  assert.equal((await fresh).ok, true);
  assert.equal(h.calls, 2);
  assert.equal(h.collectedOptions.noteId, next.noteId);
});

test("manifest and reinjection include collector before content with matching versions", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf8"));
  const files = manifest.content_scripts[0].js;
  assert.ok(files.indexOf("comment-utils.js") < files.indexOf("comment-collector.js"));
  assert.ok(files.indexOf("comment-collector.js") < files.indexOf("content.js"));
  const workerFiles = /const CONTENT_SCRIPT_FILES = (\[[^\n]+\]);/.exec(worker)[1];
  assert.deepEqual(JSON.parse(workerFiles), files);
  assert.equal(/const CONTENT_VERSION = "([^"]+)"/.exec(content)[1], manifest.version);
  assert.equal(/const CONTENT_SCRIPT_VERSION = "([^"]+)"/.exec(worker)[1], manifest.version);
  assert.match(content, /message.type === "cancelCommentRead"/);
  assert.match(worker, /type: "cancelCommentRead"/);
  assert.match(worker, /message.type === "commentReadHeartbeat"/);
});

test("batch completion follows backend verification, and saved partial reads are retryable failures", async () => {
  const start = worker.indexOf("async function syncPulledNoteInReader(");
  const end = worker.indexOf("async function runPulledCommentSync(", start);
  for (const complete of [true, false]) {
    let saved = 0;
    const messages = [];
    const comparison = { ok: true, commentHasChanges: false, newCount: 0, removedCount: 0, changedCount: 0 };
    const context = vm.createContext({
      syncAlerts,
      readPulledNoteInReader: async () => ({ ...sample, note }),
      sendTabMessage: async (_, message) => { messages.push(message); },
      bridgeApi: async () => comparison,
      syncCurrentNoteComments: async () => { saved += 1; return { ok: true, consistencyVerified: true,
        canPrune: complete, commentStatus: complete ? "likely_complete" : "partial", currentCount: 1, pullStatus: complete ? "synced" : "partial" }; }
    });
    vm.runInContext(worker.slice(start, end) + "\nthis.run = syncPulledNoteInReader;", context);
    if (complete) {
      assert.equal((await context.run(1, note)).ok, true);
      assert.equal(messages.at(-1).done, true);
      assert.equal(messages.at(-1).pullStatus, "synced");
    } else {
      await assert.rejects(context.run(1, note), (error) => error.syncStage === "comments"
        && error.opened && error.savedComparison === comparison);
      assert.equal(messages.some((message) => message.done), false);
    }
    assert.equal(saved, 1);
  }
});

test("manual pull response never overrides backend partial with a frontend complete claim", async () => {
  const start = worker.indexOf("async function pullNote(note,");
  const end = worker.indexOf("function isBridgeConnectivityError(", start);
  const context = vm.createContext({
    withSyncAlert: async (_noteId, _snapshot, result) => result,
    runExclusivePageTask: (fn) => fn(), deepScanCancelled: false,
    broadcastPullProgress() {}, getConfig: async () => ({}), activeXhsTab: async () => ({ id: 1 }),
    ensureContentInjected: async () => {}, delay: async () => {},
    chrome: { tabs: { sendMessage: async () => ({ ...sample, ok: true, note,
      comments: [sample.comments[0], sample.comments[0]] }) } },
    bridgeApi: async () => ({ ok: true, consistencyVerified: true, commentStatus: "partial", pullStatus: "partial",
      commentError: "规范化后数量不足", currentCount: 1 }),
    requireConsistencyVerified() {}, broadcastLocalNoteState: async () => {}
  });
  vm.runInContext(worker.slice(start, end) + "\nthis.run = pullNote;", context);
  const result = await context.run(note);
  assert.equal(result.commentStatus, "partial");
  assert.equal(result.commentError, "规范化后数量不足");
  assert.equal(result.commentCount, 1);
});

test("unchanged-but-incomplete audit is saved without displaying 最新 or looping retries", async () => {
  const display = content.slice(content.indexOf("  function setProcessLatest("), content.indexOf("  function renderCommentChanges("));
  const audit = content.slice(content.indexOf("  async function auditPulledComments("), content.indexOf("  function cachedPulledStatus("));
  for (const [complete, muted] of [[false, false], [true, false], [false, true]]) {
    const head = { dataset: {}, textContent: "已拉取" };
    const badge = { dataset: {} };
    const status = {};
    const panel = { dataset: { noteId: note.noteId }, _processNote: note,
      querySelector(selector) { return selector.includes("head-state") ? head : selector.includes("__status") ? status : badge; } };
    const toasts = [];
    let syncs = 0;
    const context = vm.createContext({ processPanel: panel, PROCESS_PANEL_CLASS: "fixture",
      renderCommentChanges: () => null,
      showPageToast: (...args) => toasts.push(args),
      sendRuntime: async (message) => {
        if (message.type === "auditCurrentNoteComments") return { ok: true, hasChanges: false,
          snapshot: { expectedCount: 2, comments: sample.comments } };
        syncs += 1;
        return { ok: true, consistencyVerified: true, commentStatus: complete ? "likely_complete" : "partial",
          canPrune: complete, collectedCount: 2, currentCount: 1,
          syncAlert: muted ? { suppressed: true, label: "评论数量差异" } : undefined };
      }
    });
    vm.runInContext(display + audit + "\nthis.run = auditPulledComments;", context);
    await context.run(panel, note);
    await context.run(panel, note);
    assert.equal(syncs, 1);
    assert.equal(panel._commentAuditDone, complete);
    assert.equal(head.textContent, complete ? "最新" : muted ? "可见评论已同步" : "评论待补读");
    assert.equal(toasts.length, complete || muted ? 0 : 1);
    if (!complete) assert.match(status.textContent, muted ? /仍继续同步，未见评论保留/ : /历史评论已保留/);
  }
});

test("floating status explains muted comment warnings without masking other errors", () => {
  const start = content.indexOf("  function processStatusText(");
  const end = content.indexOf("  function removeProcessPanel(", start);
  const context = vm.createContext({ PROCESS_STEPS: [] });
  vm.runInContext(content.slice(start, end) + "\nthis.status = processStatusText;", context);
  const muted = { done: true, pullStatus: "partial", syncAlert: { suppressed: true, label: "评论数量差异" } };
  assert.match(context.status(muted), /可见内容已同步.*评论数量差异已忽略/);
  assert.equal(context.status({ ...muted, error: "CSV 写入失败" }), "CSV 写入失败");
  assert.equal(context.status({ ...muted, mediaStatus: "partial", mediaError: "图片下载失败" }), "已写入，部分内容可重试");
});
