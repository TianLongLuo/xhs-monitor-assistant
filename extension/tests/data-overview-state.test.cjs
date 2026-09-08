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
  get isConnected() { return this.tagName === "BODY" || !!this.parentNode?.isConnected; }
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
    if (name === "type") return this.type;
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
  dispatchEvent(event) {
    const path = [this];
    if (event.bubbles) for (let node = this.parentNode; node; node = node.parentNode) path.push(node);
    return !dispatchFixtureEvent(event.type, path, { ...event, target: this }).defaultPrevented;
  }
  focus(options) { (this.focusCalls ||= []).push(options); }
  scrollIntoView(options) { (this.scrollIntoViewCalls ||= []).push(options); }
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
      { id: "in", label: "one of", types: ["text", "datetime", "boolean", "number"] },
      { id: "between", label: "between", types: ["datetime"] },
      { id: "is_false", label: "false", types: ["boolean"] },
    ],
    datasets: Object.fromEntries(Object.entries({ notes, comments }).map(([dataset, fields]) => [dataset, {
      total: 0, fields: fields.map((item, displayOrder) => ({ ...item, displayOrder })),
    }])),
  };
}

async function harness(t, saved, { valueOptions = [], extraFields = {} } = {}) {
  const storage = new Map(saved ? [[STORAGE_KEY, JSON.stringify(saved)]] : []);
  const ids = new Map();
  const body = new Element("body");
  const downloads = [], blobs = [], revoked = [], queries = [], messages = [], unexpected = [];
  const timers = new Map();
  const animationFrames = new Map();
  let nextFrame = 0, frameTime = 0;
  const requestAnimationFrame = (callback) => { animationFrames.set(++nextFrame, callback); return nextFrame; };
  const cancelAnimationFrame = (id) => animationFrames.delete(id);
  let nextTimer = 0, nextId = 0, queryHandler, exportHandler;
  const schema = fixtureSchema();
  for (const [dataset, additions] of Object.entries(extraFields)) {
    const fields = schema.datasets[dataset].fields;
    for (const item of additions) fields.push({ ...item, displayOrder: fields.length });
  }
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
        if (id === "exportFormat") element.value = "csv";
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
    atob: value => Buffer.from(value, "base64").toString("binary"),
    document, window: Object.assign(new Element("window"), { requestAnimationFrame, cancelAnimationFrame }), Blob,
    requestAnimationFrame, cancelAnimationFrame,
    Event: class { constructor(type, options = {}) { this.type = type; this.bubbles = !!options.bubbles; } },
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
      if (message.type === "getDataOverviewValues") return callback({ ok: true, values: plain(valueOptions), truncated: false, snapshotToken: SNAPSHOT });
      if (message.type === "exportDataOverview" && exportHandler) {
        Promise.resolve().then(() => exportHandler(plain(message.payload))).then(callback, error => callback({ok:false,error:error.message}));
        return;
      }
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
    state, elements, queryPayload, renderCell, exportCurrentPage, applyColumnPins, syncColumnPins, renderColumnPinOptions, rowVisualState,
    currentVisibleFields, tableLayoutFields, orderedDatasetFields, renderTable, renderFieldOptions, renderFilters, renderSorts,
    loadSchema, runQuery, resetCurrentView, filterDraftProblem, validateFilterDraft, makeValueInput, scheduleQuery,
    writeFilterInput, readFilterInput, attachMultiValueOptions, splitFilterValues, openColumnFilter,
    locatePostInDatabase, returnToCommentPosition, runTableAction,
    getCommentReturnPoint: () => commentReturnPoint,
    reorderColumn: typeof reorderColumn === "function" ? reorderColumn : undefined,
    resetColumnOrder: typeof resetColumnOrder === "function" ? resetColumnOrder : undefined,
  })`, context);
  await Promise.resolve(); // Finish the one schema-bootstrap continuation; it cannot issue a query.
  assert.equal(api.state.schema, schema, "bootstrap/rendering must finish without a swallowed stub error");
  assert.equal(api.elements.refreshSchema.disabled, false);
  return {
    ...api, schema, document, window: context.window, buttons, storage, downloads, blobs, revoked, queries, messages, timers,
    respondWith(handler) { queryHandler = handler; },
    respondExportWith(handler) { exportHandler = handler; },
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
function assertTableColumns(h, keys, { includesActions = false } = {}) {
  const token = (cell) => cell.classList.contains("select-column") ? "$select"
    : cell.classList.contains("row-number-column") ? "$number" : cell.dataset.field;
  const expected = ["$select", "$number", ...keys, ...(h.state.dataset === "comments" && !includesActions ? ["__overview_comment_actions"] : [])];
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
    const expected = [...required, ...observed, ...["is_deleted", "post_status", "comment_status", "analysis_is_negative", "post__is_deleted", "post__post_status"].filter(key => h.schema.datasets[dataset].fields.some(f => f.key === key)),
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

test("column order: legacy preferences migrate to v5 and a reorder survives a fresh VM reload", async (t) => {
  const h = await harness(t, preferences());
  requireColumnOrder(h);
  assert.deepEqual(plain(h.state.columnOrder), { notes: [], comments: [] });
  assert.equal(stored(h).version, 5);
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
  assert.equal(stored(reloaded).version, 5);

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
  assert.equal(stored(reloaded).version, 5);
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


test("column pins: defaults empty, checkbox is local-only and persistent, clear restores all", async t => {
  const h = await harness(t, orderedPreferences("comments"));
  renderLoadedRows(h, [{comment_id:"reply-1",note_id:"note-1",content:"preview",thread_root_id:"reply-1",thread_root_content:"root"}]);
  assert.deepEqual(plain(h.state.pinnedColumns), {notes:[],comments:[]});
  for (const row of [h.elements.tableHead, ...h.elements.tableBody.children])
    assert.ok(row.children.every(c => c.dataset.pinned !== "true"));
  const before = localSnapshot(h);
  const input = h.elements.columnPinOptions.querySelector('input[data-pin-field="content"]');
  assert.ok(input); input.checked = true;
  await h.elements.columnPinOptions.emit("change", {target:input});
  assertLocalUnchanged(h, before);
  assert.deepEqual(JSON.parse(h.storage.get(STORAGE_KEY)).pinnedColumns.comments, ["content"]);
  assert.equal(h.elements.tableHead.querySelector('[data-field="content"]').dataset.pinned, "true");
  assert.equal(h.elements.tableBody.children[0].querySelector('[data-field="content"]').style.left, "0px");
  assert.notEqual(h.elements.tableHead.querySelector('[data-field="__overview_comment_actions"]').dataset.pinned, "true");
  await h.elements.clearColumnPins.click();
  assert.deepEqual(plain(h.state.pinnedColumns.comments), []);
  assert.equal(h.elements.tableBody.children[0].querySelector('[data-field="content"]').style.left, "");
});

test("column pins: offsets follow actual selected widths and ignore non-pinned columns", async t => {
  const prefs = orderedPreferences("comments");
  prefs.pinnedColumns = {notes:["title"],comments:["__selection", "content", "comment_id"]};
  const h = await harness(t, prefs);
  renderLoadedRows(h, [{comment_id:"reply-1",note_id:"note-1",content:"text",thread_root_content:"root"}]);
  const head=h.elements.tableHead;
  head.children[0].getBoundingClientRect=()=>({width:42});
  head.querySelector('[data-field="content"]').getBoundingClientRect=()=>({width:350});
  h.applyColumnPins();
  assert.equal(head.querySelector('[data-field="content"]').style.left,"42px");
  assert.equal(head.querySelector('[data-field="comment_id"]').style.left,"392px");
  head.querySelector('[data-field="content"]').getBoundingClientRect=()=>({width:600});
  h.applyColumnPins();
  assert.equal(head.querySelector('[data-field="comment_id"]').style.left,"642px");
  assert.deepEqual(plain(h.state.pinnedColumns.notes),["title"]);
  h.state.pinnedColumns.comments = ["missing-column"];
  h.applyColumnPins();
  assert.ok(head.children.every(c=>c.dataset.pinned!=="true"));
});


async function setColumnPinned(h, key, checked) {
  const input = h.elements.columnPinOptions.querySelector('input[data-pin-field="' + key + '"]');
  assert.ok(input, "real pin checkbox exists: " + key);
  input.checked = checked;
  // Dispatch synchronously: callers can assert the new slots before any rAF/query.
  const changed = h.elements.columnPinOptions.emit("change", { target: input });
  return changed;
}

function assertPinnedSlots(h, keys) {
  assert.deepEqual(plain(h.tableLayoutFields()).map(field => field.key), keys);
  assertTableColumns(h, keys, { includesActions: true });
}

function retainedColumnNodes(h) {
  const rows = [h.elements.tableHead, ...h.elements.tableBody.children].map(row => ({ row, cells: [...row.children] }));
  return () => rows.forEach(({ row, cells }, index) => {
    assert.equal(index ? h.elements.tableBody.children[index - 1] : h.elements.tableHead, row);
    assert.equal(row.children.length, cells.length);
    cells.forEach(cell => assert.equal(cell.parentNode, row, "pinning moves existing nodes"));
    assert.equal(row.children[0], cells[0], "selection stays in utility slot 0");
    assert.equal(row.children[1], cells[1], "row number stays in utility slot 1");
  });
}

test("column pins regression: trailing comment action moves immediately to first data slot and unpin restores saved order", async t => {
  const h = await harness(t, orderedPreferences("comments"));
  h.state.selectedIds.add("c1");
  renderLoadedRows(h, rowsForExport(2));
  Object.assign(h.elements.tableViewport, { scrollTop: 137, scrollLeft: 415 });
  const action = "__overview_comment_actions", keys = visualKeys(h);
  const before = localSnapshot(h), savedBefore = stored(h), payload = plain(h.queryPayload());
  const retained = retainedColumnNodes(h);
  const actionCells = [h.elements.tableHead, ...h.elements.tableBody.children].map(row => row.children.at(-1));
  const change = setColumnPinned(h, action, true);
  assertPinnedSlots(h, [action, ...keys]); // No await, rerender or animation-frame flush.
  [h.elements.tableHead, ...h.elements.tableBody.children].forEach((row, index) => {
    assert.equal(row.children[2], actionCells[index]);
    assert.equal(actionCells[index].dataset.pinned, "true");
    assert.equal(actionCells[index].style.left, "0px");
    assert.equal(Number(actionCells[index].rowSpan || 1), 1);
  });
  await change;
  h.syncColumnPins(); h.flushAnimationFrames();
  assertLocalUnchanged(h, before); retained();
  assert.deepEqual(visualKeys(h), keys);
  assert.deepEqual(plain(h.queryPayload()), payload);
  assert.deepEqual(stored(h), { ...savedBefore, pinnedColumns: { ...savedBefore.pinnedColumns, comments: [action] } });
  assert.equal(h.elements.tableBody.children[1].querySelector('[data-role="select-row"]').checked, true);
  const unpin = setColumnPinned(h, action, false);
  assertTableColumns(h, keys);
  [h.elements.tableHead, ...h.elements.tableBody.children].forEach((row, index) => {
    assert.equal(row.children.at(-1), actionCells[index]);
    assert.equal(actionCells[index].style.left, "");
    assert.notEqual(actionCells[index].dataset.pinned, "true");
  });
  await unpin; h.flushAnimationFrames();
  assertLocalUnchanged(h, before); retained();
  assert.deepEqual(stored(h), savedBefore);
});

test("column pins regression: multiple pins preserve logical rowspan slots across an in-flight append", { timeout: 3000 }, async t => {
  const saved = orderedPreferences("comments");
  saved.savedViews.comments.groupThreads = true;
  const h = await harness(t, saved);
  const action = "__overview_comment_actions", keys = visualKeys(h);
  const all = rowsForExport(4).map((row, index) => ({ ...row, thread_root_id: index < 3 ? "root-a" : "root-b" }));
  h.state.selectedIds.add("c1");
  renderLoadedRows(h, all.slice(0, 2), { total: 4, pageSize: 2 });
  const retained = retainedColumnNodes(h), savedOrder = stored(h).columnOrder;
  const root = h.elements.tableBody.children[0].querySelector('[data-field="thread_root_content"]');
  assert.equal(root.rowSpan, 2);
  let release;
  h.respondWith(() => new Promise(resolve => { release = resolve; }));
  const appending = h.runQuery({ append: true });
  await Promise.resolve();
  const before = localSnapshot(h), payload = plain(h.queryPayload());
  // Toggle in reverse order: pin click chronology must not replace saved field order.
  for (const key of [action, "thread_root_content", "content", "__row_number", "__selection"]) await setColumnPinned(h, key, true);
  const expected = ["content", "thread_root_content", action, ...keys.filter(key => !["content", "thread_root_content"].includes(key))];
  assertPinnedSlots(h, expected);
  assertLocalUnchanged(h, before); retained();
  assert.deepEqual(plain(h.queryPayload()), payload);
  assert.deepEqual(stored(h).columnOrder, savedOrder);
  const head = h.elements.tableHead;
  head.children.forEach((cell, index) => { cell.getBoundingClientRect = () => ({ width: [42, 42, 350, 200, 96][index] || 160 }); });
  h.syncColumnPins();
  assert.equal(head.children[2].style.left, "84px");
  assert.equal(root.style.left, "434px");
  assert.equal(head.querySelector('[data-field="' + action + '"]').style.left, "634px");
  release(pageResult(h.queries[0], all));
  await appending; h.flushAnimationFrames();
  assert.equal(h.queries.length, 1, "pin changes never replace the pending query");
  assert.deepEqual(h.queries[0].fields, payload.fields);
  assert.equal(root.rowSpan, 3);
  assertPinnedSlots(h, expected); retained();
  assert.equal(h.elements.tableBody.children[2].querySelector('[data-field="thread_root_content"]'), null);
  assert.equal(h.elements.tableBody.children[1].querySelector('[data-role="select-row"]').checked, true);
  assert.deepEqual([...h.state.selectedIds], ["c1"]);
  const afterAppend = localSnapshot(h);
  await setColumnPinned(h, "thread_root_content", false);
  assertPinnedSlots(h, ["content", action, ...keys.filter(key => key !== "content")]);
  await h.elements.clearColumnPins.click();
  assertTableColumns(h, keys); retained();
  assert.equal(root.rowSpan, 3);
  assertLocalUnchanged(h, afterAppend);
  assert.deepEqual(stored(h).columnOrder, savedOrder);
});

test("column pins regression: real drag keeps action pinned and unpin reveals the new explicit saved order", async t => {
  const h = await gestureHarness(t), action = "__overview_comment_actions";
  const retained = retainedColumnNodes(h), originalOrder = stored(h).columnOrder;
  await setColumnPinned(h, action, true);
  await setColumnPinned(h, "content", true);
  assert.deepEqual(stored(h).columnOrder, originalOrder);
  const before = localSnapshot(h);
  const point = (header, fraction) => {
    const rect = header.getBoundingClientRect();
    return { clientX: rect.left + rect.width * fraction, clientY: rect.top + rect.height / 2 };
  };
  dispatchFixtureEvent("dragstart", h.eventPath, { target: h.source.querySelector(".column-grip"), dataTransfer: h.dataTransfer, ...point(h.source, 0.5) });
  const enter = dispatchFixtureEvent("dragenter", h.eventPath, { target: h.target, dataTransfer: h.dataTransfer, ...point(h.target, 0.25) });
  assert.equal(enter.defaultPrevented, true);
  const drop = dispatchFixtureEvent("drop", h.eventPath, { target: h.target, dataTransfer: h.dataTransfer, ...point(h.target, 0.25) });
  assert.equal(drop.defaultPrevented, true);
  h.flushAnimationFrames(); assertDragFinished(h);
  const keys = ["thread_root_content", "comment_id", "note_id", "post_locator", "content", "published_at"];
  assert.deepEqual(visualKeys(h), keys);
  assertPinnedSlots(h, ["content", action, ...keys.filter(key => key !== "content")]);
  assertLocalUnchanged(h, before); retained();
  const savedKeys = h.schema.datasets.comments.fields.map(field => field.key).filter(key => key !== "thread_root_content");
  savedKeys.unshift("thread_root_content");
  assert.deepEqual(stored(h).columnOrder.comments, savedKeys);
  assert.deepEqual(stored(h).columnOrder.notes, originalOrder.notes);
  const draggedOrder = stored(h).columnOrder;
  await h.elements.clearColumnPins.click();
  assertTableColumns(h, keys); retained(); assertLocalUnchanged(h, before);
  assert.deepEqual(stored(h).columnOrder, draggedOrder, "only explicit drag, never pin/unpin, changes saved order");
});

test("column pins regression: pinned layout never changes export field order or includes action fields", async t => {
  const h = await harness(t, orderedPreferences("comments"));
  const rows = rowsForExport(2);
  renderLoadedRows(h, rows);
  h.respondWith(request => pageResult(request, rows));
  await h.exportCurrentPage();
  const exportBefore = await h.blobs[0].text(), payloadBefore = plain(h.queries[0]);
  const savedOrder = stored(h).columnOrder, keys = visualKeys(h);
  await setColumnPinned(h, "__overview_comment_actions", true);
  await setColumnPinned(h, "published_at", true);
  assertPinnedSlots(h, ["published_at", "__overview_comment_actions", ...keys.filter(key => key !== "published_at")]);
  await h.exportCurrentPage();
  assert.equal(h.queries.length, 2);
  assert.deepEqual(h.queries[1], payloadBefore);
  assert.equal(await h.blobs[1].text(), exportBefore);
  assert.doesNotMatch(exportBefore, /__overview_comment_actions/);
  assert.deepEqual(visualKeys(h), keys);
  assert.deepEqual(stored(h).columnOrder, savedOrder);
});

test("row colors use published conclusion and explicit deletion, independently", async t => {
  const h = await harness(t, orderedPreferences("comments"));
  const check=(row,expected,dataset="comments")=>assert.deepEqual(plain(h.rowVisualState(row,dataset)),expected);
  check({analysis_is_negative:"是"},{negative:true,deleted:false});
  check({analysis_is_negative:"否",is_deleted:"0",access_status:"check_failed",is_negative:1,risk_level:"high"},{negative:false,deleted:false});
  check({is_deleted:1,analysis_is_negative:"是"},{negative:true,deleted:true});
  check({comment_status:"已删除"},{negative:false,deleted:true});
  check({post__post_status:"已删除"},{negative:false,deleted:true});
  check({post_status:"已删除"},{negative:false,deleted:true},"notes");
  renderLoadedRows(h, [{comment_id:"one",note_id:"note",content:"text",analysis_is_negative:"是",is_deleted:1}]);
  assert.equal(h.elements.tableBody.children[0].dataset.rowNegative,"true");
  assert.equal(h.elements.tableBody.children[0].dataset.rowDeleted,"true");
});

test("row colors query hidden status fields without changing visible or export columns", async t=>{
  const h=await harness(t, orderedPreferences("comments"));
  h.schema.datasets.comments.fields.push(field("is_deleted",{dataType:"boolean"}),field("analysis_is_negative"),field("post__is_deleted",{dataType:"boolean"}));
  const before=plain(h.currentVisibleFields());
  const payload=h.queryPayload();
  for(const key of ["is_deleted","analysis_is_negative","post__is_deleted"])assert.ok(payload.fields.includes(key));
  assert.deepEqual(plain(h.currentVisibleFields()),before);
});

test("Excel export sends frozen full-result query and downloads xlsx, not loaded subset", async t=>{
  const h=await harness(t,orderedPreferences("comments"));
  renderLoadedRows(h,rowsForExport(3),{total:401});
  h.elements.exportFormat.value="xlsx";
  h.state.search="specific";h.state.filters=[{id:"f",field:"content",operator:"contains",value:"x"}];
  let received;
  h.respondExportWith(p=>{received=p;return {ok:true,dataset:p.dataset,total:401,snapshotToken:p.snapshotToken,consistentSnapshot:true,contentBase64:Buffer.from([80,75,3,4,1,2,3]).toString("base64")};});
  await h.exportCurrentPage();
  assert.equal(received.expectedTotal,401);assert.equal(received.search,"specific");assert.equal(received.filter.children[0].value,"x");
  assert.equal(h.queries.length,0);assert.equal(h.downloads.length,1);assert.match(h.downloads[0].filename,/filtered-401\.xlsx$/);
  assert.equal(h.blobs[0].type,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
});

test("Excel export rejects changed totals, changed snapshot and invalid workbook without downloads", async t=>{
  for(const bad of [{total:1},{snapshotToken:"changed"},{contentBase64:"YmFk"}]){
    const h=await harness(t,orderedPreferences("comments"));renderLoadedRows(h,rowsForExport(2));h.elements.exportFormat.value="xlsx";
    h.respondExportWith(p=>({ok:true,total:2,dataset:p.dataset,snapshotToken:p.snapshotToken,consistentSnapshot:true,contentBase64:"UEsDBA==",...bad}));
    await h.exportCurrentPage();assert.equal(h.downloads.length,0);assert.equal(h.state.exporting,false);
  }
});

const MULTI_VALUES = ["Alpha, West", "上海，北京", "第一行\n第二行", "0"];
function multiValuePreferences(values = MULTI_VALUES, operator = "in") {
  const saved = preferences("comments");
  saved.savedViews.comments.filters = [{ id: "multi", field: "content", operator, value: values, value2: "" }];
  return saved;
}
const settleValueOptions = () => new Promise(resolve => setImmediate(resolve));
const filterValueControl = h => h.elements.filterRows.querySelector('input[data-role="value"]');
const valueEntries = values => values.map((value, i) => ({ value, label: value, count: i + 1 }));

test("multi-value input: make/write/read preserve complete comma and newline values without aliasing", async t => {
  const h = await harness(t);
  for (const dataType of ["text", "number", "datetime", "boolean"]) {
    const original = [...MULTI_VALUES];
    const input = h.makeValueInput(field("value", { dataType }), original, "value", "in");
    assert.equal(input.type, "text", dataType);
    assert.deepEqual(JSON.parse(input.value), MULTI_VALUES, "ambiguous separators require JSON representation");
    original.push("caller mutation");
    const read = h.readFilterInput(input);
    assert.deepEqual(plain(read), MULTI_VALUES);
    read.push("reader mutation");
    assert.deepEqual(plain(h.readFilterInput(input)), MULTI_VALUES, "reads return independent arrays");
    h.writeFilterInput(input, ["上海", "北京", 0]);
    assert.equal(input.value, "上海, 北京, 0");
    assert.deepEqual(plain(h.readFilterInput(input)), ["上海", "北京", "0"]);
    h.writeFilterInput(input, []);
    assert.equal(input.value, ""); assert.deepEqual(plain(h.readFilterInput(input)), []);
  }
});

test("multi-value input: editing invalidates cached selections and supports JSON or legacy delimiters", async t => {
  const h = await harness(t), input = h.makeValueInput(field("value"), MULTI_VALUES, "value", "in");
  input.value = '  ["new, whole", "沪，京", 0, "new, whole"]  ';
  assert.equal(h.readFilterInput(input), input.value, "typed text takes precedence over old cached array");
  assert.deepEqual(plain(h.splitFilterValues(h.readFilterInput(input))), ["new, whole", "沪，京", "0"]);
  input.value = " 上海， 北京,0\n上海 , ";
  assert.deepEqual(plain(h.splitFilterValues(h.readFilterInput(input))), ["上海", "北京", "0"]);
  assert.deepEqual(plain(h.splitFilterValues(MULTI_VALUES)), MULTI_VALUES);
  assert.deepEqual(plain(h.splitFilterValues("[]")), []);
});

test("multi-value preferences: arrays survive save, dataset switches, schema refresh and reload", async t => {
  const saved = multiValuePreferences(), h = await harness(t, saved);
  assert.equal(h.state.filters[0].operator, "in");
  assert.deepEqual(plain(h.state.filters[0].value), MULTI_VALUES);
  assert.deepEqual(plain(h.readFilterInput(filterValueControl(h))), MULTI_VALUES);
  h.scheduleQuery(0);
  assert.deepEqual(stored(h).savedViews.comments.filters[0].value, MULTI_VALUES);
  await h.buttons.notes.emit("click");
  assert.deepEqual(plain(h.state.filters), saved.savedViews.notes.filters);
  await h.buttons.comments.emit("click");
  assert.deepEqual(plain(h.state.filters[0].value), MULTI_VALUES);
  await h.loadSchema();
  assert.deepEqual(plain(h.state.filters[0].value), MULTI_VALUES);
  const again = await harness(t, stored(h));
  assert.deepEqual(plain(again.state.filters[0].value), MULTI_VALUES);
  assert.deepEqual(plain(again.queryPayload().filter.children[0]), {
    field: "content", operator: "in", value: MULTI_VALUES, value2: ""
  });
});

test("multi-value picker: eq and in use checkbox details; commit upgrades eq and bubbles input to persistence", async t => {
  const values = ["Alpha, West", "上海，北京", "0"];
  const h = await harness(t, multiValuePreferences(values[0], "eq"), { valueOptions: valueEntries(values) });
  await settleValueOptions();
  const row = h.elements.filterRows.children[0], menu = row.querySelector("details.filter-multi-menu");
  assert.ok(menu, "an eq field supporting in gets the multiselect picker");
  assert.equal(row.querySelector("select.filter-value-options"), null);
  const checkboxes = menu.querySelectorAll('input[type="checkbox"]');
  assert.deepEqual(checkboxes.map(box => box.value), values);
  assert.deepEqual(checkboxes.map(box => box.checked), [true, false, false]);
  let bubbledInputs = 0;
  h.elements.filterRows.addEventListener("input", event => {
    assert.equal(event.target, filterValueControl(h)); bubbledInputs++;
  });
  checkboxes[1].checked = true; await checkboxes[1].emit("change");
  assert.equal(bubbledInputs, 1);
  assert.equal(h.state.filters[0].operator, "in");
  assert.equal(row.querySelector('[data-role="operator"]').value, "in");
  assert.deepEqual(plain(h.state.filters[0].value), values.slice(0, 2));
  assert.deepEqual(stored(h).savedViews.comments.filters[0].value, values.slice(0, 2));
  assert.ok([...h.timers.values()].some(timer => timer.delay === 360), "real delegated input handler scheduled the query");
  assert.deepEqual(plain(h.queryPayload().filter.children[0].value), values.slice(0, 2));
  checkboxes[1].checked = true; await checkboxes[1].emit("change");
  assert.deepEqual(plain(h.state.filters[0].value), values.slice(0, 2), "duplicate selection is idempotent");
  h.renderFilters(); await settleValueOptions();
  assert.ok(h.elements.filterRows.querySelector("details.filter-multi-menu"), "in rerender retains the picker");
  assert.deepEqual(h.elements.filterRows.querySelectorAll('input[type="checkbox"]').map(box => box.checked), [true, true, false]);
  assert.equal(h.queries.length, 0, "selecting values queues rather than immediately submits the query");
});

test("multi-value picker: removing chips preserves remaining exact values and final removal blocks requests", async t => {
  const h = await harness(t, multiValuePreferences(MULTI_VALUES.slice(0, 2)), { valueOptions: valueEntries(MULTI_VALUES) });
  await settleValueOptions();
  renderLoadedRows(h, rowsForExport(2));
  const previousRows = h.state.rows;
  await h.elements.filterRows.querySelector(".filter-value-chip").click();
  assert.deepEqual(plain(h.state.filters[0].value), [MULTI_VALUES[1]]);
  assert.deepEqual(stored(h).savedViews.comments.filters[0].value, [MULTI_VALUES[1]]);
  await h.elements.filterRows.querySelector(".filter-value-chip").click();
  assert.deepEqual(plain(h.state.filters[0].value), []);
  assert.equal(h.state.filters[0].operator, "in");
  assert.deepEqual(stored(h).savedViews.comments.filters[0].value, []);
  assert.equal(h.elements.filterDraftNotice.hidden, false);
  assert.equal(h.elements.exportCurrent.disabled, true);
  assert.equal(h.elements.infiniteSentinel.hidden, true);
  assert.ok(![...h.timers.values()].some(timer => timer.delay === 360), "last removal cancels the pending prior selection query");
  await h.runQuery(); await h.exportCurrentPage();
  assert.equal(h.queries.length, 0); assert.equal(h.downloads.length, 0); assert.equal(h.state.rows, previousRows);
});

test("multi-value operators: switching a selected array to eq never silently joins several values", async t => {
  for (const values of [MULTI_VALUES, [MULTI_VALUES[0]], []]) {
    const h = await harness(t, multiValuePreferences(values));
    const operator = h.elements.filterRows.querySelector('[data-role="operator"]');
    operator.value = "eq"; await h.elements.filterRows.emit("change", { target: operator });
    const expected = values.length === 1 ? values[0] : "";
    assert.equal(h.state.filters[0].operator, "eq");
    assert.equal(h.state.filters[0].value, expected);
    assert.equal(filterValueControl(h).value, expected);
    assert.equal(stored(h).savedViews.comments.filters[0].value, expected);
    assert.equal(h.queryPayload().filter.children[0].value, expected);
    assert.equal(h.validateFilterDraft(), values.length === 1);
    if (values.length !== 1) {
      h.state.queryReady = true; await h.runQuery();
      assert.equal(h.queries.length, 0, "cleared multi-value draft must pause instead of running a joined equality");
    }
  }
});

test("multi-value query: runtime payload receives arrays with intact commas, no UI IDs and no alias to state", async t => {
  const h = await harness(t, multiValuePreferences()), all = rowsForExport(3);
  renderLoadedRows(h, all);
  h.respondWith(request => pageResult(request, all));
  const projected = h.queryPayload();
  projected.filter.children[0].value.push("query copy only");
  assert.deepEqual(plain(h.state.filters[0].value), MULTI_VALUES);
  await h.runQuery();
  assert.equal(h.queries.length, 1);
  assert.deepEqual(h.queries[0].filter.children, [{ field: "content", operator: "in", value: MULTI_VALUES, value2: "" }]);
});

test("multi-value export: CSV pages keep the exact queried in array after the live draft changes", async t => {
  const h = await harness(t, multiValuePreferences()), all = rowsForExport(237);
  renderLoadedRows(h, all.slice(0, 100), { total: all.length });
  h.respondWith(request => pageResult(request, all));
  await h.runQuery();
  const queriedFilter = h.queries[0].filter;
  h.respondWith(request => {
    h.state.filters[0].value.push("later selection");
    return pageResult(request, all);
  });
  h.elements.exportFormat.value = "csv";
  await h.exportCurrentPage();
  assert.equal(h.downloads.length, 1);
  assert.ok(h.queries.length >= 3, "exercise multiple export pages, not only the initial screen");
  for (const request of h.queries.slice(1)) assert.deepEqual(request.filter, queriedFilter);
  assert.deepEqual(queriedFilter.children[0].value, MULTI_VALUES);
  assert.ok((await h.blobs[0].text()).includes("filtered-236"));
});

test("multi-value export: Excel request carries the same complete in filter as query and storage", async t => {
  const h = await harness(t, multiValuePreferences()), all = rowsForExport(3);
  renderLoadedRows(h, all); h.scheduleQuery(0);
  const savedFilter = stored(h).savedViews.comments.filters[0];
  h.respondWith(request => pageResult(request, all)); await h.runQuery();
  let received;
  h.respondExportWith(request => {
    received = request;
    h.state.filters[0].value.push("later selection");
    return { ok: true, dataset: request.dataset, total: all.length, snapshotToken: request.snapshotToken,
      consistentSnapshot: true, contentBase64: "UEsDBA==" };
  });
  h.elements.exportFormat.value = "xlsx"; await h.exportCurrentPage();
  assert.equal(h.downloads.length, 1);
  assert.deepEqual(received.filter, h.queries[0].filter);
  assert.equal(received.filter.children[0].operator, "in");
  assert.deepEqual(received.filter.children[0].value, savedFilter.value);
  assert.deepEqual(received.filter.children[0].value, MULTI_VALUES);
});

test("multi-value empty draft: no query or export runs, old rows remain and array persistence survives reload", async t => {
  const h = await harness(t, multiValuePreferences([]));
  renderLoadedRows(h, rowsForExport(2)); const rows = h.state.rows;
  assert.match(h.filterDraftProblem(), /尚未填写完整/);
  h.scheduleQuery(0);
  await h.runQuery(); await h.runQuery({ append: true }); await h.exportCurrentPage();
  assert.equal(h.queries.length, 0); assert.equal(h.downloads.length, 0);
  assert.equal(h.state.rows, rows); assert.equal(h.state.resetScheduled, true);
  assert.equal(h.elements.filterDraftNotice.hidden, false);
  assert.match(h.elements.filterDraftNotice.textContent, /上次结果/);
  assert.ok(![...h.timers.values()].some(timer => timer.delay === 0));
  const again = await harness(t, stored(h));
  assert.equal(again.state.filters[0].operator, "in");
  assert.deepEqual(plain(again.state.filters[0].value), []);
  assert.equal(again.validateFilterDraft(), false);
});

test("multi-value empty text: JSON empty arrays and delimiter-only input pause just like an empty selection", async t => {
  const h = await harness(t, multiValuePreferences());
  for (const value of ["[]", " ,，\n "]) {
    const input = filterValueControl(h); input.value = value;
    input.dispatchEvent({ type: "input", bubbles: true });
    assert.deepEqual(plain(h.splitFilterValues(h.state.filters[0].value)), []);
    assert.equal(h.validateFilterDraft(), false, `empty parsed in value must block: ${JSON.stringify(value)}`);
    assert.equal(h.elements.filterDraftNotice.hidden, false);
    assert.ok(![...h.timers.values()].some(timer => timer.delay === 360));
    h.state.queryReady = true; await h.runQuery(); assert.equal(h.queries.length, 0);
  }
});

test("multi-value operators: manually edited JSON arrays cannot become a literal JSON equality", async t => {
  for (const values of [["Alpha, West", "上海，北京"], ["Alpha, West"]]) {
    const h = await harness(t, multiValuePreferences());
    const input = filterValueControl(h); input.value = JSON.stringify(values);
    input.dispatchEvent({ type: "input", bubbles: true });
    assert.deepEqual(plain(h.queryPayload().filter.children[0].value), values);
    const operator = h.elements.filterRows.querySelector('[data-role="operator"]');
    operator.value = "eq"; await h.elements.filterRows.emit("change", { target: operator });
    assert.equal(h.state.filters[0].value, values.length === 1 ? values[0] : "",
      "operator conversion must use interpreted in values, not the JSON display string");
  }
});

test("multi-value boundary matrix: builder and column share limits; eq-to-in preserves one complete value", async t => {
  const hundred = Array.from({ length: 100 }, (_, i) => `value-${i}`);
  const cases = [
    { name: "empty JSON", value: "[]", valid: false },
    { name: "only separators", value: " ,，\n ", valid: false },
    { name: "101 selected values", value: [...hundred, "overflow"], valid: false },
    { name: "101 JSON values", value: JSON.stringify([...hundred, "overflow"]), valid: false },
    { name: "101 comma-separated values", value: [...hundred, "overflow"].join(","), valid: false },
    { name: "exactly 100 values", value: hundred, valid: true },
    { name: "100 unique values plus duplicate", value: [...hundred, hundred[0]], valid: true },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async sub => {
      const builder = await harness(sub, multiValuePreferences(["original"]));
      builder.state.filters[0].value = entry.value;
      assert.equal(builder.validateFilterDraft(), entry.valid, "builder validates parsed unique cardinality");
      if (!entry.valid) {
        builder.scheduleQuery(0); builder.state.queryReady = true; await builder.runQuery();
        assert.equal(builder.queries.length, 0);
        assert.equal(builder.elements.exportCurrent.disabled, true);
      } else assert.equal(builder.queryPayload().filter.children[0].value.length, 100);

      const column = await harness(sub, multiValuePreferences(["original"]));
      const previousFilters = plain(column.state.filters), previousStored = stored(column);
      column.openColumnFilter("content", null);
      assert.equal(column.elements.columnFilterOperator.value, "in");
      const input = column.elements.columnFilterValueWrap.querySelector('[data-role="value"]');
      let focused = false; input.focus = () => { focused = true; };
      column.writeFilterInput(input, entry.value);
      await column.elements.applyColumnFilter.click();
      assert.equal(column.elements.columnFilterPopover.hidden, entry.valid, "invalid column draft stays open");
      if (!entry.valid) {
        assert.equal(focused, true);
        assert.deepEqual(plain(column.state.filters), previousFilters, "rejected apply preserves existing rules");
        assert.deepEqual(stored(column), previousStored, "rejected apply does not persist a replacement");
        assert.equal(column.state.resetScheduled, false);
      } else {
        assert.equal(column.state.filters.length, 1);
        assert.equal(column.state.filters[0].operator, "in");
        assert.deepEqual(plain(column.queryPayload().filter.children[0].value), hundred);
        assert.equal(column.state.resetScheduled, true);
      }
      assert.equal(column.queries.length, 0);
    });
  }
  for (const value of [...MULTI_VALUES, '["literal JSON-looking single value"]']) {
    await t.test(`eq-to-in ${JSON.stringify(value)}`, async sub => {
      const h = await harness(sub, multiValuePreferences(value, "eq"));
      const operator = h.elements.filterRows.querySelector('[data-role="operator"]');
      operator.value = "in"; await h.elements.filterRows.emit("change", { target: operator });
      assert.equal(h.state.filters[0].operator, "in");
      assert.deepEqual(plain(h.state.filters[0].value), [value]);
      assert.deepEqual(plain(h.readFilterInput(filterValueControl(h))), [value]);
      assert.deepEqual(plain(h.queryPayload().filter.children[0].value), [value]);
      assert.deepEqual(stored(h).savedViews.comments.filters[0].value, [value]);
    });
  }
});

function pendingResponse() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function commentReturnHarness(t, { semantic = false, notice = false } = {}) {
  const h = await harness(t, multiValuePreferences());
  h.schema.queryReady = true;
  h.state.visibleFields.comments.push("post_locator");
  h.state.semanticSearch = semantic; h.state.semanticAwaitingSubmit = false;
  h.state.groupThreads = true;
  const rows = rowsForExport(237).map(row => ({ ...row, post_locator: row.note_id }));
  renderLoadedRows(h, rows, { total: 450, pageSize: 100 });
  h.state.page = 3; h.state.hasMore = true;
  h.state.selectedIds = new Set(["c1", "c203"]);
  h.elements.semanticStatus.textContent = semantic ? "语义检索 · fixture-model · 相关度降序" : "普通搜索 · 关键词匹配";
  h.elements.filterDraftNotice.hidden = !notice;
  h.elements.filterDraftNotice.textContent = notice ? "上次请求未完成，保留此前结果" : "";
  h.elements.tableViewport.scrollTop = 8123; h.elements.tableViewport.scrollLeft = 417;
  h.window.scrollY = 250; h.window.scrollX = 19;
  h.window.scrollCalls = [];
  h.window.scrollTo = function (options) {
    this.scrollCalls.push(plain(options)); this.scrollY = options.top; this.scrollX = options.left;
  };
  h.respondWith(request => pageResult(request, [{ note_id: "fixture-note", title: "parent post" }]));
  return h;
}
function returnState(h) {
  return plain({ view: activeView(h.state), semanticSearch: h.state.semanticSearch,
    semanticAwaitingSubmit: h.state.semanticAwaitingSubmit, rows: h.state.rows,
    total: h.state.total, page: h.state.page, pageSize: h.state.pageSize, hasMore: h.state.hasMore,
    selectedIds: [...h.state.selectedIds], semanticStatus: h.elements.semanticStatus.textContent,
    draftNoticeHidden: h.elements.filterDraftNotice.hidden, draftNotice: h.elements.filterDraftNotice.textContent });
}

test("comment return: clicked source restores all loaded pages, selection and both scroll surfaces without a first-page query", async t => {
  const h = await commentReturnHarness(t), before = returnState(h);
  assert.equal(h.elements.returnToComments.hidden, true);
  const source = h.elements.tableBody.querySelector('tr[data-record-id="c203"]');
  const button = source.querySelector('[data-action="locate_post"]');
  assert.ok(button, "use the rendered row action so its comment ID is passed through production");
  assert.equal(button.disabled, false, "fixture must include the backend-projected post_locator value");
  assert.equal(button.dataset.value, "fixture-note");
  await h.runTableAction(button);
  assert.equal(h.state.dataset, "notes"); assert.equal(h.elements.returnToComments.hidden, false);
  assert.equal(h.getCommentReturnPoint().commentId, "c203");
  assert.equal(h.queries.length, 1); assert.equal(h.queries[0].dataset, "notes");
  assert.equal(h.queries[0].filter.children[0].value, "fixture-note");
  h.elements.tableViewport.scrollTop = 0; h.elements.tableViewport.scrollLeft = 0;
  h.window.scrollY = 0; h.window.scrollX = 0;
  const click = h.elements.returnToComments.click();
  assert.equal(h.state.dataset, "comments", "cache restore is synchronous before the click promise resolves");
  await click; h.flushAnimationFrames();
  assert.deepEqual(returnState(h), before);
  assert.equal(h.elements.tableBody.querySelectorAll("tr[data-record-id]").length, 237);
  assert.equal(h.elements.tableViewport.scrollTop, 8123); assert.equal(h.elements.tableViewport.scrollLeft, 417);
  assert.equal(h.window.scrollY, 250); assert.equal(h.window.scrollX, 19);
  assert.equal(h.window.scrollCalls.length, 2, "both animation frames restore document scroll");
  const restoredSource = h.elements.tableBody.querySelector('tr[data-record-id="c203"]');
  assert.equal(restoredSource.classList.contains("return-comment-highlight"), true);
  assert.equal(restoredSource.querySelector('[data-action="locate_post"]').focusCalls.at(-1).preventScroll, true);
  assert.equal(h.elements.returnToComments.hidden, true); assert.equal(h.getCommentReturnPoint(), null);
  assert.equal(h.queries.length, 1, "return never refetches the first comments batch");
  assert.ok(!JSON.stringify(stored(h)).includes('"rows"'), "bookmark rows remain memory-only");
});

test("comment return: committed semantic search, array filters, sort, grouping and draft notice survive notes navigation", async t => {
  const h = await commentReturnHarness(t, { semantic: true, notice: true }), before = returnState(h);
  await h.locatePostInDatabase("fixture-note", "c203");
  assert.equal(h.state.semanticSearch, false);
  assert.equal(h.queries[0].semanticSearch, false);
  h.state.savedViews.comments.filters[0].value.push("unrelated later edit");
  h.returnToCommentPosition(); h.flushAnimationFrames();
  assert.deepEqual(returnState(h), before);
  assert.equal(h.elements.globalSearch.value, before.view.search);
  assert.equal(h.state.semanticAwaitingSubmit, false, "restored committed semantic results are not marked unsubmitted");
  assert.deepEqual(plain(h.state.filters[0].value), MULTI_VALUES);
  assert.deepEqual(stored(h).savedViews.comments.filters[0].value, MULTI_VALUES);
  assert.equal(h.elements.exportCurrent.disabled, true, "restored draft notice keeps export paused");
  assert.equal(h.queries.length, 1);
});

test("comment return: returning during a pending notes query cancels debounce and rejects late rows, loading and locate scroll", async t => {
  const h = await commentReturnHarness(t), before = returnState(h), pending = pendingResponse();
  h.respondWith(() => pending.promise);
  const locating = h.locatePostInDatabase("fixture-note", "c203");
  assert.equal(h.state.loading, true);
  await h.runQuery(); assert.equal(h.state.queryPending, true);
  h.scheduleQuery(180); assert.equal(h.state.resetScheduled, true);
  const oldSerial = h.state.querySerial;
  h.returnToCommentPosition(); h.flushAnimationFrames();
  assert.ok(h.state.querySerial > oldSerial);
  assert.equal(h.state.loading, false); assert.equal(h.state.queryPending, false); assert.equal(h.state.resetScheduled, false);
  assert.ok(![...h.timers.values()].some(timer => timer.delay === 180));
  assert.deepEqual(returnState(h), before);
  const currentRows = h.state.rows, currentNodes = [...h.elements.tableBody.children], toast = h.elements.toast.textContent;
  pending.resolve(pageResult(h.queries[0], [{ note_id: "late-parent", title: "late note" }]));
  await locating; await settleValueOptions(); h.flushAnimationFrames();
  assert.equal(h.state.rows, currentRows); assert.deepEqual([...h.elements.tableBody.children], currentNodes);
  assert.deepEqual(returnState(h), before); assert.equal(h.queries.length, 1);
  assert.equal(h.elements.toast.textContent, toast, "late locate completion must not replace the return message");
  assert.ok(currentNodes.every(row => !row.scrollIntoViewCalls?.length), "late note completion must not scroll the restored comments");
  assert.equal(h.elements.dataSurface.getAttribute("aria-busy"), "false");
});

test("comment return: in-flight comment append is cancelled and never injected into the restored cached pages", async t => {
  const h = await commentReturnHarness(t), before = returnState(h), pending = pendingResponse();
  h.respondWith(request => request.dataset === "comments" ? pending.promise
    : pageResult(request, [{ note_id: "fixture-note", title: "parent" }]));
  const appending = h.runQuery({ append: true });
  assert.equal(h.queries[0].page, 4); assert.equal(h.state.loading, true);
  await h.locatePostInDatabase("fixture-note", "c203");
  assert.equal(h.state.dataset, "notes");
  h.returnToCommentPosition(); h.flushAnimationFrames();
  assert.deepEqual(returnState(h), before);
  pending.resolve({ ok: true, dataset: "comments", snapshotToken: SNAPSHOT, page: 4, pageSize: 100,
    total: 450, rows: [{ comment_id: "late-append", note_id: "fixture-note", content: "late row" }] });
  await appending; await settleValueOptions(); h.flushAnimationFrames();
  assert.deepEqual(returnState(h), before);
  assert.equal(h.queries.length, 2);
  assert.equal(h.state.loading, false); assert.equal(h.state.queryPending, false);
});

test("comment return: token changes, explicit staleness or lost readiness restore a read-only cache", async t => {
  for (const reason of ["token", "stale", "not-ready"]) {
    await t.test(reason, async sub => {
      const h = await commentReturnHarness(sub), before = returnState(h);
      await h.locatePostInDatabase("fixture-note", "c203");
      if (reason === "token") h.state.snapshotToken = "new-snapshot";
      if (reason === "stale") h.state.snapshotStale = true;
      if (reason === "not-ready") h.state.queryReady = false;
      const liveToken = h.state.snapshotToken;
      h.returnToCommentPosition(); h.flushAnimationFrames();
      assert.deepEqual(plain(h.state.rows), before.rows);
      assert.equal(h.state.page, 3); assert.equal(h.state.snapshotToken, liveToken, "return must not rewind the live snapshot token");
      assert.equal(h.state.snapshotStale, true); assert.equal(h.elements.snapshotNotice.hidden, false);
      assert.match(h.elements.snapshotNoticeText.textContent, /离开时的记录/);
      assert.equal(h.state.selectedIds.size, 0);
      assert.equal(h.elements.exportCurrent.disabled, true);
      assert.equal(h.elements.deleteSelected.disabled, true); assert.equal(h.elements.confirmDelete.disabled, true);
      assert.ok(h.elements.tableBody.querySelectorAll('[data-role="select-row"]').every(input => input.disabled));
      const requests = h.messages.length;
      await h.runQuery(); await h.exportCurrentPage(); await h.elements.deleteSelected.click();
      assert.equal(h.messages.length, requests); assert.equal(h.downloads.length, 0);
      assert.equal(h.elements.tableViewport.scrollTop, 8123); assert.equal(h.elements.tableViewport.scrollLeft, 417);
    });
  }
});

test("comment return: unresolved drafts and destructive/export operations prevent bookmark capture", async t => {
  for (const flag of ["resetScheduled", "queryPending", "semanticAwaitingSubmit", "deletePending", "exporting", "snapshotStale"]) {
    const h = await commentReturnHarness(t), before = returnState(h);
    h.state[flag] = true;
    const serial = h.state.querySerial;
    await h.locatePostInDatabase("fixture-note", "c203");
    assert.equal(h.state.dataset, "comments", flag);
    assert.equal(h.getCommentReturnPoint(), null, flag);
    assert.equal(h.state.querySerial, serial, flag);
    assert.equal(h.queries.length, 0, flag);
    assert.deepEqual(plain(h.state.rows), before.rows, flag);
    assert.deepEqual(plain(h.state.filters[0].value), MULTI_VALUES, flag);
  }
});

test("comment return: manual comments switch discards the bookmark rather than reviving old cached pages later", async t => {
  const h = await commentReturnHarness(t);
  h.respondWith(request => pageResult(request, request.dataset === "notes"
    ? [{ note_id: "fixture-note", title: "parent" }] : [{ comment_id: "fresh-comment", note_id: "fixture-note", content: "fresh" }]));
  await h.locatePostInDatabase("fixture-note", "c203");
  await h.buttons.comments.emit("click"); await settleValueOptions();
  assert.equal(h.getCommentReturnPoint(), null);
  assert.equal(h.elements.returnToComments.hidden, true);
  assert.equal(h.state.rows[0].comment_id, "fresh-comment");
  await h.buttons.notes.emit("click"); await settleValueOptions();
  const rows = h.state.rows, requests = h.queries.length;
  h.returnToCommentPosition();
  assert.equal(h.state.dataset, "notes"); assert.equal(h.state.rows, rows); assert.equal(h.queries.length, requests);
});

test("comment return: deletion, export or schema refresh blocks return without consuming the bookmark", async t => {
  for (const flag of ["deletePending", "exporting", "refreshSchema"]) {
    const h = await commentReturnHarness(t);
    await h.locatePostInDatabase("fixture-note", "c203");
    const point = h.getCommentReturnPoint(), rows = h.state.rows, serial = h.state.querySerial;
    if (flag === "refreshSchema") h.elements.refreshSchema.disabled = true;
    else h.state[flag] = true;
    h.returnToCommentPosition();
    assert.equal(h.state.dataset, "notes", flag); assert.equal(h.state.rows, rows, flag);
    assert.equal(h.state.querySerial, serial, flag); assert.equal(h.getCommentReturnPoint(), point, flag);
    if (flag === "refreshSchema") h.elements.refreshSchema.disabled = false;
    else h.state[flag] = false;
    h.returnToCommentPosition(); h.flushAnimationFrames();
    assert.equal(h.state.dataset, "comments"); assert.equal(h.state.rows.length, 237);
    assert.equal(h.getCommentReturnPoint(), null); assert.equal(h.queries.length, 1);
  }
});

test("comment return: a second navigation before animation frames prevents stale scroll restoration", async t => {
  const h = await commentReturnHarness(t);
  await h.locatePostInDatabase("fixture-note", "c203");
  h.returnToCommentPosition();
  await h.locatePostInDatabase("another-note", "c1");
  h.elements.tableViewport.scrollTop = 91; h.elements.tableViewport.scrollLeft = 23;
  h.window.scrollY = 17; h.window.scrollX = 5;
  h.flushAnimationFrames();
  assert.equal(h.state.dataset, "notes");
  assert.equal(h.elements.tableViewport.scrollTop, 91); assert.equal(h.elements.tableViewport.scrollLeft, 23);
  assert.equal(h.window.scrollY, 17); assert.equal(h.window.scrollX, 5);
  assert.equal(h.window.scrollCalls.length, 0);
  assert.equal(h.elements.tableBody.querySelector(".return-comment-highlight"), null);
  assert.equal(h.queries.length, 2);
});

const IP_FIELDS = { notes: [field("source_ip_location", { suggestValues: true })], comments: [
  field("ip_location", { suggestValues: true }), field("post__source_ip_location", { suggestValues: true })
] };
function ipEmptyPreferences({ dataset = "comments", key = "ip_location", value = ["广东"], includeEmpty = true, operator = "in" } = {}) {
  const saved = preferences(dataset);
  saved.savedViews[dataset].filters = [{ id: "ip", field: key, operator, value, value2: "", ...(includeEmpty ? { includeEmpty: true } : {}) }];
  return saved;
}
const ipEmptyHarness = (t, saved = ipEmptyPreferences(), values = ["广东", "上海"]) =>
  harness(t, saved, { extraFields: IP_FIELDS, valueOptions: valueEntries(values) });
const ipValueOrEmpty = (key = "ip_location", value = ["广东"]) => ({ logic: "or", children: [
  { field: key, operator: "in", value, value2: "" }, { field: key, operator: "is_empty" }
] });

test("IP empty picker: only the three IP fields show a fixed empty row below search without extra count queries", async t => {
  for (const [dataset, key] of [["comments", "ip_location"], ["comments", "post__source_ip_location"], ["notes", "source_ip_location"]]) {
    const h = await ipEmptyHarness(t, ipEmptyPreferences({ dataset, key, includeEmpty: false, operator: "eq", value: "广东" }));
    await settleValueOptions();
    const menu = h.elements.filterRows.querySelector("details.filter-multi-menu");
    const empty = menu.querySelector(".filter-empty-checkbox"), search = menu.querySelector(".filter-options-search");
    assert.ok(empty, key); assert.equal(empty.dataset.emptyValue, "true");
    assert.equal(empty.getAttribute("value"), undefined, "empty selection has no fabricated option value attribute");
    assert.equal(empty.parentNode.hidden, false); assert.equal(empty.parentNode.textContent, "未显示（空值）");
    assert.equal(empty.parentNode.querySelector("small"), null, "no fabricated empty-value count is displayed");
    assert.equal(menu.children[menu.children.indexOf(search) + 1], empty.parentNode);
    assert.equal(empty.parentNode.parentNode, menu, "empty row is outside the replaceable options result list");
    assert.equal(h.messages.filter(m => m.type === "getDataOverviewValues").length, 1);
    assert.equal(h.queries.length, 0);
    search.value = "不存在的属地"; await search.emit("input"); h.fireTimer(250); await settleValueOptions();
    assert.equal(menu.querySelector(".filter-empty-checkbox"), empty); assert.equal(empty.parentNode.hidden, false);
    const requests = h.messages.filter(m => m.type === "getDataOverviewValues");
    assert.equal(requests.length, 2, "search adds only the ordinary options request, never an empty-count query");
    assert.equal(requests[1].payload.search, search.value); assert.equal(requests[1].payload.field, key);
    empty.checked = true; await empty.emit("change");
    assert.equal(h.state.filters[0].operator, "in"); assert.equal(h.state.filters[0].includeEmpty, true);
    assert.deepEqual(plain(h.state.filters[0].value), ["广东"]);
    assert.deepEqual(plain(h.queryPayload().filter.children[0]), ipValueOrEmpty(key));
    assert.equal(h.messages.filter(m => m.type === "getDataOverviewValues").length, 2);
  }
  const other = await harness(t, multiValuePreferences()); await settleValueOptions();
  assert.equal(other.elements.filterRows.querySelector(".filter-empty-checkbox"), null, "ordinary content field must not expose IP-only wording");
});

test("IP empty query: value-or-empty stays a single subgroup under either global AND or OR", async t => {
  for (const logic of ["and", "or"]) {
    const h = await ipEmptyHarness(t);
    h.state.filterLogic = logic;
    h.state.filters.push({ id: "other", field: "content", operator: "contains", value: "投诉", value2: "" });
    const expected = { logic, children: [ipValueOrEmpty(), { field: "content", operator: "contains", value: "投诉", value2: "" }] };
    assert.deepEqual(plain(h.queryPayload().filter), expected);
    assert.equal(h.validateFilterDraft(), true);
    h.state.queryReady = true; h.respondWith(request => pageResult(request, rowsForExport(2)));
    await h.runQuery(); assert.equal(h.queries.length, 1);
    assert.deepEqual(h.queries[0].filter, expected);
    assert.doesNotMatch(JSON.stringify(h.queries[0].filter), /includeEmpty|"id"|未显示/, "UI metadata and empty labels never leak into filter values");
    assert.equal(h.state.filters[0].includeEmpty, true, "compilation does not consume the display flag");
  }
});

test("IP empty-only: empty selection compiles to is_empty and removing it restores incomplete-draft protection", async t => {
  const h = await ipEmptyHarness(t, ipEmptyPreferences({ value: [] })); await settleValueOptions();
  assert.equal(h.filterDraftProblem(), ""); assert.equal(h.validateFilterDraft(), true);
  assert.deepEqual(plain(h.queryPayload().filter.children), [{ field: "ip_location", operator: "is_empty" }]);
  assert.deepEqual(plain(h.readFilterInput(filterValueControl(h))), []);
  h.scheduleQuery(0);
  const again = await ipEmptyHarness(t, stored(h));
  assert.equal(again.state.filters[0].includeEmpty, true);
  assert.deepEqual(plain(again.state.filters[0].value), []);
  assert.deepEqual(plain(again.queryPayload().filter.children[0]), { field: "ip_location", operator: "is_empty" });
  h.state.queryReady = true; h.respondWith(request => pageResult(request, rowsForExport(2)));
  await h.runQuery(); assert.equal(h.queries.length, 1);
  const chip = h.elements.filterRows.querySelector(".filter-value-chip");
  assert.equal(chip.textContent, "未显示（空值） ×"); await chip.click();
  assert.equal(h.state.filters[0].includeEmpty, undefined);
  assert.deepEqual(plain(h.state.filters[0].value), []);
  assert.equal(h.validateFilterDraft(), false); assert.equal(h.elements.exportCurrent.disabled, true);
  await h.runQuery(); assert.equal(h.queries.length, 1, "unchecking the last selection cannot execute an empty in condition");
});

test("IP empty preferences: flag and exact arrays survive dataset changes and reload; non-in and nonboolean flags do not", async t => {
  const h = await ipEmptyHarness(t, ipEmptyPreferences({ value: ["广东", "地区,完整值"] }));
  h.scheduleQuery(0);
  assert.equal(stored(h).savedViews.comments.filters[0].includeEmpty, true);
  await h.buttons.notes.emit("click"); await h.buttons.comments.emit("click");
  assert.equal(h.state.filters[0].includeEmpty, true);
  assert.deepEqual(plain(h.state.filters[0].value), ["广东", "地区,完整值"]);
  const again = await ipEmptyHarness(t, stored(h)); await settleValueOptions();
  assert.equal(again.elements.filterRows.querySelector(".filter-empty-checkbox").checked, true);
  assert.deepEqual(plain(again.queryPayload().filter.children[0]), ipValueOrEmpty("ip_location", ["广东", "地区,完整值"]));
  for (const overrides of [{ includeEmpty: "true" }, { includeEmpty: true, operator: "eq", value: "广东" }]) {
    const saved = ipEmptyPreferences(); Object.assign(saved.savedViews.comments.filters[0], overrides);
    const invalidFlag = await ipEmptyHarness(t, saved);
    assert.equal(invalidFlag.state.filters[0].includeEmpty, undefined, "only boolean true on in survives normalization");
    assert.equal(invalidFlag.queryPayload().filter.children[0].logic, undefined);
  }
});

test("IP empty column: apply and reopen retain empty choice; builder chip removes empty without removing Guangdong", async t => {
  const h = await ipEmptyHarness(t, ipEmptyPreferences({ includeEmpty: false }));
  h.openColumnFilter("ip_location", null); await settleValueOptions();
  const check = h.elements.columnFilterValueWrap.querySelector(".filter-empty-checkbox");
  check.checked = true; await check.emit("change");
  assert.equal(h.state.filters[0].includeEmpty, undefined, "column selection remains draft until apply");
  await h.elements.applyColumnFilter.click();
  assert.equal(h.elements.columnFilterPopover.hidden, true);
  assert.equal(h.state.filters.length, 1); assert.equal(h.state.filters[0].includeEmpty, true);
  assert.deepEqual(plain(h.queryPayload().filter.children[0]), ipValueOrEmpty());
  h.openColumnFilter("ip_location", null); await settleValueOptions();
  assert.equal(h.elements.columnFilterValueWrap.querySelector(".filter-empty-checkbox").checked, true);
  assert.deepEqual(plain(h.readFilterInput(h.elements.columnFilterValueWrap.querySelector('[data-role="value"]'))), ["广东"]);
  await h.elements.closeColumnFilter.click();
  const chips = h.elements.filterRows.querySelectorAll(".filter-value-chip");
  await chips.find(chip => chip.textContent === "未显示（空值） ×").click();
  assert.equal(h.state.filters[0].includeEmpty, undefined);
  assert.deepEqual(plain(h.queryPayload().filter.children[0]), { field: "ip_location", operator: "in", value: ["广东"], value2: "" });
  assert.equal(stored(h).savedViews.comments.filters[0].includeEmpty, undefined);
});

test("IP empty column: empty-only apply succeeds and selecting a non-in operator clears the flag", async t => {
  const h = await ipEmptyHarness(t, ipEmptyPreferences({ value: [], includeEmpty: false }));
  h.openColumnFilter("ip_location", null); await settleValueOptions();
  const check = h.elements.columnFilterValueWrap.querySelector(".filter-empty-checkbox");
  check.checked = true; await check.emit("change"); await h.elements.applyColumnFilter.click();
  assert.equal(h.elements.columnFilterPopover.hidden, true); assert.equal(h.validateFilterDraft(), true);
  assert.deepEqual(plain(h.queryPayload().filter.children[0]), { field: "ip_location", operator: "is_empty" });
  h.openColumnFilter("ip_location", null);
  h.elements.columnFilterOperator.value = "eq"; await h.elements.columnFilterOperator.emit("change");
  const value = h.elements.columnFilterValueWrap.querySelector('[data-role="value"]'); value.value = "广东";
  await h.elements.applyColumnFilter.click();
  assert.equal(h.state.filters[0].includeEmpty, undefined);
  assert.deepEqual(plain(h.queryPayload().filter.children[0]), { field: "ip_location", operator: "eq", value: "广东", value2: "" });
  h.state.filters[0].operator = "in"; h.state.filters[0].value = ["广东"]; h.state.filters[0].includeEmpty = true; h.renderFilters();
  const operator = h.elements.filterRows.querySelector('[data-role="operator"]'); operator.value = "eq";
  await h.elements.filterRows.emit("change", { target: operator });
  assert.equal(h.state.filters[0].includeEmpty, undefined); assert.equal(h.state.filters[0].value, "广东");
});

test("empty-only serialization: date and number skip value validation only for explicit true; limits still apply", async t => {
  const h = await ipEmptyHarness(t);
  h.schema.datasets.comments.fields.push(field("fixture_number", { dataType: "number" }));
  for (const key of ["published_at", "fixture_number"]) {
    h.state.filters = [{ id: "empty", field: key, operator: "in", value: [], value2: "", includeEmpty: true }];
    assert.equal(h.filterDraftProblem(), "", key);
    assert.deepEqual(plain(h.queryPayload().filter.children[0]), { field: key, operator: "is_empty" });
    h.state.filters[0].includeEmpty = "true";
    assert.notEqual(h.filterDraftProblem(), "", "a truthy string cannot bypass validation");
    h.state.filters[0].includeEmpty = true; h.state.filters[0].value = ["invalid-number-or-date"];
    assert.notEqual(h.filterDraftProblem(), "", "empty choice does not excuse malformed nonempty values");
  }
  h.state.filters = [{ id: "limit", field: "ip_location", operator: "in", value: Array.from({ length: 101 }, (_, i) => String(i)), includeEmpty: true }];
  assert.match(h.filterDraftProblem(), /100/);
});

test("IP empty export: CSV and Excel preserve mixed or empty-only queries even if the live empty choice changes", async t => {
  for (const [format, values] of [["csv", ["广东"]], ["xlsx", ["广东"]], ["csv", []], ["xlsx", []]]) {
    const h = await ipEmptyHarness(t, ipEmptyPreferences({ value: values })), all = rowsForExport(237);
    h.state.filterLogic = "and";
    h.state.filters.push({ id: "content", field: "content", operator: "contains", value: "filtered", value2: "" });
    renderLoadedRows(h, all.slice(0, 100), { total: all.length });
    h.respondWith(request => pageResult(request, all)); await h.runQuery();
    const queriedFilter = h.queries[0].filter;
    const mutate = () => { delete h.state.filters[0].includeEmpty; h.state.filters[0].value.push("later-only"); };
    h.respondWith(request => { mutate(); return pageResult(request, all); });
    let workbookRequest;
    h.respondExportWith(request => {
      workbookRequest = request; mutate();
      return { ok: true, dataset: request.dataset, total: all.length, snapshotToken: request.snapshotToken,
        consistentSnapshot: true, contentBase64: "UEsDBA==" };
    });
    h.elements.exportFormat.value = format; await h.exportCurrentPage();
    assert.equal(h.downloads.length, 1, format);
    assert.deepEqual(queriedFilter.children[0], values.length ? ipValueOrEmpty() : { field: "ip_location", operator: "is_empty" });
    assert.equal(queriedFilter.logic, "and"); assert.equal(queriedFilter.children.length, 2);
    const exportRequests = format === "xlsx" ? [workbookRequest] : h.queries.slice(1);
    assert.ok(exportRequests.length > 0);
    for (const request of exportRequests) assert.deepEqual(request.filter, queriedFilter, format);
    assert.doesNotMatch(JSON.stringify(exportRequests.map(r => r.filter)), /includeEmpty|未显示|later-only/);
    if (format === "csv") assert.ok((await h.blobs[0].text()).includes("filtered-236"));
  }
});
