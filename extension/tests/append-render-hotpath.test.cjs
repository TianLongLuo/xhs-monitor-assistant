"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

// Reuse only the isolated VM/DOM fixture declarations, not its registered tests.
// That fixture evaluates production scripts verbatim and guards runtime traffic.
const fixturePath = join(__dirname, "data-overview-state.test.cjs");
const fixture = readFileSync(fixturePath, "utf8");
const firstTest = fixture.indexOf('\ntest("legacy views');
assert.ok(firstTest > 0, "Fixture declaration boundary must remain explicit");
const moduleFixture = { exports: {} };
vm.runInThisContext(`(function(require, module, __dirname) {\n${fixture.slice(0, firstTest)}
  module.exports = { harness, orderedPreferences, renderLoadedRows, rowsForExport };
})`, { filename: fixturePath })(require, moduleFixture, __dirname);
const { harness, orderedPreferences, renderLoadedRows, rowsForExport } = moduleFixture.exports;

const notes = (start, count) => Array.from({ length: count }, (_, offset) => ({
  note_id: "synthetic-note-" + (start + offset), title: "Synthetic title " + (start + offset)
}));

function append(h, rows) {
  h.state.rows = [...h.state.rows, ...rows];
  h.state.page++;
  h.state.hasMore = h.state.rows.length < h.state.total;
  h.renderTable({ rows }, { append: true, incomingRows: rows });
}

function probeRows(rows) {
  const counts = { childrenReads: 0, subtreeQueries: 0 };
  const restore = [];
  for (const row of rows) {
    const descriptor = Object.getOwnPropertyDescriptor(row, "children");
    Object.defineProperty(row, "children", { configurable: true, get() { counts.childrenReads++; return descriptor.value; } });
    for (const name of ["querySelector", "querySelectorAll"]) {
      const original = row[name];
      row[name] = function(...args) { counts.subtreeQueries++; return original.apply(this, args); };
      restore.push(() => { row[name] = original; });
    }
    restore.push(() => Object.defineProperty(row, "children", descriptor));
  }
  return { counts, stop() { restore.forEach(fn => fn()); } };
}

function tableState(h) {
  const cellState = cell => ({ field: cell.dataset.field || "", pinned: cell.dataset.pinned || "",
    left: cell.style.left || "", column: cell.getAttribute("aria-colindex"), text: cell.textContent,
    span: cell.rowSpan || 1, classes: cell.className,
    check: cell.querySelector("input") ? { checked: cell.querySelector("input").checked,
      disabled: cell.querySelector("input").disabled } : null });
  return { head: [...h.elements.tableHead.children].map(cellState),
    rows: [...h.elements.tableBody.children].map(row => ({ dataset: { ...row.dataset }, classes: row.className,
      cells: [...row.children].map(cellState) })),
    selectedCount: h.elements.selectedCount.textContent,
    deleteDisabled: h.elements.deleteSelected.disabled,
    findCount: h.elements.pageFindCount.textContent,
    findIndex: h.state.findIndex,
    findMatches: h.state.findMatches.map(cell => cell.textContent) };
}

test("plain append does not visit old pin/selection/find DOM, including large retained tables", async t => {
  for (const retained of [10, 1000]) {
    const h = await harness(t, orderedPreferences());
    renderLoadedRows(h, notes(0, retained), { total: retained + 20 });
    const old = [...h.elements.tableBody.children];
    const probe = probeRows(old);
    append(h, notes(retained, 20));
    probe.stop();
    assert.deepEqual(probe.counts, { childrenReads: 0, subtreeQueries: 0 }, `retained=${retained}`);
    assert.ok(old.every((row, index) => h.elements.tableBody.children[index] === row));
    for (const row of h.elements.tableBody.children.slice(retained)) {
      assert.equal(row.dataset.selected, "false");
      assert.equal(row.querySelector('[data-role="select-row"]').checked, false);
    }
  }
});

test("active selection and active find conservatively retain full update semantics", async t => {
  for (const kind of ["selected", "find"]) {
    const h = await harness(t, orderedPreferences());
    if (kind === "selected") h.state.selectedIds.add("synthetic-note-1");
    else h.state.findQuery = "Synthetic title";
    renderLoadedRows(h, notes(0, 3), { total: 6 });
    const probe = probeRows([...h.elements.tableBody.children]);
    append(h, notes(3, 3)); probe.stop();
    assert.ok(probe.counts.subtreeQueries > 0);
    const optimized = tableState(h);
    h.renderTable({ rows: h.state.rows });
    assert.deepEqual(tableState(h), optimized);
  }
});

