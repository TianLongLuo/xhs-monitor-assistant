"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { Blob } = require("node:buffer");
const { test } = require("node:test");
const vm = require("node:vm");

// Load production scripts verbatim, including their UI bootstrap, in a fresh VM.
// All data, runtime messages, storage, timers and downloads below stay in memory.
const scripts = ["data-export.js", "column-order.js", "data-overview.js"].map((name) => {
  const filename = join(__dirname, "..", name);
  return new vm.Script(readFileSync(filename, "utf8"), { filename });
});
const STORAGE_KEY = "xhsMonitorDataOverviewStateV1";
const SNAPSHOT = "fixture-snapshot";
const plain = (value) => JSON.parse(JSON.stringify(value));

// Only the tag/class/data-attribute selectors and select options used by this UI
// are modeled; no HTML engine, browser, extension API or external service is used.
class Element {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.value = "";
    this.title = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this._text = "";
    const tokens = () => new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList = {
      contains: (name) => tokens().has(name),
      add: (...names) => { this.className = [...new Set([...tokens(), ...names])].join(" "); },
      remove: (...names) => { this.className = [...tokens()].filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, force) => {
        const enabled = force ?? !tokens().has(name);
        this.classList[enabled ? "add" : "remove"](name);
        return enabled;
      },
    };
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this._text = String(value ?? ""); }
  set innerHTML(html) {
    this.replaceChildren();
    for (const [, attrs, label] of html.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)) {
      const option = new Element("option");
      option.value = /value="([^"]*)"/.exec(attrs)?.[1] || "";
      option.textContent = label;
      option.selected = /\bselected\b/.test(attrs);
      this.append(option);
    }
    this.value = (this.options.find((option) => option.selected) || this.options[0])?.value || "";
  }
  get options() { return this.children.filter((child) => child.tagName === "OPTION"); }
  append(...children) {
    for (const child of children) {
      child.remove();
      child.parentNode = this;
      this.children.push(child);
    }
  }
  insertBefore(child, reference = null) {
    if (reference !== null) assert.equal(reference.parentNode, this, "reference must belong to this parent");
    if (child === reference) return child;
    child.remove();
    const index = reference === null ? this.children.length : this.children.indexOf(reference);
    child.parentNode = this;
    this.children.splice(index, 0, child);
    return child;
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = "";
    this.append(...children);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) {
    if (name.startsWith("data-")) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())];
    return this.attributes.get(name);
  }
  matches(selector) {
    return selector.split(",").some((part) => {
      part = part.trim();
      assert.match(part, /^(?:[a-z][\w-]*)?(?:\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*$/i, "unsupported fixture selector");
      const tag = /^[a-z][\w-]*/i.exec(part)?.[0];
      return (!tag || tag.toUpperCase() === this.tagName)
        && [...part.matchAll(/\.([\w-]+)/g)].every(([, name]) => this.classList.contains(name))
        && [...part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) =>
          value === undefined ? this.getAttribute(name) !== undefined : this.getAttribute(name) === value);
    });
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    for (let element = this; element; element = element.parentNode) {
      if (element.matches(selector)) return element;
    }
    return null;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  emit(type, extra = {}) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...extra };
    return Promise.all((this.listeners.get(type) || []).map((listener) => listener(event)));
  }
  click() {
    if (this.disabled) return;
    this.onClick?.();
    return this.emit("click");
  }
}

function field(key, extra = {}) {
  return { key, label: key, source: "fixture", dataType: "text", filterable: true, sortable: true, defaultVisible: false, ...extra };
}
function dateFields(key, defaultVisible = false) {
  return [field(key, { dataType: "datetime", defaultVisible }),
    ...["raw", "precision", "status"].map((suffix) => field(key + "_" + suffix))];
}
function fixtureSchema() {
  const notes = [
    field("note_id", { defaultVisible: true }),
    field("open_material", { defaultVisible: true, action: "open_material", filterable: false, sortable: false }),
    field("ignore_status", { defaultVisible: true }), field("title", { defaultVisible: true }),
    ...dateFields("source_published_at", true), ...dateFields("source_updated_at"), field("time_observed_at"),
  ];
  const comments = [
    field("comment_id", { defaultVisible: true }), field("note_id", { defaultVisible: true }),
    field("post_locator", { defaultVisible: true, action: "locate_post", filterable: false, sortable: false }),
    field("thread_root_content", { defaultVisible: true }), field("content", { defaultVisible: true }),
    field("is_deleted", { dataType: "boolean" }), ...dateFields("published_at", true),
    field("time_observed_at"), field("thread_root_id"), field("thread_root_author"),
    ...dateFields("post__source_published_at"), ...dateFields("post__source_updated_at"), field("post__time_observed_at"),
  ];
  return {
    ok: true, snapshotToken: SNAPSHOT, queryReady: false, health: { summary: {} },
    operators: [
      { id: "eq", label: "equals", types: ["text", "datetime", "boolean"] },
      { id: "contains", label: "contains", types: ["text"] },
      { id: "between", label: "between", types: ["datetime"] },
      { id: "is_false", label: "false", types: ["boolean"] },
    ],
    datasets: Object.fromEntries(Object.entries({ notes, comments }).map(([dataset, fields]) => [dataset, {
      total: 0, fields: fields.map((item, displayOrder) => ({ ...item, displayOrder })),
    }])),
  };
}

async function harness(t, saved) {
  const storage = new Map(saved ? [[STORAGE_KEY, JSON.stringify(saved)]] : []);
  const ids = new Map();
  const body = new Element("body");
  const downloads = [], blobs = [], revoked = [], queries = [], messages = [], unexpected = [];
  const timers = new Map();
  const animationFrames = new Map();
  let nextFrame = 0, frameTime = 0;
  const requestAnimationFrame = (callback) => { animationFrames.set(++nextFrame, callback); return nextFrame; };
  const cancelAnimationFrame = (id) => animationFrames.delete(id);
  let nextTimer = 0, nextId = 0, queryHandler;
  const schema = fixtureSchema();
  const buttons = Object.fromEntries(["notes", "comments"].map((dataset) => {
    const button = new Element("button");
    button.className = "dataset-button";
    button.dataset.dataset = dataset;
    body.append(button);
    return [dataset, button];
  }));
  const document = {
    body,
    getElementById(id) {
      if (!ids.has(id)) {
        const element = new Element();
        element.hidden = ["pageFind", "columnFilterPopover", "filterPanel", "fieldPanel", "sortPanel"].includes(id);
        if (id === "tableEmpty") element.append(new Element("strong"), new Element("p"));
        ids.set(id, element);
        body.append(element);
      }
      return ids.get(id);
    },
    createElement(tag) {
      const element = new Element(tag);
      if (tag === "a") element.onClick = () => downloads.push({ href: element.href, filename: element.download });
      return element;
    },
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    addEventListener: (...args) => body.addEventListener(...args),
  };
  const context = vm.createContext({
    document, window: Object.assign(new Element("window"), { requestAnimationFrame, cancelAnimationFrame }), Blob,
    requestAnimationFrame, cancelAnimationFrame,
    crypto: { randomUUID: () => "fixture-id-" + ++nextId },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    setTimeout: (callback, delay = 0) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout: (id) => timers.delete(id), queueMicrotask,
    URL: {
      createObjectURL: (blob) => { blobs.push(blob); return "blob:fixture/" + blobs.length; },
      revokeObjectURL: (url) => revoked.push(url),
    },
    chrome: { runtime: { sendMessage(message, callback) {
      messages.push(plain(message));
      if (message.type === "getDataOverviewSchema") return callback(schema);
      if (message.type === "getDataOverviewValues") return callback({ ok: true, values: [], truncated: false, snapshotToken: SNAPSHOT });
      if (message.type !== "queryDataOverview" || !queryHandler) {
        unexpected.push(plain(message));
        return callback({ ok: false, error: "Unexpected fixture runtime request" });
      }
      const request = plain(message.payload); // Model Chrome's message serialization.
      queries.push(request);
      Promise.resolve().then(() => queryHandler(request)).then(callback, (error) => callback({ ok: false, error: error.message }));
    } } },
  });
  t.after(() => assert.deepEqual(unexpected, [], "all runtime traffic must have an explicit in-memory fixture"));
  for (const script of scripts) script.runInContext(context, { timeout: 1000 });
  const api = vm.runInContext(`({
    state, elements, queryPayload, renderCell, exportCurrentPage,
    currentVisibleFields, tableLayoutFields, orderedDatasetFields, renderTable, renderFieldOptions, renderFilters, renderSorts,
    loadSchema, runQuery, resetCurrentView, filterDraftProblem, validateFilterDraft, makeValueInput, scheduleQuery,
    reorderColumn: typeof reorderColumn === "function" ? reorderColumn : undefined,
    resetColumnOrder: typeof resetColumnOrder === "function" ? resetColumnOrder : undefined,
  })`, context);
  await Promise.resolve(); // Finish the one schema-bootstrap continuation; it cannot issue a query.
  assert.equal(api.state.schema, schema, "bootstrap/rendering must finish without a swallowed stub error");
  assert.equal(api.elements.refreshSchema.disabled, false);
  return {
    ...api, schema, document, window: context.window, buttons, storage, downloads, blobs, revoked, queries, messages, timers,
    respondWith(handler) { queryHandler = handler; },
    flushAnimationFrames() {
      // Execute queued callbacks, rather than hiding deferred work with a no-op.
      for (let batch = 0; animationFrames.size && batch < 10; batch += 1) {
        frameTime += 16;
        for (const [id, callback] of [...animationFrames]) {
          if (animationFrames.delete(id)) callback(frameTime);
        }
      }
      assert.equal(animationFrames.size, 0, "fixture animation work must settle within ten frames");
    },
    fireTimer(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, "expected a " + delay + "ms fixture timer");
      timers.delete(entry[0]);
      entry[1].callback();
    },
  };
}

