"use strict";

// Node-only, deterministic DOM/event/RAF fixture. No browser, extension APIs,
// network, storage, business records, or globals shared with other test files.
// This models DOM ownership and event propagation, not browser CSS layout.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const modulePath = join(__dirname, "..", "column-widths.js");
const api = require(modulePath);
const { sanitize, defaultWidth, create } = api;

class EventTargetFixture {
  constructor() { this.listeners = new Map(); this.parentNode = null; }
  addEventListener(type, listener, capture = false) {
    const entries = this.listeners.get(type) || [];
    if (!entries.some((entry) => entry.listener === listener && entry.capture === capture)) {
      entries.push({ listener, capture });
    }
    this.listeners.set(type, entries);
  }
  removeEventListener(type, listener, capture = false) {
    this.listeners.set(type, (this.listeners.get(type) || [])
      .filter((entry) => entry.listener !== listener || entry.capture !== capture));
  }
  listenerCount() { return [...this.listeners.values()].reduce((sum, list) => sum + list.length, 0); }
  dispatchEvent(event) {
    event.target = this;
    const path = [this];
    while (path[path.length - 1].parentNode) path.push(path[path.length - 1].parentNode);
    const invoke = (node, capture) => {
      event.currentTarget = node;
      for (const entry of [...(node.listeners.get(event.type) || [])]) {
        if (entry.capture !== capture) continue;
        entry.listener(event);
        if (event.immediateStopped) break;
      }
    };
    for (let i = path.length - 1; i > 0; --i) {
      invoke(path[i], true);
      if (event.propagationStopped) return !event.defaultPrevented;
    }
    invoke(this, true);
    if (!event.immediateStopped) invoke(this, false);
    if (event.bubbles && !event.propagationStopped) {
      for (const node of path.slice(1)) {
        invoke(node, false);
        if (event.propagationStopped) break;
      }
    }
    return !event.defaultPrevented;
  }
}

function dispatch(target, type, values = {}) {
  const event = { type, bubbles: true, cancelable: true, detail: 1,
    button: 0, pointerId: 1, isPrimary: true,
    defaultPrevented: false, propagationStopped: false, immediateStopped: false,
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.immediateStopped = true; this.propagationStopped = true; },
    ...values };
  target.dispatchEvent(event);
  return event;
}

class StyleFixture {
  constructor() { this.values = new Map(); this.writes = []; }
  setProperty(name, value, priority = "") {
    this.values.set(name, [String(value), priority]);
    this.writes.push([name, String(value)]);
  }
  getPropertyValue(name) { return this.values.get(name)?.[0] || ""; }
  getPropertyPriority(name) { return this.values.get(name)?.[1] || ""; }
  removeProperty(name) {
    const previous = this.getPropertyValue(name);
    this.values.delete(name);
    return previous;
  }
  get width() { return this.getPropertyValue("width"); }
}

class ElementFixture extends EventTargetFixture {
  constructor(tag, document) {
    super();
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = new StyleFixture();
    this.className = "";
    this.scrollLeft = 0;
    this.scrollTop = 0;
    this.mutations = 0;
    this.captured = new Set();
    this.captureRequests = [];
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (name) => { if (!this.classList.contains(name)) this.className = (this.className + " " + name).trim(); },
      remove: (name) => { this.className = this.className.split(/\s+/).filter((item) => item !== name).join(" "); },
    };
  }
  get childNodes() { return this.children; }
  get parentElement() { return this.parentNode instanceof ElementFixture ? this.parentNode : null; }
  get nextSibling() {
    if (!this.parentNode?.children) return null;
    return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null;
  }
  get draggable() { return this.getAttribute("draggable") === "true"; }
  set draggable(value) { this.setAttribute("draggable", String(value)); }
  getAttribute(name) {
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return Object.hasOwn(this.dataset, key) ? this.dataset[key] : null;
    }
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  setAttribute(name, value) {
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = String(value);
    } else this.attributes.set(name, String(value));
  }
  removeAttribute(name) {
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      delete this.dataset[key];
    } else this.attributes.delete(name);
  }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, anchor) {
    if (node === anchor) return node;
    node.remove();
    const index = anchor === null ? this.children.length : this.children.indexOf(anchor);
    assert.ok(index >= 0, "insertBefore anchor is a child");
    this.children.splice(index, 0, node);
    node.parentNode = this;
    this.mutations++;
    return node;
  }
  remove() {
    if (!this.parentNode?.children) return;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode.mutations++;
    this.parentNode = null;
  }
  replaceChildren(...nodes) {
    for (const child of [...this.children]) child.remove();
    this.append(...nodes);
    this.mutations++;
  }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  matches(selector) {
    const parts = /^([a-z]+)?(?:\.([\w-]+))?(?:\[([\w-]+)\])?$/i.exec(selector);
    assert.ok(parts, "fixture explicitly supports selector: " + selector);
    return (!parts[1] || this.tagName === parts[1].toUpperCase())
      && (!parts[2] || this.classList.contains(parts[2]))
      && (!parts[3] || this.getAttribute(parts[3]) !== null);
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) =>
      [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    if (this.matches(selector)) return this;
    return this.parentElement?.closest(selector) || null;
  }
  focus(options) {
    if (this.ownerDocument.activeElement === this) return;
    const previous = this.ownerDocument.activeElement;
    this.ownerDocument.activeElement = this;
    this.focusOptions = options;
    if (previous) dispatch(previous, "blur", { bubbles: false });
  }
  setPointerCapture(id) { this.captureRequests.push(id); this.captured.add(id); }
  releasePointerCapture(id) {
    if (this.captured.delete(id)) dispatch(this, "lostpointercapture", { pointerId: id });
  }
}

