"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { thumbnailCapacity } = require("../overview-media.js");
const source = fs.readFileSync(path.join(__dirname, "../overview-media.js"), "utf8");
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const record = id => ({ dataset: "notes", recordId: id });
const listing = (count, revision = "v1") => ({ ok: true, revision, items: Array.from({ length: count }, (_, index) => ({ source: "local", index })) });
const raster = { ok: true, dataUrl: "data:image/png;base64,aGVsbG8=" };

function harness({ total = 8, width = 240, countWidth = 48, request, intersection = true, resize = true } = {}) {
  const requests = [], intersections = [], resizes = [];
  const document = { activeElement: null };
  class Element {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.listeners = {}; this.hidden = false; this.connected = true;
      this.className = ""; this._text = ""; this.open = false;
      this.classList = {
        add: name => { if (!this.className.split(" ").includes(name)) this.className += ` ${name}`; },
        toggle: (name, enabled) => { this.className = this.className.split(" ").filter(n => n !== name).join(" "); if (enabled) this.classList.add(name); }
      };
    }
    get isConnected() { return this.connected && (!this.parentElement || this.parentElement.isConnected); }
    get clientWidth() { return this.width ?? (this.className === "media-count" ? countWidth : width); }
    get scrollWidth() { return this.clientWidth; }
    getBoundingClientRect() { return { width: this.clientWidth }; }
    set textContent(text) { this._text = text; this.replaceChildren(); }
    get textContent() { return this._text; }
    append(...nodes) { for (const n of nodes) { n.parentElement = this; n.connected = true; this.children.push(n); } }
    replaceChildren(...nodes) { for (const n of this.children) n.connected = false; this.children = []; this.append(...nodes); }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    click() { for (const fn of this.listeners.click || []) fn({ target: this, stopPropagation() {} }); }
    focus(options) { document.activeElement = this; this.focusOptions = options; }
    contains(node) { return this === node || this.children.some(n => n.contains(node)); }
    querySelector(selector) { return this.children.find(n => n.className === selector.slice(1)) || null; }
    showModal() { this.open = true; }
    close() { this.open = false; for (const fn of this.listeners.close || []) fn(); }
  }
  document.createElement = tag => new Element(tag); document.body = new Element("body");
  const observerClass = all => class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); this.disconnected = 0; all.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); this.disconnected++; }
    emit(target, values) { this.callback([{ target, ...values }]); }
  };
  const context = vm.createContext({ URL, document, Promise, Map,
    IntersectionObserver: intersection ? observerClass(intersections) : undefined,
    ResizeObserver: resize ? observerClass(resizes) : undefined
  });
  vm.runInContext(source, context);
  const api = context.XhsMonitorOverviewMedia.create({ request: async args => {
    requests.push(args); return request ? request(args) : args.index === undefined ? listing(total) : raster;
  } });
  const cell = () => { const node = new Element("td"); document.body.append(node); return node; };
  return { api, requests, intersections, resizes, document, cell,
    visible: (node, value = true) => intersections[0].emit(node, { isIntersecting: value }),
    resize: (node, value) => { node.width = value; resizes[0].emit(node, { contentRect: { width: value } }); }
  };
}
const stripOf = cell => cell.children[0];
const thumbsOf = cell => stripOf(cell).children.filter(n => n.className === "media-thumb");
const visibleThumbs = cell => thumbsOf(cell).filter(n => !n.hidden);
const imagesRequested = h => h.requests.filter(r => r.index !== undefined);

test("capacity uses 54px thumbs, 6px gaps and measured count reserve, without a three-image cap", () => {
  assert.equal(thumbnailCapacity(240, 20), 3);
  assert.equal(thumbnailCapacity(400, 20), 5);
  assert.equal(thumbnailCapacity(528, 8), 8);
  assert.equal(thumbnailCapacity(10000, 20), 20);
  assert.equal(thumbnailCapacity(400, 20, 100), 5);
  assert.equal(thumbnailCapacity(400, 20, 40), 6);
  assert.equal(thumbnailCapacity(107.99, 8), 0);
  assert.equal(thumbnailCapacity(108, 8), 1);
  for (const w of [0, -1, NaN, Infinity, undefined]) assert.equal(thumbnailCapacity(w, 8), 0);
  assert.equal(thumbnailCapacity(240, 0), 0);
  assert.equal(thumbnailCapacity(240, 8, -1), 0);
});

