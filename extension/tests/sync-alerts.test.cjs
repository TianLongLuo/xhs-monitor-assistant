"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const alerts = require("../sync-alerts.js");
const plain = value => JSON.parse(JSON.stringify(value));
const issueType = "comment_count_mismatch";
const proof = { allCommentsRequested: true, expandersExhausted: true, scrollExhausted: true,
  pendingLoads: false, unreadableCount: 0, stableRounds: 0, expectedCountKnown: true };
const snapshot = { note: { noteId: "n1", title: "测试帖子", commentCount: "8" },
  comments: Array.from({ length: 5 }, (_, i) => ({ noteId: "n1", commentId: `c${i}`, content: `可见评论${i}` })),
  status: "partial", expectedCount: 8, expectedCountKnown: true, collectionEvidence: proof,
  explicitEmptyVerified: false, commentError: "已读取 5/8 条评论，补读后仍与页面总数不一致，未据此标记评论删除" };
const partial = { ok: true, consistencyVerified: true, commentStatus: "partial", pullStatus: "partial", canPrune: false, currentCount: 5 };
const failure = alerts.commentFailure("n1", snapshot, partial);
const rule = { noteId: "n1", issueType, title: "测试帖子" };
const state = { ok: true, running: false, done: true, phase: "done", startedAt: "run-1", failedPosts: 1,
  processingFailedPosts: 1, failures: [failure], total: 1, current: 1 };

test("the reported 5/8 exhausted-list warning is a specific comment-count issue", () => {
  assert.deepEqual(alerts.describeIssue(failure), { issueType, label: "评论数量差异" });
  assert.equal(failure.commentRead.expectedCount, 8);
  assert.equal(failure.commentRead.collectedCount, 5);
});

test("unknown totals, unresolved loaders, and unfinished pagination are separate issue types", () => {
  const unknown = alerts.commentFailure("n1", { ...snapshot, expectedCount: 0, expectedCountKnown: false }, partial);
  assert.equal(alerts.describeIssue(unknown).issueType, "comment_total_unknown");
  for (const patch of [{ pendingLoads: true }, { unreadableCount: 1 }, { expandersExhausted: false }, { scrollExhausted: false }]) {
    const loading = alerts.commentFailure("n1", { ...snapshot, collectionEvidence: { ...proof, ...patch } }, partial);
    assert.equal(alerts.describeIssue(loading).issueType, "comment_load_incomplete");
  }
});

test("write failures, access failures and confirmed-deleted posts are never silencable comment warnings", () => {
  for (const patch of [{ syncStage: "sync" }, { syncStage: "compare" }, { syncStage: "open" },
    { markedUnreachable: true }, { accessStatus: "unreachable" }]) {
    assert.equal(alerts.describeIssue({ ...failure, ...patch }), null);
  }
  assert.equal(alerts.describeIssue(alerts.commentFailure("n1", snapshot,
    { ...partial, commentStatus: "likely_complete", canPrune: true })), null);
});

test("retained pre-upgrade count errors keep their scope without matching unrelated errors", () => {
  const legacy = { noteId: "n1", stage: "comments", error: snapshot.commentError };
  assert.equal(alerts.describeIssue(legacy).issueType, issueType);
  assert.equal(alerts.describeIssue({ ...legacy, error: "已读取 5/8 条评论，部分回复展开失败" }).issueType, "comment_load_incomplete");
  assert.equal(alerts.describeIssue({ ...legacy, stage: "sync" }), null);
});

test("persistent rules affect only the selected note and selected issue", () => {
  const prefs = alerts.setRule(null, rule, true, "t1");
  assert.equal(alerts.annotateFailure(failure, prefs).alert.scope, "issue");
  assert.equal(alerts.annotateFailure({ ...failure, noteId: "n2" }, prefs).alert.suppressed, false);
  const different = alerts.commentFailure("n1", { ...snapshot, collectionEvidence: { ...proof, pendingLoads: true } }, partial);
  assert.equal(alerts.annotateFailure(different, prefs).alert.suppressed, false);
  assert.equal(alerts.annotateFailure({ ...failure, syncStage: "sync" }, prefs).alert.suppressed, false);
});

test("one-time acknowledgements persist for the same run only, not future full syncs", () => {
  const prefs = alerts.setOnce(null, rule, "run-1");
  const restored = alerts.normalizePreferences(plain(prefs));
  assert.equal(alerts.projectState(state, restored).failures[0].alert.scope, "once");
  assert.equal(alerts.projectState({ ...state, startedAt: "run-2" }, restored).activeFailureCount, 1);
  assert.equal(alerts.annotateFailure(failure, restored).alert.suppressed, false, "independent auto-sync is not the same occurrence");
});