function preferences(dataset = "notes") {
  return {
    version: 2, dataset,
    visibleFields: { notes: ["note_id", "title"], comments: ["comment_id", "content", "published_at"] },
    savedViews: {
      notes: {
        search: "notes query", filterLogic: "and", groupThreads: true,
        filters: [{ id: "nf", field: "title", operator: "contains", value: "note term", value2: "" }],
        sorts: [{ id: "ns", field: "source_published_at", direction: "asc" }],
      },
      comments: {
        search: "comments query", filterLogic: "or", groupThreads: false,
        filters: [{ id: "cf", field: "content", operator: "contains", value: "comment term", value2: "" }],
        sorts: [{ id: "cs", field: "published_at", direction: "desc" }],
      },
    },
  };
}
function activeView(state) {
  const { search, filterLogic, filters, sorts, groupThreads } = state;
  return plain({ search, filterLogic, filters, sorts, groupThreads });
}
function stored(h) { return JSON.parse(h.storage.get(STORAGE_KEY)); }
function rowsForExport(total = 237) {
  return Array.from({ length: total }, (_, index) => ({
    comment_id: "c" + index, note_id: "fixture-note", thread_root_content: "fixture-root",
    content: "filtered-" + index, published_at: "2026-09-03 09:30:00",
  }));
}
function prepareExport(h, rows = rowsForExport()) {
  Object.assign(h.state, {
    dataset: "comments", queryReady: true, snapshotToken: SNAPSHOT, total: rows.length,
    page: 1, pageSize: 100, rows: rows.slice(0, 100), search: "frozen needle", filterLogic: "or", groupThreads: false,
    filters: [{ id: "f1", field: "content", operator: "contains", value: "filtered", value2: "" },
      { id: "f2", field: "published_at", operator: "between", value: "2026-09-01", value2: "2026-09-03" }],
    sorts: [{ id: "s1", field: "published_at", direction: "desc" }, { id: "s2", field: "comment_id", direction: "asc" }],
  });
  h.state.visibleFields.comments = ["comment_id", "content", "published_at", "post_locator"];
  return rows;
}
function pageResult(request, all) {
  return {
    ok: true, consistentSnapshot: true, dataset: request.dataset, snapshotToken: request.snapshotToken,
    page: request.page, pageSize: request.pageSize, total: all.length,
    rows: all.slice((request.page - 1) * request.pageSize, request.page * request.pageSize),
  };
}

function requireColumnOrder(h) {
  // Missing parent implementation is a real, explicitly diagnosed failure, not
  // a skipped test or a replacement implementation injected into the VM.
  assert.equal(typeof h.reorderColumn, "function", "not-ready: reorderColumn is missing from data-overview.js");
  assert.equal(typeof h.resetColumnOrder, "function", "not-ready: resetColumnOrder is missing from data-overview.js");
  for (const dataset of ["notes", "comments"]) {
    assert.ok(Array.isArray(h.state.columnOrder?.[dataset]), "not-ready: state.columnOrder." + dataset);
  }
}
const visualKeys = (h) => plain(h.currentVisibleFields());
const domFieldKeys = (row) => row.children.filter((cell) => cell.dataset.field && cell.dataset.utility !== "comment-actions").map((cell) => cell.dataset.field);
function orderedPreferences(dataset = "notes") {
  return { ...preferences(dataset), version: 3, columnOrder: {
    notes: ["title", "note_id", "open_material", "ignore_status"],
    comments: ["content", "comment_id", "note_id", "post_locator", "thread_root_content", "published_at"],
  } };
}
function renderLoadedRows(h, rows, { total = rows.length, pageSize = 100 } = {}) {
  Object.assign(h.state, { queryReady: true, rows, total, page: 1, pageSize, hasMore: rows.length < total });
  h.renderTable({ rows });
  h.flushAnimationFrames();
}
async function setFieldVisible(h, key, checked) {
  const input = h.elements.fieldOptions.querySelector('input[data-field="' + key + '"]');
  assert.ok(input, "real field checkbox exists: " + key);
  assert.equal(input.disabled, false, "only optional fields are toggled");
  input.checked = checked;
  await h.elements.fieldOptions.emit("change", { target: input });
}
function localSnapshot(h) {
  const keys = ["dataset", "visibleFields", "search", "filterLogic", "filters", "sorts", "groupThreads",
    "rows", "page", "pageSize", "total", "hasMore", "loading", "queryReady", "snapshotToken",
    "querySerial", "queryPending", "resetScheduled", "exporting"];
  return {
    state: plain({ ...Object.fromEntries(keys.map((key) => [key, h.state[key]])), selectedIds: [...h.state.selectedIds] }),
    refs: Object.fromEntries(["rows", "filters", "sorts", "selectedIds"].map((key) => [key, h.state[key]])),
    messages: plain(h.messages),
    // Toast/download cleanup timers are allowed; deferred query work is not.
    queryTimers: [...h.timers].filter(([, timer]) => timer.delay < 1000),
    scroll: [h.elements.tableViewport.scrollTop, h.elements.tableViewport.scrollLeft],
  };
}
function assertLocalUnchanged(h, before) {
  const after = localSnapshot(h);
  assert.deepEqual(after.state, before.state, "column order must not change query, visibility, selection or rows");
  for (const [key, reference] of Object.entries(before.refs)) assert.equal(h.state[key], reference, key + " identity");
  assert.deepEqual(after.messages, before.messages, "no runtime request, including schema refreshes");
  assert.deepEqual(after.queryTimers, before.queryTimers, "no scheduled backend query");
  assert.deepEqual(after.scroll, before.scroll, "keep the current viewport");
}
function assertCanonicalMenus(h) {
  const canonical = [...h.schema.datasets[h.state.dataset].fields].sort((a, b) => a.displayOrder - b.displayOrder);
  assert.deepEqual(plain(h.orderedDatasetFields()).map((item) => item.key), canonical.map((item) => item.key));
  h.renderFilters();
  h.renderSorts();
  for (const [container, property] of [[h.elements.filterRows, "filterable"], [h.elements.sortRows, "sortable"]]) {
    const menu = container.querySelector('select[data-role="field"]');
    assert.ok(menu, "fixture has a populated " + property + " menu");
    assert.deepEqual(menu.options.map((option) => option.value), canonical.filter((item) => item[property]).map((item) => item.key));
  }
}
function assertTableColumns(h, keys) {
  const token = (cell) => cell.classList.contains("select-column") ? "$select"
    : cell.classList.contains("row-number-column") ? "$number" : cell.dataset.field;
  const expected = ["$select", "$number", ...keys, ...(h.state.dataset === "comments" ? ["__overview_comment_actions"] : [])];
  assert.deepEqual(h.elements.tableHead.children.map(token), expected);
  assert.ok(h.elements.tableHead.children[0].querySelector('[data-role="select-loaded"]'));
  assert.equal(h.elements.tableHead.children[1].textContent, "#");
  h.elements.tableHead.children.slice(2).forEach((cell, index) => {
    assert.equal(cell.getAttribute("aria-colindex"), String(index + 3));
  });
  // Expand physical cells into logical slots using only DOM rowSpan values.
  // This catches a shifted merged cell even when a reply has one fewer <td>.
  const spans = new Map();
  h.elements.tableBody.children.forEach((row, rowIndex) => {
    const slots = [];
    for (const [index, span] of spans) {
      slots[index] = span.key;
      if (--span.remaining === 0) spans.delete(index);
    }
    let column = 0;
    for (const cell of row.children) {
      while (slots[column] !== undefined) column += 1;
      assert.ok(token(cell), "every data cell, including merged roots, needs dataset.field");
      slots[column] = token(cell);
      if (cell.dataset.field) assert.equal(cell.getAttribute("aria-colindex"), String(column + 1));
      const rowSpan = Number(cell.rowSpan || 1);
      if (rowSpan > 1) spans.set(column, { key: token(cell), remaining: rowSpan - 1 });
      column += 1;
    }
    assert.deepEqual(slots, expected, "logical column alignment for row " + rowIndex);
    assert.equal(token(row.children[0]), "$select");
    assert.ok(row.children[0].querySelector('[data-role="select-row"]'));
    assert.equal(token(row.children[1]), "$number");
    assert.equal(row.children[1].textContent, String(rowIndex + 1));
    assert.equal(row.dataset.index, String(rowIndex));
  });
  assert.equal(spans.size, 0, "rowspans end within the rendered rows");
}