class WindowFixture extends EventTargetFixture {
  constructor() {
    super();
    this.frames = new Map();
    this.nextFrame = 0; // Zero is a valid token; truthy checks would leak it.
    this.cancelledFrames = [];
  }
  requestAnimationFrame(callback) {
    const id = this.nextFrame++;
    this.frames.set(id, callback);
    return id;
  }
  cancelAnimationFrame(id) { this.cancelledFrames.push(id); this.frames.delete(id); }
  flush() {
    const frames = [...this.frames.values()];
    this.frames.clear();
    for (const callback of frames) callback(0);
  }
}

const FIELDS = [
  { key: "note_id", label: "笔记 ID", dataType: "text" },
  { key: "content", label: "正文", dataType: "text" },
  { key: "media_preview", label: "图片预览", dataType: "text", action: "preview_media" },
];

function fixture(options = {}) {
  const window = new WindowFixture();
  const document = new EventTargetFixture();
  document.defaultView = window;
  document.parentNode = window;
  document.activeElement = null;
  document.createElement = (tag) => new ElementFixture(tag, document);
  const viewport = document.createElement("div");
  viewport.parentNode = document;
  const table = document.createElement("table");
  viewport.append(table);
  const caption = document.createElement("caption");
  const thead = document.createElement("thead");
  const head = document.createElement("tr");
  thead.append(head);
  const body = document.createElement("tbody");
  const bodyRow = document.createElement("tr");
  const bodyCell = document.createElement("td");
  const bodyChild = document.createElement("span");
  bodyCell.append(bodyChild);
  bodyRow.append(bodyCell);
  body.append(bodyRow);
  table.append(caption, thead, body);
  const state = { fields: options.fields || FIELDS.map((field) => ({ ...field })), saved: options.saved || {} };
  const commits = [], activity = [], hints = [];
  const reads = { fields: 0, widths: 0 };
  function renderHeaders() {
    head.replaceChildren();
    head.append(document.createElement("th"), document.createElement("th"));
    for (const field of state.fields) {
      const th = document.createElement("th");
      th.dataset.field = field.key;
      th.draggable = true;
      const grip = document.createElement("button");
      grip.className = "column-grip";
      grip.draggable = true;
      th.append(grip);
      head.append(th);
    }
  }
  renderHeaders();
  const f = { window, document, viewport, table, caption, thead, head, body, bodyRow, bodyCell, bodyChild,
    state, commits, activity, hints, reads, renderHeaders };
  options.beforeCreate?.(f);
  f.controller = create({ table, head, viewport,
    getFields() { ++reads.fields; return state.fields; },
    getWidths() { ++reads.widths; return state.saved; },
    onCommit(next) {
      commits.push(next);
      options.onCommit?.(next, f);
      if (options.persist !== false) state.saved = next;
    },
    onActiveChange(value) { activity.push(value); options.onActiveChange?.(value, f); },
    onHint(value) { hints.push(value); options.onHint?.(value, f); },
  });
  f.header = (key = "content") => head.querySelectorAll("th[data-field]").find((th) => th.dataset.field === key);
  f.handle = (key = "content") => f.header(key)?.querySelector("button.column-resize-handle");
  f.group = () => table.children.find((node) => node.tagName === "COLGROUP");
  f.col = (key) => f.group().children.find((col) => col.dataset.field === key);
  f.width = (key = "content") => Number.parseInt(f.col(key).style.width, 10);
  f.down = (x = 100, key = "content", extra = {}) => dispatch(f.handle(key), "pointerdown", { clientX: x, ...extra });
  f.move = (x, extra = {}) => dispatch(window, "pointermove", { clientX: x, ...extra });
  f.up = (x, extra = {}) => dispatch(window, "pointerup", { clientX: x, ...extra });
  f.key = (key, extra = {}, field = "content") => dispatch(f.handle(field), "keydown", { key, ...extra });
  f.assertIdle = () => {
    assert.equal(window.frames.size, 0);
    assert.equal(window.listenerCount(), 0, "transient global listeners are removed");
    assert.equal(viewport.listenerCount(), 0, "transient scroll listener is removed");
    assert.equal(viewport.classList.contains("is-column-resizing"), false);
    for (const th of head.querySelectorAll("th[data-field]")) {
      assert.equal(th.classList.contains("is-column-resizing"), false);
      assert.equal(th.draggable, true);
      assert.equal(th.querySelector(".column-grip").draggable, true);
      const handle = th.querySelector(".column-resize-handle");
      if (handle) assert.equal(handle.captured.size, 0);
    }
  };
  return f;
}

