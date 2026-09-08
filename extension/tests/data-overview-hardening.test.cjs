"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { Blob } = require("node:buffer");
const { test } = require("node:test");
const vm = require("node:vm");

// Self-contained DOM fixture based on data-overview-state.test.cjs; production
// functions are never replaced. DATA_OVERVIEW_SOURCE can replay a pre-edit copy.
// Load production scripts verbatim, including their UI bootstrap, in a fresh VM.
// All data, runtime messages, storage, timers and downloads below stay in memory.
const scripts = ["data-export.js", "column-order.js", "data-overview.js"].map((name) => {
  const filename = name === "data-overview.js" && process.env.DATA_OVERVIEW_SOURCE
    ? process.env.DATA_OVERVIEW_SOURCE : join(__dirname, "..", name);
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
  get isConnected() { return this.tagName === "BODY" || Boolean(this.parentNode?.isConnected); }
  dispatchEvent(event) { this.emit(event.type, { target: this }); return true; }
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
  showModal() { this.open = true; }
  close() { this.open = false; }
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

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const queryTimers = (h) => [...h.timers.values()].filter((timer) => timer.delay < 1000);
const schemaCalls = (h) => h.messages.filter((message) => message.type === "getDataOverviewSchema");
const deleteCalls = (h) => h.messages.filter((message) => message.type === "deleteDataOverviewRecords");
function pageResult(request, rows) {
  return {
    ok: true, consistentSnapshot: true, dataset: request.dataset, snapshotToken: request.snapshotToken,
    page: request.page, pageSize: request.pageSize, total: rows.length,
    rows: rows.slice((request.page - 1) * request.pageSize, request.page * request.pageSize),
  };
}
function prepareRows(h, count = 1) {
  const all = Array.from({ length: count }, (_, index) => ({ note_id: "n" + index, title: "row " + index }));
  h.schema.queryReady = true;
  Object.assign(h.state, {
    queryReady: true, snapshotToken: SNAPSHOT, rows: all.slice(0, 100), total: all.length,
    page: 1, pageSize: 100, hasMore: all.length > 100,
  });
  h.renderTable({ rows: h.state.rows });
  return all;
}
async function search(h, value) {
  h.elements.globalSearch.value = value;
  await h.elements.globalSearch.emit("input");
}

test("hardening: a stale success must not cut short the latest search debounce", async (t) => {
  const h = await harness(t);
  prepareRows(h);
  const old = deferred();
  h.respondWith((request) => request.search === "" ? old.promise
    : pageResult(request, [{ note_id: "latest", title: request.search }]));
  const loading = h.runQuery();
  await search(h, "latest intent");
  old.resolve(pageResult(h.queries[0], [{ note_id: "old" }]));
  await loading;
  await settle();
  assert.equal(h.queries.length, 1, "old completion must leave the 320ms quiet period intact");
  assert.equal(h.state.resetScheduled, true);
  assert.deepEqual(plain(h.state.rows).map(row => row.note_id), ["n0"], "retain prior confirmed rows, never render superseded result");
  assert.equal(h.elements.exportCurrent.disabled, true);
  h.fireTimer(320);
  await settle();
  assert.deepEqual(h.queries.map((request) => request.search), ["", "latest intent"]);
  assert.deepEqual(plain(h.state.rows).map((row) => row.note_id), ["latest"]);
  assert.equal(h.state.loading, false);
});

test("hardening: an immediate dataset query consumes the old dataset's debounce once", async (t) => {
  const h = await harness(t);
  prepareRows(h);
  h.respondWith((request) => pageResult(request, [{ comment_id: "c1", note_id: "n1", content: "comment" }]));
  await search(h, "old notes search");
  await h.buttons.comments.click();
  await settle();
  assert.deepEqual(h.queries.map((request) => [request.dataset, request.page]), [["comments", 1]],
    "no redundant reset query for the same new dataset");
  assert.equal(queryTimers(h).length, 0, "a direct reset takes ownership of the pending timer");
  assert.equal(h.state.resetScheduled, false);
  assert.equal(h.state.rows[0].comment_id, "c1");
});

test("hardening: another edit after a queued reset still gets its full debounce", async (t) => {
  const h = await harness(t);
  prepareRows(h);
  const old = deferred();
  h.respondWith((request) => h.queries.length === 1 ? old.promise : pageResult(request, [{ note_id: "new" }]));
  const loading = h.runQuery();
  await search(h, "first");
  h.fireTimer(320);
  assert.equal(h.state.queryPending, true);
  await search(h, "second");
  old.resolve(pageResult(h.queries[0], [{ note_id: "old" }]));
  await loading;
  await settle();
  assert.equal(h.queries.length, 1);
  assert.equal(h.state.resetScheduled, true);
  h.fireTimer(320);
  await settle();
  assert.deepEqual(h.queries.map((request) => request.search), ["", "second"]);
});

test("hardening: superseded failures never paint errors or trigger snapshot recovery", async (t) => {
  for (const message of ["fixture transport error", "快照已变化，请重新校验"]) {
    for (const append of [false, true]) {
      const h = await harness(t);
      prepareRows(h, 201);
      const old = deferred();
      h.respondWith((request) => request.search === "" ? old.promise : pageResult(request, [{ note_id: "fresh" }]));
      const loading = h.runQuery({ append });
      await search(h, "fresh");
      old.reject(new Error(message));
      await loading;
      await settle();
      assert.equal(schemaCalls(h).length, 1, "only bootstrap may request a schema for a superseded error");
      assert.equal(h.elements.tableEmpty.hidden, true, "no error panel from the obsolete view");
      assert.notEqual(h.elements.infiniteSentinel.dataset.state, "error", "no obsolete append retry state");
      assert.equal(h.elements.toast.textContent, "");
      assert.equal(h.queries.length, 1);
      h.fireTimer(320);
      await settle();
      assert.equal(h.state.rows.length, 1);
      assert.equal(h.state.rows[0].note_id, "fresh");
    }
  }
});

test("hardening: observer and scroll bursts serialize appends and cannot append a pending filter", async (t) => {
  const h = await harness(t);
  const all = prepareRows(h, 205);
  const pageTwo = deferred();
  h.respondWith((request) => request.page === 2 ? pageTwo.promise : pageResult(request, all));
  Object.assign(h.elements.tableViewport, { scrollTop: 0, clientHeight: 600, scrollHeight: 620 });
  for (let index = 0; index < 30; index += 1) {
    h.intersect();
    await h.elements.tableViewport.emit("scroll");
  }
  assert.deepEqual(h.queries.map((request) => request.page), [2]);
  pageTwo.resolve(pageResult(h.queries[0], all));
  await settle();
  assert.equal(h.state.rows.length, 200);
  assert.equal(new Set(h.state.rows.map((row) => row.note_id)).size, 200);
  await search(h, "pending filter");
  h.intersect();
  await h.elements.tableViewport.emit("scroll");
  assert.equal(h.queries.length, 1, "a scheduled reset must block both append entry points");
});

test("hardening: current append failures retain rows and an explicit retry uses the same page", async (t) => {
  const h = await harness(t);
  const all = prepareRows(h, 105);
  let calls = 0;
  h.respondWith((request) => {
    if (++calls === 1) throw new Error("fixture offline");
    return pageResult(request, all);
  });
  await h.runQuery({ append: true });
  assert.equal(h.state.rows.length, 100);
  assert.equal(h.state.page, 1);
  assert.equal(h.elements.infiniteSentinel.dataset.state, "error");
  await h.elements.infiniteSentinel.click();
  await settle();
  assert.deepEqual(h.queries.map((request) => request.page), [2, 2]);
  assert.equal(h.state.rows.length, 105);
  assert.equal(h.state.hasMore, false);
  assert.equal(h.elements.infiniteSentinel.dataset.state, "done");
});

test("hardening: snapshot invalidation preserves rows/scroll and waits for explicit refresh", async (t) => {
  const h = await harness(t); const all = prepareRows(h, 205);
  h.elements.tableViewport.scrollTop = 410; h.elements.tableViewport.scrollLeft = 180;
  const rows = h.state.rows, nodes = [...h.elements.tableBody.children];
  h.respondWith(() => { throw new Error("快照已变化，请重新校验"); });
  await h.runQuery({append:true}); await settle();
  assert.equal(schemaCalls(h).length,1);assert.equal(h.queries.length,1);
  assert.equal(h.state.rows,rows);assert.deepEqual(h.elements.tableBody.children,nodes);
  assert.equal(h.elements.tableViewport.scrollTop,410);assert.equal(h.elements.tableViewport.scrollLeft,180);
  assert.equal(h.state.snapshotStale,true);assert.equal(h.elements.snapshotNotice.hidden,false);
  for(let i=0;i<10;i++) h.intersect();await settle();assert.equal(h.queries.length,1);
  h.respondWith(request=>pageResult(request,all));
  await h.elements.refreshSnapshot.click();await settle();
  assert.equal(schemaCalls(h).length,2);assert.equal(h.state.snapshotStale,false);
  assert.equal(h.state.rows.length,100);assert.equal(h.elements.snapshotNotice.hidden,true);
});

test("hardening: a null saved view does not erase valid filters or columns for the other dataset", async (t) => {
  const savedView = {
    search: "saved comment search", filterLogic: "or", groupThreads: false,
    filters: [{ id: "filter", field: "content", operator: "contains", value: "saved", value2: "" }],
    sorts: [{ id: "sort", field: "published_at", direction: "asc" }],
  };
  const saved = {
    dataset: "comments", visibleFields: { comments: ["content", "published_at"] },
    columnOrder: { comments: ["content", "published_at", "comment_id"] },
    savedViews: { notes: null, comments: savedView },
  };
  const h = await harness(t, saved);
  assert.equal(h.state.search, savedView.search);
  assert.deepEqual(plain(h.state.filters), savedView.filters);
  assert.deepEqual(plain(h.state.sorts), savedView.sorts);
  assert.equal(h.state.groupThreads, false);
  assert.deepEqual(plain(h.currentVisibleFields()).slice(0, 2), ["content", "published_at"]);
  const reloaded = await harness(t, JSON.parse(h.storage.get(STORAGE_KEY)));
  assert.equal(reloaded.state.search, savedView.search, "schema bootstrap must persist the intact view");
  assert.deepEqual(plain(reloaded.state.filters), savedView.filters);
  for (const malformed of [null, false, 42, "not an object", []]) {
    assert.deepEqual(plain(h.normalizeViewPreferences(malformed)), {
      search: "", semanticSearch: false, filterLogic: "and", filters: [], sorts: [], groupThreads: true,
    });
  }
});

test("hardening: export stays locked during deletion and its snapshot refresh, then recovers", async (t) => {
  for (const failing of [false, true]) {
    const h = await harness(t);
    const all = prepareRows(h);
    const deletion = deferred(), refresh = deferred();
    h.respondDeleteWith(() => deletion.promise);
    h.respondSchemaWith(() => refresh.promise);
    h.respondWith((request) => pageResult(request, all));
    h.openDeleteDialog(["n0"]);
    h.elements.deleteAcknowledgement.checked = true;
    const deleting = h.performPermanentDelete();
    const exportLocked = h.elements.exportCurrent.disabled;
    await h.exportCurrentPage();
    const queriesDuringDelete = h.queries.length;
    if (failing) deletion.reject(new Error("fixture delete failure"));
    else deletion.resolve({ ok: true, deletedCount: 1 });
    await settle();
    await h.exportCurrentPage();
    const queriesDuringRefresh = h.queries.length;
    refresh.resolve(h.schema);
    await deleting;
    assert.equal(queriesDuringDelete, 0, "no export request may race deletion");
    assert.equal(queriesDuringRefresh, 0, "keep export locked until the replacement view is loaded");
    assert.equal(exportLocked, true, "delete entry locks the export button synchronously");
    assert.equal(h.downloads.length, 0);
    assert.equal(deleteCalls(h).length, 1);
    assert.equal(h.state.deletePending, false);
    assert.equal(h.elements.exportCurrent.disabled, false, "both success and failure restore a usable current view");
  }
});

test("hardening: an in-flight export rejects deletion, then releases delete controls on success or failure", async (t) => {
  for (const failing of [false, true]) {
    const h = await harness(t);
    const all = prepareRows(h);
    h.state.selectedIds.add("n0");
    h.updateSelectionUi();
    h.openDeleteDialog(["n0"]);
    h.elements.deleteAcknowledgement.checked = true;
    await h.elements.deleteAcknowledgement.emit("change");
    const exportPage = deferred();
    h.respondWith((request) => request.pageSize === 200 ? exportPage.promise : pageResult(request, all));
    h.respondDeleteWith(() => ({ ok: true, deletedCount: 1 }));
    const exporting = h.exportCurrentPage();
    const deleteLocked = h.elements.deleteSelected.disabled;
    const confirmLocked = h.elements.confirmDelete.disabled;
    await h.elements.deleteAcknowledgement.emit("change");
    const stillLocked = h.elements.confirmDelete.disabled;
    await h.performPermanentDelete(); // Exercise the guard even for a programmatic invocation.
    if (failing) exportPage.reject(new Error("fixture export failure"));
    else exportPage.resolve(pageResult(h.queries[0], all));
    await exporting;
    assert.equal(deleteCalls(h).length, 0, "already-open confirmations cannot race an export");
    assert.equal(deleteLocked, true, "export entry locks delete controls synchronously");
    assert.equal(confirmLocked, true);
    assert.equal(stillLocked, true, "acknowledgement changes cannot unlock a conflicting mutation");
    assert.equal(h.downloads.length, failing ? 0 : 1);
    assert.equal(h.state.exporting, false);
    assert.equal(h.elements.deleteSelected.disabled, false);
    assert.equal(h.elements.confirmDelete.disabled, false);
    await h.performPermanentDelete();
    assert.equal(deleteCalls(h).length, 1, "deletion works after the export finishes");
  }
});

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
  let nextTimer = 0, nextId = 0, queryHandler, schemaHandler, deleteHandler, valuesHandler;
  const observers = [];
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.target = target; }
  }
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
    document, window: Object.assign(new Element("window"), { requestAnimationFrame, cancelAnimationFrame, IntersectionObserver }), Blob,
    Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    IntersectionObserver,
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
      if (message.type === "getDataOverviewSchema") {
        if (!schemaHandler) return callback(schema);
        Promise.resolve().then(() => schemaHandler()).then(callback, (error) => callback({ ok: false, error: error.message }));
        return;
      }
      if (message.type === "getDataOverviewValues") {
        const result = valuesHandler ? valuesHandler(plain(message.payload)) : { ok: true, values: [], snapshotToken: SNAPSHOT };
        Promise.resolve(result).then(callback, error => callback({ ok: false, error: error.message })); return;
      }
      if (message.type === "deleteDataOverviewRecords" && deleteHandler) {
        const request = plain(message.payload);
        Promise.resolve().then(() => deleteHandler(request)).then(callback, (error) => callback({ ok: false, error: error.message }));
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
    state, elements, queryPayload, renderCell, exportCurrentPage,
    currentVisibleFields, orderedDatasetFields, renderTable, renderFieldOptions, renderFilters, renderSorts,
    loadSchema, runQuery, resetCurrentView, scheduleQuery, loadNextBatch,
    openDeleteDialog, performPermanentDelete, updateSelectionUi, normalizeViewPreferences,
    attachValueOptions, getFieldValueOptions, applyQuickView, markSnapshotStale,
    reorderColumn: typeof reorderColumn === "function" ? reorderColumn : undefined,
    resetColumnOrder: typeof resetColumnOrder === "function" ? resetColumnOrder : undefined,
  })`, context);
  await Promise.resolve(); // Finish the one schema-bootstrap continuation; it cannot issue a query.
  assert.equal(api.state.schema, schema, "bootstrap/rendering must finish without a swallowed stub error");
  assert.equal(api.elements.refreshSchema.disabled, false);
  return {
    ...api, schema, document, window: context.window, buttons, storage, downloads, blobs, revoked, queries, messages, timers,
    respondWith(handler) { queryHandler = handler; },
    respondSchemaWith(handler) { schemaHandler = handler; },
    respondDeleteWith(handler) { deleteHandler = handler; },
    respondValuesWith(handler) { valuesHandler = handler; },
    intersect() {
      assert.equal(observers.length, 1, "bootstrap installs one infinite-scroll observer");
      observers[0].callback([{ isIntersecting: true, target: observers[0].target }]);
    },
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


test("filter choices: every filterable type gets visible choices without suggestValues", async t=>{
  const h=await harness(t);
  h.respondValuesWith(()=>({ok:true,values:[{value:0,label:"0",count:3},{value:"<img onerror=evil>",label:"<img onerror=evil>",count:1}]}));
  for(const type of ["text","number","datetime","boolean"]){
    const container=h.document.createElement("div"),input=h.document.createElement("input");
    container.append(input);h.document.body.append(container);
    h.attachValueOptions(container,input,field("choice-"+type,{dataType:type}),"eq","id","value");await settle();
    const select=container.querySelector("select");assert.ok(select);assert.equal(select.disabled,false);
    assert.equal(select.options[1].value,"0");assert.equal(select.options[2].textContent,"<img onerror=evil> · 1 条");
    assert.equal(container.querySelector("img"),null);
    select.value="0";await select.emit("change");assert.equal(input.value,"0");
  }
  assert.equal(h.queries.length,0);
});
test("filter choices: multiple selection appends without duplicates",async t=>{
  const h=await harness(t);h.respondValuesWith(()=>({ok:true,values:[{value:"甲",count:1},{value:"乙",count:2}]}));
  const container=h.document.createElement("div"),input=h.document.createElement("input");input.value="甲";
  container.append(input);h.document.body.append(container);h.attachValueOptions(container,input,field("content"),"in","id","value");await settle();
  const select=container.querySelector("select");select.value="乙";await select.emit("change");select.value="甲";await select.emit("change");
  assert.equal(input.value,"甲, 乙");assert.equal(h.queries.length,0);
});
test("filter choices: search uses independent cached requests and late results stay detached",async t=>{
  const h=await harness(t);const pending=deferred();h.respondValuesWith(()=>pending.promise);
  const container=h.document.createElement("div"),input=h.document.createElement("input");container.append(input);h.document.body.append(container);
  h.attachValueOptions(container,input,field("content"),"eq","id","value");container.remove();
  pending.resolve({ok:true,values:[{value:"late",count:1}]});await settle();assert.equal(container.querySelector("select").options.length,1);
  h.respondValuesWith(()=>({ok:true,values:[]}));
  await h.getFieldValueOptions(field("content"),"rare");await h.getFieldValueOptions(field("content"),"rare");
  assert.equal(h.messages.filter(x=>x.type==="getDataOverviewValues"&&x.payload.search==="rare").length,1);
});
test("filter choices: stale option errors keep table and mark visible update requirement",async t=>{
  const h=await harness(t);prepareRows(h);const rows=h.state.rows,head=h.elements.tableHead.children[0];
  h.respondValuesWith(()=>Promise.reject(new Error("本地数据已变化，请重新校验")));
  const container=h.document.createElement("div"),input=h.document.createElement("input");input.value="draft";
  container.append(input);h.document.body.append(container);h.attachValueOptions(container,input,field("content"),"eq","id","value");await settle();
  assert.equal(h.state.snapshotStale,true);assert.equal(h.state.rows,rows);assert.equal(h.elements.tableHead.children[0],head);
  assert.equal(input.value,"draft");assert.equal(h.elements.snapshotNotice.hidden,false);assert.equal(schemaCalls(h).length,1);
});
test("quick unanalyzed: uses empty conclusion for both datasets and clears prior query context",async t=>{
  const h=await harness(t);
  h.schema.operators.push({id:"is_empty",label:"为空",types:["text"]});
  for(const dataset of ["notes","comments"]){
    h.schema.datasets[dataset].fields.push(field("analysis_is_negative"));h.state.dataset=dataset;
    h.state.search="old query";h.state.semanticSearch=true;h.state.semanticAwaitingSubmit=true;h.state.filterLogic="or";
    h.applyQuickView("unanalyzed");assert.equal(h.state.search,"");assert.equal(h.state.semanticSearch,false);
    assert.equal(h.state.semanticAwaitingSubmit,false);assert.equal(h.state.filterLogic,"and");
    assert.deepEqual(plain(h.state.filters).map(({id,...filter})=>filter),[{field:"analysis_is_negative",operator:"is_empty",value:"",value2:""}]);
  }
});