test("restoring a rule and its once acknowledgement returns the alert without touching data", () => {
  let prefs = alerts.setRule(alerts.setOnce(null, rule, "run-1"), rule, true);
  prefs = alerts.setOnce(alerts.setRule(prefs, rule, false), rule, "", false);
  assert.equal(alerts.projectState(state, prefs).activeFailureCount, 1);
  assert.equal(prefs.rules.length, 0); assert.equal(prefs.dismissed.alerts.length, 0);
});

test("muting preserves raw failures, expected counts, partial flags, and all source inputs", () => {
  const prefs = alerts.setRule(null, rule, true);
  const before = plain({ state, prefs });
  const projected = alerts.projectState(state, prefs);
  assert.equal(projected.failedPosts, 1); assert.equal(projected.processingFailedPosts, 1);
  assert.equal(projected.activeFailureCount, 0); assert.equal(projected.mutedFailureCount, 1);
  assert.deepEqual(projected.failures[0].commentRead, failure.commentRead);
  assert.deepEqual({ state, prefs }, before);
  assert.equal(projected.failures[0].commentRead.canPrune, false);
});

test("legacy failure totals beyond retained IDs never disappear behind preferences", () => {
  const projected = alerts.projectState({ ...state, failedPosts: 7 }, alerts.setRule(null, rule, true));
  assert.equal(projected.activeFailureCount, 6); assert.equal(projected.mutedFailureCount, 1);
});

test("invalid stored rules are sanitized and never broaden scope", () => {
  const value = alerts.normalizePreferences({ rules: [null, { noteId: "n1", issueType: "__proto__" },
    { noteId: "../n1", issueType }, rule, { ...rule, title: "新标题" }],
    dismissed: { runStartedAt: "run-1", alerts: [{ noteId: "n2", issueType: "sync" }] } });
  assert.equal(value.rules.length, 1); assert.equal(value.rules[0].title, "新标题");
  assert.equal(value.dismissed.alerts.length, 0);
  assert.throws(() => alerts.setRule(null, { ...rule, issueType: "sync" }, true));
});

const source = readFileSync(join(__dirname, "../service-worker.js"), "utf8").replace(/\r\n/g, "\n");
function declaration(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  const end = source.indexOf("\n}", start);
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start, end + 2);
}
function worker(initial = state, storedPrefs = null) {
  const persisted = { batchCommentSyncState: plain(initial), syncAlertPreferencesV1: plain(storedPrefs) };
  const h = { persisted, writes: [], messages: [], bridgeCalls: [], failPreferences: false, reads: [] };
  const context = vm.createContext({
    syncAlerts: alerts, SYNC_ALERT_PREFERENCES_KEY: "syncAlertPreferencesV1", BATCH_COMMENT_SYNC_KEY: "batchCommentSyncState",
    batchCommentSyncState: plain(initial), syncAlertPreferences: null, syncAlertPreferencesLoad: null,
    syncAlertMutationTail: Promise.resolve(), batchStatePersistTail: Promise.resolve(),
    batchCommentSyncCancelled: false,
    chrome: {
      storage: { local: {
        get: async defaults => ({ ...defaults, ...plain(persisted) }),
        set: async value => {
          if (Object.hasOwn(value, "syncAlertPreferencesV1")) {
            if (h.failPreferences) throw new Error("模拟设置保存失败");
            if (h.beforePreferenceSave) await h.beforePreferenceSave();
          }
          h.writes.push(plain(value)); Object.assign(persisted, plain(value));
        }
      } }, runtime: { sendMessage: async message => { h.messages.push(plain(message)); } }
    },
    bridgeApi: async () => assert.fail("Unexpected Bridge call from notification preferences"),
    requireConsistencyVerified: result => { assert.equal(result.ok, true); assert.equal(result.consistencyVerified, true); },
    broadcastLocalNoteState: async () => {}
  });
  vm.runInContext(["getSyncAlertPreferences", "withSyncAlert", "getSyncAlertSettings", "setSyncAlertDisposition",
    "batchSyncState", "publishBatchCommentSync", "getBatchCommentSyncState", "syncCurrentNoteComments",
    "startFailedPulledCommentSync", "accessFailureDiagnosis", "syncPulledNoteInReader", "runPulledCommentSync"]
    .map(declaration).join("\n"), context);
  h.context = context;
  h.set = (scope, noteId = "n1", type = issueType, run = initial.startedAt) => context.setSyncAlertDisposition({ noteId, issueType: type, scope, runStartedAt: run });
  return h;
}

