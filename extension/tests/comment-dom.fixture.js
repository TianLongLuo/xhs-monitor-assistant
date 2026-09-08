"use strict";
// Synthetic DOM only. Images are blocked by CSP; their attributes model data
// visible to the production extractor without downloading anything.
const utils = XhsMonitorCommentUtils;
const note = { noteId: "note-fixture", authorId: "owner", author: "帖子作者", url: "https://example.invalid/note" };
const tests = [];
const test = (name, run) => tests.push({ name, run });
const assert = (value, message = "assertion failed") => { if (!value) throw new Error(message); };
const equal = (actual, expected) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} ≠ ${JSON.stringify(expected)}`);
const mount = document.querySelector("#mount");
function item(id, content = "真实评论", options = {}) {
  return `<div class="comment-item ${options.reply ? "comment-item-sub" : ""}" id="${id}">
    <a class="avatar" href="https://www.xiaohongshu.com/user/profile/user-${id}"><img src="https://example.invalid/avatar-${id}.jpg"></a>
    <div class="info"><a class="name" href="https://www.xiaohongshu.com/user/profile/user-${id}">用户${id}</a>
    <div class="content">${content}</div>${options.images || ""}<div class="date">昨天 18:47 广东</div>
    <div class="actions"><span class="like">赞 2</span><span class="reply">回复</span></div></div></div>`;
}
function root(body, total = 1) {
  const element = document.createElement("section");
  element.className = "fixture-root";
  element.setAttribute("data-note-id", note.noteId);
  element.innerHTML = `<div class="comments-container">${total === null ? "" : `<div class="total">共 ${total} 条评论</div>`}${body}</div>`;
  mount.replaceChildren(element);
  return element;
}

// Minimal structure copied from the native DOM observed on the reported note.
// No real content, media, identifiers or source URLs are included in fixtures.
const nativeEmptyMarkup = '<div class="no-comments"><p class="no-comments-text"> 这是一片荒地<span class="focus-comments">点击评论</span></p></div>';
function emptyLayout(body = nativeEmptyMarkup, count = "评论") {
  const element = root("", null);
  element.innerHTML = '<div class="note-content"><h1>测试帖子 1</h1></div>'
    + `<div class="comments-el">${body}</div>`
    + '<div class="interactions"><div class="engage-bar-style">'
    + '<span class="like-wrapper"><span class="count">5</span></span>'
    + '<span class="collect-wrapper"><span class="count">1</span></span>'
    + `<span class="chat-wrapper"><span class="count">${count}</span></span></div></div>`;
  return element;
}

test("真实零评论布局：荒地提示无需评论总数即可核验，且不进入第二轮补读", async () => {
  const element = emptyLayout();
  const extracted = utils.extractComments(element, note);
  equal(extracted.comments.length, 0); equal(extracted.expectedCount, 0);
  equal(extracted.expectedCountKnown, true); equal(extracted.expectedCountSource, "native_empty_state");
  equal(extracted.explicitEmpty, true);
  const progress = [];
  const adapter = utils.createCollectionAdapter(() => element, note, { onProgress: value => progress.push(value) });
  const started = performance.now();
  try {
    const result = await XhsMonitorCommentCollector.collect(adapter, { noteId: note.noteId });
    equal(result.status, "likely_complete"); equal(result.explicitEmptyVerified, true);
    equal(result.expectedCountKnown, true); equal(result.collectionEvidence.passes, 1);
    equal(result.collectionEvidence.retryCount, 0); assert(result.collectionEvidence.stableRounds >= 2);
    equal(progress.at(-1).expectedCountKnown, true); equal(progress.at(-1).expectedCount, 0);
    document.querySelector("#metrics").textContent += `真实空评论布局：${Math.round(performance.now() - started)}ms；`;
  } finally { adapter.restore(); }
});

test("只有底部评论按钮、空白区域或数字 0，不擅自判定空评论", () => {
  for (const label of ["评论", "0", "1.2万"]) {
    const element = emptyLayout("", label);
    const count = utils.readCommentCount(element);
    equal(count.explicitEmpty, false); equal(count.expectedCountKnown, label === "0");
    equal(count.expectedCount, 0); // Likes/collections/title digits are unrelated.
  }
});

test("隐藏的空提示，以及正文或真实评论中的同名句子不作为零评论证据", () => {
  let element = emptyLayout(`<div hidden>${nativeEmptyMarkup}</div>`);
  equal(utils.hasExplicitEmptyState(element), false);
  element.querySelector(".note-content").insertAdjacentHTML("beforeend", nativeEmptyMarkup);
  equal(utils.hasExplicitEmptyState(element), false);
  element = root(item("quote-empty", nativeEmptyMarkup), null);
  equal(utils.hasExplicitEmptyState(element), false);
  equal(utils.extractComments(element, note).comments.length, 1);
});

test("零评论加载完成后即时核验，不把正文视频加载误判为评论加载", async () => {
  const element = emptyLayout('<div class="loading">加载中</div>');
  element.querySelector(".note-content").insertAdjacentHTML("beforeend", '<div class="loading">视频加载中</div>');
  const adapter = utils.createCollectionAdapter(() => element, note);
  equal(adapter.read().explicitEmpty, false); equal(adapter.read().loading, true);
  const timer = setTimeout(() => { element.querySelector(".comments-el").innerHTML = nativeEmptyMarkup; }, 120);
  try {
    const result = await XhsMonitorCommentCollector.collect(adapter, { noteId: note.noteId, timeoutMs: 3000 });
    equal(result.status, "likely_complete"); equal(result.explicitEmptyVerified, true);
    equal(result.collectionEvidence.passes, 1); equal(adapter.read().loading, false);
  } finally { clearTimeout(timer); adapter.restore(); }
});

test("原生空提示仍处于加载中时，不提前宣告完整或删除旧评论", async () => {
  const element = emptyLayout(nativeEmptyMarkup + '<div class="loading">加载中</div>');
  const adapter = utils.createCollectionAdapter(() => element, note);
  try {
    const result = await XhsMonitorCommentCollector.collect(adapter, { noteId: note.noteId, timeoutMs: 900, maxPasses: 1, stallMs: 30 });
    equal(result.status, "partial"); equal(result.explicitEmptyVerified, false);
    equal(result.collectionEvidence.pendingLoads, true);
  } finally { adapter.restore(); }
});

test("原生空提示与正数计数冲突时保留历史，而不是静默当作零条", async () => {
  const element = emptyLayout(nativeEmptyMarkup, "3");
  const count = utils.readCommentCount(element);
  equal(count.expectedCount, 3); equal(count.countConflict, true); equal(count.explicitEmpty, false);
  const adapter = utils.createCollectionAdapter(() => element, note);
  try {
    const result = await XhsMonitorCommentCollector.collect(adapter, { noteId: note.noteId, timeoutMs: 900, maxPasses: 1, stallMs: 30 });
    equal(result.status, "partial"); equal(result.explicitEmptyVerified, false);
    assert(result.commentError.includes("冲突"));
  } finally { adapter.restore(); }
});

test("评论标题计数缺失时，精确原生底栏计数支持完整核验", async () => {
  const element = emptyLayout(item("footer-1") + item("footer-2"), "2");
  const count = utils.readCommentCount(element);
  equal(count.expectedCount, 2); equal(count.expectedCountSource, "comment_footer");
  const adapter = utils.createCollectionAdapter(() => element, note);
  try {
    const result = await XhsMonitorCommentCollector.collect(adapter, { noteId: note.noteId });
    equal(result.status, "likely_complete"); equal(result.comments.length, 2);
  } finally { adapter.restore(); }
});

test("正数评论头尾计数不一致时即使已读数量匹配，也保留冲突信息", () => {
  const element = emptyLayout(`<div class="comments-container"><div class="total">共 2 条评论</div>${item("conflict-1")}${item("conflict-2")}</div>`, "1");
  const result = utils.extractComments(element, note);
  equal(result.expectedCount, 2); equal(result.countConflict, true); equal(result.status, "partial");
});

test("读取真实文字、作者、时间和评论 ID", () => {
  const result = utils.extractComments(root(item("comment-c1")), note);
  equal(result.comments.length, 1); equal(result.expectedCount, 1); equal(result.unreadableCount, 0);
  equal(result.comments[0].content, "真实评论"); equal(result.comments[0].author, "用户comment-c1");
  equal(result.comments[0].commentId, "comment-c1");
  assert(result.comments[0].timeObservedAt);
});
test("纯图片评论纳入总数，头像不冒充内容图片", () => {
  const result = utils.extractComments(root(item("photo", "", { images: '<div class="pictures"><img src="https://example.invalid/photo.jpg"></div>' })), note);
  equal(result.comments.length, 1); equal(result.comments[0].content, "[图片]");
  equal(result.comments[0].imageUrls, ["https://example.invalid/photo.jpg"]);
});
test("纯表情评论保持可读含义", () => {
  const result = utils.extractComments(root(item("emoji", '<img class="emoji" alt="[微笑]" src="https://example.invalid/emoji.png">')), note);
  equal(result.comments.length, 1); equal(result.comments[0].content, "[微笑]"); equal(result.comments[0].imageUrls, []);
});
test("只有头像、正文未加载的评论阻止完整性声明", () => {
  const result = utils.extractComments(root(item("loading-item", "")), note);
  equal(result.comments.length, 0); equal(result.unreadableCount, 1);
});
test("图片主评论与文字子评论的作者及父 ID 不串行", () => {
  const result = utils.extractComments(root(`<div class="parent-comment">${item("main", "", { images: '<div class="pictures"><img src="https://example.invalid/main.jpg"></div>' })}${item("sub", "子评论内容", { reply: true })}</div>`, 2), note);
  equal(result.comments.length, 2);
  equal(result.comments[0].content, "[图片]"); equal(result.comments[1].parentCommentId, "main");
  equal(result.comments[1].commentLevel, 2); equal(result.comments[1].author, "用户sub");
});
test("父评论缺失正文时，不拿子评论正文或图片充数", () => {
  const element = root(item("main", ""), 2);
  element.querySelector("#main").insertAdjacentHTML("beforeend", item("sub", "子评论", { reply: true }));
  const result = utils.extractComments(element, note);
  equal(result.comments.length, 1); equal(result.comments[0].commentId, "sub"); equal(result.unreadableCount, 1);
});
test("相同正文但不同真实 ID 保留为两条评论", () => {
  const result = utils.extractComments(root(item("same1", "相同") + item("same2", "相同"), 2), note);
  equal(result.comments.map((comment) => comment.commentId), ["same1", "same2"]);
});
test("ID 在父级线程包装时保留主评论身份，子评论不借用父 ID", () => {
  const element = root(`<div class="parent-comment" data-comment-id="thread-main">${item("temporary", "主评论")}${item("thread-sub", "子评论", { reply: true })}</div>`, 2);
  element.querySelector("#temporary").removeAttribute("id");
  const result = utils.extractComments(element, note);
  equal(result.comments.map((comment) => comment.commentId), ["thread-main", "thread-sub"]);
  equal(result.comments[1].parentCommentId, "thread-main"); equal(result.unreadableCount, 0);
});
test("用户正文恰好是回复或展开时仍然保留", () => {
  const result = utils.extractComments(root(item("literal", "回复") + item("literal2", "展开"), 2), note);
  equal(result.comments.map((comment) => comment.content), ["回复", "展开"]);
});
test("支持带千位分隔符的评论总数", () => {
  equal(utils.extractExpectedCount(root(item("c1"), "1,234")), 1234);
});
test("用户评论提到总数或暂无评论，不成为页面完整性证据", () => {
  const element = root(item("c1", "共 9000 条评论 暂无评论"), null);
  equal(utils.extractExpectedCount(element), 0); equal(utils.hasExplicitEmptyState(element), false);
});
test("原生空状态与未加载区分", () => {
  equal(utils.hasExplicitEmptyState(root('<div class="comment-empty">暂无评论，快来评论吧</div>', 0)), true);
  equal(utils.hasExplicitEmptyState(root('<div class="loading">加载中</div>', null)), false);
});
test("p / span 嵌套展开按钮只点击一次，兼容箭头与空格", () => {
  const element = root(`${item("c1")}<p class="show-more"><span>展开 10 条回复 ▼</span></p>`, 11);
  const controls = utils.collectionButtons(element);
  equal(controls.length, 1); equal(controls[0].element.tagName, "SPAN");
});
test("更多评论、失败重试可识别；回复正文与收起按钮不误点", () => {
  const element = root(`${item("c1", "展开更多")}<button>查看更多评论</button><p>加载失败，点击重试</p><button>收起</button>`, 2);
  equal(utils.collectionButtons(element).map((control) => control.kind), ["expand", "retry"]);
});
test("禁用按钮保留为未完成证据但不会被再次点击", () => {
  const element = root(`${item("c1")}<button disabled><span>展开 1 条回复</span></button>`, 2);
  const adapter = utils.createCollectionAdapter(() => element, note);
  const snapshot = adapter.read();
  equal(snapshot.controls.length, 1); equal(snapshot.controls[0].disabled, true);
  equal(adapter.click(snapshot.controls[0]), false);
});
test("正确识别根滚动器，而不是名称相似但不滚动的节点", () => {
  const element = root(`<div class="note-scroller">无滚动占位</div>${Array.from({ length: 12 }, (_, n) => item(`c${n}`)).join("")}`, 12);
  element.style.height = "220px";
  equal(utils.findCommentScroller(element) === element, true);
  const adapter = utils.createCollectionAdapter(() => element, note);
  equal(adapter.read().atBottom, false); assert(adapter.scroll("next")); assert(element.scrollTop > 0);
  adapter.restore(); equal(element.scrollTop, 0);
});
test("评论外的媒体加载指示器不阻止完成，评论内加载指示器会阻止", () => {
  const element = root(item("c1"));
  element.insertAdjacentHTML("afterbegin", '<div class="loading">视频加载中</div>');
  const adapter = utils.createCollectionAdapter(() => element, note);
  equal(adapter.read().loading, false);
  element.querySelector(".comments-container").insertAdjacentHTML("beforeend", '<div class="loading">加载评论中</div>');
  equal(adapter.read().loading, true);
});
test("评论尚未挂载时仍能找到正文滚动器，触发底部懒加载", () => {
  const element = root("", null);
  element.innerHTML = '<div class="note-scroller" style="height:200px;overflow-y:auto"><p style="height:800px">长正文，评论将在滚动后挂载</p></div>';
  const scroller = element.querySelector(".note-scroller");
  equal(utils.findCommentScroller(element) === scroller, true);
  const adapter = utils.createCollectionAdapter(() => element, note);
  equal(adapter.read().atBottom, false); assert(adapter.scroll("next")); assert(scroller.scrollTop > 0);
  adapter.restore(); equal(scroller.scrollTop, 0);
});
test("真实 DOM 异步展开：先消失的按钮不会导致提前结束", async () => {
  const element = root(`<div class="parent-comment">${item("main")}<p class="show-more">展开 1 条回复</p></div>`, 2);
  const button = element.querySelector(".show-more");
  let clicks = 0;
  button.addEventListener("click", () => {
    clicks += 1; button.remove();
    setTimeout(() => element.querySelector(".parent-comment").insertAdjacentHTML("beforeend", item("sub", "延迟回复", { reply: true })), 1700);
  });
  const adapter = utils.createCollectionAdapter(() => element, note);
  const result = await XhsMonitorCommentCollector.collect(adapter, { noteId: note.noteId, settleMs: 650, stallMs: 3500, timeoutMs: 12000 });
  equal(result.status, "likely_complete"); equal(result.comments.length, 2); equal(clicks, 1);
  equal(result.comments[1].parentCommentId, "main"); adapter.restore();
});

test("静止 DOM 重复读取使用缓存，最终强制校验与内容变化必定重新读", () => {
  const element = root(Array.from({ length: 40 }, (_, i) => item(`cache-${i}`)).join(""), 40);
  const adapter = utils.createCollectionAdapter(() => element, note);
  adapter.read();
  for (let i = 0; i < 20; i++) adapter.read();
  equal(adapter.getDiagnostics().fullReads, 1);
  equal(adapter.getDiagnostics().cachedReads, 20);
  adapter.read({ force: true }); equal(adapter.getDiagnostics().fullReads, 2);
  element.querySelector(".content").textContent = "已编辑的评论";
  equal(adapter.read().comments[0].content, "已编辑的评论");
  equal(adapter.getDiagnostics().fullReads, 3);
  element.querySelector(".comment-item").setAttribute("id", "new-stable-id");
  equal(adapter.read().comments[0].commentId, "new-stable-id");
  adapter.restore();
});

test("DOM 变化立即唤醒等待，取消时清理监听与定时器", async () => {
  const element = root(item("wake"));
  const adapter = utils.createCollectionAdapter(() => element, note);
  adapter.read();
  let woke = false;
  const wake = adapter.waitForChange(5000).then(() => { woke = true; });
  element.querySelector(".content").textContent = "新内容到了";
  await wake;
  equal(woke, true); equal(adapter.read().comments[0].content, "新内容到了");
  let disposed = false;
  const pending = adapter.waitForChange(5000).then(() => { disposed = true; });
  adapter.restore(); await pending; equal(disposed, true);
});

test("独立回复组限量并发，纯 DOM 快路径仍完整保留全部父子关系", async () => {
  const count = 6;
  const element = root(Array.from({ length: count }, (_, i) => `<div class="parent-comment">${item(`parallel-${i}`)}<p class="show-more" data-group="${i}">展开 1 条回复</p></div>`).join(""), count * 2);
  let active = 0, peak = 0;
  element.querySelectorAll(".show-more").forEach((button) => button.addEventListener("click", () => {
    const group = button.dataset.group;
    const wrapper = button.parentElement;
    button.remove();
    wrapper.insertAdjacentHTML("beforeend", '<span class="loading">评论加载中</span>');
    peak = Math.max(peak, ++active);
    setTimeout(() => {
      wrapper.querySelector(".loading").remove();
      wrapper.insertAdjacentHTML("beforeend", item(`parallel-sub-${group}`, "已返回回复", { reply: true }));
      active -= 1;
    }, 350);
  }));
  const adapter = utils.createCollectionAdapter(() => element, note);
  const started = performance.now();
  const result = await XhsMonitorCommentCollector.collect(adapter, { noteId: note.noteId });
  equal(result.status, "likely_complete"); equal(result.comments.length, count * 2);
  equal(peak, 3); equal(result.collectionEvidence.peakInFlight, 3);
  for (let i = 0; i < count; i++) equal(result.comments.find((comment) => comment.commentId === `parallel-sub-${i}`).parentCommentId, `parallel-${i}`);
  const elapsed = Math.round(performance.now() - started);
  document.querySelector("#metrics").textContent += `6组异步回复：${elapsed}ms；峰值并发 ${peak}；`;
  adapter.restore();
});

test("评论全部在 DOM 中时只一次到底，跨任务强制复核后立即结束", async () => {
  const element = root(Array.from({ length: 40 }, (_, i) => item(`full-${i}`)).join(""), 40);
  const adapter = utils.createCollectionAdapter(() => element, note);
  const started = performance.now();
  const result = await XhsMonitorCommentCollector.collect(adapter, { noteId: note.noteId });
  equal(result.status, "likely_complete"); equal(result.comments.length, 40);
  equal(result.collectionEvidence.scrollCount, 1);
  assert(result.collectionEvidence.stableRounds >= 2);
  const elapsed = Math.round(performance.now() - started);
  document.querySelector("#metrics").textContent += `已加载40条评论：${elapsed}ms；完整解析 ${adapter.getDiagnostics().fullReads} 次；`;
  adapter.restore(); equal(element.scrollTop, 0);
});

test("异步渲染的虚拟列表逐页核验，不因滚动太快跳过中间评论", async () => {
  const element = root("", 12);
  element.style.height = "200px";
  const scope = element.querySelector(".comments-container");
  const render = (page) => {
    scope.innerHTML = `<div class="total">共 12 条评论</div><div style="height:${page * 700}px"></div>`
      + Array.from({ length: 4 }, (_, i) => item(`virtual-${page * 4 + i}`, "虚拟列表评论")).join("")
      + `<div style="height:${(2 - page) * 700}px"></div>`;
  };
  let page = 0, queued = false;
  render(page);
  element.addEventListener("scroll", () => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      const next = Math.min(2, Math.floor(element.scrollTop / 700));
      if (next !== page) { page = next; render(page); }
    }, 12);
  });
  const adapter = utils.createCollectionAdapter(() => element, note);
  const result = await XhsMonitorCommentCollector.collect(adapter, { noteId: note.noteId, timeoutMs: 15000 });
  equal(result.status, "likely_complete");
  equal(result.comments.map((comment) => comment.commentId).sort(), Array.from({ length: 12 }, (_, i) => `virtual-${i}`).sort());
  adapter.restore();
});

document.querySelector("#run").addEventListener("click", async (event) => {
  event.target.disabled = true;
  const results = document.querySelector("#results"); results.replaceChildren();
  const summary = document.querySelector("#summary"); summary.textContent = "运行中";
  document.querySelector("#metrics").textContent = "";
  let passed = 0;
  for (const { name, run } of tests) {
    const result = document.createElement("li");
    try { await run(); passed += 1; result.textContent = `PASS ${name}`; result.dataset.status = "passed"; }
    catch (error) { result.textContent = `FAIL ${name}: ${error.message}`; result.dataset.status = "failed"; }
    results.append(result);
  }
  mount.replaceChildren();
  summary.textContent = `完成：${passed}/${tests.length} 通过，${tests.length - passed} 失败`;
  summary.dataset.complete = "true";
  event.target.disabled = false;
});
