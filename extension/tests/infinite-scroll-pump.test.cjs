"use strict";

// Production functions, isolated geometry/RAF/observers and deferred requests.
// No browser, extension API, timers, network, or real data are contacted.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const source = readFileSync(join(__dirname, "../data-overview.js"), "utf8");
const start = source.indexOf("function infiniteLoadPumpState()");
const end = source.indexOf("function clearFindMarks()", start);
assert.ok(start > 0 && end > start);

function target(props = {}) {
  const events = new Map();
  return Object.assign({ hidden: false, dataset: {},
    addEventListener(type, fn) { const list = events.get(type) || []; list.push(fn); events.set(type, list); },
    emit(type) { for (const fn of events.get(type) || []) fn({ type }); },
    listeners(type) { return (events.get(type) || []).length; }
  }, props);
}

function harness({ observers = true } = {}) {
  const h = { frames: new Map(), calls: [], requests: [], io: [], ro: [], draftProblem: "", popoverCloses: 0 };
  let frameId = 0;
  h.rect = { top: 100, bottom: 500, height: 400, width: 800 };
  h.state = { dataset: "notes", snapshotToken: "synthetic-snapshot", querySerial: 1, page: 1,
    rows: [{ note_id: "fixture" }], hasMore: true, queryReady: true, loading: false,
    snapshotStale: false, resetScheduled: false, queryPending: false, semanticAwaitingSubmit: false };
  h.elements = { tableViewport: target({ clientHeight: 400, clientTop: 0, scrollTop: 400, scrollHeight: 810,
      getBoundingClientRect: () => h.rect }),
    infiniteSentinel: target({ dataset: { state: "idle" } }), tableBody: target(),
    columnFilterPopover: target({ hidden: true }) };
  const window = target({ innerHeight: 800,
    requestAnimationFrame(fn) { const id = ++frameId; h.frames.set(id, fn); return id; } });
  const document = target({ visibilityState: "visible", documentElement: { clientHeight: 800 } });
  class IO {
    constructor(callback, options) { this.callback = callback; this.options = options; this.targets = []; h.io.push(this); }
    observe(node) { this.targets.push(node); }
    fire(isIntersecting = true, intersectionRatio = 0.00001) { this.callback([{ isIntersecting, intersectionRatio }]); }
  }
  class RO {
    constructor(callback) { this.callback = callback; this.targets = []; h.ro.push(this); }
    observe(node) { this.targets.push(node); }
    fire() { this.callback([]); }
  }
  if (observers) Object.assign(window, { IntersectionObserver: IO, ResizeObserver: RO });
  h.context = vm.createContext({ state: h.state, elements: h.elements, window, document,
    IntersectionObserver: IO, ResizeObserver: RO, columnDrag: null, columnLayoutFrame: 0, columnFilterDraft: null,
    filterDraftProblem: () => h.draftProblem,
    closeColumnFilterPopover: () => { h.popoverCloses++; h.elements.columnFilterPopover.hidden = true; },
    runQuery(options) {
      h.calls.push(options); h.state.loading = true; h.state.querySerial++;
      h.elements.infiniteSentinel.dataset.state = "loading";
      return new Promise((resolve, reject) => h.requests.push({ resolve, reject }));
    } });
  vm.runInContext(source.slice(start, end), h.context);
  h.schedule = () => h.context.scheduleInfiniteLoadCheck();
  h.frame = () => { const work = [...h.frames.values()]; h.frames.clear(); for (const fn of work) fn(); };
  h.idle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  h.finish = async ({ error = false, reject = false, more = true, progress = true } = {}) => {
    const request = h.requests.shift(); assert.ok(request, "A request must be pending");
    h.state.loading = false;
    h.elements.infiniteSentinel.dataset.state = error ? "error" : "idle";
    if (!error && !reject && progress) { h.state.page++; h.state.rows.push({ note_id: "fixture-" + h.state.page }); }
    h.state.hasMore = more;
    if (reject) request.reject(new Error("Synthetic rejection")); else request.resolve();
    await h.idle();
  };
  h.init = () => h.context.initializeInfiniteScroll();
  return h;
}

test("RAF coalesces IO/scroll/resize bursts and only one append can be in flight", async () => {
  const h = harness(); h.init();
  for (let i = 0; i < 100; i++) { h.io[0].fire(); h.ro[0].fire(); h.elements.tableViewport.emit("scroll"); }
  assert.equal(h.frames.size, 1); assert.equal(h.calls.length, 0);
  h.frame(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].append, true);
  for (let i = 0; i < 10; i++) { h.schedule(); h.frame(); }
  assert.equal(h.calls.length, 1); assert.equal(h.frames.size, 0);
  await h.finish({ more: false }); h.frame(); assert.equal(h.calls.length, 1);
});