function dispatchFixtureEvent(type, receivers, init = {}) {
  // Explicit receiver paths model the relevant bubbling ancestors without an
  // HTML engine. Invoke only listeners installed by the real UI bootstrap.
  let stopped = false;
  const event = {
    type, target: receivers[0], defaultPrevented: false, ...init,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { stopped = true; },
  };
  for (const receiver of receivers) {
    event.currentTarget = receiver;
    for (const listener of receiver.listeners.get(type) || []) listener.call(receiver, event);
    if (stopped) break;
  }
  event.currentTarget = null;
  return event;
}
async function gestureHarness(t) {
  const saved = preferences("comments");
  saved.savedViews.comments.groupThreads = true;
  saved.savedViews.comments.sorts = [{ id: "thread-sort", field: "content", direction: "asc" }];
  const h = await harness(t, saved);
  requireColumnOrder(h);
  h.state.selectedIds.add("c1");
  const rows = rowsForExport(2).map((record) => ({ ...record, thread_root_id: "root-a", thread_root_author: "author A" }));
  renderLoadedRows(h, rows, { total: 4, pageSize: 2 });
  const viewport = h.elements.tableViewport;
  Object.assign(viewport, { scrollTop: 137, scrollLeft: 23, scrollHeight: 2000, clientHeight: 400,
    scrollWidth: 1044, clientWidth: 844 });
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  viewport.getBoundingClientRect = () => rect(20, 30, 844, 400);
  for (const header of h.elements.tableHead.children) {
    header.getBoundingClientRect = () => {
      const index = h.elements.tableHead.children.indexOf(header);
      // Sticky utility columns are 42px; data-column rectangles follow their
      // current DOM positions and the nonzero horizontal scroll offset.
      return rect(index < 2 ? 20 + index * 42 : 104 + (index - 2) * 160 - viewport.scrollLeft,
        30, index < 2 ? 42 : 160, 40);
    };
  }
  const source = h.elements.tableHead.querySelector('th[data-field="thread_root_content"]');
  const target = h.elements.tableHead.querySelector('th[data-field="comment_id"]');
  assert.ok(source);
  assert.ok(target);
  const point = (header, fraction) => {
    const bounds = header.getBoundingClientRect();
    return { clientX: bounds.left + bounds.width * fraction, clientY: bounds.top + bounds.height / 2 };
  };
  const values = new Map();
  const dataTransfer = { effectAllowed: "uninitialized", dropEffect: "none",
    setData: (type, value) => values.set(type, String(value)), getData: (type) => values.get(type) || "" };
  return { ...h, source, target, dataTransfer,
    eventPath: [h.elements.tableHead, viewport, h.window],
    startPoint: point(source, 0.5), dropPoint: point(target, 0.25),
  };
}
function assertDragFinished(h) {
  assert.equal(h.elements.tableViewport.classList.contains("is-column-dragging"), false);
  for (const header of h.elements.tableHead.children) {
    assert.equal(header.classList.contains("is-drag-source"), false);
    assert.equal(header.dataset.dropSide, undefined);
  }
}

test("legacy views default groupThreads on, while an explicitly saved false survives reload", async (t) => {
  const saved = preferences();
  delete saved.savedViews.notes.groupThreads;
  const h = await harness(t, saved);
  assert.equal(h.state.groupThreads, true);
  assert.equal(stored(h).savedViews.notes.groupThreads, true);
  assert.equal(stored(h).savedViews.comments.groupThreads, false);
  await h.buttons.comments.emit("click");
  const reloaded = await harness(t, stored(h));
  assert.equal(reloaded.state.dataset, "comments");
  assert.equal(reloaded.state.groupThreads, false);
  assert.equal(reloaded.elements.groupThreads.checked, false);
});

test("dataset switches retain independent search, filters, sorts, columns and grouping preferences", async (t) => {
  const saved = preferences();
  const h = await harness(t, saved);
  assert.deepEqual(activeView(h.state), saved.savedViews.notes);
  assert.equal(h.elements.threadGroupingRow.hidden, true);
  await h.buttons.comments.emit("click");
  assert.deepEqual(activeView(h.state), saved.savedViews.comments);
  assert.equal(h.elements.globalSearch.value, "comments query");
  assert.equal(h.elements.threadGroupingRow.hidden, false);
  h.elements.groupThreads.checked = true;
  await h.elements.groupThreads.emit("change");
  assert.equal(h.state.groupThreads, true);
  assert.equal(stored(h).savedViews.comments.groupThreads, true);
  h.elements.groupThreads.checked = false;
  await h.elements.groupThreads.emit("change");
  await h.buttons.notes.emit("click");
  assert.deepEqual(activeView(h.state), saved.savedViews.notes);
  assert.equal(h.elements.globalSearch.value, "notes query");
  assert.equal(h.elements.groupThreads.checked, h.state.dataset === "comments" && h.state.groupThreads);
  await h.buttons.comments.emit("click");
  assert.deepEqual(activeView(h.state), saved.savedViews.comments);
  assert.deepEqual(stored(h).visibleFields, saved.visibleFields);
  assert.deepEqual(stored(h).savedViews, {
    notes: { ...saved.savedViews.notes, semanticSearch: false },
    comments: { ...saved.savedViews.comments, semanticSearch: false },
  });
});

test("reset restores only the active dataset's defaults, including groupThreads, and schedules a fresh query", async (t) => {
  const saved = preferences("comments");
  const h = await harness(t, saved);
  h.state.selectedIds.add("fixture-selected");
  h.elements.fieldSearch.value = "published";
  await h.elements.resetView.emit("click");
  assert.deepEqual(activeView(h.state), { search: "", filterLogic: "and", filters: [], sorts: [], groupThreads: true });
  assert.equal(h.elements.globalSearch.value, "");
  assert.equal(h.elements.fieldSearch.value, "");
  assert.equal(h.elements.groupThreads.checked, h.state.dataset === "comments" && h.state.groupThreads);
  assert.equal(h.state.selectedIds.size, 0);
  assert.equal(h.state.resetScheduled, true);
  assert.equal(h.elements.exportCurrent.disabled, true);
  assert.ok([...h.timers.values()].some((timer) => timer.delay === 0));
  assert.deepEqual(stored(h).visibleFields.comments,
    ["comment_id", "note_id", "post_locator", "thread_root_content", "content", "published_at"]);
  assert.deepEqual(stored(h).savedViews.notes, { ...saved.savedViews.notes, semanticSearch: false });
  assert.deepEqual(stored(h).visibleFields.notes, saved.visibleFields.notes);
  assert.deepEqual(stored(h).savedViews.comments, { ...activeView(h.state), semanticSearch: false });
});

test("normalized date cells display the normalized value and retain raw text and the correct observation clock in tooltips", async (t) => {
  const h = await harness(t);
  for (const key of ["published_at", "source_published_at", "source_updated_at", "post__source_published_at", "post__source_updated_at"]) {
    const value = "2026-09-01 18:04:05";
    const raw = "9月1日 18:04:05 上海 <原文>";
    const record = { [key]: value, [key + "_raw"]: raw, [key + "_precision"]: "second", [key + "_status"]: "exact",
      time_observed_at: "2026-09-02 10:00:00", post__time_observed_at: "2026-09-01 20:00:00" };
    const td = new Element("td");
    h.renderCell(td, value, key, "datetime", {}, record);
    assert.equal(td.textContent, value, key);
    assert.equal(td.title, "原文：" + raw + "\n北京时间：" + value + "\n采集基准："
      + record[key.startsWith("post__") ? "post__time_observed_at" : "time_observed_at"] + "\n精度：秒", key);
    assert.equal(td.querySelector(".date-estimate"), null, key);
    assert.equal(td.children.length, 0, "raw markup must stay text, not become DOM");
  }
});

test("estimated dates get a mark; edited-only and missing dates never masquerade as normalized timestamps", async (t) => {
  const h = await harness(t);
  const cases = [
    { value: "2026-09-03 08:00:00", raw: "2小时前", status: "estimated", precision: "hour", label: "小时（约）", display: "2026-09-03 08:00:00推算", marked: true },
    { value: "2026-09-01", raw: "09-01", status: "estimated", precision: "day", label: "日", display: "2026-09-01推算", marked: true },
    { value: "", raw: "编辑于昨天", status: "edited_only", display: "待按编辑时间换算" },
    { value: null, raw: "", status: "missing", display: "待补充" },
    { value: undefined, raw: "时间待核验", status: "estimated", display: "待补充" },
  ];
  for (const item of cases) {
    const td = new Element("td");
    h.renderCell(td, item.value, "published_at", "datetime", {}, {
      published_at_raw: item.raw, published_at_status: item.status, published_at_precision: item.precision,
    });
    assert.equal(td.textContent, item.display);
    assert.equal(td.querySelectorAll(".date-estimate").length, item.marked ? 1 : 0);
    assert.ok(td.title.includes("原文：" + (item.raw || "未显示")));
    assert.ok(td.title.includes("北京时间：" + (item.value || "待核验")));
    assert.ok(td.title.includes("采集基准：未记录"));
    assert.ok(td.title.includes("精度：" + (item.label || "未确定")));
    assert.equal(td.title.includes("相对时间或年份推算，原文已保留"), item.status === "estimated");
  }
});

