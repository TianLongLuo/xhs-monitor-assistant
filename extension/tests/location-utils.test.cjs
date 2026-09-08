"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const locationUtils = require("../location-utils.js");
const commentUtils = require("../comment-utils.js");
const { fixture } = require("./comment-locator.fixture.cjs");
const { extractRegion } = locationUtils;
const NOTE = { noteId: "note-fixture", url: "https://example.invalid/note", ipLocation: "广西" };
const contentSource = readFileSync(join(__dirname, "../content.js"), "utf8").replace(/\r\n/g, "\n");
const forbidden = () => assert.fail("Location extraction must not access a clock, storage, browser APIs or the network");

test("UMD exposes one pure function in both browser and CommonJS environments", () => {
  const source = readFileSync(join(__dirname, "../location-utils.js"), "utf8");
  for (const commonjs of [false, true]) {
    const sandbox = { fetch: forbidden, Date: forbidden, document: new Proxy({}, { get: forbidden }) };
    if (commonjs) sandbox.module = { exports: {} };
    vm.runInNewContext(source, sandbox, { timeout: 1000 });
    const api = sandbox.XhsMonitorLocationUtils;
    assert.deepEqual(Object.keys(api), ["extractRegion"]);
    assert.equal(api.extractRegion("01-27 四川"), "四川");
    if (commonjs) assert.equal(api, sandbox.module.exports);
  }
});

test("every region spelling matches date_normalization._REGIONS without importing the backend", () => {
  const source = readFileSync(join(__dirname, "../../bridge/date_normalization.py"), "utf8");
  const words = (block) => [...block.matchAll(/"([^"]*)"/g)].map((match) => match[1]).join("").trim().split(/\s+/);
  const provinces = words(source.slice(source.indexOf("_PROVINCES ="), source.indexOf("_MUNICIPALITIES =")));
  const municipalities = words(source.slice(source.indexOf("_MUNICIPALITIES ="), source.indexOf("_REGIONS =")));
  const extra = source.slice(source.indexOf("| frozenset(", source.indexOf("_REGIONS =")), source.indexOf("_REGION_PREFIX ="));
  const regions = new Set([
    ...provinces, ...provinces.map((name) => name + "省"),
    ...municipalities, ...municipalities.map((name) => name + "市"), ...words(extra)
  ]);
  assert.equal(provinces.length, 23);
  assert.equal(municipalities.length, 4);
  assert.ok(regions.size > 110);
  for (const region of regions) {
    for (const prefix of ["", "IP属地：", "ip 所在地: ", "来自 ", "01-27 ", "编辑于 昨天 18:47 · IP属地 "]) {
      assert.equal(extractRegion(prefix + region), region, prefix + region);
    }
  }
});

test("date, relative and edited labels yield only their displayed region spelling", () => {
  const cases = [
    ["01-27 四川", "四川"], ["02-01 湖北", "湖北"], ["12-31四川", "四川"],
    ["2026-01-27 四川省", "四川省"], ["2026/02/01 湖北", "湖北"], ["2026.02.01 上海市", "上海市"],
    ["2026年2月1日 日本", "日本"], ["1/27 广西", "广西"], ["1月27日 中国香港", "中国香港"],
    ["刚刚 新西兰", "新西兰"], ["昨天 18:47 广东", "广东"], ["今天 IP所在地：湖北", "湖北"],
    ["前天 • 美国", "美国"], ["30秒前 四川", "四川"], ["15分钟前 浙江", "浙江"],
    ["两个小时前 四川", ""], ["两小时前 四川", "四川"], ["十分钟之前 法国", "法国"],
    ["几天前 海南", "海南"], ["三天前 08:30 来自 宁夏回族自治区", "宁夏回族自治区"],
    ["编辑于 01-27 四川", "四川"], ["更新于：昨天 09:00 加拿大", "加拿大"],
    ["发布于 2026-02-01 23:59:59.123 来自 英国", "英国"],
    ["2026-02-01T15:59:59Z · 中国内地", "中国内地"],
    ["2026-02-01T23:59:59+08:00 IP属地：台湾省", "台湾省"],
    ["  02-01\n\t·\u00a0IP 所在地 ： 湖北  ", "湖北"]
  ];
  for (const [raw, expected] of cases) assert.equal(extractRegion(raw), expected, raw);
});