test("preference changes write only extension keys, never /api/ignore or business records", async () => {
  const h = worker();
  const result = await h.set("issue");
  assert.equal(result.ok, true); assert.equal(result.continuesSync, true);
  assert.equal(result.state.activeFailureCount, 0); assert.equal(result.state.failedPosts, 1);
  assert.deepEqual(result.state.failures[0].commentRead, failure.commentRead);
  assert.ok(h.writes.every(value => Object.keys(value).every(key => ["syncAlertPreferencesV1", "batchCommentSyncState"].includes(key))));
  assert.ok(h.messages.every(message => message.notifyCompletion === false), "preference changes do not announce a second completed sync");
  assert.equal(h.persisted.syncAlertPreferencesV1.rules.length, 1);
});

test("worker restart reloads issue preferences and supports restoring without the old failure", async () => {
  const first = worker(); await first.set("issue");
  const restarted = worker({ ...state, startedAt: "run-2", failures: [], failedPosts: 0 }, first.persisted.syncAlertPreferencesV1);
  const settings = await restarted.context.getSyncAlertSettings();
  assert.equal(settings.rules.length, 1);
  const result = await restarted.set("restore");
  assert.equal(result.rules.length, 0);
});

test("once acknowledgement is persisted separately and expires on the next batch", async () => {
  const h = worker(); await h.set("once");
  assert.equal(h.persisted.syncAlertPreferencesV1.rules.length, 0);
  const same = worker(state, h.persisted.syncAlertPreferencesV1);
  assert.equal((await same.context.getBatchCommentSyncState()).mutedFailureCount, 1);
  const next = worker({ ...state, startedAt: "run-2" }, h.persisted.syncAlertPreferencesV1);
  assert.equal((await next.context.getBatchCommentSyncState()).mutedFailureCount, 0);
});

test("stale clicks and wrong issue types cannot mute a new batch or unrelated error", async () => {
  const h = worker();
  for (const request of [["issue", "n1", issueType, "old-run"], ["issue", "n1", "comment_load_incomplete"],
    ["once", "unknown"], ["issue", "n1", "sync"]]) await assert.rejects(h.set(...request));
  assert.equal(h.writes.length, 0);
});

test("a failed preference save leaves previous rules and visible alerts unchanged", async () => {
  const h = worker(); h.failPreferences = true;
  await assert.rejects(h.set("issue"), /保存失败/);
  assert.equal(h.writes.length, 0);
  assert.equal((await h.context.getBatchCommentSyncState()).activeFailureCount, 1);
  h.failPreferences = false; assert.equal((await h.set("issue")).state.activeFailureCount, 0);
});

test("concurrent preference mutations are serialized without dropping another note's rule", async () => {
  const h = worker({ ...state, failedPosts: 2, failures: [failure, { ...failure, noteId: "n2" }] });
  await Promise.all([h.set("issue"), h.set("issue", "n2")]);
  assert.deepEqual(h.persisted.syncAlertPreferencesV1.rules.map(r => r.noteId).sort(), ["n1", "n2"]);
  assert.equal((await h.context.getBatchCommentSyncState()).mutedFailureCount, 2);
});

test("new progress during preference persistence is not overwritten by the old failure list", async () => {
  const h = worker({ ...state, running: true });
  h.beforePreferenceSave = async () => {
    h.context.batchSyncState({ current: 2, failedPosts: 2, failures: [plain(failure), { ...plain(failure), noteId: "n2" }] });
  };
  const result = await h.set("issue");
  assert.equal(result.state.current, 2); assert.equal(result.state.failures.length, 2);
  assert.equal(result.state.activeFailureCount, 1); assert.equal(result.state.mutedFailureCount, 1);
});

test("a new run started during an acknowledgement never inherits that acknowledgement", async () => {
  const h = worker({ ...state, running: true });
  h.beforePreferenceSave = async () => h.context.batchSyncState({ ...plain(state), running: true, startedAt: "run-2" });
  const result = await h.set("once");
  assert.equal(result.state.startedAt, "run-2"); assert.equal(result.state.activeFailureCount, 1);
});

