"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const syncAlerts = require("../sync-alerts.js");

const source = (name) => readFileSync(join(__dirname, "..", name), "utf8").replace(/\r\n/g, "\n");
const workerSource = source("service-worker.js");
const panelSource = source("sidepanel.js");
const css = source("sidepanel.css");
const plain = (value) => JSON.parse(JSON.stringify(value));
const unexpected = () => assert.fail("Unexpected external operation in isolated diagnosis test");

// Only load named, top-level declarations, whose closing braces are unindented.
// Never execute extension bootstrap, collectors, browser APIs, CSV or DB access.
function declaration(script, name) {
  const start = script.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.notEqual(start, -1, `Missing production function: ${name}`);
  const end = script.indexOf("\n}", start);
  assert.ok(end > start, `Missing closing brace: ${name}`);
  return script.slice(start, end + 2);
}

function load(script, names, globals = {}) {
  const context = vm.createContext({
    fetch: unexpected, setTimeout: unexpected, setInterval: unexpected,
    chrome: new Proxy({}, { get: unexpected }), ...globals
  });
  vm.runInContext(names.map((name) => declaration(script, name)).join("\n\n"), context, { timeout: 1000 });
  return context;
}

function worker(failures = []) {
  const calls = { updates: [], broadcasts: [], publications: [] };
  const context = load(workerSource, ["accessFailureDiagnosis", "isManualDeleteCandidate", "deleteReviewedFailures"], {
    batchCommentSyncState: { failures, running: false }
  });
  context.getBatchCommentSyncState = async () => context.batchCommentSyncState;
  context.setNoteAccessStatuses = async (items) => {
    calls.updates.push(plain(items));
    return { ok: true, items: items.map((item) => ({ noteId: item.noteId, postStatus: "已删除" })) };
  };
  context.broadcastLocalNoteState = async (...args) => { calls.broadcasts.push(plain(args)); };
  context.publishBatchCommentSync = async (state) => {
    calls.publications.push(plain(state));
    context.batchCommentSyncState = { ...context.batchCommentSyncState, ...state };
    return context.batchCommentSyncState;
  };
  return { context, calls };
}

// Evaluate the actual failure record literal, not the sync function around it.
function failureRecord(error) {
  const body = declaration(workerSource, "runPulledCommentSync");
  const match = body.match(/const failure = (\{[\s\S]*?\n        \});/);
  assert.ok(match, "Production failure record must be present");
  const { context } = worker();
  return plain(vm.runInNewContext(`(${match[1]})`, {
    error, note: { noteId: "note-fixture", title: "测试帖子", url: "" },
    noteIdFromXhsUrl: () => "", markedUnreachable: false, accessStatus: "ok",
    localStatus: { found: true, inExcel: true }, diagnosis: context.accessFailureDiagnosis(error)
  }, { timeout: 1000 }));
}

class Element {
  constructor(tagName = "span") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this._text = "";
    this.listeners = new Map();
    this.attributes = new Map();
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.children = []; this._text = String(value ?? ""); }
  set innerHTML(_value) { assert.fail("Diagnostic content must be rendered as text"); }
  append(...children) {
    for (const child of children) {
      this.children.push(...(child.tagName === "#FRAGMENT" ? child.children : [child]));
    }
  }
  replaceChildren(...children) { this.children = []; this._text = ""; this.append(...children); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
}

function find(root, className) {
  if (root.className.split(/\s+/).includes(className)) return root;
  return root.children.map((child) => find(child, className)).find(Boolean);
}