test("prose, usernames, numeric IPs, unsupported names and incomplete labels stay empty", () => {
  for (const raw of [
    "", " ", "未显示", "未知", "四川网友", "我是四川人", "IP属地：四川网友", "正文 IP属地：四川",
    "来自一个普通用户", "来自四川的用户", "四川 IP属地", "IP所在地：", "IP地址：四川",
    "IP属地：127.0.0.1", "来自 2001:db8::1", "127.0.0.1", "2001:db8::1", "IP属地：武汉", "东京", "火星",
    "2026-02-01", "01-27", "刚刚", "昨天 12:00", "1700000000", "1700000000 四川", "编辑于四川",
    "01-27 四川 很好", "01-27 四川 湖北", "01-27 四川 赞2", "IP属地：四川/湖北", "IP属地：四川。",
    "01-27 02-01 四川", "02-01 IP属地：未知", "01-27 来自四川用户", "四川" + "正文".repeat(1000)
  ]) assert.equal(extractRegion(raw), "", raw);
  for (const raw of [null, undefined, 0, true, [], ["四川"], Symbol("四川"), { toString: forbidden }]) {
    assert.equal(extractRegion(raw), "");
  }
});

test("malformed or ambiguous time prefixes are not treated as native date metadata", () => {
  for (const raw of [
    "2026-13-01 四川", "2026-01-00 四川", "2026-01-32 四川", "13-01 湖北", "01-00 湖北",
    "2026-01/27 四川", "昨天 24:00 四川", "01-27 12:60 四川", "01-27 TT12:00 四川",
    "昨天T12:00 四川", "昨天 12:00Z 四川", "刚刚 12:00 四川", "5分钟前 12:00 四川",
    "一二小时前 四川", "2026-01-27 12:00+99:00 四川", "更新于 发布于 01-27 四川"
  ]) assert.equal(extractRegion(raw), "", raw);
});

test("calendar validity agrees with reference-free normalization, without resolving ambiguous times", () => {
  for (const raw of [
    "02-30 四川", "2026-02-29 四川", "1900-02-29 四川", "2024-04-31 四川", "0000-01-27 四川",
    "2026年2月30日 四川", "编辑于 2026/02/30 四川", "999999999999999天前 四川"
  ]) assert.equal(extractRegion(raw), "", raw);
  for (const raw of ["02-29 四川", "2024-02-29 四川", "2000年2月29日 四川", "几天前 四川", "几分钟前 四川"]) {
    assert.equal(extractRegion(raw), "四川", raw);
  }
});

// Extend the existing narrow fixture locally with descendant/child selectors,
// ID selectors and rendered innerText. No global prototype or existing fixture
// is changed, and no real page, image, Chrome API, CSV or database is contacted.
function domFixture() {
  const h = fixture();
  const originals = new WeakMap();
  const simple = (node, token) => node && originals.get(node)(token.replace(/#([\w-]+)/g, "[id='$1']"));
  function chain(node, tokens, index = tokens.length - 1) {
    if (!simple(node, tokens[index])) return false;
    if (!index) return true;
    if (tokens[index - 1] === ">") return chain(node.parentElement, tokens, index - 2);
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (chain(ancestor, tokens, index - 1)) return true;
    }
    return false;
  }
  const renderedText = (node) => node.getClientRects().length
    ? node._text + node.children.map(renderedText).join("") : "";
  function decorate(node) {
    if (originals.has(node)) return node;
    originals.set(node, node.matches.bind(node));
    node.matches = (selector) => selector.split(",").some((part) => chain(node, part.trim().match(/(?:\[[^\]]*\]|[^\s>])+|>/g)));
    Object.defineProperty(node, "innerText", { get: () => renderedText(node), set: (value) => { node.textContent = value; } });
    node.children.forEach(decorate);
    return node;
  }
  decorate(h.document.body);
  const create = h.el;
  h.el = (...args) => decorate(create(...args));
  h.document.querySelector = (selector) => h.document.body.querySelector(selector);
  h.document.querySelectorAll = (selector) => h.document.body.querySelectorAll(selector);
  return h;
}

const comments = (h) => commentUtils.extractComments(h.root, NOTE).comments;
const ipNode = (h, text, attrs = {}) => h.el("span", { class: "ip-location", ...attrs }, [text]);

function declaration(name) {
  const start = contentSource.indexOf(`  function ${name}(`);
  const end = contentSource.indexOf("\n  }", start);
  assert.ok(start >= 0 && end > start, `Missing production declaration ${name}`);
  return contentSource.slice(start, end + 4);
}

