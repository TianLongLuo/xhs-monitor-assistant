(function (root, factory) {
  const api = factory();
  root.XhsMonitorSyncAlerts = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Notification preferences only. Nothing in this module changes a note's
  // sync eligibility, collection status, expected total, or deletion evidence.
  const LABELS = Object.freeze({
    comment_count_mismatch: "评论数量差异",
    comment_total_unknown: "评论总数未显示",
    comment_load_incomplete: "评论加载未完成"
  });
  const MAX_RULES = 1000;
  const clean = (value, limit = 160) => typeof value === "string" ? value.trim().slice(0, limit) : "";
  const validId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
  const validIssue = value => Object.prototype.hasOwnProperty.call(LABELS, value);
  const ruleKey = (noteId, issueType) => JSON.stringify([noteId, issueType]);

  function describeIssue(failure = {}) {
    if (!failure || typeof failure !== "object") return null;
    if (failure.markedUnreachable || failure.unreachable || failure.accessStatus === "unreachable"
      || failure.diagnosis?.code === "confirmed_unreachable") return null;
    const stage = failure.syncStage || failure.stage;
    if (stage ? stage !== "comments" : failure.diagnosis?.code !== "comments_unverified") return null;
    const read = failure.commentRead || {};
    if (read.commentStatus === "likely_complete" && read.canPrune === true) return null;
    const evidence = read.collectionEvidence || {};
    const current = Number(read.collectedCount);
    const expected = Number(read.expectedCount);
    const loading = evidence.pendingLoads === true || Number(evidence.unreadableCount) > 0
      || evidence.expandersExhausted === false || evidence.scrollExhausted === false;
    let issueType;
    if (Number.isFinite(expected) && Number.isFinite(current)) {
      const counted = expected > 0 && read.expectedCountKnown !== false;
      if (!loading && (evidence.countConflict === true || (counted && current !== expected))) {
        issueType = "comment_count_mismatch";
      } else if (!loading && (!counted && !read.explicitEmptyVerified)) {
        issueType = "comment_total_unknown";
      } else issueType = "comment_load_incomplete";
    } else {
      // Compatibility for retained batches before structured comment evidence.
      // A read failure never becomes a count mismatch merely because it has
      // numbers in its message; require the prior count-mismatch wording.
      const message = clean(failure.error, 1500);
      const match = message.match(/(?:已读取|已保存)\s*(\d+)\s*\/\s*(\d+)\s*条评论/);
      if (match && Number(match[2]) > 0 && Number(match[1]) !== Number(match[2])
        && /页面总数不一致|数量不一致|数量不足/.test(message)
        && !/加载任务|展开失败|内容尚未加载/.test(message)) issueType = "comment_count_mismatch";
      else if (/未提供可核验的评论总数|评论总数未显示/.test(message)) issueType = "comment_total_unknown";
      else issueType = "comment_load_incomplete";
    }
    return { issueType, label: LABELS[issueType] };
  }

  function normalizePreferences(value) {
    const items = Array.isArray(value?.rules) ? value.rules : [];
    const rules = new Map();
    for (const item of items.slice(0, MAX_RULES * 2)) {
      if (!validId(item?.noteId) || !validIssue(item?.issueType)) continue;
      const key = ruleKey(item.noteId, item.issueType);
      if (rules.size >= MAX_RULES && !rules.has(key)) continue;
      rules.set(key, { noteId: item.noteId, issueType: item.issueType,
        title: clean(item.title, 300), createdAt: clean(item.createdAt, 60) });
    }
    const alerts = new Map();
    const runStartedAt = clean(value?.dismissed?.runStartedAt, 80);
    if (runStartedAt && Array.isArray(value?.dismissed?.alerts)) {
      for (const item of value.dismissed.alerts.slice(0, MAX_RULES)) {
        if (validId(item?.noteId) && validIssue(item?.issueType)) {
          alerts.set(ruleKey(item.noteId, item.issueType), { noteId: item.noteId, issueType: item.issueType });
        }
      }
    }
    return { version: 1, rules: [...rules.values()], dismissed: { runStartedAt, alerts: [...alerts.values()] } };
  }

  function commentFailure(noteId, snapshot = {}, response = {}, error = "") {
    return {
      noteId, title: snapshot.note?.title || "", syncStage: "comments", stage: "comments", accessStatus: "ok", opened: true,
      error: error || response.commentError || snapshot.commentError || "评论完整性待核验",
      commentRead: {
        collectedCount: response.currentCount ?? snapshot.comments?.length ?? 0,
        expectedCount: Number(snapshot.expectedCount) || 0,
        expectedCountKnown: snapshot.expectedCountKnown ?? snapshot.collectionEvidence?.expectedCountKnown ?? (Number(snapshot.expectedCount) > 0),
        explicitEmptyVerified: snapshot.explicitEmptyVerified === true,
        commentStatus: response.commentStatus || snapshot.status || "partial", canPrune: response.canPrune === true,
        collectionEvidence: { ...(snapshot.collectionEvidence || {}) }
      }
    };
  }

  function setRule(preferences, rule, enabled, timestamp = new Date().toISOString()) {
    if (!validId(rule?.noteId) || !validIssue(rule?.issueType)) throw new Error("告警规则参数不正确");
    const value = normalizePreferences(preferences);
    const key = ruleKey(rule.noteId, rule.issueType);
    const index = value.rules.findIndex(item => ruleKey(item.noteId, item.issueType) === key);
    if (!enabled) return { ...value, rules: value.rules.filter((_, i) => i !== index) };
    const next = { noteId: rule.noteId, issueType: rule.issueType, title: clean(rule.title, 300),
      createdAt: index >= 0 ? value.rules[index].createdAt : timestamp };
    if (index >= 0) value.rules[index] = next;
    else {
      if (value.rules.length >= MAX_RULES) throw new Error("告警规则已达到上限，请先恢复部分提醒");
      value.rules.push(next);
    }
    return value;
  }

  function setOnce(preferences, rule, runStartedAt, enabled = true) {
    if (!validId(rule?.noteId) || !validIssue(rule?.issueType)
      || (enabled && !clean(runStartedAt, 80))) throw new Error("本次告警参数不正确");
    const value = normalizePreferences(preferences);
    const key = ruleKey(rule.noteId, rule.issueType);
    const alerts = enabled && value.dismissed.runStartedAt !== runStartedAt ? [] : value.dismissed.alerts;
    const kept = alerts.filter(item => ruleKey(item.noteId, item.issueType) !== key);
    if (enabled) {
      if (kept.length >= MAX_RULES) throw new Error("本次已忽略告警达到上限");
      kept.push({ noteId: rule.noteId, issueType: rule.issueType });
    }
    return { ...value, dismissed: { runStartedAt: enabled ? runStartedAt : value.dismissed.runStartedAt, alerts: kept } };
  }

  function annotateWithKeys(failure, keys, onceKeys = new Set()) {
    const issue = describeIssue(failure);
    if (!issue) return { ...failure, alert: { issueType: "", label: "", suppressed: false, scope: "" } };
    const persistent = keys.has(ruleKey(failure.noteId, issue.issueType));
    const scope = persistent ? "issue" : onceKeys.has(ruleKey(failure.noteId, issue.issueType)) ? "once" : "";
    return { ...failure, alert: { ...issue, suppressed: Boolean(scope), scope } };
  }

  function annotateFailure(failure, preferences) {
    const keys = new Set(normalizePreferences(preferences).rules.map(rule => ruleKey(rule.noteId, rule.issueType)));
    return annotateWithKeys(failure, keys);
  }

  function projectState(state = {}, preferences) {
    const prefs = normalizePreferences(preferences);
    const keys = new Set(prefs.rules.map(rule => ruleKey(rule.noteId, rule.issueType)));
    const onceKeys = new Set(prefs.dismissed.runStartedAt && prefs.dismissed.runStartedAt === state.startedAt
      ? prefs.dismissed.alerts.map(rule => ruleKey(rule.noteId, rule.issueType)) : []);
    const failures = (Array.isArray(state.failures) ? state.failures : []).map(item => annotateWithKeys(item, keys, onceKeys));
    const mutedFailureCount = failures.filter(item => item.alert.suppressed).length;
    const rawCount = Math.max(0, Number(state.failedPosts) || 0, failures.length);
    return { ...state, failures, activeFailureCount: rawCount - mutedFailureCount, mutedFailureCount,
      alertRules: prefs.rules.map(rule => ({ ...rule, label: LABELS[rule.issueType] })) };
  }

  return { LABELS, MAX_RULES, validId, validIssue, describeIssue, commentFailure, normalizePreferences, setRule, setOnce, annotateFailure, projectState };
});