function panel(failures = []) {
  const elements = Object.fromEntries([
    "batchSyncFailures", "batchSyncFailureList", "batchSyncFailureCount", "ignoreAllBatchFailures",
    "deleteUnreachable", "deleteUnreachableLabel", "unreachableCount", "unreachableHint"
  ].map((name) => [name, new Element()]));
  const calls = { messages: [], confirmations: [] };
  const context = load(panelSource, [
    "batchFailureAlert", "batchFailureCounts", "onlyMutedBatchAlerts", "mutedBatchSyncMessage",
    "mergeBatchSyncViewState", "createSyncAlertButton", "renderSyncAlertRules",
    "batchFailureDiagnosis", "isManualDeleteCandidate", "failureNoteUrl", "renderBatchFailures",
    "batchSyncPhaseLabel", "batchSyncSummary", "renderBatchSync", "renderUnreachableNotes", "deleteAllUnreachableNotes"
  ], {
    elements, batchSyncViewState: { running: false, failures }, batchFailureRenderSignature: "",
    XhsMonitorSyncAlerts: syncAlerts, syncAlertPending: new Set(), syncAlertRules: [],
    syncAlertRulesRenderSignature: "", syncAlertSettingsRevision: 0,
    unreachableNotes: [], unreachableDeleteRunning: false,
    document: { createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element("#fragment") },
    confirm: (message) => { calls.confirmations.push(message); return true; },
    sendRuntime: async (message) => {
      assert.equal(message.type, "deleteReviewedFailures");
      calls.messages.push(plain(message));
      return { ok: true, markedDeletedCount: message.noteIds.length };
    },
    setStatus() {}, showToast() {},
    refreshStats: async () => {}, refreshPending: async () => {},
    refreshUnreachableNotes: async () => {}, loadPageInfo: async () => {}
  });
  return { context, elements, calls };
}

test("comments are accessible with body read and comment completeness unverified", () => {
  const { context } = worker();
  const result = context.accessFailureDiagnosis({ syncStage: "comments", opened: true }, {
    found: true, inExcel: true, commentCount: 0, mediaFiles: ["local-image"]
  });
  assert.equal(result.code, "comments_unverified");
  assert.match(result.label, /可打开.*评论待核验/);
  assert.match(result.summary, /正文已读取.*评论计数或完整性尚未核验/);
  assert.doesNotMatch(result.summary, /详情层提取失败/);
  assert.equal(result.hasLocalCopy, true);
  assert.equal(result.commentCount, 0);
  assert.match(result.localSummary, /素材 1 个/);
});

test("open extraction, comments verification and local sync have distinct diagnoses", () => {
  const { context } = worker();
  const cases = { open: "accessible_extraction_failed", comments: "comments_unverified",
    sync: "accessible_sync_failed", compare: "accessible_sync_failed" };
  for (const [syncStage, code] of Object.entries(cases)) {
    assert.equal(context.accessFailureDiagnosis({ syncStage, opened: true }).code, code, syncStage);
  }
  assert.equal(context.accessFailureDiagnosis({ syncStage: "open" }).code, "link_needs_review");
});

test("legacy stage is supported while an explicit syncStage takes precedence", () => {
  const { context } = worker();
  assert.equal(context.accessFailureDiagnosis({ stage: "comments" }).code, "comments_unverified");
  assert.equal(context.accessFailureDiagnosis({ stage: "sync" }).code, "accessible_sync_failed");
  assert.equal(context.accessFailureDiagnosis({ stage: "comments", syncStage: "open" }).code, "link_needs_review");
  assert.equal(context.accessFailureDiagnosis({}).code, "link_needs_review");
});

test("old records with access status or single-object evidence remain accessible", () => {
  const { context } = worker();
  for (const failure of [{ accessStatus: "ok" }, { opened: true },
    { accessEvidence: { state: "accessible_surface" } }, { accessEvidence: [{ state: "ok" }] }]) {
    assert.equal(context.accessFailureDiagnosis(failure).code, "accessible_extraction_failed");
  }
});

test("explicit confirmed unreachability retains priority over comment stage", () => {
  const { context } = worker();
  for (const confirmed of [{ unreachable: true }, { markedUnreachable: true },
    { accessStatus: "unreachable" }, { diagnosis: { code: "confirmed_unreachable" } }]) {
    for (const stage of [{ syncStage: "comments" }, { stage: "comments" }]) {
      const result = context.accessFailureDiagnosis({ ...confirmed, ...stage, opened: true });
      assert.equal(result.code, "confirmed_unreachable");
      assert.equal(result.label, "已确认失效");
    }
  }
});

test("existing link and access diagnoses are preserved without inventing deletion evidence", () => {
  const { context } = worker();
  const cases = { definitive_unreachable: "suspected_unreachable", mobile_only: "mobile_only",
    authentication_required: "authentication_required", temporary_blocked: "temporary_blocked",
    link_id_mismatch: "stored_link_id_mismatch" };
  for (const [state, code] of Object.entries(cases)) {
    assert.equal(context.accessFailureDiagnosis({ syncStage: "open", accessEvidence: [{ state }] }).code, code);
  }
  assert.equal(context.accessFailureDiagnosis({}, { found: true, inExcel: true }).code, "stored_link_needs_refresh");
});

