"use strict";

// Dependency-free, deliberately narrow DOM fixture. Unsupported selectors
// throw instead of silently passing; mutations are delivered as microtasks.
const assert = require("node:assert/strict");

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    for (const fn of [...this.listeners.get(event.type) || []]) fn.call(this, event);
    return true;
  }
  listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

function simpleMatch(node, selector) {
  let rest = selector.trim();
  if (!rest) throw new Error("Empty fixture selector");
  const tag = rest.match(/^[a-zA-Z][\w-]*/);
  if (tag) {
    if (node.tagName !== tag[0].toUpperCase()) return false;
    rest = rest.slice(tag[0].length);
  }
  while (rest) {
    let token = rest.match(/^\.([\w-]+)/);
    if (token) {
      if (!node.className.split(/\s+/).includes(token[1])) return false;
    } else {
      token = rest.match(/^\[([\w-]+)(?:(\*=|\^=|=)(?:'([^']*)'|"([^"]*)"|([^\]]+)))?\]/);
      if (!token) throw new Error(`Unsupported fixture selector: ${selector}`);
      const value = node.getAttribute(token[1]);
      const expected = token[3] ?? token[4] ?? token[5];
      if (value == null || (token[2] === "=" && value !== expected)
        || (token[2] === "*=" && !value.includes(expected)) || (token[2] === "^=" && !value.startsWith(expected))) return false;
    }
    rest = rest.slice(token[0].length);
  }
  return true;
}

class Node extends Events {
  constructor(h, tag, attrs = {}, children = []) {
    super(); this.h = h; this.nodeType = 1; this.tagName = tag.toUpperCase();
    this.ownerDocument = h.document; this.parentElement = null; this.children = [];
    this.attributes = new Map(); this._text = ""; this.style = {};
    this.scrollTop = 0; this.scrollHeight = 300; this.clientHeight = 300;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: name => { if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim(); },
      remove: name => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(" "); }
    };
    for (const [name, value] of Object.entries(attrs)) this.setAttribute(name, value);
    this.append(...children);
  }
  get className() { return this.getAttribute("class") || ""; }
  set className(value) { this.setAttribute("class", value); }
  get id() { return this.getAttribute("id") || ""; }
  set id(value) { this.setAttribute("id", value); }
  get hidden() { return this.attributes.has("hidden"); }
  set hidden(value) { if (value) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); }
  get disabled() { return this.attributes.has("disabled"); }
  get href() { return this.getAttribute("href") || ""; }
  get src() { return this.getAttribute("src") || ""; }
  get alt() { return this.getAttribute("alt") || ""; }
  get childNodes() { return this.children; }
  get isConnected() { return this === this.h.document.body || Boolean(this.h.document.body?.contains(this)); }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); this.h.mutation(this, "characterData"); }
  get innerText() { return this.textContent; }
  set innerText(value) { this.textContent = value; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); this.h.mutation(this, "attributes", name); }
  removeAttribute(name) { this.attributes.delete(name); this.h.mutation(this, "attributes", name); }
  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === "string") { this._text += node; continue; }
      if (node.parentElement) node.remove();
      node.parentElement = this; this.children.push(node);
    }
    this.h.mutation(this, "childList");
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = []; this._text = ""; this.append(...nodes);
  }
  remove() {
    const parent = this.parentElement;
    if (parent) {
      parent.children = parent.children.filter(node => node !== this);
      this.parentElement = null; this.h.mutation(parent, "childList");
    }
  }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  matches(selector) { return selector.split(",").some(part => simpleMatch(this, part)); }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    this.h.selectors.push(selector);
    const found = [];
    function visit(node) {
      for (const child of node.children) { if (child.matches(selector)) found.push(child); visit(child); }
    }
    visit(this); return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getClientRects() {
    for (let node = this; node; node = node.parentElement) {
      if (node.hidden || node.getAttribute("aria-hidden") === "true" || node.style.display === "none"
        || /hidden|collapse/.test(node.style.visibility || "")) return [];
    }
    return this.isConnected ? [{ width: 400, height: 100 }] : [];
  }
  scrollIntoView(options) {
    this.h.actions.push({ kind: "center", node: this, options, at: this.h.time });
    this.onCenter?.();
  }
  scrollTo(options) {
    this.scrollTop = options.top;
    this.h.actions.push({ kind: "scroll", node: this, options, at: this.h.time });
  }
  click() {
    this.h.actions.push({ kind: "click", node: this, at: this.h.time });
    const event = { type: "click", bubbles: true };
    for (let node = this; node; node = node.parentElement) node.dispatchEvent(event);
  }
}