test("query payload adds available date metadata exactly once without changing visible column preferences", async (t) => {
  const h = await harness(t);
  for (const dataset of ["notes", "comments"]) {
    h.state.dataset = dataset;
    const dates = dataset === "notes" ? ["source_published_at", "source_updated_at"]
      : ["published_at", "post__source_published_at", "post__source_updated_at"];
    const observed = dataset === "notes" ? ["time_observed_at"] : ["time_observed_at", "post__time_observed_at"];
    const required = dataset === "notes" ? ["note_id", "open_material", "ignore_status"]
      : ["comment_id", "note_id", "post_locator", "thread_root_content", "thread_root_id", "thread_root_author"];
    // Optional metadata may be absent on an older schema; explicitly selected
    // raw/observation columns must not be appended a second time.
    const absent = dataset === "comments" ? "post__source_updated_at_status" : "absent-fixture-field";
    h.schema.datasets[dataset].fields = h.schema.datasets[dataset].fields.filter((item) => item.key !== absent);
    h.state.visibleFields[dataset] = [...dates, dates[0] + "_raw", ...observed];
    const before = plain(h.state.visibleFields);
    const payload = plain(h.queryPayload(3));
    const expected = [...required, ...observed,
      ...dates.flatMap((key) => [key, ...["raw", "precision", "status"].map((suffix) => key + "_" + suffix)])]
      .filter((key) => key !== absent);
    assert.deepEqual([...new Set(payload.fields)].sort(), expected.sort(), dataset);
    assert.deepEqual(plain(h.state.visibleFields), before);
    assert.equal(payload.fields.length, new Set(payload.fields).size,
      dataset + ": selected date metadata must not be duplicated in the request");
  }
});

test("edited timestamps fill the publication column with an edit-derived provenance badge", async (t) => {
  const h = await harness(t);
  for (const key of ["source_published_at", "post__source_published_at"]) {
    const td = new Element("td");
    const record = {
      [key]: "2026-08-27", [key + "_raw"]: "编辑于7天前 广东",
      [key + "_precision"]: "day", [key + "_status"]: "estimated_from_edit",
      time_observed_at: "2026-09-03T12:00:00+08:00", post__time_observed_at: "2026-09-03T12:00:00+08:00",
    };
    h.renderCell(td, record[key], key, "datetime", {}, record);
    assert.equal(td.textContent, "2026-08-27编辑推算");
    assert.equal(td.querySelector(".date-estimate").textContent, "编辑推算");
    assert.match(td.title, /编辑于7天前 广东/);
    assert.match(td.title, /2026-09-03T12:00:00\+08:00/);
    assert.match(td.title, /不代表首次发布时间/);
  }
});

test("query payload preserves search/filter/sort semantics, strips UI IDs and groups only opted-in comments", async (t) => {
  const h = await harness(t);
  prepareExport(h);
  for (const dataset of ["notes", "comments"]) {
    h.state.dataset = dataset;
    const textKey = dataset === "notes" ? "title" : "content";
    const dateKey = dataset === "notes" ? "source_published_at" : "published_at";
    const primary = dataset === "notes" ? "note_id" : "comment_id";
    h.state.visibleFields[dataset] = [textKey];
    h.state.filters[0].field = textKey;
    h.state.filters[1].field = dateKey;
    h.state.sorts[0].field = dateKey;
    h.state.sorts[1].field = primary;
    for (const grouping of [true, false]) {
      h.state.groupThreads = grouping;
      const payload = plain(h.queryPayload(4));
      assert.equal(payload.dataset, dataset);
      assert.equal(payload.snapshotToken, SNAPSHOT);
      assert.equal(payload.page, 4);
      assert.equal(payload.pageSize, 100);
      assert.equal(payload.search, "frozen needle");
      assert.deepEqual(payload.filter, { logic: "or", children: [
        { field: textKey, operator: "contains", value: "filtered", value2: "" },
        { field: dateKey, operator: "between", value: "2026-09-01", value2: "2026-09-03" },
      ] });
      assert.deepEqual(payload.sort, [{ field: dateKey, direction: "desc" }, { field: primary, direction: "asc" }]);
      assert.equal(payload.groupThreads, dataset === "comments" && grouping);
      assert.equal(payload.fields.includes("time_observed_at"), false, "no date metadata for non-date columns");
      if (dataset === "comments") {
        assert.ok(payload.fields.includes("thread_root_id"));
        assert.ok(payload.fields.includes("thread_root_author"));
      }
      assert.equal(h.state.filters[0].id, "f1");
      assert.equal(h.state.sorts[0].id, "s1");
    }
  }
});

test("export click freezes its entry view and fetches every filtered page, not state.rows", { timeout: 3000 }, async (t) => {
  const h = await harness(t);
  const all = prepareExport(h);
  let releaseFirst;
  const firstPage = new Promise((resolve) => { releaseFirst = resolve; });
  h.respondWith((request) => request.page === 1 ? firstPage : pageResult(request, all));
  const exporting = h.elements.exportCurrent.emit("click");
  assert.equal(h.queries.length, 1, "the UI entry must fetch, not serialize loaded rows");
  assert.equal(h.state.exporting, true);
  assert.equal(h.elements.exportCurrent.disabled, true);
  await h.exportCurrentPage();
  assert.equal(h.queries.length, 1, "a second click must not start a concurrent export");

  // Mutate existing filter/sort objects while page one is in flight, as well as
  // replacing the UI's dataset/rows/columns. Every export page must stay frozen.
  h.elements.globalSearch.value = "later search";
  await h.elements.globalSearch.emit("input");
  h.state.filters[0].value = "later filter";
  h.state.filters[1].value2 = "2030-01-01";
  h.state.sorts[0].direction = "asc";
  h.state.filterLogic = "and";
  h.state.groupThreads = true;
  h.state.visibleFields.comments = ["content"];
  h.state.rows = [{ comment_id: "ui-only-row", content: "not exported" }];
  h.state.total = 1;
  h.state.snapshotToken = "later-snapshot";
  h.state.dataset = "notes";
  releaseFirst(pageResult(h.queries[0], all));
  await exporting;

  assert.deepEqual(h.queries.map((request) => request.page), [1, 2]);
  for (const request of h.queries) {
    assert.equal(request.dataset, "comments");
    assert.equal(request.snapshotToken, SNAPSHOT);
    assert.equal(request.pageSize, 200);
    assert.equal(request.search, "frozen needle");
    assert.equal(request.groupThreads, false);
    assert.deepEqual(request.filter, { logic: "or", children: [
      { field: "content", operator: "contains", value: "filtered", value2: "" },
      { field: "published_at", operator: "between", value: "2026-09-01", value2: "2026-09-03" },
    ] });
    assert.deepEqual(request.sort, [{ field: "published_at", direction: "desc" }, { field: "comment_id", direction: "asc" }]);
    assert.deepEqual(request.fields, ["comment_id", "note_id", "thread_root_content", "content", "published_at"]);
  }
  assert.equal(h.downloads.length, 1);
  assert.match(h.downloads[0].filename, /^XHS-Monitor_comments_\d{4}-\d{2}-\d{2}_filtered-237\.csv$/);
  assert.equal(h.blobs.length, 1);
  assert.equal(h.blobs[0].type, "text/csv;charset=utf-8");
  const csv = Buffer.from(await h.blobs[0].arrayBuffer()).toString("utf8");
  const expectedLines = ['\ufeff"comment_id","note_id","thread_root_content","content","published_at"',
    ...all.map((row) => '"' + row.comment_id + '","fixture-note","fixture-root","' + row.content + '","' + row.published_at + '"')];
  assert.equal(csv, expectedLines.join("\r\n"), "all 237 filtered rows and only the original data columns are exported");
  assert.equal(h.document.body.querySelectorAll("a").length, 0, "temporary download link is removed");
  h.fireTimer(1000);
  assert.deepEqual(h.revoked, [h.downloads[0].href]);
  assert.equal(h.state.exporting, false);
  assert.equal(h.elements.exportLabel.textContent, "导出筛选结果");
  assert.equal(h.elements.exportCurrent.disabled, true, "a new pending UI query stays locked after export");
});

test("export entry creates no download on displayed-count or later-page snapshot/count changes", { timeout: 3000 }, async (t) => {
  for (const failure of ["displayed-count", "snapshot", "later-count"]) {
    const h = await harness(t);
    const all = prepareExport(h);
    if (failure === "displayed-count") h.state.total = all.length - 1;
    h.respondWith((request) => {
      const result = pageResult(request, all);
      if (request.page === 2 && failure === "snapshot") result.snapshotToken = "changed-snapshot";
      if (request.page === 2 && failure === "later-count") result.total += 1;
      return result;
    });
    await h.elements.exportCurrent.emit("click");
    assert.equal(h.queries.length, failure === "displayed-count" ? 1 : 2, failure);
    assert.deepEqual(h.downloads, [], failure);
    assert.deepEqual(h.blobs, [], failure);
    assert.match(h.elements.toast.textContent, failure === "snapshot" ? /快照发生变化/ : /结果已变化|数量发生变化/);
    assert.equal(h.state.exporting, false);
    assert.equal(h.elements.exportLabel.textContent, "导出筛选结果");
    assert.equal(h.elements.exportCurrent.disabled, false);
  }
});