test("serialized production failure records carry syncStage and the legacy stage", () => {
  for (const syncStage of ["comments", "open", "sync", undefined]) {
    const error = Object.assign(new Error("实际错误原因"), syncStage ? { syncStage } : {});
    const failure = failureRecord(error);
    assert.equal(failure.syncStage, syncStage || "unknown");
    assert.equal(failure.stage, failure.syncStage);
    assert.equal(failure.error, error.message);
    assert.equal(failure.accessStatus, "ok");
    assert.equal(failure.markedUnreachable, false);
  }
});

test("panel corrects stale legacy diagnoses without mutating saved failures", () => {
  const { context } = panel();
  const { context: background } = worker();
  for (const stage of ["comments", "sync", "open"]) {
    const failure = { noteId: "legacy", stage, error: "实际原因", diagnosis: {
      code: "accessible_extraction_failed", label: "可打开，读取未完成",
      summary: "帖子页面可访问，仅详情层提取失败，不属于失效帖子", localSummary: "本地已拉取"
    } };
    const before = plain(failure);
    const diagnosis = context.batchFailureDiagnosis(failure);
    const expected = background.accessFailureDiagnosis({ ...failure, opened: true });
    assert.equal(diagnosis.code, expected.code);
    assert.equal(diagnosis.label, expected.label);
    assert.equal(diagnosis.summary, expected.summary);
    assert.equal(diagnosis.localSummary, "本地已拉取");
    assert.deepEqual(failure, before);
  }
});

test("panel retains confirmed-unreachable evidence including historical markers", () => {
  const { context } = panel();
  const result = context.batchFailureDiagnosis({ stage: "comments", diagnosis: {
    code: "confirmed_unreachable", label: "已确认失效", summary: "已保留明确失效证据"
  } });
  assert.equal(result.code, "confirmed_unreachable");
  assert.equal(result.summary, "已保留明确失效证据");
  for (const marker of [{ markedUnreachable: true }, { unreachable: true }, { accessStatus: "unreachable" }]) {
    const diagnosis = context.batchFailureDiagnosis({ ...marker, syncStage: "comments",
      diagnosis: { code: "comments_unverified", summary: "旧评论摘要" } });
    assert.equal(diagnosis.code, "confirmed_unreachable");
    assert.equal(diagnosis.label, "已确认失效");
    assert.doesNotMatch(diagnosis.summary, /旧评论摘要/);
  }
});

test("actual error is fully visible before expandable diagnostic context and stays text-only", () => {
  const error = `实际原因：${"长错误细节".repeat(60)}\n评论总数未核验 <img src=x onerror=alert(1)>`;
  const failure = failureRecord(Object.assign(new Error(error), { syncStage: "comments" }));
  failure.diagnosis.localSummary = "本地已拉取 · 素材 2 个";
  const { context, elements } = panel([failure]);
  context.renderBatchFailures([failure]);
  const item = elements.batchSyncFailureList.children[0];
  const reason = find(item, "batch-sync-failure__reason");
  const details = find(item, "batch-sync-failure__details");
  const copy = find(item, "batch-sync-failure__copy");
  assert.equal(item.dataset.diagnosis, "comments_unverified");
  assert.equal(reason.textContent, error);
  assert.equal(reason.children.length, 0);
  assert.equal(details.tagName, "DETAILS");
  assert.equal(details.children[0].tagName, "SUMMARY");
  assert.equal(details.open, false);
  assert.ok(copy.children.indexOf(reason) < copy.children.indexOf(details));
  assert.match(details.textContent, /评论计数或完整性尚未核验/);
  assert.match(details.textContent, /素材 2 个/);
  assert.doesNotMatch(reason.textContent, /本地已拉取/);
});

test("legacy errors and missing errors have useful fallbacks without repeated summaries", () => {
  const cases = [
    [{ error: "旧失败对象的实际原因" }, "旧失败对象的实际原因"],
    [{ error: "  ", diagnosis: { summary: "仅有诊断摘要", localSummary: "本地记录" } }, "仅有诊断摘要"],
    [{ error: "相同原因", diagnosis: { summary: "相同原因" } }, "相同原因"],
    [{}, "等待重新核验"]
  ];
  for (const [fields, expected] of cases) {
    const { context, elements } = panel();
    context.renderBatchFailures([{ noteId: "legacy", ...fields }]);
    const item = elements.batchSyncFailureList.children[0];
    assert.equal(find(item, "batch-sync-failure__reason").textContent, expected);
    const details = find(item, "batch-sync-failure__details");
    if (details) assert.ok(!details.textContent.includes(expected));
  }
});