function metadata(h) {
  const context = vm.createContext({
    locationUtils, document: h.document, location: h.view.location,
    detailRootForNote: () => h.root, detailDescription: () => ({ value: "测试正文" }),
    detailNoteId: () => NOTE.noteId, noteIdFromUrl: () => NOTE.noteId,
    canonicalTitle: (value) => value, detailMediaRoot: (root) => root,
    extractImageUrls: () => [], extractVideoUrls: () => [], extractMediaText: () => "",
    processAuthorId: () => "", processMetric: () => "", currentKeyword: () => "",
    noteUtils: { normalizeXhsUrl: (value) => value, preferredUrl: (value) => value },
    fetch: forbidden, chrome: new Proxy({}, { get: forbidden })
  });
  vm.runInContext([
    "clean", "validNoteId", "normalizeTagValues", "sourceNoteSnapshot", "detailMetadataNodes",
    "detailDateText", "processIpLocation", "processDetailMetadata", "extractCurrentDetail"
  ].map(declaration).join("\n"), context, { timeout: 1000 });
  return context;
}

test("parent, nested reply and other thread each retain their own visible region and date", () => {
  const h = domFixture();
  const parent = h.row("parent", "主评论", { publishedAt: "01-27 四川" });
  const reply = h.row("reply", "子评论", { reply: true, publishedAt: "02-01 湖北" });
  parent.append(h.el("div", { class: "sub-comments" }, [reply]));
  h.scope.append(h.thread("thread", [parent]), h.thread("other-thread", [h.row("other", "另一个线程", { publishedAt: "昨天 日本" })]));
  const rows = comments(h);
  assert.deepEqual(rows.map((row) => [row.commentId, row.ipLocation, row.publishedAt]), [
    ["parent", "四川", "01-27 四川"], ["reply", "湖北", "02-01 湖北"], ["other", "日本", "昨天 日本"]
  ]);
  assert.equal(rows[1].parentCommentId, "parent");
});

test("a parent without a region never borrows a nested reply's metadata or the note region", () => {
  const h = domFixture();
  const parent = h.row("parent", "主评论", { publishedAt: "01-27" });
  const reply = h.row("reply", "子评论", { reply: true, publishedAt: "02-01 湖北" });
  parent.parts.date.append(reply); // even a malformed date wrapper is not own metadata
  h.scope.append(h.thread("thread", [parent]));
  assert.deepEqual(comments(h).map((row) => row.ipLocation), ["", "湖北"]);
});

test("sibling replies do not inherit their parent's or another reply's region", () => {
  const h = domFixture();
  h.scope.append(h.thread("thread", [
    h.row("parent", "主评论", { publishedAt: "01-27 四川" }),
    h.row("reply", "子评论", { reply: true, publishedAt: "02-01 湖北" }),
    h.row("empty", "其他回复", { reply: true, publishedAt: "02-01" })
  ]));
  assert.deepEqual(comments(h).map((row) => row.ipLocation), ["四川", "湖北", ""]);
});

test("comment bodies, usernames and avatars do not become regions even with metadata-like descendants", () => {
  const h = domFixture();
  const row = h.row("own", "正文提到四川，也写了 IP属地：四川", { author: "四川", publishedAt: "01-27" });
  row.parts.content.append(ipNode(h, "IP属地：湖北"), h.el("span", { class: "date" }, ["昨天 日本"]));
  row.parts.author.append(ipNode(h, "来自广东"));
  row.append(h.el("div", { class: "avatar" }, [ipNode(h, "美国")]));
  h.scope.append(row);
  assert.equal(comments(h)[0].ipLocation, "");
});

test("explicit own comment IP metadata wins over a date suffix without rewriting publishedAt", () => {
  const h = domFixture();
  const raw = "编辑于 01-27 四川";
  const row = h.row("own", "评论", { publishedAt: raw });
  row.append(ipNode(h, "IP所在地：湖北")); h.scope.append(row);
  assert.equal(comments(h)[0].ipLocation, "湖北");
  assert.equal(comments(h)[0].publishedAt, raw);
});

test("hidden comment metadata is ignored and a visible own date may be used instead", () => {
  for (const hide of [
    (node) => { node.hidden = true; }, (node) => node.setAttribute("aria-hidden", "true"),
    (node) => { node.style.display = "none"; }, (node) => { node.style.visibility = "hidden"; },
    (node) => { node.style.visibility = "collapse"; }
  ]) {
    const h = domFixture(); const row = h.row("own", "评论", { publishedAt: "01-27 四川" });
    const explicit = ipNode(h, "IP属地：湖北"); hide(explicit); hide(row.parts.date);
    row.append(explicit); h.scope.append(row);
    assert.equal(comments(h)[0].ipLocation, "");
    row.append(h.el("span", { class: "time" }, ["02-01 日本"]));
    assert.equal(comments(h)[0].ipLocation, "日本");
  }
});

