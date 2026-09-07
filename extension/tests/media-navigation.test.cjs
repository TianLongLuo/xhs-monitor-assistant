"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { safeImageUrl } = require("../overview-media.js");
const worker = fs.readFileSync(path.join(__dirname, "../service-worker.js"), "utf8").replace(/\r\n/g, "\n");
function declaration(name) {
  const start = worker.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  const end = worker.indexOf("\n}", start); assert.ok(start >= 0 && end > start, name);
  return worker.slice(start, end + 2);
}
const noteId = "a".repeat(24), commentId = "comment-" + "b".repeat(24);
function harness(target) {
  const events = [];
  const chrome = { tabs: {
    create: async args => { events.push(["create", args]); return { id: 42 }; },
    get: async id => ({ id, url: `https://www.xiaohongshu.com/explore/${noteId}?xhs_monitor_locate=1` }),
    sendMessage: async (id, message) => { events.push(["message", message]); return message.type === "getPageInfo" ? { contentVersion: "test" } : { ok: true, matchedBy: "id" }; }
  } };
  const context = vm.createContext({ URL, Map, Date, Promise, setTimeout, chrome,
    DETAIL_LOAD_TIMEOUT_MS: 25, CONTENT_SCRIPT_VERSION: "test", commentNavigationTasks: new Map(),
    bridgeApi: async p => { events.push(["read", p]); return target || { ok: true, note: { noteId }, comment: { noteId, commentId } }; },
    delay: async () => {}
  });
  vm.runInContext(["commentLocatorUrl", "openCommentInPage"].map(declaration).join("\n"), context);
  return { context, events, chrome };
}
test("remote previews accept only HTTPS platform CDN URLs", () => {
  assert.equal(safeImageUrl("https://sns-img-bd.xhscdn.com/path!format_webp"), "https://sns-img-bd.xhscdn.com/path!format_webp");
  for (const value of ["http://sns-img.xhscdn.com/a", "https://xhscdn.com.evil.test/a", "https://evil.test/a", "https://u:p@xhscdn.com/a", "file:///c:/x.png", "javascript:alert(1)", "https://xhscdn.com:444/a", "data:image/svg+xml;base64,abcd"]) assert.equal(safeImageUrl(value), "", value);
});
test("local preview accepts encoded raster bytes and rejects SVG/arbitrary data", () => {
  assert.equal(safeImageUrl("data:image/png;base64,aGVsbG8=", true), "data:image/png;base64,aGVsbG8=");
  for (const value of ["data:text/html;base64,abcd", "data:image/svg+xml;base64,abcd", "data:image/png;base64,<svg>", "https://xhscdn.com/a"]) assert.equal(safeImageUrl(value, true), "");
});
test("locator preserves signed original note URL but strips batch marker and hash", () => {
  const { context } = harness();
  const result = new URL(context.commentLocatorUrl({ noteId, url: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=fixture&xhs_monitor_batch=1#comment` }));
  assert.equal(result.searchParams.get("xsec_token"), "fixture"); assert.equal(result.searchParams.get("xhs_monitor_batch"), null);
  assert.equal(result.searchParams.get("xhs_monitor_locate"), "1"); assert.equal(result.hash, "");
});
test("untrusted or different-note URL never navigates away from exact stored post", () => {
  const { context } = harness();
  for (const url of ["https://evil.test/a", `https://www.xiaohongshu.com/explore/${"c".repeat(24)}`, `https://www.xiaohongshu.com/user/profile/${noteId}`, `javascript:alert(1)`, `https://user@www.xiaohongshu.com/explore/${noteId}`]) {
    assert.equal(new URL(context.commentLocatorUrl({ noteId, url })).pathname, `/explore/${noteId}`);
  }
  assert.throws(() => context.commentLocatorUrl({ noteId: "../../bad" }));
});
test("comment navigation only reads exact record and creates independent tab, never reuses sync tab", async () => {
  const h = harness(); const result = await h.context.openCommentInPage(commentId);
  assert.equal(result.ok, true); assert.equal(result.tabId, 42);
  assert.deepEqual(h.events.filter(e => e[0] === "read").map(e => e[1]), [`/api/data-overview/comment-target?commentId=${commentId}`]);
  assert.equal(h.events.filter(e => e[0] === "create").length, 1);
  assert.equal(h.events.at(-1)[1].type, "locateCommentInPage");
  assert.equal(h.events.at(-1)[1].comment.commentId, commentId);
});
test("mismatched ownership is rejected before creating a tab", async () => {
  const h = harness({ ok: true, note: { noteId }, comment: { noteId: "c".repeat(24), commentId } });
  await assert.rejects(h.context.openCommentInPage(commentId), /关联/); assert.equal(h.events.filter(e => e[0] === "create").length, 0);
});
test("double click coalesces exact same target without duplicate new tabs", async () => {
  const h = harness(); await Promise.all([h.context.openCommentInPage(commentId), h.context.openCommentInPage(commentId)]);
  assert.equal(h.events.filter(e => e[0] === "create").length, 1); assert.equal(h.context.commentNavigationTasks.size, 0);
});
test("user navigation interrupts lookup without opening another tab or modifying state", async () => {
  const h = harness(); h.chrome.tabs.get = async id => ({ id, url: "https://www.xiaohongshu.com/explore/" + "d".repeat(24) });
  await assert.rejects(h.context.openCommentInPage(commentId), /已跳转/);
  assert.equal(h.events.filter(e => e[0] === "message").length, 0);
});
test("asset helpers appear before their consumers in both content injection paths", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf("comment-locator.js") < scripts.indexOf("content.js"));
  assert.match(worker, /"comment-locator.js", "content.js"/);
  const html = fs.readFileSync(path.join(__dirname, "../data-overview.html"), "utf8");
  assert.ok(html.indexOf('src="overview-media.js"') < html.indexOf('src="data-overview.js"'));
});