test("table first intersection loads only visible thumbnails; resize grows to all without repeat requests", async () => {
  const h = harness(), cell = h.cell(); h.api.mount(cell, record("a"));
  await settle(); assert.equal(h.requests.length, 0);
  h.visible(cell); h.visible(cell); await settle();
  assert.equal(h.requests.filter(r => r.index === undefined).length, 1);
  assert.equal(thumbsOf(cell).length, 8); assert.equal(visibleThumbs(cell).length, 3);
  assert.deepEqual(imagesRequested(h).map(r => r.index), [0, 1, 2]);
  h.resize(stripOf(cell), 400); await settle(); assert.equal(visibleThumbs(cell).length, 5);
  h.resize(stripOf(cell), 528); await settle(); assert.equal(visibleThumbs(cell).length, 8);
  h.resize(stripOf(cell), 240); h.resize(stripOf(cell), 528); await settle();
  assert.equal(imagesRequested(h).length, 8);
});

test("count width changes recompute capacity with the same shared ResizeObserver", async () => {
  const h = harness(), a = h.cell(), b = h.cell();
  h.api.mount(a, record("a"), { eager: true }); h.api.mount(b, record("b"), { eager: true }); await settle();
  assert.equal(h.resizes.length, 1); assert.equal(h.resizes[0].targets.size, 4);
  h.resize(stripOf(a).children.at(-1), 130); await settle();
  assert.equal(visibleThumbs(a).length, 1); assert.equal(visibleThumbs(b).length, 3);
});

test("shrinking transfers thumbnail focus and modal return focus to count, not to hidden content", async () => {
  const h = harness({ width: 528 }), cell = h.cell(); h.api.mount(cell, record("a"), { eager: true }); await settle();
  const last = thumbsOf(cell).at(-1), count = stripOf(cell).children.at(-1);
  last.focus(); last.click(); await settle();
  h.resize(stripOf(cell), 108); await settle();
  assert.equal(h.document.activeElement, count);
  assert.equal(count.focusOptions.preventScroll, true);
  h.api.close(); assert.equal(h.document.activeElement, count);
  assert.equal(count.focusOptions.preventScroll, true);
  count.focus(); h.resize(stripOf(cell), 48); assert.equal(h.document.activeElement, count);
  assert.equal(visibleThumbs(cell).length, 0);
});

test("viewer navigation after shrinking retains the visible count as its return target", async () => {
  const h = harness({ width: 528 }), cell = h.cell(); h.api.mount(cell, record("a"), { eager: true }); await settle();
  thumbsOf(cell)[6].click(); await settle();
  const dialog = h.document.body.children.find(n => n.tagName === "dialog");
  h.resize(stripOf(cell), 108); dialog.children[2].children[1].click(); await settle();
  h.api.close();
  assert.equal(h.document.activeElement, stripOf(cell).children.at(-1));
  assert.equal(h.document.activeElement.focusOptions.preventScroll, true);
});

test("offscreen resize does not load newly exposed thumbnails until intersection", async () => {
  const h = harness(), cell = h.cell(); h.api.mount(cell, record("a")); h.visible(cell); await settle();
  h.visible(cell, false); h.resize(stripOf(cell), 528); await settle(); assert.equal(imagesRequested(h).length, 3);
  h.visible(cell); await settle(); assert.equal(imagesRequested(h).length, 8);
});

test("zero-width strip loads no images until it has enough space", async () => {
  const h = harness({ width: 0 }), cell = h.cell(); h.api.mount(cell, record("a"), { eager: true }); await settle();
  assert.equal(imagesRequested(h).length, 0);
  h.resize(stripOf(cell), 240); await settle(); assert.equal(imagesRequested(h).length, 3);
});

test("detail keeps previewLimit clamping and never observes width", async () => {
  const h = harness({ width: 0, total: 20 }), cell = h.cell();
  h.api.mount(cell, record("a"), { layout: "detail", previewLimit: 6, eager: true }); await settle();
  assert.equal(visibleThumbs(cell).length, 6); assert.equal(imagesRequested(h).length, 6);
  assert.equal(h.resizes[0].targets.size, 0);
  h.api.mount(cell, record("b"), { layout: "detail", previewLimit: 99, eager: true }); await settle();
  assert.equal(visibleThumbs(cell).length, 12);
  h.api.mount(cell, record("c"), { layout: "table", previewLimit: 1, eager: true }); await settle();
  assert.ok(!cell.className.includes("media-detail"));
  h.resize(stripOf(cell), 10000); await settle(); assert.equal(visibleThumbs(cell).length, 20);
});

test("same-cell remount token rejects old metadata and old image completion", async () => {
  const oldMetadata = deferred(), oldImage = deferred();
  const h = harness({ request: args => args.recordId === "old-meta" ? oldMetadata.promise
    : args.recordId === "old-image" && args.index !== undefined ? oldImage.promise
    : args.index === undefined ? listing(1) : raster });
  const cell = h.cell(); h.api.mount(cell, record("old-meta"), { eager: true }); await settle();
  h.api.mount(cell, record("old-image"), { eager: true }); await settle();
  const oldButton = thumbsOf(cell)[0];
  h.api.mount(cell, record("new"), { eager: true }); await settle();
  const currentStrip = stripOf(cell);
  oldMetadata.resolve(listing(8)); oldImage.resolve(raster); await settle();
  assert.equal(stripOf(cell), currentStrip); assert.equal(thumbsOf(cell).length, 1);
  assert.equal(oldButton.children.length, 0);
  assert.equal(h.resizes[0].targets.size, 2);
});

