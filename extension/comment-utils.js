(function (root, factory) {
  const api = factory();
  root.XhsMonitorCommentUtils = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
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
    const directItem = element?.matches?.(
      ".comment-item, [class*='comment-item-sub'], [class*='reply-item'], [class*='ReplyItem'], [data-comment-id], [comment-id]"
    );
    return Boolean(directItem || !element?.querySelector?.(
      ".comment-item, [class*='comment-item'], [class*='reply-item'], [class*='ReplyItem']"
    ));
  }

  function commentBasics(element, note) {
    const content = firstText(element, CONTENT_SELECTORS);
    const authorLink = element.querySelector?.("a[href*='/user/profile/']");
    const author = clean(authorLink?.innerText || authorLink?.textContent, 500)
      || firstText(element, AUTHOR_SELECTORS, 500);
    const publishedAt = firstText(element, [".date", ".time", "[class*='date']", "[class*='time']"], 100);
    return {
      content,
      authorLink,
      author,
      publishedAt,
      commentId: elementCommentId(element) || stableCommentId(note?.noteId || "", author, content, publishedAt)
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

  function extractExpectedCount(root) {
    const texts = [];
    for (const selector of [".comments-container", "[class*='comments-container']", "[class*='comment-title']", "[class*='comments-header']"]) {
      for (const element of root.querySelectorAll?.(selector) || []) texts.push(clean(element.innerText, 300));
    }
    for (const value of texts) {
      const match = value.match(/(?:共\s*)?(\d+)\s*条?评论/);
      if (match) return Number(match[1]);
    }
    return 0;
  }

  function extractComments(root, note) {
    const candidates = Array.from(root.querySelectorAll?.(ITEM_SELECTORS.join(",")) || []);
    const items = [];
    const seenElements = new Set();
    for (const element of candidates) {
      if (seenElements.has(element)) continue;
      const isCommentItem = element.matches?.(
        ".comment-item, [class*='comment-item-sub'], [class*='reply-item'], [class*='ReplyItem'], [data-comment-id], [comment-id]"
      );
      if (!isCommentItem && element.querySelector?.(".comment-item, [class*='comment-item'], [class*='reply-item']")) continue;
      const ownId = elementCommentId(element);
      if (ownId && candidates.some((other) => other !== element && other.contains?.(element) && elementCommentId(other) === ownId)) continue;
      const basics = commentBasics(element, note);
      const { content, authorLink, author, publishedAt: time } = basics;
      if (!content || /^(展开|收起|查看更多|回复)$/.test(content)) continue;
      seenElements.add(element);
      const authorUrl = authorLink?.href || "";
      const authorId = profileIdFromUrl(authorUrl);
      const badgeText = firstText(element, [
        "[class*='author-tag']", "[class*='authorTag']", "[class*='identity']", "[class*='badge']"
      ], 40);
      const likeText = firstText(element, ["[class*='like']", "[aria-label*='赞']"], 80);
      const replyText = firstText(element, ["[class*='reply-count']", "[class*='reply']"], 80);
      const isReply = isReplyElement(element);
      const parent = isReply ? mainCommentElementFor(element, candidates) : null;
      const parentBasics = parent ? commentBasics(parent, note) : null;
      const nestedReplyCount = !isReply
        ? element.closest?.(".parent-comment, [class*='parent-comment']")?.querySelectorAll?.(".comment-item-sub, [class*='reply-item']")?.length || 0
        : 0;
      items.push({
        commentId: basics.commentId,
        noteId: note?.noteId || "",
        parentCommentId: isReply && parentBasics ? parentBasics.commentId : "",
        content,
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
        likeCount: numericText(likeText),
        replyCount: Math.max(numericText(replyText), nestedReplyCount),
        commentUrl: element.querySelector?.("a[href*='comment']")?.href || note?.url || "",
        commentLevel: isReply ? 2 : 1,
        commentType: isReply ? "子评论" : "主评论"
      });
    }
    const expectedCount = extractExpectedCount(root);
    return {
      comments: items,
      expectedCount,
      status: expectedCount > 0 && items.length >= expectedCount ? "likely_complete" : "partial"
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
    const matched = Array.from(root.querySelectorAll?.("button, [role='button'], span, a, div") || []).filter((element) => {
      if (element.offsetParent === null) return false;
      const label = clean(element.innerText || element.getAttribute?.("aria-label"), 80);
      return /^(?:展开(?:更多|全部|剩余)?\s*\d*\s*条?回复|查看(?:更多|全部|剩余)?\s*\d*\s*条?回复|更多回复|展开回复)$/.test(label);
    });
    // XHS often wraps the visible label in several nested div/span nodes.
    // Keep only the innermost clickable match so one group is clicked once.
    return matched.filter((element) => !matched.some((other) => other !== element && element.contains(other)));
  }

  return {
    clean, numericText, profileIdFromUrl, isPostAuthorComment, stableCommentId, isReplyElement,
    extractExpectedCount, extractComments, expandableButtons, findCommentElement, replyButtonFor
  };
});