test("nested hidden region spans and invisible metadata ancestors never contribute text", () => {
  const h = domFixture(); const row = h.row("own", "评论", { publishedAt: "01-27" });
  row.parts.date.append(h.el("span", { hidden: "" }, [" 四川"]));
  row.append(h.el("div", { hidden: "" }, [ipNode(h, "IP属地：湖北")])); h.scope.append(row);
  assert.equal(comments(h)[0].ipLocation, "");
  row.parts.date.append(h.el("span", {}, [" 日本"]));
  assert.equal(comments(h)[0].ipLocation, "日本");
});

test("plugin labels are excluded while highlighted native comments remain eligible", () => {
  const h = domFixture(); const row = h.row("own", "评论", { publishedAt: "01-27" });
  for (const className of ["xhs-monitor-process", "xhs-monitor-toolbar", "xhs-monitor-page-toast", "xhs-monitor-badge"]) {
    row.append(h.el("aside", { class: className }, [ipNode(h, "IP属地：湖北"), h.el("span", { class: "date" }, ["昨天 四川"])]));
  }
  h.scope.append(row);
  assert.equal(comments(h)[0].ipLocation, "");
  row.classList.add("xhs-monitor-comment-highlight");
  h.document.body.classList.add("xhs-monitor-detail-open");
  row.parts.date.textContent = "01-27 四川";
  assert.equal(comments(h)[0].ipLocation, "四川");
});

test("image-only comments retain media, stable identity inputs and their own displayed region", () => {
  const h = domFixture(); const url = "https://example.invalid/comment.jpg";
  const raw = "02-01 湖北";
  h.scope.append(h.row(null, "", { publishedAt: raw, images: [
    h.el("a", { class: "avatar" }, [h.image("https://example.invalid/avatar.jpg")]), h.image(url)
  ] }));
  const row = comments(h)[0];
  assert.equal(row.content, "[图片]"); assert.deepEqual(row.imageUrls, [url]);
  assert.equal(row.ipLocation, "湖北"); assert.equal(row.publishedAt, raw);
  assert.equal(row.commentId, commentUtils.stableCommentId(NOTE.noteId, "作者甲", `[图片]\u001f${url}`, raw));
});

test("post date suffixes are captured without losing edited or relative source labels", () => {
  for (const [raw, region] of [["01-27 四川", "四川"], ["02-01 湖北", "湖北"], ["编辑于 昨天 12:00 日本", "日本"]]) {
    const h = domFixture(); h.root.append(h.el("div", { class: "note-content" }, [h.el("span", { class: "date" }, [raw])]));
    const api = metadata(h); const result = api.processDetailMetadata(h.root);
    assert.equal(result.ipLocation, region); assert.equal(api.processIpLocation(h.root), region);
    assert.equal(result.publishedAt, raw);
    assert.equal(result.updatedAt, raw.startsWith("编辑于") ? raw : "未显示");
  }
});

test("post metadata gives explicit IP nodes and native date locations precedence", () => {
  const h = domFixture();
  h.root.append(h.el("time", {}, ["昨天 日本"]), h.el("div", { class: "bottom-container" }, [h.el("span", { class: "date" }, ["01-27 四川"])]));
  const api = metadata(h);
  assert.equal(api.processDetailMetadata(h.root).ipLocation, "四川");
  const explicit = ipNode(h, "IP所在地：湖北"); h.root.append(explicit);
  const result = api.processDetailMetadata(h.root);
  assert.equal(result.ipLocation, "湖北"); assert.equal(result.publishedAt, "01-27 四川");
  explicit.remove(); assert.equal(api.processIpLocation(h.root), "四川");
});

