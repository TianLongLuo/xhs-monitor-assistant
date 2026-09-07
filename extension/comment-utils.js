(function (root, factory) {
  const api = factory(typeof module !== "undefined" && module.exports
    ? require("./location-utils.js") : root.XhsMonitorLocationUtils);
  root.XhsMonitorCommentUtils = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (locationUtils) {
  "use strict";

  const ITEM_SELECTORS = [
    "[data-comment-id]", "[comment-id]", ".comment-item", ".parent-comment",
    "[class*='comment-item']", "[class*='CommentItem']", "[class*='parent-comment']",
    "[class*='reply-item']", "[class*='ReplyItem']"
  ];
  const CONTENT_SELECTORS = [
    ".comment-content", ".content", "[class*='comment-content']", "[class*='CommentContent']",
    "[class*='content-text']", "[class*='note-text']"
  ];
  const AUTHOR_SELECTORS = [
    ".name", ".author", ".user-name", "[class*='nickname']", "[class*='author']", "[class*='user-name']"
  ];
  const CONCRETE_SELECTOR = ".comment-item, [class*='comment-item-sub'], [class*='reply-item'], [class*='ReplyItem'], [data-comment-id], [comment-id]";
  // In the empty layout XHS replaces comments-container with a no-comments
  // illustration inside comments-el. Use the common shell for both states.
  const SCOPE_SELECTOR = ".comments-el, .comments-container, [class*='comments-container'], [class*='comments-list']";

  function isRendered(element) {
    const style = element?.ownerDocument?.defaultView?.getComputedStyle(element);
    if (style && /^(hidden|collapse)$/.test(style.visibility)) return false;
    return Boolean(element && element.isConnected !== false && !element.hidden
      && (!element.getClientRects || element.getClientRects().length > 0)
      && !element.closest?.("[hidden], [aria-hidden='true'], .xhs-monitor-process"));
  }

  function ownElements(element, selector) {
    return Array.from(element.querySelectorAll?.(selector) || []).filter((child) => {
      const owner = child.closest?.(CONCRETE_SELECTOR);
      return !owner || owner === element || owner.contains?.(element);
    });
  }

  function ownFirstText(element, selectors, limit = 8000) {
    for (const selector of selectors) {
      for (const child of ownElements(element, selector)) {
        const value = clean(child.innerText || child.textContent, limit);
        if (value) return value;
      }
    }
    return "";
  }

  function ownIpLocation(element) {
    const excluded = [
      ...CONTENT_SELECTORS, ...AUTHOR_SELECTORS, ".username",
      "[class*='avatar']", "[class*='Avatar']", "a[href*='/user/profile/']", "img", "video", "svg",
      ".xhs-monitor-process", ".xhs-monitor-toolbar", ".xhs-monitor-page-toast",
      ".xhs-monitor-badge", ".xhs-monitor-relevance", ".xhs-monitor-action", "[data-xhs-monitor-ui]"
    ].join(",");
    const owners = ITEM_SELECTORS.join(",");
    // Only metadata owned by this row is eligible, never the row's full text.
    // Explicit IP metadata precedes a region appended to the native date label.
    const selectors = [
      "[class*='ip-location'], [class*='ipLocation'], [class*='ip_location'], [class*='ip-address'], [class*='ipAddress'], [data-ip-location]",
      ".date, .time, time, [class*='date'], [class*='time']"
    ];
    for (const selector of selectors) {
      for (const node of ownElements(element, selector)) {
        if (!isRendered(node) || node.closest?.(excluded)) continue;
        const owner = node.closest?.(owners);
        if (owner && owner !== element) continue;
        // A wrapper containing another row, prose, or plugin UI is not metadata.
        if (node.querySelector?.(`${owners},${excluded}`)) continue;
        const raw = node.innerText ?? node.textContent ?? "";
        const region = locationUtils?.extractRegion(raw) || "";
        if (region) return region;
      }
    }
    return "";
  }

  function commentScope(root) {
    return root?.matches?.(SCOPE_SELECTOR) ? root : root?.querySelector?.(SCOPE_SELECTOR) || root;
  }

  function clean(value, limit = 8000) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function firstText(root, selectors, limit = 8000) {
    for (const selector of selectors) {
      const element = root.querySelector?.(selector);
      const value = clean(element?.innerText || element?.textContent, limit);
      if (value) return value;
    }
    return "";
  }

  function numericText(value) {
    const normalized = clean(value, 80).replace(/,/g, "");
    const match = normalized.match(/(\d+(?:\.\d+)?)\s*([万wW]?)/);
    if (!match) return 0;
    const number = Number(match[1]);
    return Math.round(number * (/[万wW]/.test(match[2]) ? 10000 : 1));
  }

  function profileIdFromUrl(value) {
    try {
      const url = new URL(String(value || ""), "https://www.xiaohongshu.com");
      const match = url.pathname.match(/\/user\/profile\/([^/?#]+)/);
      return match ? clean(match[1], 256) : "";
    } catch (_error) {
      return "";
    }
  }

  function normalizedAuthor(value) {
    return clean(value, 500).normalize("NFKC").toLocaleLowerCase();
  }

  function isPostAuthorComment({ noteAuthorId = "", commentAuthorId = "", noteAuthor = "", commentAuthor = "", badgeText = "" } = {}) {
    const ownerId = clean(noteAuthorId, 256);
    const commenterId = clean(commentAuthorId, 256);
    if (ownerId && commenterId) return ownerId === commenterId;
    if (/^(作者|笔记作者|博主|楼主)$/.test(clean(badgeText, 40))) return true;
    const ownerName = normalizedAuthor(noteAuthor);
    const commenterName = normalizedAuthor(commentAuthor);
    return Boolean(!ownerId && !commenterId && ownerName && commenterName && ownerName === commenterName);
  }

  function elementCommentId(element) {
    for (const attribute of ["data-comment-id", "comment-id", "data-id", "id"]) {
      const value = clean(element.getAttribute?.(attribute), 256);
      if (value && !/^(comment|reply)[-_]?item$/i.test(value)) return value;
    }
    // Some layouts put the ID on the thread wrapper rather than the main
    // comment. Replies must not inherit that wrapper's (parent) identity.
    const wrapper = element.closest?.(".parent-comment, [class*='parent-comment'], [class*='comment-thread']");
    if (wrapper && wrapper !== element && !isReplyElement(element)) {
      for (const attribute of ["data-comment-id", "comment-id", "id"]) {
        const value = clean(wrapper.getAttribute?.(attribute), 256);
        if (value && !/^(comment|reply)[-_]?item$/i.test(value)) return value;
      }
    }
    const link = element.querySelector?.("a[href*='comment'], a[href*='xsec_token']");
    if (link) {
      try {
        const url = new URL(link.href, location.href);
        const id = url.searchParams.get("comment_id") || url.searchParams.get("commentId");
        if (id) return clean(id, 256);
      } catch (_error) {}
    }
    return "";
  }

  function stableCommentId(noteId, author, content, publishedAt) {
    const source = [noteId, author, content, publishedAt].map((value) => clean(value, 8000)).join("\u001f");
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `dom-${hash.toString(16).padStart(8, "0")}`;
  }

  function isReplyElement(element) {
    return Boolean(
      element?.classList?.contains("comment-item-sub")
      || element?.matches?.("[class*='comment-item-sub'], [class*='reply-item'], [class*='ReplyItem']")
      || element?.closest?.("[class*='sub-comment'], [class*='replies-list'], [class*='reply-container']")
    );
  }

  function isConcreteCommentElement(element) {
    if (element?.matches?.(".parent-comment, [class*='parent-comment'], [class*='comment-thread']")
      && Array.from(element.querySelectorAll?.(CONCRETE_SELECTOR) || []).some((child) => !isReplyElement(child))) return false;
    const directItem = element?.matches?.(
      ".comment-item, [class*='comment-item-sub'], [class*='reply-item'], [class*='ReplyItem'], [data-comment-id], [comment-id]"
    );
    return Boolean(directItem || !element?.querySelector?.(
      ".comment-item, [class*='comment-item'], [class*='reply-item'], [class*='ReplyItem']"
    ));
  }

  function commentBasics(element, note) {
    let content = ownFirstText(element, CONTENT_SELECTORS);
    const images = ownElements(element, "img").filter((img) => !img.closest?.(
      "[class*='avatar'], [class*='Avatar'], a[href*='/user/profile/'], [class*='author'], [class*='nickname']"
    ));
    const emojiImages = images.filter((img) => /emoji|emoticon|expression/i.test(String(img.className || "") + " " + String(img.src || "")));
    if (!content) content = emojiImages.map((img) => clean(img.alt || img.getAttribute?.("title"), 100)).filter(Boolean).join("");
    const imageUrls = images.filter((img) => !emojiImages.includes(img)).map((img) => (
      img.getAttribute?.("data-src") || img.currentSrc || img.getAttribute?.("src") || ""
    )).filter((url) => /^https?:\/\//i.test(url));
    // Image-only / emoji-only comments still count toward the site's total.
    // A visible placeholder plus original media URLs preserves their meaning in
    // the existing non-empty-text CSV schema; avatars are explicitly excluded.
    if (!content && imageUrls.length) content = imageUrls.map(() => "[图片]").join("");
    if (!content && emojiImages.length) content = "[表情]";
    const authorLinks = ownElements(element, "a[href*='/user/profile/']");
    const authorLink = authorLinks.find((link) => clean(link.innerText || link.textContent, 500)) || authorLinks[0];
    const author = clean(authorLink?.innerText || authorLink?.textContent, 500)
      || ownFirstText(element, AUTHOR_SELECTORS, 500);
    const publishedAt = ownFirstText(element, [".date", ".time", "[class*='date']", "[class*='time']"], 100);
    return {
      content,
      imageUrls,
      authorLink,
      author,
      publishedAt,
      ipLocation: ownIpLocation(element),
      commentId: elementCommentId(element) || stableCommentId(note?.noteId || "", author,
        /^\[图片\]/.test(content) ? `${content}\u001f${imageUrls.join("|")}` : content, publishedAt)
    };
  }

  function mainCommentElementFor(replyElement, candidates) {
    const wrapper = replyElement.closest?.(".parent-comment, [class*='parent-comment'], [class*='comment-thread']");
    if (!wrapper) return null;
    return candidates.find((candidate) => (
      candidate !== replyElement
      && wrapper.contains?.(candidate)
      && isConcreteCommentElement(candidate)
      && !isReplyElement(candidate)
      && !candidate.contains?.(replyElement)
    )) || candidates.find((candidate) => (
      candidate !== replyElement
      && wrapper.contains?.(candidate)
      && isConcreteCommentElement(candidate)
      && !isReplyElement(candidate)
    )) || null;
  }

  function readCommentCount(root) {
    let headerCount = null;
    for (const selector of [".comments-container .total", "[class*='comment-title']", "[class*='comments-header']", ".comments-container", "[class*='comments-container']"]) {
      const elements = Array.from(root.querySelectorAll?.(selector) || []);
      if (root.matches?.(selector)) elements.unshift(root);
      for (const element of elements) {
        if (!isRendered(element) || element.closest?.(CONCRETE_SELECTOR)) continue;
        const value = clean(element.innerText || element.textContent, 300);
        const match = value.match(/^(?:共\s*)?([\d,，]+)\s*条?\s*评论/);
        // A precise native header is enough; do not serialize the entire
        // comments-container after already finding its count.
        if (match) { headerCount = Number(match[1].replace(/[,，]/g, "")); break; }
      }
      if (headerCount !== null) break;
    }
    let footerCount = null;
    for (const element of root.querySelectorAll?.(".engage-bar-style .chat-wrapper > .count, .interactions .chat-wrapper > .count") || []) {
      if (!isRendered(element) || element.closest?.(CONCRETE_SELECTOR)) continue;
      const value = clean(element.innerText || element.textContent, 80);
      // The label “评论” and rounded counts such as “1.2万” are not exact zero
      // or exact totals. Never borrow a nearby like/collection count.
      if (/^\d+(?:[,，]\d{3})*$/.test(value)) { footerCount = Number(value.replace(/[,，]/g, "")); break; }
    }
    const empty = hasExplicitEmptyState(root);
    const expectedCount = Math.max(0, headerCount || 0, footerCount || 0);
    const countConflict = (headerCount !== null && footerCount !== null && headerCount !== footerCount)
      || (empty && expectedCount > 0);
    return {
      expectedCount,
      expectedCountKnown: headerCount !== null || footerCount !== null || empty,
      expectedCountSource: headerCount !== null ? "comment_header" : footerCount !== null ? "comment_footer" : empty ? "native_empty_state" : "unknown",
      explicitEmpty: empty && expectedCount === 0 && !countConflict,
      countConflict
    };
  }

  function extractExpectedCount(root) {
    // Legacy callers still receive a number; collection uses the accompanying
    // known/source fields so a verified zero no longer displays as “0/?”.
    return readCommentCount(root).expectedCount;
  }

  function hasExplicitEmptyState(root) {
    const selectors = [
      ".comments-container", "[class*='comments-container']", "[class*='comment-title']",
      "[class*='comments-header']", "[class*='comment-empty']", "[class*='empty-comment']",
      "[class*='no-comment']", "[class*='empty']"
    ];
    for (const selector of selectors) {
      const elements = Array.from(root.querySelectorAll?.(selector) || []);
      if (root.matches?.(selector)) elements.unshift(root);
      for (const element of elements) {
        if (!isRendered(element) || element.closest?.(CONCRETE_SELECTOR)) continue;
        const value = clean(element.innerText || element.textContent, 500);
        if (/^(?:(?:共\s*)?0\s*条?评论|暂无评论|还没有评论|暂时没有评论|成为第一个评论|快来(?:发表|发布)?评论)/.test(value)) {
          return true;
        }
        // Observed in the real zero-comment note: .comments-el > .no-comments
        // > p.no-comments-text, with a “点击评论” span. Require that native
        // empty component; identical prose in a post/comment is not evidence.
        if (element.matches?.(".no-comments, .no-comments-text")
          && element.closest?.(".comments-el, .comments-container")
          && /^这是一片荒地\s*(?:点击评论)?$/.test(value)) return true;
      }
    }
    return false;
  }

  function extractComments(root, note) {
    const observationTime = new Date().toISOString();
    const candidates = Array.from(root.querySelectorAll?.(ITEM_SELECTORS.join(",")) || []);
    const items = [];
    const seenElements = new Set();
    const seenIds = new Set();
    const unreadable = new Set();
    const parents = new Map();
    const basicsCache = new Map();
    const basicsFor = (element) => {
      if (!basicsCache.has(element)) basicsCache.set(element, commentBasics(element, note));
      return basicsCache.get(element);
    };
    for (const element of candidates) {
      if (seenElements.has(element) || !isRendered(element)) continue;
      if (!isConcreteCommentElement(element)) continue;
      const isCommentItem = element.matches?.(
        ".comment-item, [class*='comment-item-sub'], [class*='reply-item'], [class*='ReplyItem'], [data-comment-id], [comment-id]"
      );
      if (!isCommentItem && element.querySelector?.(".comment-item, [class*='comment-item'], [class*='reply-item']")) continue;
      const ownId = elementCommentId(element);
      const basics = basicsFor(element);
      const { content, authorLink, author, publishedAt: time } = basics;
      if (!content) {
        if (ownId || author || time) unreadable.add(ownId || element);
        continue;
      }
      if (seenIds.has(basics.commentId)) continue;
      seenIds.add(basics.commentId);
      unreadable.delete(ownId || element);
      seenElements.add(element);
      const authorUrl = authorLink?.href || "";
      const authorId = profileIdFromUrl(authorUrl);
      const badgeText = ownFirstText(element, [
        "[class*='author-tag']", "[class*='authorTag']", "[class*='identity']", "[class*='badge']"
      ], 40);
      const likeText = ownFirstText(element, ["[class*='like']", "[aria-label*='赞']"], 80);
      const replyText = ownFirstText(element, ["[class*='reply-count']", "[class*='reply']"], 80);
      const isReply = isReplyElement(element);
      const wrapper = element.closest?.(".parent-comment, [class*='parent-comment'], [class*='comment-thread']");
      if (isReply && wrapper && !parents.has(wrapper)) parents.set(wrapper, mainCommentElementFor(element, candidates));
      const parent = isReply ? parents.get(wrapper) : null;
      const parentBasics = parent ? basicsFor(parent) : null;
      const nestedReplyCount = !isReply
        ? element.closest?.(".parent-comment, [class*='parent-comment']")?.querySelectorAll?.(".comment-item-sub, [class*='reply-item']")?.length || 0
        : 0;
      items.push({
        commentId: basics.commentId,
        noteId: note?.noteId || "",
        parentCommentId: isReply && parentBasics ? parentBasics.commentId : "",
        content,
        imageUrls: basics.imageUrls,
        author,
        authorUrl,
        authorId,
        isAuthor: isPostAuthorComment({
          noteAuthorId: note?.authorId || profileIdFromUrl(note?.authorUrl || ""),
          commentAuthorId: authorId,
          noteAuthor: note?.author || "",
          commentAuthor: author,
          badgeText
        }),
        publishedAt: time,
        ipLocation: basics.ipLocation,
        timeObservedAt: observationTime,
        timeReferenceSource: "capture",
        likeCount: numericText(likeText),
        replyCount: Math.max(numericText(replyText), nestedReplyCount),
        commentUrl: element.querySelector?.("a[href*='comment']")?.href || note?.url || "",
        commentLevel: isReply ? 2 : 1,
        commentType: isReply ? "子评论" : "主评论"
      });
    }
    const count = readCommentCount(root);
    return {
      comments: items,
      ...count,
      unreadableCount: unreadable.size,
      status: !count.countConflict && count.expectedCount > 0 && items.length >= count.expectedCount ? "likely_complete" : "partial"
    };
  }

  function findCommentElement(root, comment = {}) {
    const targetId = clean(comment.commentId || comment.comment_id, 256);
    if (targetId) {
      for (const selector of [
        `[data-comment-id="${CSS.escape(targetId)}"]`, `[comment-id="${CSS.escape(targetId)}"]`,
        `#${CSS.escape(targetId)}`, `#comment-${CSS.escape(targetId)}`
      ]) {
        const direct = root.querySelector?.(selector);
        if (direct) return direct.matches?.(".comment-item, [class*='comment-item'], [class*='reply-item']")
          ? direct : direct.closest?.(".comment-item, [class*='comment-item'], [class*='reply-item']") || direct;
      }
      for (const candidate of root.querySelectorAll?.(ITEM_SELECTORS.join(",")) || []) {
        if (elementCommentId(candidate) === targetId) return candidate;
      }
    }
    const targetContent = clean(comment.content, 300);
    const targetAuthor = clean(comment.author, 120);
    return Array.from(root.querySelectorAll?.(ITEM_SELECTORS.join(",")) || []).find((candidate) => {
      const basics = commentBasics(candidate, { noteId: comment.noteId || "" });
      return targetContent && basics.content.includes(targetContent.slice(0, 80))
        && (!targetAuthor || basics.author === targetAuthor);
    }) || null;
  }

  function replyButtonFor(element) {
    if (!element) return null;
    const ownerSelector = ITEM_SELECTORS.join(",");
    const owner = element.matches?.(ownerSelector) ? element : element.closest?.(ownerSelector) || element;
    const anchor = owner.querySelector?.(CONTENT_SELECTORS.join(",")) || element;
    const anchorRect = anchor.getBoundingClientRect?.() || { left: 0, bottom: 0 };
    const scopes = [];
    let cursor = owner;
    for (let depth = 0; cursor && depth < 5; depth += 1) {
      scopes.push(cursor);
      if (depth > 0 && cursor.matches?.(".parent-comment, [class*='parent-comment'], [class*='comment-thread']")) break;
      cursor = cursor.parentElement;
    }
    const nodes = [];
    const seen = new Set();
    for (const scope of scopes) {
      for (const node of scope.querySelectorAll?.("button, [role='button'], a, span, p, div") || []) {
        if (seen.has(node)) continue;
        seen.add(node);
        const label = clean(
          node.getAttribute?.("aria-label") || node.getAttribute?.("title") || node.innerText || node.textContent,
          40
        );
        if (!/^(?:回复|回覆)(?:\s*\d+)?$/.test(label)) continue;
        if (node.offsetParent === null || node.getClientRects?.().length === 0) continue;
        const candidateOwner = node.closest?.(ownerSelector);
        let ownerPenalty = 0;
        if (candidateOwner && candidateOwner !== owner) {
          if (owner.contains?.(candidateOwner)) ownerPenalty = 10000;
          else if (!candidateOwner.contains?.(owner)) ownerPenalty = 100000;
        }
        const rect = node.getBoundingClientRect?.() || { left: 0, top: 0 };
        nodes.push({
          node,
          score: ownerPenalty + Math.abs(rect.top - anchorRect.bottom) * 10 + Math.abs(rect.left - anchorRect.left)
        });
      }
    }
    nodes.sort((left, right) => left.score - right.score);
    return nodes[0]?.node || null;
  }

  function expandableButtons(root) {
    return collectionButtons(root).filter((item) => item.kind !== "retry").map((item) => item.element);
  }

  function collectionButtons(root) {
    const scope = commentScope(root);
    const matched = Array.from(scope?.querySelectorAll?.("button, [role='button'], span, a, div, p") || []).flatMap((element) => {
      if (element.closest?.(".comment-content, .content, [class*='content-text'], [class*='note-text']")) return [];
      // Reject ordinary text before any computed-style/layout query. In a long
      // list only a handful of nodes are actually expansion/retry controls.
      const raw = element.textContent || element.getAttribute?.("aria-label") || "";
      if (raw.length > 120 || !/展开|查看|加载|更多|重试|网络异常/.test(raw)) return [];
      if (!isRendered(element)) return [];
      const label = clean(element.innerText || element.getAttribute?.("aria-label") || raw, 100)
        .replace(/[\s>›»⌄∨▼…\.。]+$/g, "");
      const expand = /^(?:(?:展开|查看|加载)(?:更多|全部|剩余)?\s*\d*\s*(?:条|个)?\s*(?:回复|评论)|更多回复|更多评论|展开更多|查看更多|加载更多)$/.test(label);
      const retry = /^(?:(?:评论|回复)?(?:加载失败|网络异常)[，,：:\s]*)?(?:点击|点此)?(?:重新加载|重试)$/.test(label);
      if (!expand && !retry) return [];
      return [{ element, label, kind: retry ? "retry" : "expand" }];
    });
    // XHS often wraps the visible label in several nested div/span nodes.
    // Keep only the innermost clickable match so one group is clicked once.
    return matched.filter((item) => !matched.some((other) => other !== item && item.element.contains(other.element)));
  }

  function findCommentScroller(root) {
    const scope = commentScope(root);
    if (!scope) return null;
    const view = root.ownerDocument?.defaultView;
    const candidates = [];
    let cursor = scope;
    // The root itself or one of its ancestors may own scrollTop. Picking the
    // first selector match often picked a non-scrollable comments-container.
    while (cursor?.nodeType === 1) {
      candidates.push(cursor);
      if (view?.getComputedStyle(cursor).position === "fixed") break;
      cursor = cursor.parentElement;
    }
    for (const candidate of root.querySelectorAll?.(".note-scroller, [class*='note-scroller'], [class*='comment-scroller']") || []) {
      // The comment section can be mounted only after the body is scrolled.
      // Its absence must not prevent discovering the known note scroll owner.
      if (candidate.contains(scope) || scope === root) candidates.unshift(candidate);
    }
    return [...new Set(candidates)].find((element) => {
      if (!isRendered(element) || element.clientHeight <= 0 || element.scrollHeight <= element.clientHeight + 2) return false;
      const overflow = view?.getComputedStyle(element).overflowY || "";
      return /^(auto|scroll|overlay)$/.test(overflow)
        || (element === root.ownerDocument?.scrollingElement && !/hidden|clip/.test(overflow));
    }) || null;
  }

  function createCollectionAdapter(getRoot, note, options = {}) {
    const originals = new Map();
    const scrollerKeys = new WeakMap();
    const groups = new Map();
    const waiters = new Set();
    const turns = new Set();
    const diagnostics = { fullReads: 0, cachedReads: 0, domWakeups: 0 };
    let nextScrollerKey = 0;
    let observedRoot = null;
    let observer = null;
    let dirty = true;
    let revision = 0;
    let cached = null;
    let disposed = false;
    const loadingSelector = "[aria-busy='true'], [role='progressbar'], .loading, [class*='loading'], [class*='Loading']";

    function invalidate(records = null) {
      if (records && !records.some((record) => {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (target?.closest?.(".xhs-monitor-process, .xhs-monitor-toolbar, .xhs-monitor-page-toast")) return false;
        return true;
      })) return;
      dirty = true; revision += 1;
      for (const finish of [...waiters]) finish();
    }
    function observe(root) {
      if (root === observedRoot) return;
      observer?.disconnect(); groups.clear(); cached = null;
      observedRoot = root; invalidate();
      const Observer = root?.ownerDocument?.defaultView?.MutationObserver;
      observer = Observer ? new Observer((records) => { diagnostics.domWakeups += 1; invalidate(records); }) : null;
      observer?.observe(root, { childList: true, subtree: true, characterData: true, attributes: true,
        attributeFilter: ["id", "data-id", "class", "style", "hidden", "aria-hidden", "aria-label", "aria-busy", "aria-disabled", "disabled", "src", "data-src", "alt", "title", "datetime", "data-comment-id", "comment-id", "data-parent-comment-id", "data-note-id", "note-id"] });
    }
    function drain() {
      const records = observer?.takeRecords() || [];
      if (records.length) invalidate(records);
    }
    function pending(scope) {
      const nodes = Array.from(scope.querySelectorAll?.(loadingSelector) || []);
      if (scope.matches?.(loadingSelector)) nodes.unshift(scope);
      return nodes.some((element) => isRendered(element) && !element.closest?.(CONCRETE_SELECTOR));
    }
    function resolve() {
      const root = getRoot();
      if (!root || !isRendered(root)) return { root: null, scroller: null };
      if (!disposed) observe(root);
      drain();
      const scroller = findCommentScroller(root);
      if (scroller && !originals.has(scroller)) originals.set(scroller, scroller.scrollTop);
      if (scroller && !scrollerKeys.has(scroller)) scrollerKeys.set(scroller, ++nextScrollerKey);
      return { root, scroller };
    }
    return {
      supportsThreadTracking: true,
      interruption: options.interruption,
      onProgress: options.onProgress,
      getDiagnostics: () => ({ ...diagnostics }),
      read(readOptions = {}) {
        const { root, scroller } = resolve();
        if (!root) return { ready: false };
        const scope = commentScope(root);
        if (readOptions.force || dirty || !cached || !observer) {
          diagnostics.fullReads += 1;
          const extracted = extractComments(root, note);
          const threadStates = Object.create(null);
          const groupMemo = new Map();
          function groupInfo(node) {
            if (groupMemo.has(node)) return groupMemo.get(node);
            const descendants = Array.from(node.querySelectorAll?.(CONCRETE_SELECTOR) || []).filter(isConcreteCommentElement);
            const owner = descendants.find((element) => !isReplyElement(element));
            const key = node === scope ? "list" : commentBasics(owner || node, note).commentId;
            const state = { key, revision: descendants.map((element) => elementCommentId(element) || commentBasics(element, note).commentId).join("|"), pending: pending(node) };
            groupMemo.set(node, state); groups.set(key, node);
            threadStates[key] = { revision: state.revision, pending: state.pending };
            return state;
          }
          const controls = collectionButtons(root).map((item) => {
            const wrapper = item.element.closest?.(".parent-comment, [class*='parent-comment'], [class*='comment-thread']");
            const group = groupInfo(wrapper || scope);
            const disabled = Boolean(item.element.closest?.("[disabled], [aria-disabled='true'], [aria-busy='true']"));
            if (disabled) threadStates[group.key].pending = true;
            return { ...item, groupKey: group.key, key: `${group.key}:${item.kind}`,
              revision: `${item.label}:${group.revision}`, disabled };
          });
          // Keep a group's response evidence even while its button is hidden.
          for (const [key, node] of groups) {
            if (!node.isConnected || !root.contains(node)) { groups.delete(key); continue; }
            groupInfo(node);
          }
          cached = { ...extracted, controls, threadStates, loading: pending(scope) };
          dirty = false;
        } else diagnostics.cachedReads += 1;
        const scopeRect = scope.getBoundingClientRect?.();
        const viewportHeight = root.ownerDocument?.defaultView?.innerHeight || 0;
        return { ...cached, ready: true, revision,
          scrollKey: scroller ? String(scrollerKeys.get(scroller)) : "fits-viewport",
          scrollTop: scroller?.scrollTop || 0,
          scrollHeight: scroller?.scrollHeight || 0,
          atBottom: scroller ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4
            : Boolean(scopeRect && viewportHeight && scopeRect.bottom <= viewportHeight + 4)
        };
      },
      waitForChange(timeoutMs) {
        drain();
        if (dirty || disposed || options.interruption?.()) return Promise.resolve();
        return new Promise((resolveWait) => {
          let timer;
          const finish = () => { clearTimeout(timer); waiters.delete(finish); resolveWait(); };
          waiters.add(finish);
          timer = setTimeout(finish, Math.max(1, timeoutMs));
        });
      },
      afterDomTurn() {
        // Count-complete data needs two fresh task-boundary checks, not a
        // mandatory sleep. MessageChannel also works in background reader tabs
        // where requestAnimationFrame may be suspended.
        const Channel = observedRoot?.ownerDocument?.defaultView?.MessageChannel;
        if (!Channel || disposed) return new Promise((resolveTurn) => setTimeout(resolveTurn, 60));
        return new Promise((resolveTurn) => {
          const channel = new Channel();
          let done = false;
          const finish = () => {
            if (done) return; done = true;
            channel.port1.close(); channel.port2.close(); turns.delete(finish); resolveTurn();
          };
          turns.add(finish); channel.port1.onmessage = finish; channel.port2.postMessage(0);
        });
      },
      afterScroll() {
        // A partial/virtualized viewport must get its render opportunity before
        // moving again. Complete DOM lists use the separate no-sleep end jump.
        const view = observedRoot?.ownerDocument?.defaultView;
        if (!view?.requestAnimationFrame || disposed) return this.waitForChange(120);
        return new Promise((resolveFrame) => {
          let frame = 0, timer;
          const finish = () => { clearTimeout(timer); view.cancelAnimationFrame(frame); turns.delete(finish); resolveFrame(); };
          turns.add(finish);
          frame = view.requestAnimationFrame(() => { frame = view.requestAnimationFrame(finish); });
          timer = setTimeout(finish, 180); // fallback only for suspended/background rendering
        });
      },
      click(control) {
        if (options.interruption?.() || !isRendered(control.element)) return false;
        if (control.element.closest?.("[disabled], [aria-disabled='true'], [aria-busy='true']")) return false;
        control.element.click();
        return true;
      },
      scroll(direction) {
        if (options.interruption?.()) return false;
        const { scroller } = resolve();
        if (!scroller) return false;
        const previous = scroller.scrollTop;
        scroller.scrollTop = direction === "start" ? 0
          : direction === "end" ? Math.max(0, scroller.scrollHeight - scroller.clientHeight)
          : Math.min(scroller.scrollHeight - scroller.clientHeight, previous + Math.max(160, scroller.clientHeight * 0.7));
        // Native scroll events do not bubble; dispatch only on the actual owner.
        scroller.dispatchEvent(new Event("scroll"));
        const moved = Math.abs(scroller.scrollTop - previous) > 0.5;
        if (moved) invalidate();
        return moved;
      },
      restore() {
        disposed = true; observer?.disconnect(); observer = null;
        for (const finish of [...waiters, ...turns]) finish();
        groups.clear(); cached = null;
        if (options.interruption?.()) return;
        for (const [scroller, top] of originals) if (scroller.isConnected) scroller.scrollTop = top;
      }
    };
  }

  return {
    clean, numericText, profileIdFromUrl, isPostAuthorComment, stableCommentId, isReplyElement,
    readCommentCount, extractExpectedCount, hasExplicitEmptyState, extractComments, expandableButtons, findCommentElement, replyButtonFor,
    collectionButtons, findCommentScroller, createCollectionAdapter
  };
});