test("UMD exports a frozen API without requiring DOM or polluting CommonJS globals", () => {
  assert.deepEqual(Object.keys(api), ["sanitize", "defaultWidth", "create"]);
  assert.ok(Object.isFrozen(api));
  assert.equal(globalThis.XhsMonitorColumnWidths, undefined);
  const sandbox = {};
  vm.runInNewContext(readFileSync(modulePath, "utf8"), sandbox, { filename: modulePath });
  assert.equal(typeof sandbox.XhsMonitorColumnWidths.create, "function");
  assert.ok(Object.isFrozen(sandbox.XhsMonitorColumnWidths));
});

test("sanitize clamps and rounds finite numbers and unambiguous decimal strings", () => {
  const saved = Object.freeze({ low: -50, zero: 0, min: 72, max: 1200, high: 1500,
    decimal: 199.6, string: " 240 ", exponent: "4.2e2", fractional: "+.5", negative: "-9" });
  const result = sanitize(saved);
  assert.deepEqual(result, { low: 72, zero: 72, min: 72, max: 1200, high: 1200,
    decimal: 200, string: 240, exponent: 420, fractional: 72, negative: 72 });
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  result.string = 100;
  assert.equal(saved.string, " 240 ");
});

test("sanitize rejects coercions, NaN, infinities, units, arrays, and invalid containers", () => {
  const bad = [null, undefined, true, false, NaN, Infinity, -Infinity, "", " ", "NaN", "Infinity",
    "0x100", "0b1010", "220px", "1_000", "1e309", {}, [], [240], new Number(240), 240n, Symbol("width")];
  assert.deepEqual(sanitize(Object.fromEntries(bad.map((value, index) => ["bad_" + index, value]))), {});
  for (const value of [null, undefined, true, false, 240, "240", ["240"], () => 240]) {
    assert.deepEqual(sanitize(value), {});
  }
});

test("sanitize blocks prototype names, inherited values, accessors, and control keys", () => {
  const saved = Object.create({ inherited: 500 });
  saved.valid = 250;
  for (const key of ["__proto__", "prototype", ...Object.getOwnPropertyNames(Object.prototype)]) {
    Object.defineProperty(saved, key, { enumerable: true, value: 900, configurable: true });
  }
  Object.defineProperty(saved, "getter", { enumerable: true, get() { throw new Error("must not execute"); } });
  Object.assign(saved, { "": 100, "   ": 100, ["x".repeat(161)]: 100, ["\u0000bad"]: 100, ["bad\nkey"]: 100 });
  saved[Symbol("private")] = 300;
  assert.deepEqual(sanitize(saved), { valid: 250 });
  assert.equal({}.polluted, undefined);
  const nullPrototype = Object.assign(Object.create(null), { valid: 300 });
  assert.deepEqual(sanitize(nullPrototype), { valid: 300 });
});

test("sanitize accepts bounded ordinary Unicode keys without silently truncating hidden preferences", () => {
  const longest = "x".repeat(160);
  assert.deepEqual(sanitize({ [longest]: 240, "评论·正文": 420, "post__source_published_at": 180 }),
    { [longest]: 240, "评论·正文": 420, "post__source_published_at": 180 });
  const saved = { bad: NaN };
  for (let i = 0; i < 1005; ++i) saved["field_" + i] = 200;
  assert.equal(Object.keys(sanitize(saved)).length, 1005);
  assert.equal(sanitize(saved).field_999, 200);
  assert.equal(sanitize(saved).field_1004, 200);
});

test("defaultWidth covers IDs, long fields, images, titles, paths, actions, and data types", () => {
  for (const key of ["id", "note_id", "comment_id", "parent_comment_id", "post__note_id", "thread_root_id", "image_id"]) {
    assert.equal(defaultWidth({ key, dataType: "text" }), 260, key);
  }
  for (const key of ["content", "thread_root_content", "post__content", "summary", "error", "ai_reason", "raw_json", "notes"]) {
    assert.equal(defaultWidth({ key }), 420, key);
  }
  for (const field of [{ key: "media_preview" }, { key: "x", action: "preview_media" },
    { key: "images" }, { key: "cover" }, { key: "x", dataType: "image" }]) {
    assert.equal(defaultWidth(field), 240);
  }
  for (const [field, width] of [
    [{ key: "title" }, 320], [{ key: "author_url" }, 300], [{ key: "media_dir" }, 300],
    [{ key: "like_count", dataType: "number" }, 120], [{ key: "error_count", dataType: "number" }, 120],
    [{ key: "enabled", dataType: "boolean" }, 100], [{ key: "published_at", dataType: "datetime" }, 180],
    [{ key: "x", type: "json" }, 420], [{ key: "x", label: "正文" }, 420],
    [{ key: "open_material", action: "open_material" }, 160],
    [null, 180], [undefined, 180], [{}, 180], ["note_id", 260],
  ]) assert.equal(defaultWidth(field), width, JSON.stringify(field));
});

test("create validates inputs and callbacks remain optional", () => {
  assert.throws(() => create(), TypeError);
  assert.throws(() => create({ table: {} }), TypeError);
  const f = fixture();
  f.controller.destroy();
  const controller = create({ table: f.table, head: f.head, getFields: () => [], getWidths: () => null });
  controller.sync();
  controller.cancel();
  controller.reset();
  controller.destroy();
});

