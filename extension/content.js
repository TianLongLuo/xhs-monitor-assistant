(function () {
  "use strict";
  if (globalThis.__XHS_MONITOR_CONTENT_V0151__) return;
  globalThis.__XHS_MONITOR_CONTENT_V0151__ = true;

  const DEFAULT_CONFIG = { targetKeywords: ["品牌词"], enabled: true };
  let activeRelevanceGroups = null;
  const relevanceMatch = (note) => globalThis.XhsMonitorRelevance.match(note, activeRelevanceGroups);
  const pageContext = globalThis.XhsMonitorPageContext;
  const noteUtils = globalThis.XhsMonitorNoteUtils;
  const commentUtils = globalThis.XhsMonitorCommentUtils;
  const detailStore = globalThis.XhsMonitorDetailStore.create();
  const CARD_MARK = "data-xhs-monitor-card";
  const TOOLBAR_CLASS = "xhs-monitor-toolbar";
  const PROCESS_PANEL_CLASS = "xhs-monitor-process";
  const NOTE_LINK_SELECTOR = [
    'a[href*="/explore/"]',
    'a[href*="/discovery/item/"]',
    'a[href*="/search_result/"]',
    'a[href*="/item/"]',
    'a[href*="/note/"]',
    'section.note-item a[href]',
    '.feeds-container a[href]'
  ].join(", ");
  const NOTE_CARD_SELECTOR = [
    "section.note-item", ".note-item", '[class*="note-item"]',
    '[class*="noteItem"]', '[data-note-id]', '[note-id]'
  ].join(", ");
  let config = { ...DEFAULT_CONFIG };
  let bridgeReady = false;
  let scanTimer = null;
  let started = false;
  let activeScan = null;
  let pendingScan = false;
  let rememberedKeyword = "";
  let deepScanActive = false;
  let activeDeepScanPromise = null;
  let deepScanQueued = false;
  let deepScanTimer = null;
  const pullingNoteIds = new Set();
  const relevanceAnalyzingNoteIds = new Set();
  const detailRetryAt = new Map();
  const AUTO_DETAIL_RETRY_DELAY_MS = 60_000;
  let processPanel = null;
  let processPanelObserver = null;
  let currentDetailHint = null;
  let detailControlTimer = null;
  let lastDetailSignal = "";
  let lastAutoScanFingerprint = "";
  let lastAutoScanResult = null;
  let dismissedDetailId = "";

  const PROCESS_STEPS = [
    { id: "open", label: "打开帖子", hint: "点击卡片并展开详情" },
    { id: "body", label: "正文与字段", hint: "标题、正文、话题、作者" },
    { id: "comments", label: "评论及 ID", hint: "读取评论并生成稳定 ID" },
    { id: "media", label: "素材文件", hint: "提取图片 / 视频并保存帖子文件夹" },
    { id: "excel", label: "Excel / SQLite", hint: "按总表字段幂等写入" }
  ];

  const PROCESS_NOTE_FIELDS = [
    ["笔记url", "url"], ["用户主页url", "authorUrl"], ["用户昵称", "author"],
    ["笔记标题", "title"], ["笔记内容", "content"], ["笔记话题", "tags"],
    ["点赞量", "likeCount"], ["收藏量", "collectCount"], ["评论量", "commentCount"],
    ["分享量", "shareCount"], ["发布时间", "publishedAt"], ["更新时间", "updatedAt"],
    ["IP地址", "ipLocation"], ["图片数量", "imageCount"], ["视频数量", "videoCount"], ["发布日期", "publishedAt"],
    ["来源词", "keyword"], ["笔记ID", "noteId"], ["博主ID", "authorId"],
    ["对应帖子文件夹地址", "mediaDir"], ["文件夹内清单", "mediaFiles"],
    ["AI情绪判断", "postSentiment"], ["帖子好坏", "postSentiment"]
  ];

  function sendRuntime(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
  }

  function isSearchPage() {
    return pageContext.isSearchSurface({
      href: location.href,
      hasSearchLayout: Boolean(document.querySelector(
        ".search-layout .feeds-container section.note-item, .search-layout section.note-item[data-note-id]"
      ))
    });
  }

  function hasTrackableNoteSurface() {
    return Boolean(document.querySelector(`${NOTE_LINK_SELECTOR}, [data-note-id], [note-id]`));
  }

  function currentKeyword() {
    const input = document.querySelector('input[placeholder*="搜索"], input[placeholder*="搜"]');
    const keyword = pageContext.resolveKeyword({
      href: location.href,
      inputValue: input?.value || "",
      remembered: rememberedKeyword
    });
    if (keyword) rememberedKeyword = keyword;
    return keyword;
  }

  function detailDescription(root = document) {
    const selectors = [
      "#detail-desc", "[data-note-content]", ".note-text", "[class*='note-text']",
      "[class*='desc']", "[class*='Desc']", "[class*='content']"
    ];
    for (const selector of selectors) {
      const candidates = [];
      for (const element of root.querySelectorAll?.(selector) || []) {
        const value = clean(element.innerText || element.getAttribute?.("data-note-content"), 12000);
        if (value.length >= 4) candidates.push({ element, value });
      }
      if (!candidates.length) continue;
      candidates.sort((left, right) => right.value.length - left.value.length);
      return candidates[0];
    }
    return { element: null, value: "" };
  }

  function openDetailIsRelevant() {
    const description = detailDescription();
    if (!description.element) return false;
    const content = description.value;
    if (!content) return false;
    return relevanceMatch({
      title: clean(document.querySelector("#detail-title")?.innerText, 1000),
      content,
      tags: extractTags(description.element, content)
    }).relevant;
  }

  function shouldAutoScan() {
    if (deepScanActive || !bridgeReady || !config.enabled) return false;
    // Search pages remain keyword-gated. Other XHS surfaces (首页、推荐流、个人页)
    // still receive a lightweight card decoration so a late-loaded card is never
    // silently left without the “拉取” affordance.
    if (!isSearchPage()) return hasTrackableNoteSurface();
    const keyword = currentKeyword().toLocaleLowerCase();
    if (keyword) return config.targetKeywords.some((target) => keyword.includes(target));
    // Handles a page loaded/reloaded while an XHS-Monitor detail modal is already
    // open over a search grid and the original search keyword is unavailable.
    return openDetailIsRelevant();
  }

  function noteIdFromUrl(value) {
    try {
      const url = new URL(value, location.href);
      const match = url.pathname.match(/\/(?:explore|discovery\/item|search_result|item|note)\/([A-Za-z0-9_-]+)/);
      return match ? match[1] : "";
    } catch (_error) {
      return "";
    }
  }

  function clean(value, limit = 600) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function processValue(value, limit = 220) {
    if (Array.isArray(value)) return value.map((item) => processValue(item, 80)).filter(Boolean).join("、").slice(0, limit);
    if (value === null || value === undefined) return "";
    return clean(value, limit);
  }

  function processMetric(root, patterns) {
    const keys = patterns.map((value) => String(value).toLocaleLowerCase());
    const primarySelectors = keys.some((value) => value === "like" || value.includes("点赞"))
      ? [".engage-bar-style .like-wrapper > .count"]
      : keys.some((value) => value === "collect" || value.includes("收藏") || value === "star")
        ? [".engage-bar-style .collect-wrapper > .count"]
        : keys.some((value) => value === "comment" || value.includes("评论"))
          ? [".engage-bar-style .chat-wrapper > .count", ".comments-container .total"]
          : keys.some((value) => value === "share" || value.includes("分享"))
            ? [".engage-bar-style .share-wrapper > .count", ".engage-bar-style .share-wrapper .count"]
            : [];
    for (const selector of primarySelectors) {
      const value = clean(root?.querySelector?.(selector)?.innerText, 120);
      if (value && /\d|万|w/i.test(value)) return value;
    }
    if (keys.some((value) => value === "comment" || value.includes("评论"))) {
      const match = clean(root?.querySelector?.(".comments-container")?.innerText, 200)
        .match(/共\s*([\d,.]+\s*[万wW]?)\s*条评论/);
      if (match) return match[1].replace(/\s+/g, "");
    }
    if (keys.some((value) => value === "share" || value.includes("分享"))
        && root?.querySelector?.(".engage-bar-style .share-wrapper")) return "未显示";
    const candidates = [];
    for (const element of root?.querySelectorAll?.("button, [role='button'], span, p, div") || []) {
      if (element.closest?.(".comments-container, .comment-item")) continue;
      const marker = [
        element.getAttribute?.("aria-label"), element.getAttribute?.("title"),
        element.className, element.innerText
      ].map((value) => String(value || "").toLocaleLowerCase()).join(" ");
      if (!patterns.some((pattern) => marker.includes(pattern))) continue;
      const value = clean(element.innerText || element.getAttribute?.("aria-label"), 120);
      const match = value.match(/(?:^|[^\d])([\d,.]+\s*[万wW]?)(?:$|[^\d万wW])/);
      if (match) candidates.push(match[1].replace(/\s+/g, ""));
    }
    return candidates[0] || "";
  }

  function processIpLocation(root) {
    for (const element of root?.querySelectorAll?.("span, p, div, time") || []) {
      const value = clean(element.innerText, 100);
      if (/^(IP属地|IP所在地|来自)\s*[:：]?/.test(value)) return value.replace(/^(IP属地|IP所在地|来自)\s*[:：]?\s*/, "");
    }
    return "";
  }

  function processDetailMetadata(root) {
    const raw = clean(root?.querySelector?.(".note-content .date, .bottom-container .date, time, [class*='date']")?.innerText, 200);
    const datePattern = "\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}(?:\\s+\\d{1,2}:\\d{2})?";
    const updatedMatch = raw.match(new RegExp(`(?:编辑于|更新于)\\s*(${datePattern})`));
    const publishedMatch = raw.match(new RegExp(datePattern));
    const explicitIp = processIpLocation(root);
    const locationMatch = raw.match(/(?:IP属地|IP所在地|来自)\s*[:：]?\s*([^\s]+)/);
    return {
      publishedAt: publishedMatch?.[0] || raw,
      updatedAt: updatedMatch?.[1] || "未显示",
      ipLocation: explicitIp || locationMatch?.[1] || "未显示"
    };
  }

  function processAuthorId(authorUrl) {
    try {
      const url = new URL(authorUrl, location.href);
      const parts = url.pathname.split("/").filter(Boolean);
      return parts[parts.length - 1] || "";
    } catch (_error) {
      return "";
    }
  }

  async function ensureCommentIds(note, comments) {
    const rows = Array.isArray(comments) ? comments : [];
    return Promise.all(rows.map(async (comment) => {
      if (comment?.commentId) return comment;
      const identity = [
        note?.noteId || "",
        comment?.author || "",
        comment?.content || "",
        comment?.publishedAt || ""
      ].join("\u001f");
      try {
        const bytes = new TextEncoder().encode(identity);
        const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
        const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
        return { ...comment, commentId: `dom-${hex.slice(0, 32)}` };
      } catch (_error) {
        return { ...comment, commentId: "" };
      }
    }));
  }

  function processNoteFields(note = {}, extras = {}) {
    const source = { ...note, ...extras };
    const fields = {};
    for (const [label, key] of PROCESS_NOTE_FIELDS) {
      let value = source[key];
      if (label === "笔记话题") value = source.tags;
      if (label === "笔记话题" && Array.isArray(value) && !value.length && source.detailRead) value = "无话题";
      if (label === "图片数量" && value === undefined) value = source.imageUrls?.length || 0;
      if (label === "视频数量" && value === undefined) value = source.videoUrls?.length || 0;
      if (label === "发布日期") value = processValue(source.publishedAt, 100).slice(0, 10);
      if (label === "文件夹内清单" && Array.isArray(value)) value = value.join("\n");
      if ((label === "AI情绪判断" || label === "帖子好坏") && !value) {
        const aiLabels = {
          queued: "AI 排队中", analyzing: "AI 分析中", completed: "AI 已完成",
          failed: "AI 分析失败", manual: "AI 待手动分析", not_configured: "AI 未配置"
        };
        value = aiLabels[source.aiStatus] || "";
      }
      fields[label] = processValue(value, label === "笔记内容" ? 520 : 220);
    }
    return fields;
  }

  function processStepIndex(phase) {
    const index = PROCESS_STEPS.findIndex((step) => step.id === phase);
    return index >= 0 ? index : 0;
  }

  function processStatusText(message = {}) {
    if (message.error) return message.error;
    if (message.done) return message.pullStatus === "partial" ? "已写入，部分内容可重试" : "已完成并写入本地 Excel";
    return message.title || PROCESS_STEPS.find((step) => step.id === message.phase)?.hint || "处理中…";
  }

  function removeProcessPanel() {
    if (processPanel?._aiPollTimer) {
      clearInterval(processPanel._aiPollTimer);
      processPanel._aiPollTimer = null;
    }
    processPanelObserver?.disconnect?.();
    processPanelObserver = null;
    window.removeEventListener("resize", positionProcessPanel);
    processPanel?.remove?.();
    processPanel = null;
  }

  function dismissProcessPanel() {
    dismissedDetailId = processPanel?.dataset.noteId || "";
    removeProcessPanel();
  }

  function processButton(label, className, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.setAttribute("aria-label", label);
    button.textContent = label;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handler();
    });
    return button;
  }

  function enableProcessPanelScroll(panel) {
    if (!panel || panel._scrollShielded) return;
    panel._scrollShielded = true;
    // Xiaohongshu's detail layer installs its own wheel handlers. Shield the
    // Process panel and perform the vertical scroll locally so the page/modal
    // cannot swallow the gesture or trigger a new card scan.
    panel.addEventListener("wheel", (event) => {
      if (panel.classList.contains(`${PROCESS_PANEL_CLASS}--collapsed`)) return;
      const delta = event.deltaMode === 1 ? event.deltaY * 16
        : event.deltaMode === 2 ? event.deltaY * panel.clientHeight
          : event.deltaY;
      const maxScroll = Math.max(0, panel.scrollHeight - panel.clientHeight);
      if (!maxScroll || !Number.isFinite(delta) || delta === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      panel.scrollTop = Math.max(0, Math.min(maxScroll, panel.scrollTop + delta));
    }, { capture: true, passive: false });
    panel.addEventListener("touchmove", (event) => event.stopPropagation(), { capture: true, passive: true });
  }

  function processDockRect(note = {}) {
    const exactContainer = document.querySelector("#noteContainer.note-container, #noteContainer");
    const exactRect = exactContainer?.getBoundingClientRect?.();
    if (exactRect && exactRect.width >= 600 && exactRect.height >= 240) {
      return { node: exactContainer, rect: exactRect };
    }
    const detail = detailRootForNote(note);
    if (!detail) return null;
    const detailRect = detail.getBoundingClientRect?.();
    if (!detailRect) return null;
    const candidates = [];
    const viewportGuard = Math.max(48, Math.min(120, window.innerWidth * 0.045));
    const maximumDockRight = window.innerWidth - viewportGuard;
    let node = detail;
    for (let depth = 0; depth < 8 && node && node !== document.body && node !== document.documentElement; depth += 1) {
      const rect = node.getBoundingClientRect?.();
      const marker = `${node.id || ""} ${typeof node.className === "string" ? node.className : ""} ${node.getAttribute?.("role") || ""}`;
      const isDetailShell = node === detail || /note.?detail|notecontainer|modal|dialog/i.test(marker);
      if (rect && isDetailShell && rect.width >= 320 && rect.height >= 180) {
        const coversViewport = rect.width >= window.innerWidth * 0.94 && rect.height >= window.innerHeight * 0.9;
        const endsBeforePageRail = rect.right <= maximumDockRight;
        const containsDetailEdge = rect.right >= detailRect.right - 2;
        if (!coversViewport && endsBeforePageRail && containsDetailEdge) {
          // Prefer the outermost semantic detail shell that shares the post's
          // right edge. Generic search/feed ancestors are intentionally
          // excluded; choosing one of those caused the panel to fall back over
          // the top-right corner instead of docking beside the open post.
          candidates.push({ node, rect, score: rect.right * 100000 + rect.width * rect.height });
        }
      }
      node = node.parentElement;
    }
    if (!candidates.length) return { node: detail, rect: detailRect };
    candidates.sort((left, right) => right.score - left.score);
    return candidates[0];
  }

  function positionProcessPanel() {
    if (!processPanel) return;
    const dock = processDockRect(processPanel._processNote || {});
    const rect = dock?.rect;
    if (!rect) return;
    const gap = 8;
    const edge = 8;
    const availableRight = Math.floor(window.innerWidth - rect.right - gap - edge);
    const top = Math.max(edge, Math.min(Math.round(rect.top), window.innerHeight - 72));
    processPanel.style.top = `${top}px`;
    processPanel.style.maxHeight = `${Math.max(180, Math.floor(window.innerHeight - top - edge))}px`;
    if (availableRight >= 188) {
      const panelWidth = Math.min(304, availableRight);
      processPanel.style.width = `${panelWidth}px`;
      processPanel.style.left = `${Math.round(rect.right + gap)}px`;
      processPanel.style.right = "auto";
      processPanel.dataset.position = "outside";
      processPanel.dataset.dockRight = String(Math.round(rect.right));
    } else {
      const panelWidth = Math.min(280, Math.max(204, Math.round(rect.width * 0.28)));
      processPanel.style.width = `${panelWidth}px`;
      processPanel.style.left = `${Math.max(edge, Math.round(rect.right - panelWidth - 10))}px`;
      processPanel.style.right = "auto";
      processPanel.dataset.position = "overlay";
      processPanel.dataset.dockRight = String(Math.round(rect.right));
    }
  }

  function mountProcessPanel(note = {}) {
    if (processPanel?.dataset.noteId === note.noteId) return processPanel;
    removeProcessPanel();
    const panel = document.createElement("aside");
    panel.className = PROCESS_PANEL_CLASS;
    panel.dataset.noteId = note.noteId || "";
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    panel._processNote = { ...note };
    panel._detailOpened = false;

    const header = document.createElement("div");
    header.className = `${PROCESS_PANEL_CLASS}__head`;
    const heading = document.createElement("div");
    heading.className = `${PROCESS_PANEL_CLASS}__heading`;
    const eyebrow = document.createElement("span");
    eyebrow.className = `${PROCESS_PANEL_CLASS}__eyebrow`;
    eyebrow.textContent = "ORIGANI RADAR";
    const title = document.createElement("strong");
    title.className = `${PROCESS_PANEL_CLASS}__title`;
    title.textContent = "拉取进度";
    const status = document.createElement("small");
    status.className = `${PROCESS_PANEL_CLASS}__status`;
    status.textContent = "准备打开帖子";
    const headStates = document.createElement("div");
    headStates.className = `${PROCESS_PANEL_CLASS}__head-states`;
    const headPullState = document.createElement("span");
    headPullState.className = `${PROCESS_PANEL_CLASS}__head-state ${PROCESS_PANEL_CLASS}__head-state--pull`;
    headPullState.textContent = "未拉取";
    const headRelevanceState = document.createElement("span");
    headRelevanceState.className = `${PROCESS_PANEL_CLASS}__head-state ${PROCESS_PANEL_CLASS}__head-state--relevance`;
    headRelevanceState.textContent = "相关性未知";
    headStates.append(headPullState, headRelevanceState);
    heading.append(eyebrow, title, status, headStates);
    const actions = document.createElement("div");
    actions.className = `${PROCESS_PANEL_CLASS}__actions`;
    const pullButton = processButton("拉取到 Excel", `${PROCESS_PANEL_CLASS}__pull`, () => {
      pullFromProcessPanel(panel).catch(() => {});
    });
    pullButton.textContent = "拉取";
    const collapseButton = processButton("折叠或展开 Process", `${PROCESS_PANEL_CLASS}__collapse`, () => {
      panel.classList.toggle(`${PROCESS_PANEL_CLASS}--collapsed`);
      positionProcessPanel();
    });
    collapseButton.textContent = "−";
    const closeButton = processButton("关闭 Process", `${PROCESS_PANEL_CLASS}__close`, dismissProcessPanel);
    closeButton.textContent = "×";
    actions.append(pullButton, collapseButton, closeButton);
    header.append(heading, actions);

    const target = document.createElement("div");
    target.className = `${PROCESS_PANEL_CLASS}__target`;
    const targetTitle = document.createElement("strong");
    targetTitle.className = `${PROCESS_PANEL_CLASS}__target-title`;
    targetTitle.textContent = note.title || "未命名帖子";
    const targetId = document.createElement("span");
    targetId.className = `${PROCESS_PANEL_CLASS}__target-id`;
    targetId.textContent = `ID ${note.noteId || "—"}`;
    const targetStates = document.createElement("div");
    targetStates.className = `${PROCESS_PANEL_CLASS}__target-states`;
    const pullState = document.createElement("span");
    pullState.className = `${PROCESS_PANEL_CLASS}__state ${PROCESS_PANEL_CLASS}__state--pull`;
    pullState.textContent = "拉取状态：读取中";
    const relevanceState = document.createElement("span");
    relevanceState.className = `${PROCESS_PANEL_CLASS}__state ${PROCESS_PANEL_CLASS}__state--relevance`;
    relevanceState.textContent = "相关性：读取中";
    targetStates.append(pullState, relevanceState);
    target.append(targetTitle, targetId, targetStates);

    const progress = document.createElement("div");
    progress.className = `${PROCESS_PANEL_CLASS}__progress`;
    const progressBar = document.createElement("i");
    progressBar.className = `${PROCESS_PANEL_CLASS}__progress-bar`;
    progress.append(progressBar);

    const steps = document.createElement("ol");
    steps.className = `${PROCESS_PANEL_CLASS}__steps`;
    for (const step of PROCESS_STEPS) {
      const item = document.createElement("li");
      item.dataset.step = step.id;
      const marker = document.createElement("span");
      marker.className = `${PROCESS_PANEL_CLASS}__step-marker`;
      marker.textContent = "·";
      const copy = document.createElement("span");
      copy.className = `${PROCESS_PANEL_CLASS}__step-copy`;
      const label = document.createElement("strong");
      label.textContent = step.label;
      const hint = document.createElement("small");
      hint.textContent = step.hint;
      copy.append(label, hint);
      item.append(marker, copy);
      if (step.id === "media" || step.id === "excel") {
        const open = document.createElement("button");
        open.type = "button";
        open.className = `${PROCESS_PANEL_CLASS}__step-open`;
        open.dataset.artifact = step.id;
        open.textContent = "打开";
        open.disabled = true;
        open.title = step.id === "media" ? "打开该帖子的素材文件夹" : "打开 Excel 并定位到该帖子";
        open.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          const artifacts = panel._processArtifacts || {};
          open.disabled = true;
          open.textContent = "打开中";
          try {
            const result = await sendRuntime({
              type: "openLocalArtifact",
              payload: {
                kind: step.id === "media" ? "folder" : "excel",
                noteId: artifacts.noteId || panel._processNote?.noteId || "",
                fieldName: "笔记标题",
                excelRow: artifacts.excelRow || 0
              }
            });
            if (!result?.ok) throw new Error(result?.error || "打开失败");
            open.textContent = "已打开";
          } catch (error) {
            open.textContent = "重试";
            open.title = error.message || "打开失败";
          } finally {
            const ready = step.id === "media"
              ? Boolean(panel._processArtifacts?.mediaDir)
              : Boolean(panel._processArtifacts?.excelPath);
            open.disabled = !ready;
            setTimeout(() => { if (open.isConnected) open.textContent = "打开"; }, 1400);
          }
        });
        item.append(open);
      }
      steps.append(item);
    }

    const fieldSection = document.createElement("section");
    fieldSection.className = `${PROCESS_PANEL_CLASS}__section`;
    const fieldHead = document.createElement("div");
    fieldHead.className = `${PROCESS_PANEL_CLASS}__section-head`;
    const fieldLabel = document.createElement("strong");
    fieldLabel.textContent = "Excel 字段对齐";
    const fieldCount = document.createElement("span");
    fieldCount.className = `${PROCESS_PANEL_CLASS}__field-count`;
    fieldHead.append(fieldLabel, fieldCount);
    const fields = document.createElement("div");
    fields.className = `${PROCESS_PANEL_CLASS}__fields`;
    fieldSection.append(fieldHead, fields);

    const commentSection = document.createElement("section");
    commentSection.className = `${PROCESS_PANEL_CLASS}__section`;
    const commentHead = document.createElement("div");
    commentHead.className = `${PROCESS_PANEL_CLASS}__section-head`;
    const commentLabel = document.createElement("strong");
    commentLabel.textContent = "评论及 ID";
    const commentCount = document.createElement("span");
    commentCount.className = `${PROCESS_PANEL_CLASS}__comment-count`;
    commentHead.append(commentLabel, commentCount);
    const comments = document.createElement("div");
    comments.className = `${PROCESS_PANEL_CLASS}__comments`;
    commentSection.append(commentHead, comments);

    const foot = document.createElement("div");
    foot.className = `${PROCESS_PANEL_CLASS}__foot`;
    foot.textContent = "详情层保持打开；完成后可直接核对原文和评论";
    panel.append(header, target, progress, steps, fieldSection, commentSection, foot);
    (document.body || document.documentElement).append(panel);
    enableProcessPanelScroll(panel);
    processPanel = panel;
    processPanelObserver = new MutationObserver(() => {
      if (panel._detailOpened && !detailRootForNote(panel._processNote || {})) removeProcessPanel();
    });
    processPanelObserver.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("resize", positionProcessPanel, { passive: true });
    return panel;
  }

  function renderProcessAIBars(panel, status, percent) {
    const rows = panel?.querySelectorAll(`.${PROCESS_PANEL_CLASS}__field[data-ai-field]`) || [];
    const safePercent = Math.max(3, Math.min(100, Number(percent) || 0));
    rows.forEach((row) => {
      const strong = row.querySelector("strong");
      if (!strong) return;
      strong.className = "";
      if (status === "completed") {
        row.dataset.state = "ready";
        strong.classList.add(`${PROCESS_PANEL_CLASS}__ai-done`);
        strong.textContent = "✓ AI 已完成，已写入 Excel";
      } else if (status === "failed") {
        row.dataset.state = "ready";
        strong.classList.add(`${PROCESS_PANEL_CLASS}__ai-fail`);
        strong.textContent = "AI 分析失败，可在侧边栏重试";
      } else if (status === "queued" || status === "analyzing") {
        row.dataset.state = "ready";
        strong.classList.add(`${PROCESS_PANEL_CLASS}__ai-progress`);
        strong.replaceChildren();
        const track = document.createElement("span");
        track.className = `${PROCESS_PANEL_CLASS}__ai-track`;
        const fill = document.createElement("i");
        fill.style.width = `${safePercent}%`;
        track.append(fill);
        const label = document.createElement("em");
        label.textContent = `${status === "queued" ? "排队中" : "分析中"} ${safePercent}%`;
        strong.append(track, label);
      } else {
        strong.textContent = "后台 AI";
      }
    });
  }

  function startProcessAIPoll(panel, noteId, aiStatus) {
    if (panel?._aiPollTimer) {
      clearInterval(panel._aiPollTimer);
      panel._aiPollTimer = null;
    }
    if (!panel || !noteId) return;
    const active = aiStatus === "queued" || aiStatus === "analyzing";
    if (aiStatus === "completed" || aiStatus === "failed") {
      renderProcessAIBars(panel, aiStatus, 100);
      return;
    }
    if (!active) return;
    renderProcessAIBars(panel, aiStatus, 8);
    const startedAt = Date.now();
    panel._aiPollTimer = setInterval(() => {
      try {
        chrome.runtime.sendMessage({ type: "getNoteAIProgress", noteId }, (response) => {
          if (chrome.runtime.lastError || processPanel !== panel) {
            clearInterval(panel._aiPollTimer);
            panel._aiPollTimer = null;
            return;
          }
          if (Date.now() - startedAt > 10 * 60 * 1000) {
            clearInterval(panel._aiPollTimer);
            panel._aiPollTimer = null;
            return;
          }
          const status = response?.status || "";
          const percent = Number(response?.percent) || 0;
          if (status === "completed" || status === "failed") {
            renderProcessAIBars(panel, status, 100);
            clearInterval(panel._aiPollTimer);
            panel._aiPollTimer = null;
          } else if (status) {
            renderProcessAIBars(panel, status, percent);
          }
        });
      } catch (_error) {
        clearInterval(panel._aiPollTimer);
        panel._aiPollTimer = null;
      }
    }, 2500);
  }

  function renderProcessPanel(message = {}) {
    const note = {
      ...(processPanel?._processNote || {}), ...(message.note || {}),
      noteId: message.noteId || message.note?.noteId || processPanel?._processNote?.noteId || "",
      title: message.note?.title || message.title || processPanel?._processNote?.title || ""
    };
    const panel = mountProcessPanel({ ...note, noteId: message.noteId || note.noteId });
    panel._processNote = note;
    panel.dataset.mode = message.done ? "done" : "processing";
    panel.classList.remove(`${PROCESS_PANEL_CLASS}--collapsed`);
    const pullButton = panel.querySelector(`.${PROCESS_PANEL_CLASS}__pull`);
    if (pullButton) {
      pullButton.disabled = !message.done;
      pullButton.textContent = message.done ? "补采" : "处理中";
    }
    const phase = message.error ? (message.phase || "open") : (message.done ? "excel" : (message.phase || "open"));
    const activeIndex = processStepIndex(phase);
    const status = panel.querySelector(`.${PROCESS_PANEL_CLASS}__status`);
    if (status) status.textContent = processStatusText(message);
    const targetTitle = panel.querySelector(`.${PROCESS_PANEL_CLASS}__target-title`);
    const targetId = panel.querySelector(`.${PROCESS_PANEL_CLASS}__target-id`);
    if (targetTitle) targetTitle.textContent = note.title || "未命名帖子";
    if (targetId) targetId.textContent = `ID ${note.noteId || message.noteId || "—"}`;
    if (message.mode === "relevance" && message.done) {
      const relevance = panel.querySelector(`.${PROCESS_PANEL_CLASS}__state--relevance`);
      const headRelevance = panel.querySelector(`.${PROCESS_PANEL_CLASS}__head-state--relevance`);
      const value = message.relevanceStatus || "unknown";
      const label = value === "relevant" ? "相关" : value === "irrelevant" ? "不相关" : "相关性未知";
      if (relevance) { relevance.dataset.state = value; relevance.textContent = `相关性：${label.replace("相关性", "")}`; }
      if (headRelevance) { headRelevance.dataset.state = value; headRelevance.textContent = label; }
    }
    panel.dataset.phase = phase;
    panel.classList.toggle(`${PROCESS_PANEL_CLASS}--error`, Boolean(message.error));
    panel.classList.toggle(`${PROCESS_PANEL_CLASS}--done`, Boolean(message.done && !message.error));
    panel.querySelectorAll(`.${PROCESS_PANEL_CLASS}__steps li`).forEach((item, index) => {
      const state = message.error && index === activeIndex
        ? "error"
        : message.done || index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
      item.dataset.state = state;
      const marker = item.querySelector(`.${PROCESS_PANEL_CLASS}__step-marker`);
      if (marker) marker.textContent = state === "done" ? "✓" : state === "error" ? "!" : state === "active" ? "•" : "·";
    });
    const progressBar = panel.querySelector(`.${PROCESS_PANEL_CLASS}__progress-bar`);
    const progressPercent = message.done ? 100 : Math.max(8, ((activeIndex + (message.error ? 0 : 0.35)) / PROCESS_STEPS.length) * 100);
    if (progressBar) progressBar.style.width = `${progressPercent}%`;
    panel.style.setProperty("--signal-progress", `${progressPercent}%`);

    const merged = { ...note };
    if (message.mediaDir) merged.mediaDir = message.mediaDir;
    if (message.mediaFiles) merged.mediaFiles = message.mediaFiles;
    if (message.imageCount !== undefined) merged.imageCount = message.imageCount;
    else if (message.mediaCount !== undefined && merged.imageCount === undefined) merged.imageCount = message.mediaCount;
    if (message.videoCount !== undefined) merged.videoCount = message.videoCount;
    if (message.commentCount !== undefined) merged.commentCount = message.commentCount;
    if (message.excelPath) merged.excelPath = message.excelPath;
    if (message.excelRow) merged.excelRow = message.excelRow;
    if (message.aiStatus) merged.aiStatus = message.aiStatus;
    panel._processArtifacts = {
      ...(panel._processArtifacts || {}),
      noteId: merged.noteId || message.noteId || "",
      excelPath: message.excelPath || panel._processArtifacts?.excelPath || "",
      excelRow: message.excelRow || panel._processArtifacts?.excelRow || 0,
      mediaDir: message.mediaDir || merged.mediaDir || panel._processArtifacts?.mediaDir || "",
      mediaFiles: message.mediaFiles || merged.mediaFiles || panel._processArtifacts?.mediaFiles || []
    };
    const mediaOpen = panel.querySelector(`.${PROCESS_PANEL_CLASS}__step-open[data-artifact="media"]`);
    const excelOpen = panel.querySelector(`.${PROCESS_PANEL_CLASS}__step-open[data-artifact="excel"]`);
    if (mediaOpen) mediaOpen.disabled = !panel._processArtifacts.mediaDir;
    if (excelOpen) excelOpen.disabled = !panel._processArtifacts.excelPath;
    const fieldMap = processNoteFields(merged);
    const fieldRoot = panel.querySelector(`.${PROCESS_PANEL_CLASS}__fields`);
    let filled = 0;
    if (fieldRoot) {
      fieldRoot.replaceChildren();
      const deferredFields = new Set(["AI情绪判断", "帖子好坏"]);
      for (const [label] of PROCESS_NOTE_FIELDS) {
        const value = fieldMap[label] || "";
        if (value && !deferredFields.has(label)) filled += 1;
        const deferred = deferredFields.has(label) && !value;
        const row = document.createElement("div");
        row.className = `${PROCESS_PANEL_CLASS}__field`;
        if (deferredFields.has(label)) row.dataset.aiField = "1";
        row.dataset.state = value ? "ready" : deferred ? "deferred" : "pending";
        const name = document.createElement("span");
        name.textContent = label;
        const content = document.createElement("strong");
        content.textContent = value || (deferred ? "后台 AI" : "待读取");
        if (value) content.title = value;
        row.append(name, content);
        fieldRoot.append(row);
      }
    }
    const fieldCount = panel.querySelector(`.${PROCESS_PANEL_CLASS}__field-count`);
    if (fieldCount) fieldCount.textContent = `${filled}/${PROCESS_NOTE_FIELDS.length - 2} 已拉取 · AI 2 项后台`;
    startProcessAIPoll(panel, merged.noteId || "", merged.aiStatus || "");

    const rows = Array.isArray(message.commentRows) ? message.commentRows : null;
    const commentRoot = panel.querySelector(`.${PROCESS_PANEL_CLASS}__comments`);
    if (commentRoot && rows) {
      commentRoot.replaceChildren();
      if (!rows.length) {
        const empty = document.createElement("p");
        empty.className = `${PROCESS_PANEL_CLASS}__empty`;
        empty.textContent = message.commentCount ? `已读取 ${message.commentCount} 条，暂无可展示的 ID` : "暂无评论或等待读取";
        commentRoot.append(empty);
      } else {
        rows.slice(0, 12).forEach((rowData) => {
          const row = document.createElement("div");
          row.className = `${PROCESS_PANEL_CLASS}__comment`;
          const id = document.createElement("code");
          id.textContent = rowData.commentId || "待生成 ID";
          const text = document.createElement("span");
          text.textContent = `${rowData.author || "匿名用户"}：${rowData.content || ""}`;
          row.append(id, text);
          commentRoot.append(row);
        });
        if (Number(message.commentCount) > rows.length) {
          const more = document.createElement("p");
          more.className = `${PROCESS_PANEL_CLASS}__empty`;
          more.textContent = `已读取 ${message.commentCount} 条，面板展示前 ${rows.length} 条 ID`;
          commentRoot.append(more);
        }
      }
    }
    const commentCount = panel.querySelector(`.${PROCESS_PANEL_CLASS}__comment-count`);
    if (commentCount) commentCount.textContent = `${Number(message.commentCount ?? merged.commentCount) || 0} 条`;
    return panel;
  }

  function updateProcessPanel(message = {}) {
    if (!message.noteId && !processPanel) return;
    renderProcessPanel(message);
  }

  function markProcessDetailOpened(note) {
    if (processPanel?.dataset.noteId === note.noteId) {
      processPanel._detailOpened = true;
      positionProcessPanel();
    }
  }

  async function pullFromProcessPanel(panel = processPanel) {
    const note = panel?._processNote || {};
    const noteId = clean(note.noteId, 128);
    if (!noteId || pullingNoteIds.has(noteId)) return;
    pullingNoteIds.add(noteId);
    panel.dataset.mode = "processing";
    panel.classList.remove(`${PROCESS_PANEL_CLASS}--collapsed`);
    updateProcessPanel({
      process: true,
      noteId,
      phase: "open",
      title: `正在拉取“${note.title || "当前帖子"}”`,
      note: { ...note, showProcess: true, process: true }
    });
    try {
      const result = await sendRuntime({
        type: "pullNote",
        note: { ...note, noteId, showProcess: true, process: true }
      });
      if (!result?.ok) throw new Error(result?.error || "拉取失败");
    } catch (error) {
      updateProcessPanel({
        process: true,
        noteId,
        phase: "excel",
        done: true,
        error: error?.message || "拉取失败",
        note
      });
    } finally {
      pullingNoteIds.delete(noteId);
    }
  }

  function uniqueNoteIds(element) {
    const ids = new Set();
    for (const attribute of ["data-note-id", "note-id"]) {
      const value = clean(element.getAttribute?.(attribute), 128);
      if (value) ids.add(value);
    }
    if (element.matches?.("a[href]")) {
      const ownId = noteIdFromUrl(element.href);
      if (ownId) ids.add(ownId);
    }
    for (const link of element.querySelectorAll?.("a[href]") || []) {
      const id = noteIdFromUrl(link.href);
      if (id) ids.add(id);
      if (ids.size > 1) break;
    }
    return ids;
  }

  function candidateCard(anchor) {
    const directCard = anchor.closest?.(NOTE_CARD_SELECTOR);
    if (directCard && directCard.querySelector?.("img, video") && clean(directCard.innerText, 1800).length >= 2) {
      return directCard;
    }
    let node = anchor;
    let best = anchor;
    for (let depth = 0; depth < 9 && node && node !== document.body; depth += 1) {
      const ids = uniqueNoteIds(node);
      if (ids.size > 1) break;
      const text = clean(node.innerText, 1800);
      const hasMedia = Boolean(node.querySelector?.("img, video"));
      if (ids.size === 1 && hasMedia && text.length >= 2) best = node;
      node = node.parentElement;
    }
    return best;
  }

  function firstText(card, selectors) {
    for (const selector of selectors) {
      const element = card.querySelector(selector);
      const value = clean(element?.innerText || element?.getAttribute?.("alt"));
      if (value) return value;
    }
    return "";
  }

  function invalidNoteTitle(value) {
    const normalized = clean(value, 1000).replace(/\s+/g, "").toLocaleLowerCase();
    return !normalized || ["未命名帖子", "当前打开帖子", "待读取", "无标题", "猜你想搜"]
      .includes(normalized) || normalized.startsWith("猜你想搜");
  }

  function titleFromContent(content, limit = 80) {
    const paragraphs = String(content || "")
      .split(/\n+/)
      .map((line) => clean(line, 1000).replace(/\s+/g, " ").replace(/^[\s\-—|｜]+|[\s\-—|｜]+$/g, ""))
      .filter(Boolean);
    const selected = [];
    for (const paragraph of paragraphs.slice(0, 3)) {
      if (paragraph.startsWith("#") && selected.length) break;
      selected.push(paragraph);
      if (selected.join(" ").length >= limit) break;
    }
    const combined = selected.join(" ").trim();
    if (!combined) return "未命名帖子";
    return combined.length > limit
      ? combined.slice(0, limit).replace(/[，。！？；、,!?;:：\s]+$/g, "")
      : combined;
  }

  function canonicalTitle(title, content) {
    return invalidNoteTitle(title) ? titleFromContent(content) : clean(title, 1000);
  }

  function extractTitle(card, anchor) {
    const direct = firstText(card, [
      '[class*="title"]', '[class*="Title"]', "h1", "h2", "h3", "img[alt]"
    ]);
    if (direct && !invalidNoteTitle(direct)) return direct;
    const lines = String(anchor.innerText || card.innerText || "")
      .split(/\n+/)
      .map((line) => clean(line, 300))
      .filter(Boolean);
    return lines.find((line) => !invalidNoteTitle(line)) || "未命名帖子";
  }

  function extractAuthor(card, title) {
    const value = firstText(card, [
      '[class*="author"]', '[class*="Author"]', '[class*="nickname"]',
      '[class*="user-name"]', '[class*="username"]'
    ]);
    return value && value !== title ? value : "";
  }

  function extractCaption(card, title, author) {
    const selectors = [
      '[class*="desc"]', '[class*="description"]', '[class*="caption"]',
      '[class*="content"]', '[class*="note-text"]', '[data-note-content]'
    ];
    for (const selector of selectors) {
      for (const element of card.querySelectorAll(selector)) {
        const value = clean(element.innerText || element.getAttribute?.("data-note-content"), 12000);
        if (!value || value === title || value === author) continue;
        if (value.length >= 4) return value;
      }
    }
    return "";
  }

  function extractTags(card, content) {
    const values = [];
    const selectors = [
      '[class*="tag"]', '[class*="Tag"]', '[class*="topic"]', '[class*="Topic"]',
      'a[href*="hashtag"]', '[data-tag]', '[data-topic]'
    ];
    for (const selector of selectors) {
      for (const element of card.querySelectorAll(selector)) {
        const value = clean(
          element.innerText || element.getAttribute("data-tag") || element.getAttribute("data-topic") ||
          element.getAttribute("aria-label") || element.getAttribute("title"),
          300
        );
        if (value) values.push(value);
      }
    }
    const hashtags = noteUtils.extractHashtags(content);
    values.push(...hashtags.map((value) => clean(value, 300)));
    return [...new Set(values)];
  }

  function extractMediaText(card) {
    const values = [];
    const elements = [card, ...Array.from(card.querySelectorAll("img, a"))];
    const attributes = [
      "alt", "aria-label", "title", "data-title", "data-note-title", "data-content", "data-note-content"
    ];
    for (const element of elements) {
      for (const attribute of attributes) {
        const value = clean(element.getAttribute?.(attribute), 500);
        if (value) values.push(value);
      }
    }
    return [...new Set(values)].join(" ").slice(0, 6000);
  }

  function isAvatarOrUiImage(image) {
    if (!image) return true;
    const url = String(image.currentSrc || image.getAttribute?.("src") || "");
    if (/sns-avatar|\/avatar\/|avatar-item|head(?:img|image)/i.test(url)) return true;
    if (image.closest?.('.avatar, [class*="avatar"], [class*="comment"], [class*="author"], [class*="profile"], a[href*="/user/profile/"]')) return true;
    const rect = image.getBoundingClientRect?.() || { width: 0, height: 0 };
    const width = Math.max(Number(image.naturalWidth) || 0, Number(rect.width) || 0);
    const height = Math.max(Number(image.naturalHeight) || 0, Number(rect.height) || 0);
    return width > 0 && height > 0 && width < 180 && height < 180;
  }

  function detailMediaRoot(detailRoot) {
    if (!detailRoot) return null;
    const shell = detailRoot.matches?.("#noteContainer") ? detailRoot : detailRoot.closest?.("#noteContainer") || detailRoot;
    const selectors = [
      ":scope > .media-container", ".media-container", ".xhs-slider-container", ".note-slider",
      "[class*='video-container']", "[class*='video-player']", "[class*='player-container']"
    ];
    for (const selector of selectors) {
      const candidate = shell.querySelector?.(selector);
      if (candidate && !candidate.closest?.('.interaction-container, [class*="comment"]')) return candidate;
    }
    const video = shell.querySelector?.("video");
    if (video) {
      let candidate = video.parentElement;
      while (candidate?.parentElement && candidate.parentElement !== shell) {
        const rect = candidate.getBoundingClientRect?.();
        if (rect?.width >= 320 && rect?.height >= 180) return candidate;
        candidate = candidate.parentElement;
      }
      return video.parentElement || shell;
    }
    return shell;
  }

  function extractImageUrls(root, limit = 32, strict = false) {
    const values = [];
    const add = (value) => {
      const raw = clean(value, 4000);
      if (!raw) return;
      try {
        const url = new URL(raw, location.href);
        if (!/^https?:$/i.test(url.protocol)) return;
        values.push(url.href);
      } catch (_error) {}
    };
    const addSrcSet = (value) => {
      for (const item of String(value || "").split(",")) {
        const candidate = item.trim().split(/\s+/)[0];
        if (candidate) add(candidate);
      }
    };
    for (const image of root?.querySelectorAll?.("img") || []) {
      if (strict && isAvatarOrUiImage(image)) continue;
      add(image.currentSrc);
      add(image.getAttribute("src"));
      add(image.getAttribute("data-src"));
      add(image.getAttribute("data-original"));
      addSrcSet(image.getAttribute("srcset"));
      addSrcSet(image.getAttribute("data-srcset"));
      if (values.length >= limit * 2) break;
    }
    for (const link of root?.querySelectorAll?.("a[href]") || []) {
      const href = link.getAttribute("href") || "";
      if (/\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(href)) add(href);
      if (values.length >= limit * 2) break;
    }
    return [...new Set(values)].slice(0, limit);
  }

  function extractVideoUrls(root, limit = 8) {
    const values = [];
    const add = (value) => {
      const raw = clean(value, 8000);
      if (!raw || /^blob:/i.test(raw)) return;
      try {
        const url = new URL(raw, location.href);
        if (!/^https?:$/i.test(url.protocol)) return;
        if (/\.(?:jpe?g|png|webp|gif|bmp|avif)(?:[?#]|$)/i.test(url.href)) return;
        values.push(url.href);
      } catch (_error) {}
    };
    const attributes = [
      "src", "data-src", "data-url", "data-video-url", "data-video-src",
      "data-play-url", "data-master-url", "data-origin-url"
    ];
    for (const video of root?.querySelectorAll?.("video") || []) {
      add(video.currentSrc);
      for (const attribute of attributes) add(video.getAttribute(attribute));
      for (const source of video.querySelectorAll("source")) {
        add(source.src);
        for (const attribute of attributes) add(source.getAttribute(attribute));
      }
    }
    for (const element of root?.querySelectorAll?.(
      "[data-video-url],[data-video-src],[data-play-url],[data-master-url],[data-origin-url]"
    ) || []) {
      for (const attribute of attributes) add(element.getAttribute(attribute));
    }
    // Some XHS players expose only a blob: URL on <video>. The signed CDN URL
    // remains visible in the Resource Timing buffer after the detail opens.
    if (!values.length && root?.querySelector?.("video")) {
      for (const entry of performance.getEntriesByType?.("resource") || []) {
        const url = String(entry?.name || "");
        if (/\.(?:mp4|m4v|mov|webm)(?:[?#]|$)|sns-video|video\/tos|video-cdn|stream/i.test(url)) add(url);
      }
      // Newer XHS players sometimes keep a blob: currentSrc while the signed
      // CDN URL remains serialized in the page state script.
      for (const script of document.scripts || []) {
        const source = String(script.textContent || "");
        if (!source || source.length > 12_000_000) continue;
        const normalized = source.replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
        for (const match of normalized.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) {
          const candidate = match[0].replace(/&amp;/g, "&");
          if (/\.mp4(?:[?#]|$)|sns-video|video\/tos|video-cdn|stream/i.test(candidate)) add(candidate);
          if (values.length >= limit) break;
        }
        if (values.length >= limit) break;
      }
    }
    return [...new Set(values)].slice(-limit);
  }

  function visibleLargeElement(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width >= 320 && rect.height >= 180;
  }

  function detailCandidates() {
    const candidates = new Set([
      ...document.querySelectorAll(
        '[role="dialog"], [class*="modal"], [class*="Modal"], [class*="detail"], [class*="Detail"], [class*="note-detail"], [class*="NoteDetail"]'
      )
    ]);
    for (const textElement of document.querySelectorAll('[class*="note-text"], [data-note-content]')) {
      let parent = textElement;
      for (let depth = 0; depth < 5 && parent; depth += 1) {
        candidates.add(parent);
        parent = parent.parentElement;
      }
    }
    return [...candidates].filter(visibleLargeElement);
  }

  function detailRootForNote(baseNote = {}) {
    const noteId = clean(baseNote.noteId, 128);
    const title = clean(baseNote.title, 1000);
    const activeDetailId = noteIdFromUrl(location.href);
    const allCandidates = detailCandidates();
    const shellCandidates = allCandidates.filter((candidate) => candidate.matches?.(
      '#noteContainer, [role="dialog"], .note-detail-mask, [class*="note-detail"], [class*="NoteDetail"], [class*="modal"], [class*="Modal"]'
    ));
    const candidates = shellCandidates.length
      ? shellCandidates
      : allCandidates.filter((candidate) => clean(candidate.getAttribute?.("note-id"), 128));
    const ranked = candidates.map((candidate) => {
      const rootId = clean(candidate.getAttribute?.("note-id"), 128);
      const textValue = clean(candidate.innerText, 16000);
      const hasNoteLink = noteId && Array.from(candidate.querySelectorAll("a[href]"))
        .some((link) => noteIdFromUrl(link.href) === noteId);
      const idMatch = Boolean(noteId && (rootId === noteId || activeDetailId === noteId));
      const titleMatch = Boolean(title && textValue.includes(title.slice(0, 24)));
      return {
        candidate,
        score: (idMatch ? 100 : 0) + (hasNoteLink ? 40 : 0) + (titleMatch ? 20 : 0) + Math.min(textValue.length, 8000) / 8000
      };
    }).sort((left, right) => right.score - left.score);
    return ranked[0]?.candidate || null;
  }

  function extractDetailContext(candidates, noteId, title) {
    const activeDetailId = noteIdFromUrl(location.href);
    for (const candidate of candidates) {
      const visibleText = clean(candidate.innerText, 16000);
      if (!visibleText || visibleText.length < 40) continue;
      const candidateId = clean(candidate.getAttribute?.("note-id"), 128) || activeDetailId;
      const hasNoteLink = Array.from(candidate.querySelectorAll("a[href]"))
        .some((link) => noteIdFromUrl(link.href) === noteId);
      if (!noteUtils.detailBelongsToNote({
        candidateId, activeDetailId, noteId, hasNoteLink, title, visibleText
      })) continue;
      const content = extractCaption(candidate, title, "");
      const tags = extractTags(candidate, content || visibleText);
      if (content || tags.length) return { content, tags };
    }
    return { content: "", tags: [] };
  }

  function extractNotes(options = {}) {
    const lightweight = Boolean(options.lightweight);
    const anchors = [
      ...Array.from(document.querySelectorAll(NOTE_LINK_SELECTOR)),
      ...Array.from(document.querySelectorAll("[data-note-id], [note-id], [data-noteid]")).filter((element) => !element.matches("a[href]")),
      ...Array.from(document.querySelectorAll(NOTE_CARD_SELECTOR)).filter((element) => !element.matches("a[href]"))
    ];
    const bestAnchorById = new Map();
    const anchorScore = (anchor) => {
      const href = anchor.href || "";
      let score = anchor.offsetParent === null ? 0 : 2;
      if (href.includes("/search_result/")) score += 4;
      if (href.includes("xsec_token=")) score += 3;
      if (href.includes("/discovery/item/")) score += 2;
      return score;
    };
    for (const anchor of anchors) {
      const descendantLink = anchor.matches?.("a[href]")
        ? anchor
        : Array.from(anchor.querySelectorAll?.("a[href]") || []).find((link) => noteIdFromUrl(link.href));
      const noteId = noteIdFromUrl(anchor.href || descendantLink?.href)
        || clean(anchor.getAttribute?.("data-note-id") || anchor.getAttribute?.("note-id") || anchor.getAttribute?.("data-noteid"), 128);
      if (!noteId) continue;
      const candidate = descendantLink || anchor;
      const existing = bestAnchorById.get(noteId);
      if (!existing || anchorScore(candidate) > anchorScore(existing)) bestAnchorById.set(noteId, candidate);
    }
    const byId = new Map();
    const details = lightweight ? [] : detailCandidates();
    for (const [noteId, anchor] of bestAnchorById) {
      const url = anchor.href
        ? new URL(anchor.href, location.href).href
        : new URL(`/explore/${noteId}`, location.origin).href;
      const card = candidateCard(anchor);
      if (card.getAttribute(CARD_MARK) && card.getAttribute(CARD_MARK) !== noteId) {
        clearDecorations(card);
      }
      card.setAttribute(CARD_MARK, noteId);
      const title = extractTitle(card, anchor);
      const author = extractAuthor(card, title);
      const cardContent = lightweight ? "" : extractCaption(card, title, author);
      const cardTags = lightweight ? [] : extractTags(card, cardContent);
      const detail = lightweight ? { content: "", tags: [] } : extractDetailContext(details, noteId, title);
      const content = detail.content || cardContent;
      const finalTitle = canonicalTitle(title, content);
      const tags = [...new Set([...cardTags, ...detail.tags])];
      const note = {
        noteId,
        url,
        title: finalTitle,
        author,
        content,
        detailRead: Boolean(detail.content),
        tags,
        mediaText: lightweight ? "" : extractMediaText(card),
        imageUrls: lightweight ? [] : extractImageUrls(card, 12),
        keyword: currentKeyword(),
        pageUrl: location.href
      };
      if (detail.content) detailStore.remember([note]);
      byId.set(noteId, detailStore.merge(note));
    }
    return Array.from(byId.values());
  }

  function bestLiveNoteUrl(noteId) {
    const links = Array.from(document.querySelectorAll(NOTE_LINK_SELECTOR))
      .filter((anchor) => noteIdFromUrl(anchor.href) === noteId);
    return links.reduce(
      (best, anchor) => noteUtils.preferredUrl(best, new URL(anchor.href, location.href).href),
      ""
    );
  }

  function fallbackMarker() {
    try {
      const params = new URLSearchParams(location.hash.replace(/^#/, ""));
      const noteId = clean(params.get("xhs_monitor_note_id"), 128);
      if (!noteId) return null;
      return { noteId, title: clean(params.get("xhs_monitor_title"), 1000) };
    } catch (_error) {
      return null;
    }
  }

  function fallbackSearchUrl(marker) {
    const keyword = marker.title || marker.noteId || "XHS-Monitor";
    const url = new URL("https://www.xiaohongshu.com/search_result");
    url.searchParams.set("keyword", keyword);
    url.searchParams.set("source", "web_search_result_notes");
    url.hash = new URLSearchParams({
      xhs_monitor_note_id: marker.noteId,
      xhs_monitor_title: keyword
    }).toString();
    return url.href;
  }

  function recoverFallbackNavigation() {
    const marker = fallbackMarker();
    if (!marker) return false;
    const bodyText = clean(document.body?.innerText, 3000);
    if (/当前笔记暂时无法浏览|笔记暂时无法浏览|暂时无法浏览/.test(bodyText)) {
      location.replace(fallbackSearchUrl(marker));
      return true;
    }
    if (!isSearchPage()) return false;
    const liveUrl = bestLiveNoteUrl(marker.noteId);
    const target = new URL(liveUrl, location.href);
    const hasToken = Boolean(target.searchParams.get("xsec_token"))
      || target.hostname === "xhslink.com"
      || target.hostname.endsWith(".xhslink.com");
    if (!liveUrl || !hasToken) return false;
    target.hash = "";
    location.replace(target.href);
    return true;
  }

  let fallbackNavigationTimer = null;
  function startFallbackNavigation() {
    if (!fallbackMarker() || fallbackNavigationTimer) return;
    let attempts = 0;
    fallbackNavigationTimer = setInterval(() => {
      attempts += 1;
      if (recoverFallbackNavigation() || attempts >= 24) {
        clearInterval(fallbackNavigationTimer);
        fallbackNavigationTimer = null;
      }
    }, 500);
    recoverFallbackNavigation();
  }

  function extractCurrentDetail(baseNote = {}) {
    const detailRoot = detailRootForNote(baseNote);
    const description = detailDescription(detailRoot || document);
    const content = description.value;
    if (!detailRoot || content.length < 4) {
      return { ok: false, loading: true, error: "正文尚未加载" };
    }
    const locationId = noteIdFromUrl(location.href);
    const rootId = clean(detailRoot.getAttribute?.("note-id"), 128);
    const noteId = locationId || rootId || clean(baseNote.noteId, 128);
    if (!noteId) return { ok: false, loading: false, error: "详情页缺少帖子 ID" };
    if (baseNote.noteId && noteId !== baseNote.noteId) {
      return { ok: false, loading: false, error: "详情页帖子 ID 不匹配" };
    }
    const detailTitleElement = detailRoot.querySelector?.(
      "#detail-title, h1, [class*='title'], [class*='Title']"
    ) || document.querySelector(
      "#detail-title, .note-detail-mask h1, #noteContainer h1, [class*='note-detail'] h1, [class*='note-detail'] [class*='title']"
    );
    const title = canonicalTitle(
      clean(detailTitleElement?.innerText, 1000) || baseNote.title,
      content
    );
    const detailAuthorElement = detailRoot.querySelector?.(
      '.author-container .username, .author-wrapper .username, [class*="author"] [class*="name"], [class*="nickname"]'
    );
    const author = clean(
      detailAuthorElement?.innerText,
      500
    ) || baseNote.author || "";
    const authorLink = detailRoot.querySelector?.("a[href*='/user/profile/']") || document.querySelector("a[href*='/user/profile/']");
    const metadata = processDetailMetadata(detailRoot);
    const tags = description.element ? extractTags(description.element, content) : [];
    const mediaRoot = detailMediaRoot(detailRoot);
    const imageUrls = extractImageUrls(mediaRoot, 32, true);
    const videoUrls = extractVideoUrls(mediaRoot, 8);
    const authorUrl = noteUtils.normalizeXhsUrl(authorLink?.href || baseNote.authorUrl || "");
    return {
      ok: true,
      note: {
        ...baseNote,
        noteId,
        url: noteUtils.preferredUrl(baseNote.url, location.href),
        title,
        author,
        authorUrl,
        authorId: baseNote.authorId || processAuthorId(authorUrl),
        publishedAt: baseNote.publishedAt || metadata.publishedAt,
        updatedAt: baseNote.updatedAt || metadata.updatedAt,
        content,
        detailRead: true,
        tags: [...new Set([...(baseNote.tags || []), ...tags])],
        mediaText: extractMediaText(detailRoot),
        imageUrls: imageUrls.length ? imageUrls : (baseNote.imageUrls || []),
        imageCount: imageUrls.length || baseNote.imageCount || (baseNote.imageUrls || []).length,
        videoUrls: videoUrls.length ? videoUrls : (baseNote.videoUrls || []),
        videoCount: videoUrls.length || baseNote.videoCount || (baseNote.videoUrls || []).length,
        mediaType: videoUrls.length || (baseNote.videoUrls || []).length ? "video" : "image",
        likeCount: baseNote.likeCount || processMetric(detailRoot, ["like", "点赞", "赞"]),
        collectCount: baseNote.collectCount || processMetric(detailRoot, ["collect", "收藏", "star"]),
        commentCount: baseNote.commentCount || processMetric(detailRoot, ["comment", "评论"]),
        shareCount: baseNote.shareCount || processMetric(detailRoot, ["share", "分享"]),
        ipLocation: baseNote.ipLocation || metadata.ipLocation,
        keyword: baseNote.keyword || currentKeyword(),
        pageUrl: baseNote.pageUrl || location.href
      }
    };
  }

  function detailNoteId(root) {
    const direct = [
      root?.getAttribute?.("note-id"),
      root?.getAttribute?.("data-note-id"),
      root?.getAttribute?.("data-noteid"),
      root?.getAttribute?.("data-id"),
      root?.dataset?.noteId,
      root?.dataset?.noteid
    ].map((value) => clean(value, 128)).find(Boolean);
    if (direct) return direct;
    return Array.from(root?.querySelectorAll?.(NOTE_LINK_SELECTOR) || [])
      .map((link) => noteIdFromUrl(link.href))
      .find(Boolean) || "";
  }

  function detailTitle(root, fallback = "") {
    const selectors = [
      "#detail-title", "h1", "h2", "[class*='title']", "[class*='Title']"
    ];
    for (const selector of selectors) {
      const value = clean(root?.querySelector?.(selector)?.innerText, 1000);
      if (value) return value;
    }
    return clean(fallback, 1000) || "当前打开帖子";
  }

  function preferredLiveNoteUrl(noteId, fallback = "") {
    const liveUrl = noteId ? bestLiveNoteUrl(noteId) : "";
    return noteUtils.preferredUrl(liveUrl, fallback) || liveUrl || fallback || "";
  }

  function currentDetailInfo() {
    const hint = currentDetailHint || {};
    const detailRoot = detailRootForNote(hint);
    if (!detailRoot) return { note: null, loading: false };

    const extracted = extractCurrentDetail(hint);
    if (extracted.ok && extracted.note?.noteId) {
      const note = {
        ...extracted.note,
        url: preferredLiveNoteUrl(extracted.note.noteId, extracted.note.url),
        pageUrl: location.href
      };
      currentDetailHint = { ...currentDetailHint, ...note };
      return { note, loading: false };
    }

    const noteId = noteIdFromUrl(location.href) || detailNoteId(detailRoot) || clean(hint.noteId, 128);
    if (!noteId) return { note: null, loading: true };
    const title = detailTitle(detailRoot, hint.title);
    const note = {
      ...hint,
      noteId,
      url: preferredLiveNoteUrl(noteId, hint.url || location.href),
      title,
      detailRead: false,
      loading: true,
      pageUrl: location.href
    };
    currentDetailHint = { ...currentDetailHint, ...note };
    return { note, loading: true };
  }

  function publishCurrentDetail(info = { note: null, loading: false }) {
    const note = info.note || null;
    const signature = [
      note?.noteId || "",
      note?.title || "",
      info.loading ? "1" : "0",
      note?.imageCount || note?.imageUrls?.length || 0,
      note?.videoCount || note?.videoUrls?.length || 0
    ].join("|");
    if (signature === lastDetailSignal) return;
    lastDetailSignal = signature;
    sendRuntime({
      type: "currentDetailChanged",
      currentDetail: note,
      currentDetailLoading: Boolean(info.loading)
    }).catch(() => {});
  }

  async function refreshProcessPanelStatus(panel, note) {
    if (!panel || !note?.noteId) return;
    if (Date.now() - Number(panel._statusFetchedAt || 0) < 1500) return;
    panel._statusFetchedAt = Date.now();
    try {
      const result = await sendRuntime({ type: "getNoteStatus", noteId: note.noteId });
      if (!result?.ok || panel !== processPanel || panel.dataset.noteId !== note.noteId) return;
      panel._processNote = { ...panel._processNote, ...result, inExcel: Boolean(result.inExcel) };
      const pull = panel.querySelector(`.${PROCESS_PANEL_CLASS}__state--pull`);
      const relevance = panel.querySelector(`.${PROCESS_PANEL_CLASS}__state--relevance`);
      const headPull = panel.querySelector(`.${PROCESS_PANEL_CLASS}__head-state--pull`);
      const headRelevance = panel.querySelector(`.${PROCESS_PANEL_CLASS}__head-state--relevance`);
      const pulled = result.inExcel || ["synced", "partial"].includes(result.pullStatus);
      const pullLabel = pulled ? (result.pullStatus === "partial" ? "部分拉取" : "已拉取") : "未拉取";
      if (pull) { pull.textContent = `拉取状态：${pullLabel}`; pull.dataset.state = pulled ? "pulled" : "missing"; }
      if (headPull) { headPull.textContent = pullLabel; headPull.dataset.state = pulled ? "pulled" : "missing"; }
      const rel = result.relevanceStatus || "unknown";
      const relevanceLabel = rel === "relevant" ? "相关" : rel === "irrelevant" ? "不相关" : "相关性未知";
      if (relevance) { relevance.textContent = `相关性：${relevanceLabel.replace("相关性", "")}`; relevance.dataset.state = rel; }
      if (headRelevance) { headRelevance.textContent = relevanceLabel; headRelevance.dataset.state = rel; }
    } catch (_error) {}
  }

  function syncDetailControl() {
    const info = currentDetailInfo();
    const note = info.note;
    if (!note?.noteId) {
      document.documentElement.classList.remove("xhs-monitor-detail-open");
      publishCurrentDetail({ note: null, loading: false });
      if (!detailRootForNote({})) {
        dismissedDetailId = "";
        if (processPanel?._autoDock) removeProcessPanel();
      }
      return;
    }

    document.documentElement.classList.add("xhs-monitor-detail-open");
    publishCurrentDetail(info);
    if (dismissedDetailId === note.noteId) return;
    if (dismissedDetailId && dismissedDetailId !== note.noteId) dismissedDetailId = "";

    if (processPanel && processPanel.dataset.noteId !== note.noteId) removeProcessPanel();
    let panel = processPanel;
    if (!panel) {
      panel = mountProcessPanel(note);
      panel._autoDock = true;
      panel._detailOpened = true;
      panel.dataset.mode = "idle";
      panel.classList.add(`${PROCESS_PANEL_CLASS}--collapsed`);
      const heading = panel.querySelector(`.${PROCESS_PANEL_CLASS}__title`);
      const status = panel.querySelector(`.${PROCESS_PANEL_CLASS}__status`);
      const pullButton = panel.querySelector(`.${PROCESS_PANEL_CLASS}__pull`);
      if (heading) heading.textContent = "当前帖子";
      if (status) status.textContent = info.loading ? "正文加载中，可直接开始拉取" : "点击拉取正文、图片与评论";
      if (pullButton) {
        pullButton.disabled = false;
        pullButton.textContent = "拉取";
      }
    } else {
      panel._processNote = { ...panel._processNote, ...note };
      panel._detailOpened = true;
      if (panel.dataset.mode === "idle") {
        const status = panel.querySelector(`.${PROCESS_PANEL_CLASS}__status`);
        if (status) status.textContent = info.loading ? "正文加载中，可直接开始拉取" : "点击拉取正文、图片与评论";
      }
    }
    positionProcessPanel();
    refreshProcessPanelStatus(panel, note);
  }

  function scheduleDetailControl(delay = 70) {
    clearTimeout(detailControlTimer);
    detailControlTimer = setTimeout(() => {
      detailControlTimer = null;
      syncDetailControl();
    }, delay);
  }

  function waitFor(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function findNoteAnchor(noteId) {
    const markedCard = document.querySelector(`[${CARD_MARK}="${CSS.escape(noteId)}"]`);
    if (markedCard?.matches?.("a[href]")) return markedCard;
    const markedAnchor = markedCard?.querySelector?.("a[href]");
    if (markedAnchor && noteIdFromUrl(markedAnchor.href) === noteId) return markedAnchor;
    if (markedCard?.getAttribute?.("data-note-id") === noteId || markedCard?.getAttribute?.("note-id") === noteId) {
      return markedCard;
    }
    const links = Array.from(document.querySelectorAll(NOTE_LINK_SELECTOR))
      .filter((anchor) => noteIdFromUrl(anchor.href) === noteId);
    return links.sort((left, right) => {
      const score = (anchor) => (anchor.offsetParent === null ? 0 : 10)
        + (anchor.href.includes("xsec_token=") ? 5 : 0)
        + (anchor.href.includes("/search_result/") ? 3 : 0);
      return score(right) - score(left);
    })[0] || null;
  }

  function currentDetailMatches(note) {
    const root = detailRootForNote(note);
    if (!root) return false;
    const currentId = noteIdFromUrl(location.href) || clean(root.getAttribute?.("note-id"), 128);
    if (currentId && currentId === note.noteId) return true;
    const title = clean(note.title, 1000);
    return Boolean(title && clean(root.innerText, 16000).includes(title.slice(0, 24)));
  }

  async function closeDetailInPage() {
    const root = detailRootForNote({});
    if (!root) return;
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", code: "Escape", bubbles: true, cancelable: true
    }));
    await waitFor(240);
    if (!detailRootForNote({})) return;
    const closeButton = Array.from(root.querySelectorAll(
      "button[aria-label*='关闭'], button[aria-label*='close'], [class*='close'], [class*='Close']"
    )).find((element) => visibleLargeElement(element.parentElement || element) || element.offsetParent !== null);
    closeButton?.click?.();
    await waitFor(320);
  }

  async function openDetailInPage(note) {
    if (currentDetailMatches(note)) {
      markProcessDetailOpened(note);
      return { opened: false };
    }
    if (detailRootForNote({})) await closeDetailInPage();
    const anchor = findNoteAnchor(note.noteId);
    if (!anchor) throw new Error("当前页面找不到这篇帖子的卡片，请先让它显示在页面上");
    try { anchor.scrollIntoView({ block: "center", inline: "center" }); } catch (_error) {}
    // The result card is often an <a>. Let XHS's own click handler open the
    // detail layer, but block the anchor's default navigation. Without this
    // guard a background deep scan can replace the search grid with the
    // platform's “当前笔记暂时无法浏览” QR page.
    const keepSearchSurface = (event) => event.preventDefault();
    anchor.addEventListener?.("click", keepSearchSurface, true);
    try {
      anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      anchor.click?.();
    } finally {
      anchor.removeEventListener?.("click", keepSearchSurface, true);
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < 12000) {
      if (currentDetailMatches(note)) {
        markProcessDetailOpened(note);
        return { opened: true };
      }
      await waitFor(240);
    }
    throw new Error("帖子详情层未在当前页面加载完成");
  }

  async function readNoteInPage(note = {}) {
    if (!note?.noteId) return { ok: false, error: "缺少帖子 ID" };
    const originalScrollY = window.scrollY;
    const showProcess = Boolean(note.showProcess || note.process);
    let opened = false;
    if (showProcess) {
      mountProcessPanel(note);
      updateProcessPanel({
        process: true, noteId: note.noteId, phase: "open",
        title: `正在点击“${note.title || "该帖子"}”并打开详情`, note
      });
    }
    try {
      const openedState = await openDetailInPage(note);
      opened = Boolean(openedState.opened);
      if (showProcess) {
        updateProcessPanel({
          process: true, noteId: note.noteId, phase: "body",
          title: "详情已打开，正在读取正文与 Excel 字段", note
        });
      }
      let detail = null;
      const startedAt = Date.now();
      while (Date.now() - startedAt < 12000) {
        detail = extractCurrentDetail(note);
        if (detail.ok && detail.note?.content) break;
        await waitFor(280);
      }
      if (!detail?.ok || !detail.note?.content) {
        const errorMessage = detail?.error || "正文尚未加载完成";
        if (showProcess) updateProcessPanel({
          process: true, noteId: note.noteId, phase: "body", error: errorMessage,
          title: errorMessage, note
        });
        return { ok: false, error: errorMessage };
      }

      if (showProcess) {
        updateProcessPanel({
          process: true, noteId: note.noteId, phase: "comments",
          title: `正文已读取 ${detail.note.content.length} 字，正在展开评论`, note: detail.note,
          fields: processNoteFields(detail.note)
        });
      }

      let totalClicked = 0;
      let commentRoot = detailRootForNote(detail.note) || document;
      for (let round = 0; round < 4; round += 1) {
        const buttons = commentUtils.expandableButtons(commentRoot).slice(0, 16);
        if (!buttons.length) break;
        buttons.forEach((button) => button.click());
        totalClicked += buttons.length;
        if (showProcess) updateProcessPanel({
          process: true, noteId: note.noteId, phase: "comments",
          title: `已展开 ${totalClicked} 组回复，继续读取评论`, note: detail.note,
          commentCount: totalClicked
        });
        await waitFor(650);
        commentRoot = detailRootForNote(detail.note) || commentRoot;
      }
      const refreshed = extractCurrentDetail(detail.note);
      if (refreshed?.ok) detail = refreshed;
      commentRoot = detailRootForNote(detail.note) || document;
      const extracted = commentUtils.extractComments(commentRoot, detail.note);
      const expectedCount = Number(extracted.expectedCount || 0);
      const commentStatus = expectedCount === 0 && extracted.comments.length === 0
        ? "likely_complete"
        : (extracted.status || "partial");
      const commentsWithIds = await ensureCommentIds(detail.note, extracted.comments || []);
      if (showProcess) updateProcessPanel({
        process: true, noteId: note.noteId, phase: "media",
        title: `评论及 ID 已读取 ${commentsWithIds.length} 条，准备保存图片 / 视频素材`, note: detail.note,
        commentCount: commentsWithIds.length,
        commentRows: commentsWithIds.slice(0, 12)
      });
      return {
        ok: true,
        note: detail.note,
        comments: commentsWithIds,
        expectedCount,
        status: commentStatus,
        commentError: commentStatus === "partial" ? "当前页面只读取到已加载评论，可稍后重试" : "",
        expandedCount: totalClicked
      };
    } catch (error) {
      if (showProcess) updateProcessPanel({
        process: true, noteId: note.noteId, phase: "body", error: error?.message || "当前页面读取失败",
        title: "当前页面读取失败", note
      });
      return { ok: false, error: error?.message || "当前页面读取失败" };
    } finally {
      // A user-triggered pull leaves the enlarged note visible so the Process
      // window and the exact source text/comments can be checked side by side.
      // Background deep reads keep the previous open/read/close behavior.
      if (opened && !showProcess) await closeDetailInPage();
      try { window.scrollTo({ top: originalScrollY, behavior: "auto" }); } catch (_error) { window.scrollTo(0, originalScrollY); }
    }
  }

  function autoDetailEligible(note) {
    return detailStore.needsDetail(note) && (detailRetryAt.get(note.noteId) || 0) <= Date.now();
  }

  async function performDeepScan(reason = "manual") {
    if (!isSearchPage()) return { ok: false, error: "深度补全仅支持小红书搜索结果页" };
    if (activeScan) await activeScan.catch(() => {});
    bridgeReady = true;
    deepScanActive = true;
    const failedIds = new Set();
    const statusById = new Map();
    const insertedById = new Map();
    const relevantById = new Map();
    const detailsById = new Map();
    let completed = 0;
    let failedCount = 0;
    let cancelled = false;
    let batches = 0;
    const initialPending = extractNotes().filter((note) => detailStore.needsDetail(note)).length;
    try {
      while (batches < 10) {
        const notes = extractNotes();
        const pending = notes.filter((note) => {
          if (!detailStore.needsDetail(note) || failedIds.has(note.noteId)) return false;
          return reason === "manual" || autoDetailEligible(note);
        });
        if (!pending.length) break;
        batches += 1;
        const result = await sendRuntime({
          type: "deepScanNotes",
          payload: {
            keyword: currentKeyword(),
            pageUrl: location.href,
            scannedAt: new Date().toISOString(),
            reason: reason === "auto" ? "auto-deep" : "manual-deep",
            batch: batches,
            notes: pending
          }
        });
        detailStore.remember(result.details || []);
        for (const note of result.details || []) detailRetryAt.delete(note.noteId);
        for (const note of result.details || []) detailsById.set(note.noteId, note);
        if (!result?.ok) return { ...result, unresolvedCount: initialPending };
        for (const note of result.notes || []) relevantById.set(note.noteId, note);
        for (const status of result.statuses || []) statusById.set(status.noteId, status);
        for (const note of result.inserted || []) insertedById.set(note.noteId, note);
        for (const noteId of result.failedNoteIds || []) {
          failedIds.add(noteId);
          detailRetryAt.set(noteId, Date.now() + AUTO_DETAIL_RETRY_DELAY_MS);
        }
        completed += result.deepScannedCount || 0;
        failedCount += result.failedCount || 0;
        cancelled = Boolean(result.cancelled);
        decorate(result.notes || [], result.statuses || []);
        if (cancelled || !result.limited) break;
      }
      const remainingCount = extractNotes().filter((note) => detailStore.needsDetail(note)).length;
      const result = {
        ok: true,
        notes: [...relevantById.values()],
        details: [...detailsById.values()],
        statuses: [...statusById.values()],
        inserted: [...insertedById.values()],
        deepScannedCount: completed,
        relevantCount: relevantById.size,
        failedCount,
        failedNoteIds: [...failedIds],
        cancelled,
        batches,
        unresolvedCount: initialPending,
        remainingCount,
        limited: remainingCount > failedIds.size,
        warning: remainingCount
          ? `${remainingCount} 篇正文尚未读取成功，可点击“仅深读未判断帖子”重试`
          : (initialPending ? "" : "当前已加载帖子的详情正文均已读取")
      };
      return result;
    } finally {
      deepScanActive = false;
      scheduleScan(250);
    }
  }

  function requestDeepScan(reason = "manual") {
    if (activeDeepScanPromise) {
      deepScanQueued = true;
      return activeDeepScanPromise;
    }
    const current = performDeepScan(reason);
    activeDeepScanPromise = current;
    current.finally(() => {
      if (activeDeepScanPromise === current) activeDeepScanPromise = null;
      if (deepScanQueued) {
        deepScanQueued = false;
        scheduleScan(200);
      }
    }).catch(() => {});
    return current;
  }

  function clearDecorations(card) {
    card.classList.remove(
      "xhs-monitor-card--new", "xhs-monitor-card--known",
      "xhs-monitor-card--confirmed", "xhs-monitor-card--ignored",
      "xhs-monitor-card--unrelated", "xhs-monitor-card--unloaded",
      "xhs-monitor-card--partial",
      "xhs-monitor-card--pulling",
      "xhs-monitor-card--relevance-relevant", "xhs-monitor-card--relevance-irrelevant",
      "xhs-monitor-card--relevance-unknown",
      "xhs-monitor-position-anchor"
    );
    card.querySelectorAll(`:scope > .${TOOLBAR_CLASS}`).forEach((element) => element.remove());
  }

  const STATE_META = {
    unloaded: { label: "未拉取", hint: "本地 Excel 标题中没有匹配记录；点击“拉取”保存完整帖子" },
    unrelated: { label: "未拉取", hint: "当前卡片尚未写入本地 Excel；点击“拉取”后再判断并保存" },
    new: { label: "未拉取", hint: "本地 Excel 中没有匹配记录，点击“拉取”保存完整帖子" },
    known: { label: "Excel 已有", hint: "已存在于本地 Excel 帖子总表" },
    confirmed: { label: "已加入拉取", hint: "已加入本地拉取队列，当前仍未写入 Excel" },
    partial: { label: "部分拉取", hint: "正文已保存，但图片或评论仍可重试" },
    pulling: { label: "拉取中…", hint: "正在当前小红书页面读取正文、图片和评论" },
    ignored: { label: "已忽略", hint: "已从新相关帖子列表移除" }
  };

  function ensurePositionAnchor(card) {
    if (getComputedStyle(card).position === "static") {
      card.classList.add("xhs-monitor-position-anchor");
    }
  }

  function makeAction(label, className, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `xhs-monitor-action ${className}`;
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function renderDecoration(card, note, status) {
    const pullStatus = status?.pullStatus || "";
    let state = status?.inExcel ? "known" : "new";
    if (!status) state = "unloaded";
    if (status?.status === "ignored") state = "ignored";
    if (["partial", "failed"].includes(pullStatus)) state = "partial";
    if (pullStatus === "pulling" || pullingNoteIds.has(note.noteId)) state = "pulling";
    if (status?.inExcel) state = "known";
    const relevanceStatus = status?.relevanceStatus || (status?.inExcel || status?.isRelevant ? "relevant" : "unknown");
    const relevanceAnalyzing = relevanceAnalyzingNoteIds.has(note.noteId);
    const meta = STATE_META[state];
    const matchLabel = status?.matchLabel || "";
    const expectedKey = `${note.noteId}|${state}|${matchLabel}|${pullStatus}|${relevanceStatus}|${relevanceAnalyzing}`;
    const existing = card.querySelector(`:scope > .${TOOLBAR_CLASS}`);
    if (existing?.dataset.renderKey === expectedKey) return;

    clearDecorations(card);
    ensurePositionAnchor(card);
    card.classList.add(`xhs-monitor-card--${state}`, `xhs-monitor-card--relevance-${relevanceStatus}`);
    const toolbar = document.createElement("div");
    toolbar.className = `${TOOLBAR_CLASS} ${TOOLBAR_CLASS}--${state}`;
    toolbar.dataset.renderKey = expectedKey;
    toolbar.setAttribute("role", "group");
    toolbar.setAttribute("aria-label", `拉取：${meta.label}；相关性：${relevanceStatus}`);
    const badge = document.createElement("span");
    badge.className = "xhs-monitor-badge";
    badge.textContent = meta.label;
    badge.title = meta.hint;
    toolbar.append(badge);
    const relevanceBadge = document.createElement("span");
    relevanceBadge.className = `xhs-monitor-relevance xhs-monitor-relevance--${relevanceStatus}`;
    relevanceBadge.textContent = relevanceAnalyzing ? "AI判断中…" : relevanceStatus === "relevant" ? "相关" : relevanceStatus === "irrelevant" ? "不相关" : "相关性未知";
    relevanceBadge.title = status?.relevanceReason || "综合标题、正文、话题和评论判断";
    toolbar.append(relevanceBadge);

    if (relevanceStatus === "unknown" && !relevanceAnalyzing) {
      toolbar.append(makeAction("AI判断", "xhs-monitor-action--relevance", async (event) => {
        event.preventDefault(); event.stopPropagation();
        relevanceAnalyzingNoteIds.add(note.noteId);
        renderDecoration(card, note, status);
        try {
          const result = await sendRuntime({ type: "analyzeNoteRelevance", note: { ...note, showProcess: true, process: true } });
          if (!result?.ok) throw new Error(result?.error || "AI 判断失败");
          renderDecoration(card, note, { ...status, relevanceStatus: result.relevanceStatus,
            relevanceSource: result.relevanceSource, relevanceReason: result.relevanceReason,
            relevanceConfidence: result.relevanceConfidence, isRelevant: result.isRelevant,
            status: result.relevanceStatus === "irrelevant" ? "irrelevant" : status?.status || "new" });
        } catch (error) {
          relevanceBadge.title = error?.message || "AI 判断失败";
        } finally {
          relevanceAnalyzingNoteIds.delete(note.noteId);
          scheduleScan("relevance-result", 300);
        }
      }));
    }

    if (state !== "known" && state !== "ignored") {
      toolbar.append(makeAction(state === "partial" ? "重试拉取" : "拉取", "xhs-monitor-action--pull", async (event) => {
        event.preventDefault(); event.stopPropagation();
        toolbar.querySelectorAll("button").forEach((button) => { button.disabled = true; });
        pullingNoteIds.add(note.noteId);
        renderDecoration(card, note, { ...status, pullStatus: "pulling" });
        try {
          const result = await sendRuntime({ type: "pullNote", note: { ...note, showProcess: true, process: true } });
          if (!result?.ok) throw new Error(result?.error || "操作失败");
          renderDecoration(card, note, { ...status, status: "known", inExcel: true, isNew: false,
            pullStatus: result.pullStatus || "synced", relevanceStatus: "relevant", isRelevant: true });
        } catch (error) {
          renderDecoration(card, note, { ...status, status: "partial", pullStatus: "partial", pullError: error?.message || "拉取失败" });
        } finally { pullingNoteIds.delete(note.noteId); }
      }));
    } else if (state === "known") {
      const button = makeAction("已拉取", "xhs-monitor-action--done", (event) => { event.preventDefault(); event.stopPropagation(); });
      button.disabled = true;
      toolbar.append(button);
    }
    card.prepend(toolbar);
  }

  function decorate(notes, statuses) {
    const statusById = new Map((statuses || []).map((status) => [status.noteId, status]));
    for (const note of notes) {
      const card = document.querySelector(`[${CARD_MARK}="${CSS.escape(note.noteId)}"]`);
      const status = statusById.get(note.noteId);
      if (card) {
        renderDecoration(card, note, status || {
          noteId: note.noteId,
          status: "unloaded",
          isNew: false,
          inExcel: false,
          isRelevant: false,
          relevanceStatus: "unknown",
          pullStatus: "not_started"
        });
      }
    }
  }

  function scanFingerprint(notes = []) {
    return notes.map((note) => [
      note.noteId,
      clean(note.title, 180),
      clean(note.content, 260),
      (note.tags || []).slice(0, 6).join("#"),
      note.imageUrls?.length || 0
    ].join("~")).sort().join("|");
  }

  async function runScan(reason = "auto") {
    if (reason === "auto" && !shouldAutoScan()) return { ok: false, skipped: true, notes: [] };
    const notes = extractNotes({ lightweight: true });
    const directlyRelevantCount = notes.filter((note) => relevanceMatch(note).relevant).length;
    const detailPendingCount = 0;
    const fingerprint = scanFingerprint(notes);
    if (!notes.length) {
      return {
        ok: true, notes: [], statuses: [], scannedCount: 0, relevantCount: 0,
        filteredCount: 0, detailPendingCount: 0,
        warning: "当前页面未找到可识别的帖子卡片"
      };
    }
    if (reason === "auto" && fingerprint === lastAutoScanFingerprint && lastAutoScanResult?.ok) {
      const statuses = lastAutoScanResult.statuses || [];
      decorate(notes, statuses);
      return {
        ...lastAutoScanResult,
        cached: true,
        notes: notes.filter((note) => statuses.some((status) => status.noteId === note.noteId)),
        scannedCount: notes.length,
        directRelevantCount: directlyRelevantCount,
        detailPendingCount
      };
    }
    let result;
    try {
      result = await sendRuntime({
        type: "scanPage",
        payload: {
          keyword: currentKeyword(), pageUrl: location.href,
          scannedAt: new Date().toISOString(), reason, titleOnly: true,
          returnAllStatuses: true, notes
        }
      });
    } catch (error) {
      result = { ok: false, offline: true, statuses: [], error: error.message || "本地 Bridge 暂不可用" };
    }
    bridgeReady = Boolean(result?.ok);
    if (result?.ok) {
      lastAutoScanFingerprint = fingerprint;
      lastAutoScanResult = result;
    }
    // A bridge timeout or an incomplete backend response must not remove the
    // visual affordance from cards that are already on screen. Keep the card
    // outline and render a local “待读取” fallback until the next successful
    // comparison supplies the definitive state.
    decorate(notes, result?.statuses || []);
    const enriched = {
      ...result,
      notes: notes.filter((note) => (result?.statuses || []).some((status) => status.noteId === note.noteId)),
      scannedCount: notes.length,
      directRelevantCount: directlyRelevantCount,
      relevantCount: result?.relevantCount || 0,
      filteredCount: result?.filteredCount || 0,
      detailPendingCount
    };
    window.dispatchEvent(new CustomEvent("xhs-monitor-scan-complete", { detail: enriched }));
    return enriched;
  }

  function scan(reason = "auto") {
    if (activeScan) {
      pendingScan = true;
      return activeScan;
    }
    const currentScan = runScan(reason);
    activeScan = currentScan;
    currentScan.finally(() => {
      if (activeScan === currentScan) activeScan = null;
      if (pendingScan) {
        pendingScan = false;
        scheduleScan();
      }
    }).catch(() => {});
    return currentScan;
  }

  function scheduleScan(delay = 220) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scan("auto").catch(() => {}), delay);
  }

  function scheduleDeepScan(delay = 700) {
    if (!bridgeReady || !config.enabled || !isSearchPage()) return;
    clearTimeout(deepScanTimer);
    deepScanTimer = setTimeout(async () => {
      if (deepScanActive || activeDeepScanPromise) {
        deepScanQueued = true;
        return;
      }
      if (activeScan) await activeScan.catch(() => {});
      const pending = extractNotes().filter(autoDetailEligible);
      if (!pending.length) return;
      requestDeepScan("auto").catch(() => {});
    }, delay);
  }

  function isPluginOwnedNode(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(element?.closest?.(`.${TOOLBAR_CLASS}, .${PROCESS_PANEL_CLASS}`));
  }

  function isPluginOnlyMutation(record) {
    const nodes = [...record.addedNodes, ...record.removedNodes];
    return nodes.length > 0 && nodes.every(isPluginOwnedNode);
  }

  function rememberManualDetailHint(event) {
    const target = event.target?.closest?.(`${NOTE_LINK_SELECTOR}, [data-note-id], [note-id]`);
    if (!target || isPluginOwnedNode(target)) return;
    const noteId = noteIdFromUrl(target.href || "")
      || clean(target.getAttribute?.("data-note-id") || target.getAttribute?.("note-id"), 128);
    if (!noteId) return;
    const card = candidateCard(target);
    const title = extractTitle(card, target);
    const author = extractAuthor(card, title);
    const content = extractCaption(card, title, author);
    currentDetailHint = {
      noteId,
      url: preferredLiveNoteUrl(noteId, target.href || ""),
      title,
      author,
      content,
      detailRead: false,
      tags: extractTags(card, content),
      imageUrls: extractImageUrls(card, 12),
      keyword: currentKeyword(),
      pageUrl: location.href
    };
    dismissedDetailId = "";
    scheduleDetailControl(35);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "pullProgress") {
      if (message.process || processPanel?.dataset.noteId === message.noteId) updateProcessPanel(message);
      return false;
    }
    if (message.type === "scanNow") {
      bridgeReady = true;
      scan("manual").then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === "deepScanNow") {
      requestDeepScan("manual").then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === "extractCurrentDetail") {
      sendResponse(extractCurrentDetail(message.baseNote || {}));
      return false;
    }
    if (message.type === "readNoteInPage") {
      readNoteInPage(message.note || {}).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === "resolveNoteUrl") {
      const noteId = clean(message.noteId, 128);
      const url = noteId ? bestLiveNoteUrl(noteId) : "";
      sendResponse({ ok: Boolean(url), url });
      return false;
    }
    if (message.type === "expandVisibleComments") {
      const buttons = commentUtils.expandableButtons(document).slice(0, Math.max(1, Number(message.limit) || 12));
      buttons.forEach((button) => button.click());
      sendResponse({ ok: true, clicked: buttons.length });
      return false;
    }
    if (message.type === "extractCurrentComments") {
      const detailRoot = detailRootForNote(message.note || {});
      const currentNoteId = noteIdFromUrl(location.href) || clean(detailRoot?.getAttribute?.("note-id"), 128);
      const targetNoteId = clean(message.note?.noteId, 128);
      if (targetNoteId && (!currentNoteId || targetNoteId !== currentNoteId)) {
        sendResponse({ ok: false, matchesTarget: false, currentNoteId, error: "当前详情不是目标帖子" });
        return false;
      }
      const result = commentUtils.extractComments(detailRoot || document, message.note || {});
      sendResponse({ ok: true, matchesTarget: !targetNoteId || targetNoteId === currentNoteId, currentNoteId, ...result });
      return false;
    }
    if (message.type === "applyDeepScanResult") {
      detailStore.remember(message.details || []);
      decorate(message.notes || [], message.statuses || []);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "getPageInfo") {
      const notes = extractNotes({ lightweight: true });
      const relevantCount = notes.filter((note) => relevanceMatch(note).relevant).length;
      const detailPendingCount = 0;
      const currentDetail = currentDetailInfo();
      sendResponse({
        ok: true,
        url: location.href,
        keyword: currentKeyword(),
        isSearchPage: isSearchPage(),
        noteCount: notes.length,
        relevantCount,
        detailPendingCount,
        unresolvedCount: detailPendingCount,
        currentDetail: currentDetail.note,
        currentDetailLoading: currentDetail.loading
      });
    }
    return false;
  });

  chrome.storage.local.get(DEFAULT_CONFIG).then(async (stored) => {
    config = { ...DEFAULT_CONFIG, ...stored };
    try {
      const state = await sendRuntime({ type: "getBridgeState" });
      bridgeReady = Boolean(state?.ok);
      if (bridgeReady) {
        const relevance = await sendRuntime({ type: "getRelevanceGroups", force: true });
        if (relevance?.ok && relevance.groups) activeRelevanceGroups = relevance.groups;
      }
    } catch (_error) {
      bridgeReady = false;
    }
    if (!started) {
      started = true;
      const observer = new MutationObserver((records) => {
        if (records.length && records.every(isPluginOnlyMutation)) return;
        scheduleDetailControl(45);
        scheduleScan();
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["href", "data-note-id", "note-id"]
      });
      document.addEventListener("click", rememberManualDetailHint, { capture: true, passive: true });
      document.addEventListener("scroll", (event) => {
        if (event.target instanceof Element && event.target.closest(`.${PROCESS_PANEL_CLASS}`)) return;
        scheduleScan(140);
      }, { passive: true, capture: true });
      window.addEventListener("scroll", () => scheduleScan(140), { passive: true });
      scheduleDetailControl(20);
      scheduleScan();
    }
    startFallbackNavigation();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.targetKeywords) config.targetKeywords = changes.targetKeywords.newValue || DEFAULT_CONFIG.targetKeywords;
    if (changes.enabled) config.enabled = changes.enabled.newValue !== false;
    scheduleScan();
  });
})();
