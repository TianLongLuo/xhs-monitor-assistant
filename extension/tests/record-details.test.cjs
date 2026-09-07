"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const details = require("../record-details.js");

const spec = key => ({ key, label: key, dataType: "text" });
function options(overrides = {}) {
  return { dataset: "comments", recordId: "comment-a", expectedNoteId: "note-a", snapshotToken: "snapshot-a",
    fields: ["comment_id", "note_id", "content", "author", "payload_json"].map(spec), ...overrides };
}
function responder(calls, change = value => value) {
  return async payload => {
    calls.push(payload);
    const values = { comment_id: "comment-a", note_id: "note-a", content: "完整原文", author: "作者", payload_json: "{\"imageUrls\":[\"https://img.xhscdn.com/a.jpg\"]}" };
    return change({ ok: true, dataset: payload.dataset, consistentSnapshot: true, snapshotToken: payload.snapshotToken,
      total: 1, rows: [Object.fromEntries(payload.fields.map(key => [key, values[key] ?? key]))] });
  };
}

test("full record includes hidden fields and raw payload; exact read is independent of list filters", async () => {
  const calls = [], result = await details.fetchRecord(options({ request: responder(calls) }));
  assert.equal(result.content, "完整原文"); assert.equal(result.author, "作者"); assert.ok(result.payload_json.includes("imageUrls"));
  assert.deepEqual(calls[0].filter, { logic: "and", children: [{ field: "comment_id", operator: "eq", value: "comment-a" }] });
  assert.equal(calls[0].search, ""); assert.deepEqual(calls[0].sort, []);
  assert.equal(calls[0].groupThreads, false); assert.equal(calls[0].pageSize, 1);
});
test("wide schema is fetched in bounded chunks under the same snapshot", async () => {
  const calls = [], fields = ["comment_id", "note_id", ...Array.from({length: 220}, (_, i) => "field_" + i)].map(spec);
  const result = await details.fetchRecord(options({ fields, request: responder(calls) }));
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.fields.length <= 180 && call.snapshotToken === "snapshot-a"));
  assert.equal(Object.keys(result).length, 222); assert.equal(result.field_219, "field_219");
});
for (const [name, change] of [
  ["changed snapshot", r => ({...r, snapshotToken: "new"})],
  ["unverified snapshot", r => ({...r, consistentSnapshot: false})],
  ["wrong dataset", r => ({...r, dataset: "notes"})],
  ["deleted record", r => ({...r, total: 0, rows: []})],
  ["more than one record", r => ({...r, total: 2})],
  ["another comment", r => ({...r, rows: [{...r.rows[0], comment_id: "comment-b"}]})],
  ["wrong post relationship", r => ({...r, rows: [{...r.rows[0], note_id: "note-b"}]})],
  ["missing selected field", r => { delete r.rows[0].author; return r; }],
]) test(`reject ${name} rather than display mixed/partial data`, async () => {
  await assert.rejects(details.fetchRecord(options({ request: responder([], change) })));
});
test("closed or superseded drawer ignores late response", async () => {
  let current = true, resolve;
  const pending = details.fetchRecord(options({ isCurrent: () => current, request: payload => new Promise(r => { resolve = () => responder([])(payload).then(r); }) }));
  current = false; await resolve(); assert.equal(await pending, null);
});
test("cancel before load makes no request", async () => {
  const calls = []; assert.equal(await details.fetchRecord(options({ isCurrent: () => false, request: responder(calls) })), null); assert.equal(calls.length, 0);
});
test("second-chunk failure rejects the whole record", async () => {
  let count = 0;
  const fields = ["comment_id", "note_id", ...Array.from({length: 200}, (_, i) => "k" + i)].map(spec);
  await assert.rejects(details.fetchRecord(options({ fields, request: async p => {
    if (++count === 2) throw new Error("offline"); return responder([])(p);
  } })), /offline/);
});
test("invalid identity/schema cannot trigger reads and prototype-like columns are ignored", async () => {
  for (const override of [{ dataset: "unknown" }, { recordId: "" }, { snapshotToken: "" }, { fields: [spec("content")] }]) {
    await assert.rejects(details.fetchRecord(options({ ...override, request: () => assert.fail("must not request") })));
  }
  const calls = []; await details.fetchRecord(options({ fields: [...options().fields, spec("__proto__"), spec("constructor")], request: responder(calls) }));
  assert.ok(!calls[0].fields.includes("__proto__")); assert.ok(!calls[0].fields.includes("constructor"));
});
test("links permit only non-credential http(s) URLs", () => {
  for (const value of ["javascript:alert(1)", "data:text/html,hello", "file:///C:/secret", "https://user:pass@www.xiaohongshu.com/x", "not url"]) assert.equal(details.safeLink(value), "");
  assert.equal(details.safeLink("https://www.xiaohongshu.com/explore/abc"), "https://www.xiaohongshu.com/explore/abc");
});
test("zero, false and missing values retain different meanings", () => {
  assert.equal(details.display(0), "0"); assert.equal(details.display(false), "false"); assert.equal(details.display(null), "—");
  assert.equal(details.fieldGroup("post__ip_location"), "关联原帖"); assert.equal(details.fieldGroup("payload_json"), "原始结构化数据");
});

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.events = {}; this.className = ""; this._text = ""; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  set innerHTML(v) { throw new Error("untrusted text must never be rendered as HTML"); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ""; this.children = children; }
  addEventListener(name, handler) { this.events[name] = handler; }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}
