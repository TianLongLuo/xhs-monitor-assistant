"use strict";

// Execute the production callback verbatim; synthetic DOM and clock only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const source = readFileSync(join(__dirname, "../content.js"), "utf8");
const entry = source.indexOf("  async function readNoteInPageUnchecked(");
const start = source.indexOf("        onProgress(progress) {", entry);
const end = source.indexOf("\n      });", start);
assert.ok(entry >= 0 && start > entry && end > start);
const callback = source.slice(start, end);

function label(initial = "") {
  let value = initial;
  return {
    writes: 0,
    get textContent() { return value; },
    set textContent(next) { this.writes++; value = next; }
  };
}

function harness() {
  const h = { now: 0, heartbeats: [], queries: 0, status: label(), count: label() };
  const context = vm.createContext({
    Date: { now: () => h.now },
    showProcess: true,
    note: { noteId: "synthetic-note" },
    PROCESS_PANEL_CLASS: "test",
    processPanel: {
      dataset: { noteId: "synthetic-note" },
      querySelector(selector) {
        h.queries++;
        return selector.endsWith("__status") ? h.status : h.count;
      }
    },
    sendRuntime(message) { h.heartbeats.push({ at: h.now, ...message }); return Promise.resolve(); }
  });
  h.progress = vm.runInContext(`let lastHeartbeatAt = 0; ({${callback}\n}).onProgress`, context);
  h.context = context;
  return h;
}
const progress = (count = 1, extra = {}) => ({ count, expectedCount: 10, expectedCountKnown: true, pass: 1, ...extra });

test("consecutive identical values do not repeat DOM assignments", () => {
  const h = harness();
  for (let i = 0; i < 100; i++) h.progress(progress());
  assert.equal(h.status.writes, 1);
  assert.equal(h.count.writes, 1);
  assert.equal(h.queries, 200); // Deliberately no node cache.
});

test("real count, expected-total and pass changes update their affected labels", () => {
  const h = harness();
  h.progress(progress());
  h.progress(progress(2));
  assert.equal(h.count.textContent, "2 条");
  h.progress(progress(2, { expectedCount: 20 }));
  h.progress(progress(2, { expectedCount: 20, pass: 2 }));
  assert.equal(h.status.textContent, "评论 2/20 条 · 第 2 轮自动补读");
  assert.equal(h.status.writes, 4);
  assert.equal(h.count.writes, 2);
  h.progress(progress(2, { expectedCount: 0, expectedCountKnown: false }));
  assert.equal(h.status.textContent, "评论 2/? 条 · 正在展开与核验");
  h.progress(progress(2, { expectedCount: 0, expectedCountKnown: true }));
  assert.equal(h.status.textContent, "评论 2/0 条 · 正在展开与核验");
});

test("replacement nodes receive identical progress values without a stale cache", () => {
  const h = harness();
  h.progress(progress());
  const oldStatus = h.status;
  const oldCount = h.count;
  h.status = label(); h.count = label();
  h.progress(progress());
  assert.equal(h.status.writes, 1);
  assert.equal(h.count.writes, 1);
  assert.equal(h.status.textContent, oldStatus.textContent);
  assert.equal(h.count.textContent, oldCount.textContent);
  assert.equal(oldStatus.writes, 1);
  assert.equal(oldCount.writes, 1);
  h.status = null; h.count = null;
  assert.doesNotThrow(() => h.progress(progress()));
});

test("unchanged labels do not suppress the five-second heartbeat or its UI-independent guard", () => {
  const h = harness();
  for (const time of [0, 4999, 5000, 5001, 9999, 10000]) {
    h.now = time; h.progress(progress());
  }
  assert.deepEqual(h.heartbeats.map(item => item.at), [5000, 10000]);
  assert.equal(h.status.writes, 1);
  assert.equal(h.count.writes, 1);
  h.context.showProcess = false;
  h.now = 15000; h.progress(progress());
  h.context.showProcess = true;
  h.context.processPanel.dataset.noteId = "different-note";
  h.now = 20000; h.progress(progress());
  assert.deepEqual(h.heartbeats.map(item => item.at), [5000, 10000, 15000, 20000]);
  assert.ok(h.heartbeats.every(item => item.type === "commentReadHeartbeat" && item.noteId === "synthetic-note"));
  assert.equal(h.queries, 12);
});

test("repeatable P/U experiment counts assignments, not wall-clock sync speed", t => {
  const h = harness();
  const P = 10000;
  const U = 100;
  const baselineStatus = label(); const baselineCount = label();
  for (let i = 0; i < P; i++) {
    const value = progress(Math.floor(i / (P / U)), { expectedCount: U });
    h.progress(value);
    // Original two unconditional assignments, with the same synthetic input.
    baselineStatus.textContent = `评论 ${value.count}/${U} 条 · 正在展开与核验`;
    baselineCount.textContent = `${value.count} 条`;
  }
  assert.equal(h.status.writes, U);
  assert.equal(h.count.writes, U);
  assert.equal(h.queries, 2 * P);
  assert.equal(baselineStatus.writes + baselineCount.writes, 2 * P);
  assert.equal(h.status.textContent, baselineStatus.textContent);
  assert.equal(h.count.textContent, baselineCount.textContent);
  t.diagnostic(JSON.stringify({ P, U, beforeAssignments: 2 * P, afterAssignments: 2 * U,
    avoidedAssignments: 2 * (P - U), nodeQueries: h.queries, wallClockClaim: false }));
});