test("export is blocked during a debounced reset, a queued query, loading or an unverified view", async (t) => {
  const h = await harness(t);
  prepareExport(h);
  await h.elements.globalSearch.emit("input");
  assert.equal(h.state.resetScheduled, true, "exercise the real search-input/scheduleQuery path");
  assert.equal(h.state.loading, false);
  assert.equal(h.elements.exportCurrent.disabled, true);
  await h.exportCurrentPage(); // Exercise the guard even if invoked despite a disabled button.
  assert.match(h.elements.toast.textContent, /请等待当前筛选查询完成后再导出/);
  for (const flags of [{ queryPending: true }, { loading: true }, { queryReady: false }]) {
    Object.assign(h.state, { resetScheduled: false, queryPending: false, loading: false, queryReady: true }, flags);
    h.elements.toast.textContent = "";
    await h.exportCurrentPage();
    assert.match(h.elements.toast.textContent, /请等待当前筛选查询完成后再导出/);
    assert.equal(h.state.exporting, false);
  }
  assert.deepEqual(h.queries, []);
  assert.deepEqual(h.downloads, []);
  assert.deepEqual(h.blobs, []);
});

test("column order: legacy preferences migrate to v4 and a reorder survives a fresh VM reload", async (t) => {
  const h = await harness(t, preferences());
  requireColumnOrder(h);
  assert.deepEqual(plain(h.state.columnOrder), { notes: [], comments: [] });
  assert.equal(stored(h).version, 4);
  const visibleBefore = plain(h.state.visibleFields);
  renderLoadedRows(h, [{ note_id: "n1", title: "first note" }]);
  const before = localSnapshot(h);
  assert.equal(h.reorderColumn("title", "note_id"), true);
  h.flushAnimationFrames();
  const expected = ["title", "note_id", "open_material", "ignore_status"];
  assert.deepEqual(visualKeys(h), expected);
  assertTableColumns(h, expected);
  assertLocalUnchanged(h, before);
  assert.deepEqual(stored(h).columnOrder, plain(h.state.columnOrder));
  assert.deepEqual(stored(h).visibleFields, visibleBefore);
  const reloaded = await harness(t, stored(h));
  requireColumnOrder(reloaded);
  assert.deepEqual(visualKeys(reloaded), expected);
  assert.deepEqual(plain(reloaded.state.columnOrder), plain(h.state.columnOrder));
  assert.equal(stored(reloaded).version, 4);

  const dirty = stored(h);
  dirty.columnOrder.notes.push("title", "", null, 7, "x".repeat(161), "removed_schema_key");
  const sanitized = await harness(t, dirty);
  requireColumnOrder(sanitized);
  assert.deepEqual(visualKeys(sanitized), expected, "invalid or removed keys do not become visible columns");
  const savedKeys = plain(sanitized.state.columnOrder.notes);
  assert.equal(savedKeys.length, new Set(savedKeys).size);
  assert.ok(savedKeys.every((key) => typeof key === "string" && key.length > 0 && key.length <= 160));
});

test("column order: datasets remain independent and filter/sort menus stay canonical", async (t) => {
  const saved = orderedPreferences();
  const h = await harness(t, saved);
  requireColumnOrder(h);
  const schemaBefore = plain(h.schema.datasets);
  assert.deepEqual(visualKeys(h), saved.columnOrder.notes);
  assertCanonicalMenus(h);
  assert.equal(h.reorderColumn("ignore_status", "title"), true);
  const notesOrder = plain(h.state.columnOrder.notes);
  assert.deepEqual(plain(h.state.columnOrder.comments), saved.columnOrder.comments);
  assertCanonicalMenus(h);
  await h.buttons.comments.emit("click");
  assert.deepEqual(visualKeys(h), saved.columnOrder.comments);
  assert.equal(h.reorderColumn("published_at", "content"), true);
  const commentsOrder = plain(h.state.columnOrder.comments);
  assert.deepEqual(plain(h.state.columnOrder.notes), notesOrder);
  assertCanonicalMenus(h);
  await h.buttons.notes.emit("click");
  assert.deepEqual(visualKeys(h), ["ignore_status", "title", "note_id", "open_material"]);
  assert.deepEqual(plain(h.state.columnOrder.comments), commentsOrder);
  assert.deepEqual(plain(h.schema.datasets), schemaBefore, "visual moves never sort the schema in place");
  assert.deepEqual(stored(h).savedViews, {
    notes: { ...saved.savedViews.notes, semanticSearch: false },
    comments: { ...saved.savedViews.comments, semanticSearch: false },
  });
  assert.deepEqual(stored(h).visibleFields, saved.visibleFields);
  const reloaded = await harness(t, stored(h));
  assert.deepEqual(plain(reloaded.state.columnOrder), { notes: notesOrder, comments: commentsOrder });
  await reloaded.buttons.comments.emit("click");
  assert.deepEqual(visualKeys(reloaded), ["published_at", "content", "comment_id", "note_id", "post_locator", "thread_root_content"]);
  assertCanonicalMenus(reloaded);
});

test("column order: hiding, reloading and showing a field retain order across schema changes", async (t) => {
  const saved = orderedPreferences();
  saved.visibleFields.notes = ["note_id", "title", "source_published_at", "source_updated_at"];
  saved.columnOrder.notes = ["source_published_at", "title", "source_updated_at", "note_id", "open_material", "ignore_status"];
  const h = await harness(t, saved);
  requireColumnOrder(h);
  await setFieldVisible(h, "title", false);
  assert.equal(visualKeys(h).includes("title"), false);
  assert.deepEqual(stored(h).columnOrder.notes, saved.columnOrder.notes);
  const reloaded = await harness(t, stored(h));
  requireColumnOrder(reloaded);
  assert.equal(visualKeys(reloaded).includes("title"), false);
  assert.equal(reloaded.reorderColumn("note_id", "source_published_at"), true);
  assert.ok(reloaded.state.columnOrder.notes.includes("title"), "moving a visible field retains the hidden one");
  await setFieldVisible(reloaded, "title", true);
  assert.deepEqual(visualKeys(reloaded), ["note_id", "source_published_at", "title", "source_updated_at", "open_material", "ignore_status"]);
  assert.deepEqual(stored(reloaded).columnOrder, plain(reloaded.state.columnOrder));

  reloaded.schema.datasets.notes.fields = reloaded.schema.datasets.notes.fields.filter((item) => item.key !== "source_updated_at");
  reloaded.schema.datasets.notes.fields.unshift(field("new_schema_field", { displayOrder: -1 }));
  await reloaded.loadSchema(); // Explicit in-memory schema refresh, not a database request.
  await setFieldVisible(reloaded, "new_schema_field", true);
  assert.deepEqual(visualKeys(reloaded), ["note_id", "source_published_at", "title", "open_material", "ignore_status", "new_schema_field"]);
  assert.equal(visualKeys(reloaded).includes("source_updated_at"), false);
  assert.deepEqual(plain(reloaded.state.columnOrder.comments), saved.columnOrder.comments);
  assert.deepEqual(reloaded.queries, []);
});

test("column order: invalid/no-op drops and valid moves preserve query, selection, rows and backend traffic", async (t) => {
  const h = await harness(t, preferences());
  requireColumnOrder(h);
  h.state.selectedIds.add("n2");
  renderLoadedRows(h, [{ note_id: "n1", title: "one" }, { note_id: "n2", title: "two" }], { total: 500 });
  h.state.page = 3;
  h.state.querySerial = 7;
  h.elements.tableViewport.scrollTop = 137;
  h.elements.tableViewport.scrollLeft = 83;
  const before = localSnapshot(h), savedBefore = stored(h);
  const rows = [...h.elements.tableBody.children], headers = [...h.elements.tableHead.children];
  const payloadBefore = plain(h.queryPayload(3));
  for (const args of [
    ["title", "title"], ["missing", "title"], ["title", "missing"],
    ["source_updated_at", "title"], ["title", "source_updated_at"], // Known but hidden.
    ["#", "title"], ["title", "select-loaded"], [null, "title"], ["title", undefined],
    ["title", "note_id", "sideways"], ["title", "note_id", ""], ["title", "note_id", null],
    ["note_id", "open_material"], ["open_material", "note_id", "after"],
  ]) {
    assert.equal(h.reorderColumn(...args), false, JSON.stringify(args));
    h.flushAnimationFrames();
    assertLocalUnchanged(h, before);
    assert.deepEqual(stored(h), savedBefore, "no-op must not rewrite preferences");
    assert.deepEqual(plain(h.state.columnOrder), savedBefore.columnOrder);
    rows.forEach((row, index) => assert.equal(h.elements.tableBody.children[index], row));
    headers.forEach((cell, index) => assert.equal(h.elements.tableHead.children[index], cell));
  }
  assert.equal(h.reorderColumn("title", "note_id"), true);
  assert.deepEqual(visualKeys(h), ["title", "note_id", "open_material", "ignore_status"]);
  assert.equal(h.reorderColumn("title", "note_id", "after"), true);
  h.flushAnimationFrames();
  assertTableColumns(h, ["note_id", "title", "open_material", "ignore_status"]);
  assertLocalUnchanged(h, before);
  rows.forEach((row, index) => assert.equal(h.elements.tableBody.children[index], row));
  const payloadAfter = plain(h.queryPayload(3));
  assert.deepEqual({ ...payloadAfter, fields: [...payloadAfter.fields].sort() },
    { ...payloadBefore, fields: [...payloadBefore.fields].sort() }, "only projection order may change");
  assert.equal(rows[1].querySelector('[data-role="select-row"]').checked, true);
});