test("inspector renders own images, full prose, hidden fields and actionable values", t => {
  const old = global.document; global.document = { createElement: tag => new Element(tag) };
  t.after(() => { global.document = old; });
  const record = { comment_id: "comment-a", note_id: "note-a", author: "读者", content: '<img onerror="alert(1)">\n' + "完整正文".repeat(250),
    media_preview: "comment-a", comment_status: "存在", like_count: 0, comment_level: 2, published_at: "2026-09-04 09:10:00",
    ip_location: "四川", thread_root_id: "comment-root", thread_root_content: "一级评论原文", thread_root_author: "原作者",
    post__title: "关联帖子", post__content: "原帖完整正文", post__post_status: "存在", post__open_material: "note-a",
    author_url: "javascript:alert(1)", is_deleted: 0, payload_json: '{"imageUrls":["original-url"]}' };
  const fields = Object.keys(record).map(key => ({...spec(key), ...(key === "is_deleted" ? {dataType:"boolean"} : {}), ...(key === "media_preview" ? {action:"preview_media"} : {})}));
  const container = new Element("div"), mounts = [], actions = [];
  details.render(container, {dataset:"comments",record,fields,snapshotToken:"snapshot-a",gallery:{mount:(...args)=>mounts.push(args)},onAction:b=>actions.push({...b.dataset})});
  assert.equal(mounts.length, 1); assert.equal(mounts[0][1].recordId, "comment-a"); assert.equal(mounts[0][2].previewLimit, 6);
  assert.ok(container.textContent.includes(record.content)); assert.ok(container.textContent.includes("一级评论原文"));
  assert.ok(container.textContent.includes("author_url")); assert.ok(container.textContent.includes("original-url"));
  assert.ok(!container.all().some(e => e.tagName === "a" && e.href === record.author_url));
  const locate = container.all().find(e => e.dataset.action === "locate_comment"); locate.events.click(); assert.equal(actions[0].value, "comment-a");
  const parent = container.all().find(e => e.className === "detail-post-context"); parent.open = true; parent.events.toggle(); parent.events.toggle();
  assert.equal(mounts.length, 2); assert.equal(mounts[1][1].dataset, "notes"); assert.equal(mounts[1][1].recordId, "note-a");
  assert.ok(container.textContent.includes("仅查看，不修改数据库"));
});
test("post inspector uses the post media identity even without the image column selected", t => {
  const old = global.document; global.document = { createElement: tag => new Element(tag) }; t.after(() => {global.document=old;});
  const mounts = [], container = new Element("div");
  details.render(container,{dataset:"notes",record:{note_id:"note-a",content:"正文",access_status:"check_failed",pull_status:"synced",media_dir:"folder",source_published_at:"2026-09-04 09:00:00",source_published_at_status:"estimated_from_edit"},fields:[spec("note_id")],snapshotToken:"a",gallery:{mount:(...a)=>mounts.push(a)}});
  assert.equal(mounts[0][1].recordId,"note-a"); assert.ok(container.textContent.includes("帖子图片"));
  assert.ok(container.textContent.includes("待复核")); assert.ok(container.all().some(e=>e.dataset.action==="open_material"));
  assert.ok(!container.textContent.includes("check_failed"));
  assert.ok(container.textContent.includes("北京时间")); assert.ok(container.textContent.includes("非首次发布时间"));
});
