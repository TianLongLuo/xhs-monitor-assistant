(function (root, factory) {
  const api = factory();
  root.XhsMonitorCommentLocator = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ITEM = ".comment-item, [class*='comment-item'], [class*='CommentItem'], [class*='reply-item'], [class*='ReplyItem']";
  const THREAD = ".parent-comment, [class*='parent-comment'], [class*='comment-thread']";
  const REPLY = "[class*='comment-item-sub'], [class*='reply-item'], [class*='ReplyItem']";
  const REPLIES = "[class*='sub-comment'], [class*='replies-list'], [class*='reply-container']";
  const SCOPE = ".comments-el, .comments-container, [class*='comments-container'], [class*='comments-list']";
  const CANDIDATE = `${ITEM}, ${THREAD}, [data-comment-id], [comment-id]`;
  const CONTENT = [".comment-content", ".content", "[class*='comment-content']", "[class*='CommentContent']", "[class*='content-text']", "[class*='note-text']"];
  const AUTHOR = [".name", ".author", ".user-name", "[class*='nickname']", "[class*='author']", "[class*='user-name']"];
  const HIGHLIGHT = "xhs-monitor-comment-highlight";
  const active = new WeakMap(); // One locator per document; separate note tabs are independent.
  const highlights = new WeakMap();
  const query = (node, selector) => Array.from(node?.querySelectorAll?.(selector) || []);
  const matches = (node, selector) => Boolean(node?.matches?.(selector));
  const within = (root, node) => node === root || Boolean(root?.contains?.(node));
  const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const rawId = (value) => String(value ?? "");
  const attr = (node, name) => node?.getAttribute?.(name) || "";

  // No substring, case folding, truncation, selector interpolation or generic
  // prefix stripping. In particular comment-abc is NOT the identity abc.
  function canonicalCommentId(value) {
    const id = rawId(value);
    return /^comment-[\da-fA-F]{24}$/.test(id) ? id.slice(8) : id;
  }

  function extensionUI(node, root) {
    for (let cursor = node; cursor; cursor = cursor.parentElement) {
      if (String(cursor.className || "").split(/\s+/).some((name) => name.startsWith("xhs-monitor-") && name !== HIGHLIGHT)) return true;
      if (cursor === root) break;
    }
    return false;
  }

  function visible(node) {
    if (!node || node.isConnected === false || node.hidden || node.closest?.("[hidden], [aria-hidden='true']")) return false;
    const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
    if (style?.display === "none" || /^(hidden|collapse)$/.test(style?.visibility || "")) return false;
    return !node.getClientRects || node.getClientRects().length > 0;
  }

  function belongs(root, node, noteId) {
    if (!within(root, node) || extensionUI(node, root)) return false;
    for (let cursor = node; cursor; cursor = cursor.parentElement) {
      if (["data-note-id", "note-id"].some((name) => attr(cursor, name) && attr(cursor, name) !== noteId)) return false;
      if (cursor === root) break;
    }
    return true;
  }

  function isReply(node) {
    return Boolean(node?.closest?.(`${REPLY}, ${REPLIES}`))
      || Boolean(attr(node, "data-parent-comment-id") || attr(node, "parent-comment-id"));
  }

  function idWrapper(node) {
    return !matches(node, ITEM) && Boolean(attr(node, "data-comment-id") || attr(node, "comment-id")
      || /^(?:comment-)?[\da-fA-F]{24}$/.test(attr(node, "id"))) && query(node, ITEM).length > 0;
  }

  function context(root, noteId, utils) {
    const candidates = query(root, CANDIDATE);
    if (matches(root, CANDIDATE)) candidates.unshift(root);
    const owners = candidates.filter((node) => {
      if ((matches(node, THREAD) || idWrapper(node)) && query(node, ITEM).some((child) => !isReply(child))) return false;
      // An identity carrier inside a real row is not another comment.
      const outer = node.parentElement?.closest?.(ITEM);
      if (!matches(node, `${ITEM}, ${THREAD}`) && outer && within(root, outer)) return false;
      return true;
    });
    // Hidden/nested rows remain ownership boundaries, never sources of a
    // parent's body/author/media. Only rendered rows can actually match.
    const rows = owners.filter((node) => visible(node) && belongs(root, node, noteId));
    return { root, noteId, utils, rows, rowSet: new Set(owners), ids: new Map(), basics: new Map(), mains: new Map() };
  }

  function threadFor(node, ctx) {
    for (let cursor = node; cursor && within(ctx.root, cursor); cursor = cursor.parentElement) {
      if (matches(cursor, THREAD) || (cursor !== ctx.root && idWrapper(cursor))) return cursor;
      if (cursor === ctx.root || matches(cursor, SCOPE)) break;
    }
    return null;
  }

  function mainFor(thread, ctx) {
    if (!thread) return null;
    if (!ctx.mains.has(thread)) {
      const mains = ctx.rows.filter((row) => !isReply(row) && threadFor(row, ctx) === thread);
      ctx.mains.set(thread, mains.length === 1 ? mains[0] : null);
    }
    return ctx.mains.get(thread);
  }

  function own(node, selector, ctx) {
    return query(node, selector).filter((child) => {
      if (!belongs(ctx.root, child, ctx.noteId)) return false;
      let owner = child;
      while (owner && !ctx.rowSet.has(owner)) owner = owner.parentElement;
      return owner === node;
    });
  }

  function identities(node, ctx) {
    if (ctx.ids.has(node)) return ctx.ids.get(node);
    const result = new Set();
    function add(value) {
      if (value && !/^(comment|reply)[-_]?item$/i.test(value)) result.add(canonicalCommentId(value));
    }
    function read(carrier) {
      for (const name of ["data-comment-id", "comment-id", "data-id", "id"]) add(attr(carrier, name));
    }
    read(node);
    for (const carrier of own(node, "[data-comment-id], [comment-id]", ctx)) {
      add(attr(carrier, "data-comment-id")); add(attr(carrier, "comment-id"));
    }
    const thread = threadFor(node, ctx);
    if (!isReply(node) && thread && thread !== node && mainFor(thread, ctx) === node) read(thread);
    for (const link of own(node, "a[href]", ctx)) {
      try {
        const url = new URL(attr(link, "href"), node.ownerDocument?.baseURI || "https://www.xiaohongshu.com/");
        add(url.searchParams.get("comment_id")); add(url.searchParams.get("commentId"));
      } catch (_error) { /* Malformed links are not evidence. */ }
    }
    ctx.ids.set(node, result);
    return result;
  }

  function basics(node, ctx) {
    if (ctx.basics.has(node)) return ctx.basics.get(node);
    function first(selectors) {
      for (const selector of selectors) {
        for (const child of own(node, selector, ctx)) {
          if ([...ctx.rowSet].some((row) => row !== node && within(child, row))) continue;
          const value = text(child.innerText || child.textContent);
          if (value) return value;
        }
      }
      return "";
    }
    const images = own(node, "img", ctx).filter((img) => !img.closest?.(
      "[class*='avatar'], [class*='Avatar'], a[href*='/user/profile/'], [class*='author'], [class*='nickname']"
    ));
    const emoji = images.filter((img) => /emoji|emoticon|expression/i.test(`${img.className || ""} ${img.src || attr(img, "src")}`));
    const imageUrls = images.filter((img) => !emoji.includes(img)).map((img) => (
      attr(img, "data-src") || img.currentSrc || attr(img, "src")
    )).filter((url) => /^https?:\/\//i.test(url));
    let content = first(CONTENT);
    if (!content) content = emoji.map((img) => text(img.alt || attr(img, "title")).slice(0, 100)).filter(Boolean).join("");
    if (!content && imageUrls.length) content = imageUrls.map(() => "[图片]").join("");
    if (!content && emoji.length) content = "[表情]";
    const links = own(node, "a[href*='/user/profile/']", ctx);
    const authorLink = links.find((link) => text(link.innerText || link.textContent)) || links[0];
    const value = { content, imageUrls,
      author: text(authorLink?.innerText || authorLink?.textContent) || first(AUTHOR),
      publishedAt: first([".date", ".time", "[class*='date']", "[class*='time']"]) };
    ctx.basics.set(node, value);
    return value;
  }

  function stableId(node, ctx) {
    const b = basics(node, ctx);
    // Match the existing extractor's media salt and field limits, not a new
    // hash scheme. Full-text fallback below is deliberately never truncated.
    const content = b.content.slice(0, 8000);
    const salted = /^\[图片\]/.test(content) ? `${content}\u001f${b.imageUrls.join("|")}` : content;
    const args = [ctx.noteId, b.author.slice(0, 500), salted, b.publishedAt.slice(0, 100)];
    if (typeof ctx.utils?.stableCommentId === "function") return ctx.utils.stableCommentId(...args);
    const source = args.map((value) => text(value).slice(0, 8000)).join("\u001f");
    let hash = 0x811c9dc5;
    for (let i = 0; i < source.length; i += 1) { hash ^= source.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
    return `dom-${hash.toString(16).padStart(8, "0")}`;
  }

  function hasIdentity(node, target, ctx) {
    const ids = identities(node, ctx);
    if ([...ids].some((id) => id !== target)) return false;
    return target.startsWith("dom-") ? stableId(node, ctx) === target : ids.has(target);
  }

  function inParent(node, parentId, ctx) {
    if (!parentId) return true;
    const thread = threadFor(node, ctx);
    const main = mainFor(thread, ctx);
    if (main === node) return false;
    let declared = false;
    for (let cursor = node; cursor && cursor !== thread && within(ctx.root, cursor); cursor = cursor.parentElement) {
      for (const name of ["data-parent-comment-id", "parent-comment-id"]) {
        const id = attr(cursor, name);
        if (!id) continue;
        if (canonicalCommentId(id) !== parentId) return false;
        declared = true;
      }
    }
    if (main) return hasIdentity(main, parentId, ctx);
    if (thread) return false; // Ambiguous thread ownership is not a parent proof.
    // Missing thread markup may use an explicit native parent attribute. A
    // synthetic dom-* parent still needs its parent's hash to be recomputed.
    return declared && !parentId.startsWith("dom-");
  }

  function findParent(parentId, ctx) {
    const parents = ctx.rows.filter((node) => !isReply(node) && hasIdentity(node, parentId, ctx));
    return parents.length === 1 ? threadFor(parents[0], ctx) || parents[0] : null;
  }

  function matchInContext(ctx, comment) {
    const id = canonicalCommentId(comment?.commentId || comment?.comment_id);
    const parentId = canonicalCommentId(comment?.parentCommentId || comment?.parent_comment_id);
    const miss = (reason = "not_found") => ({ element: null, matchedBy: "", reason });
    if (!id || !/\S/.test(id)) return miss("invalid_comment");
    if ((comment.noteId || comment.note_id) && rawId(comment.noteId || comment.note_id) !== ctx.noteId) return miss("note_mismatch");
    const rows = ctx.rows.filter((node) => inParent(node, parentId, ctx));
    if (!id.startsWith("dom-")) {
      const matching = rows.filter((node) => identities(node, ctx).has(id));
      if (matching.length > 1) return miss("ambiguous");
      if (matching.length && identities(matching[0], ctx).size === 1) return { element: matching[0], matchedBy: "commentId", reason: "found" };
      return miss(matching.length ? "conflicting_id" : "not_found");
    }
    function fullMatch(node) {
      const b = basics(node, ctx);
      if (!text(comment.content) || !text(comment.author) || b.content !== text(comment.content) || b.author !== text(comment.author)) return false;
      if (/^(?:\[图片\])+$/.test(b.content)) {
        return Array.isArray(comment.imageUrls) && comment.imageUrls.length > 0
          && JSON.stringify(comment.imageUrls) === JSON.stringify(b.imageUrls);
      }
      return true;
    }
    function consistent(node) {
      const b = basics(node, ctx);
      return (!text(comment.content) || b.content === text(comment.content))
        && (!text(comment.author) || b.author === text(comment.author))
        && (!Array.isArray(comment.imageUrls) || JSON.stringify(comment.imageUrls) === JSON.stringify(b.imageUrls));
    }
    const exact = rows.filter((node) => hasIdentity(node, id, ctx) && consistent(node));
    if (exact.length > 1) return miss("ambiguous");
    if (exact.length === 1) return { element: exact[0], matchedBy: "stableId", reason: "found" };
    // Count all full matches, including rows carrying a conflicting native ID.
    // Otherwise a duplicate with a real ID could make a no-ID row look unique.
    const full = rows.filter(fullMatch);
    if (full.length > 1) return miss("ambiguous");
    if (full.length === 1 && [...identities(full[0], ctx)].every((value) => value === id)) {
      return { element: full[0], matchedBy: "contentAuthor", reason: "found" };
    }
    return miss(full.length ? "conflicting_id" : "not_found");
  }

  /** Read-only strict helper: {element, matchedBy, reason}; no collection or storage. */
  function matchComment({ root, noteId = "", comment = {}, utils } = {}) {
    if (!root?.querySelectorAll) return { element: null, matchedBy: "", reason: "invalid_root" };
    return matchInContext(context(root, rawId(noteId), utils), comment);
  }

  function nativeControl(element, ctx) {
    if (!belongs(ctx.root, element, ctx.noteId) || !visible(element) || typeof element.click !== "function") return false;
    if (!matches(element, "button, [role='button'], span, a, div, p")) return false;
    const scope = element.closest?.(SCOPE);
    if (!scope || !within(ctx.root, scope)) return false;
    if (element.closest?.("[disabled], [aria-disabled='true'], [aria-busy='true'], input, textarea, [role='textbox'], img, figure, video, svg")) return false;
    for (let cursor = element; cursor && cursor !== scope; cursor = cursor.parentElement) {
      if (matches(cursor, CONTENT.join(","))) return false;
      if (cursor.getAttribute?.("contenteditable") != null && attr(cursor, "contenteditable") !== "false") return false;
      if (matches(cursor, ".reply, .reply-action, .comment-action")) return false;
      if (/like|thumb|vote|reply-input|reply-button|reply-btn|comment-input|compose|editor|picture|image|gallery|emoji|avatar|actions/i.test(String(cursor.className || ""))) return false;
      if (matches(cursor, "a[href]") && !/^#?$/.test(attr(cursor, "href"))) return false;
      if (cursor !== element && matches(cursor, "button, [role='button']")
        && /点赞|取消赞|回复$|回覆$|图片|图像|收藏|分享|举报/.test(text(attr(cursor, "aria-label") || attr(cursor, "title")))) return false;
    }
    const labels = [element.innerText || element.textContent, attr(element, "aria-label"), attr(element, "title")]
      .map((value) => text(value).replace(/[\s>›»⌄∨▼…\.。]+$/g, "")).filter(Boolean);
    const expand = /^(?:(?:展开|查看|加载)(?:更多|全部|剩余)?\s*\d*\s*(?:条|个)?\s*(?:回复|评论)|更多回复|更多评论|展开更多|查看更多|加载更多)$/;
    const retry = /^(?:(?:评论|回复)?(?:加载失败|网络异常)[，,：:\s]*)?(?:点击|点此)?(?:重新加载|重试)$/;
    return labels.length > 0 && labels.every((label) => expand.test(label) || retry.test(label));
  }

  function loadControls(ctx, comment) {
    const parentId = canonicalCommentId(comment.parentCommentId || comment.parent_comment_id);
    const parent = parentId ? findParent(parentId, ctx) : null;
    const unknownReply = !parentId && (Number(comment.commentLevel) === 2 || comment.commentType === "子评论");
    const controls = Array.from(ctx.utils?.collectionButtons?.(ctx.root) || []).map((control) => control.element || control)
      .filter((element) => nativeControl(element, ctx)).filter((element) => {
        const thread = threadFor(element, ctx);
        const replyControl = Boolean(thread || element.closest?.(REPLIES) || /回复/.test(text(element.textContent || attr(element, "aria-label"))));
        if (parent) return within(parent, element); // Never expand a different thread.
        return unknownReply || !replyControl;
      });
    return [...new Set(controls)].filter((element) => !controls.some((other) => other !== element && within(element, other)));
  }

  /**
   * locate({root,noteId,comment,utils,isCurrent,signal,onStatus,timeoutMs})
   * resolves only {ok,reason,message,matchedBy}. matchedBy: commentId,
   * stableId, contentAuthor, or "". onStatus receives {phase,message,elapsedMs}.
   * The caller owns note navigation/bridge access. No text/ID is sent or saved.
   */
  function locate(options = {}) {
    const { root, comment = {}, utils, signal, onStatus } = options;
    const noteId = rawId(options.noteId);
    const result = (ok, reason, message, matchedBy = "") => ({ ok, reason, message, matchedBy });
    if (!root?.querySelectorAll || !noteId || !comment || !(comment.commentId || comment.comment_id)) {
      return Promise.resolve(result(false, "invalid_input", "定位参数缺少帖子、评论 ID 或 DOM 根节点"));
    }
    const view = root.ownerDocument?.defaultView || globalThis;
    const setTimer = (fn, ms) => view.setTimeout(fn, ms);
    const clearTimer = (timer) => { if (timer != null) view.clearTimeout(timer); };
    const now = () => view.performance?.now?.() ?? Date.now();
    const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0 ? Math.min(options.timeoutMs, 2147483647) : 20000;
    const start = now();
    const key = root.ownerDocument || root;
    const originalUrl = view.location?.href;
    return new Promise((resolve) => {
      let closed = false, settled = false, pumping = false, searched = false;
      let stepTimer = null, deadlineTimer = null, watchTimer = null, highlightTimer = null, observer = null;
      let highlighted = null, nextActionAt = 0, lastPhase = "", lastReason = "not_found";
      const attempts = new WeakMap();
      const scrolled = new WeakSet();
      const token = { cancel };

      function report(phase, message) {
        if (phase === lastPhase) return;
        lastPhase = phase;
        try { onStatus?.({ phase, message, elapsedMs: Math.max(0, now() - start) }); } catch (_error) { /* Presentation is optional. */ }
      }
      function stopSearch() {
        observer?.disconnect(); observer = null;
        clearTimer(stepTimer); clearTimer(deadlineTimer); stepTimer = deadlineTimer = null;
      }
      function close() {
        if (closed) return;
        closed = true; stopSearch(); clearTimer(watchTimer); clearTimer(highlightTimer);
        signal?.removeEventListener?.("abort", abort);
        for (const event of ["pagehide", "popstate", "hashchange"]) view.removeEventListener?.(event, navigation);
        if (highlighted && highlights.get(highlighted) === token) {
          highlights.delete(highlighted); highlighted.classList?.remove(HIGHLIGHT);
        }
        if (active.get(key) === token) active.delete(key);
      }
      function finish(value) {
        if (settled) return;
        settled = true; stopSearch();
        if (!value.ok) close();
        resolve(value); report(value.reason, value.message);
      }
      function cancel(reason) {
        if (closed) return;
        const messages = { aborted: "评论定位已取消", superseded: "新的定位任务已开始，本次定位已停止", note_changed: "帖子或页面已切换，本次定位已停止" };
        if (!settled) finish(result(false, reason, messages[reason] || "评论定位已停止"));
        else close();
      }
      function interruption() {
        if (signal?.aborted) return "aborted";
        if (active.get(key) !== token) return "superseded";
        try { if (options.isCurrent && !options.isCurrent()) return "note_changed"; } catch (_error) { return "note_changed"; }
        if (!visible(root) || !belongs(root, root, noteId) || (originalUrl && view.location?.href !== originalUrl)) return "note_changed";
        return "";
      }
      function check() {
        if (closed) return false;
        let reason;
        try { reason = interruption(); } catch (_error) { reason = "note_changed"; }
        if (reason) { cancel(reason); return false; }
        return true;
      }
      function abort() { cancel("aborted"); }
      function navigation() { cancel("note_changed"); }
      function notFound() {
        finish(result(false, "not_found", lastReason === "ambiguous"
          ? "未找到可唯一确认的目标评论：存在多个匹配项，未选择任何一条"
          : lastReason === "conflicting_id" ? "未找到可确认的目标评论：页面评论 ID 与目标冲突"
            : "在限定时间内未找到目标评论，可能尚未加载或当前页面未展示"));
      }
      function found(match) {
        if (!check()) return;
        const node = match.element;
        // Instant scrolling leaves no animation running after abort/navigation.
        node.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "instant" });
        if (!check()) return;
        const previous = highlights.get(node);
        if (previous && previous !== token) previous.cancel("superseded");
        highlighted = node; highlights.set(node, token); node.classList?.add(HIGHLIGHT);
        highlightTimer = setTimer(close, 6000);
        finish(result(true, "found", "已定位并高亮目标评论", match.matchedBy));
      }
      function inspect() {
        if (!check()) return null;
        const ctx = context(root, noteId, utils);
        const match = matchInContext(ctx, comment);
        lastReason = match.reason;
        if (match.element) { found(match); return null; }
        if (match.reason === "invalid_comment" || match.reason === "note_mismatch") {
          finish(result(false, match.reason, "评论标识或所属帖子与定位参数不一致")); return null;
        }
        return ctx;
      }
      function schedule(ms = 200) {
        if (closed || settled) return;
        clearTimer(stepTimer);
        stepTimer = setTimer(pump, Math.max(1, Math.min(ms, timeout - (now() - start))));
      }
      function afterAction() {
        // A native click/scroll may synchronously insert the target. Test it
        // before scheduling any render fallback; mutations also bypass pacing.
        if (inspect()) schedule(Math.max(1, nextActionAt - now()));
      }
      function pump() {
        if (closed || settled || pumping) return;
        pumping = true;
        try {
          if (!check()) return;
          if (searched && now() - start >= timeout) { notFound(); return; }
          searched = true;
          const ctx = inspect();
          if (!ctx) return;
          if (now() - start >= timeout) { notFound(); return; }
          if (now() < nextActionAt) { schedule(nextActionAt - now()); return; }
          const controls = loadControls(ctx, comment);
          let cooling = Infinity;
          for (const button of controls) {
            const group = threadFor(button, ctx) || button.closest(SCOPE);
            const rows = ctx.rows.filter((node) => within(group, node));
            const label = text(button.textContent || attr(button, "aria-label"));
            const previous = attempts.get(group);
            const unchanged = previous && previous.label === label && previous.count === rows.length && previous.last === rows.at(-1);
            if (unchanged && previous.tries >= 3) continue;
            if (unchanged && previous.next > now()) { cooling = Math.min(cooling, previous.next - now()); continue; }
            report("expanding", "正在逐步展开原生评论或目标回复");
            const fresh = inspect();
            if (!fresh || !check()) return;
            if (now() - start >= timeout) { notFound(); return; }
            if (!loadControls(fresh, comment).includes(button)) { schedule(1); return; }
            attempts.set(group, { label, count: rows.length, last: rows.at(-1), tries: unchanged ? previous.tries + 1 : 1, next: now() + 600 });
            nextActionAt = now() + 80;
            button.click(); afterAction(); return;
          }
          if (Number.isFinite(cooling)) { schedule(Math.min(cooling, 200)); return; }
          const scroller = utils?.findCommentScroller?.(root);
          if (scroller && visible(scroller) && (within(root, scroller) || within(scroller, root))) {
            const top = Number(scroller.scrollTop) || 0;
            const max = Math.max(0, (Number(scroller.scrollHeight) || 0) - (Number(scroller.clientHeight) || 0));
            const next = !scrolled.has(scroller) && top > 0 ? 0 : Math.min(max, top + Math.max(160, scroller.clientHeight * .7));
            scrolled.add(scroller);
            if (Math.abs(next - top) > .5) {
              report("scrolling", "正在滚动加载评论，目标出现后立即停止");
              if (!inspect() || !check()) return;
              if (now() - start >= timeout) { notFound(); return; }
              if (!visible(scroller) || utils?.findCommentScroller?.(root) !== scroller) { schedule(1); return; }
              nextActionAt = now() + 80;
              if (scroller.scrollTo) scroller.scrollTo({ top: next, behavior: "instant" });
              else scroller.scrollTop = next;
              if (check() && view.Event) scroller.dispatchEvent?.(new view.Event("scroll"));
              afterAction(); return;
            }
          }
          report("waiting", "正在等待目标评论加载");
          if (check()) schedule();
        } catch (_error) {
          finish(result(false, "error", "评论定位中断，未确认目标评论"));
        } finally { pumping = false; }
      }
      function watch() {
        if (!check()) return;
        watchTimer = setTimer(watch, 75); // Cancellation watchdog, not a loading sleep.
      }

      const previous = active.get(key);
      active.set(key, token); previous?.cancel("superseded");
      if (!check()) return;
      try {
        signal?.addEventListener?.("abort", abort, { once: true });
        for (const event of ["pagehide", "popstate", "hashchange"]) view.addEventListener?.(event, navigation);
        if (view.MutationObserver) {
          observer = new view.MutationObserver(() => { if (check()) pump(); });
          observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
        }
        watchTimer = setTimer(watch, 75);
        deadlineTimer = setTimer(pump, timeout);
        pump();
      } catch (_error) {
        finish(result(false, "error", "评论定位初始化中断，未确认目标评论"));
      }
    });
  }

  return { locate, matchComment, canonicalCommentId };
});