test("sync fixes two utility columns, pixel total, layout, and CSS opt-in without tbody access", () => {
  const saved = Object.freeze({ note_id: "300", content: 500, hidden: 700 });
  const f = fixture({ saved });
  assert.ok(Object.isFrozen(f.controller));
  assert.deepEqual(Object.keys(f.controller), ["sync", "cancel", "reset", "destroy"]);
  assert.deepEqual(f.group().children.map((col) => col.style.width), ["42px", "42px", "300px", "500px", "240px"]);
  assert.equal(f.table.style.width, "1124px");
  assert.equal(f.table.style.getPropertyValue("table-layout"), "fixed");
  assert.equal(f.table.style.getPropertyValue("min-width"), "0px");
  assert.equal(f.table.style.getPropertyValue("max-width"), "none");
  assert.equal(f.table.dataset.columnWidths, "true");
  assert.deepEqual(f.table.children, [f.caption, f.group(), f.thead, f.body]);
  assert.equal(f.body.children[0], f.bodyRow);
  assert.equal(f.bodyCell.children[0], f.bodyChild);
  assert.equal(f.body.mutations, 1);
  assert.equal(f.bodyRow.mutations, 1);
  assert.equal(f.bodyCell.mutations, 1);
  assert.equal(f.commits.length, 0);
  assert.equal(f.state.saved, saved);
});

test("handles are focusable, labeled vertical separators with current ARIA values", () => {
  const f = fixture();
  const handle = f.handle();
  assert.equal(handle.type, "button");
  assert.equal(handle.tabIndex, 0);
  assert.equal(handle.draggable, false);
  assert.equal(handle.getAttribute("role"), "separator");
  assert.equal(handle.getAttribute("aria-orientation"), "vertical");
  assert.equal(handle.getAttribute("aria-valuemin"), "72");
  assert.equal(handle.getAttribute("aria-valuemax"), "1200");
  assert.equal(handle.getAttribute("aria-valuenow"), "420");
  assert.match(handle.getAttribute("aria-valuetext"), /420/);
  assert.match(handle.getAttribute("aria-label"), /正文/);
  assert.equal(handle.style.getPropertyValue("touch-action"), "none");
  assert.match(handle.getAttribute("aria-keyshortcuts"), /Shift\+ArrowLeft/);
});

test("repeated sync reuses col nodes, keeps focus, and does not duplicate handles or listeners", () => {
  const f = fixture();
  const handle = f.handle(), col = f.col("content"), group = f.group();
  handle.focus();
  const listeners = handle.listenerCount(), headListeners = f.head.listenerCount();
  for (let i = 0; i < 5; ++i) f.controller.sync();
  assert.equal(f.handle(), handle);
  assert.equal(f.col("content"), col);
  assert.equal(f.group(), group);
  assert.equal(f.document.activeElement, handle);
  assert.equal(handle.listenerCount(), listeners);
  assert.equal(f.head.listenerCount(), headListeners);
  assert.equal(f.head.querySelectorAll(".column-resize-handle").length, 3);
  f.key("ArrowRight");
  assert.equal(f.commits.length, 1);
});

test("reorder, hide, and re-add follow getFields order and retain hidden saved widths", () => {
  const f = fixture({ saved: { content: 600, note_id: 290, hidden: 510 } });
  const col = f.col("content"), handle = f.handle();
  f.state.fields.reverse();
  for (const field of f.state.fields) f.head.append(f.header(field.key));
  f.controller.sync();
  assert.deepEqual(f.group().children.slice(2).map((node) => node.dataset.field), ["media_preview", "content", "note_id"]);
  assert.equal(f.col("content"), col);
  assert.equal(f.handle(), handle);
  f.state.fields = f.state.fields.filter((field) => field.key !== "content");
  f.renderHeaders();
  f.controller.sync();
  assert.equal(handle.parentNode, null);
  assert.equal(handle.listenerCount(), 0);
  assert.equal(f.group().children.length, 4);
  f.state.fields.push({ key: "content" });
  f.renderHeaders();
  f.controller.sync();
  assert.equal(f.width(), 600);
  assert.equal(f.state.saved.hidden, 510);
  assert.equal(f.commits.length, 0);
});

test("rerender removes detached listeners and invalid or duplicate schema keys never become handles", () => {
  const f = fixture();
  const old = f.handle();
  f.renderHeaders();
  f.controller.sync();
  assert.equal(old.listenerCount(), 0);
  dispatch(old, "keydown", { key: "ArrowRight" });
  assert.equal(f.commits.length, 0);
  f.state.fields = [{ key: "valid" }, { key: "__proto__" }, { key: "constructor" }, { key: "valid" }, { key: "" }];
  f.renderHeaders();
  f.controller.sync();
  assert.equal(f.group().children.length, 3);
  assert.equal(f.head.querySelectorAll(".column-resize-handle").length, 1);
});