function fixture() {
  const h = { time: 0, timers: new Map(), scheduled: [], observers: new Set(), selectors: [], actions: [], nextTimer: 0 };
  const view = new Events();
  h.view = view;
  h.document = { nodeType: 9, defaultView: view, baseURI: "https://www.xiaohongshu.com/explore/note-fixture" };
  h.mutation = (target, type, attributeName) => {
    for (const observer of h.observers) {
      if (!observer.root || !observer.root.contains(target) || !observer.options[type]) continue;
      if (type === "attributes" && observer.options.attributeFilter && !observer.options.attributeFilter.includes(attributeName)) continue;
      observer.records.push({ target, type, attributeName });
      if (!observer.queued) {
        observer.queued = true;
        queueMicrotask(() => {
          observer.queued = false;
          const records = observer.takeRecords();
          if (observer.root && records.length) observer.fn(records);
        });
      }
    }
  };
  view.MutationObserver = class {
    constructor(fn) { this.fn = fn; this.root = null; this.records = []; this.queued = false; }
    observe(root, options) { this.root = root; this.options = options; h.observers.add(this); }
    takeRecords() { const records = this.records; this.records = []; return records; }
    disconnect() { this.root = null; this.records = []; h.observers.delete(this); }
  };
  view.setTimeout = (fn, ms) => {
    const job = { id: ++h.nextTimer, at: h.time + Math.max(0, ms), ms, fn };
    h.timers.set(job.id, job); h.scheduled.push(job); return job.id;
  };
  view.clearTimeout = id => h.timers.delete(id);
  view.performance = { now: () => h.time };
  view.location = { href: h.document.baseURI };
  view.getComputedStyle = node => ({ visibility: "visible", display: "block", position: "static", overflowY: "visible", ...node.style });
  view.Event = class { constructor(type) { this.type = type; } };
  h.el = (tag = "div", attrs = {}, children = []) => new Node(h, tag, attrs, children);
  h.document.body = h.el("body");
  h.root = h.el("section", { "data-note-id": "note-fixture" });
  h.scope = h.el("div", { class: "comments-container" });
  h.scope.style.overflowY = "auto";
  h.root.append(h.scope); h.document.body.append(h.root);
  h.row = (id, content = "完整评论", options = {}) => {
    const attributes = { class: `comment-item${options.reply ? " comment-item-sub" : ""}`, ...options.attrs };
    if (id != null) attributes[options.idAttribute || "data-comment-id"] = id;
    const node = h.el("div", attributes);
    node.parts = {
      author: h.el("a", { class: "name", href: "https://www.xiaohongshu.com/user/profile/author-fixture" }, [options.author ?? "作者甲"]),
      content: h.el("div", { class: "content" }, [content]),
      date: h.el("div", { class: "date" }, [options.publishedAt ?? "昨天 12:00"])
    };
    node.append(node.parts.author, node.parts.content, ...options.images || [], node.parts.date);
    return node;
  };
  h.thread = (id, children = []) => h.el("div", { class: "parent-comment", ...(id == null ? {} : { id }) }, children);
  h.button = (label = "加载更多评论", attrs = {}, fn) => {
    const node = h.el("button", attrs, [label]); if (fn) node.addEventListener("click", fn); return node;
  };
  h.image = (url, attrs = {}) => h.el("img", { src: url, ...attrs });
  h.flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  h.advance = async ms => {
    const end = h.time + ms;
    await h.flush();
    let turns = 0;
    while (true) {
      const job = [...h.timers.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!job || job.at > end) break;
      assert.ok(turns++ < 10000, "Fixture timer livelock");
      h.time = job.at; h.timers.delete(job.id); job.fn(); await h.flush();
    }
    h.time = end; await h.flush();
  };
  h.assertIdle = () => {
    assert.equal(h.observers.size, 0, "Observers disconnected");
    assert.equal(h.timers.size, 0, "All timers cleared");
    assert.equal(view.listenerCount(), 0, "Navigation listeners removed");
  };
  h.abortController = () => {
    const signal = new Events(); signal.aborted = false;
    return { signal, abort() { signal.aborted = true; signal.dispatchEvent({ type: "abort" }); } };
  };
  return h;
}

module.exports = { fixture };