test("wide sentinel uses threshold zero; IO is only a hint and geometry is rechecked", () => {
  const h = harness(); h.init();
  assert.equal(h.io[0].options.threshold, 0);
  assert.equal(h.io[0].options.rootMargin, "0px 0px 2400px 0px");
  assert.equal(h.io[0].options.root, h.elements.tableViewport);
  assert.deepEqual(h.io[0].targets, [h.elements.infiniteSentinel]);
  h.elements.tableViewport.scrollHeight = 5000;
  h.io[0].fire(true, 0.000001); h.frame(); assert.equal(h.calls.length, 0);
  h.elements.tableViewport.scrollHeight = 810;
  h.io[0].fire(true, 0.000001); h.frame(); assert.equal(h.calls.length, 1);
});

test("zero-height, hidden and offscreen viewports never auto-fetch", () => {
  const changes = [
    h => { h.elements.tableViewport.clientHeight = 0; },
    h => { h.rect.height = 0; },
    h => { h.rect = { top: 800, bottom: 1200, height: 400 }; },
    h => { h.rect = { top: -500, bottom: -100, height: 400 }; },
    h => { h.elements.tableViewport.hidden = true; },
    h => { h.elements.infiniteSentinel.hidden = true; },
    h => { h.context.document.visibilityState = "hidden"; },
    h => { h.elements.tableViewport.scrollHeight = NaN; }
  ];
  for (const change of changes) { const h = harness(); change(h); h.schedule(); h.frame(); assert.equal(h.calls.length, 0); assert.equal(h.frames.size, 0); }
});

test("clipped lower viewport does not mistake invisible bottom for visible bottom", () => {
  const h = harness();
  h.elements.tableViewport.scrollHeight = 1810;
  h.rect = { top: 700, bottom: 1100, height: 400 };
  h.schedule(); h.frame(); assert.equal(h.calls.length, 0);
  h.rect = { top: 500, bottom: 900, height: 400 };
  h.schedule(); h.frame(); assert.equal(h.calls.length, 1);
});

test("prefetch starts one to two screens ahead with a bounded 1200–2400px budget", () => {
  for (const [height, limit] of [[400, 1200], [800, 1600], [1200, 2400], [2000, 2400]]) {
    const h = harness();
    h.context.window.innerHeight = height + 200;
    h.rect = { top: 100, bottom: height + 100, height };
    h.elements.tableViewport.clientHeight = height;
    h.elements.tableViewport.scrollHeight = h.elements.tableViewport.scrollTop + height + limit;
    h.schedule(); h.frame(); assert.equal(h.calls.length, 0, `boundary ${height}`);
    h.elements.tableViewport.scrollHeight--;
    h.schedule(); h.frame(); assert.equal(h.calls.length, 1, `prefetch ${height}`);
  }
});

test("near-bottom intent rearms after loading, layout or drag without a new IO event", () => {
  for (const busy of ["loading", "columnLayoutFrame", "columnDrag"]) {
    const h = harness();
    const holder = busy === "loading" ? h.state : h.context;
    holder[busy] = true;
    h.schedule(); h.frame(); assert.equal(h.calls.length, 0); assert.equal(h.frames.size, 1);
    holder[busy] = false;
    h.frame(); assert.equal(h.calls.length, 1);
  }
});

test("busy-time transient bottom geometry is re-evaluated before fetching", () => {
  const h = harness(); h.context.columnLayoutFrame = 1;
  h.schedule(); h.frame();
  h.context.columnLayoutFrame = 0; h.elements.tableViewport.scrollHeight = 9000;
  h.frame(); assert.equal(h.calls.length, 0); assert.equal(h.frames.size, 0);
});

test("settlement pumps successive underfilled pages until full or exhausted", async () => {
  const h = harness(); h.schedule(); h.frame();
  await h.finish(); assert.equal(h.frames.size, 1); h.frame(); assert.equal(h.calls.length, 2);
  await h.finish(); h.elements.tableViewport.scrollHeight = 5000;
  h.frame(); assert.equal(h.calls.length, 2);
  h.elements.tableViewport.scrollHeight = 810; h.schedule(); h.frame(); assert.equal(h.calls.length, 3);
  await h.finish({ more: false }); h.frame(); assert.equal(h.calls.length, 3); assert.equal(h.frames.size, 0);
});

