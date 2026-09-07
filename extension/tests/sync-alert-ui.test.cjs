"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const syncAlerts = require("../sync-alerts.js");

const source = name => readFileSync(join(__dirname, "..", name), "utf8").replace(/\r\n/g, "\n");
const panelSource = source("sidepanel.js");
const html = source("sidepanel.html");
const css = source("sidepanel.css");
const plain = value => JSON.parse(JSON.stringify(value));
const unexpected = () => assert.fail("Unexpected external operation in isolated UI test");

// Load real UI declarations only. Extension bootstrap, service-worker, storage,
// collection, navigation, CSV, and database code are never executed.
function declaration(name) {
  const start = panelSource.search(new RegExp("^(?:async )?function " + name + "\\(", "m"));
  assert.notEqual(start, -1, "Missing UI function: " + name);
  const end = panelSource.indexOf("\n}", start);
  assert.ok(end > start, "Missing closing brace: " + name);
  return panelSource.slice(start, end + 2);
}

class Element {
  constructor(tag = "div", document = null) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this._text = "";
    this.classList = {
      toggle: (name, enabled) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        if (enabled) names.add(name); else names.delete(name);
        this.className = [...names].join(" ");
      }
    };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this._text = String(value ?? ""); }
  set innerHTML(_value) { assert.fail("Untrusted UI text must never become HTML"); }
  get isConnected() { return Boolean(this.ownerDocument?.body?.contains(this)); }
  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === "#FRAGMENT") { this.append(...node.children.slice()); continue; }
      if (node.parentElement) {
        node.parentElement.children = node.parentElement.children.filter(child => child !== node);
      }
      node.parentElement = this;
      this.children.push(node);
    }
  }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) {
    this.children.forEach(child => { child.parentElement = null; });
    this.children = [];
    this._text = "";
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  async click() { if (!this.disabled) return this.listeners.get("click")?.({ preventDefault() {} }); }
  focus() { this.ownerDocument.activeElement = this; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) {
    return selector.startsWith(".")
      ? this.className.split(/\s+/).includes(selector.slice(1))
      : this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
}

const uiFunctions = [
  "batchFailureAlert", "batchFailureCounts", "onlyMutedBatchAlerts", "mutedBatchSyncMessage",
  "mergeBatchSyncViewState", "batchSyncPhaseLabel", "batchSyncSummary", "batchFailureDiagnosis",
  "failureNoteUrl", "confirmWholePostIgnore", "ignoreBatchFailureItems", "changeSyncAlertDisposition",
  "createSyncAlertButton", "renderBatchFailures", "renderBatchSync", "renderSyncAlertRules",
  "refreshSyncAlertSettings", "refreshOperations", "operationsEmpty", "retryFailedPulledSync",
  "startAllPulledSync", "updateCompactFloatingState", "pullNoteFeedback", "pullNoteToExcel",
  "renderNoteList", "actionButton"
];

function panel(state, options = {}) {
  const calls = { messages: [], confirmations: [], statuses: [], toasts: [], refreshes: [] };
  const document = {
    activeElement: null,
    createElement: tag => new Element(tag, document),
    createDocumentFragment: () => new Element("#fragment", document),
    querySelectorAll: selector => document.body.querySelectorAll(selector)
  };
  document.body = new Element("body", document);
  const ids = [
    "batchSyncProgress", "batchSyncTitle", "batchSyncCount", "batchSyncBar", "batchSyncCurrent", "batchSyncStats",
    "batchSyncFailures", "batchSyncFailureList", "batchSyncFailureCount", "ignoreAllBatchFailures",
    "batchSyncMutedFailures", "batchSyncMutedCount", "batchSyncMutedList",
    "syncAllPulled", "syncAllPulledLabel", "cancelBatchSync", "retryBatchFailures",
    "syncAlertRules", "syncAlertRulesCount", "syncAlertRulesList", "syncAlertRulesHint", "refreshOperations",
    "pendingList", "pendingCount", "pendingEmpty", "queueKicker", "queueTitle", "queueHint", "queueBack", "queueMore"
  ];
  const elements = Object.fromEntries(ids.map(id => [id, document.createElement(
    ["batchSyncMutedFailures", "syncAlertRules"].includes(id) ? "details"
      : /^(ignoreAll|syncAll|cancelBatch|retryBatch|refreshOperations)/.test(id) ? "button" : "div"
  )]));
  document.body.append(...Object.values(elements));
  elements.batchSyncFailures.append(elements.batchSyncFailureCount, elements.ignoreAllBatchFailures, elements.batchSyncFailureList);
  elements.batchSyncMutedFailures.append(document.createElement("summary"), elements.batchSyncMutedCount, elements.batchSyncMutedList);
  elements.syncAlertRules.append(document.createElement("summary"), elements.syncAlertRulesCount, elements.syncAlertRulesHint, elements.syncAlertRulesList);
  const compact = Object.fromEntries(["widget", "title", "detail", "badge"].map(id => [id, document.createElement("span")]));
  const refresh = name => async () => { calls.refreshes.push(name); };
  const context = vm.createContext({
    document, elements, XhsMonitorSyncAlerts: syncAlerts,
    batchSyncViewState: {}, batchFailureRenderSignature: "", batchSyncCompletionNotified: "",
    syncAlertRules: [], syncAlertRulesRenderSignature: "", syncAlertSettingsRevision: 0, syncAlertPending: new Set(),
    operationsLoading: false, operationsState: {}, compactFloatingElements: compact,
    activePulls: new Set(), queueView: { type: "pending" },
    fetch: unexpected, setTimeout: unexpected, setInterval: unexpected,
    chrome: new Proxy({}, { get: unexpected }),
    confirm: message => { calls.confirmations.push(message); return options.confirm !== false; },
    sendRuntime: async message => {
      calls.messages.push(plain(message));
      if (!options.reply) return unexpected();
      return options.reply(plain(message));
    },
    setStatus: (message, state = "idle") => calls.statuses.push({ message, state }),
    showToast: (message, variant = "success") => calls.toasts.push({ message, variant }),
    formatLocalTime: value => String(value),
    formatTime: () => "本次发现", sourceLabel: () => "", activateMetric() {},
    noteUrl: note => "https://www.xiaohongshu.com/explore/" + (note.noteId || note.note_id),
    navigationUrl: (_note, url) => url,
    showStatusView: refresh("showStatusView"),
    refreshStats: refresh("refreshStats"), refreshPending: refresh("refreshPending"), loadPageInfo: refresh("loadPageInfo"),
    refreshIgnoredOperations: refresh("refreshIgnoredOperations"), refreshUnreachableNotes: refresh("refreshUnreachableNotes"),
    refreshHealth: refresh("refreshHealth"), refreshChanges: refresh("refreshChanges"),
    refreshWatchlist: refresh("refreshWatchlist"), refreshWeeklyReport: refresh("refreshWeeklyReport")
  });
  vm.runInContext(uiFunctions.map(declaration).join("\n\n"), context, { timeout: 1000 });
  // Bind the actual bulk-ignore UI listener without running any other startup.
  const start = panelSource.indexOf('elements.ignoreAllBatchFailures?.addEventListener("click"');
  const end = panelSource.indexOf("\n});", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(panelSource.slice(start, end + 4), context, { timeout: 1000 });
  context.renderBatchSync(state);
  return { context, elements, compact, document, calls };
}

const ISSUE = "comment_count_mismatch";
const UNKNOWN = "comment_total_unknown";
const INCOMPLETE = "comment_load_incomplete";
const RUN = "2026-09-03T01:00:00.000Z";
function failure(noteId = "note-a", issueType = ISSUE) {
  return {
    noteId, title: "测试帖子 " + noteId, stage: "comments", syncStage: "comments", accessStatus: "ok",
    error: issueType === ISSUE ? "已保存 5/8 条评论，与页面总数不一致；历史评论已保留"
      : issueType === UNKNOWN ? "评论总数未显示" : "评论加载未完成",
    commentRead: {
      collectedCount: 5, expectedCount: issueType === UNKNOWN ? 0 : 8,
      expectedCountKnown: issueType !== UNKNOWN, commentStatus: "partial", canPrune: false,
      collectionEvidence: { pendingLoads: issueType === INCOMPLETE, expandersExhausted: true, scrollExhausted: true }
    }
  };
}
function raw(failures = [], overrides = {}) {
  return {
    ok: true, running: false, done: true, phase: "completed",
    failedPosts: failures.length, processingFailedPosts: failures.length, statusSyncFailures: 0,
    total: failures.length, current: failures.length, newComments: 5, changedPosts: 0, unchangedPosts: 0,
    startedAt: RUN, finishedAt: "2026-09-03T01:05:00.000Z", error: "", failures, ...overrides
  };
}
function rule(noteId = "note-a", issueType = ISSUE) {
  return { noteId, issueType, title: "测试帖子 " + noteId, createdAt: RUN };
}
function projected(failures = [], rules = [], overrides = {}) {
  return syncAlerts.projectState(raw(failures, overrides), { rules });
}
function onceProjected(failures = [failure()], rules = [], noteId = "note-a", overrides = {}) {
  // Build the server response in memory via the shared pure module. Do not
  // encode one-time preference storage in the UI or execute background code.
  const state = raw(failures, overrides);
  const preferences = syncAlerts.setOnce({ rules }, { noteId, issueType: ISSUE }, state.startedAt);
  return syncAlerts.projectState(state, preferences);
}
function response(state) { return { ok: true, state, rules: state.alertRules }; }
function buttonFor(ui, scope, { muted = false, rules = false, noteId = "note-a", issueType = ISSUE } = {}) {
  const root = rules ? ui.elements.syncAlertRulesList : muted ? ui.elements.batchSyncMutedList : ui.elements.batchSyncFailureList;
  const button = root.querySelectorAll(".sync-alert-button").find(node =>
    node.dataset.scope === scope && node.dataset.noteId === noteId && node.dataset.issueType === issueType);
  assert.ok(button, "Missing alert button: " + JSON.stringify({ scope, noteId, issueType }));
  return button;
}

function bindProgressListener(ui) {
  let listener;
  ui.context.ballMode = false;
  ui.context.chrome = { runtime: { onMessage: { addListener: handler => { listener = handler; } } } };
  const start = panelSource.indexOf("chrome.runtime.onMessage.addListener((message) => {");
  const end = panelSource.indexOf("\n});", start);
  assert.ok(start >= 0 && end > start);
  // Register the real message listener, not extension bootstrap or browser APIs.
  vm.runInContext(panelSource.slice(start, end + 4), ui.context, { timeout: 1000 });
  ui.context.chrome = new Proxy({}, { get: unexpected });
  assert.equal(typeof listener, "function");
  return listener;
}

test("shared UMD loads before sidepanel; rules and muted lists are native details", () => {
  assert.ok(html.indexOf('src="sync-alerts.js"') < html.indexOf('src="sidepanel.js"'));
  assert.match(html, /<details id="batchSyncMutedFailures"[^>]*hidden>/);
  assert.match(html, /<details id="syncAlertRules"/);
  assert.match(html, /告警忽略规则（仍同步）/);
  assert.match(html, /id="ignoreAllBatchFailures"[^>]*>忽略整个帖子（停止同步）/);
});

test("all three comment classes have explicit native settings and two scoped choices", () => {
  for (const issueType of [ISSUE, UNKNOWN, INCOMPLETE]) {
    const ui = panel(projected([failure("note-a", issueType)]));
    const settings = ui.elements.batchSyncFailureList.querySelector(".sync-alert-settings");
    assert.equal(settings.tagName, "DETAILS");
    assert.equal(settings.open, false);
    assert.equal(settings.children[0].tagName, "SUMMARY");
    assert.equal(settings.children[0].textContent, "告警设置");
    assert.equal(settings.parentElement.className, "sync-alert-controls", "choices use a full-width footer, not the narrow text column");
    assert.equal(settings.children.at(-1).className, "batch-sync-failure__ignore", "whole-post ignore is last, after the non-destructive scopes");
    assert.equal(buttonFor(ui, "once", { issueType }).textContent, "仅忽略本次告警");
    assert.equal(buttonFor(ui, "issue", { issueType }).textContent,
      "忽略此帖的" + syncAlerts.LABELS[issueType] + "（继续同步）");
    for (const button of settings.querySelectorAll("button")) {
      assert.equal(button.type, "button");
      assert.ok(button.attributes.get("aria-label").includes("测试帖子"));
    }
    assert.match(settings.textContent, /不改变采集完整性.*不改变或删除历史数据/);
  }
});

for (const scope of ["once", "issue"]) {
  test(scope + " sends only a disposition and renders the returned projection without changing raw failures", async () => {
    const initial = projected([failure()]);
    const snapshot = plain(initial);
    const next = scope === "once"
      ? onceProjected()
      : projected([failure()], [rule()]);
    const ui = panel(initial, { reply: () => response(next) });
    const selected = buttonFor(ui, scope);
    selected.focus();
    await selected.click();
    assert.deepEqual(ui.calls.messages, [{ type: "setSyncAlertDisposition", noteId: "note-a",
      issueType: ISSUE, scope, runStartedAt: RUN }]);
    assert.deepEqual(initial, snapshot);
    assert.equal(ui.context.batchSyncViewState.failedPosts, 1);
    assert.equal(ui.context.batchSyncViewState.failures.length, 1);
    assert.equal(ui.context.batchSyncViewState.failures[0].commentRead.canPrune, false);
    assert.equal(ui.elements.batchSyncFailureList.children.length, 0);
    assert.equal(ui.elements.batchSyncMutedList.children.length, 1);
    assert.equal(ui.elements.batchSyncMutedFailures.hidden, false);
    assert.equal(ui.elements.batchSyncMutedFailures.open, false);
    assert.match(ui.elements.batchSyncMutedList.textContent, scope === "once" ? /仅本次已忽略/ : /持续忽略同类/);
    assert.equal(buttonFor(ui, "restore", { muted: true }).disabled, false);
    assert.equal(ui.elements.retryBatchFailures.hidden, true);
    assert.equal(ui.calls.confirmations.length, 0);
    assert.equal(ui.calls.refreshes.length, 0);
    assert.equal(ui.calls.toasts.at(-1).variant, "neutral");
    assert.match(ui.calls.statuses.at(-1).message, /已同步可见内容，1条告警已忽略，帖子仍继续同步/);
    assert.equal(ui.document.activeElement, ui.elements.batchSyncMutedFailures.querySelector("summary"));
  });

  test("restore from the " + scope + " muted list restores the alert without business operations", async () => {
    const state = scope === "once" ? onceProjected()
      : projected([failure()], [rule()]);
    const ui = panel(state, { reply: () => response(projected([failure()])) });
    await buttonFor(ui, "restore", { muted: true }).click();
    assert.deepEqual(ui.calls.messages, [{ type: "setSyncAlertDisposition", noteId: "note-a",
      issueType: ISSUE, scope: "restore", runStartedAt: RUN }]);
    assert.equal(ui.elements.batchSyncFailureList.children.length, 1);
    assert.equal(ui.elements.batchSyncMutedList.children.length, 0);
    assert.equal(ui.elements.batchSyncMutedFailures.hidden, true);
    assert.equal(ui.elements.retryBatchFailures.hidden, false);
    assert.equal(ui.context.batchSyncViewState.failedPosts, 1);
    assert.equal(ui.calls.refreshes.length, 0);
  });
}

test("only this note and issue are muted; different issues, other notes, and CSV errors remain active", () => {
  const csv = { noteId: "csv", title: "CSV 锁定", syncStage: "sync", error: "CSV 写入失败" };
  const state = projected([failure(), failure("note-a", UNKNOWN), failure("note-b"), csv], [rule()]);
  const ui = panel(state);
  assert.equal(ui.elements.batchSyncFailureList.children.length, 3);
  assert.equal(ui.elements.batchSyncMutedList.children.length, 1);
  assert.match(ui.elements.batchSyncFailureList.textContent, /评论总数未显示/);
  assert.match(ui.elements.batchSyncFailureList.textContent, /测试帖子 note-b/);
  assert.match(ui.elements.batchSyncFailureList.textContent, /CSV 写入失败/);
  assert.equal(ui.elements.batchSyncFailureCount.textContent, "3 项");
  assert.match(ui.elements.retryBatchFailures.textContent, /3 个/);
  ui.context.renderBatchSync(state, true);
  assert.equal(ui.calls.statuses.at(-1).state, "warning");
  assert.equal(ui.calls.toasts.at(-1).variant, "error");
  ui.context.updateCompactFloatingState(state);
  assert.equal(ui.compact.widget.dataset.state, "warning");
  assert.equal(ui.compact.badge.textContent, "3");
});

test("non-comment failures and complete comment reads never offer alert suppression", () => {
  const failures = [
    { noteId: "access", syncStage: "open", error: "访问失败" },
    { noteId: "csv", syncStage: "sync", error: "CSV 写入失败" },
    { noteId: "compare", syncStage: "compare", error: "数据库比对失败" },
    { ...failure("deleted"), markedUnreachable: true },
    { ...failure("complete"), commentRead: { commentStatus: "likely_complete", canPrune: true } }
  ];
  const ui = panel(projected(failures));
  assert.equal(ui.elements.batchSyncFailureList.children.length, failures.length);
  assert.equal(ui.elements.batchSyncFailureList.querySelectorAll(".sync-alert-settings").length, 0);
  assert.equal(ui.elements.batchSyncFailureList.querySelectorAll(".sync-alert-button").length, 0);
  assert.equal(ui.elements.batchSyncMutedList.children.length, 0);
});

test("a forged suppression or different issue annotation never hides an actual error", () => {
  for (const item of [
    { ...failure(), alert: { issueType: UNKNOWN, suppressed: true, scope: "issue" } },
    { noteId: "access", syncStage: "open", error: "访问失败",
      alert: { issueType: ISSUE, suppressed: true, scope: "issue" } },
    { ...failure(), alert: { issueType: ISSUE, suppressed: true, scope: "" } }
  ]) {
    const ui = panel(raw([item]));
    assert.equal(ui.elements.batchSyncFailureList.children.length, 1);
    assert.equal(ui.elements.batchSyncMutedList.children.length, 0);
    assert.equal(ui.elements.retryBatchFailures.hidden, false);
  }
});

test("all-muted completion stays neutral while raw incomplete counts and visible-content wording remain", () => {
  const state = onceProjected([failure(), failure("note-b")], [rule()], "note-b");
  const before = plain(state);
  const ui = panel(state);
  ui.context.renderBatchSync(state, true);
  assert.equal(ui.elements.batchSyncFailures.hidden, true);
  assert.equal(ui.elements.batchSyncMutedCount.textContent, "2 条");
  assert.equal(ui.elements.batchSyncTitle.textContent, "已同步可见内容");
  assert.equal(ui.elements.batchSyncCurrent.textContent, "已同步可见内容，2条告警已忽略，帖子仍继续同步");
  assert.match(ui.elements.batchSyncStats.textContent, /待处理 0.*已忽略告警 2.*原始未完成 2.*读取未完成 2/);
  assert.doesNotMatch(ui.calls.statuses.at(-1).message, /全部同步完成|完整|最新|一致性已通过/);
  assert.equal(ui.calls.statuses.at(-1).state, "idle");
  assert.equal(ui.calls.toasts.at(-1).variant, "neutral");
  ui.context.renderBatchSync(state, true);
  assert.equal(ui.calls.toasts.length, 1, "Unchanged completion must not notify repeatedly");
  ui.context.updateCompactFloatingState(state);
  assert.equal(ui.compact.widget.dataset.state, "idle");
  assert.equal(ui.compact.badge.hidden, true);
  assert.equal(ui.compact.title.textContent, "已同步可见内容");
  assert.match(ui.compact.detail.textContent, /2条告警已忽略.*仍继续同步/);
  assert.deepEqual(state, before);
});

test("preference progress suppresses duplicate completion toasts while normal and legacy progress still notify", async () => {
  const saved = projected([failure()], [rule()]);
  let onMessage;
  const ui = panel(projected([failure()]), {
    reply: () => {
      onMessage({ ...saved, type: "batchCommentSyncProgress", notifyCompletion: false });
      assert.equal(ui.calls.toasts.length, 0, "Saving preferences is not another completed sync");
      return response(saved);
    }
  });
  onMessage = bindProgressListener(ui);
  await buttonFor(ui, "issue").click();
  assert.equal(ui.calls.toasts.length, 1, "The disposition action should emit exactly one toast");
  assert.equal(ui.calls.toasts[0].variant, "neutral");
  assert.equal(ui.elements.batchSyncMutedList.children.length, 1);
  onMessage({ ...saved, type: "batchCommentSyncProgress", notifyCompletion: false });
  assert.equal(ui.calls.toasts.length, 1);
  assert.equal(ui.calls.refreshes.length, 0, "An alert preference change must not launch business/CSV refresh work");
  const next = projected([failure()], [], { startedAt: "run-next", finishedAt: "next-finish" });
  onMessage({ ...next, type: "batchCommentSyncProgress" });
  assert.equal(ui.calls.toasts.length, 2, "Missing notifyCompletion retains legacy completion notifications");
  assert.equal(ui.calls.toasts[1].variant, "error");
  onMessage({ ...next, finishedAt: "another-finish", type: "batchCommentSyncProgress", notifyCompletion: true });
  assert.equal(ui.calls.toasts.length, 3, "Explicit true still notifies on a real new completion");
});

test("muted current-comment phase does not call the visible read a failure", () => {
  const state = projected([failure()], [rule()], { done: false, running: true, phase: "failed-note" });
  const ui = panel(state);
  assert.equal(ui.elements.batchSyncTitle.textContent, "已同步可见内容（告警已忽略）");
});

test("status-write and overall errors remain warnings with zero active comment alerts", () => {
  for (const override of [
    { statusSyncFailures: 1, error: "CSV 访问状态写入失败" },
    { statusSyncFailures: 2 },
    { ok: false, error: "任务错误" }
  ]) {
    const state = projected([failure()], [rule()], override);
    const ui = panel(state);
    ui.context.renderBatchSync(state, true);
    assert.ok(["warning", "error"].includes(ui.calls.statuses.at(-1).state));
    assert.equal(ui.calls.toasts.at(-1).variant, "error");
    assert.doesNotMatch(ui.calls.statuses.at(-1).message, /已同步可见内容，1条告警已忽略/);
    ui.context.updateCompactFloatingState(state);
    assert.equal(ui.compact.widget.dataset.state, "warning");
  }
});

test("retry uses activeFailureCount, not raw failures, and all-muted retries do nothing", async () => {
  const state = projected([failure(), failure("note-a", UNKNOWN)], [rule()]);
  const ui = panel(state, { reply: () => ({ ok: true, running: true, total: 1, phase: "reading" }) });
  await ui.context.retryFailedPulledSync();
  assert.deepEqual(ui.calls.messages, [{ type: "syncFailedPulledComments" }]);
  assert.equal(ui.context.batchSyncViewState.total, 1);
  assert.match(ui.calls.statuses[0].message, /1 个失败项/);
  assert.equal(ui.elements.syncAlertRulesCount.textContent, "1");
  const muted = panel(projected([failure()], [rule()]));
  await muted.context.retryFailedPulledSync();
  assert.equal(muted.calls.messages.length, 0);
});

test("legacy no-alert/no-derived-count batches keep errors, classifications, and raw retry count", () => {
  const legacy = { noteId: "note-a", title: "历史帖子", stage: "comments",
    error: "已保存 5/8 条评论，与页面总数不一致；历史评论已保留" };
  const ui = panel(raw([legacy], { failedPosts: 4 }));
  assert.equal(ui.context.batchFailureAlert(legacy).issueType, ISSUE);
  assert.equal(buttonFor(ui, "once").disabled, false);
  assert.equal(ui.elements.batchSyncFailureList.children.length, 1);
  assert.equal(ui.elements.batchSyncFailureCount.textContent, "4 项");
  assert.match(ui.elements.retryBatchFailures.textContent, /4 个/);
  assert.match(ui.elements.retryBatchFailures.title, /旧批次未保存全部失败 ID/);
  ui.context.updateCompactFloatingState(raw([legacy], { failedPosts: 4 }));
  assert.equal(ui.compact.badge.textContent, "4");
});

test("legacy updates discard stale projected counters instead of falsely hiding retries", () => {
  const ui = panel(projected([failure()], [rule()]));
  const legacy = failure();
  ui.context.renderBatchSync({ failedPosts: 7, failures: [legacy] });
  assert.equal(ui.context.batchFailureCounts(ui.context.batchSyncViewState).active, 7);
  assert.match(ui.elements.retryBatchFailures.textContent, /7 个/);
  assert.equal(ui.elements.retryBatchFailures.hidden, false);
  assert.equal(ui.elements.syncAlertRulesCount.textContent, "1", "Missing rules do not erase old rules");
});

test("missing shared module is conservative: raw errors remain and no mute action is offered", () => {
  const ui = panel(raw([failure()]));
  ui.context.XhsMonitorSyncAlerts = undefined;
  ui.context.renderBatchSync(raw([failure()]));
  assert.equal(ui.elements.batchSyncFailureList.children.length, 1);
  assert.equal(ui.elements.batchSyncFailureList.querySelectorAll(".sync-alert-button").length, 0);
  assert.equal(ui.elements.retryBatchFailures.hidden, false);
});

test("unchanged progress preserves open details; changed scope and batch invalidate render cache", () => {
  const initial = projected([failure()]);
  const ui = panel(initial);
  const row = ui.elements.batchSyncFailureList.children[0];
  row.querySelector(".sync-alert-settings").open = true;
  ui.context.renderBatchSync({ current: 1 });
  assert.equal(ui.elements.batchSyncFailureList.children[0], row);
  assert.equal(row.querySelector(".sync-alert-settings").open, true);
  ui.context.renderBatchSync(onceProjected());
  ui.elements.batchSyncMutedFailures.open = true;
  const mutedRow = ui.elements.batchSyncMutedList.children[0];
  ui.context.renderBatchSync(projected([failure()], [rule()]));
  assert.notEqual(ui.elements.batchSyncMutedList.children[0], mutedRow);
  assert.match(ui.elements.batchSyncMutedList.textContent, /持续忽略同类/);
  assert.equal(ui.elements.batchSyncMutedFailures.open, true);
  ui.context.renderBatchSync(projected([failure()], [], { startedAt: "new-run" }));
  assert.equal(ui.elements.batchSyncMutedList.children.length, 0);
  assert.equal(ui.elements.batchSyncFailureList.children.length, 1);
  assert.notEqual(ui.elements.batchSyncFailureList.children[0], row);
});

test("single whole-post ignore always confirms stopping sync and associated data-state changes", async () => {
  for (const confirmed of [false, true]) {
    const ui = panel(projected([failure()]), {
      confirm: confirmed,
      reply: () => ({ ok: true, ignoredCount: 1, state: projected([]) })
    });
    const button = ui.elements.batchSyncFailureList.querySelector(".batch-sync-failure__ignore");
    assert.equal(button.textContent, "忽略整个帖子（停止同步）");
    await button.click();
    assert.equal(ui.calls.confirmations.length, 1);
    assert.match(ui.calls.confirmations[0], /停止参与后续同步.*帖子与关联评论会标记为删除态.*本地记录保留/s);
    assert.match(ui.calls.confirmations[0], /告警设置.*仍继续同步/s);
    assert.equal(ui.calls.messages.length, confirmed ? 1 : 0);
    if (confirmed) assert.deepEqual(ui.calls.messages[0], { type: "ignoreBatchFailures", noteIds: ["note-a"] });
    else {
      assert.equal(button.disabled, false);
      assert.equal(button.textContent, "忽略整个帖子（停止同步）");
      assert.equal(ui.elements.batchSyncFailureList.children.length, 1);
    }
  }
});

test("bulk whole-post ignore excludes muted-only posts, deduplicates IDs, and requires confirmation", async () => {
  const initial = projected([failure("note-a"), failure("note-b"), failure("note-b", UNKNOWN)], [rule()]);
  for (const confirmed of [false, true]) {
    const ui = panel(initial, {
      confirm: confirmed,
      reply: () => ({ ok: true, ignoredCount: 1, state: projected([failure()], [rule()]) })
    });
    await ui.elements.ignoreAllBatchFailures.click();
    assert.equal(ui.calls.confirmations.length, 1);
    assert.match(ui.calls.confirmations[0], /以下 1 篇帖子.*测试帖子 note-b/s);
    assert.doesNotMatch(ui.calls.confirmations[0], /测试帖子 note-a/);
    assert.match(ui.calls.confirmations[0], /关联评论会标记为删除态/);
    assert.equal(ui.calls.messages.length, confirmed ? 1 : 0);
    if (confirmed) assert.deepEqual(ui.calls.messages[0], { type: "ignoreBatchFailures", noteIds: ["note-b"] });
  }
});

test("legacy note-list whole-post action is also explicit and confirmation-gated", async () => {
  const ui = panel(projected([]), { confirm: false });
  ui.context.renderNoteList([{ noteId: "note-a", title: "新帖子", status: "new" }], { status: "new" });
  const button = ui.elements.pendingList.querySelectorAll("button")
    .find(node => node.textContent === "忽略整个帖子（停止同步）");
  assert.ok(button);
  await button.click();
  assert.equal(ui.calls.confirmations.length, 1);
  assert.equal(ui.calls.messages.length, 0);
  assert.equal(button.disabled, false);
});

test("running batch disables whole-post ignore without disabling comment alert settings", () => {
  const ui = panel(projected([failure()], [], { running: true, done: false }));
  assert.equal(ui.elements.batchSyncFailureList.querySelector(".batch-sync-failure__ignore").disabled, true);
  assert.equal(ui.elements.ignoreAllBatchFailures.disabled, true);
  assert.equal(buttonFor(ui, "once").disabled, false);
});

test("initial state renders persistent rules even with no matching failures; restore works after a restart", async () => {
  const state = projected([], [rule()], { startedAt: "new-run", done: false, phase: "idle" });
  const ui = panel(state, { reply: () => response(projected([], [], { startedAt: "new-run", done: false, phase: "idle" })) });
  assert.equal(ui.elements.syncAlertRulesCount.textContent, "1");
  assert.match(ui.elements.syncAlertRulesList.textContent, /评论数量差异.*持续忽略.*仍同步/);
  assert.match(ui.elements.syncAlertRulesList.textContent, /2026-09-03T01:00:00.000Z/);
  await buttonFor(ui, "restore", { rules: true }).click();
  assert.deepEqual(ui.calls.messages, [{ type: "setSyncAlertDisposition", noteId: "note-a",
    issueType: ISSUE, scope: "restore", runStartedAt: "new-run" }]);
  assert.equal(ui.elements.syncAlertRulesCount.textContent, "0");
  assert.match(ui.elements.syncAlertRulesList.textContent, /当前没有持续忽略规则/);
  assert.equal(ui.calls.refreshes.length, 0);
});

test("settings refresh applies returned state; operations refresh includes the settings request", async () => {
  const refreshed = projected([failure()], [rule()]);
  const ui = panel(projected([]), { reply: () => response(refreshed) });
  await ui.context.refreshOperations();
  assert.deepEqual(ui.calls.messages, [{ type: "getSyncAlertSettings" }]);
  assert.equal(ui.context.batchSyncViewState.failedPosts, 1);
  assert.equal(ui.elements.batchSyncMutedList.children.length, 1);
  assert.equal(ui.elements.syncAlertRulesCount.textContent, "1");
  assert.equal(ui.elements.refreshOperations.disabled, false);
});

test("failed settings refresh preserves old rules and offers retry context, never empty success", async () => {
  for (const reply of [() => ({ ok: false, error: "离线", rules: [] }), () => { throw new Error("读取失败"); }]) {
    const ui = panel(projected([], [rule()]), { reply });
    const row = ui.elements.syncAlertRulesList.children[0];
    const result = await ui.context.refreshSyncAlertSettings();
    assert.equal(result.ok, false);
    assert.equal(ui.elements.syncAlertRulesList.children[0], row);
    assert.equal(ui.elements.syncAlertRulesCount.textContent, "1");
    assert.match(ui.elements.syncAlertRulesHint.textContent, /刷新失败，已保留原规则/);
    assert.equal(ui.elements.syncAlertRulesHint.dataset.state, "warning");
    assert.deepEqual(ui.calls.messages, [{ type: "getSyncAlertSettings" }]);
  }
});

test("late settings refresh cannot overwrite a newly saved disposition", async () => {
  let finishRead;
  const initial = projected([failure()]);
  const saved = projected([failure()], [rule()]);
  const ui = panel(initial, {
    reply: message => message.type === "getSyncAlertSettings"
      ? new Promise(resolve => { finishRead = resolve; }) : response(saved)
  });
  const reading = ui.context.refreshSyncAlertSettings();
  await buttonFor(ui, "issue").click();
  finishRead(response(initial));
  await reading;
  assert.equal(ui.elements.syncAlertRulesCount.textContent, "1");
  assert.equal(ui.elements.batchSyncMutedList.children.length, 1);
});

test("saving disables sibling choices and restores controls after the server projection arrives", async () => {
  let finish;
  const ui = panel(projected([failure()]), { reply: () => new Promise(resolve => { finish = resolve; }) });
  const once = buttonFor(ui, "once");
  const issue = buttonFor(ui, "issue");
  const saving = once.click();
  assert.equal(once.disabled, true);
  assert.equal(issue.disabled, true);
  await issue.click();
  assert.equal(ui.calls.messages.length, 1);
  finish(response(onceProjected()));
  await saving;
  assert.equal(buttonFor(ui, "restore", { muted: true }).disabled, false);
});

test("failed disposition never optimistically removes alerts or rules and keeps controls retryable", async () => {
  const initial = projected([failure()], [rule()]);
  const ui = panel(initial, { reply: () => ({ ok: false, error: "保存失败", rules: [] }) });
  const selected = buttonFor(ui, "restore", { rules: true });
  await selected.click();
  assert.equal(ui.elements.syncAlertRulesCount.textContent, "1");
  assert.equal(ui.elements.batchSyncMutedList.children.length, 1);
  assert.equal(selected.disabled, false);
  assert.equal(selected.textContent, "恢复提醒");
  assert.equal(ui.calls.statuses.at(-1).state, "error");
  assert.equal(ui.calls.refreshes.length, 0);
});

test("stale-batch rejection applies the supplied new state without suppressing its other issue", async () => {
  const next = projected([failure("note-a", UNKNOWN)], [], { startedAt: "run-next" });
  const ui = panel(projected([failure()]), { reply: () => ({ ok: false, error: "批次已变化", state: next }) });
  await buttonFor(ui, "once").click();
  assert.equal(ui.context.batchSyncViewState.startedAt, "run-next");
  assert.equal(ui.elements.batchSyncMutedList.children.length, 0);
  assert.equal(buttonFor(ui, "once", { issueType: UNKNOWN }).disabled, false);
  assert.equal(ui.calls.statuses.at(-1).state, "error");
});

test("delayed clicks retain their displayed batch stamp even when the same issue exists in a new run", async () => {
  for (const scope of ["once", "issue"]) {
    const next = projected([failure()], [], { startedAt: "run-next" });
    const ui = panel(projected([failure()]), {
      reply: message => {
        assert.equal(message.runStartedAt, RUN, "An old button must never borrow the new run stamp");
        return { ok: false, error: "该告警所属批次已变化，请刷新后重新选择", state: next };
      }
    });
    const oldButton = buttonFor(ui, scope);
    ui.context.renderBatchSync(next);
    assert.equal(oldButton.isConnected, false);
    assert.equal(ui.context.batchSyncViewState.startedAt, "run-next");
    await oldButton.click();
    assert.deepEqual(ui.calls.messages, [{ type: "setSyncAlertDisposition", noteId: "note-a",
      issueType: ISSUE, scope, runStartedAt: RUN }]);
    assert.equal(ui.context.batchSyncViewState.startedAt, "run-next");
    assert.equal(ui.context.batchSyncViewState.activeFailureCount, 1);
    assert.equal(ui.elements.batchSyncMutedList.children.length, 0);
    assert.equal(buttonFor(ui, scope).disabled, false);
    assert.equal(ui.calls.statuses.at(-1).state, "error");
    assert.equal(ui.calls.refreshes.length, 0);
  }
});

test("newly rendered buttons capture the new batch stamp", async () => {
  const next = projected([failure()], [], { startedAt: "run-next" });
  const ui = panel(projected([failure()]), {
    reply: message => {
      assert.equal(message.runStartedAt, "run-next");
      return response(projected([failure()], [rule()], { startedAt: "run-next" }));
    }
  });
  ui.context.renderBatchSync(next);
  await buttonFor(ui, "issue").click();
  assert.equal(ui.calls.messages[0].runStartedAt, "run-next");
  assert.equal(ui.elements.batchSyncMutedList.children.length, 1);
});

test("a persistent-rule restore created in an older batch still works without a matching current failure", async () => {
  const next = projected([], [rule()], { startedAt: "run-next" });
  const ui = panel(projected([failure()], [rule()]), {
    reply: message => {
      assert.equal(message.scope, "restore");
      // The background contract deliberately accepts restore across batches.
      return response(projected([], [], { startedAt: "run-next" }));
    }
  });
  const restore = buttonFor(ui, "restore", { rules: true });
  ui.context.renderBatchSync(next);
  assert.equal(restore.isConnected, true, "Unchanged global rules retain their existing controls");
  await restore.click();
  assert.equal(ui.calls.messages[0].runStartedAt, RUN);
  assert.equal(ui.context.batchSyncViewState.startedAt, "run-next");
  assert.equal(ui.elements.syncAlertRulesCount.textContent, "0");
  assert.equal(ui.calls.refreshes.length, 0);
});

function manualResult(overrides = {}) {
  return {
    ok: true, consistencyVerified: true, pullStatus: "partial", commentStatus: "partial", canPrune: false,
    mediaStatus: "complete", commentCount: 5, commentError: "已保存 5/8 条评论，与页面总数不一致",
    pullError: "已保存 5/8 条评论，与页面总数不一致",
    syncAlert: { issueType: ISSUE, label: "评论数量差异", suppressed: true, scope: "issue" },
    ...overrides
  };
}

test("manual visible-comment sync stays neutral before and after the known-list refresh without upgrading data", async () => {
  const result = manualResult();
  const before = plain(result);
  const ui = panel(projected([]), { reply: () => result });
  ui.context.queueView = { type: "status", status: "known" };
  const button = ui.document.createElement("button");
  button.textContent = "补采评论";
  await ui.context.pullNoteToExcel({ noteId: "note-a", title: "测试帖子" }, button);
  assert.match(ui.calls.statuses.at(-1).message, /已同步可见评论 5 条，同类告警已忽略，帖子仍继续同步/);
  assert.equal(ui.calls.statuses.at(-1).state, "idle");
  assert.ok(ui.calls.statuses.every(item => item.state !== "warning"));
  assert.equal(button.textContent, "补采评论");
  assert.equal(ui.context.activePulls.size, 0);
  assert.deepEqual(result, before);
  assert.equal(result.commentStatus, "partial");
  assert.equal(result.canPrune, false);
  assert.deepEqual(ui.calls.messages.map(item => item.type), ["pullNote"]);
});

test("manual muted comment issue never masks media, CSV, task, or other errors", () => {
  const cases = [
    [{ mediaStatus: "partial", mediaError: "素材下载失败" }, /素材下载失败/],
    [{ pullError: "CSV 写入异常" }, /CSV 写入异常/],
    [{ pullError: "已保存 5/8 条评论，与页面总数不一致；另有本地写入错误" }, /本地写入错误/],
    [{ error: "访问状态更新失败" }, /访问状态更新失败/],
    [{ warning: "其它待处理错误" }, /其它待处理错误/],
    [{ mediaStatus: "failed" }, /素材/],
    [{ pullStatus: "failed" }, /仍未完整采集/]
  ];
  const ui = panel(projected([]));
  for (const [override, expected] of cases) {
    const feedback = ui.context.pullNoteFeedback(manualResult(override));
    assert.equal(feedback.state, "warning");
    assert.match(feedback.message, expected);
    assert.doesNotMatch(feedback.message, /同类告警已忽略，帖子仍继续同步/);
  }
});

test("unmuted manual incompleteness and false canPrune never claim a complete or latest collection", () => {
  const ui = panel(projected([]));
  for (const result of [
    manualResult({ syncAlert: undefined }),
    manualResult({ syncAlert: { issueType: ISSUE, suppressed: false, scope: "" } }),
    { pullStatus: "synced", commentStatus: "likely_complete", canPrune: false, mediaStatus: "complete" }
  ]) {
    const feedback = ui.context.pullNoteFeedback(result, true);
    assert.equal(feedback.state, "warning");
    assert.doesNotMatch(feedback.message, /补采完成|最新|全部同步完成/);
  }
});

test("manual consistency and fatal failures still reject before any muted feedback", async () => {
  for (const override of [{ ok: false, error: "CSV 写入失败" }, { consistencyVerified: false }]) {
    const ui = panel(projected([]), { reply: () => manualResult(override) });
    await assert.rejects(ui.context.pullNoteToExcel({ noteId: "note-a" }), /CSV 写入失败|一致性校验/);
    assert.equal(ui.calls.refreshes.length, 0);
    assert.equal(ui.context.activePulls.size, 0);
    assert.ok(ui.calls.statuses.every(item => !item.message.includes("同类告警已忽略")));
  }
});

test("hostile titles, diagnostic messages, and rule labels render as literal text", () => {
  const attack = '<img src=x onerror="alert(1)"> <script>bad()</script>';
  const item = { ...failure(), title: attack, error: attack };
  const state = projected([item]);
  state.alertRules = [{ ...rule("other"), title: attack, label: attack }];
  const ui = panel(state);
  assert.equal(ui.elements.batchSyncFailureList.querySelector(".batch-sync-failure__reason").textContent, attack);
  assert.equal(ui.elements.batchSyncFailureList.querySelector("strong").textContent, attack);
  assert.match(ui.elements.syncAlertRulesList.textContent, /<script>bad\(\)<\/script>/);
  assert.equal(ui.document.querySelectorAll("script").length, 0);
});

test("new controls use scoped Apple styles, wrap long copy, and expose keyboard focus", () => {
  assert.match(css, /\.sync-alert-button\s*\{[^}]*white-space:\s*normal/s);
  assert.match(css, /\.sync-alert-button:focus-visible/);
  assert.match(css, /\.sync-alert-settings > summary:focus-visible/);
  assert.match(css, /\.sync-alert-rules > summary:focus-visible/);
  assert.match(css, /data-suppressed="true"[^}]*var\(--apple-surface\)/s);
  assert.match(css, /\.app-toast--neutral\s*\{[^}]*white-space:\s*normal/s);
  assert.match(css, /\.sync-alert-rule \.operations-row__copy p\s*\{[^}]*overflow-wrap:\s*anywhere/s);
});