test("reset disconnects shared observers, clears load callbacks and ignores stale completions", async () => {
  const pending = deferred(); const h = harness({ request: args => args.index === undefined ? listing(8) : pending.promise });
  const cell = h.cell(); h.api.mount(cell, record("a"), { eager: true }); await settle();
  const oldStrip = stripOf(cell); h.api.reset();
  assert.equal(h.resizes[0].targets.size, 0); assert.equal(h.intersections[0].targets.size, 0);
  assert.equal(cell._loadMedia, undefined);
  h.resize(oldStrip, 10000); h.visible(cell); pending.resolve(raster); await settle();
  assert.ok(thumbsOf(cell).every(n => n.children.length === 0));
  assert.equal(imagesRequested(h).length, 3);
  h.api.mount(cell, record("b"), { eager: true }); await settle();
  assert.equal(visibleThumbs(cell).length, 3); assert.equal(h.resizes.length, 1);
});

test("queued thumbnails hidden during shrink are deferred and can load on later expansion", async () => {
  const pending = deferred();
  const h = harness({ width: 528, request: args => args.index === undefined ? listing(8) : args.index < 3 ? pending.promise : raster });
  const cell = h.cell(); h.api.mount(cell, record("a"), { eager: true }); await settle();
  assert.equal(imagesRequested(h).length, 3);
  h.resize(stripOf(cell), 108); pending.resolve(raster); await settle(); assert.equal(imagesRequested(h).length, 3);
  h.resize(stripOf(cell), 528); await settle(); assert.equal(imagesRequested(h).length, 8);
});

test("no observer support falls back to measured initial capacity and eager loading", async () => {
  const h = harness({ intersection: false, resize: false }), cell = h.cell(); h.api.mount(cell, record("a")); await settle();
  assert.equal(visibleThumbs(cell).length, 3); assert.equal(imagesRequested(h).length, 3);
});

test("remote thumbnails receive src only when visible and retain their image node across resize", async () => {
  const h = harness({ request: () => ({ ok: true, items: Array.from({ length: 8 }, (_, index) => ({
    source: "remote", index, url: `https://sns-img.xhscdn.com/${index}.jpg`
  })) }) });
  const cell = h.cell(); h.api.mount(cell, record("a"), { eager: true }); await settle();
  assert.ok(thumbsOf(cell).slice(3).every(n => n.children.length === 0));
  const firstImage = thumbsOf(cell)[0].children[0];
  h.resize(stripOf(cell), 528); await settle();
  assert.ok(thumbsOf(cell).every(n => n.children[0].src.startsWith("https://sns-img.xhscdn.com/")));
  h.resize(stripOf(cell), 108); h.resize(stripOf(cell), 528); await settle();
  assert.equal(thumbsOf(cell)[0].children[0], firstImage); assert.equal(h.requests.length, 1);
});

test("in-flight resize never duplicates requests and reset cancels queued stale images", async () => {
  const pending = deferred();
  const h = harness({ width: 528, request: args => args.index === undefined ? listing(8) : pending.promise });
  const cell = h.cell(); h.api.mount(cell, record("a"), { eager: true }); await settle();
  h.resize(stripOf(cell), 108); h.resize(stripOf(cell), 528); await settle();
  assert.equal(imagesRequested(h).length, 3);
  h.api.reset(); pending.resolve(raster); await settle();
  assert.equal(imagesRequested(h).length, 3);
  assert.ok(thumbsOf(cell).every(n => n.children.length === 0));
});

test("reset before metadata resolves leaves the old cell untouched", async () => {
  const pending = deferred(), h = harness({ request: () => pending.promise }), cell = h.cell();
  h.api.mount(cell, record("a"), { eager: true }); await settle(); h.api.reset();
  pending.resolve(listing(8)); await settle();
  assert.equal(cell.textContent, "等待图片…"); assert.equal(cell.children.length, 0);
  assert.equal(h.resizes[0].targets.size, 0);
});

test("metadata failure offers explicit retry without repeating successful metadata or images", async () => {
  let attempts = 0;
  const h = harness({ request: args => args.index !== undefined ? raster : ++attempts === 1 ? Promise.reject(new Error("retry")) : listing(2) });
  const cell = h.cell(); h.api.mount(cell, record("a"), { eager: true }); await settle();
  assert.equal(cell.children[0].textContent, "重新读取图片"); cell.children[0].click(); await settle();
  assert.equal(visibleThumbs(cell).length, 2); assert.equal(attempts, 2);
  h.resize(stripOf(cell), 1000); await settle(); assert.equal(imagesRequested(h).length, 2);
});
