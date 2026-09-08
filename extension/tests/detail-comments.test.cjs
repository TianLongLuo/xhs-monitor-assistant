"use strict";
// In-memory request fixtures only. No bridge, database, browser or network IO.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const details = require("../record-details.js");

const NOTE = "note-a", TOKEN = "snapshot-a";
function options(overrides = {}) {
  return { noteId: NOTE, snapshotToken: TOKEN, ...overrides };
}
function row(index, fields) {
  const values = {
    comment_id: `comment-${index}`, note_id: NOTE, content: `原文-${index}`,
    author: `作者-${index}`, author_url: "", published_at: "2026-09-08 12:00:00",
    published_at_status: "exact", ip_location: "四川", like_count: 0, reply_count: 0,
    comment_level: index === 1 ? 2 : 1, comment_type: index === 1 ? "子评论" : "主评论",
    parent_comment_id: index === 1 ? "comment-0" : "",
    thread_root_id: index === 1 ? "comment-0" : `comment-${index}`,
    thread_root_author: "原作者", thread_root_content: "一级评论原文",
    comment_status: index % 2 ? "已删除" : "存在", is_deleted: index % 2,
    comment_url: "", media_preview: `comment-${index}`, payload_json: "{}",
    semantic_analysis_count: 0, analysis_is_negative: "待复核", negative_type: "", negative_subtype: "",
  };
  return Object.fromEntries(fields.map(key => [key, Object.hasOwn(values, key) ? values[key] : ""]));
}
function responder(total, calls = [], change = value => value) {
  return async payload => {
    calls.push(structuredClone(payload));
    const start = (payload.page - 1) * payload.pageSize;
    const length = Math.max(0, Math.min(payload.pageSize, total - start));
    const response = { ok: true, consistentSnapshot: true, dataset: "comments", snapshotToken: TOKEN,
      total, rows: Array.from({ length }, (_, i) => row(start + i, payload.fields)) };
    return change(response, payload);
  };
}

test("fetchComments retrieves all 451 records in sequential 200-row pages, including deleted", async () => {
  const calls = [], progress = [];
  let active = 0, peak = 0;
  const respond = responder(451, calls);
  const result = await details.fetchComments(options({
    request: async payload => {
      active++; peak = Math.max(peak, active);
      try { await new Promise(resolve => setImmediate(resolve)); return await respond(payload); }
      finally { active--; }
    },
    onPage: page => progress.push(structuredClone(page)),
  }));
  assert.equal(peak, 1, "Pages must be fetched sequentially");
  assert.deepEqual(calls.map(p => p.page), [1, 2, 3]);
  assert.equal(result.total, 451); assert.equal(result.rows.length, 451);
  assert.deepEqual(result.rows.map(r => r.comment_id), Array.from({ length: 451 }, (_, i) => `comment-${i}`));
  assert.equal(result.rows.filter(r => r.is_deleted === 1).length, 225);
  assert.equal(result.rows[1].comment_status, "已删除");
  assert.deepEqual(progress.map(p => p.loaded), [200, 400, 451]);
  assert.deepEqual(progress.map(p => p.rows.length), [200, 200, 51]);
  assert.ok(progress.every(p => p.total === 451 && Array.isArray(p.rows)));
  for (const payload of calls) {
    assert.equal(payload.dataset, "comments"); assert.equal(payload.snapshotToken, TOKEN);
    assert.equal(payload.pageSize, 200); assert.equal(payload.search, "");
    assert.deepEqual(payload.filter, { logic: "and", children: [{ field: "note_id", operator: "eq", value: NOTE }] });
    assert.equal(payload.groupThreads, true); assert.equal(payload.threadSortMode, "root");
    // Root grouping supplies the unique ID tie-break on the backend.
    assert.deepEqual(payload.sort, [{ field: "published_at", direction: "asc" }]);
    assert.equal(details.COMMENT_FIELDS.length, 13);
    assert.ok(!payload.fields.includes("thread_root_content"), "Do not repeat full parent prose for every reply");
    assert.deepEqual(payload.fields, details.COMMENT_FIELDS);
    assert.deepEqual(payload.fields, calls[0].fields);
    assert.equal(new Set(payload.fields).size, payload.fields.length);
    for (const key of ["note_id", "comment_id", "content", "comment_status", "is_deleted"])
      assert.ok(payload.fields.includes(key), `Missing required selection: ${key}`);
  }
});