test("column order: export headers, values and requested projection follow visual data columns", { timeout: 3000 }, async (t) => {
  const h = await harness(t);
  requireColumnOrder(h);
  const all = prepareExport(h, rowsForExport(3));
  renderLoadedRows(h, all);
  const before = localSnapshot(h);
  assert.equal(h.reorderColumn("published_at", "comment_id"), true);
  assert.equal(h.reorderColumn("content", "note_id"), true);
  h.flushAnimationFrames();
  const expected = ["published_at", "comment_id", "content", "note_id", "post_locator", "thread_root_content"];
  assertTableColumns(h, expected);
  assertLocalUnchanged(h, before);
  const exported = ["published_at", "comment_id", "content", "note_id", "thread_root_content"];
  h.respondWith((request) => pageResult(request, all));
  await h.elements.exportCurrent.emit("click");
  assert.equal(h.queries.length, 1);
  assert.deepEqual(h.queries[0].fields, exported, "omit action/utility columns and date metadata");
  assert.equal(h.downloads.length, 1);
  assert.equal(h.blobs.length, 1);
  const csv = Buffer.from(await h.blobs[0].arrayBuffer()).toString("utf8");
  const lines = ['\ufeff"' + exported.join('","') + '"',
    ...all.map((record) => '"' + exported.map((key) => record[key]).join('","') + '"')];
  assert.equal(csv, lines.join("\r\n"), "each value remains beneath its reordered header; no file is written");
  assert.deepEqual(domFieldKeys(h.elements.tableHead), expected);
});

test("column order: resetColumnOrder resets only the active order without a query or view reset", async (t) => {
  const saved = orderedPreferences("comments");
  const h = await harness(t, saved);
  requireColumnOrder(h);
  h.state.selectedIds.add("c1");
  renderLoadedRows(h, rowsForExport(2));
  assertTableColumns(h, saved.columnOrder.comments);
  const before = localSnapshot(h), savedBefore = stored(h);
  const firstRow = h.elements.tableBody.children[0];
  const firstCells = [...firstRow.children];
  assert.ok(h.elements.restoreColumnOrder);
  await h.elements.restoreColumnOrder.emit("click");
  h.flushAnimationFrames();
  assert.deepEqual(plain(h.state.columnOrder), { notes: saved.columnOrder.notes, comments: [] });
  assertLocalUnchanged(h, before);
  assertTableColumns(h, ["comment_id", "note_id", "post_locator", "thread_root_content", "content", "published_at"]);
  assert.equal(h.elements.tableBody.children[0], firstRow);
  firstCells.forEach((cell) => assert.ok(firstRow.children.includes(cell), "reset moves existing cells"));
  assert.deepEqual(stored(h).savedViews, savedBefore.savedViews);
  assert.deepEqual(stored(h).visibleFields, savedBefore.visibleFields);
  assert.deepEqual(stored(h).columnOrder, plain(h.state.columnOrder));
  // The button above must perform a real reset; the global API is idempotent.
  h.resetColumnOrder();
  assertLocalUnchanged(h, before);
  const reloaded = await harness(t, stored(h));
  assert.deepEqual(plain(reloaded.state.columnOrder), { notes: saved.columnOrder.notes, comments: [] });
  assert.deepEqual(visualKeys(reloaded), ["comment_id", "note_id", "post_locator", "thread_root_content", "content", "published_at"]);
});

test("column order: resetCurrentView clears active order but retains the other dataset's saved view", async (t) => {
  const saved = orderedPreferences();
  const h = await harness(t, saved);
  requireColumnOrder(h);
  h.state.selectedIds.add("n1");
  await h.elements.resetView.emit("click");
  assert.deepEqual(plain(h.state.columnOrder), { notes: [], comments: saved.columnOrder.comments });
  assert.deepEqual(stored(h).columnOrder, plain(h.state.columnOrder));
  assert.deepEqual(activeView(h.state), { search: "", filterLogic: "and", filters: [], sorts: [], groupThreads: true });
  assert.deepEqual(visualKeys(h), ["note_id", "open_material", "ignore_status", "title", "source_published_at"]);
  assert.equal(h.state.selectedIds.size, 0);
  assert.equal(h.state.resetScheduled, true, "full reset, unlike column-only reset, schedules a query");
  assert.ok([...h.timers.values()].some((timer) => timer.delay === 0));
  assert.deepEqual(stored(h).savedViews.comments, { ...saved.savedViews.comments, semanticSearch: false });
  assert.deepEqual(stored(h).visibleFields.comments, saved.visibleFields.comments);
  const reloaded = await harness(t, stored(h));
  assert.equal(stored(reloaded).version, 4);
  assert.deepEqual(plain(reloaded.state.columnOrder), { notes: [], comments: saved.columnOrder.comments });
  await reloaded.buttons.comments.emit("click");
  assert.deepEqual(visualKeys(reloaded), saved.columnOrder.comments);
  assert.deepEqual(activeView(reloaded.state), saved.savedViews.comments);
});

test("column order: merged root cells stay aligned and an in-flight infinite append uses the latest order", { timeout: 3000 }, async (t) => {
  const saved = preferences("comments");
  saved.savedViews.comments.groupThreads = true;
  saved.savedViews.comments.sorts = [{ id: "thread-sort", field: "content", direction: "asc" }];
  const h = await harness(t, saved);
  requireColumnOrder(h);
  const all = rowsForExport(4).map((record, index) => ({ ...record,
    post_locator: "fixture-note", thread_root_id: index < 3 ? "root-a" : "root-b",
    thread_root_author: index < 3 ? "author A" : "author B",
    thread_root_content: index < 3 ? "thread A" : "thread B",
  }));
  h.state.selectedIds.add("c1");
  renderLoadedRows(h, all.slice(0, 2), { total: 4, pageSize: 2 });
  const canonical = ["comment_id", "note_id", "post_locator", "thread_root_content", "content", "published_at"];
  assertTableColumns(h, canonical);
  const root = h.elements.tableBody.children[0].querySelector('td[data-field="thread_root_content"]');
  assert.ok(root);
  assert.equal(root.rowSpan, 2);
  assert.equal(h.elements.tableBody.children[1].querySelector('td[data-field="thread_root_content"]'), null);
  const rows = h.elements.tableBody.children.map((row) => ({ row, cells: [...row.children] }));
  const headers = [...h.elements.tableHead.children];
  const assertRetained = () => {
    headers.forEach((cell) => assert.equal(cell.parentNode, h.elements.tableHead));
    assert.equal(h.elements.tableHead.children[0], headers[0]);
    assert.equal(h.elements.tableHead.children[1], headers[1]);
    rows.forEach(({ row, cells }, index) => {
      assert.equal(h.elements.tableBody.children[index], row);
      assert.equal(row.children.length, cells.length);
      cells.forEach((cell) => assert.ok(row.children.includes(cell), "move cells instead of rebuilding rows"));
      assert.equal(row.children[0], cells[0]);
      assert.equal(row.children[1], cells[1]);
    });
  };
  const before = localSnapshot(h);
  assert.equal(h.reorderColumn("thread_root_content", "comment_id"), true);
  assertTableColumns(h, ["thread_root_content", "comment_id", "note_id", "post_locator", "content", "published_at"]);
  assert.equal(h.reorderColumn("thread_root_content", "published_at", "after"), true);
  const atRequest = ["comment_id", "note_id", "post_locator", "content", "published_at", "thread_root_content"];
  assertTableColumns(h, atRequest);
  assertRetained();
  assertLocalUnchanged(h, before);

  let releaseNextPage;
  const nextPage = new Promise((resolve) => { releaseNextPage = resolve; });
  h.respondWith(() => nextPage);
  const appending = h.runQuery({ append: true }); // The production infinite-scroll query path.
  assert.equal(h.queries.length, 1);
  assert.equal(h.queries[0].page, 2);
  assert.equal(h.queries[0].pageSize, 2);
  assert.deepEqual(h.queries[0].fields.slice(0, atRequest.length), atRequest);
  assert.equal(h.state.loading, true);
  const inFlight = localSnapshot(h);
  assert.equal(h.reorderColumn("content", "note_id"), true);
  h.flushAnimationFrames();
  assertLocalUnchanged(h, inFlight);
  const latest = ["comment_id", "content", "note_id", "post_locator", "published_at", "thread_root_content"];
  assertTableColumns(h, latest);
  releaseNextPage(pageResult(h.queries[0], all));
  await appending;
  assert.equal(h.queries.length, 1, "no replacement query on drop or append completion");
  assert.deepEqual(plain(h.state.rows), all);
  assert.equal(h.state.page, 2);
  assert.equal(h.state.hasMore, false);
  assert.equal(h.state.loading, false);
  assert.equal(root.rowSpan, 3, "the next batch extends the original, still-connected root cell");
  assert.equal(root.parentNode, rows[0].row);
  assert.equal(h.elements.tableBody.children[2].querySelector('td[data-field="thread_root_content"]'), null);
  const secondRoot = h.elements.tableBody.children[3].querySelector('td[data-field="thread_root_content"]');
  assert.ok(secondRoot);
  assert.notEqual(secondRoot, root);
  assert.ok(secondRoot.textContent.includes("thread B"));
  assertTableColumns(h, latest);
  assertRetained();
  assert.equal(rows[1].row.querySelector('[data-role="select-row"]').checked, true);
  const afterAppend = localSnapshot(h);
  assert.equal(h.reorderColumn("thread_root_content", "comment_id"), true);
  assertTableColumns(h, ["thread_root_content", "comment_id", "content", "note_id", "post_locator", "published_at"]);
  assertLocalUnchanged(h, afterAppend);
  assertRetained();
  assert.equal(secondRoot.parentNode, h.elements.tableBody.children[3]);
  assert.equal(root.rowSpan, 3);
});