test("pointer capture, native draggable suppression, and active callbacks bracket a transaction", () => {
  const f = fixture();
  const th = f.header(), grip = th.querySelector(".column-grip"), handle = f.handle();
  const event = f.down();
  assert.ok(event.defaultPrevented);
  assert.ok(event.propagationStopped);
  assert.equal(f.document.activeElement, handle);
  assert.deepEqual(handle.focusOptions, { preventScroll: true });
  assert.deepEqual(handle.captureRequests, [1]);
  assert.ok(handle.captured.has(1));
  assert.equal(th.draggable, false);
  assert.equal(grip.draggable, false);
  assert.ok(f.viewport.classList.contains("is-column-resizing"));
  assert.deepEqual(f.activity, [true]);
  f.up(140);
  assert.deepEqual(f.activity, [true, false]);
  assert.equal(f.commits.length, 1);
  assert.equal(f.commits[0].content, 460);
  f.assertIdle();
});

test("pointermoves coalesce per RAF and change only the target col, total width, and ARIA", () => {
  const f = fixture();
  f.down(100);
  const reads = { ...f.reads };
  const groupMutations = f.group().mutations;
  const otherWrites = f.col("note_id").style.writes.length;
  const colWrites = f.col("content").style.writes.length;
  const tableWrites = f.table.style.writes.length;
  const bodyMutations = f.body.mutations;
  for (let x = 101; x <= 140; ++x) f.move(x);
  assert.deepEqual(f.reads, reads, "move handlers do not query getters or touch layout");
  assert.equal(f.window.frames.size, 1);
  assert.equal(f.width(), 420);
  assert.equal(f.commits.length, 0);
  f.window.flush();
  assert.equal(f.width(), 460);
  assert.equal(f.table.style.width, "1044px");
  assert.equal(f.col("content").style.writes.length, colWrites + 1);
  assert.equal(f.table.style.writes.length, tableWrites + 1);
  assert.equal(f.col("note_id").style.writes.length, otherWrites);
  assert.equal(f.group().mutations, groupMutations);
  assert.equal(f.body.mutations, bodyMutations);
  assert.equal(f.handle().getAttribute("aria-valuenow"), "460");
  f.controller.cancel();
});

test("pointerup flushes its final coordinate before the frame and commits exactly once", () => {
  const saved = Object.freeze({ note_id: 300, hidden: 610 });
  const f = fixture({ saved });
  f.down(100);
  f.move(160);
  f.up(175);
  assert.equal(f.width(), 495);
  assert.deepEqual(f.commits, [{ note_id: 300, hidden: 610, content: 495 }]);
  assert.equal(saved.content, undefined);
  assert.ok(f.window.cancelledFrames.includes(0));
  f.up(200);
  f.window.flush();
  assert.equal(f.commits.length, 1);
  f.assertIdle();
});

test("no-motion and move-away-then-back gestures do not persist overrides", () => {
  const f = fixture();
  f.down(100);
  f.up(100);
  f.down(100);
  f.move(130);
  f.window.flush();
  f.up(100);
  assert.equal(f.width(), 420);
  assert.equal(f.commits.length, 0);
  assert.deepEqual(f.activity, [true, false, true, false]);
  f.assertIdle();
});

test("dragging clamps both bounds and ignores nonfinite coordinates or unrelated pointer IDs", () => {
  const f = fixture();
  f.down(100);
  f.move(9999, { pointerId: 2 });
  f.up(9999, { pointerId: 2 });
  f.move(NaN);
  assert.equal(f.window.frames.size, 0);
  dispatch(f.window, "pointercancel", { pointerId: 2 });
  f.move(-9999);
  f.window.flush();
  assert.equal(f.width(), 72);
  f.up(-9999);
  f.down(100);
  f.move(9999);
  f.up(9999);
  assert.equal(f.width(), 1200);
  assert.deepEqual(f.commits.map((saved) => saved.content), [72, 1200]);
  f.assertIdle();
});

test("secondary buttons and non-primary pointers never start or commit resizing", () => {
  const f = fixture();
  for (const extra of [{ button: 1 }, { button: 2 }, { isPrimary: false }, { clientX: NaN }]) {
    assert.ok(f.down(100, "content", extra).defaultPrevented);
  }
  assert.deepEqual(f.activity, []);
  assert.equal(f.commits.length, 0);
  f.assertIdle();
});

test("viewport scroll compensation shares the same RAF and preserves scroll offsets", () => {
  const f = fixture();
  f.viewport.scrollLeft = 20;
  f.viewport.scrollTop = 50;
  f.down(100);
  f.move(120);
  f.viewport.scrollLeft = 50;
  dispatch(f.viewport, "scroll");
  assert.equal(f.window.frames.size, 1);
  f.window.flush();
  assert.equal(f.width(), 470);
  f.up(120);
  assert.equal(f.commits[0].content, 470);
  assert.equal(f.viewport.scrollLeft, 50);
  assert.equal(f.viewport.scrollTop, 50);
  f.assertIdle();
});

for (const [name, abort] of [
  ["cancel()", (f) => f.controller.cancel()],
  ["sync()", (f) => f.controller.sync()],
  ["pointercancel", (f) => dispatch(f.window, "pointercancel")],
  ["Escape", (f) => dispatch(f.window, "keydown", { key: "Escape" })],
  ["window blur", (f) => dispatch(f.window, "blur", { bubbles: false })],
  ["handle blur", (f) => dispatch(f.handle(), "blur", { bubbles: false })],
  ["lostpointercapture", (f) => dispatch(f.handle(), "lostpointercapture")],
]) {
  test(name + " restores saved width without committing and clears frames/capture/listeners", () => {
    const f = fixture({ saved: { content: 510 } });
    const oldHandle = f.handle();
    f.down();
    f.move(180);
    f.window.flush();
    assert.equal(f.width(), 590);
    f.move(200);
    const staleFrame = [...f.window.frames.values()][0];
    abort(f);
    f.up(200);
    staleFrame();
    assert.equal(f.width(), 510);
    assert.equal(f.commits.length, 0);
    assert.deepEqual(f.activity, [true, false]);
    assert.equal(oldHandle.captured.size, 0);
    f.assertIdle();
  });
}