test("error latches across auto events and incidental idle rendering; click explicitly retries", async () => {
  for (const reject of [false, true]) {
    const h = harness(); h.init(); h.frame(); await h.finish({ error: !reject, reject });
    h.elements.infiniteSentinel.dataset.state = "idle";
    for (let i = 0; i < 10; i++) { h.io[0].fire(); h.ro[0].fire(); h.frame(); }
    assert.equal(h.calls.length, 1); assert.equal(h.frames.size, 0);
    h.elements.infiniteSentinel.emit("click"); assert.equal(h.calls.length, 2);
    await h.finish({ more: false }); h.frame(); assert.equal(h.calls.length, 2);
  }
});

test("new successful query scope rearms a previous failed append", async () => {
  const h = harness(); h.schedule(); h.frame(); await h.finish({ error: true });
  h.state.querySerial++; h.elements.infiniteSentinel.dataset.state = "idle";
  // Integration hook owned by runQuery's caller, without editing runQuery here.
  h.schedule(); h.frame(); assert.equal(h.calls.length, 2);
});

test("synchronous unexpected query failure also stops auto retries", () => {
  const h = harness(); let attempts = 0;
  h.context.runQuery = () => { attempts++; throw new Error("Synthetic synchronous failure"); };
  h.schedule(); h.frame();
  for (let i = 0; i < 10; i++) { h.schedule(); h.frame(); }
  assert.equal(attempts, 1);
  assert.equal(h.context.infiniteLoadPumpState().request, null);
  h.context.loadNextBatch(); assert.equal(attempts, 2);
});

test("a superseded rejected request does not poison a newer successful scope", async () => {
  const h = harness(); h.schedule(); h.frame();
  h.state.querySerial++; h.state.page = 10;
  await h.finish({ reject: true, progress: false });
  h.schedule(); h.frame(); assert.equal(h.calls.length, 2);
});

test("all data guards block both auto checks and explicit retry", () => {
  const changes = [h => { h.state.snapshotStale = true; }, h => { h.state.queryReady = false; },
    h => { h.state.resetScheduled = true; }, h => { h.state.queryPending = true; },
    h => { h.state.semanticAwaitingSubmit = true; }, h => { h.state.hasMore = false; },
    h => { h.state.rows = []; }, h => { h.context.columnFilterDraft = {}; },
    h => { h.draftProblem = "incomplete filter"; }];
  for (const change of changes) {
    const h = harness(); h.init(); change(h); h.frame(); h.elements.infiniteSentinel.emit("click");
    assert.equal(h.calls.length, 0); assert.equal(h.frames.size, 0);
  }
});

test("submitted semantic results can paginate; unsubmitted semantic drafts cannot", () => {
  const h = harness(); h.state.semanticSearch = true;
  h.schedule(); h.frame(); assert.equal(h.calls.length, 1);
});

test("resize and visibility rearm; fallback works without observers; init is idempotent", () => {
  for (const observers of [true, false]) {
    const h = harness({ observers }); h.elements.tableViewport.clientHeight = 0;
    h.init(); h.init(); h.frame(); assert.equal(h.calls.length, 0);
    assert.equal(h.context.window.listeners("resize"), 1);
    assert.equal(h.elements.tableViewport.listeners("scroll"), 1);
    if (observers) assert.deepEqual(h.ro[0].targets, [h.elements.tableViewport, h.elements.tableBody, h.elements.infiniteSentinel]);
    h.elements.tableViewport.clientHeight = 400;
    h.context.window.emit("resize"); h.context.document.emit("visibilitychange");
    h.frame(); assert.equal(h.calls.length, 1);
  }
});

test("ResizeObserver alone rearms after a zero-height viewport becomes visible", () => {
  const h = harness(); h.rect.height = 0;
  h.init(); h.frame(); assert.equal(h.calls.length, 0);
  h.rect.height = 400; h.ro[0].fire(); h.frame(); assert.equal(h.calls.length, 1);
});

test("guarded/no-progress resolution does not self-spin or repeatedly append", async () => {
  const h = harness(); h.schedule(); h.frame(); await h.finish({ progress: false });
  assert.equal(h.frames.size, 0); assert.equal(h.calls.length, 1);
});

test("scroll preserves existing filter-popover close behavior", () => {
  const h = harness(); h.init(); h.elements.columnFilterPopover.hidden = false;
  h.elements.tableViewport.emit("scroll"); assert.equal(h.popoverCloses, 1);
});