for (const total of [0, 1, 200, 201, 400]) test(`exact boundary total=${total} has no extra page request`, async () => {
  const calls = [], result = await details.fetchComments(options({ request: responder(total, calls) }));
  assert.equal(result.total, total); assert.equal(result.rows.length, total);
  assert.equal(calls.length, Math.max(1, Math.ceil(total / 200)));
});

const corruptions = [
  ["ok false", r => ({ ...r, ok: false })],
  ["unverified snapshot", r => ({ ...r, consistentSnapshot: false })],
  ["missing snapshot verification", r => { delete r.consistentSnapshot; return r; }],
  ["different snapshot", r => ({ ...r, snapshotToken: "snapshot-b" })],
  ["wrong dataset", r => ({ ...r, dataset: "notes" })],
  ["cross-post comment", r => { r.rows[0].note_id = "note-b"; return r; }],
  ["duplicate within page", r => { r.rows[1].comment_id = r.rows[0].comment_id; return r; }],
  ["empty identity", r => { r.rows[0].comment_id = ""; return r; }],
  ["missing content field", r => { delete r.rows[0].content; return r; }],
  ["missing note identity", r => { delete r.rows[0].note_id; return r; }],
  ["missing comment identity", r => { delete r.rows[0].comment_id; return r; }],
  ["empty page before total", r => ({ ...r, rows: [] })],
  ["short nonfinal page", r => ({ ...r, rows: r.rows.slice(0, 199) })],
  ["oversized page", r => ({ ...r, rows: [...r.rows, { ...r.rows[0], comment_id: "extra" }] })],
  ["nonarray rows", r => ({ ...r, rows: {} })],
  ["null row", r => { r.rows[0] = null; return r; }],
  ["undefined response", () => undefined],
];
for (const [name, change] of corruptions) test(`reject ${name}; do not publish the invalid page or fetch onward`, async () => {
  const calls = [], pages = [];
  await assert.rejects(details.fetchComments(options({ request: responder(401, calls, change), onPage: p => pages.push(p) })));
  assert.equal(calls.length, 1); assert.equal(pages.length, 0);
});
for (const total of [-1, 1.5, "200", null, undefined, NaN, Infinity]) test(`reject invalid total ${String(total)}`, async () => {
  await assert.rejects(details.fetchComments(options({ request: responder(200, [], r => ({ ...r, total })) })));
});

for (const [name, change] of [
  ["cross-page duplicate", r => { r.rows[0].comment_id = "comment-0"; return r; }],
  ["changed total", r => ({ ...r, total: 402 })],
  ["changed snapshot", r => ({ ...r, snapshotToken: "snapshot-b" })],
  ["cross-post row", r => { r.rows[0].note_id = "note-b"; return r; }],
  ["empty second page", r => ({ ...r, rows: [] })],
]) test(`reject second-page ${name} without announcing that page or requesting page 3`, async () => {
  const calls = [], pages = [];
  await assert.rejects(details.fetchComments(options({
    request: responder(401, calls, (r, p) => p.page === 2 ? change(r) : r),
    onPage: p => pages.push(structuredClone(p)),
  })));
  assert.equal(calls.length, 2); assert.deepEqual(pages.map(p => p.loaded), [200]);
});
test("reject short final page rather than return a partial success", async () => {
  const calls = [], pages = [];
  await assert.rejects(details.fetchComments(options({ request: responder(202, calls, (r, p) =>
    p.page === 2 ? { ...r, rows: r.rows.slice(0, 1) } : r), onPage: p => pages.push(p.loaded) })));
  assert.equal(calls.length, 2); assert.deepEqual(pages, [200]);
});
test("network failure after a valid page rejects and retains no false completion", async () => {
  const calls = [], pages = [], respond = responder(401, calls);
  await assert.rejects(details.fetchComments(options({ request: async p => {
    if (p.page === 2) throw new Error("fixture offline"); return respond(p);
  }, onPage: p => pages.push(p.loaded) })), /fixture offline/);
  assert.deepEqual(pages, [200]);
});