test("sync after a same-schema dataset switch never commits the old dataset into the new one", () => {
  const oldSaved = Object.freeze({ content: 510, only_old: 700 });
  const newSaved = Object.freeze({ content: 300, only_new: 260 });
  const f = fixture({ saved: oldSaved });
  f.down();
  f.move(180);
  f.window.flush();
  f.state.saved = newSaved;
  f.renderHeaders();
  f.controller.sync();
  f.up(200);
  f.window.flush();
  assert.equal(f.width(), 300);
  assert.equal(f.state.saved, newSaved);
  assert.deepEqual(f.commits, []);
  assert.equal(f.state.saved.only_old, undefined);
  f.assertIdle();
});

test("cancel reads the new dataset instead of restoring the old drag snapshot", () => {
  const f = fixture({ saved: { content: 510 } });
  f.down();
  f.move(130);
  f.window.flush();
  f.state.saved = { content: 250 };
  f.controller.cancel();
  assert.equal(f.width(), 250);
  assert.equal(f.commits.length, 0);
  f.assertIdle();
});

for (const [name, change] of [
  ["identity-only same-schema switch", (f) => { f.state.saved = { ...f.state.saved }; }],
  ["in-place saved width change", (f) => { f.state.saved.content = 280; }],
  ["visible field reorder", (f) => { f.state.fields.reverse(); }],
  ["field removal", (f) => { f.state.fields = f.state.fields.filter((field) => field.key !== "media_preview"); }],
  ["detached header", (f) => { f.renderHeaders(); }],
]) {
  test(name + " without sync invalidates a pending transaction before commit", () => {
    const f = fixture({ saved: { content: 510 } });
    f.down();
    f.move(160);
    change(f);
    f.up(180);
    assert.equal(f.commits.length, 0);
    f.assertIdle();
  });
}

test("RAF also checks dataset identity, and stale key/double-click actions are discarded", () => {
  const f = fixture();
  f.down();
  f.move(150);
  f.state.saved = { content: 320 };
  f.window.flush();
  assert.equal(f.width(), 320);
  assert.equal(f.commits.length, 0);
  f.state.saved = { content: 300 };
  f.key("ArrowRight");
  assert.equal(f.width(), 300);
  assert.equal(f.commits.length, 0);
  f.state.saved = { content: 280 };
  dispatch(f.handle(), "dblclick");
  assert.equal(f.width(), 280);
  assert.equal(f.commits.length, 0);
  f.assertIdle();
});

test("keyboard arrows, Shift steps, and Home commit sanitized maps while retaining hidden fields", () => {
  const f = fixture({ saved: { hidden: 620, content: 400 } });
  const expected = [410, 400, 450, 400];
  for (const [index, [key, shiftKey]] of [
    ["ArrowRight", false], ["ArrowLeft", false], ["ArrowRight", true], ["ArrowLeft", true],
  ].entries()) {
    const event = f.key(key, { shiftKey });
    assert.ok(event.defaultPrevented);
    assert.ok(event.propagationStopped);
    assert.equal(f.width(), expected[index]);
    assert.equal(f.commits[index].hidden, 620);
  }
  f.key("Home");
  assert.equal(f.width(), 420);
  assert.deepEqual(f.commits.at(-1), { hidden: 620 });
  assert.deepEqual(f.activity, Array.from({ length: 5 }, () => [true, false]).flat());
  assert.match(f.hints.at(-1), /默认.*420/);
  assert.equal(f.window.frames.size, 0);
});

test("keyboard bounds are no-ops; modifier shortcuts and activation keys never filter or reorder", () => {
  const f = fixture({ saved: { content: 72 } });
  let headerKeys = 0;
  f.head.addEventListener("keydown", () => ++headerKeys);
  f.key("ArrowLeft");
  for (const [key, extra] of [["ArrowRight", { altKey: true }], ["ArrowLeft", { ctrlKey: true }],
    ["Home", { metaKey: true }], ["Enter", {}], [" ", {}]]) f.key(key, extra);
  assert.equal(f.commits.length, 0);
  assert.equal(headerKeys, 0);
  assert.equal(f.key("Tab").defaultPrevented, false);
  f.state.saved.content = 1200;
  f.controller.sync();
  f.key("ArrowRight", { shiftKey: true });
  assert.equal(f.commits.length, 0);
});

test("double-click resets only one column and simple pointer clicks do not add commits", () => {
  const f = fixture({ saved: { content: 700, note_id: 300, hidden: 500 } });
  for (let i = 0; i < 2; ++i) {
    f.down(100);
    f.up(100);
    dispatch(f.handle(), "click");
  }
  assert.equal(f.commits.length, 0);
  const event = dispatch(f.handle(), "dblclick");
  assert.ok(event.defaultPrevented);
  assert.equal(f.width(), 420);
  assert.deepEqual(f.commits, [{ note_id: 300, hidden: 500 }]);
  f.assertIdle();
});

