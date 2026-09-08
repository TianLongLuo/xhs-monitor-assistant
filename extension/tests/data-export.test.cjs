"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { collectFilteredRows, toCsv } = require("../data-export.js");

const original = {
  dataset: "comments", snapshotToken: "verified-snapshot", fields: ["comment_id", "published_at"],
  search: "目标", filter: { logic: "and", children: [{ field: "is_deleted", operator: "is_false" }] },
  sort: [{ field: "published_at", direction: "desc" }], groupThreads: false,
};
const response = (payload, rows, total) => ({
  ok: true, consistentSnapshot: true, dataset: payload.dataset, snapshotToken: payload.snapshotToken,
  page: payload.page, pageSize: payload.pageSize, rows, total,
});

test("exports all filtered pages with frozen conditions, not the loaded subset", async () => {
  const payload = structuredClone(original);
  const calls = [];
  const all = Array.from({ length: 237 }, (_, i) => ({ comment_id: `c${i}`, published_at: "2026-09-03" }));
  const result = await collectFilteredRows(async (request) => {
    calls.push(structuredClone(request));
    payload.filter.children = []; // UI changes do not broaden this export.
    return response(request, all.slice((request.page - 1) * 200, request.page * 200), all.length);
  }, payload, { expectedTotal: 237 });
  assert.equal(result.rows.length, 237);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.filter, original.filter);
    assert.equal(call.search, "目标");
    assert.deepEqual(call.sort, original.sort);
    assert.equal(call.groupThreads, false);
  }
});

test("rejects changing snapshot instead of exporting partial or unfiltered data", async () => {
  await assert.rejects(collectFilteredRows(async p => ({
    ...response(p, [], 0), snapshotToken: "different"
  }), original), /快照/);
});

test("rejects duplicate and truncated pages", async () => {
  await assert.rejects(collectFilteredRows(async p => response(p, [{ comment_id: "c" }, { comment_id: "c" }], 2), original), /重复/);
  await assert.rejects(collectFilteredRows(async p => response(p, [{ comment_id: "c" }], 3), original), /不完整/);
});

test("rejects changed displayed count", async () => {
  await assert.rejects(collectFilteredRows(async p => response(p, [], 0), original, { expectedTotal: 1 }), /结果已变化/);
});

test("empty results and CSV escaping are explicit", async () => {
  const empty = await collectFilteredRows(async p => response(p, [], 0), original);
  assert.equal(empty.total, 0);
  const csv = toCsv([{ content: '=SUM(1,2)\n"原文"', published_at: "2026-09-03 09:30:00" }], [
    { key: "content", label: "正文", dataType: "text" },
    { key: "published_at", label: "发布时间", dataType: "datetime" },
  ]);
  assert.ok(csv.startsWith("\ufeff"));
  assert.ok(csv.includes("'=SUM(1,2)"));
  assert.ok(csv.includes('""原文""'));
  assert.ok(csv.includes("2026-09-03 09:30:00"));
});

test("CSV guards formula strings even in numeric columns while retaining numeric negatives", () => {
  const csv = toCsv([{n:"=1+2"},{n:"@SUM(1)"},{n:-12.5}], [{key:"n",dataType:"number"}]);
  assert.ok(csv.includes("'=1+2"));assert.ok(csv.includes("'@SUM(1)"));assert.ok(csv.includes('"-12.5"'));
});