test("new pinned rows match full render while existing rowspan and nodes survive", async t => {
  const h = await harness(t, orderedPreferences("comments"));
  const all = rowsForExport(5).map((row, index) => ({ ...row, thread_root_id: index < 4 ? "root-a" : "root-b" }));
  h.state.groupThreads = true;
  h.state.pinnedColumns.comments = ["__selection", "content", "thread_root_content", "__overview_comment_actions"];
  renderLoadedRows(h, all.slice(0, 2), { total: 5 });
  const root = h.elements.tableBody.children[0].querySelector('[data-field="thread_root_content"]');
  const old = [...h.elements.tableBody.children];
  append(h, all.slice(2));
  assert.equal(root.rowSpan, 4);
  assert.ok(old.every((row, index) => h.elements.tableBody.children[index] === row));
  assert.equal(h.elements.tableBody.children[2].querySelector('[data-field="thread_root_content"]'), null);
  const optimized = tableState(h);
  h.renderTable({ rows: all });
  assert.deepEqual(tableState(h), optimized);
});

test("unchanged pinned geometry touches only new rows and preserves both scroll axes", async t => {
  const h = await harness(t, orderedPreferences());
  h.state.pinnedColumns.notes = ["__selection", "title"];
  renderLoadedRows(h, notes(0, 100), { total: 110 });
  h.elements.tableViewport.scrollTop = 311; h.elements.tableViewport.scrollLeft = 222;
  const probe = probeRows([...h.elements.tableBody.children]);
  append(h, notes(100, 10)); probe.stop();
  assert.deepEqual(probe.counts, { childrenReads: 0, subtreeQueries: 0 });
  assert.equal(h.elements.tableViewport.scrollTop, 311);
  assert.equal(h.elements.tableViewport.scrollLeft, 222);
  assert.equal(h.elements.tableBody.children[100].querySelector('[data-field="title"]').style.left, "42px");
});

test("real pinned header width changes fall back to full offset repair", async t => {
  const h = await harness(t, orderedPreferences());
  h.state.pinnedColumns.notes = ["__selection", "title"];
  renderLoadedRows(h, notes(0, 4), { total: 6 });
  h.elements.tableHead.children[0].getBoundingClientRect = () => ({ width: 100 });
  const probe = probeRows([...h.elements.tableBody.children]);
  append(h, notes(4, 2)); probe.stop();
  assert.ok(probe.counts.childrenReads > 0, "Old offsets must be repaired after actual geometry changes");
  for (const row of h.elements.tableBody.children) assert.equal(row.querySelector('[data-field="title"]').style.left, "100px");
});

test("plain append output matches a full repaint including utility cells and empty selection controls", async t => {
  const h = await harness(t, orderedPreferences());
  renderLoadedRows(h, notes(0, 4), { total: 6 });
  append(h, notes(4, 2));
  const optimized = tableState(h);
  h.renderTable({ rows: h.state.rows });
  assert.deepEqual(tableState(h), optimized);
});

test("synthetic batch experiment counts avoided retained-row work, not wall-clock gains", async t => {
  const h = await harness(t, orderedPreferences());
  const batchSize = 100, batches = 10;
  renderLoadedRows(h, notes(0, batchSize), { total: batchSize * batches });
  let retainedRows = 0, childrenReads = 0, subtreeQueries = 0;
  for (let page = 1; page < batches; page++) {
    const old = [...h.elements.tableBody.children];
    retainedRows += old.length;
    const probe = probeRows(old);
    append(h, notes(page * batchSize, batchSize)); probe.stop();
    childrenReads += probe.counts.childrenReads; subtreeQueries += probe.counts.subtreeQueries;
  }
  assert.equal(retainedRows, 4500);
  assert.equal(childrenReads, 0); assert.equal(subtreeQueries, 0);
  t.diagnostic(JSON.stringify({ batchSize, batches, retainedRowVisitsPerOldFullPass: retainedRows,
    measuredOldRowChildrenReads: childrenReads, measuredOldRowSubtreeQueries: subtreeQueries,
    newRowsRendered: 900, wallClockClaim: false }));
});

test("result label marks only a matching browsing session and clears obsolete tooltip", () => {
  const source = readFileSync(join(__dirname, "../data-overview.js"), "utf8");
  const start = source.indexOf("  const browsingSnapshot = overviewReadSessions.has(overviewReadSessionKey(queryPayload()));");
  const end = source.indexOf("  elements.tableEmpty.hidden", start);
  assert.ok(start > 0 && end > start);
  const label = { textContent: "", title: "old tooltip" };
  for (const selected of [false, true]) {
    for (const filters of [[], [{}]]) {
      const sessions = new Map([[selected ? "current-query" : "different-query", "synthetic-session"]]);
      vm.runInNewContext(source.slice(start, end), {
        elements: { resultLabel: label }, state: { filters, search: "" }, overviewReadSessions: sessions,
        queryPayload: () => ({ key: "current-query" }), overviewReadSessionKey: payload => payload.key
      });
      assert.equal(label.textContent, (filters.length ? "条筛选结果" : "条结果") + (selected ? " · 快照" : ""));
      if (selected) { assert.match(label.title, /并非实时数据/); assert.match(label.title, /更新数据/); }
      else assert.equal(label.title, "");
    }
  }
});