test("post capture excludes every comment shell, standalone row, thread and plugin metadata", () => {
  const h = domFixture();
  for (const className of [
    "comments-el", "comments-container", "comments-list", "comment-item", "parent-comment", "comment-thread", "reply-item",
    "xhs-monitor-process", "xhs-monitor-toolbar", "xhs-monitor-page-toast"
  ]) h.root.append(h.el("div", { class: className }, [ipNode(h, "IP属地：湖北"), h.el("span", { class: "date" }, ["昨天 四川"])]));
  h.root.append(h.el("div", { "data-comment-id": "standalone" }, [ipNode(h, "IP属地：日本")]));
  const api = metadata(h); const empty = api.processDetailMetadata(h.root);
  assert.equal(empty.ipLocation, ""); assert.equal(empty.publishedAt, "");
  h.root.append(h.el("span", { class: "date" }, ["01-27"]));
  assert.equal(api.processDetailMetadata(h.root).ipLocation, "");
});

test("post bodies containing region words or IP labels are never scanned as metadata", () => {
  const h = domFixture();
  for (const attrs of [{ id: "detail-desc" }, { class: "note-text" }, { class: "description" }, { class: "content" }, { class: "username" }]) {
    h.root.append(h.el("div", attrs, ["四川", ipNode(h, "IP属地：四川"), h.el("span", { class: "date" }, ["昨天 湖北"])]));
  }
  h.root.append(h.el("p", {}, ["IP属地：日本"]), h.el("div", {}, ["来自四川"]));
  const result = metadata(h).processDetailMetadata(h.root);
  assert.equal(result.ipLocation, ""); assert.equal(result.publishedAt, "");
});

test("post wrappers containing comments or UI and neighboring notes do not supply metadata", () => {
  const h = domFixture();
  h.root.append(h.el("span", { class: "date" }, ["01-27", h.el("div", { class: "comments-el" }, [" 四川"])]));
  h.root.append(h.el("div", { class: "ip-location" }, [h.el("aside", { class: "xhs-monitor-process" }, ["湖北"])]));
  h.root.append(h.el("section", { "data-note-id": "neighbor" }, [ipNode(h, "IP属地：日本")]));
  const result = metadata(h).processDetailMetadata(h.root);
  assert.equal(result.ipLocation, ""); assert.equal(result.publishedAt, "");
});

test("hidden post nodes and attributes without displayed region text stay empty", () => {
  const h = domFixture();
  const invisible = ipNode(h, "IP属地：湖北"); invisible.style.visibility = "hidden";
  h.root.append(invisible, h.el("span", { class: "date", hidden: "" }, ["昨天 四川"]),
    h.el("div", { "aria-hidden": "true" }, [ipNode(h, "日本")]),
    h.el("time", { datetime: "2026-01-27", "data-ip-location": "美国" }),
    h.el("span", { class: "date" }, ["01-27", h.el("span", { hidden: "" }, [" 四川"])]));
  const api = metadata(h);
  assert.equal(api.processDetailMetadata(h.root).ipLocation, "");
  invisible.style.visibility = "visible";
  assert.equal(api.processDetailMetadata(h.root).ipLocation, "湖北");
});

test("current native metadata replaces stale baseNote region, including when no region is shown", () => {
  const h = domFixture(); const date = h.el("span", { class: "date" }, ["01-27 四川"]); h.root.append(date);
  const api = metadata(h);
  const base = { ...NOTE, title: "测试帖子", ipLocation: "湖北" };
  const current = api.extractCurrentDetail(base);
  assert.equal(current.ok, true); assert.equal(current.note.ipLocation, "四川");
  assert.equal(base.ipLocation, "湖北");
  date.textContent = "01-27";
  assert.equal(api.extractCurrentDetail(base).note.ipLocation, "");
  date.remove(); assert.equal(api.extractCurrentDetail(base).note.ipLocation, "");
});

test("sourceNoteSnapshot retains existing ipLocation without inventing derived region fields", () => {
  const api = metadata(domFixture());
  for (const ipLocation of ["四川省", "IP属地：湖北", ""]) {
    const snapshot = api.sourceNoteSnapshot({ ...NOTE, ipLocation, publishedAt: "01-27 四川" });
    assert.equal(snapshot.ipLocation, ipLocation); assert.equal(snapshot.publishedAt, "01-27 四川");
    assert.equal("ipRegion" in snapshot, false); assert.equal("ipRegionSource" in snapshot, false);
  }
  assert.equal("ipLocation" in api.sourceNoteSnapshot({ noteId: NOTE.noteId }), false);
});
test("date extraction retains datetime fallback when the native time element has no text", () => {
  const h=domFixture();h.root.append(h.el("time",{datetime:"2026-01-27T12:00:00+08:00"}));
  const out=metadata(h).processDetailMetadata(h.root);
  assert.equal(out.publishedAt,"2026-01-27T12:00:00+08:00");assert.equal(out.ipLocation,"");
});