test("column gestures: initialized dragenter accepts a fast drop and moves merged cells without losing rows or selection", { timeout: 3000 }, async (t) => {
  const h = await gestureHarness(t);
  const viewport = h.elements.tableViewport;
  const before = localSnapshot(h), savedBefore = stored(h);
  const nodes = [h.elements.tableHead, ...h.elements.tableBody.children].map((row) => ({ row, cells: [...row.children] }));
  const root = h.elements.tableBody.children[0].querySelector('td[data-field="thread_root_content"]');
  assert.equal(root.rowSpan, 2);
  const grip = h.source.querySelector(".column-grip");
  assert.ok(grip);
  const start = dispatchFixtureEvent("dragstart", h.eventPath, { target: grip, dataTransfer: h.dataTransfer, ...h.startPoint });
  assert.equal(start.defaultPrevented, false);
  assert.equal(h.dataTransfer.effectAllowed, "move");
  assert.equal(h.dataTransfer.getData("application/x-xhs-column"), "thread_root_content");
  assert.equal(h.source.classList.contains("is-drag-source"), true);
  assert.equal(viewport.classList.contains("is-column-dragging"), true);

  // Deliberately emit no dragover and run no rAF between entering and dropping.
  // Both acceptance and pointer tracking must already happen on dragenter.
  const enter = dispatchFixtureEvent("dragenter", h.eventPath, { target: h.target, dataTransfer: h.dataTransfer, ...h.dropPoint });
  assert.equal(enter.defaultPrevented, true, "dragenter itself must accept the gesture");
  assert.equal(h.dataTransfer.dropEffect, "move");
  assert.equal(h.target.dataset.dropSide, "before", "window dragenter must track the new pointer before drop");
  assertLocalUnchanged(h, before);

  // A transient near-bottom scroll during the gesture must not fetch a page.
  const height = viewport.scrollHeight;
  viewport.scrollHeight = viewport.scrollTop + viewport.clientHeight + 10;
  dispatchFixtureEvent("scroll", [viewport]);
  viewport.scrollHeight = height;
  assertLocalUnchanged(h, before);
  let layoutMoves = 0;
  for (const { row } of nodes) {
    const insertBefore = row.insertBefore.bind(row);
    row.insertBefore = (cell, reference) => {
      const moved = insertBefore(cell, reference); // Keep the actual fixture node-move semantics.
      // Model a browser's transient scroll/layout shift during rowspan moves.
      viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight - 10;
      viewport.scrollLeft += 7;
      dispatchFixtureEvent("scroll", [viewport]);
      layoutMoves += 1;
      return moved;
    };
  }
  const drop = dispatchFixtureEvent("drop", h.eventPath, { target: h.target, dataTransfer: h.dataTransfer, ...h.dropPoint });
  assert.equal(drop.defaultPrevented, true);
  assert.ok(layoutMoves > 0, "exercise real insertBefore calls and explicit scroll restoration");
  assertDragFinished(h);
  assertLocalUnchanged(h, before); // Includes both scroll axes and transient-load guards.
  // The layout rAF rechecks stable geometry, not the transient near-bottom one.
  h.flushAnimationFrames();
  assertLocalUnchanged(h, before);
  const expected = ["thread_root_content", "comment_id", "note_id", "post_locator", "content", "published_at"];
  assert.deepEqual(visualKeys(h), expected);
  assertTableColumns(h, expected);
  assert.deepEqual(stored(h).columnOrder, plain(h.state.columnOrder));
  assert.deepEqual(stored(h).visibleFields, savedBefore.visibleFields);
  assert.deepEqual(stored(h).savedViews, savedBefore.savedViews);
  assert.deepEqual(stored(h).columnOrder.notes, savedBefore.columnOrder.notes);
  nodes.forEach(({ row, cells }, index) => {
    assert.equal(index === 0 ? h.elements.tableHead : h.elements.tableBody.children[index - 1], row);
    assert.equal(row.children.length, cells.length);
    cells.forEach((cell) => assert.equal(cell.parentNode, row));
    assert.equal(row.children[0], cells[0]);
    assert.equal(row.children[1], cells[1]);
  });
  assert.equal(root.rowSpan, 2);
  assert.equal(h.elements.tableBody.children[1].querySelector('[data-role="select-row"]').checked, true);
});

test("column gestures: Escape, drag cancellation and outside drop discard the pending target without mutation", { timeout: 3000 }, async (t) => {
  for (const ending of ["escape", "dragend", "outside"]) {
    const h = await gestureHarness(t);
    const before = localSnapshot(h), savedBefore = stored(h), orderBefore = visualKeys(h);
    const nodes = [h.elements.tableHead, ...h.elements.tableBody.children].map((row) => ({ row, cells: [...row.children] }));
    dispatchFixtureEvent("dragstart", h.eventPath, { target: h.source, dataTransfer: h.dataTransfer, ...h.startPoint });
    const enter = dispatchFixtureEvent("dragenter", h.eventPath, { target: h.target, dataTransfer: h.dataTransfer, ...h.dropPoint });
    assert.equal(enter.defaultPrevented, true, ending);
    assert.equal(h.target.dataset.dropSide, "before", ending + ": establish a pending valid target first");
    if (ending === "escape") {
      dispatchFixtureEvent("keydown", [h.window], { key: "Escape" });
    } else if (ending === "dragend") {
      h.dataTransfer.dropEffect = "none";
      dispatchFixtureEvent("dragend", [h.window], { target: h.source, dataTransfer: h.dataTransfer });
    } else {
      const bounds = h.elements.tableViewport.getBoundingClientRect();
      const searchBefore = h.elements.globalSearch.value;
      const outside = { target: h.elements.globalSearch, dataTransfer: h.dataTransfer, clientX: bounds.right + 20, clientY: bounds.top + 20 };
      const leave = dispatchFixtureEvent("dragenter", [h.window], outside);
      assert.equal(leave.defaultPrevented, false, "outside targets are not accepted by the viewport");
      assert.equal(h.target.dataset.dropSide, undefined, "outside dragenter clears the stale inside target");
      const outsideDrop = dispatchFixtureEvent("drop", [h.window], outside);
      assert.equal(outsideDrop.defaultPrevented, true, "an active column drop over globalSearch must block native text insertion");
      assert.equal(h.elements.globalSearch.value, searchBefore);
    }
    assertDragFinished(h);
    h.flushAnimationFrames();
    assertLocalUnchanged(h, before);
    assert.deepEqual(plain(h.state.columnOrder), savedBefore.columnOrder, ending);
    assert.deepEqual(stored(h), savedBefore, ending);
    assert.deepEqual(visualKeys(h), orderBefore, ending);
    assertTableColumns(h, orderBefore);
    nodes.forEach(({ row, cells }, index) => {
      assert.equal(index === 0 ? h.elements.tableHead : h.elements.tableBody.children[index - 1], row);
      assert.equal(row.children.length, cells.length);
      cells.forEach((cell, position) => assert.equal(row.children[position], cell, ending));
    });
    // A late drop after cancellation/outside drop must not revive the old drag.
    const lateDrop = dispatchFixtureEvent("drop", h.eventPath, { target: h.target, dataTransfer: h.dataTransfer, ...h.dropPoint });
    assert.equal(lateDrop.defaultPrevented, false, ending);
    h.flushAnimationFrames();
    assertLocalUnchanged(h, before);
    assert.deepEqual(stored(h), savedBefore, ending);
    assert.deepEqual(visualKeys(h), orderBefore, ending);
  }
});