test("cancel before first request returns null without IO or progress", async () => {
  const calls = [], pages = [];
  assert.equal(await details.fetchComments(options({ isCurrent: () => false,
    request: responder(401, calls), onPage: p => pages.push(p) })), null);
  assert.equal(calls.length, 0); assert.equal(pages.length, 0);
});
test("cancel in onPage stops before the following request", async () => {
  const calls = []; let current = true;
  const result = await details.fetchComments(options({ request: responder(401, calls), isCurrent: () => current,
    onPage: () => { current = false; } }));
  assert.equal(result, null); assert.equal(calls.length, 1);
});
test("late response from superseded drawer returns null without progress or further requests", async () => {
  const calls = [], pages = []; let current = true, release;
  const respond = responder(401, calls);
  const pending = details.fetchComments(options({ isCurrent: () => current, onPage: p => pages.push(p),
    request: p => new Promise(resolve => { release = () => respond(p).then(resolve); }) }));
  assert.equal(typeof release, "function"); current = false; await release();
  assert.equal(await pending, null); assert.equal(calls.length, 1); assert.equal(pages.length, 0);
});
for (const overrides of [{ noteId: "" }, { noteId: null }, { snapshotToken: "" }, { snapshotToken: null }, { request: null }])
  test(`invalid input ${JSON.stringify(overrides)} rejects before IO`, async () => {
    let calls = 0;
    await assert.rejects(async () => details.fetchComments(options({ request: async () => { calls++; }, ...overrides })));
    assert.equal(calls, 0);
  });
test("missing options rejects", async () => {
  await assert.rejects(async () => details.fetchComments());
});

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.events = {}; this.attributes = {}; this.className = ""; this._text = ""; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  set innerHTML(v) { throw new Error("Untrusted content must never be interpreted as HTML"); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ""; this.children = children; }
  addEventListener(name, handler) { this.events[name] = handler; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  scrollIntoView(options) { this.scrolled = options; }
  focus(options) { this.focused = options; }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}
function dom(t) {
  const old = global.document;
  global.document = { createElement: tag => new Element(tag) };
  t.after(() => { global.document = old; });
  return new Element("section");
}
const articles = container => container.all().filter(e => e.tagName === "article");
const tick = () => new Promise(resolve => setImmediate(resolve));