test("render cache invalidates on either stage field or an unreachability change", () => {
  const { context, elements } = panel();
  const failure = { noteId: "cached", error: "实际原因", stage: "open" };
  context.renderBatchFailures([failure]);
  const first = elements.batchSyncFailureList.children[0];
  context.renderBatchFailures([failure]);
  assert.equal(elements.batchSyncFailureList.children[0], first);
  failure.stage = "comments";
  context.renderBatchFailures([failure]);
  assert.equal(elements.batchSyncFailureList.children[0].dataset.diagnosis, "comments_unverified");
  failure.syncStage = "sync";
  context.renderBatchFailures([failure]);
  assert.equal(elements.batchSyncFailureList.children[0].dataset.diagnosis, "accessible_sync_failed");
  failure.accessStatus = "unreachable";
  context.renderBatchFailures([failure]);
  assert.equal(elements.batchSyncFailureList.children[0].dataset.diagnosis, "confirmed_unreachable");
});

test("diagnostic CSS wraps the full reason instead of ellipsizing small text", () => {
  const rule = css.match(/^\.batch-sync-failure__copy small\s*\{([^}]+)\}/m)?.[1];
  assert.ok(rule);
  assert.match(rule, /white-space:\s*pre-wrap/);
  assert.match(rule, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(rule, /overflow:\s*hidden|text-overflow:\s*ellipsis|white-space:\s*nowrap/);
  assert.doesNotMatch(css, /\.batch-sync-failure__copy strong,\s*\.batch-sync-failure__copy small\s*\{/);
  assert.match(css, /data-diagnosis="comments_unverified"/);
  assert.match(css, /\.batch-sync-failure__details summary\s*\{[^}]*cursor:\s*pointer/);
});

test("panel and worker exclude accessible/comment-only records from manual deletion", () => {
  const { context: background } = worker();
  const { context: ui } = panel();
  const excluded = [
    { syncStage: "comments" }, { stage: "comments" }, { stage: "sync" }, { syncStage: "compare" },
    { accessStatus: "ok" }, { opened: true }, { diagnosis: { code: "comments_unverified" } },
    { diagnosis: { code: "accessible_extraction_failed" } }, { diagnosis: { code: "accessible_sync_failed" } },
    { accessEvidence: [{ state: "accessible_surface" }] }, { accessEvidence: { state: "ok" } },
    { markedUnreachable: true }, { unreachable: true }, { accessStatus: "unreachable" },
    { diagnosis: { code: "confirmed_unreachable" } }
  ];
  const included = [{}, { stage: "open", accessStatus: "check_failed" },
    { diagnosis: { code: "suspected_unreachable" }, accessEvidence: [{ state: "definitive_unreachable" }] }];
  for (const [cases, expected] of [[excluded, false], [included, true]]) {
    for (const fields of cases) {
      const failure = { noteId: "candidate", ...fields };
      assert.equal(background.isManualDeleteCandidate(failure), expected, JSON.stringify(fields));
      assert.equal(ui.isManualDeleteCandidate(failure), expected, JSON.stringify(fields));
    }
  }
  for (const missing of [null, undefined, {}, { url: "link-only" }]) {
    assert.equal(background.isManualDeleteCandidate(missing), false);
    assert.equal(ui.isManualDeleteCandidate(missing), false);
  }
});

function mixedFailures() {
  return [
    { noteId: "comments", title: "仅评论待核验", syncStage: "comments", accessStatus: "ok" },
    { noteId: "legacy-comments", title: "历史评论待核验", stage: "comments" },
    { noteId: "accessible", title: "已可打开", diagnosis: { code: "accessible_extraction_failed" } },
    { noteId: "review", title: "待复核链接", stage: "open", accessStatus: "check_failed" },
    { noteId: "legacy-review", title: "历史待复核链接", error: "打开失败" },
    { noteId: "confirmed", title: "明确失效", markedUnreachable: true, diagnosis: { code: "confirmed_unreachable" } }
  ];
}

test("worker rechecks mixed manual-delete IDs and preserves excluded failures", async () => {
  const failures = mixedFailures();
  const { context, calls } = worker(failures);
  const result = await context.deleteReviewedFailures([...failures.map((item) => item.noteId), "unknown", " review "]);
  assert.equal(result.ok, true);
  assert.equal(result.markedDeletedCount, 2);
  assert.equal(result.nonDestructive, true);
  assert.deepEqual(calls.updates[0].map((item) => item.noteId), ["review", "legacy-review"]);
  assert.ok(calls.updates[0].every((item) => item.result === "manual_confirmed_deleted"));
  assert.deepEqual(plain(result.state.failures).map((item) => item.noteId),
    ["comments", "legacy-comments", "accessible", "confirmed"]);
  assert.equal(result.state.reviewPosts, 0);
  assert.equal(result.state.unreachablePosts, 1);
  assert.equal(calls.broadcasts.length, 2);
});

test("comment-only, already-confirmed or stale manual selections make no status writes", async () => {
  for (const noteIds of [["comments", "legacy-comments", "accessible"], ["confirmed"], ["unknown"], []]) {
    const { context, calls } = worker(mixedFailures());
    const result = await context.deleteReviewedFailures(noteIds);
    assert.equal(result.ok, false);
    assert.equal(calls.updates.length, 0);
    assert.equal(calls.broadcasts.length, 0);
    assert.equal(calls.publications.length, 0);
  }
});

test("worker applies the manual guard after refreshing saved failure state", async () => {
  const { context, calls } = worker([{ noteId: "changed", stage: "open" }]);
  context.getBatchCommentSyncState = async () => {
    context.batchCommentSyncState = { failures: [{ noteId: "changed", stage: "comments" }] };
    return context.batchCommentSyncState;
  };
  assert.equal((await context.deleteReviewedFailures(["changed"])).ok, false);
  assert.equal(calls.updates.length, 0);
});

test("manual-delete counts ignore comment failures while retaining confirmed records", () => {
  const { context, elements } = panel(mixedFailures());
  context.renderUnreachableNotes({ notes: [{ note_id: "confirmed", title: "明确失效" }] });
  assert.equal(elements.deleteUnreachable.disabled, false);
  assert.match(elements.deleteUnreachableLabel.textContent, /人工确认并标记已删除（2）/);
  context.batchSyncViewState.failures = mixedFailures().filter((item) => !item.noteId.includes("review"));
  context.renderUnreachableNotes({ notes: [{ note_id: "confirmed", title: "明确失效" }] });
  assert.equal(elements.deleteUnreachable.disabled, true);
  assert.equal(elements.deleteUnreachableLabel.textContent, "已保留删除帖子记录（1）");
  context.renderUnreachableNotes({ notes: [] });
  assert.equal(elements.unreachableCount.textContent, "0");
  assert.equal(elements.deleteUnreachableLabel.textContent, "暂无已确认删除帖子");
});

test("panel confirmation and outgoing manual-delete IDs contain only review candidates", async () => {
  const { context, calls } = panel(mixedFailures());
  await context.deleteAllUnreachableNotes();
  assert.equal(calls.confirmations.length, 1);
  assert.match(calls.confirmations[0], /以下 2 篇帖子/);
  assert.match(calls.confirmations[0], /待复核链接/);
  assert.doesNotMatch(calls.confirmations[0], /仅评论待核验|历史评论待核验|已可打开|明确失效/);
  assert.deepEqual(calls.messages, [{ type: "deleteReviewedFailures", noteIds: ["review", "legacy-review"] }]);
});

test("panel does not offer confirmation or send messages for comment-only failures", async () => {
  const { context, calls, elements } = panel([{ noteId: "comment-only", stage: "comments" }]);
  context.renderUnreachableNotes();
  assert.equal(elements.deleteUnreachable.disabled, true);
  await context.deleteAllUnreachableNotes();
  assert.equal(calls.confirmations.length, 0);
  assert.equal(calls.messages.length, 0);
});

test("progress rerender refreshes manual-delete labels when an open failure becomes comment-only", () => {
  const { context, elements } = panel([{ noteId: "changing", stage: "open" }]);
  context.renderBatchSync();
  assert.equal(elements.deleteUnreachable.disabled, false);
  assert.match(elements.deleteUnreachableLabel.textContent, /（1）/);
  context.renderBatchSync({ failures: [{ noteId: "changing", stage: "comments" }] });
  assert.equal(elements.deleteUnreachable.disabled, true);
  assert.equal(elements.deleteUnreachableLabel.textContent, "暂无已确认删除帖子");
  assert.equal(elements.batchSyncFailureList.children[0].dataset.diagnosis, "comments_unverified");
});