test("retry-only action excludes muted records, while retaining any unsilenced failures", async () => {
  const h = worker({ ...state, failedPosts: 2, failures: [failure, { ...failure, noteId: "n2" }] }, alerts.setRule(null, rule, true));
  h.context.startPulledCommentSync = async (ids, mode) => ({ ids: plain(ids), mode });
  assert.deepEqual(await h.context.startFailedPulledCommentSync(), { ids: ["n2"], mode: "failed" });
  const only = worker(state, alerts.setRule(null, rule, true));
  only.context.startPulledCommentSync = () => assert.fail("No active alert to retry");
  assert.equal((await only.context.startFailedPulledCommentSync()).ok, false);
});

test("muting does not alter the snapshot sent to the data layer or elevate partial to complete", async () => {
  const h = worker(state, alerts.setRule(null, rule, true));
  h.context.bridgeApi = async (path, options) => {
    assert.equal(path, "/api/comments/sync"); h.bridgeCalls.push(JSON.parse(options.body)); return plain(partial);
  };
  const result = await h.context.syncCurrentNoteComments({ noteId: "n1", snapshot: plain(snapshot) });
  assert.equal(result.syncAlert.suppressed, true); assert.equal(result.canPrune, false);
  assert.equal(result.commentStatus, "partial"); assert.equal(result.pullStatus, "partial");
  assert.equal(h.bridgeCalls[0].expectedCount, 8); assert.equal(h.bridgeCalls[0].comments.length, 5);
  assert.equal(h.bridgeCalls[0].status, "partial"); assert.equal(h.bridgeCalls[0].explicitEmptyVerified, false);
  assert.deepEqual(h.bridgeCalls[0].collectionEvidence, proof);
});

test("CSV write or consistency errors bypass notification suppression", async () => {
  const h = worker(state, alerts.setRule(null, rule, true));
  const bad = { ...partial, ok: false, consistencyVerified: false, error: "CSV被占用" };
  assert.equal(await h.context.withSyncAlert("n1", snapshot, bad), bad);
  h.context.bridgeApi = async () => bad;
  await assert.rejects(h.context.syncCurrentNoteComments({ noteId: "n1", snapshot: plain(snapshot) }));
});

test("a muted mismatch remains in every full-sync run and fresh visible comments are still written", async () => {
  const h = worker(state, alerts.setRule(null, rule, true));
  const note = { ...snapshot.note, status: "known", source: "existing_xlsx", pullStatus: "partial" };
  const before = plain(note);
  let round = 0;
  Object.assign(h.context, {
    getNotes: async () => ({ ok: true, notes: [note] }),
    acquireReaderTab: async () => ({ id: 1 }),
    readPulledNoteInReader: async (_, current) => {
      h.reads.push(current.noteId); round += 1;
      return { ...plain(snapshot), ok: true, comments: [...plain(snapshot.comments), ...(round > 1 ? [{ noteId: "n1", commentId: "new", content: "新评论" }] : [])] };
    },
    getNoteStatus: async () => ({ ok: true, found: true, inExcel: true, commentCount: 5 }),
    noteIdFromXhsUrl: () => "n1", sendTabMessage: async () => ({}), delay: async () => {}, releaseReaderTabSoon() {},
    setNoteAccessStatuses: async items => {
      assert.ok(items.every(item => item.status === "ok")); return { ok: true, items };
    },
    bridgeApi: async (path, options = {}) => {
      assert.notEqual(path, "/api/ignore");
      if (path === "/api/sync-runs/start") return { ok: true, runId: 0 };
      if (path === "/api/comments/compare") return { ok: true, commentHasChanges: round > 1, newCount: round > 1 ? 1 : 0 };
      if (path === "/api/comments/sync") {
        const payload = JSON.parse(options.body); h.bridgeCalls.push(payload);
        return { ...partial, currentCount: payload.comments.length, newCount: round > 1 ? 1 : 0 };
      }
      if (path === "/api/reports/weekly") return { ok: false };
      assert.fail(`Unexpected API ${path}`);
    }
  });
  for (let i = 0; i < 2; i++) {
    const result = await h.context.runPulledCommentSync(null, "all");
    assert.equal(result.total, 1); assert.equal(result.current, 1);
    assert.equal(result.failedPosts, 1, "truthful partial history remains recorded");
    assert.equal(result.activeFailureCount, 0); assert.equal(result.mutedFailureCount, 1);
    assert.equal(result.newComments, i);
  }
  assert.deepEqual(h.reads, ["n1", "n1"]); assert.deepEqual(note, before);
  assert.deepEqual(h.bridgeCalls.map(item => [item.expectedCount, item.comments.length, item.status]), [[8, 5, "partial"], [8, 6, "partial"]]);
});