test("DOM highlights current comment, deleted badge, reply parent and literal full XSS prose", async t => {
  const container = dom(t), actions = [], mounts = [];
  const prose = '<img src=x onerror="alert(1)"><script>bad()</script>\n' + "完整原文".repeat(400);
  const result = await details.loadComments(container, options({ currentCommentId: "comment-1",
    request: responder(3, [], r => { r.rows[1].content = prose; return r; }),
    gallery: { mount: (...args) => mounts.push(args) }, onAction: button => actions.push({ ...button.dataset }),
  }));
  assert.equal(result.total, 3); assert.equal(articles(container).length, 3);
  const current = articles(container).find(e => e.dataset.current === "true");
  assert.equal(current.dataset.commentId, "comment-1"); assert.equal(current.dataset.deleted, "true");
  assert.ok(current.textContent.includes(prose)); assert.ok(current.textContent.includes("回复 @原作者"));
  assert.ok(current.all().some(e => e.className === "detail-comment-current" && e.textContent === "当前评论"));
  assert.ok(current.all().some(e => e.className === "detail-comment-deleted" && e.textContent === "已删除"));
  assert.ok(!container.all().some(e => ["img", "script"].includes(e.tagName)));
  assert.equal(mounts.length, 3, "Every comment automatically mounts its image area");
  assert.ok(!container.all().some(e => e.tagName === "summary"));
  assert.ok(!container.textContent.includes("查看评论图片"));
  assert.equal(mounts[1][1].recordId, "comment-1");
  assert.equal(mounts[1][1].dataset, "comments");
  for (const mount of mounts) assert.deepEqual(mount[2], {layout: "detail", previewLimit: 3, eager: false, hideEmpty: true});
  current.all().find(e => e.dataset.action === "locate_comment").events.click();
  assert.equal(actions[0].value, "comment-1");
  container.all().find(e => e.tagName === "button" && e.textContent === "定位当前评论").events.click();
  assert.deepEqual(current.scrolled, { block: "nearest" }); assert.deepEqual(current.focused, { preventScroll: true });
});
test("DOM progressively appends each page once and never declares completion early", async t => {
  const container = dom(t), calls = [], respond = responder(201, calls);
  let release;
  const pending = details.loadComments(container, options({ request: p => p.page === 2
    ? new Promise(resolve => { release = () => respond(p).then(resolve); }) : respond(p) }));
  await tick();
  assert.equal(articles(container).length, 200); assert.ok(container.textContent.includes("已读取 200 / 201 条"));
  assert.ok(!container.textContent.includes("已加载全部"));
  await release(); await pending;
  assert.equal(articles(container).length, 201);
  assert.equal(new Set(articles(container).map(e => e.dataset.commentId)).size, 201);
  assert.ok(container.textContent.includes("已加载全部 201 条"));
});
test("DOM error retains verified page, marks incomplete, and retry replaces rather than duplicates", async t => {
  const container = dom(t), respond = responder(201); let fail = true;
  const result = await details.loadComments(container, options({ request: async p => {
    if (p.page === 2 && fail) throw new Error("fixture offline"); return respond(p);
  } }));
  assert.equal(result, null); assert.equal(articles(container).length, 200);
  assert.ok(container.textContent.includes("加载未完成")); assert.ok(!container.textContent.includes("已加载全部"));
  const retry = container.all().find(e => e.tagName === "button" && e.textContent === "重试读取评论");
  assert.ok(retry); fail = false; retry.events.click(); retry.events.click();
  await tick();
  assert.equal(articles(container).length, 201);
  assert.equal(new Set(articles(container).map(e => e.dataset.commentId)).size, 201);
  assert.ok(container.textContent.includes("已加载全部 201 条"));
  assert.ok(!container.textContent.includes("fixture offline"));
});
test("DOM empty state says only local collection is empty", async t => {
  const container = dom(t);
  await details.loadComments(container, options({ request: responder(0) }));
  assert.equal(articles(container).length, 0);
  assert.ok(container.textContent.includes("本地尚未采集")); assert.ok(!container.textContent.includes("已加载全部"));
});
test("DOM missing selected comment is an error, not completed all-comments UI", async t => {
  const container = dom(t);
  assert.equal(await details.loadComments(container, options({ currentCommentId: "missing", request: responder(1) })), null);
  assert.ok(container.textContent.includes("加载未完成")); assert.ok(!container.textContent.includes("已加载全部"));
});
test("DOM missing reply parent is explicitly unknown, never fabricated", async t => {
  const container = dom(t);
  await details.loadComments(container, options({ request: responder(2, [], r => {
    r.rows[1].thread_root_author = ""; r.rows[1].thread_root_content = ""; return r;
  }) }));
  assert.ok(articles(container)[1].textContent.includes("上级评论未采集或作者未记录"));
});
test("DOM superseded load does not append late rows or overwrite new drawer", async t => {
  const container = dom(t); let current = true, release;
  const pending = details.loadComments(container, options({ isCurrent: () => current,
    request: p => new Promise(resolve => { release = () => responder(1)(p).then(resolve); }) }));
  current = false; container.textContent = "new drawer"; await release();
  assert.equal(await pending, null); assert.equal(container.textContent, "new drawer");
});
test("render exposes comments container synchronously for both post and comment inspectors", t => {
  dom(t);
  for (const dataset of ["notes", "comments"]) {
    const container = new Element("section");
    const record = { note_id: NOTE, comment_id: "comment-1", content: "正文" };
    const result = details.render(container, { dataset, record, fields: [], snapshotToken: TOKEN });
    assert.ok(result.commentsContainer instanceof Element);
    assert.ok(container.all().includes(result.commentsContainer)); assert.ok(container.textContent.includes("正文"));
  }
});