test("resize events never reach existing header handlers; unrelated header clicks still work", () => {
  const f = fixture();
  const counts = {};
  for (const type of ["pointerdown", "mousedown", "click", "dblclick", "dragstart", "keydown"]) {
    counts[type] = 0;
    f.head.addEventListener(type, () => ++counts[type]);
  }
  f.down();
  dispatch(f.handle(), "mousedown");
  dispatch(f.header(), "dragstart");
  dispatch(f.header().querySelector(".column-grip"), "dragstart");
  dispatch(f.handle(), "click");
  f.move(130);
  f.up(130);
  dispatch(f.header(), "click"); // Retargeted compatibility click.
  dispatch(f.handle(), "dblclick");
  f.key("ArrowRight", { altKey: true });
  assert.deepEqual(counts, { pointerdown: 0, mousedown: 0, click: 0, dblclick: 0, dragstart: 0, keydown: 0 });
  dispatch(f.header("note_id"), "pointerdown");
  dispatch(f.header("note_id"), "click");
  assert.equal(counts.click, 1, "new intentional header clicks are not suppressed");
  dispatch(f.header("note_id"), "keydown", { key: "Enter" });
  assert.equal(counts.keydown, 1, "only handle keys are intercepted");
});

test("draggable attributes are restored exactly, including absent and false values", () => {
  const f = fixture();
  const header = f.header();
  const grip = header.querySelector(".column-grip");
  header.removeAttribute("draggable");
  grip.setAttribute("draggable", "false");
  f.down();
  f.controller.cancel();
  assert.equal(header.getAttribute("draggable"), null);
  assert.equal(grip.getAttribute("draggable"), "false");
});

test("reset is display-only, cancels a preview, and sync can reapply caller-owned saved widths", () => {
  const saved = Object.freeze({ content: 700, note_id: 300, hidden: 500 });
  const f = fixture({ saved });
  f.down();
  f.move(180);
  f.window.flush();
  f.controller.reset();
  assert.equal(f.width(), 420);
  assert.equal(f.width("note_id"), 260);
  assert.equal(f.state.saved, saved);
  assert.deepEqual(f.commits, []);
  f.controller.sync();
  assert.equal(f.width(), 700);
  f.assertIdle();
});

test("onActiveChange may synchronously switch dataset and sync without leaking a transaction", () => {
  let once = false;
  const f = fixture({ onActiveChange(value, current) {
    if (value && !once) {
      once = true;
      current.state.saved = { content: 310 };
      current.controller.sync();
    }
  } });
  f.down();
  f.move(150);
  f.up(160);
  assert.equal(f.width(), 310);
  assert.deepEqual(f.activity, [true, false]);
  assert.deepEqual(f.commits, []);
  f.assertIdle();
});

test("commit runs before inactive notification, so a callback switch cannot redirect an old write", () => {
  const f = fixture({ onActiveChange(value, current) {
    if (!value) {
      current.state.saved = { content: 280, new_dataset: 200 };
      current.controller.sync();
    }
  } });
  f.down();
  f.up(140);
  assert.deepEqual(f.commits, [{ content: 460 }]);
  assert.deepEqual(f.state.saved, { content: 280, new_dataset: 200 });
  assert.equal(f.width(), 280);
  f.assertIdle();
});

test("a throwing commit still releases capture/listeners/draggable and emits inactive", () => {
  const f = fixture({ onCommit() { throw new Error("storage rejected"); } });
  f.down();
  f.move(160);
  assert.throws(() => f.up(170), /storage rejected/);
  assert.deepEqual(f.activity, [true, false]);
  f.assertIdle();
  f.controller.cancel();
  assert.equal(f.width(), 420);
});

test("a throwing start hint rolls back without leaving the UI active", () => {
  const f = fixture({ onHint() { throw new Error("hint failed"); } });
  assert.throws(() => f.down(), /hint failed/);
  assert.equal(f.width(), 420);
  assert.deepEqual(f.activity, [true, false]);
  f.assertIdle();
});