test("comment actions: rightmost independent cell for every grouped reply, never inside prose", async (t) => {
  const h = await harness(t, preferences("comments"));
  h.state.groupThreads = true;
  const rows = rowsForExport(3).map(row => ({ ...row, thread_root_id: "shared-root" }));
  renderLoadedRows(h, rows);
  assertTableColumns(h, visualKeys(h));
  for (const [i, row] of h.elements.tableBody.children.entries()) {
    const action = row.children.at(-1);
    assert.equal(action.dataset.utility, "comment-actions");
    assert.equal(Number(action.rowSpan || 1), 1);
    assert.equal(action.querySelector("button").dataset.value, rows[i].comment_id);
    assert.equal(action.querySelector("button").dataset.action, "locate_comment");
    assert.equal(row.querySelector('[data-field="content"]').querySelector("button"), null);
    assert.equal(row.querySelector('[data-field="content"]').textContent, rows[i].content);
  }
});

test("comment actions: hiding prose or reordering data cannot remove or move the action slot", async (t) => {
  const h = await harness(t, orderedPreferences("comments"));
  renderLoadedRows(h, rowsForExport(2));
  await setFieldVisible(h, "content", false);
  renderLoadedRows(h, rowsForExport(2));
  assertTableColumns(h, visualKeys(h));
  assert.equal(h.elements.tableBody.querySelector('[data-field="content"]'), null);
  assert.equal(h.reorderColumn("__overview_comment_actions", "comment_id"), false);
  assert.equal(h.reorderColumn("comment_id", "__overview_comment_actions"), false);
  assert.equal(h.reorderColumn("published_at", "comment_id"), true);
  assertTableColumns(h, visualKeys(h));
  assert.equal(h.elements.tableHead.children.at(-1).draggable, false);
  assert.equal(h.elements.tableHead.children.at(-1).querySelector(".column-grip"), null);
});

test("comment actions: sizing includes the trailing slot while query/export projections exclude it", async (t) => {
  const h = await harness(t, preferences("comments"));
  renderLoadedRows(h, rowsForExport(2));
  const layout = plain(h.tableLayoutFields());
  assert.deepEqual(layout.map(f => f.key), [...visualKeys(h), "__overview_comment_actions"]);
  assert.equal(layout.at(-1).action, "locate_comment");
  assert.equal(h.queryPayload().fields.includes("__overview_comment_actions"), false);
  assert.equal(h.queryPayload().sort.some(x => x.field === "__overview_comment_actions"), false);
  h.respondWith(request => pageResult(request, rowsForExport(2)));
  await h.exportCurrentPage();
  assert.equal(h.blobs.length, 1);
  assert.doesNotMatch(await h.blobs[0].text(), /__overview_comment_actions|定位原评论/);
  assert.ok(h.queries.every(p => !p.fields.includes("__overview_comment_actions")));
});

test("comment actions: missing ID is disabled; notes have no comment action column", async (t) => {
  const h = await harness(t, preferences("comments"));
  renderLoadedRows(h, [{ ...rowsForExport(1)[0], comment_id: "" }]);
  assert.equal(h.elements.tableBody.children[0].children.at(-1).querySelector("button").disabled, true);
  h.state.dataset = "notes";
  renderLoadedRows(h, [{ note_id: "n1", title: "synthetic" }]);
  assert.equal(h.elements.tableHead.querySelector(".comment-actions-column"), null);
  assert.equal(h.tableLayoutFields().some(f => f.key === "__overview_comment_actions"), false);
});

test("comment actions: action header cannot open filters or enter keyboard reordering", async (t) => {
  const h = await harness(t, preferences("comments"));
  renderLoadedRows(h, rowsForExport(1));
  const header = h.elements.tableHead.children.at(-1);
  const order = plain(h.state.columnOrder);
  await h.elements.tableHead.emit("click", { target: header });
  await h.elements.tableHead.emit("keydown", { target: header, key: "ArrowLeft", altKey: true });
  await h.elements.tableHead.emit("keydown", { target: header, key: "Enter" });
  assert.equal(h.elements.columnFilterPopover.hidden, true);
  assert.deepEqual(plain(h.state.columnOrder), order);
});


test("chronological defaults: empty rules send publication DESC for both datasets including reset", async (t) => {
  for (const dataset of ["notes", "comments"]) {
    const saved = preferences(dataset);
    saved.savedViews[dataset].sorts = [];
    saved.savedViews[dataset].groupThreads = true;
    const h = await harness(t, saved);
    const field = dataset === "notes" ? "source_published_at" : "published_at";
    assert.deepEqual(plain(h.queryPayload().sort), [{ field, direction: "desc" }]);
    assert.equal(h.queryPayload().groupThreads, dataset === "comments");
    assert.equal(h.elements.groupThreads.disabled, false);
    await h.elements.resetView.emit("click");
    assert.deepEqual(plain(h.queryPayload().sort), [{ field, direction: "desc" }]);
    await h.elements.addSort.emit("click");
    assert.equal(h.state.sorts[0].field, field);
  }
});

test("thread time modes remain independent of semantic relevance and saved sort rules", async (t) => {
  const h = await harness(t, preferences("comments"));
  h.state.groupThreads = true;
  assert.equal(h.queryPayload().threadSortMode,"root");
  h.elements.threadSortMode.value="comment";
  await h.elements.threadSortMode.emit("change");
  assert.equal(h.queryPayload().threadSortMode,"comment");
  assert.equal(h.queryPayload().sort[0].field,"published_at");
  assert.equal(h.queryPayload().groupThreads,true);
  assert.equal(stored(h).threadSortModes.comments,"comment");
  h.state.semanticSearch=true;
  assert.deepEqual(plain(h.queryPayload().sort),[]);
  assert.equal(h.queryPayload().groupThreads,false);
  h.state.semanticSearch=false;
  assert.equal(h.queryPayload().threadSortMode,"comment");
  const again=await harness(t,stored(h));
  assert.equal(again.queryPayload().threadSortMode,"comment");
});

test("sorting uses latest direction for duplicates and at most four distinct fields", async (t) => {
  const saved=preferences("comments");
  saved.savedViews.comments.sorts=[{id:"old",field:"published_at",direction:"asc"},{id:"new",field:"published_at",direction:"desc"}];
  const h=await harness(t,saved);
  assert.deepEqual(plain(h.queryPayload().sort),[{field:"published_at",direction:"desc"}]);
  h.state.sorts=["content","comment_id","note_id","published_at"].map((field,i)=>({id:String(i),field,direction:"asc"}));
  await h.elements.addSort.emit("click");
  assert.equal(h.queryPayload().sort.length,4);
});

test("multi-filter in values preserve zero and split Chinese commas without using number input", async(t)=>{
  const h=await harness(t,preferences("comments"));
  const input=h.makeValueInput({dataType:"number"},"0，2","value","in");
  assert.equal(input.type,"text");
  h.state.filters=[{id:"n",field:"content",operator:"in",value:"上海，北京",value2:""}];
  assert.deepEqual(plain(h.queryPayload().filter.children[0].value),["上海","北京"]);
  h.state.filters[0].value=["a,b","0"];
  assert.deepEqual(plain(h.queryPayload().filter.children[0].value),["a,b","0"]);
});

test("incomplete multi-filter ranges pause requests and visibly retain previous results", async(t)=>{
  const h=await harness(t,preferences("comments"));
  h.state.filters=[{id:"d",field:"published_at",operator:"between",value:"2026-09-01",value2:""}];
  const before=h.queries.length;
  h.scheduleQuery(0);
  assert.equal(h.state.resetScheduled,true);
  assert.equal(h.elements.filterDraftNotice.hidden,false);
  assert.match(h.elements.filterDraftNotice.textContent,/上次结果/);
  assert.equal(h.queries.length,before);
  h.state.filters[0].value2="2026-08-01";
  assert.match(h.filterDraftProblem(),/晚于/);
  h.state.filters[0].value2="2026-09-01";
  h.state.filters[0].value="2026-09-01 12:00:00";
  assert.equal(h.filterDraftProblem(),"");
  h.scheduleQuery(0);
  assert.equal(h.elements.filterDraftNotice.hidden,true);
  assert.ok([...h.timers.values()].some(timer=>timer.delay===0));
});


test("date draft validation follows Beijing calendar, zones, fractions and text operators",async(t)=>{
  const h=await harness(t,preferences("comments"));
  const rule={id:"date",field:"published_at",operator:"eq",value:"2026-09-01T12:00:00.123Z",value2:""};
  h.state.filters=[rule];
  assert.equal(h.filterDraftProblem(),"");
  rule.operator="contains";rule.value="2026-09";
  assert.equal(h.filterDraftProblem(),"");
  rule.operator="between";rule.value="2026-09-01T20:00:00Z";rule.value2="2026-09-01";
  assert.match(h.filterDraftProblem(),/晚于/);
  rule.value="2026-09-01T15:59:59.999Z";
  assert.equal(h.filterDraftProblem(),"");
  rule.value="2026/9/1 12:00:00";
  assert.equal(h.filterDraftProblem(),"");
  rule.value="2026-02-30";
  assert.match(h.filterDraftProblem(),/有效/);
});
