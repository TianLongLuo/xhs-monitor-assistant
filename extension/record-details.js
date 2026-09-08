(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.XhsMonitorRecordDetails = api;
})(globalThis, function () {
  "use strict";

  const LABELS = Object.freeze({
    ok: "可打开", check_failed: "待复核", unreachable: "打不开",
    synced: "已拉取", partial: "部分拉取", failed: "失败", not_started: "未开始",
    known: "已入库", ignored: "已忽略", pending: "等待中", running: "进行中",
    complete: "已完成", completed: "已完成", collecting: "读取中",
  });
  const STATUS = /(?:^|__)(?:status|post_status|comment_status|access_status|pull_status|ignore_status|media_status|comment_collection_status|review_status|ai_analysis_status)$/;
  const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

  function safeLink(value) {
    try {
      const url = new URL(String(value || ""));
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
    } catch (_error) { return ""; }
  }
  function present(value) { return value !== null && value !== undefined && value !== ""; }
  function display(value) {
    if (!present(value)) return "—";
    return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  }
  function fieldGroup(key) {
    if (key.startsWith("post__")) return "关联原帖";
    if (/json$/.test(key)) return "原始结构化数据";
    if (/semantic|negative|sentiment|review|ai_|risk|issue_/.test(key)) return "分析与复核";
    if (/published|updated|time_observed|ip_location/.test(key)) return "时间与属地";
    if (/status|error|synced|collected|checked|deleted|last_seen|first_seen|media_|access_|ignore/.test(key)) return "同步与状态";
    return "记录信息";
  }

  async function fetchRecord({ dataset, recordId, expectedNoteId = "", snapshotToken, fields, request, isCurrent = () => true }) {
    if (!["notes", "comments"].includes(dataset) || !recordId || !snapshotToken) throw new Error("请先完成数据校验再查看详情");
    const primary = dataset === "notes" ? "note_id" : "comment_id";
    const identities = dataset === "notes" ? [primary] : [primary, "note_id"];
    const keys = [...new Set((fields || []).map(field => field.key).filter(key =>
      typeof key === "string" && key.length > 0 && key.length <= 160 && !BLOCKED_KEYS.has(key)))];
    if (!identities.every(key => keys.includes(key))) throw new Error("记录标识字段缺失，请刷新数据");
    const remainder = keys.filter(key => !identities.includes(key));
    const chunkSize = 180 - identities.length;
    const result = {};
    // Every chunk uses the same approved snapshot and exact identity. Never mix
    // a new snapshot, a different record or the table's active filters into it.
    for (let offset = 0; offset < Math.max(1, remainder.length); offset += chunkSize) {
      if (!isCurrent()) return null;
      const selected = [...identities, ...remainder.slice(offset, offset + chunkSize)];
      const response = await request({
        dataset, snapshotToken, fields: selected, search: "", sort: [], groupThreads: false,
        filter: { logic: "and", children: [{ field: primary, operator: "eq", value: recordId }] },
        page: 1, pageSize: 1,
      });
      if (!isCurrent()) return null;
      if (!response?.ok || response.consistentSnapshot !== true || response.snapshotToken !== snapshotToken
          || response.dataset !== dataset) throw new Error("详情快照已变化，请刷新数据后重试");
      if (response.total !== 1 || response.rows?.length !== 1) throw new Error("这条记录已变化或已被删除，请刷新数据");
      const row = response.rows[0];
      if (row[primary] !== recordId || (expectedNoteId && row.note_id !== expectedNoteId)) {
        throw new Error("详情记录关联校验未通过，已停止显示");
      }
      if (selected.some(key => !Object.prototype.hasOwnProperty.call(row, key))) throw new Error("详情字段读取不完整，请刷新后重试");
      for (const key of selected) result[key] = row[key];
    }
    return result;
  }

  const COMMENT_FIELDS = Object.freeze([
    "comment_id", "note_id", "author", "content", "published_at", "ip_location", "like_count",
    "comment_status", "is_deleted", "comment_level", "parent_comment_id", "thread_root_author", "is_post_author",
  ]);

  async function fetchComments({ noteId, snapshotToken, request, isCurrent = () => true, onPage = () => {} }) {
    if (typeof noteId !== "string" || !noteId || typeof snapshotToken !== "string" || !snapshotToken
        || typeof request !== "function") throw new Error("请先完成数据校验再读取评论");
    const rows = [], ids = new Set();
    let total = null;
    for (let page = 1; ; page += 1) {
      if (!isCurrent()) return null;
      const response = await request({
        dataset: "comments", snapshotToken, fields: [...COMMENT_FIELDS], search: "",
        filter: { logic: "and", children: [{ field: "note_id", operator: "eq", value: noteId }] },
        sort: [{ field: "published_at", direction: "asc" }],
        groupThreads: true, threadSortMode: "root", page, pageSize: 200,
      });
      if (!isCurrent()) return null;
      if (!response?.ok || response.consistentSnapshot !== true || response.dataset !== "comments"
          || response.snapshotToken !== snapshotToken) throw new Error("评论快照已变化，请刷新校验后重新打开详情");
      if (!Number.isSafeInteger(response.total) || response.total < 0
          || (total !== null && response.total !== total)) throw new Error("评论总数已变化，请刷新后重试");
      total = response.total;
      const expected = Math.min(200, total - rows.length);
      if (!Array.isArray(response.rows) || response.rows.length !== expected
          || (response.page !== undefined && response.page !== page)) throw new Error("评论分页读取不完整，请刷新后重试");
      const pageIds = new Set();
      for (const row of response.rows) {
        if (!row || row.note_id !== noteId || typeof row.comment_id !== "string" || !row.comment_id
            || ids.has(row.comment_id) || pageIds.has(row.comment_id)
            || COMMENT_FIELDS.some(key => !Object.prototype.hasOwnProperty.call(row, key))) {
          throw new Error("评论身份或字段校验未通过，已停止加载");
        }
        pageIds.add(row.comment_id);
      }
      for (const id of pageIds) ids.add(id);
      rows.push(...response.rows);
      onPage({ rows: response.rows, total, loaded: rows.length });
      if (!isCurrent()) return null;
      if (rows.length === total) return { rows, total };
    }
  }

  async function loadComments(container, { noteId, snapshotToken, currentCommentId = "", request,
    isCurrent = () => true, gallery, onAction = () => {} }) {
    if (!isCurrent()) return null;
    const node = (tag, className, text) => {
      const element = document.createElement(tag); element.className = className || "";
      if (text !== undefined) element.textContent = text;
      return element;
    };
    container.replaceChildren();
    const title = node("h3", "", "全部本地评论");
    const hint = node("p", "detail-meta", "包含已删除评论及各级回复，不受左侧表格筛选影响。仅显示已采集到本地的记录。");
    const progress = node("p", "detail-comments-progress", "正在读取评论…");
    progress.setAttribute("role", "status");
    const list = node("div", "detail-comment-list");
    const controls = node("div", "detail-comments-controls");
    container.append(title, hint, controls, progress, list);
    let selected = null, jump = null, deleted = 0, loaded = 0;
    if (currentCommentId) {
      jump = node("button", "detail-action", "定位当前评论"); jump.type = "button"; jump.disabled = true;
      jump.addEventListener("click", () => {
        if (!isCurrent() || !selected) return;
        selected.scrollIntoView({ block: "nearest" }); selected.focus({ preventScroll: true });
      });
      controls.append(jump);
    }
    try {
      const result = await fetchComments({ noteId, snapshotToken, request, isCurrent, onPage: batch => {
        if (!isCurrent()) return;
        for (const row of batch.rows) {
          const isDeleted = row.comment_status === "已删除" || [true, 1, "1"].includes(row.is_deleted);
          const isReply = Number(row.comment_level) >= 2 || Boolean(row.parent_comment_id);
          const article = node("article", "detail-comment" + (isReply ? " detail-comment-reply" : ""));
          article.dataset.commentId = row.comment_id;
          article.dataset.deleted = String(isDeleted);
          if (row.comment_id === currentCommentId) {
            article.dataset.current = "true"; article.tabIndex = -1;
            article.setAttribute("aria-label", "当前选中的评论"); selected = article; jump.disabled = false;
          }
          const header = node("div", "detail-comment-header");
          header.append(node("strong", "", row.author || "作者未记录"));
          if (row.comment_id === currentCommentId) header.append(node("span", "detail-comment-current", "当前评论"));
          if ([true, 1, "1"].includes(row.is_post_author)) header.append(node("span", "detail-comment-role", "帖主"));
          if (isDeleted) { header.append(node("span", "detail-comment-deleted", "已删除")); deleted += 1; }
          article.append(header);
          article.append(node("p", "detail-meta", [row.published_at && `${row.published_at}（北京时间）`,
            row.ip_location && `IP 属地：${row.ip_location}`, `点赞 ${display(row.like_count)}`].filter(Boolean).join(" · ")));
          if (isReply) {
            const parent = row.thread_root_author ? `回复 @${row.thread_root_author}` : "回复 · 上级评论未采集或作者未记录";
            article.append(node("p", "detail-comment-parent", parent));
          }
          article.append(node("p", "detail-prose", row.content || "（无文字评论）"));
          const actions = node("div", "detail-comment-actions");
          const locate = node("button", "detail-action", "定位原评论 ↗"); locate.type = "button";
          locate.dataset.action = "locate_comment"; locate.dataset.value = row.comment_id;
          locate.addEventListener("click", () => { if (isCurrent()) onAction(locate); });
          actions.append(locate);
          if (gallery) {
            const photos = node("details", "detail-comment-photos");
            photos.append(node("summary", "", "查看评论图片"));
            const album = node("div", "detail-album"); photos.append(album);
            let mounted = false;
            photos.addEventListener("toggle", () => {
              if (!photos.open || mounted || !isCurrent()) return;
              mounted = true;
              gallery.mount(album, { dataset: "comments", recordId: row.comment_id, title: row.author || "评论图片" },
                { layout: "detail", previewLimit: 3, eager: true });
            });
            actions.append(photos);
          }
          article.append(actions); list.append(article);
        }
        loaded = batch.loaded;
        title.textContent = `全部本地评论 · ${batch.total} 条`;
        progress.textContent = `已读取 ${batch.loaded} / ${batch.total} 条`;
      } });
      if (!result || !isCurrent()) return null;
      if (currentCommentId && !selected) throw new Error("当前评论未在同帖列表中找到，请刷新校验后重试");
      progress.textContent = result.total ? `已加载全部 ${result.total} 条 · 现存 ${result.total - deleted} · 已删除 ${deleted}`
        : "本地尚未采集到这篇帖子的评论。";
      return result;
    } catch (error) {
      if (!isCurrent()) return null;
      title.textContent = "本地评论 · 加载未完成";
      progress.className = "detail-load-error"; progress.setAttribute("role", "alert");
      progress.textContent = `${loaded ? `已读取 ${loaded} 条，尚未完整加载。` : ""}${error.message || "评论读取失败"}`;
      const retry = node("button", "detail-action", "重试读取评论"); retry.type = "button";
      retry.addEventListener("click", () => {
        if (!isCurrent() || retry.disabled) return;
        retry.disabled = true;
        void loadComments(container, { noteId, snapshotToken, currentCommentId, request, isCurrent, gallery, onAction });
      });
      controls.append(retry);
      return null;
    }
  }

  function render(container, { dataset, record, fields, snapshotToken, gallery, onAction = () => {} }) {
    const node = (tag, className, value) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (value !== undefined) element.textContent = value;
      return element;
    };
    const action = (label, kind, value) => {
      const button = node("button", "detail-action", label); button.type = "button";
      button.dataset.action = kind; button.dataset.value = String(value || "");
      button.disabled = !value;
      button.addEventListener("click", () => onAction(button));
      return button;
    };
    const pill = (value, key) => {
      const raw = String(value || "");
      const element = node("span", "cell-pill", LABELS[raw] || raw);
      element.dataset.state = /已删除|unreachable|^failed$/.test(raw) ? "deleted"
        : /已忽略|ignored/.test(raw) ? "ignored"
        : /存在|known|synced|^ok$|未忽略|^complete/.test(raw) ? "active" : "pending";
      element.title = raw === "check_failed" ? "访问核验未完成，不代表帖子打不开" : `${key}: ${raw}`;
      return element;
    };
    const section = (title, className = "") => {
      const block = node("section", `detail-section ${className}`);
      block.append(node("h3", "", title)); container.append(block); return block;
    };
    const isComment = dataset === "comments";
    const id = isComment ? record.comment_id : record.note_id;
    container.replaceChildren();

    const identity = node("section", "detail-identity");
    identity.append(node("p", "detail-byline", record.author || "作者未记录"));
    const published = isComment ? record.published_at : record.source_published_at;
    const timeStatus = isComment ? record.published_at_status : record.source_published_at_status;
    const meta = [published && `${published}（北京时间）`,
      (isComment ? record.ip_location : record.source_ip_location) && `IP 属地：${isComment ? record.ip_location : record.source_ip_location}`]
      .filter(present);
    identity.append(node("p", "detail-meta", meta.length ? meta.join(" · ") : "发布时间 / 属地未记录"));
    if (timeStatus === "estimated_from_edit" || timeStatus === "estimated") identity.append(node("p", "detail-meta",
      timeStatus === "estimated_from_edit" ? "按页面编辑时间推算，非首次发布时间；原文与采集基准见全部字段。" : "按相对时间或年份推算；原文与采集基准见全部字段。"));
    const badges = node("div", "detail-badges");
    for (const key of (isComment ? ["comment_status", "comment_type"] : ["post_status", "access_status", "pull_status", "ignore_status"])) {
      if (present(record[key])) badges.append(pill(record[key], key));
    }
    identity.append(badges); container.append(identity);

    const photos = section(isComment ? "评论图片" : "帖子图片", "detail-photos");
    const album = node("div", "detail-album"); photos.append(album);
    if (gallery) gallery.mount(album, { dataset, recordId: id, title: record.title || record.author || "素材图片" }, { layout: "detail", previewLimit: 6, eager: true });
    else album.textContent = "图片预览未加载，请刷新页面";
    const body = section(isComment ? "评论原文" : "完整正文");
    body.append(node("p", "detail-prose", record.content || "未记录正文"));
    if (record.tags) body.append(node("p", "detail-tags", display(record.tags)));

    const stats = node("div", "detail-stats");
    for (const [key, label] of (isComment ? [["like_count", "点赞"], ["reply_count", "回复"], ["comment_level", "评论层级"]]
      : [["source_like_count", "点赞"], ["source_collect_count", "收藏"], ["active_comment_count", "本地现存评论"], ["deleted_comment_count", "已删除评论"]])) {
      const stat = node("div"); stat.append(node("strong", "", display(record[key])), node("span", "", label)); stats.append(stat);
    }
    container.append(stats);
    const commentsContainer = section("全部本地评论", "detail-comments");
    const actions = node("div", "detail-actions");
    if (isComment) {
      actions.append(action("定位原评论 ↗", "locate_comment", id), action("定位帖子数据库", "locate_post", record.note_id));
      if (record.post__open_material) actions.append(action("打开原帖素材", "open_material", record.note_id));
    } else if (record.open_material || record.media_dir) actions.append(action("打开本地素材", "open_material", id));
    container.append(actions);

    if (isComment && record.thread_root_id && record.thread_root_id !== id) {
      const parent = section("对应一级评论", "detail-parent");
      parent.append(node("strong", "", record.thread_root_author || "作者未记录"));
      parent.append(node("p", "detail-prose", record.thread_root_content || "一级评论尚未采集，未推断原文"));
      parent.append(node("code", "detail-id", record.thread_root_id));
    }
    if (isComment && record.note_id) {
      const post = section("关联原帖", "detail-parent");
      post.append(node("strong", "", record.post__title || record.note_id));
      post.append(node("p", "detail-meta", [record.post__author, record.post__source_published_at, record.post__post_status].filter(present).join(" · ")));
      const excerpt = node("details", "detail-post-context"); excerpt.append(node("summary", "", "展开原帖正文与图片"));
      const prose = node("p", "detail-prose", record.post__content || "未记录原帖正文"); excerpt.append(prose);
      const postAlbum = node("div", "detail-album"); excerpt.append(postAlbum);
      let mounted = false;
      excerpt.addEventListener("toggle", () => {
        if (!excerpt.open || mounted) return;
        mounted = true;
        gallery?.mount(postAlbum, { dataset: "notes", recordId: record.note_id, title: record.post__title || "原帖图片" }, { layout: "detail", previewLimit: 3, eager: true });
      });
      post.append(excerpt);
    }

    const available = fields.filter(field => !field.action && Object.prototype.hasOwnProperty.call(record, field.key));
    const all = node("details", "detail-all-fields");
    all.append(node("summary", "", `全部字段 · ${available.length} 项`));
    const groups = new Map();
    for (const field of available) {
      const name = fieldGroup(field.key);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(field);
    }
    for (const [name, members] of groups) {
      const group = node("section", "detail-field-group"); group.append(node("h4", "", name));
      for (const field of members) {
        const value = record[field.key];
        const row = node("dl", "drawer-field");
        const label = node("dt", "", field.label || field.key); label.title = field.key;
        const output = node("dd");
        if (STATUS.test(field.key) && present(value)) output.append(pill(value, field.key));
        else if (field.dataType === "boolean" && present(value)) output.textContent = [true, 1, "1"].includes(value) ? "是" : "否";
        else if (/json$/.test(field.key) && present(value)) {
          const raw = node("details", "detail-json"); raw.append(node("summary", "", "查看结构化数据"));
          let parsed = value;
          if (typeof value === "string") { try { parsed = JSON.parse(value); } catch (_error) {} }
          raw.append(node("pre", "", display(parsed))); output.append(raw);
        } else if (/url$/i.test(field.key) && safeLink(value)) {
          const link = node("a", "cell-link", String(value)); link.href = safeLink(value); link.target = "_blank"; link.rel = "noopener noreferrer";
          output.append(link);
        } else output.textContent = display(value);
        row.append(label, output); group.append(row);
      }
      all.append(group);
    }
    container.append(all);
    const provenance = node("p", "detail-provenance", `完整记录 · 校验快照 ${snapshotToken.slice(0, 14).toUpperCase()}\n仅查看，不修改数据库；图片按记录 ID 与素材版本单独校验。`);
    container.append(provenance);
    return { commentsContainer };
  }

  return Object.freeze({ fetchRecord, fetchComments, loadComments, COMMENT_FIELDS, render, safeLink, fieldGroup, display });
});