test("destroy restores original colgroups, table styles/priorities/marker, and leaves tbody untouched", () => {
  let first, second, originalCol;
  const f = fixture({ beforeCreate(current) {
    first = current.document.createElement("colgroup");
    second = current.document.createElement("colgroup");
    originalCol = current.document.createElement("col");
    originalCol.style.setProperty("width", "90px");
    first.append(originalCol);
    first.setAttribute("span", "3");
    current.table.insertBefore(first, current.thead);
    current.table.insertBefore(second, current.thead);
    current.table.style.setProperty("width", "100%", "important");
    current.table.style.setProperty("min-width", "100%");
    current.table.style.setProperty("table-layout", "auto");
    current.table.style.setProperty("color", "red");
    current.table.dataset.columnWidths = "previous";
  } });
  assert.equal(f.group(), first);
  assert.equal(second.parentNode, null);
  assert.equal(first.getAttribute("span"), null);
  const handle = f.handle();
  f.down();
  f.move(150);
  f.controller.destroy();
  f.controller.destroy();
  f.controller.sync();
  f.controller.cancel();
  f.controller.reset();
  dispatch(handle, "pointerdown", { clientX: 100 });
  f.up(160);
  assert.deepEqual(f.table.children, [f.caption, first, second, f.thead, f.body]);
  assert.deepEqual(first.children, [originalCol]);
  assert.equal(first.getAttribute("span"), "3");
  assert.equal(originalCol.style.width, "90px");
  assert.equal(f.table.style.width, "100%");
  assert.equal(f.table.style.getPropertyPriority("width"), "important");
  assert.equal(f.table.style.getPropertyValue("min-width"), "100%");
  assert.equal(f.table.style.getPropertyValue("table-layout"), "auto");
  assert.equal(f.table.style.getPropertyValue("max-width"), "");
  assert.equal(f.table.style.getPropertyValue("color"), "red");
  assert.equal(f.table.dataset.columnWidths, "previous");
  assert.equal(f.head.querySelectorAll(".column-resize-handle").length, 0);
  assert.equal(f.head.listenerCount(), 0);
  assert.equal(handle.listenerCount(), 0);
  assert.equal(f.body.mutations, 1);
  assert.deepEqual(f.activity, [true, false]);
  assert.equal(f.commits.length, 0);
  f.assertIdle();
});

test("destroy removes only its newly created colgroup and table marker", () => {
  const f = fixture();
  const group = f.group();
  f.controller.destroy();
  assert.equal(group.parentNode, null);
  assert.equal(f.table.getAttribute("data-column-widths"), null);
  assert.equal(f.table.style.width, "");
  assert.deepEqual(f.table.children, [f.caption, f.thead, f.body]);
  assert.deepEqual(f.commits, []);
});

test("cancelled capture clicks are blocked even after the host has replaced the headers", () => {
  const f = fixture();
  let clicks = 0;
  f.head.addEventListener("click", () => ++clicks);
  f.down();
  f.move(150);
  f.renderHeaders();
  f.controller.sync();
  dispatch(f.header(), "click");
  assert.equal(clicks, 0);
  dispatch(f.header(), "pointerdown");
  dispatch(f.header(), "click");
  assert.equal(clicks, 1);
  assert.deepEqual(f.commits, []);
  f.assertIdle();
});

test("a stale RAF cannot clear a newer drag's queued frame or paint its old width", () => {
  const f = fixture();
  f.down();
  f.move(150);
  const stale = [...f.window.frames.values()][0];
  f.controller.cancel();
  f.down();
  f.move(120);
  stale();
  f.move(130);
  assert.equal(f.window.frames.size, 1);
  f.window.flush();
  assert.equal(f.width(), 450);
  f.up(130);
  assert.deepEqual(f.commits, [{ content: 450 }]);
  f.assertIdle();
});

test("capture failure still permits outside-window-target move/up handling and full cleanup", () => {
  const f = fixture();
  f.handle().setPointerCapture = () => { throw new Error("capture target detached"); };
  f.handle().releasePointerCapture = () => { throw new Error("not captured"); };
  assert.doesNotThrow(() => f.down());
  f.move(130);
  f.up(140);
  assert.equal(f.width(), 460);
  assert.deepEqual(f.activity, [true, false]);
  f.assertIdle();
});

test("an additional pointer on a header/grip/handle is isolated while resizing is active", () => {
  const f = fixture();
  let starts = 0;
  f.header("note_id").querySelector(".column-grip").addEventListener("pointerdown", () => ++starts);
  f.down();
  const gripEvent = dispatch(f.header("note_id").querySelector(".column-grip"), "pointerdown",
    { pointerId: 2, clientX: 100 });
  assert.ok(gripEvent.defaultPrevented);
  f.down(120, "note_id", { pointerId: 2 });
  assert.equal(starts, 0);
  assert.deepEqual(f.activity, [true]);
  f.up(140);
  assert.deepEqual(f.commits, [{ content: 460 }]);
  f.assertIdle();
});

test("commits preserve large hidden preference maps and sanitize dangerous saved values", () => {
  const saved = JSON.parse('{"__proto__":800,"constructor":900,"prototype":500,"hidden":"300","bad":"220px"}');
  for (let i = 0; i < 1005; ++i) saved["field_" + i] = 200;
  const f = fixture({ saved });
  f.key("ArrowRight");
  const committed = f.commits[0];
  assert.equal(Object.keys(committed).length, 1007);
  assert.equal(committed.content, 430);
  assert.equal(committed.hidden, 300);
  assert.equal(committed.field_1004, 200);
  for (const key of ["__proto__", "constructor", "prototype", "bad"]) {
    assert.equal(Object.hasOwn(committed, key), false);
  }
  assert.deepEqual(sanitize(committed), committed);
});

test("keyboard preview can repeat before a host persists, without per-move commits", () => {
  const f = fixture({ persist: false });
  f.key("ArrowRight");
  f.key("ArrowRight", { repeat: true });
  assert.deepEqual(f.commits, [{ content: 430 }, { content: 440 }]);
  assert.equal(f.width(), 440);
  assert.deepEqual(f.state.saved, {});
  f.controller.cancel();
  assert.equal(f.width(), 420);
});
