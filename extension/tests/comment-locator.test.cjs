"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const locator = require("../comment-locator.js");
const realUtils = require("../comment-utils.js");
const { fixture } = require("./comment-locator.fixture.cjs");

const NOTE = "note-fixture";
const ID = "64aabbccddeeff0011223344";
const PARENT = "64aabbccddeeff0011223300";
const OTHER = "64aabbccddeeff0011223355";
const HIGHLIGHT = "xhs-monitor-comment-highlight";
const forbidden = () => assert.fail("No fuzzy lookup, collection, storage or network operation permitted");
const utils = { ...realUtils, findCommentElement: forbidden, extractComments: forbidden, createCollectionAdapter: forbidden };
const match = (h, comment, extra = {}) => locator.matchComment({ root: h.root, noteId: NOTE, comment, utils, ...extra });
const run = (h, comment, extra = {}) => locator.locate({ root: h.root, noteId: NOTE, comment, utils, isCurrent: () => true, ...extra });
const idOf = (content, author = "作者甲", date = "昨天 12:00") => realUtils.stableCommentId(NOTE, author, content, date);
const clicks = h => h.actions.filter(action => action.kind === "click");
const scrolls = h => h.actions.filter(action => action.kind === "scroll");

test("UMD exposes the same strict API via the browser global and CommonJS", () => {
  const source = readFileSync(join(__dirname, "../comment-locator.js"), "utf8");
  const sandbox = { module: { exports: {} }, fetch: forbidden, localStorage: new Proxy({}, { get: forbidden }) };
  vm.runInNewContext(source, sandbox);
  assert.equal(sandbox.XhsMonitorCommentLocator, sandbox.module.exports);
  assert.deepEqual(Object.keys(sandbox.module.exports).sort(), ["canonicalCommentId", "locate", "matchComment"]);
  const browser = {}; vm.runInNewContext(source, browser);
  assert.equal(typeof browser.XhsMonitorCommentLocator.locate, "function");
  assert.doesNotMatch(source, /\.findCommentElement\s*\(|\.extractComments\s*\(|\bfetch\s*\(|\blocalStorage\b|\bchrome\./);
});

test("canonical ID strips only literal comment- followed by exactly 24 hex characters", () => {
  assert.equal(locator.canonicalCommentId(`comment-${ID}`), ID);
  for (const value of ["comment-abc", `comment-${ID}a`, `comment-${ID}Z`, `reply-${ID}`, `COMMENT-${ID}`, ` ${ID}`, `${ID} `]) {
    assert.equal(locator.canonicalCommentId(value), value);
  }
});

test("exact native ID wins over body/author changes and similar-ID/body decoys", () => {
  const h = fixture();
  h.scope.append(h.row(`${ID}suffix`, "旧正文"), h.row(OTHER, "旧正文"));
  const target = h.row(ID, "新正文", { author: "已改名" }); h.scope.append(target);
  assert.equal(match(h, { commentId: `comment-${ID}`, content: "旧正文", author: "作者甲" }).element, target);
  assert.equal(match(h, { commentId: ID }).matchedBy, "commentId");
});

test("missing real IDs never fall back to identical or partial body text", () => {
  const h = fixture();
  h.scope.append(h.row(OTHER, "完全相同"), h.row(null, "完全相同"));
  assert.equal(match(h, { commentId: ID, content: "完全相同", author: "作者甲" }).element, null);
  assert.equal(match(h, { commentId: "abc", content: "完全" }).element, null);
  h.scope.append(h.row("comment-abc", "完全"));
  assert.equal(match(h, { commentId: "abc" }).element, null);
});

test("malicious CSS IDs and long common prefixes are compared as literal attributes", () => {
  const h = fixture(); const evil = 'x"] , .comment-item, [id="\\#💥';
  const node = h.row(evil, ""); h.scope.append(node, h.row(evil + "x"));
  assert.equal(match(h, { commentId: evil }).element, node);
  const long = "a".repeat(400); const second = h.row(long + "2");
  h.scope.append(h.row(long + "1"), second);
  assert.equal(match(h, { commentId: long + "2" }).element, second);
  assert.ok(h.selectors.every(selector => !selector.includes(evil) && !selector.includes(long)));
});

test("duplicate native identities and conflicting identity attributes are not guessed", () => {
  const h = fixture(); h.scope.append(h.row(ID), h.row(`comment-${ID}`));
  assert.equal(match(h, { commentId: ID }).reason, "ambiguous");
  h.scope.replaceChildren(h.row(ID, "正文", { attrs: { "comment-id": OTHER } }));
  assert.equal(match(h, { commentId: ID }).reason, "conflicting_id");
});

test("parent-wrapper identity belongs only to its main row, not nested replies", () => {
  const h = fixture(); const main = h.row(null); const reply = h.row(OTHER, "二级回复", { reply: true });
  h.scope.append(h.thread(`comment-${PARENT}`, [main, reply]));
  assert.equal(match(h, { commentId: PARENT }).element, main);
  assert.equal(match(h, { commentId: PARENT, parentCommentId: PARENT }).element, null);
  assert.equal(match(h, { commentId: OTHER, parentCommentId: PARENT }).element, reply);
});

test("identity carriers nested inside a row are deduplicated and highlight the row", () => {
  const h = fixture(); const row = h.row(null);
  row.append(h.el("div", { "data-comment-id": ID })); h.scope.append(row);
  assert.equal(match(h, { commentId: ID }).element, row);
});

test("reply matching respects parent ID and excludes another thread even with the same reply ID", () => {
  const h = fixture(); const wrong = h.row(ID, "相同回复", { reply: true });
  const right = h.row(ID, "相同回复", { reply: true });
  h.scope.append(h.thread(OTHER, [h.row(OTHER), wrong]), h.thread(PARENT, [h.row(PARENT), right]));
  assert.equal(match(h, { commentId: ID, parentCommentId: `comment-${PARENT}` }).element, right);
  right.remove(); assert.equal(match(h, { commentId: ID, parentCommentId: PARENT }).element, null);
});

test("explicit native parent attributes work without thread markup and conflicts fail closed", () => {
  const h = fixture(); const row = h.row(ID, "回复", { attrs: { "data-parent-comment-id": PARENT } });
  h.scope.append(row);
  assert.equal(match(h, { commentId: ID, parentCommentId: PARENT }).element, row);
  h.scope.replaceChildren(h.thread(OTHER, [h.row(OTHER), row]));
  assert.equal(match(h, { commentId: ID, parentCommentId: PARENT }).element, null);
});

test("hidden rows, extension UI, neighboring notes and mismatched bridge note data are excluded", () => {
  const h = fixture();
  const hidden = h.row(ID); hidden.hidden = true;
  h.scope.append(hidden, h.el("aside", { class: "xhs-monitor-process" }, [h.row(ID)]),
    h.el("section", { "data-note-id": "other-note" }, [h.row(ID)]));
  h.document.body.append(h.row(ID));
  assert.equal(match(h, { commentId: ID }).element, null);
  const target = h.row(ID); h.scope.append(target);
  assert.equal(match(h, { commentId: ID, noteId: "other-note" }).reason, "note_mismatch");
  assert.equal(match(h, { commentId: ID }).element, target);
});

test("synthetic IDs must be recomputed, even when a matching dom-* attribute is present", () => {
  const h = fixture(); const row = h.row("dom-forged", "真实正文"); h.scope.append(row);
  assert.equal(match(h, { commentId: "dom-forged" }).element, null);
  row.removeAttribute("data-comment-id");
  const id = idOf("真实正文");
  assert.equal(match(h, { commentId: id }).element, row);
  assert.equal(match(h, { commentId: id }).matchedBy, "stableId");
  assert.equal(match(h, { commentId: id }, { utils: {} }).element, row, "Self-contained hash agrees with current utils");
});

test("stable fallback requires full text plus author uniqueness and never truncates long content", () => {
  const h = fixture(); const row = h.row(null, "全文 末尾"); h.scope.append(row);
  const comment = { commentId: "dom-old-date", content: "全文 末尾", author: "作者甲" };
  assert.equal(match(h, comment).matchedBy, "contentAuthor");
  assert.equal(match(h, { ...comment, author: "" }).element, null);
  assert.equal(match(h, { ...comment, content: "全文" }).element, null);
  row.parts.content.textContent = "a".repeat(9000) + "B";
  assert.equal(match(h, { ...comment, content: "a".repeat(9000) + "A" }).element, null);
  assert.equal(match(h, { ...comment, content: "a".repeat(9000) + "B" }).element, row);
});

test("same text/author, including a duplicate with an explicit ID, is ambiguous", () => {
  const h = fixture(); h.scope.append(h.row(null, "同文"), h.row(OTHER, "同文"));
  assert.equal(match(h, { commentId: "dom-old", content: "同文", author: "作者甲" }).reason, "ambiguous");
  h.scope.replaceChildren(h.row(OTHER, "同文"));
  assert.equal(match(h, { commentId: "dom-old", content: "同文", author: "作者甲" }).reason, "conflicting_id");
  assert.equal(match(h, { commentId: idOf("同文"), content: "同文", author: "作者甲" }).element, null);
});

test("multiple equal stable hashes fail closed; recomputed date may distinguish different hashes", () => {
  const h = fixture(); const first = h.row(null, "同文"); const second = h.row(null, "同文");
  h.scope.append(first, second);
  assert.equal(match(h, { commentId: idOf("同文") }).reason, "ambiguous");
  second.parts.date.textContent = "前天 12:00";
  assert.equal(match(h, { commentId: idOf("同文") }).element, first);
});

test("stable reply IDs are constrained to their parent and do not borrow reply authors/content", () => {
  const h = fixture(); const parent = h.row(null, "父评论"); const reply = h.row(null, "子评论", { reply: true, author: "乙" });
  h.scope.append(h.thread(null, [parent, reply]));
  assert.equal(match(h, { commentId: idOf("子评论", "乙"), parentCommentId: idOf("父评论") }).element, reply);
  assert.equal(match(h, { commentId: "dom-old", content: "子评论", author: "乙", parentCommentId: OTHER }).element, null);
  assert.equal(match(h, { commentId: "dom-old", content: "父评论子评论", author: "作者甲" }).element, null);
});

test("exact image/emoji-only and unloaded-content rows need no body text", () => {
  for (const images of [[], ["photo"], ["emoji"]]) {
    const h = fixture(); const row = h.row(ID, "", { images: images.map(name => h.image(`https://example.invalid/${name}.png`)) });
    h.scope.append(row); assert.equal(match(h, { commentId: ID }).element, row);
  }
});

test("image-only stable IDs include media URLs and ignore avatars", () => {
  const h = fixture(); const url = "https://example.invalid/photo.jpg";
  const row = h.row(null, "", { images: [h.el("div", { class: "avatar" }, [h.image("https://example.invalid/avatar.jpg")]), h.image(url)] });
  h.scope.append(row);
  const id = idOf(`[图片]\u001f${url}`);
  assert.equal(match(h, { commentId: id, content: "[图片]", imageUrls: [url], author: "作者甲" }).matchedBy, "stableId");
  assert.equal(match(h, { commentId: "dom-old", content: "[图片]", author: "作者甲" }).element, null);
  assert.equal(match(h, { commentId: "dom-old", content: "[图片]", imageUrls: [url], author: "作者甲" }).element, row);
  assert.equal(match(h, { commentId: "dom-old", content: "[图片]", imageUrls: [url + "?other"], author: "作者甲" }).element, null);
});

test("emoji alt text and emoji-only placeholders reproduce the existing stable algorithm", () => {
  for (const alt of ["[微笑]", ""]) {
    const h = fixture(); const row = h.row(null, "");
    row.parts.content.append(h.image("https://example.invalid/emoji.png", { class: "emoji", alt }));
    h.scope.append(row);
    assert.equal(match(h, { commentId: idOf(alt || "[表情]") }).element, row);
  }
});

test("loaded targets center immediately, without any loading wait or native control calls", async () => {
  const h = fixture(); const row = h.row(ID); h.scope.append(row);
  const result = await run(h, { commentId: ID }, { utils: { collectionButtons: forbidden, findCommentScroller: forbidden } });
  assert.deepEqual(result, { ok: true, reason: "found", message: "已定位并高亮目标评论", matchedBy: "commentId" });
  assert.equal(h.time, 0); assert.equal(h.observers.size, 0);
  assert.deepEqual(h.actions.map(action => action.kind), ["center"]);
  assert.deepEqual(h.actions[0].options, { block: "center", inline: "nearest", behavior: "instant" });
  assert.ok(row.classList.contains(HIGHLIGHT));
  await h.advance(5999); assert.ok(row.classList.contains(HIGHLIGHT));
  await h.advance(1); assert.ok(!row.classList.contains(HIGHLIGHT)); h.assertIdle();
});

test("secondary replies expand only their parent thread, regardless of DOM order", async () => {
  const h = fixture(); const wrong = h.button("展开 5 条回复"); const parent = h.thread(PARENT, [h.row(PARENT)]);
  const reply = h.row(ID, "目标回复", { reply: true });
  const right = h.button("展开 2 条回复", {}, () => parent.append(reply)); parent.append(right);
  h.scope.append(h.thread(OTHER, [h.row(OTHER), wrong]), parent);
  const result = await run(h, { commentId: ID, parentCommentId: PARENT });
  assert.equal(result.ok, true); assert.deepEqual(clicks(h).map(action => action.node), [right]);
  assert.equal(h.time, 0); assert.equal(scrolls(h).length, 0);
  h.view.dispatchEvent({ type: "pagehide" }); h.assertIdle();
});

test("an unloaded parent uses top-level loaders, then expands only the newly loaded target thread", async () => {
  const h = fixture(); const parent = h.thread(PARENT, [h.row(PARENT)]);
  const nested = h.button("展开回复", {}, () => parent.append(h.row(ID, "回复", { reply: true }))); parent.append(nested);
  const wrong = h.button("展开回复"); h.scope.append(h.thread(OTHER, [h.row(OTHER), wrong]));
  const top = h.button("加载更多评论", {}, () => { top.remove(); h.scope.append(parent); }); h.scope.append(top);
  const promise = run(h, { commentId: ID, parentCommentId: PARENT }); await h.advance(450);
  assert.equal((await promise).ok, true); assert.deepEqual(clicks(h).map(action => action.node), [top, nested]);
  h.view.dispatchEvent({ type: "pagehide" }); h.assertIdle();
});

test("MutationObserver interrupts the render fallback the instant an asynchronous reply appears", async () => {
  const h = fixture(); const parent = h.thread(PARENT, [h.row(PARENT)]);
  const button = h.button("展开回复", {}, () => {
    button.hidden = true;
    h.view.setTimeout(() => parent.append(h.row(ID, "回复", { reply: true })), 17);
  });
  parent.append(button); h.scope.append(parent);
  const promise = run(h, { commentId: ID, parentCommentId: PARENT }); await h.advance(17);
  assert.equal((await promise).ok, true); assert.equal(h.actions.find(action => action.kind === "center").at, 17);
  assert.equal(clicks(h).length, 1); assert.equal(h.observers.size, 0);
  await h.advance(6000); assert.equal(clicks(h).length, 1); h.assertIdle();
});

test("ID-attribute mutations wake the locator, not just inserted rows", async () => {
  const h = fixture(); const row = h.row(OTHER); h.scope.append(row);
  const promise = run(h, { commentId: ID }); await h.advance(9);
  row.setAttribute("data-comment-id", ID); await h.flush();
  assert.equal((await promise).ok, true); assert.equal(h.actions[0].at, 9);
  h.view.dispatchEvent({ type: "pagehide" }); h.assertIdle();
});

test("only native load/retry controls are clicked, including when utils supplies unsafe candidates", async () => {
  const h = fixture(); const safe = h.button("评论加载失败，点击重试", {}, () => h.scope.append(h.row(ID)));
  const unsafe = [h.button("点赞"), h.button("回复"), h.button("展开图片"),
    h.button("加载更多", { class: "like" }), h.button("加载更多", { "aria-label": "点赞" }),
    h.button("加载更多", { disabled: "" }), h.button("加载更多", { "aria-busy": "true" })];
  const inContent = h.button("加载更多"); const content = h.el("div", { class: "content" }, [inContent]);
  const input = h.button("加载更多"); const editable = h.el("div", { contenteditable: "true" }, [input]);
  const image = h.button("加载更多"); const gallery = h.el("div", { class: "gallery" }, [image]);
  const extension = h.button("加载更多"); const ui = h.el("aside", { class: "xhs-monitor-toolbar" }, [extension]);
  const link = h.el("a", { href: "https://example.invalid/leave" }, ["加载更多"]);
  const foreign = h.button("加载更多"); h.document.body.append(foreign);
  const article = h.button("加载更多"); h.root.append(article);
  h.scope.append(...unsafe, content, editable, gallery, ui, link, safe);
  const candidates = [...unsafe, inContent, input, image, extension, link, foreign, article, safe];
  const result = await run(h, { commentId: ID }, { utils: { ...utils, collectionButtons: () => candidates.map(element => ({ element })) } });
  assert.equal(result.ok, true); assert.deepEqual(clicks(h).map(action => action.node), [safe]);
  h.view.dispatchEvent({ type: "pagehide" }); h.assertIdle();
});

test("nested labels are clicked once and unchanged native loaders get bounded retries", async () => {
  const h = fixture(); const label = h.el("span", {}, ["加载更多评论"]); const button = h.el("button", {}, [label]); h.scope.append(button);
  const promise = run(h, { commentId: ID }, { timeoutMs: 2500 }); await h.advance(2500);
  assert.equal((await promise).reason, "not_found");
  assert.equal(clicks(h).length, 3); assert.ok(clicks(h).every(action => action.node === label));
  assert.deepEqual(clicks(h).map(action => action.at), [0, 600, 1200]); h.assertIdle();
});

test("scrolls are bounded steps on the utility-selected owner and stop at synchronous target insertion", async () => {
  const h = fixture(); h.scope.scrollHeight = 2000;
  h.scope.addEventListener("scroll", () => h.scope.append(h.row(ID)));
  const result = await run(h, { commentId: ID });
  assert.equal(result.ok, true); assert.equal(scrolls(h).length, 1);
  assert.equal(scrolls(h)[0].node, h.scope); assert.equal(scrolls(h)[0].options.top, 210);
  assert.equal(scrolls(h)[0].options.behavior, "instant");
  await h.advance(6000); assert.equal(scrolls(h).length, 1); h.assertIdle();
});

test("a virtualized list rewinds at most once and stops before a whole-list traversal", async () => {
  const h = fixture(); h.scope.scrollHeight = 3000; h.scope.scrollTop = 2000;
  h.scope.addEventListener("scroll", () => { if (h.scope.scrollTop === 210) h.scope.append(h.row(ID)); });
  const promise = run(h, { commentId: ID }); await h.advance(450);
  assert.equal((await promise).ok, true);
  assert.deepEqual(scrolls(h).map(action => action.options.top), [0, 210]);
  h.view.dispatchEvent({ type: "pagehide" }); h.assertIdle();
});

test("an unrelated scroll owner returned by an adapter is never scrolled", async () => {
  const h = fixture(); const foreign = h.el("div"); foreign.scrollHeight = 5000; h.document.body.append(foreign);
  const promise = run(h, { commentId: ID }, { utils: { ...utils, findCommentScroller: () => foreign }, timeoutMs: 30 });
  await h.advance(30); assert.equal((await promise).reason, "not_found"); assert.equal(scrolls(h).length, 0); h.assertIdle();
});

test("abort cancels observers, timers and future loading immediately", async () => {
  const h = fixture(); h.scope.scrollHeight = 3000; const controller = h.abortController();
  const promise = run(h, { commentId: ID }, { signal: controller.signal });
  controller.abort(); assert.equal((await promise).reason, "aborted"); h.assertIdle();
  assert.equal(controller.signal.listenerCount(), 0);
  const actionCount = h.actions.length; h.scope.append(h.row(ID)); await h.advance(30000);
  assert.equal(h.actions.length, actionCount); h.assertIdle();
});

test("pre-aborted and stale tasks perform no scroll/click/highlight", async () => {
  const h = fixture(); h.scope.append(h.row(ID)); const controller = h.abortController(); controller.abort();
  assert.equal((await run(h, { commentId: ID }, { signal: controller.signal })).reason, "aborted");
  assert.equal((await run(h, { commentId: ID }, { isCurrent: () => false })).reason, "note_changed");
  assert.equal(h.actions.length, 0); h.assertIdle();
});

test("isCurrent changes cancel within the watchdog interval even without DOM mutations", async () => {
  const h = fixture(); let current = true;
  const promise = run(h, { commentId: ID }, { isCurrent: () => current });
  current = false; await h.advance(75);
  assert.equal((await promise).reason, "note_changed"); h.assertIdle();
});

test("navigation events, changed URL/root note ID and detached roots all cancel", async () => {
  for (const mode of ["pagehide", "popstate", "hashchange", "url", "root-id", "detach"]) {
    const h = fixture(); const promise = run(h, { commentId: ID });
    if (mode === "url") h.view.location.href += "/other";
    else if (mode === "root-id") h.root.setAttribute("data-note-id", "different-note");
    else if (mode === "detach") h.root.remove();
    else h.view.dispatchEvent({ type: mode });
    await h.advance(75); assert.equal((await promise).reason, "note_changed", mode); h.assertIdle();
  }
});

test("a newer locator supersedes the old one, including a different root in the same document", async () => {
  const h = fixture(); const old = run(h, { commentId: OTHER });
  const root = h.el("section", { "data-note-id": NOTE }, [h.el("div", { class: "comments-container" }, [h.row(ID)])]);
  h.document.body.append(root);
  const current = run(h, { commentId: ID }, { root });
  assert.equal((await old).reason, "superseded"); assert.equal((await current).ok, true);
  h.view.dispatchEvent({ type: "pagehide" }); h.assertIdle();
});

test("old highlight cleanup/abort does not erase a newer highlight on the same element", async () => {
  const h = fixture(); const row = h.row(ID); h.scope.append(row); const oldAbort = h.abortController();
  await run(h, { commentId: ID }, { signal: oldAbort.signal });
  const oldCleanup = h.scheduled.find(job => job.ms === 6000).fn;
  await h.advance(100); await run(h, { commentId: ID });
  oldAbort.abort(); oldCleanup(); assert.ok(row.classList.contains(HIGHLIGHT));
  await h.advance(5999); assert.ok(row.classList.contains(HIGHLIGHT));
  await h.advance(1); assert.ok(!row.classList.contains(HIGHLIGHT)); h.assertIdle();
});

test("separate documents locate concurrently and unrelated highlighter classes are preserved", async () => {
  const first = fixture(); const second = fixture(); const one = first.row(ID); const two = second.row(ID);
  const unrelated = first.row(OTHER); unrelated.classList.add(HIGHLIGHT);
  first.scope.append(one, unrelated); second.scope.append(two);
  const results = await Promise.all([run(first, { commentId: ID }), run(second, { commentId: ID })]);
  assert.ok(results.every(result => result.ok));
  first.view.dispatchEvent({ type: "pagehide" });
  assert.ok(unrelated.classList.contains(HIGHLIGHT)); assert.ok(two.classList.contains(HIGHLIGHT));
  await second.advance(6000); first.assertIdle(); second.assertIdle();
});

test("abort or supersession inside onStatus prevents the planned click", async () => {
  for (const supersede of [false, true]) {
    const h = fixture(); const controller = h.abortController(); h.scope.append(h.button("加载更多评论"));
    let next;
    const promise = run(h, { commentId: ID }, { signal: controller.signal, onStatus(status) {
      if (status.phase !== "expanding") return;
      if (supersede) { h.scope.append(h.row(OTHER)); next = run(h, { commentId: OTHER }); }
      else controller.abort();
    } });
    assert.equal((await promise).reason, supersede ? "superseded" : "aborted");
    if (next) assert.equal((await next).ok, true);
    assert.equal(clicks(h).length, 0); h.view.dispatchEvent({ type: "pagehide" }); h.assertIdle();
  }
});

test("target inserted by a status callback is rechecked before any click or scroll", async () => {
  for (const mode of ["expanding", "scrolling"]) {
    const h = fixture(); if (mode === "expanding") h.scope.append(h.button("加载更多评论")); else h.scope.scrollHeight = 2000;
    const result = await run(h, { commentId: ID }, { onStatus(status) { if (status.phase === mode) h.scope.append(h.row(ID)); } });
    assert.equal(result.ok, true); assert.equal(clicks(h).length, 0); assert.equal(scrolls(h).length, 0);
    h.view.dispatchEvent({ type: "pagehide" }); h.assertIdle();
  }
});

test("timeout is an upper bound (20 seconds by default), not a success delay or deletion diagnosis", async () => {
  const h = fixture(); const promise = run(h, { commentId: ID });
  await h.advance(19999); assert.equal(h.observers.size, 1);
  await h.advance(1); const result = await promise;
  assert.equal(result.ok, false); assert.equal(result.reason, "not_found"); assert.match(result.message, /未找到/);
  assert.doesNotMatch(result.message, /已删除|已被删除|确定删除/); h.assertIdle();
  const other = fixture(); other.scope.append(other.row(ID));
  assert.equal((await run(other, { commentId: ID }, { timeoutMs: 0 })).ok, true);
  other.view.dispatchEvent({ type: "pagehide" }); other.assertIdle();
});

test("ambiguous results at timeout stay explicitly unresolved", async () => {
  const h = fixture(); h.scope.append(h.row(ID), h.row(ID));
  const promise = run(h, { commentId: ID }, { timeoutMs: 10 }); await h.advance(10);
  const result = await promise; assert.equal(result.ok, false); assert.equal(result.matchedBy, "");
  assert.match(result.message, /多个匹配项/); assert.equal(h.actions.length, 0); h.assertIdle();
});

test("missing MutationObserver uses short fallbacks and still clears everything", async () => {
  const h = fixture(); delete h.view.MutationObserver;
  const promise = run(h, { commentId: ID }); h.scope.append(h.row(ID)); await h.advance(200);
  assert.equal((await promise).ok, true);
  h.view.dispatchEvent({ type: "pagehide" }); h.assertIdle();
});

test("presentation exceptions are isolated; DOM/utility exceptions settle with structured error and cleanup", async () => {
  const h = fixture(); h.scope.append(h.row(ID));
  assert.equal((await run(h, { commentId: ID }, { onStatus: () => { throw new Error("UI failure"); } })).ok, true);
  h.view.dispatchEvent({ type: "pagehide" }); h.assertIdle();
  const broken = fixture();
  const result = await run(broken, { commentId: ID }, { utils: { collectionButtons: () => { throw new Error("DOM failure"); } } });
  assert.equal(result.reason, "error"); assert.equal(result.ok, false); broken.assertIdle();
});

test("invalid root/ID/note input is structured and comment input is never mutated", async () => {
  assert.equal((await locator.locate()).reason, "invalid_input");
  const h = fixture(); h.scope.append(h.row(ID)); const comment = Object.freeze({ commentId: ID, noteId: NOTE });
  assert.equal((await run(h, comment)).ok, true);
  assert.equal(match(h, {}).reason, "invalid_comment");
  assert.equal((await run(h, { commentId: ID, noteId: "different" })).reason, "note_mismatch");
  h.assertIdle();
});

test("identity-only parent wrappers without a thread class bind only their unique main row", () => {
  for (const attributes of [{ "data-comment-id": PARENT }, { id: `comment-${PARENT}` }]) {
    const h = fixture(); const main = h.row(null); const reply = h.row(ID, "回复", { reply: true });
    h.scope.append(h.el("div", attributes, [main, reply]));
    assert.equal(match(h, { commentId: PARENT }).element, main);
    assert.equal(match(h, { commentId: ID, parentCommentId: PARENT }).element, reply);
  }
});

test("ambiguous parent markup cannot be overridden by a reply's declared parent ID", () => {
  const h = fixture(); const reply = h.row(ID, "回复", { reply: true, attrs: { "data-parent-comment-id": PARENT } });
  h.scope.append(h.thread(OTHER, [h.row(OTHER), h.row(PARENT), reply]));
  assert.equal(match(h, { commentId: ID, parentCommentId: PARENT }).element, null);
});

test("content wrappers containing nested replies are not treated as a parent's own full body", () => {
  const h = fixture(); const parent = h.row(null, "父正文");
  const reply = h.row(null, "子正文", { reply: true, author: "乙" });
  parent.parts.content.append(reply); h.scope.append(h.thread(null, [parent]));
  const polluted = parent.parts.content.textContent;
  assert.equal(match(h, { commentId: "dom-old", content: polluted, author: "作者甲" }).element, null);
  reply.hidden = true;
  assert.equal(match(h, { commentId: "dom-old", content: polluted, author: "作者甲" }).element, null);
});

test("parent permalink IDs work without leaking a reply permalink into the main identity", () => {
  const h = fixture(); const main = h.row(null); const reply = h.row(null, "回复", { reply: true });
  main.append(h.el("a", { href: `https://example.invalid/note?comment_id=${PARENT}` }));
  reply.append(h.el("a", { href: `https://example.invalid/note?commentId=${ID}` }));
  main.append(h.el("div", { class: "reply-container" }, [reply])); h.scope.append(h.thread(null, [main]));
  assert.equal(match(h, { commentId: PARENT }).element, main);
  assert.equal(match(h, { commentId: ID, parentCommentId: PARENT }).element, reply);
});

test("inherited actionable labels and empty contenteditable attributes cannot disguise unsafe loaders", async () => {
  const h = fixture(); const controls = [];
  for (const attributes of [{ "aria-label": "回复" }, { "aria-label": "展开图片" }]) {
    const label = h.el("span", {}, ["加载更多"]); controls.push(label);
    h.scope.append(h.el("button", attributes, [label]));
  }
  const edit = h.button("加载更多"); h.scope.append(h.el("div", { contenteditable: "" }, [edit])); controls.push(edit);
  const photo = h.image("https://example.invalid/image.jpg", { "aria-label": "加载更多" }); h.scope.append(photo); controls.push(photo);
  const resultPromise = run(h, { commentId: ID }, { utils: { ...utils, collectionButtons: () => controls }, timeoutMs: 20 });
  await h.advance(20); assert.equal((await resultPromise).reason, "not_found"); assert.equal(clicks(h).length, 0); h.assertIdle();
});

test("a nested native loader label bubbles one click to its owning button", async () => {
  const h = fixture(); const label = h.el("span", {}, ["加载更多评论"]);
  const button = h.el("button", {}, [label]); button.addEventListener("click", () => h.scope.append(h.row(ID)));
  h.scope.append(button); assert.equal((await run(h, { commentId: ID })).ok, true);
  assert.deepEqual(clicks(h).map(action => action.node), [label]);
  h.view.dispatchEvent({ type: "pagehide" }); h.assertIdle();
});

test("replaced loader elements do not reset retries when their thread made no progress", async () => {
  const h = fixture();
  function loader() {
    const button = h.button("加载更多评论", {}, () => { button.remove(); h.scope.append(loader()); });
    return button;
  }
  h.scope.append(loader()); const promise = run(h, { commentId: ID }, { timeoutMs: 2500 });
  await h.advance(2500); assert.equal((await promise).reason, "not_found");
  assert.deepEqual(clicks(h).map(action => action.at), [0, 600, 1200]); h.assertIdle();
});

test("native reply pagination may advance immediately after actual thread progress", async () => {
  const h = fixture(); const parent = h.thread(PARENT, [h.row(PARENT)]); let page = 0;
  const button = h.button("展开更多回复", {}, () => {
    parent.append(h.row(++page === 3 ? ID : `intermediate-${page}`, "回复", { reply: true }));
  }); parent.append(button); h.scope.append(parent);
  const promise = run(h, { commentId: ID, parentCommentId: PARENT }); await h.advance(900);
  assert.equal((await promise).ok, true); assert.deepEqual(clicks(h).map(action => action.at), [0, 450, 900]);
  h.view.dispatchEvent({ type: "pagehide" }); h.assertIdle();
});

test("a status callback moving a loader into another thread invalidates the planned click", async () => {
  const h = fixture(); const button = h.button("展开回复");
  const parent = h.thread(PARENT, [h.row(PARENT), button]); const other = h.thread(OTHER, [h.row(OTHER)]);
  h.scope.append(parent, other);
  const promise = run(h, { commentId: ID, parentCommentId: PARENT }, { timeoutMs: 50, onStatus(status) {
    if (status.phase === "expanding") other.append(button);
  } }); await h.advance(50);
  assert.equal((await promise).reason, "not_found"); assert.equal(clicks(h).length, 0); h.assertIdle();
});

test("root/scroller replacement during status reporting invalidates the planned scroll", async () => {
  const h = fixture(); h.scope.scrollHeight = 2000;
  const promise = run(h, { commentId: ID }, { timeoutMs: 50, onStatus(status) {
    if (status.phase === "scrolling") h.scope.remove();
  } }); await h.advance(50);
  assert.equal((await promise).reason, "not_found"); assert.equal(scrolls(h).length, 0); h.assertIdle();
});

test("isCurrent/abort invalidation during centering never applies a stale highlight", async () => {
  const h = fixture(); const controller = h.abortController(); const row = h.row(ID); h.scope.append(row);
  row.onCenter = () => controller.abort();
  assert.equal((await run(h, { commentId: ID }, { signal: controller.signal })).reason, "aborted");
  assert.ok(!row.classList.contains(HIGHLIGHT)); h.assertIdle();
});

test("observer setup failure resolves a structured error and releases navigation/abort listeners", async () => {
  const h = fixture(); const controller = h.abortController();
  h.view.MutationObserver = class { observe() { throw new Error("Observer unavailable"); } disconnect() {} };
  const result = await run(h, { commentId: ID }, { signal: controller.signal });
  assert.equal(result.reason, "error"); h.assertIdle(); assert.equal(controller.signal.listenerCount(), 0);
});

test("a delayed mutation after the logical deadline is not promoted to a late success", async () => {
  const h = fixture(); const promise = run(h, { commentId: ID }, { timeoutMs: 20 });
  h.time = 30; // Model a blocked browser task before overdue timer dispatch.
  h.scope.append(h.row(ID)); await h.flush();
  assert.equal((await promise).reason, "not_found"); assert.equal(h.actions.length, 0); h.assertIdle();
});

// Freeze-gate contracts: execute the current content/worker entrypoints, not
// replicas. Only browser/bridge transport is replaced; no app bootstrap, DB,
// platform request, background collection or production file write is run.
function entryDeclaration(source, name, indent = "") {
  const start = source.search(new RegExp(`^${indent}(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `Missing integrated entrypoint: ${name}`);
  const end = source.indexOf(`\n${indent}}`, start);
  assert.ok(end > start, `Missing integrated entrypoint boundary: ${name}`);
  return source.slice(start, end + indent.length + 2);
}

function integratedContent(h, noteId, marker = "xhs_monitor_locate=1") {
  h.root.setAttribute("data-note-id", noteId);
  h.view.location.href = `https://www.xiaohongshu.com/explore/${noteId}?${marker}`;
  const toasts = [];
  const source = readFileSync(join(__dirname, "../content.js"), "utf8").replace(/\r\n/g, "\n");
  const page = vm.createContext({
    URL, Date, AbortController, window: h.view, location: h.view.location,
    commentLocatorSurface: marker === "xhs_monitor_locate=1", activePageRead: null,
    clearTimeout: h.view.clearTimeout, scanTimer: null, deepScanTimer: null, pendingScan: false, deepScanQueued: false,
    CONTENT_VERSION: "locator-contract", __XHS_MONITOR_CONTENT_VERSION__: "locator-contract",
    DETAIL_READY_TIMEOUT_MS: 100, commentUtils: utils, XhsMonitorCommentLocator: locator,
    noteIdFromUrl: value => new URL(value).pathname.split("/").filter(Boolean).at(-1),
    detailRootForNote: () => h.root,
    showPageToast: (message, variant) => toasts.push({ message, variant }),
    waitFor: forbidden, fetch: forbidden, scheduleScan: forbidden, readNoteInPage: forbidden,
    chrome: new Proxy({}, { get: forbidden })
  });
  vm.runInContext(entryDeclaration(source, "isCommentLocatorSurface", "  ")
    + "\nlet commentLocationTask = null;\n"
    + entryDeclaration(source, "locateCommentInPage", "  "), page);
  return { page, toasts };
}

test("freeze gate: canonical DB target traverses actual worker -> content -> locator against prefixed DOM ID", async () => {
  const h = fixture(); const noteId = "65aabbccddeeff0011223344";
  const { page } = integratedContent(h, noteId);
  const node = h.row(`comment-${ID}`, "DOM 中的完整正文"); h.scope.append(node);
  const comment = Object.freeze({ commentId: ID, noteId, content: "数据库旧正文", author: "数据库旧作者" });
  const target = { ok: true, note: { noteId }, comment };
  const calls = [];
  const source = readFileSync(join(__dirname, "../service-worker.js"), "utf8").replace(/\r\n/g, "\n");
  const worker = vm.createContext({
    URL, Date, Map, Promise, DETAIL_LOAD_TIMEOUT_MS: 100, CONTENT_SCRIPT_VERSION: "locator-contract",
    commentNavigationTasks: new Map(), delay: forbidden, fetch: forbidden,
    bridgeApi: async route => { calls.push(["bridge", route]); return target; },
    chrome: { tabs: {
      create: async args => { calls.push(["create", args]); h.view.location.href = args.url; return { id: 42 }; },
      get: async id => ({ id, url: h.view.location.href }),
      sendMessage: async (id, message) => {
        calls.push(["message", id, message.type]);
        if (message.type === "getPageInfo") return { contentVersion: "locator-contract" };
        assert.equal(message.type, "locateCommentInPage");
        assert.equal(message.comment, comment, "The exact canonical bridge record is passed through");
        return page.locateCommentInPage(message);
      }
    } }
  });
  vm.runInContext(["commentLocatorUrl", "openCommentInPage"].map(name => entryDeclaration(source, name)).join("\n"), worker);
  const result = await worker.openCommentInPage(ID);
  assert.equal(result.ok, true); assert.equal(result.reason, "found"); assert.equal(result.matchedBy, "commentId");
  assert.equal(result.tabId, 42); assert.equal(result.error, undefined);
  assert.deepEqual(calls.filter(call => call[0] === "bridge"), [["bridge", `/api/data-overview/comment-target?commentId=${ID}`]]);
  assert.equal(calls.filter(call => call[0] === "create").length, 1);
  assert.equal(new URL(h.view.location.href).searchParams.get("xhs_monitor_locate"), "1");
  assert.equal(worker.commentNavigationTasks.size, 0);
  assert.deepEqual(h.actions.map(action => action.kind), ["center"]);
  assert.ok(node.classList.contains(HIGHLIGHT));
  h.view.dispatchEvent({ type: "pagehide" }); h.assertIdle();
});

test("freeze gate: actual content accepts only the strict locator marker, never batch or ordinary pages", async () => {
  for (const marker of ["", "xhs_monitor_batch=1", "xhs_monitor_locate=0", "xhs_monitor_locate=true", "xhs_monitor_locate=1x"]) {
    const h = fixture(); const { page, toasts } = integratedContent(h, NOTE, marker); h.scope.append(h.row(ID));
    const result = await page.locateCommentInPage({ note: { noteId: NOTE }, comment: { noteId: NOTE, commentId: ID } });
    assert.equal(result.ok, false, marker); assert.match(result.error, /独立定位页/);
    assert.equal(h.actions.length, 0); assert.equal(toasts.length, 0); h.assertIdle();
  }
});

test("freeze gate: actual content navigation guard cancels the active module and releases listeners", async () => {
  const h = fixture(); const { page, toasts } = integratedContent(h, NOTE);
  const promise = page.locateCommentInPage({ note: { noteId: NOTE }, comment: { noteId: NOTE, commentId: ID } });
  h.view.location.href = "https://www.xiaohongshu.com/explore/another-note?xhs_monitor_locate=1";
  await h.advance(75);
  const result = await promise;
  assert.equal(result.ok, false); assert.equal(result.reason, "note_changed");
  assert.equal(toasts.length, 1, "No stale completion toast on the new page");
  assert.equal(h.actions.length, 0); h.assertIdle();
});



test("native ID absent permits unique FULL content+author, never ID conflict or partial text", () => {
  const h=fixture(); const row=h.row(null,"完整唯一正文");h.scope.append(row);
  const target={commentId:ID,content:"完整唯一正文",author:"作者甲"};
  assert.equal(match(h,target).element,row);assert.equal(match(h,target).matchedBy,"contentAuthor");
  assert.equal(match(h,{...target,content:"完整"}).element,null);
  row.setAttribute("data-comment-id",OTHER);assert.equal(match(h,target).element,null);
});
test("explicit comment identity is not vetoed by unrelated presentation ID",()=>{
  const h=fixture();const row=h.row(ID,"正文",{attrs:{id:"virtual-row-12"}});h.scope.append(row);
  assert.equal(match(h,{commentId:ID}).element,row);
});
test("locator page remains read-only when SPA removes its query marker",async()=>{
  const h=fixture();const {page}=integratedContent(h,NOTE);h.scope.append(h.row(ID));
  h.view.location.href=h.view.location.href.split("?")[0];
  assert.equal(page.isCommentLocatorSurface(),true);
  assert.equal((await page.locateCommentInPage({note:{noteId:NOTE},comment:{noteId:NOTE,commentId:ID}})).ok,true);
  await h.advance(6000);assert.ok(h.scope.querySelector("."+HIGHLIGHT));
  await h.advance(54000);h.assertIdle();
});
test("locator waits for cancelled collector cleanup before it centers the comment",async()=>{
  const h=fixture();const {page}=integratedContent(h,NOTE);h.scope.append(h.row(ID));
  let release;page.activePageRead={cancelled:false,promise:new Promise(resolve=>{release=resolve;})};
  const promise=page.locateCommentInPage({note:{noteId:NOTE},comment:{noteId:NOTE,commentId:ID}});
  assert.equal(page.activePageRead.cancelled,true);assert.equal(h.actions.length,0);
  release();await h.flush();assert.equal((await promise).ok,true);assert.equal(h.actions[0].kind,"center");
  h.view.dispatchEvent({type:"pagehide"});h.assertIdle();
});
test("actual scan/read/sync entrypoints reject work on a locator surface",async()=>{
  const source=readFileSync(join(__dirname,"../content.js"),"utf8").replace(/\r\n/g,"\n");
  const page=vm.createContext({isCommentLocatorSurface:()=>true,Promise});
  for(const name of ["scan","scheduleScan","scheduleDeepScan","performDeepScan","readNoteInPage","auditPulledComments"])
    vm.runInContext(entryDeclaration(source,name,"  "),page);
  assert.equal((await page.scan()).skipped,true);assert.equal((await page.performDeepScan()).skipped,true);
  assert.equal((await page.readNoteInPage()).cancelled,true);
  page.scheduleScan();page.scheduleDeepScan();await page.auditPulledComments();
});

test("native rerender transfers highlight to exact replacement without loading or scrolling",async()=>{
  const h=fixture();const old=h.row(ID);h.scope.append(old);await run(h,{commentId:ID});
  const fresh=h.row(ID);h.scope.replaceChildren(fresh);await h.advance(75);
  assert.ok(fresh.classList.contains(HIGHLIGHT));assert.ok(!old.classList.contains(HIGHLIGHT));
  assert.equal(h.actions.length,1);await h.advance(6000);h.assertIdle();
});
test("early document-start marker survives URL cleanup before idle content startup",()=>{
  const manifest=JSON.parse(readFileSync(join(__dirname,"../manifest.json"),"utf8"));
  assert.ok(manifest.content_scripts.some(x=>x.run_at==="document_start"&&x.js.includes("comment-locator-mode.js")));
  const source=readFileSync(join(__dirname,"../comment-locator-mode.js"),"utf8");
  const context=vm.createContext({URL,location:{href:"https://www.xiaohongshu.com/explore/abc?xhs_monitor_locate=1"}});
  vm.runInContext(source,context);context.location.href=context.location.href.split("?")[0];
  assert.equal(context.__XHS_MONITOR_COMMENT_LOCATOR_SURFACE__,true);
  vm.runInContext(source,context);assert.equal(context.__XHS_MONITOR_COMMENT_LOCATOR_SURFACE__,true);
});
