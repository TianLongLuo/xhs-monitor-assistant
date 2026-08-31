"use strict";

const floatingMode = new URLSearchParams(globalThis.location?.search || "").get("mode") === "floating";
const ballMode = new URLSearchParams(globalThis.location?.search || "").get("mode") === "ball";
document.body?.classList?.toggle?.("is-floating", floatingMode);
document.body?.classList?.toggle?.("is-ball", ballMode);

const elements = {
  bridgeStateDot: document.getElementById("bridgeStateDot"),
  bridgeStateText: document.getElementById("bridgeStateText"),
  bridgeVersion: document.getElementById("bridgeVersion"),
  toggleFloating: document.getElementById("toggleFloating"),
  refreshAll: document.getElementById("refreshAll"),
  openSettings: document.getElementById("openSettings"),
  settingsPanel: document.getElementById("settingsPanel"),
  overviewTab: document.getElementById("overviewTab"),
  postsTab: document.getElementById("postsTab"),
  postsTabBadge: document.getElementById("postsTabBadge"),
  toolsTab: document.getElementById("toolsTab"),
  toolsTabBadge: document.getElementById("toolsTabBadge"),
  scanTrack: document.getElementById("scanTrack"),
  pageKeyword: document.getElementById("pageKeyword"),
  pageCount: document.getElementById("pageCount"),
  currentDetailCard: document.getElementById("currentDetailCard"),
  currentDetailVisual: document.getElementById("currentDetailVisual"),
  currentDetailThumb: document.getElementById("currentDetailThumb"),
  currentDetailTitle: document.getElementById("currentDetailTitle"),
  currentDetailState: document.getElementById("currentDetailState"),
  currentDetailMeta: document.getElementById("currentDetailMeta"),
  currentDetailPullStatus: document.getElementById("currentDetailPullStatus"),
  currentDetailRelevance: document.getElementById("currentDetailRelevance"),
  currentDetailAnalyze: document.getElementById("currentDetailAnalyze"),
  currentDetailPull: document.getElementById("currentDetailPull"),
  currentDetailSummary: document.getElementById("currentDetailSummary"),
  currentDetailComments: document.getElementById("currentDetailComments"),
  currentDetailWatch: document.getElementById("currentDetailWatch"),
  currentDetailRefresh: document.getElementById("currentDetailRefresh"),
  currentDetailDelete: document.getElementById("currentDetailDelete"),
  currentDetailHint: document.getElementById("currentDetailHint"),
  scanCurrent: document.getElementById("scanCurrent"),
  scanButtonLabel: document.getElementById("scanButtonLabel"),
  deepScanCurrent: document.getElementById("deepScanCurrent"),
  deepScanButtonLabel: document.getElementById("deepScanButtonLabel"),
  syncAllPulled: document.getElementById("syncAllPulled"),
  syncAllPulledLabel: document.getElementById("syncAllPulledLabel"),
  batchSyncProgress: document.getElementById("batchSyncProgress"),
  batchSyncTitle: document.getElementById("batchSyncTitle"),
  batchSyncCount: document.getElementById("batchSyncCount"),
  batchSyncBar: document.getElementById("batchSyncBar"),
  batchSyncCurrent: document.getElementById("batchSyncCurrent"),
  batchSyncStats: document.getElementById("batchSyncStats"),
  batchSyncFailures: document.getElementById("batchSyncFailures"),
  batchSyncFailureCount: document.getElementById("batchSyncFailureCount"),
  batchSyncFailureList: document.getElementById("batchSyncFailureList"),
  ignoreAllBatchFailures: document.getElementById("ignoreAllBatchFailures"),
  cancelBatchSync: document.getElementById("cancelBatchSync"),
  retryBatchFailures: document.getElementById("retryBatchFailures"),
  deleteUnreachable: document.getElementById("deleteUnreachable"),
  deleteUnreachableLabel: document.getElementById("deleteUnreachableLabel"),
  unreachableCount: document.getElementById("unreachableCount"),
  unreachableHint: document.getElementById("unreachableHint"),
  status: document.getElementById("status"),
  scanStages: document.getElementById("scanStages"),
  newCount: document.getElementById("newCount"),
  knownCount: document.getElementById("knownCount"),
  ignoredCount: document.getElementById("ignoredCount"),
  negativeCount: document.getElementById("negativeCount"),
  libraryTotal: document.getElementById("libraryTotal"),
  inboxTotal: document.getElementById("inboxTotal"),
  recordTotal: document.getElementById("recordTotal"),
  newMetric: document.getElementById("newMetric"),
  knownMetric: document.getElementById("knownMetric"),
  ignoredMetric: document.getElementById("ignoredMetric"),
  negativeMetric: document.getElementById("negativeMetric"),
  negativeTabs: document.getElementById("negativeTabs"),
  negativeFilters: document.getElementById("negativeFilters"),
  negativeKeyword: document.getElementById("negativeKeyword"),
  negativeFirstSeen: document.getElementById("negativeFirstSeen"),
  negativePublished: document.getElementById("negativePublished"),
  negativeRisk: document.getElementById("negativeRisk"),
  negativeCategory: document.getElementById("negativeCategory"),
  negativeBusinessStatus: document.getElementById("negativeBusinessStatus"),
  negativeAIStatus: document.getElementById("negativeAIStatus"),
  negativeReviewStatus: document.getElementById("negativeReviewStatus"),
  negativeSourceKeyword: document.getElementById("negativeSourceKeyword"),
  applyNegativeFilters: document.getElementById("applyNegativeFilters"),
  allPosts: document.getElementById("allPosts"),
  ignoredPosts: document.getElementById("ignoredPosts"),
  queueSection: document.getElementById("queueSection"),
  queueBack: document.getElementById("queueBack"),
  queueKicker: document.getElementById("queueKicker"),
  queueTitle: document.getElementById("queueTitle"),
  queueHint: document.getElementById("queueHint"),
  queueMore: document.getElementById("queueMore"),
  pendingCount: document.getElementById("pendingCount"),
  pendingList: document.getElementById("pendingList"),
  pendingEmpty: document.getElementById("pendingEmpty"),
  operationsCenter: document.getElementById("operationsCenter"),
  ignoredOperations: document.getElementById("ignoredOperations"),
  ignoredOperationsCount: document.getElementById("ignoredOperationsCount"),
  ignoredOperationsList: document.getElementById("ignoredOperationsList"),
  refreshOperations: document.getElementById("refreshOperations"),
  healthScore: document.getElementById("healthScore"),
  healthSummary: document.getElementById("healthSummary"),
  healthMetrics: document.getElementById("healthMetrics"),
  healthIssues: document.getElementById("healthIssues"),
  runHealthCheck: document.getElementById("runHealthCheck"),
  repairHealth: document.getElementById("repairHealth"),
  changeUnreadCount: document.getElementById("changeUnreadCount"),
  changeMetrics: document.getElementById("changeMetrics"),
  changeList: document.getElementById("changeList"),
  refreshChanges: document.getElementById("refreshChanges"),
  acknowledgeChanges: document.getElementById("acknowledgeChanges"),
  watchCount: document.getElementById("watchCount"),
  watchList: document.getElementById("watchList"),
  refreshWatchlist: document.getElementById("refreshWatchlist"),
  weeklyReportState: document.getElementById("weeklyReportState"),
  weeklyStartDate: document.getElementById("weeklyStartDate"),
  weeklyEndDate: document.getElementById("weeklyEndDate"),
  weeklyReportSummary: document.getElementById("weeklyReportSummary"),
  generateWeeklyReport: document.getElementById("generateWeeklyReport"),
  openWeeklyReport: document.getElementById("openWeeklyReport"),
  openWeeklyExcel: document.getElementById("openWeeklyExcel"),
  keywords: document.getElementById("keywords"),
  bridgeUrl: document.getElementById("bridgeUrl"),
  saveConfig: document.getElementById("saveConfig"),
  aiBaseUrl: document.getElementById("aiBaseUrl"),
  aiKey: document.getElementById("aiKey"),
  aiModel: document.getElementById("aiModel"),
  aiThinking: document.getElementById("aiThinking"),
  aiTemperature: document.getElementById("aiTemperature"),
  aiTimeout: document.getElementById("aiTimeout"),
  aiMaxTokens: document.getElementById("aiMaxTokens"),
  aiBatchSize: document.getElementById("aiBatchSize"),
  aiConcurrency: document.getElementById("aiConcurrency"),
  aiDailyLimit: document.getElementById("aiDailyLimit"),
  testAI: document.getElementById("testAI"),
  saveAI: document.getElementById("saveAI"),
  clearAIHistory: document.getElementById("clearAIHistory"),
  lastScan: document.getElementById("lastScan"),
  summaryPage: document.getElementById("summaryPage"),
  summaryBack: document.getElementById("summaryBack"),
  summaryRerun: document.getElementById("summaryRerun"),
  summaryTitle: document.getElementById("summaryTitle"),
  summaryMeta: document.getElementById("summaryMeta"),
  summaryLoading: document.getElementById("summaryLoading"),
  summaryError: document.getElementById("summaryError"),
  summaryResult: document.getElementById("summaryResult"),
  summarySentiment: document.getElementById("summarySentiment"),
  summaryOverview: document.getElementById("summaryOverview"),
  summaryKeyPoints: document.getElementById("summaryKeyPoints"),
  summaryConsensus: document.getElementById("summaryConsensus"),
  summaryDisagreements: document.getElementById("summaryDisagreements"),
  summaryRisks: document.getElementById("summaryRisks"),
  summaryActions: document.getElementById("summaryActions"),
  summaryComments: document.getElementById("summaryComments"),
  commentsPage: document.getElementById("commentsPage"),
  commentsBack: document.getElementById("commentsBack"),
  commentsReload: document.getElementById("commentsReload"),
  commentsTitle: document.getElementById("commentsTitle"),
  commentsMeta: document.getElementById("commentsMeta"),
  personaHint: document.getElementById("personaHint"),
  commentsLoading: document.getElementById("commentsLoading"),
  commentsError: document.getElementById("commentsError"),
  commentsList: document.getElementById("commentsList")
};

let scanning = false;
let deepScanning = false;
let pendingNotes = [];
let visiblePendingCount = null;
let queueView = { type: "pending", status: "new" };
const activePulls = new Set();
let currentDetailNote = null;
let currentDetailPullingId = "";
let currentDetailRenderSignature = "";
let pendingRenderSignature = "";
let pageInfoRequest = null;
let refreshAllRequest = null;
let commentPageData = { note: null, comments: [], persona: "brand" };
let batchSyncViewState = {
  ok: true, running: false, done: false, cancelled: false,
  total: 0, current: 0, currentTitle: "", changedPosts: 0,
  unchangedPosts: 0, failedPosts: 0, accessiblePosts: 0, reviewPosts: 0,
  unreachablePosts: 0, processingFailedPosts: 0, statusSyncFailures: 0, newComments: 0,
  removedComments: 0, changedComments: 0, phase: "idle",
  error: "", startedAt: "", finishedAt: ""
};
let batchSyncCompletionNotified = "";
let unreachableNotes = [];
let unreachableDeleteRunning = false;
let panelView = "overview";
let operationsLoading = false;
let operationsState = { health: null, changes: null, watchlist: null, report: null };

if (floatingMode) {
  document.title = "XHS-Monitor 帖子核对 · 悬浮窗";
  elements.toggleFloating?.setAttribute("title", "恢复到侧边栏");
  elements.toggleFloating?.setAttribute("aria-label", "恢复到侧边栏");
} else if (ballMode) {
  document.title = "舆情雷达 · 快捷窗";
} else {
  elements.toggleFloating?.setAttribute("title", "缩小为悬浮窗");
  elements.toggleFloating?.setAttribute("aria-label", "缩小为悬浮窗");
}

const STATUS_VIEWS = {
  new: { title: "新相关未拉取", kicker: "NEW & RELEVANT", hint: "与 XHS-Monitor 品牌相关，但本地笔记 CSV 中还没有" },
  known: { title: "CSV 已有", kicker: "IN LOCAL CSV", hint: "这些帖子已经存在于本地笔记 CSV" },
  confirmed: { title: "待加入 CSV", kicker: "MARKED", hint: "已人工标记，但当前仍未写入 CSV" },
  ignored: { title: "已忽略帖子", kicker: "IGNORED", hint: "不再参与批量同步，可随时恢复" }
};

const PANEL_VIEWS = new Set(["overview", "posts", "tools"]);

function setPanelView(nextView, options = {}) {
  const view = PANEL_VIEWS.has(nextView) ? nextView : "overview";
  const changed = panelView !== view;
  panelView = view;
  document.body.dataset.panelView = view;
  [elements.overviewTab, elements.postsTab, elements.toolsTab].forEach((button) => {
    if (!button) return;
    const active = button.dataset.panelView === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  if (options.scroll !== false && changed) {
    const target = [...document.querySelectorAll(`[data-panel-section="${view}"]`)]
      .find((section) => !section.hidden);
    target?.scrollIntoView?.({ block: "start", behavior: options.smooth === false ? "auto" : "smooth" });
  }
}

function setScanStage(active = "", completed = []) {
  const completedSet = new Set(completed);
  elements.scanStages?.querySelectorAll?.("li[data-stage]")?.forEach((item) => {
    const stage = item.dataset.stage;
    item.classList.toggle("is-active", stage === active);
    item.classList.toggle("is-complete", completedSet.has(stage));
  });
}

function sendRuntime(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function friendlyTabError(error) {
  const message = String(error?.message || error || "未知错误");
  if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
    return new Error("自动注入当前页面失败，请稍后重试或检查小红书页面权限");
  }
  return new Error(message);
}

async function toggleFloatingWindow() {
  if (!elements.toggleFloating) return;
  elements.toggleFloating.disabled = true;
  try {
    let result;
    if (floatingMode) {
      // Prefer the direct user-gesture path for sidePanel.open. Some Chrome
      // versions reject the same call when it is relayed through a worker.
      let opened = false;
      const saved = await chrome.storage.local.get({ floatingOriginWindowId: null }).catch(() => ({}));
      const originWindowId = Number(saved.floatingOriginWindowId) || 0;
      if (originWindowId && chrome.sidePanel?.open) {
        try {
          await chrome.sidePanel.open({ windowId: originWindowId });
          opened = true;
        } catch (_error) {}
      }
      result = await sendRuntime({ type: opened ? "closeFloatingWindow" : "restoreSidePanel" });
    } else {
      result = await sendRuntime({ type: "openBallWindow" });
    }
    if (!result?.ok) throw new Error(result?.error || "窗口切换失败");
    if (floatingMode) {
      // The service worker opens the original side panel and then closes this
      // popup. Keeping the close here also covers Chrome versions that do not
      // expose windows.remove to the service worker immediately.
      if (typeof window !== "undefined" && typeof window.close === "function") window.close();
      return;
    }
    setStatus("已缩小为右侧快捷悬浮窗，点击卡片可展开完整面板", "success");
  } catch (error) {
    setStatus(error.message || "窗口切换失败", "error");
  } finally {
    if (!floatingMode) elements.toggleFloating.disabled = false;
  }
}

async function sendToActiveTab(message) {
  let tabId = 0;
  if (floatingMode && chrome.storage?.local?.get) {
    const state = await chrome.storage.local.get({ floatingOriginWindowId: null }).catch(() => ({}));
    const windowId = Number(state?.floatingOriginWindowId) || 0;
    const tabs = await chrome.tabs.query(windowId ? { active: true, windowId } : { active: true, currentWindow: true });
    tabId = Number(tabs?.[0]?.id) || 0;
  } else {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = Number(tabs?.[0]?.id) || 0;
  }
  if (!tabId) throw new Error("没有找到当前小红书标签页");
  const result = await sendRuntime({ type: "sendToActiveXhsTab", tabId, payload: message });
  if (!result?.ok && result?.error) throw new Error(result.error);
  return result;
}

function setStatus(message, state = "idle", action = null) {
  const copy = document.createElement("span");
  copy.textContent = message;
  elements.status.replaceChildren(copy);
  if (action?.label && typeof action.onClick === "function") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "status-action";
    button.textContent = action.label;
    button.addEventListener("click", action.onClick);
    elements.status.append(button);
  }
  elements.status.dataset.state = state;
}

// 底部居中弹窗，2 秒后自动消失
function showToast(message, variant = "success") {
  if (!message) return;
  const toast = document.createElement("div");
  toast.className = `app-toast app-toast--${variant}`;
  toast.setAttribute("role", "status");
  toast.textContent = message;
  document.body.append(toast);
  requestAnimationFrame(() => toast.classList.add("app-toast--show"));
  window.setTimeout(() => {
    toast.classList.remove("app-toast--show");
    window.setTimeout(() => toast.remove(), 320);
  }, 2000);
}

function batchSyncPhaseLabel(state) {
  if (state.cancelled || state.phase === "cancelled") return "同步已停止";
  if (state.phase === "stopping") return "正在停止";
  if (state.phase === "interrupted") return "上次同步已中断";
  if (state.phase === "status-write-failed") return "访问状态写入失败";
  if (state.phase === "failed") return "批量同步失败";
  if (state.phase === "failed-note") return "当前帖子读取失败";
  if (state.phase === "synced") return "当前帖子已更新";
  if (state.phase === "unchanged") return "当前帖子无变化";
  if (state.phase === "reading") return "正在打开帖子并展开评论";
  if (state.done) return "全部同步完成";
  return "正在准备批量同步";
}

function batchSyncSummary(state) {
  const accessible = Math.max(0, Number(state.accessiblePosts) || 0);
  const review = Math.max(0, Number(state.reviewPosts) || 0);
  const unreachable = Math.max(0, Number(state.unreachablePosts) || 0);
  const processing = Math.max(0, Number(state.processingFailedPosts) || 0);
  const writeFailures = Math.max(0, Number(state.statusSyncFailures) || 0);
  return `有变化 ${Number(state.changedPosts) || 0} · 无变化 ${Number(state.unchangedPosts) || 0} · 可打开 ${accessible} · 待复核 ${review} · 已确认失效 ${unreachable} · 读取未完成 ${processing}${writeFailures ? ` · 状态未写入 ${writeFailures}` : ""}`;
}

function failureNoteUrl(failure = {}) {
  const storedUrl = String(failure.url || "").trim();
  if (/^https:\/\/([a-z0-9-]+\.)?xiaohongshu\.com\//i.test(storedUrl)) return storedUrl;
  const noteId = String(failure.noteId || "").trim();
  return noteId ? `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}` : "";
}

async function ignoreBatchFailureItems(items = [], confirmMany = false) {
  const targets = (Array.isArray(items) ? items : []).filter((item) => item?.noteId);
  if (!targets.length) return null;
  if (confirmMany && !confirm(`确定一键忽略 ${targets.length} 篇未完成帖子吗？\n\n忽略后不再参与“同步全部”，可在运营页面展开并恢复。`)) return null;
  const result = await sendRuntime({ type: "ignoreBatchFailures", noteIds: targets.map((item) => item.noteId) });
  if (result?.state) renderBatchSync(result.state);
  if (!result?.ok) throw new Error(result?.error || "忽略失败");
  setStatus(`已忽略 ${result.ignoredCount || targets.length} 篇帖子，可在运营页面恢复`, "success");
  showToast("帖子已移入运营页的“已忽略帖子”");
  await Promise.all([refreshStats(), refreshIgnoredOperations(), refreshUnreachableNotes()]);
  return result;
}

function renderBatchFailures(failures = []) {
  if (!elements.batchSyncFailures || !elements.batchSyncFailureList) return;
  const items = Array.isArray(failures) ? failures.filter((item) => item?.noteId || item?.url) : [];
  elements.batchSyncFailures.hidden = items.length === 0;
  if (elements.batchSyncFailureCount) elements.batchSyncFailureCount.textContent = `${items.length} 篇`;
  if (elements.ignoreAllBatchFailures) {
    elements.ignoreAllBatchFailures.hidden = items.length === 0;
    elements.ignoreAllBatchFailures.disabled = batchSyncViewState.running || !items.some((item) => item?.noteId);
  }
  const fragment = document.createDocumentFragment();
  items.forEach((failure, index) => {
    const item = document.createElement("li");
    item.className = "batch-sync-failure";
    const url = failureNoteUrl(failure);
    const number = document.createElement("span");
    number.className = "batch-sync-failure__number";
    number.textContent = String(index + 1).padStart(2, "0");
    const copy = document.createElement("span");
    copy.className = "batch-sync-failure__copy";
    const diagnosis = failure.diagnosis || {};
    item.dataset.diagnosis = diagnosis.code || "unknown";
    const badge = document.createElement("span");
    badge.className = "batch-sync-failure__badge";
    badge.textContent = diagnosis.label || (failure.markedUnreachable ? "已确认失效" : "同步未完成");
    const title = document.createElement("strong");
    title.textContent = failure.title || "未命名帖子";
    const reason = document.createElement("small");
    reason.textContent = [diagnosis.summary, diagnosis.localSummary, failure.error].filter(Boolean).join(" · ") || "等待重新核验";
    reason.title = reason.textContent;
    copy.append(badge, title, reason);
    const actions = document.createElement("span");
    actions.className = "batch-sync-failure__actions";
    const open = document.createElement("a");
    open.className = "batch-sync-failure__action";
    open.href = url;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.title = "在新标签页打开原帖";
    open.textContent = failure.markedUnreachable ? "原帖 ↗" : "打开 ↗";
    const excel = document.createElement("button");
    excel.type = "button";
    excel.className = "batch-sync-failure__excel";
    excel.textContent = "CSV";
    excel.title = "使用 WPS 打开笔记 CSV 并定位到该帖子行";
    excel.disabled = !failure.noteId;
    excel.addEventListener("click", async () => {
      const originalText = excel.textContent;
      excel.disabled = true;
      excel.textContent = "定位中";
      try {
        const result = await sendRuntime({
          type: "openLocalArtifact",
          payload: { kind: "excel", noteId: failure.noteId, fieldName: "笔记标题" }
        });
        if (!result?.ok) throw new Error(result?.error || "CSV 定位失败");
        excel.textContent = "已定位";
        showToast(`已在 CSV 定位“${failure.title || "该帖子"}”`);
      } catch (error) {
        excel.textContent = "重试";
        setStatus(error.message || "CSV 定位失败", "error");
      } finally {
        setTimeout(() => {
          if (!excel.isConnected) return;
          excel.disabled = !failure.noteId;
          excel.textContent = originalText;
        }, 1800);
      }
    });
    const ignore = document.createElement("button");
    ignore.type = "button";
    ignore.className = "batch-sync-failure__ignore";
    ignore.textContent = "忽略";
    ignore.title = "忽略后不再参与批量同步，可在运营页面恢复";
    ignore.disabled = !failure.noteId;
    ignore.addEventListener("click", async () => {
      ignore.disabled = true;
      ignore.textContent = "忽略中";
      try {
        await ignoreBatchFailureItems([failure]);
      } catch (error) {
        ignore.disabled = false;
        ignore.textContent = "重试";
        setStatus(error.message || "忽略失败", "error");
      }
    });
    actions.append(open, excel, ignore);
    item.append(number, copy, actions);
    fragment.append(item);
  });
  elements.batchSyncFailureList.replaceChildren(fragment);
}

function renderBatchSync(state = {}, notify = false) {
  batchSyncViewState = { ...batchSyncViewState, ...(state || {}) };
  const view = batchSyncViewState;
  const total = Math.max(0, Number(view.total) || 0);
  const rawCurrent = Math.max(0, Number(view.current) || 0);
  const current = total ? Math.min(total, rawCurrent) : rawCurrent;
  const running = Boolean(view.running);
  const hasRun = running || Boolean(view.startedAt || view.finishedAt || view.done || (view.phase && view.phase !== "idle"));
  const percent = total > 0 ? Math.min(100, Math.round(current / total * 100)) : (view.done ? 100 : 0);

  if (elements.batchSyncProgress) elements.batchSyncProgress.hidden = !hasRun;
  elements.syncAllPulled?.classList.toggle("is-running", running);
  if (elements.syncAllPulled) elements.syncAllPulled.disabled = running;
  if (elements.syncAllPulledLabel) {
    elements.syncAllPulledLabel.textContent = running
      ? `正在同步 ${current}/${total || "?"}`
      : "同步全部已拉取帖子";
  }
  if (elements.batchSyncTitle) elements.batchSyncTitle.textContent = batchSyncPhaseLabel(view);
  if (elements.batchSyncCount) elements.batchSyncCount.textContent = `${current} / ${total}`;
  if (elements.batchSyncBar) elements.batchSyncBar.style.width = `${percent}%`;
  if (elements.batchSyncCurrent) {
    const failures = Array.isArray(view.failures) ? view.failures : [];
    const failure = failures[failures.length - 1] || null;
    elements.batchSyncCurrent.textContent = view.error
      || (view.currentTitle ? `当前：${view.currentTitle}` : "")
      || (failure ? `${failure.title}：${failure.error}` : "")
      || (view.done ? "已完成所有可访问帖子的评论核对" : "正在读取已拉取帖子列表…");
  }
  if (elements.batchSyncStats) {
    elements.batchSyncStats.textContent = `${batchSyncSummary(view)} · 新增 ${Number(view.newComments) || 0} · 标记删除 ${Number(view.removedComments) || 0} · 修改 ${Number(view.changedComments) || 0}`;
  }
  renderBatchFailures(view.failures);
  if (elements.cancelBatchSync) {
    elements.cancelBatchSync.hidden = !running;
    elements.cancelBatchSync.disabled = view.phase === "stopping";
    elements.cancelBatchSync.textContent = view.phase === "stopping" ? "正在停止…" : "停止同步";
  }
  if (elements.retryBatchFailures) {
    const failedCount = Math.max(0, Number(view.failedPosts) || 0);
    elements.retryBatchFailures.hidden = running || failedCount === 0;
    elements.retryBatchFailures.disabled = running;
    elements.retryBatchFailures.textContent = `重新核验 ${failedCount} 个未完成项`;
    elements.retryBatchFailures.title = (view.failures || []).length < failedCount
      ? "旧批次未保存全部失败 ID，将自动重新核验全部已拉取帖子"
      : "只重新核验上一轮失败的帖子";
  }
  if (elements.deleteUnreachable) {
    const reviewCount = (view.failures || []).filter((item) => !item?.markedUnreachable).length;
    elements.deleteUnreachable.disabled = running || unreachableDeleteRunning || (unreachableNotes.length === 0 && reviewCount === 0);
  }

  if (!notify || running || !view.done) return;
  const notificationKey = view.finishedAt || `${view.startedAt}:${view.phase}`;
  if (!notificationKey || notificationKey === batchSyncCompletionNotified) return;
  batchSyncCompletionNotified = notificationKey;
  if (view.cancelled) {
    setStatus(`批量同步已停止；已处理 ${current}/${total} 篇`, "warning");
    showToast(`批量同步已停止 · 已处理 ${current}/${total}`);
  } else if (!view.ok || view.error) {
    setStatus(`批量同步失败：${view.error || "请重新启动"}`, "error");
    showToast(`批量同步失败：${view.error || "请重新启动"}`, "error");
  } else {
    const message = `评论同步完成 · ${batchSyncSummary(view)}`;
    setStatus(message, Number(view.failedPosts) ? "warning" : "success");
    showToast(message, Number(view.failedPosts) ? "error" : "success");
  }
}

async function startAllPulledSync() {
  if (batchSyncViewState.running) return;
  renderBatchSync({
    ok: true, running: true, done: false, cancelled: false,
    total: 0, current: 0, currentTitle: "", changedPosts: 0,
    unchangedPosts: 0, failedPosts: 0, accessiblePosts: 0, reviewPosts: 0,
    unreachablePosts: 0, processingFailedPosts: 0, statusSyncFailures: 0, newComments: 0,
    removedComments: 0, changedComments: 0, failures: [],
    phase: "preparing", error: "", startedAt: new Date().toISOString(), finishedAt: ""
  });
  setStatus("已启动全部已拉取帖子的评论同步…");
  try {
    const result = await sendRuntime({ type: "syncAllPulledComments" });
    if (!result?.ok) throw new Error(result?.error || "批量同步启动失败");
    renderBatchSync(result);
  } catch (error) {
    renderBatchSync({
      ok: false, running: false, done: true, phase: "failed",
      error: error?.message || "批量同步启动失败", finishedAt: new Date().toISOString()
    }, true);
  }
}

async function retryFailedPulledSync() {
  if (batchSyncViewState.running) return;
  const failedCount = Math.max(0, Number(batchSyncViewState.failedPosts) || 0);
  if (!failedCount) return;
  renderBatchSync({
    ok: true, running: true, done: false, cancelled: false,
    total: failedCount, current: 0, currentTitle: "",
    changedPosts: 0, unchangedPosts: 0, failedPosts: 0,
    accessiblePosts: 0, reviewPosts: 0, unreachablePosts: 0, processingFailedPosts: 0,
    statusSyncFailures: 0,
    newComments: 0, removedComments: 0, changedComments: 0, failures: [],
    phase: "preparing", error: "", finishedAt: ""
  });
  setStatus(`正在重新核验上一轮 ${failedCount} 个失败项…`);
  try {
    const result = await sendRuntime({ type: "syncFailedPulledComments" });
    if (!result?.ok) throw new Error(result?.error || "失败项重试启动失败");
    renderBatchSync(result);
  } catch (error) {
    renderBatchSync({
      ok: false, running: false, done: true, phase: "failed",
      error: error?.message || "失败项重试启动失败", finishedAt: new Date().toISOString()
    }, true);
  }
}

async function cancelAllPulledSync() {
  if (!batchSyncViewState.running) return;
  renderBatchSync({ phase: "stopping" });
  const result = await sendRuntime({ type: "cancelAllPulledComments" });
  if (!result?.ok) throw new Error(result?.error || "停止同步失败");
  renderBatchSync(result);
}

function renderUnreachableNotes(result = {}) {
  unreachableNotes = Array.isArray(result.notes) ? result.notes : [];
  const count = Number(result.count ?? unreachableNotes.length) || 0;
  const reviewCount = (batchSyncViewState.failures || []).filter((item) => !item?.markedUnreachable).length;
  if (elements.unreachableCount) elements.unreachableCount.textContent = String(count || reviewCount);
  if (elements.deleteUnreachableLabel) {
    elements.deleteUnreachableLabel.textContent = count
      ? `清理已确认失效帖子（${count}）`
      : reviewCount ? `人工确认并删除无效帖子（${reviewCount}）` : "暂无已确认失效帖子";
  }
  if (elements.unreachableHint) {
    elements.unreachableHint.textContent = count
      ? "同步删除笔记/评论 CSV、SQLite、分析记录与素材，并执行一致性校验"
      : reviewCount ? "自动证据不足时，可由你人工确认后彻底删除；操作前会再次提示" : "仅删除经双重证据确认已删除或下架的帖子";
  }
  if (elements.deleteUnreachable) {
    elements.deleteUnreachable.disabled = batchSyncViewState.running || unreachableDeleteRunning || (count === 0 && reviewCount === 0);
    elements.deleteUnreachable.title = count
      ? unreachableNotes.slice(0, 5).map((item) => item.title || item.note_id).join("\n")
      : reviewCount ? "点击后确认删除这些无效帖子，并同步清理 CSV、数据库和素材" : "当前没有经双重证据确认的失效帖子";
  }
}

async function refreshUnreachableNotes() {
  const result = await sendRuntime({ type: "getUnreachableNotes" });
  if (!result?.ok) throw new Error(result?.error || "打不开帖子列表读取失败");
  renderUnreachableNotes(result);
  return result;
}

async function deleteAllUnreachableNotes() {
  if (unreachableDeleteRunning || batchSyncViewState.running) return;
  if (!unreachableNotes.length) {
    const reviewFailures = (batchSyncViewState.failures || []).filter((item) => !item?.markedUnreachable && item?.noteId);
    if (!reviewFailures.length) return;
    const preview = reviewFailures.slice(0, 8).map((item) => `• ${item.title || item.noteId}（${item.diagnosis?.label || "待复核"}）`).join("\n");
    const accepted = confirm(
      `自动核验尚未达到“确认失效”标准。\n\n你是否人工确认以下 ${reviewFailures.length} 篇属于无效帖子并彻底删除？\n\n${preview}` +
      `${reviewFailures.length > 8 ? `\n• 另有 ${reviewFailures.length - 8} 篇` : ""}\n\n` +
      "将同步删除笔记/评论 CSV、SQLite 分析记录和素材目录。此操作不可撤销。"
    );
    if (!accepted) return;
    unreachableDeleteRunning = true;
    if (elements.deleteUnreachable) elements.deleteUnreachable.disabled = true;
    if (elements.deleteUnreachableLabel) elements.deleteUnreachableLabel.textContent = `正在删除 ${reviewFailures.length} 篇…`;
    setStatus(`正在按人工确认清理 ${reviewFailures.length} 篇无效帖子…`, "warning");
    try {
      const result = await sendRuntime({ type: "deleteReviewedFailures", noteIds: reviewFailures.map((item) => item.noteId) });
      if (result?.state) renderBatchSync(result.state);
      if (!result?.ok) throw new Error(result?.error || "部分帖子删除失败");
      setStatus(`已彻底删除 ${result.deletedCount || reviewFailures.length} 篇人工确认的无效帖子`, "success");
      showToast("无效帖子已从 CSV、数据库和素材目录清理");
      await Promise.all([refreshStats(), refreshPending(), refreshUnreachableNotes(), loadPageInfo()]);
      return result;
    } finally {
      unreachableDeleteRunning = false;
      renderUnreachableNotes({ notes: unreachableNotes, count: unreachableNotes.length });
    }
  }
  const count = unreachableNotes.length;
  const accepted = confirm(
    `确定删除 ${count} 篇标记为“打不开”的帖子吗？\n\n` +
    "将同时删除笔记 CSV 中的帖子行、评论 CSV 对应行、SQLite 记录和受管素材目录。"
  );
  if (!accepted) return;
  unreachableDeleteRunning = true;
  if (elements.deleteUnreachable) elements.deleteUnreachable.disabled = true;
  if (elements.deleteUnreachableLabel) elements.deleteUnreachableLabel.textContent = `正在删除 ${count} 篇…`;
  setStatus(`正在删除 ${count} 篇打不开帖子及对应评论…`, "warning");
  try {
    const result = await sendRuntime({ type: "deleteUnreachableNotes" });
    const deleted = Number(result?.deletedCount) || 0;
    const failed = Number(result?.failedCount) || 0;
    if (!result?.ok && !deleted) throw new Error(result?.error || "批量删除失败");
    const verified = Boolean(result?.excelVerified && result?.databaseVerified);
    const linked = Number(result?.deletedLinkedDatabaseRecords) || 0;
    const message = `已清理 ${deleted} 篇失效帖子、${Number(result?.deletedCommentRows) || 0} 条 CSV 评论及 ${linked} 条关联记录${verified ? "；CSV 与数据库校验通过" : ""}${failed ? `；${failed} 篇失败` : ""}`;
    setStatus(message, failed ? "warning" : "success");
    showToast(message, failed ? "error" : "success");
    await Promise.all([refreshAll({ quiet: true }), refreshUnreachableNotes()]);
  } finally {
    unreachableDeleteRunning = false;
    renderUnreachableNotes({ count: unreachableNotes.length, notes: unreachableNotes });
  }
}

function renderCurrentDetail(note = null, loading = false) {
  const card = elements.currentDetailCard;
  if (!card) return;
  const noteId = String(note?.noteId || note?.note_id || "").trim();
  currentDetailNote = noteId ? { ...note, noteId } : null;
  const active = currentDetailPullingId === noteId || activePulls.has(noteId);
  const nextSignature = currentDetailNote ? JSON.stringify([
    noteId, loading, active, currentDetailNote.title, currentDetailNote.author,
    currentDetailNote.publishedAt || currentDetailNote.publishTime,
    currentDetailNote.content, currentDetailNote.imageCount,
    Array.isArray(currentDetailNote.imageUrls) ? currentDetailNote.imageUrls[0] : "",
    currentDetailNote.inExcel, currentDetailNote.pullStatus,
    currentDetailNote.relevanceStatus, currentDetailNote.isRelevant,
    currentDetailNote.watched, currentDetailNote.watchPriority
  ]) : "empty";
  if (nextSignature === currentDetailRenderSignature) return;
  currentDetailRenderSignature = nextSignature;
  card.hidden = !currentDetailNote;
  if (!currentDetailNote) return;

  const contentLength = String(currentDetailNote.content || "").trim().length;
  const imageCount = Number(currentDetailNote.imageCount) || currentDetailNote.imageUrls?.length || 0;
  const state = active
    ? { label: "处理中", value: "processing" }
    : currentDetailNote.inExcel
      ? { label: "CSV 已有", value: "synced" }
      : loading || !contentLength
        ? { label: "正文加载中", value: "loading" }
        : { label: "可拉取", value: "ready" };
  const title = currentDetailNote.title || "当前打开帖子";
  const meta = [
    currentDetailNote.author,
    currentDetailNote.publishedAt || currentDetailNote.publishTime,
    currentDetailNote.noteId ? `ID ${currentDetailNote.noteId}` : ""
  ].filter(Boolean).join(" · ");
  const hint = active
    ? "Process 正在详情右侧运行：正文、素材图片、评论及 ID、CSV / SQLite。"
    : currentDetailNote.inExcel
      ? "本次已写入本地 CSV 与 SQLite；再次点击可补采正文、图片或评论。"
      : contentLength
        ? `已读正文 ${contentLength} 字 · ${imageCount} 张图片；点击“拉取到 CSV”开始完整采集。`
        : "详情已打开，点击后会等待正文加载，再读取正文、素材图片、评论及 ID。";

  const imageUrl = Array.isArray(currentDetailNote.imageUrls)
    ? String(currentDetailNote.imageUrls.find(Boolean) || "")
    : "";
  if (elements.currentDetailVisual && elements.currentDetailThumb) {
    elements.currentDetailVisual.hidden = !imageUrl;
    if (imageUrl) {
      if (elements.currentDetailThumb.dataset.sourceUrl !== imageUrl) {
        elements.currentDetailThumb.dataset.sourceUrl = imageUrl;
        elements.currentDetailThumb.src = imageUrl;
      }
      elements.currentDetailThumb.alt = `${title} 的首张素材`;
      elements.currentDetailThumb.onerror = () => { elements.currentDetailVisual.hidden = true; };
    } else {
      if (elements.currentDetailThumb.hasAttribute("src")) elements.currentDetailThumb.removeAttribute("src");
      delete elements.currentDetailThumb.dataset.sourceUrl;
      elements.currentDetailThumb.alt = "";
    }
  }
  elements.currentDetailTitle.textContent = title;
  elements.currentDetailTitle.title = title;
  elements.currentDetailState.textContent = state.label;
  elements.currentDetailState.dataset.state = state.value;
  elements.currentDetailMeta.textContent = meta || "当前详情已识别，等待操作";
  const pulled = currentDetailNote.inExcel || ["synced", "partial"].includes(currentDetailNote.pullStatus);
  elements.currentDetailPullStatus.textContent = pulled ? (currentDetailNote.pullStatus === "partial" ? "拉取：部分拉取" : "拉取：已拉取") : "拉取：未拉取";
  elements.currentDetailPullStatus.dataset.state = pulled ? "pulled" : "missing";
  const relevance = currentDetailNote.relevanceStatus || (currentDetailNote.isRelevant ? "relevant" : "unknown");
  elements.currentDetailRelevance.textContent = `相关性：${relevance === "relevant" ? "相关" : relevance === "irrelevant" ? "不相关" : "未知"}`;
  elements.currentDetailRelevance.dataset.state = relevance;
  elements.currentDetailAnalyze.hidden = relevance !== "unknown";
  elements.currentDetailAnalyze.disabled = active;
  elements.currentDetailHint.textContent = hint;
  elements.currentDetailPull.disabled = active || !noteId;
  elements.currentDetailPull.textContent = active
    ? "处理中…"
    : currentDetailNote.inExcel ? "再次拉取 / 补全" : "拉取到 CSV";
  elements.currentDetailRefresh.disabled = active;
  elements.currentDetailSummary.disabled = active || !contentLength;
  elements.currentDetailComments.disabled = active || !contentLength;
  if (elements.currentDetailWatch) {
    elements.currentDetailWatch.disabled = active || !noteId;
    elements.currentDetailWatch.textContent = currentDetailNote.watched ? "已重点观察" : "加入重点观察";
    elements.currentDetailWatch.dataset.state = currentDetailNote.watched ? "watched" : "idle";
    elements.currentDetailWatch.title = currentDetailNote.watched
      ? "点击移出重点帖子观察名单"
      : "同步变化会在运营工作台优先显示";
  }
  elements.currentDetailDelete.hidden = !pulled;
  elements.currentDetailDelete.disabled = active;
}

function formatLocalTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function renderOperationsMetrics(container, metrics = []) {
  if (!container) return;
  container.replaceChildren();
  for (const [label, value] of metrics) {
    const item = document.createElement("div"); item.className = "operations-metric";
    const strong = document.createElement("strong"); strong.textContent = String(value ?? 0);
    const span = document.createElement("span"); span.textContent = label;
    item.append(strong, span); container.appendChild(item);
  }
}

function operationsEmpty(container, textValue) {
  if (!container) return;
  container.replaceChildren();
  const empty = document.createElement("div"); empty.className = "operations-empty"; empty.textContent = textValue;
  container.appendChild(empty);
}

function renderDataHealth(result) {
  operationsState.health = result?.ok ? result : null;
  if (!result?.ok) {
    elements.healthScore.textContent = "!";
    elements.healthScore.dataset.state = "critical";
    elements.healthSummary.textContent = result?.error || "数据体检暂不可用";
    operationsEmpty(elements.healthIssues, "连接本地 Bridge 后重试");
    elements.repairHealth.disabled = true;
    return;
  }
  const summary = result.summary || {};
  elements.healthScore.textContent = String(result.score ?? "—");
  elements.healthScore.dataset.state = result.status || "healthy";
  const statusLabel = { healthy: "数据结构健康", warning: "发现可处理问题", critical: "发现关键一致性问题" }[result.status] || "体检完成";
  elements.healthSummary.textContent = `${statusLabel} · ${formatLocalTime(result.checkedAt)}`;
  renderOperationsMetrics(elements.healthMetrics, [
    ["SQLite 帖子", summary.databaseNotes || 0],
    ["CSV 帖子", summary.csvNotes ?? summary.excelNotes ?? 0],
    ["问题项目", summary.issueCount || 0]
  ]);
  elements.healthIssues.replaceChildren();
  const issues = Array.isArray(result.issues) ? result.issues : [];
  for (const issue of issues.slice(0, 12)) {
    const row = document.createElement("div"); row.className = "operations-row";
    const copy = document.createElement("div"); copy.className = "operations-row__copy";
    const title = document.createElement("strong"); title.textContent = `${issue.title} · ${issue.count}`;
    const detail = document.createElement("p"); detail.textContent = issue.detail || "";
    copy.append(title, detail);
    const badge = document.createElement("span"); badge.className = "operations-row__badge";
    badge.dataset.severity = issue.severity || "info";
    badge.textContent = issue.repairable ? "可修复" : ({ critical: "关键", warning: "提醒", info: "信息" }[issue.severity] || "检查");
    row.append(copy, badge); elements.healthIssues.appendChild(row);
  }
  if (!issues.length) operationsEmpty(elements.healthIssues, "✓ CSV、SQLite、评论计数与素材目录均未发现异常");
  elements.repairHealth.disabled = !(summary.repairableCount > 0);
}

function openOperationsNote(note) {
  const url = navigationUrl(note, note.url || "");
  if (url) chrome.tabs.create({ url }).catch(() => {});
}

function renderChangeEvents(result) {
  operationsState.changes = result?.ok ? result : null;
  const unread = Number(result?.unread) || 0;
  elements.changeUnreadCount.textContent = String(unread);
  elements.acknowledgeChanges.disabled = unread === 0;
  if (elements.toolsTabBadge) {
    elements.toolsTabBadge.textContent = String(unread);
    elements.toolsTabBadge.hidden = unread === 0;
  }
  const byType = result?.byType || {};
  renderOperationsMetrics(elements.changeMetrics, [
    ["新增评论", byType.comment_added || 0],
    ["标记删除评论", byType.comment_removed || 0],
    ["帖子/状态变化", (byType.note_fields_changed || 0) + (byType.access_status_changed || 0)]
  ]);
  elements.changeList.replaceChildren();
  const labels = {
    comment_added: "新增", comment_removed: "标记删除", comment_changed: "修改",
    note_fields_changed: "帖子", access_status_changed: "状态"
  };
  const events = Array.isArray(result?.events) ? result.events : [];
  for (const event of events.slice(0, 40)) {
    const row = document.createElement("div"); row.className = "operations-row";
    const copy = document.createElement("button"); copy.type = "button"; copy.className = "operations-row__copy";
    copy.style.background = "transparent"; copy.style.border = "0"; copy.style.padding = "0"; copy.style.textAlign = "left";
    const title = document.createElement("strong"); title.textContent = event.title || "未命名帖子";
    const detail = document.createElement("p"); detail.textContent = event.summary || "发生同步变化";
    const meta = document.createElement("small"); meta.textContent = formatLocalTime(event.created_at);
    copy.append(title, detail, meta);
    copy.addEventListener("click", () => openOperationsNote({ noteId: event.note_id, title: event.title, url: event.url }));
    const badge = document.createElement("span"); badge.className = "operations-row__badge";
    badge.dataset.type = event.event_type || ""; badge.textContent = labels[event.event_type] || "变化";
    row.append(copy, badge); elements.changeList.appendChild(row);
  }
  if (!events.length) operationsEmpty(elements.changeList, "当前没有同步变化；无变化时保持安静");
}

function renderWatchlist(result) {
  operationsState.watchlist = result?.ok ? result : null;
  const items = Array.isArray(result?.items) ? result.items : [];
  elements.watchCount.textContent = String(items.length);
  elements.watchList.replaceChildren();
  const priorityLabels = { high: "高优先", normal: "关注", low: "低优先" };
  for (const item of items) {
    const row = document.createElement("div"); row.className = "operations-row";
    const copy = document.createElement("div"); copy.className = "operations-row__copy";
    const title = document.createElement("strong"); title.textContent = item.title || "未命名帖子";
    const detail = document.createElement("p");
    detail.textContent = item.reason || `${item.author || "未知作者"} · 评论 ${item.comment_count_collected || 0}`;
    const meta = document.createElement("small");
    meta.textContent = [item.unread_changes ? `${item.unread_changes} 条未读变化` : "暂无未读变化", formatLocalTime(item.last_change_at)].filter(Boolean).join(" · ");
    copy.append(title, detail, meta);
    const actions = document.createElement("div"); actions.className = "operations-row__actions";
    const open = document.createElement("button"); open.type = "button"; open.textContent = "打开";
    open.addEventListener("click", () => openOperationsNote({ noteId: item.note_id, title: item.title, url: item.url }));
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "移出";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await sendRuntime({ type: "setWatchlist", payload: { noteId: item.note_id, watched: false } });
        if (currentDetailNote?.noteId === item.note_id) {
          currentDetailNote = { ...currentDetailNote, watched: false, watchPriority: "" };
          renderCurrentDetail(currentDetailNote, false);
        }
        await refreshWatchlist();
      } catch (error) { showToast(error.message || "移出失败", "error"); }
    });
    actions.append(open, remove); row.append(copy, actions); elements.watchList.appendChild(row);
  }
  if (!items.length) operationsEmpty(elements.watchList, "还没有重点观察帖子");
}

function renderIgnoredOperations(result) {
  const items = Array.isArray(result?.notes) ? result.notes : [];
  if (elements.ignoredOperationsCount) elements.ignoredOperationsCount.textContent = String(items.length);
  if (!elements.ignoredOperationsList) return;
  elements.ignoredOperationsList.replaceChildren();
  for (const item of items) {
    const row = document.createElement("div"); row.className = "operations-row";
    const copy = document.createElement("div"); copy.className = "operations-row__copy";
    const title = document.createElement("strong"); title.textContent = item.title || "未命名帖子";
    const detail = document.createElement("p");
    detail.textContent = [item.author || "未知作者", item.accessStatus === "unreachable" ? "已确认失效" : "人工忽略"].join(" · ");
    const meta = document.createElement("small"); meta.textContent = formatLocalTime(item.lastSeenAt || item.firstSeenAt);
    copy.append(title, detail, meta);
    const actions = document.createElement("div"); actions.className = "operations-row__actions";
    const open = document.createElement("button"); open.type = "button"; open.textContent = "打开";
    open.addEventListener("click", () => openOperationsNote(item));
    const restore = document.createElement("button"); restore.type = "button"; restore.textContent = "恢复";
    restore.addEventListener("click", async () => {
      restore.disabled = true; restore.textContent = "恢复中";
      try {
        const restored = await sendRuntime({ type: "restoreNote", note: { noteId: item.noteId } });
        if (!restored?.ok) throw new Error(restored?.error || "恢复失败");
        await Promise.all([refreshIgnoredOperations(), refreshStats()]);
        showToast("帖子已恢复，将重新参与批量同步");
      } catch (error) {
        restore.disabled = false; restore.textContent = "重试";
        setStatus(error.message || "恢复失败", "error");
      }
    });
    actions.append(open, restore); row.append(copy, actions); elements.ignoredOperationsList.appendChild(row);
  }
  if (!items.length) operationsEmpty(elements.ignoredOperationsList, "当前没有已忽略帖子");
}

function renderWeeklyReport(result) {
  operationsState.report = result?.found ? result.report : null;
  const report = operationsState.report;
  if (!report) {
    elements.weeklyReportState.textContent = "未生成";
    elements.weeklyReportSummary.textContent = "全量同步结束后会自动刷新近 7 天周报，也可立即手动生成。";
    elements.openWeeklyReport.disabled = true;
    elements.openWeeklyExcel.disabled = true;
    return;
  }
  const summary = report.summary || {};
  elements.weeklyReportState.textContent = "已生成";
  elements.weeklyReportSummary.textContent = `${summary.periodStart || report.period_start} 至 ${summary.periodEnd || report.period_end} · 新增帖子 ${summary.newNotes || 0} · 变化帖子 ${summary.changedNotes || 0} · 新增评论 ${summary.newComments || 0}`;
  elements.openWeeklyReport.disabled = false;
  elements.openWeeklyExcel.disabled = false;
}

async function refreshHealth() {
  const result = await sendRuntime({ type: "getDataHealth" }).catch((error) => ({ ok: false, error: error.message }));
  renderDataHealth(result); return result;
}

async function refreshChanges() {
  const result = await sendRuntime({ type: "getChangeEvents", limit: 100 }).catch((error) => ({ ok: false, error: error.message, events: [] }));
  renderChangeEvents(result); return result;
}

async function refreshWatchlist() {
  const result = await sendRuntime({ type: "getWatchlist", limit: 200 }).catch((error) => ({ ok: false, error: error.message, items: [] }));
  renderWatchlist(result); return result;
}

async function refreshIgnoredOperations() {
  const result = await sendRuntime({ type: "getNotes", status: "ignored", limit: 1000 })
    .catch((error) => ({ ok: false, error: error.message, notes: [] }));
  renderIgnoredOperations(result);
  return result;
}

async function refreshWeeklyReport() {
  const result = await sendRuntime({ type: "getLatestWeeklyReport" }).catch((error) => ({ ok: false, error: error.message, found: false }));
  renderWeeklyReport(result); return result;
}

async function refreshOperations() {
  if (operationsLoading) return operationsState;
  operationsLoading = true;
  elements.refreshOperations.disabled = true;
  try {
    await Promise.all([refreshHealth(), refreshChanges(), refreshWatchlist(), refreshIgnoredOperations(), refreshWeeklyReport()]);
    return operationsState;
  } finally {
    operationsLoading = false;
    elements.refreshOperations.disabled = false;
  }
}

async function toggleCurrentWatch() {
  const note = currentDetailNote;
  if (!note?.noteId) throw new Error("请先打开一篇帖子");
  elements.currentDetailWatch.disabled = true;
  const watched = !note.watched;
  const result = await sendRuntime({
    type: "setWatchlist",
    payload: { noteId: note.noteId, watched, priority: note.watchPriority || "high", reason: note.watchReason || "" }
  });
  if (!result?.ok) throw new Error(result?.error || "观察名单更新失败");
  currentDetailNote = { ...currentDetailNote, watched, watchPriority: watched ? (result.priority || "normal") : "" };
  renderCurrentDetail(currentDetailNote, false);
  await refreshWatchlist();
  showToast(watched ? "已加入重点帖子观察名单" : "已移出重点帖子观察名单");
}

function setDefaultReportDates() {
  if (!elements.weeklyStartDate || !elements.weeklyEndDate) return;
  const end = new Date();
  const start = new Date(end); start.setDate(end.getDate() - 6);
  const localDate = (date) => {
    const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return shifted.toISOString().slice(0, 10);
  };
  if (!elements.weeklyStartDate.value) elements.weeklyStartDate.value = localDate(start);
  if (!elements.weeklyEndDate.value) elements.weeklyEndDate.value = localDate(end);
}

function renderSummaryList(element, values, emptyText = "暂无明确内容") {
  if (!element) return;
  element.replaceChildren();
  const items = Array.isArray(values) && values.length ? values : [emptyText];
  for (const value of items) {
    const li = document.createElement("li");
    li.textContent = String(value || emptyText);
    element.appendChild(li);
  }
}

function renderNoteSummary(result) {
  const summary = result?.summary || {};
  const sentimentLabels = { negative: "负面", light_negative: "轻度负面", neutral: "中立", positive: "正面", mixed: "褒贬混合", uncertain: "信息不足" };
  elements.summarySentiment.textContent = sentimentLabels[summary.sentiment] || "信息不足";
  elements.summarySentiment.dataset.sentiment = summary.sentiment || "uncertain";
  elements.summaryOverview.textContent = summary.overview || "DeepSeek 未返回总览。";
  elements.summaryMeta.textContent = `${result.commentCount || 0} 条评论 · ${result.model || "DeepSeek"} · ${result.updatedAt ? new Date(result.updatedAt).toLocaleString() : "刚刚"}`;
  renderSummaryList(elements.summaryKeyPoints, summary.keyPoints);
  renderSummaryList(elements.summaryConsensus, summary.commentConsensus);
  renderSummaryList(elements.summaryDisagreements, summary.disagreements);
  renderSummaryList(elements.summaryRisks, summary.risks);
  renderSummaryList(elements.summaryActions, summary.actions);
  renderSummaryList(elements.summaryComments, summary.representativeComments);
  elements.summaryResult.hidden = false;
}

async function openCurrentNoteSummary(force = true) {
  const note = currentDetailNote;
  if (!note?.noteId) throw new Error("请先打开一篇帖子");
  elements.summaryPage.hidden = false;
  document.body.classList.add("summary-open");
  elements.summaryTitle.textContent = note.title || "当前帖子";
  elements.summaryMeta.textContent = "正在读取正文与评论…";
  elements.summaryLoading.hidden = false;
  elements.summaryError.hidden = true;
  elements.summaryResult.hidden = true;
  elements.summaryRerun.disabled = true;
  try {
    const result = force
      ? await sendRuntime({ type: "summarizeCurrentNote", note })
      : await sendRuntime({ type: "getNoteSummary", noteId: note.noteId });
    if (!result?.ok || !result?.found) throw new Error(result?.error || "尚无总结结果");
    renderNoteSummary(result);
  } catch (error) {
    elements.summaryError.textContent = error.message || "DeepSeek 总结失败";
    elements.summaryError.hidden = false;
  } finally {
    elements.summaryLoading.hidden = true;
    elements.summaryRerun.disabled = false;
  }
}

function closeSummaryPage() {
  elements.summaryPage.hidden = true;
  document.body.classList.remove("summary-open");
}

function closeCommentsPage() {
  elements.commentsPage.hidden = true;
  document.body.classList.remove("comments-open");
}

function setCommentPersona(persona) {
  commentPageData.persona = persona === "community" ? "community" : "brand";
  document.querySelectorAll(".persona-switch button[data-persona]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.persona === commentPageData.persona);
  });
  elements.personaHint.textContent = commentPageData.persona === "brand"
    ? "官方身份：承接问题，提供可核验处理路径。"
    : "社区交流：不冒充消费者，不编造购买或使用经历。";
}

function renderCommentsPage() {
  elements.commentsList.replaceChildren();
  const comments = commentPageData.comments || [];
  const children = new Map();
  for (const comment of comments) {
    const parentId = comment.parentCommentId || comment.parent_comment_id || "";
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(comment);
  }
  const ordered = [];
  const mains = comments.filter((item) => !(item.parentCommentId || item.parent_comment_id));
  for (const main of mains) {
    ordered.push(main, ...(children.get(main.commentId || main.comment_id) || []));
  }
  for (const item of comments) if (!ordered.includes(item)) ordered.push(item);
  for (const comment of ordered) {
    const commentId = comment.commentId || comment.comment_id;
    const parentId = comment.parentCommentId || comment.parent_comment_id || "";
    const card = document.createElement("article");
    card.className = `comment-assist-card${parentId ? " is-reply" : ""}`;
    card.dataset.commentId = commentId;
    const head = document.createElement("div"); head.className = "comment-assist-card__head";
    const author = document.createElement("strong"); author.textContent = `${parentId ? "↳ " : ""}${comment.author || "匿名用户"}${comment.isAuthor || comment.is_author ? " · 帖主" : ""}`;
    const button = document.createElement("button"); button.type = "button"; button.textContent = "回复建议";
    head.append(author, button);
    const content = document.createElement("p"); content.textContent = comment.content || "";
    const meta = document.createElement("small"); meta.textContent = [comment.publishedAt || comment.published_at, comment.likeCount || comment.like_count ? `赞 ${comment.likeCount || comment.like_count}` : "", parentId ? "子评论" : "主评论"].filter(Boolean).join(" · ");
    const suggestion = document.createElement("div"); suggestion.className = "comment-suggestion"; suggestion.hidden = true;
    button.addEventListener("click", async () => {
      button.disabled = true; button.textContent = "DeepSeek 生成中…";
      suggestion.hidden = false; suggestion.replaceChildren();
      const loading = document.createElement("p"); loading.textContent = "正在结合正文、父评论和全评论区生成建议…"; suggestion.appendChild(loading);
      try {
        const result = await sendRuntime({ type: "suggestCommentReply", note: commentPageData.note,
          comments: commentPageData.comments, targetComment: comment, persona: commentPageData.persona });
        if (!result?.ok) throw new Error(result?.error || "回复建议生成失败");
        const need = document.createElement("small"); need.className = "comment-suggestion__need";
        const contextLabels = [result.suggestion?.intent, result.suggestion?.sentiment].filter(Boolean).join(" · ");
        need.textContent = result.suggestion?.need
          ? `${contextLabels ? `${contextLabels} · ` : ""}${result.suggestion.need}`
          : (contextLabels || "选一条更像你会说的话，也可以直接修改。");
        const choices = document.createElement("div"); choices.className = "comment-suggestion__choices";
        const candidates = Array.isArray(result.suggestion?.candidates) && result.suggestion.candidates.length
          ? result.suggestion.candidates : [{ reply: result.suggestion?.reply || "", style: result.suggestion?.tone || "" }];
        const box = document.createElement("textarea"); box.value = candidates[0]?.reply || ""; box.rows = 4;
        const risk = document.createElement("small"); risk.className = "comment-suggestion__risk";
        const renderRisk = (candidate = {}) => {
          const level = candidate.riskLevel || "low";
          const labels = { low: "低", medium: "中", high: "高" };
          const details = [
            `折叠风险：${labels[level] || "待核对"}`,
            candidate.charCount ? `${candidate.charCount}字` : "",
            Number.isFinite(Number(candidate.similarityScore)) ? `重复度${Math.round(Number(candidate.similarityScore) * 100)}%` : "",
            ...(candidate.riskNotes || []).slice(0, 2)
          ].filter(Boolean);
          risk.dataset.level = level;
          risk.textContent = details.join(" · ");
        };
        candidates.forEach((candidate, index) => {
          const choice = document.createElement("button"); choice.type = "button"; choice.className = index === 0 ? "is-active" : "";
          choice.textContent = candidate.style || `候选 ${index + 1}`;
          choice.title = candidate.why || candidate.reply || "";
          choice.addEventListener("click", () => {
            choices.querySelectorAll("button").forEach((item) => item.classList.remove("is-active"));
            choice.classList.add("is-active"); box.value = candidate.reply || ""; renderRisk(candidate);
          });
          choices.appendChild(choice);
        });
        renderRisk(candidates[0] || {});
        const rationale = document.createElement("small"); rationale.textContent = "建议稿已通过本地长度、导流、功效宣称和重复度检查；发送前仍请核对事实。";
        const confirm = document.createElement("button"); confirm.type = "button"; confirm.textContent = "确认并填入回复框";
        confirm.addEventListener("click", async () => {
          confirm.disabled = true; confirm.textContent = "正在定位评论…";
          try {
            const applied = await sendRuntime({ type: "applyCommentReply", note: commentPageData.note, comment, reply: box.value });
            if (!applied?.ok) throw new Error(applied?.error || "填入失败");
            confirm.textContent = "已填入，等待人工发送";
            showToast("回复已填入小红书输入框，没有自动发送");
          } catch (error) { confirm.disabled = false; confirm.textContent = "重试填入"; showToast(error.message || "填入失败", "error"); }
        });
        suggestion.replaceChildren(need, choices, risk, box, rationale, confirm);
      } catch (error) { loading.textContent = error.message || "回复建议生成失败"; }
      finally { button.disabled = false; button.textContent = "重新生成"; }
    });
    card.append(head, content, meta, suggestion);
    elements.commentsList.appendChild(card);
  }
  if (!ordered.length) {
    const empty = document.createElement("div"); empty.className = "comments-empty"; empty.textContent = "当前没有读取到评论，可刷新后重试。"; elements.commentsList.appendChild(empty);
  }
}

async function openCommentsPage() {
  const note = currentDetailNote;
  if (!note?.noteId) throw new Error("请先打开一篇帖子");
  elements.commentsPage.hidden = false;
  document.body.classList.add("comments-open");
  elements.commentsTitle.textContent = note.title || "当前帖子";
  elements.commentsMeta.textContent = "正在读取评论…";
  elements.commentsLoading.hidden = false;
  elements.commentsError.hidden = true;
  elements.commentsList.replaceChildren();
  try {
    const result = await sendRuntime({ type: "getCurrentNoteComments", note });
    if (!result?.ok) throw new Error(result?.error || "评论读取失败");
    commentPageData.note = result.note || note;
    commentPageData.comments = result.comments || [];
    elements.commentsMeta.textContent = `已读取 ${commentPageData.comments.length} 条 · 页面显示约 ${result.expectedCount || commentPageData.comments.length} 条`;
    renderCommentsPage();
  } catch (error) {
    elements.commentsError.textContent = error.message || "评论读取失败";
    elements.commentsError.hidden = false;
  } finally { elements.commentsLoading.hidden = true; }
}

async function deleteLocalNote(note, button = null) {
  const noteId = note?.noteId || note?.note_id;
  if (!noteId) throw new Error("缺少帖子 ID，无法删除");
  const title = note.title || "该帖子";
  if (!confirm(`确定彻底删除“${title}”吗？\n\n将同时删除：\n• 笔记 CSV 帖子行及评论 CSV 对应行\n• SQLite 帖子、评论和分析记录\n• 对应素材目录\n\n此操作不可撤销。`)) return null;
  const originalButtonText = button?.textContent || "删除本地帖子";
  if (button) {
    button.disabled = true;
    button.textContent = "删除中…";
  }
  setStatus(`正在删除“${title}”的 CSV 行、数据库记录和素材目录…`, "warning");
  try {
    const result = await sendRuntime({ type: "deletePulledNote", noteId });
    if (!result?.ok) throw new Error(result?.error || "删除失败");
    if (currentDetailNote?.noteId === noteId) {
      currentDetailNote = { ...currentDetailNote, inExcel: false, pullStatus: "not_started" };
      renderCurrentDetail(currentDetailNote, false);
    }
    setStatus(
      `删除完成：CSV 删除 ${result.deletedNoteRows || 0} 条帖子、${result.deletedCommentRows || 0} 条评论${result.mediaDeleted ? "，素材目录已删除" : ""}${result.mediaCleanupWarning ? `；${result.mediaCleanupWarning}` : ""}`,
      result.mediaCleanupWarning ? "warning" : "success"
    );
    await Promise.all([refreshStats(), refreshPending(), loadPageInfo()]);
    if (queueView.type === "status") await showStatusView(queueView.status || "known");
    return result;
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = originalButtonText;
    }
  }
}

async function analyzeCurrentDetailRelevance() {
  const note = currentDetailNote;
  if (!note?.noteId) return;
  elements.currentDetailAnalyze.disabled = true;
  elements.currentDetailAnalyze.textContent = "AI 判断中…";
  try {
    const result = await sendRuntime({ type: "analyzeNoteRelevance", note: { ...note, showProcess: true, process: true } });
    if (!result?.ok) throw new Error(result?.error || "AI 判断失败");
    currentDetailNote = { ...currentDetailNote, relevanceStatus: result.relevanceStatus,
      relevanceReason: result.relevanceReason, relevanceConfidence: result.relevanceConfidence,
      isRelevant: result.isRelevant };
    renderCurrentDetail(currentDetailNote, false);
    showToast(result.relevanceStatus === "irrelevant" ? "已判定不相关，并保存在 SQLite" : result.relevanceStatus === "relevant" ? "已判定与品牌相关" : "证据不足，保持相关性未知");
    await refreshAll({ quiet: true });
  } catch (error) { showToast(error.message || "AI 判断失败", "error"); }
  finally { elements.currentDetailAnalyze.textContent = "AI 判断相关性"; elements.currentDetailAnalyze.disabled = false; }
}

async function enrichCurrentDetail(note, loading = false) {
  const noteId = String(note?.noteId || note?.note_id || "").trim();
  const sameNote = Boolean(noteId && currentDetailNote?.noteId === noteId);
  // Keep the locally-enriched status while the 12-second page poll refreshes
  // DOM fields. Rendering the raw DOM note first made the card oscillate
  // between “未拉取” and “Excel 已有” on every poll.
  renderCurrentDetail(sameNote ? { ...currentDetailNote, ...note, noteId } : note, loading);
  if (!noteId) return;
  const result = await sendRuntime({ type: "getNoteStatus", noteId }).catch(() => null);
  if (!result?.ok || currentDetailNote?.noteId !== noteId) return;
  const hydrated = { ...currentDetailNote, ...(result.note || {}), ...result, noteId };
  renderCurrentDetail(hydrated, loading);
  // The side panel and content script are separate extension contexts. Send
  // the already-resolved local status back to the page so the docked Process
  // panel does not depend on a second, timing-sensitive Bridge request.
  sendToActiveTab({ type: "hydrateProcessPanel", note: hydrated, status: result }).catch(() => {});
}

async function pullCurrentDetail() {  const note = currentDetailNote;
  const noteId = note?.noteId;
  if (!noteId || activePulls.has(noteId)) return;
  currentDetailPullingId = noteId;
  renderCurrentDetail(note, false);
  try {
    await pullNoteToExcel(note, elements.currentDetailPull);
    currentDetailNote = { ...currentDetailNote, inExcel: true };
    renderCurrentDetail(currentDetailNote, false);
  } finally {
    currentDetailPullingId = "";
    renderCurrentDetail(currentDetailNote, false);
  }
}

function setScanning(value) {
  scanning = value;
  elements.scanCurrent.disabled = value;
  elements.refreshAll.disabled = value;
  elements.deepScanCurrent.disabled = value;
  elements.scanTrack.classList.toggle("is-scanning", value);
  elements.scanButtonLabel.textContent = value ? "正在核对…" : "核对当前页面";
}

function setDeepScanning(value) {
  deepScanning = value;
  elements.scanCurrent.disabled = value;
  elements.refreshAll.disabled = value;
  elements.deepScanCurrent.disabled = false;
  elements.deepScanCurrent.classList.toggle("is-active", value);
  elements.deepScanButtonLabel.textContent = value ? "停止完整扫描" : "仅深读未判断帖子";
  elements.scanTrack.classList.toggle("is-scanning", value || scanning);
}

function renderBridgeState(state) {
  const status = state?.status || (state?.ok ? "online" : "offline");
  elements.bridgeStateDot.dataset.state = status;
  if (status === "online") elements.bridgeStateText.textContent = "本地 CSV 已就绪";
  else if (status === "connecting") elements.bridgeStateText.textContent = "正在连接本地 CSV";
  else if (status === "idle") elements.bridgeStateText.textContent = "等待连接本地 CSV";
  else elements.bridgeStateText.textContent = "本地 CSV 暂不可用";
  elements.bridgeVersion.textContent = status === "online" ? "数据已同步" : "正在准备数据";
}

function renderStats(stats) {
  const byStatus = stats?.byStatus || {};
  const scope = stats?.scope || {};
  const available = stats?.ok !== false && stats?.total !== null && stats?.total !== undefined;
  elements.newCount.textContent = available ? (visiblePendingCount ?? scope.excelMissing ?? ((byStatus.new || 0) + (byStatus.confirmed || 0))) : "—";
  elements.knownCount.textContent = available ? (scope.excelExisting ?? byStatus.known ?? 0) : "—";
  elements.ignoredCount.textContent = available ? (scope.ignored ?? byStatus.ignored ?? 0) : "—";
  elements.libraryTotal.textContent = available ? (scope.excelExisting ?? byStatus.known ?? 0) : "—";
  elements.inboxTotal.textContent = available ? (visiblePendingCount ?? scope.excelMissing ?? ((byStatus.new || 0) + (byStatus.confirmed || 0))) : "—";
  elements.recordTotal.textContent = available ? (scope.recordTotal ?? stats.total ?? 0) : "—";
}

function renderNegativeSummary(negative) {
  elements.negativeCount.textContent = negative?.ok ? String(negative.unresolved || 0) : "—";
}

function sourceLabel(source, fallback = "本地数据库") {
  return {
    existing_xlsx: "CSV 基准总表",
    dom: "浏览器扫描",
    manual_confirm: "已加入拉取"
  }[source] || fallback;
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

function noteUrl(note) {
  const stored = note.url || (note.noteId
    ? `https://www.xiaohongshu.com/discovery/item/${encodeURIComponent(note.noteId)}`
    : "#");
  return hasDesktopAccessToken(stored) ? stored : searchFallbackUrl(note);
}

function hasDesktopAccessToken(value) {
  try {
    const url = new URL(value);
    return Boolean(url.searchParams.get("xsec_token")) || url.hostname === "xhslink.com" || url.hostname.endsWith(".xhslink.com");
  } catch (_error) {
    return false;
  }
}

function searchFallbackUrl(note) {
  const keyword = String(note.title || note.noteId || "XHS-Monitor").trim();
  const base = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes`;
  const marker = new URLSearchParams({
    xhs_monitor_note_id: String(note.noteId || note.note_id || ""),
    xhs_monitor_title: keyword
  });
  return `${base}#${marker.toString()}`;
}

function navigationUrl(note, value) {
  const target = String(value || "");
  if (!target || !hasDesktopAccessToken(target)) return target;
  try {
    const url = new URL(target);
    url.hash = new URLSearchParams({
      xhs_monitor_note_id: String(note.noteId || note.note_id || ""),
      xhs_monitor_title: String(note.title || note.noteId || "XHS-Monitor")
    }).toString();
    return url.href;
  } catch (_error) {
    return target;
  }
}

async function openNoteInDesktop(note) {
  let liveUrl = "";
  try {
    const resolved = await sendToActiveTab({ type: "resolveNoteUrl", noteId: note.noteId || note.note_id || "" });
    liveUrl = resolved?.url || "";
  } catch (_error) {}
  const storedUrl = noteUrl(note);
  const targetUrl = navigationUrl(note, hasDesktopAccessToken(liveUrl)
    ? liveUrl
    : (hasDesktopAccessToken(storedUrl) ? storedUrl : searchFallbackUrl(note)));
  if (chrome.tabs?.create) {
    const options = { url: targetUrl };
    if (floatingMode && chrome.storage?.local?.get) {
      const state = await chrome.storage.local.get({ floatingOriginWindowId: null }).catch(() => ({}));
      const windowId = Number(state?.floatingOriginWindowId) || 0;
      if (windowId) options.windowId = windowId;
    }
    chrome.tabs.create(options);
  }
  else window.open(targetUrl, "_blank", "noopener,noreferrer");
}

function activateMetric(status = "") {
  const metrics = {
    new: elements.newMetric,
    known: elements.knownMetric,
    ignored: elements.ignoredMetric,
    negative: elements.negativeMetric
  };
  for (const [key, element] of Object.entries(metrics)) {
    element.classList.toggle("is-active", key === status);
  }
}

function renderNoteList(notes, options = {}) {
  elements.pendingList.replaceChildren();
  elements.pendingCount.textContent = String(options.total ?? notes.length);
  elements.pendingEmpty.hidden = notes.length > 0;
  elements.queueKicker.textContent = options.kicker || "NEW & RELEVANT";
  elements.queueTitle.textContent = options.title || "新相关未拉取";
  elements.queueHint.textContent = options.hint || "";
  elements.queueBack.hidden = options.back !== true;
  elements.queueMore.hidden = !options.more;
  if (options.more) elements.queueMore.textContent = `查看全部 ${options.total || notes.length} 篇 CSV 未找到帖子`;
  activateMetric(options.status || "");
  notes.forEach((note, index) => {
    const item = document.createElement("article");
    item.className = `pending-item ${options.negative ? "pending-item--negative" : ""}`;

    const number = document.createElement("span");
    number.className = "pending-index";
    number.textContent = String(index + 1).padStart(2, "0");

    const copy = document.createElement("span");
    copy.className = "pending-copy";
    const title = document.createElement("a");
    title.className = "note-title-link";
    title.href = navigationUrl(note, noteUrl(note));
    title.target = "_blank";
    title.rel = "noreferrer";
    title.textContent = note.title || "未命名帖子";
    title.addEventListener("click", (event) => {
      event.preventDefault();
      openNoteInDesktop(note).catch((error) => setStatus(error.message, "error"));
    });
    const meta = document.createElement("span");
    meta.textContent = [
      note.author,
      sourceLabel(note.source, options.sourceFallback),
      formatTime(note.firstSeenAt)
    ].filter(Boolean).join(" · ") || "本次发现";
    copy.append(title, meta);

    if (false && (note.riskLevel || note.risk_level || note.aiAnalysisStatus || note.ai_analysis_status)) {
      const badges = document.createElement("span");
      badges.className = "note-badges";
      const risk = note.riskLevel || note.risk_level;
      const sentiment = note.postSentiment || note.sentiment || note.post_sentiment;
      if (risk) badges.append(makeBadge(risk, `risk-${risk.toLowerCase()}`));
      if (sentiment) badges.append(makeBadge(sentimentLabel(sentiment), sentiment.includes("negative") ? "negative" : "neutral"));
      const confidence = Number(note.aiConfidence ?? note.ai_confidence) || 0;
      if (confidence) badges.append(makeBadge(`${Math.round(confidence * 100)}%`, "confidence"));
      copy.append(badges);
    }
    const actions = document.createElement("span");
    actions.className = "note-actions";
    actions.hidden = true;
    actions.setAttribute("aria-hidden", "true");
    const noteId = note.noteId || note.note_id;
    const pullActions = document.createElement("span");
    pullActions.className = "note-actions pull-actions";
    pullActions.hidden = true;
    pullActions.setAttribute("aria-hidden", "true");
    if ((note.status || options.status || "") === "new") {
      pullActions.hidden = false;
      pullActions.removeAttribute?.("aria-hidden");
      pullActions.append(actionButton("拉取到 CSV", async (button) => pullNoteToExcel(note, button)));
    } else if (options.status === "known" && ["partial", "failed"].includes(note.pullStatus)) {
      pullActions.hidden = false;
      pullActions.removeAttribute?.("aria-hidden");
      pullActions.append(actionButton("补采评论", async (button) => pullNoteToExcel(note, button)));
    }
    if (options.status === "known" || note.inExcel || ["synced", "partial"].includes(note.pullStatus)) {
      pullActions.hidden = false;
      pullActions.removeAttribute?.("aria-hidden");
      pullActions.append(actionButton("删除", async (button) => deleteLocalNote({ ...note, noteId }, button)));
    }
    if ((note.target_type || "note") === "note") {
      actions.append(
        actionButton("读评论", async () => {
          setStatus(`正在后台读取“${note.title || "该帖子"}”的可见评论…`);
          const result = await sendRuntime({ type: "collectComments", note: { ...note, noteId, url: noteUrl(note) } });
          if (!result?.ok) throw new Error(result?.error || "评论读取失败");
          setStatus(`评论读取完成：新增 ${result.newCount || 0} 条，累计 ${result.collectedCount || 0} 条；状态 ${result.status}`, result.status === "likely_complete" ? "success" : "warning");
          await refreshAll({ quiet: true });
        })
      );
      if ((note.status || options.status || "") === "new") actions.append(
        actionButton("拉取到 CSV", async (button) => pullNoteToExcel(note, button)),
        actionButton("忽略", async () => {
          const result = await sendRuntime({ type: "ignoreNote", note: { ...note, noteId, url: noteUrl(note) } });
          if (!result?.ok) throw new Error(result?.error || "忽略失败");
          setStatus("已忽略；该帖子不再参与批量同步", "success");
          await Promise.all([refreshStats(), refreshPending()]);
        })
      );
      if ((note.status || "") === "ignored") actions.append(actionButton("恢复", async () => {
        const result = await sendRuntime({ type: "restoreNote", note: { noteId } });
        if (!result?.ok) throw new Error(result?.error || "恢复失败");
        await showStatusView("ignored");
      }));
    }
    if (options.negative) {
      actions.append(
        actionButton("确认负面", () => reviewItem(note, "pending_action", "", true)),
        actionButton("处理中", () => reviewItem(note, "in_progress")),
        actionButton("误判", () => reviewItem(note, "false_positive")),
        actionButton("已解决", () => reviewItem(note, "resolved")),
        actionButton("无需处理", () => reviewItem(note, "no_action_needed")),
        actionButton("备注", async () => {
          const localNote = prompt("输入本地处理备注", note.review_note || "");
          if (localNote === null) return;
          await reviewItem(note, note.review_status || "pending_review", localNote);
        })
      );
    }
    item.append(number, copy, actions, pullActions);
    elements.pendingList.append(item);
  });
}

function makeBadge(label, className) {
  const badge = document.createElement("em");
  badge.className = `note-badge note-badge--${className}`;
  badge.textContent = label;
  return badge;
}

function sentimentLabel(value) {
  return { negative: "负面", light_negative: "轻度负面", neutral: "中立", positive: "正面", uncertain: "不确定", irrelevant: "无关", spam: "垃圾" }[value] || value;
}

function actionButton(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "note-action";
  button.textContent = label;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await handler(button); } catch (error) { setStatus(error.message, "error"); }
    finally { button.disabled = false; }
  });
  return button;
}

async function pullNoteToExcel(note, button) {
  const noteId = note.noteId || note.note_id;
  if (!noteId) throw new Error("缺少帖子 ID，无法拉取");
  if (activePulls.has(noteId)) return;
  activePulls.add(noteId);
  const originalLabel = button?.textContent || "拉取到 CSV";
  if (button) button.textContent = "读取正文…";
  setStatus(`正在拉取“${note.title || "该帖子"}”：读取完整正文…`);
  try {
    const result = await sendRuntime({
      type: "pullNote",
      note: { ...note, noteId, url: noteUrl(note), showProcess: true, process: true }
    });
    if (!result?.ok) throw new Error(result?.error || "拉取失败");
    const partial = result.pullStatus === "partial"
      || result.commentStatus === "partial"
      || result.commentStatus === "failed"
      || (result.mediaStatus && result.mediaStatus !== "complete");
    const partialReasons = [
      result.commentStatus === "partial" || result.commentStatus === "failed" ? "评论" : "",
      result.mediaStatus && result.mediaStatus !== "complete" ? "图片" : ""
    ].filter(Boolean).join("和") || "部分内容";
    setStatus(
      partial
        ? `已写入 CSV：正文完成，${partialReasons}读取不完整，可稍后重试`
        : `已写入 CSV：正文 + ${result.commentCount || 0} 条评论；该帖子现在归入“CSV 已有”`,
      partial ? "warning" : "success"
    );
    await Promise.all([refreshStats(), refreshPending(), loadPageInfo()]);
    if (queueView.type === "status" && queueView.status === "known") {
      await showStatusView("known");
      setStatus(
        partial ? `已写入 CSV，但${partialReasons}仍未完整采集` : "评论补采完成，已更新 CSV",
        partial ? "warning" : "success"
      );
    }
  } finally {
    activePulls.delete(noteId);
    if (button) button.textContent = originalLabel;
  }
}

async function reviewItem(item, reviewStatus, localNote = "", manualNegative = false) {
  const result = await sendRuntime({ type: "updateReview", payload: {
    targetType: item.target_type || "note",
    targetId: item.target_id || item.noteId || item.note_id,
    reviewStatus,
    note: localNote,
    manualNegative
  }});
  if (!result?.ok) throw new Error(result?.error || "复核状态更新失败");
  await showNegativeView(item.target_type === "comment" ? "comment" : "note");
}

function showPendingQueue(showAll = false, options = {}) {
  if (!options.preservePanelView) setPanelView("posts", { scroll: false });
  elements.negativeTabs.hidden = true;
  elements.negativeFilters.hidden = true;
  queueView = { type: "pending", status: "new", showAll };
  const view = STATUS_VIEWS.new;
  renderNoteList(showAll ? pendingNotes : pendingNotes.slice(0, 8), {
    ...view,
    status: "new",
    total: pendingNotes.length,
    back: false,
    more: !showAll && pendingNotes.length > 8,
    sourceFallback: "浏览器扫描"
  });
  if (!options.preserveScroll) elements.queueSection.scrollIntoView?.({ block: "start" });
}

async function showStatusView(status) {
  setPanelView("posts", { scroll: false });
  elements.negativeTabs.hidden = true;
  elements.negativeFilters.hidden = true;
  const view = STATUS_VIEWS[status];
  if (!view) return;
  queueView = { type: "status", status };
  setStatus(`正在读取“${view.title}”列表…`);
  const result = status === "new"
    ? { ok: true, notes: pendingNotes }
    : await sendRuntime({ type: "getNotes", status, limit: 1000 });
  if (!result?.ok) {
    setStatus(result?.error || "帖子列表读取失败", "error");
    return;
  }
  const notes = (result.notes || []).filter((note) => status !== "new" || note.source !== "existing_xlsx");
  renderNoteList(notes, { ...view, status, total: notes.length, back: false });
  setStatus(`共 ${notes.length} 篇，点击标题可打开小红书原帖`, "success");
  elements.queueSection.scrollIntoView?.({ block: "start" });
}

async function showAllPosts() {
  setPanelView("posts", { scroll: false });
  elements.negativeTabs.hidden = true;
  elements.negativeFilters.hidden = true;
  const result = await sendRuntime({ type: "getNotes", status: "", limit: 1000 });
  if (!result?.ok) throw new Error(result?.error || "帖子列表读取失败");
  queueView = { type: "all", status: "" };
  renderNoteList(result.notes || [], {
    title: "全部本地去重记录", kicker: "LOCAL RECORDS", hint: "包含 CSV 已有、新相关、待加入 CSV 与已忽略；以 CSV 基准表数字判断是否真正入表",
    total: (result.notes || []).length, back: true
  });
  elements.queueSection.scrollIntoView?.({ block: "start" });
}

function showScanResultView(notes) {
  setPanelView("posts", { scroll: false });
  const unique = [...new Map((notes || []).filter((note) => note?.noteId).map((note) => [note.noteId, note])).values()];
  queueView = { type: "scan", status: "" };
  renderNoteList(unique, {
    title: "本次确认相关",
    kicker: "SCAN RESULT",
    hint: "正文、标签或产品词确认与 XHS-Monitor 相关",
    total: unique.length,
    back: true,
    sourceFallback: "本次正文命中"
  });
  elements.queueSection.scrollIntoView?.({ block: "start" });
}

function renderPending(notes) {
  const unique = new Map();
  for (const note of (notes || [])) {
    if (note?.source === "existing_xlsx") continue;
    const key = String(note.noteId || note.note_id || note.url || "").trim();
    if (key && !unique.has(key)) unique.set(key, note);
  }
  const nextNotes = [...unique.values()];
  const nextSignature = JSON.stringify(nextNotes.map((note) => [
    note.noteId || note.note_id, note.title, note.author, note.status,
    note.pullStatus, note.inExcel, note.firstSeenAt
  ]));
  pendingNotes = nextNotes;
  visiblePendingCount = pendingNotes.length;
  elements.newCount.textContent = String(visiblePendingCount);
  if (elements.postsTabBadge) {
    elements.postsTabBadge.textContent = String(visiblePendingCount);
    elements.postsTabBadge.hidden = visiblePendingCount === 0;
  }
  if (nextSignature === pendingRenderSignature) return;
  pendingRenderSignature = nextSignature;
  if (queueView.type === "pending") showPendingQueue(Boolean(queueView.showAll), {
    preserveScroll: true,
    preservePanelView: true
  });
}

async function loadConfig() {
  const result = await sendRuntime({ type: "getConfig" });
  if (!result) return;
  elements.bridgeUrl.value = result.bridgeUrl || "http://127.0.0.1:17881";
  elements.keywords.value = (result.targetKeywords || ["品牌词"]).join(",");
  const ai = await sendRuntime({ type: "getAISettings" }).catch(() => null);
  if (ai?.ok) {
    elements.aiBaseUrl.value = ai.base_url || "https://api.deepseek.com";
    elements.aiModel.value = ai.model || "deepseek-v4-flash";
    elements.aiThinking.value = ai.thinking_mode || "disabled";
    elements.aiTemperature.value = ai.temperature ?? 0.1;
    elements.aiTimeout.value = ai.timeout_seconds ?? 45;
    elements.aiMaxTokens.value = ai.max_tokens ?? 1800;
    elements.aiBatchSize.value = ai.comment_batch_size ?? 15;
    elements.aiConcurrency.value = ai.max_concurrency ?? 1;
    elements.aiDailyLimit.value = ai.daily_call_limit ?? 300;
    elements.aiKey.placeholder = ai.configured ? "已安全配置；留空不覆盖" : "sk-…";
  }
}

async function loadPageInfo() {
  if (pageInfoRequest) return pageInfoRequest;
  pageInfoRequest = (async () => {
    try {
      const info = await sendToActiveTab({ type: "getPageInfo" });
      const label = info.keyword ? `“${info.keyword}”` : "小红书当前页";
      if (elements.pageKeyword.textContent !== label) elements.pageKeyword.textContent = label;
      elements.pageKeyword.title = label;
      const countLabel = `当前页面已加载 ${info.noteCount || 0} 篇帖子`;
      if (elements.pageCount.textContent !== countLabel) elements.pageCount.textContent = countLabel;
      await enrichCurrentDetail(info.currentDetail || null, Boolean(info.currentDetailLoading));
      return info;
    } catch (error) {
      elements.pageKeyword.textContent = "等待小红书页面";
      elements.pageKeyword.title = "";
      elements.pageCount.textContent = error.message;
      renderCurrentDetail(null, false);
      return null;
    }
  })();
  try { return await pageInfoRequest; }
  finally { pageInfoRequest = null; }
}

async function refreshStats() {
  const result = await sendRuntime({ type: "getStats" });
  renderStats(result);
  if (result?.ok) renderBridgeState({ ...result, status: "online" });
  return result;
}

async function refreshPending() {
  const [fresh, marked] = await Promise.all([
    sendRuntime({ type: "getPendingNotes", limit: 1000 }),
    sendRuntime({ type: "getNotes", status: "confirmed", limit: 1000 })
  ]);
  const notes = [...(fresh?.ok ? fresh.notes || [] : []), ...(marked?.ok ? marked.notes || [] : [])]
    .filter((note) => note.source !== "existing_xlsx");
  renderPending(notes);
  return { ok: Boolean(fresh?.ok && marked?.ok), notes };
}

async function refreshAll(options = {}) {
  if (refreshAllRequest) return refreshAllRequest;
  refreshAllRequest = (async () => {
    const [pageInfo, stats, pending] = await Promise.all([
      loadPageInfo(), refreshStats(), refreshPending(), refreshAI(), refreshUnreachableNotes().catch(() => null)
    ]);
    if (!options.quiet && stats?.ok) setStatus("CSV 对比结果已刷新", "success");
    if (!stats?.ok) {
      renderBridgeState({ status: "offline", error: stats?.error });
      if (!options.quiet) setStatus(`本地 CSV 暂不可用：${stats?.error || "请重新打开侧边栏"}`, "error");
    }
    return { pageInfo, stats, pending };
  })();
  try { return await refreshAllRequest; }
  finally { refreshAllRequest = null; }
}

async function refreshAI() {
  const negative = await sendRuntime({ type: "getNegativeSummary" }).catch(() => null);
  renderNegativeSummary(negative);
  return { negative };
}

async function showNegativeView(type = "note") {
  setPanelView("posts", { scroll: false });
  const suspected = type === "suspected";
  const result = await sendRuntime({
    type: "getNegativeItems",
    targetType: suspected ? "" : type,
    confidence: suspected ? "medium" : "high",
    limit: 500
  });
  if (!result?.ok) throw new Error(result?.error || "差评列表读取失败");
  let items = (result.items || []).map((item) => ({
    ...item,
    noteId: item.note_id,
    title: item.target_type === "comment" ? (item.content || "未命名评论") : (item.title || "未命名帖子"),
    author: item.author || "",
    url: item.target_type === "comment" ? (item.comment_url || item.post_url || "") : item.url,
    firstSeenAt: item.first_seen_at,
    aiConfidence: item.ai_confidence,
    riskLevel: item.risk_level
  }));
  const filters = {
    keyword: elements.negativeKeyword.value.trim().toLocaleLowerCase(),
    firstSeen: elements.negativeFirstSeen.value,
    published: elements.negativePublished.value,
    risk: elements.negativeRisk.value,
    category: elements.negativeCategory.value.trim().toLocaleLowerCase(),
    business: elements.negativeBusinessStatus.value,
    ai: elements.negativeAIStatus.value,
    review: elements.negativeReviewStatus.value,
    source: elements.negativeSourceKeyword.value.trim().toLocaleLowerCase()
  };
  items = items.filter((item) => {
    let payload = {};
    try { payload = JSON.parse(item.payload_json || "{}"); } catch (_error) {}
    const corpus = [item.title, item.content, item.author, item.ai_summary].join(" ").toLocaleLowerCase();
    const published = String(item.published_at || payload.publishedAt || payload.publishTime || "").slice(0, 10);
    return (!filters.keyword || corpus.includes(filters.keyword))
      && (!filters.firstSeen || String(item.first_seen_at || "").slice(0, 10) >= filters.firstSeen)
      && (!filters.published || (published && published >= filters.published))
      && (!filters.risk || item.risk_level === filters.risk)
      && (!filters.category || String(item.issue_categories || "").toLocaleLowerCase().includes(filters.category))
      && (!filters.business || item.status === filters.business)
      && (!filters.ai || item.ai_analysis_status === filters.ai)
      && (!filters.review || item.review_status === filters.review)
      && (!filters.source || String(item.keyword || "").toLocaleLowerCase().includes(filters.source));
  });
  elements.negativeTabs.hidden = false;
  elements.negativeFilters.hidden = false;
  elements.negativeTabs.querySelectorAll("button").forEach((button) => button.classList.toggle("is-active", button.dataset.negativeType === type));
  queueView = { type: "negative", status: "negative", negativeType: type };
  renderNoteList(items, {
    negative: true,
    title: suspected ? "待人工确认" : (type === "comment" ? "负面评论" : "负面帖子"),
    kicker: "NEGATIVE INTELLIGENCE",
    hint: suspected ? "AI 置信度 60%–84%，需要人工判断" : "AI 高置信度或人工确认的负面内容",
    total: items.length,
    back: true,
    status: "negative"
  });
  elements.queueSection.scrollIntoView?.({ block: "start" });
}

async function startBridgeOnPanelOpen() {
  renderBridgeState({ status: "connecting" });
  setStatus("正在准备本地 CSV…");
  const result = await sendRuntime({ type: "startBridge" });
  renderBridgeState(result);
  if (result?.ok) {
    const excel = await sendRuntime({ type: "reloadExcel" }).catch(() => null);
    setStatus(
      excel?.ok
        ? "本地 CSV 已准备好"
        : "本地 CSV 已连接",
      "success"
    );
  } else {
    setStatus(`本地 CSV 连接失败：${result?.error || "请重新打开侧边栏"}`, "error");
  }
  return result;
}

async function scanCurrentPage() {
  if (scanning || deepScanning) return null;
  let fastResult = null;
  setScanning(true);
  setScanStage("cards");
  setStatus("正在读取当前页面并与 CSV 核对…");
  try {
    const result = await sendToActiveTab({ type: "scanNow" });
    if (!result?.ok) throw new Error(result?.error || "扫描失败");
    fastResult = result;
    const scanned = result.scannedCount ?? result.notes?.length ?? 0;
    setStatus(`标题核对完成，共读取 ${scanned} 篇帖子`, "success");
    elements.lastScan.textContent = `刚刚 · 已读取 ${scanned} 篇`;
    await Promise.all([refreshStats(), refreshPending(), loadPageInfo()]);
    setScanStage("", ["cards", "details", "compare"]);
  } catch (error) {
    setStatus(error.message, "error");
    const state = await sendRuntime({ type: "getBridgeState" }).catch(() => null);
    if (state) renderBridgeState(state);
    return null;
  } finally {
    setScanning(false);
  }
  if (!fastResult) return null;
  return fastResult;
}

async function deepScanCurrentPage(options = {}) {
  if (deepScanning) {
    await sendRuntime({ type: "cancelDeepScan" }).catch(() => {});
    setStatus("正在停止文案补全…", "warning");
    return null;
  }
  if (scanning) return null;
  setDeepScanning(true);
  setScanStage("details", ["cards"]);
  setStatus("正在核对正文与本地 CSV…");
  try {
    const result = await sendToActiveTab({ type: "deepScanNow" });
    if (!result?.ok) throw new Error(result?.error || "文案补全失败");
    const processed = result.deepScannedCount || 0;
    const failed = result.failedCount || 0;
    const remaining = result.remainingCount || 0;
    let message = result.cancelled
      ? `已停止，本次读取 ${processed} 篇`
      : `核对完成，本次读取 ${processed} 篇`;
    if (failed || remaining) message += `；${failed + remaining} 篇暂未读完，可再次核对`;
    if (result.warning) message += `；${result.warning}`;
    setStatus(message, result.cancelled || failed || remaining || result.warning ? "warning" : "success");
    elements.lastScan.textContent = `刚刚 · 已核对 ${processed} 篇正文`;
    await Promise.all([refreshStats(), refreshPending(), loadPageInfo()]);
    setScanStage("", ["cards", "details", "compare"]);
    return result;
  } catch (error) {
    setStatus(error.message, "error");
    setScanStage("details", ["cards"]);
    return null;
  } finally {
    setDeepScanning(false);
  }
}

elements.saveConfig.addEventListener("click", async () => {
  elements.saveConfig.disabled = true;
  try {
    const targetKeywords = elements.keywords.value
      .split(/[,，]/)
      .map((value) => value.trim().toLocaleLowerCase())
      .filter(Boolean);
    const result = await sendRuntime({
      type: "setConfig",
      config: { bridgeUrl: elements.bridgeUrl.value.trim(), targetKeywords, enabled: true }
    });
    if (!result?.ok) throw new Error(result?.error || "保存失败");
    setStatus("设置已保存；下次扫描立即生效", "success");
    await refreshAll({ quiet: true });
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    elements.saveConfig.disabled = false;
  }
});

elements.scanCurrent.addEventListener("click", scanCurrentPage);
elements.deepScanCurrent.addEventListener("click", () => deepScanCurrentPage());
elements.syncAllPulled?.addEventListener("click", () => {
  startAllPulledSync().catch((error) => setStatus(error.message || "批量同步启动失败", "error"));
});

elements.overviewTab?.addEventListener("click", () => setPanelView("overview"));
elements.postsTab?.addEventListener("click", () => setPanelView("posts"));
elements.toolsTab?.addEventListener("click", () => {
  setPanelView("tools");
  refreshOperations().catch((error) => setStatus(error.message || "运营数据刷新失败", "error"));
});
elements.cancelBatchSync?.addEventListener("click", () => {
  cancelAllPulledSync().catch((error) => setStatus(error.message || "停止同步失败", "error"));
});
elements.retryBatchFailures?.addEventListener("click", () => {
  retryFailedPulledSync().catch((error) => setStatus(error.message || "失败项重试失败", "error"));
});
elements.ignoreAllBatchFailures?.addEventListener("click", () => {
  const items = (batchSyncViewState.failures || []).filter((item) => item?.noteId);
  ignoreBatchFailureItems(items, true).catch((error) => setStatus(error.message || "一键忽略失败", "error"));
});
elements.deleteUnreachable?.addEventListener("click", () => {
  deleteAllUnreachableNotes().catch((error) => setStatus(error.message || "批量删除失败", "error"));
});
elements.currentDetailPull?.addEventListener("click", () => {
  pullCurrentDetail().catch((error) => setStatus(error.message || "当前帖子拉取失败", "error"));
});
elements.currentDetailSummary?.addEventListener("click", () => {
  openCurrentNoteSummary(true).catch((error) => setStatus(error.message || "AI 总结失败", "error"));
});
elements.currentDetailComments?.addEventListener("click", () => {
  openCommentsPage().catch((error) => setStatus(error.message || "评论区读取失败", "error"));
});
elements.currentDetailWatch?.addEventListener("click", () => {
  toggleCurrentWatch().catch((error) => {
    renderCurrentDetail(currentDetailNote, false);
    setStatus(error.message || "观察名单更新失败", "error");
  });
});
elements.commentsBack?.addEventListener("click", closeCommentsPage);
elements.commentsReload?.addEventListener("click", () => openCommentsPage().catch(() => {}));
document.querySelectorAll(".persona-switch button[data-persona]").forEach((button) => {
  button.addEventListener("click", () => setCommentPersona(button.dataset.persona));
});
elements.summaryBack?.addEventListener("click", closeSummaryPage);
elements.summaryRerun?.addEventListener("click", () => {
  openCurrentNoteSummary(true).catch((error) => setStatus(error.message || "AI 总结失败", "error"));
});
elements.currentDetailAnalyze?.addEventListener("click", () => {
  analyzeCurrentDetailRelevance().catch((error) => setStatus(error.message || "AI 判断失败", "error"));
});
elements.currentDetailRefresh?.addEventListener("click", () => {
  loadPageInfo().then((info) => {
    if (info?.currentDetail) setStatus("当前详情已重新读取", "success");
  }).catch((error) => setStatus(error.message || "详情刷新失败", "error"));
});
elements.currentDetailDelete?.addEventListener("click", () => {
  deleteLocalNote(currentDetailNote, elements.currentDetailDelete)
    .catch((error) => setStatus(error.message || "删除失败", "error"));
});
elements.refreshOperations?.addEventListener("click", () => {
  refreshOperations().catch((error) => setStatus(error.message || "运营数据刷新失败", "error"));
});
elements.runHealthCheck?.addEventListener("click", async () => {
  elements.runHealthCheck.disabled = true;
  elements.runHealthCheck.textContent = "体检中…";
  try {
    const result = await refreshHealth();
    if (!result?.ok) throw new Error(result?.error || "数据体检失败");
    setStatus(`数据体检完成 · 健康度 ${result.score}`, result.status === "critical" ? "error" : result.status === "warning" ? "warning" : "success");
  } catch (error) { setStatus(error.message || "数据体检失败", "error"); }
  finally { elements.runHealthCheck.disabled = false; elements.runHealthCheck.textContent = "运行体检"; }
});
elements.repairHealth?.addEventListener("click", async () => {
  elements.repairHealth.disabled = true;
  elements.repairHealth.textContent = "修复中…";
  try {
    const result = await sendRuntime({ type: "repairDataHealth" });
    if (!result?.ok) throw new Error(result?.error || "安全修复失败");
    renderDataHealth(result.health);
    const message = result.actions?.length ? result.actions.join("；") : "未发现需要自动修复的项目";
    setStatus(message, result.warnings?.length ? "warning" : "success");
    showToast("数据安全修复完成");
  } catch (error) { setStatus(error.message || "安全修复失败", "error"); }
  finally { elements.repairHealth.textContent = "安全修复"; if (operationsState.health) renderDataHealth(operationsState.health); }
});
elements.refreshChanges?.addEventListener("click", () => refreshChanges().catch(() => {}));
elements.acknowledgeChanges?.addEventListener("click", async () => {
  elements.acknowledgeChanges.disabled = true;
  try {
    const result = await sendRuntime({ type: "acknowledgeChangeEvents", all: true });
    if (!result?.ok) throw new Error(result?.error || "标记失败");
    await refreshChanges();
    showToast(`已将 ${result.updated || 0} 条变化标记为已读`);
  } catch (error) { setStatus(error.message || "标记失败", "error"); }
});
elements.refreshWatchlist?.addEventListener("click", () => refreshWatchlist().catch(() => {}));
elements.generateWeeklyReport?.addEventListener("click", async () => {
  elements.generateWeeklyReport.disabled = true;
  elements.generateWeeklyReport.textContent = "正在生成…";
  try {
    const generated = await sendRuntime({
      type: "generateWeeklyReport",
      payload: { startDate: elements.weeklyStartDate.value, endDate: elements.weeklyEndDate.value }
    });
    if (!generated?.ok) throw new Error(generated?.error || "周报生成失败");
    await refreshWeeklyReport();
    setStatus("周报已生成，可打开网页版或 Excel", "success");
    showToast("ORIGANI 舆情周报生成完成");
  } catch (error) { setStatus(error.message || "周报生成失败", "error"); }
  finally { elements.generateWeeklyReport.disabled = false; elements.generateWeeklyReport.textContent = "生成周报"; }
});
elements.openWeeklyReport?.addEventListener("click", () => {
  sendRuntime({ type: "openWeeklyReport", target: "html" }).catch((error) => setStatus(error.message || "周报打开失败", "error"));
});
elements.openWeeklyExcel?.addEventListener("click", () => {
  sendRuntime({ type: "openWeeklyReport", target: "excel" }).catch((error) => setStatus(error.message || "周报 Excel 打开失败", "error"));
});
elements.toggleFloating?.addEventListener("click", () => toggleFloatingWindow());
elements.openSettings.addEventListener("click", () => {
  const shouldOpen = elements.settingsPanel.hidden;
  elements.settingsPanel.hidden = !shouldOpen;
  elements.settingsPanel.open = shouldOpen;
  elements.openSettings.setAttribute("aria-expanded", String(shouldOpen));
  if (shouldOpen) elements.settingsPanel.scrollIntoView?.({ block: "start", behavior: "smooth" });
});
elements.newMetric.addEventListener("click", () => showStatusView("new"));
elements.knownMetric.addEventListener("click", () => showStatusView("known"));
elements.ignoredMetric.addEventListener("click", () => showStatusView("ignored"));
elements.negativeMetric.addEventListener("click", () => showNegativeView("note").catch((error) => setStatus(error.message, "error")));
elements.negativeTabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-negative-type]");
  if (button) showNegativeView(button.dataset.negativeType).catch((error) => setStatus(error.message, "error"));
});
elements.applyNegativeFilters.addEventListener("click", () => {
  showNegativeView(queueView.negativeType || "note").catch((error) => setStatus(error.message, "error"));
});
elements.allPosts.addEventListener("click", () => showAllPosts().catch((error) => setStatus(error.message, "error")));
elements.ignoredPosts.addEventListener("click", () => showStatusView("ignored").catch((error) => setStatus(error.message, "error")));
elements.queueMore.addEventListener("click", () => showPendingQueue(true));
elements.queueBack.addEventListener("click", () => showPendingQueue(false));
elements.refreshAll.addEventListener("click", async () => {
  elements.refreshAll.disabled = true;
  try {
    await sendRuntime({ type: "reloadExcel" }).catch(() => null);
    await refreshAll();
  } finally {
    elements.refreshAll.disabled = false;
  }
});

function aiSettingsPayload(includeKey = true) {
  const payload = {
    base_url: elements.aiBaseUrl.value.trim(),
    model: elements.aiModel.value.trim(),
    thinking_mode: elements.aiThinking.value,
    temperature: Number(elements.aiTemperature.value),
    timeout_seconds: Number(elements.aiTimeout.value),
    max_tokens: Number(elements.aiMaxTokens.value),
    comment_batch_size: Number(elements.aiBatchSize.value),
    daily_call_limit: Number(elements.aiDailyLimit.value),
    max_concurrency: Number(elements.aiConcurrency.value),
    auto_analyze_posts: false,
    auto_analyze_comments: false
  };
  if (includeKey && elements.aiKey.value.trim()) payload.api_key = elements.aiKey.value.trim();
  return payload;
}

elements.saveAI.addEventListener("click", async () => {
  elements.saveAI.disabled = true;
  try {
    const result = await sendRuntime({ type: "saveAISettings", settings: aiSettingsPayload(true) });
    if (!result?.ok) throw new Error(result?.error || "AI 设置保存失败");
    elements.aiKey.value = "";
    elements.aiKey.placeholder = result.configured ? "已安全配置；留空不覆盖" : "sk-…";
    setStatus("AI 设置已保存到本机 Bridge", "success");
    await refreshAI();
  } catch (error) { setStatus(error.message, "error"); }
  finally { elements.saveAI.disabled = false; }
});

elements.testAI.addEventListener("click", async () => {
  elements.testAI.disabled = true;
  setStatus("正在测试 DeepSeek 连接…");
  try {
    const result = await sendRuntime({ type: "testAIConnection", settings: aiSettingsPayload(true) });
    if (!result?.ok) throw new Error(result?.error || "连接测试失败");
    elements.aiKey.value = "";
    setStatus(`DeepSeek 连接正常 · ${result.model || "当前模型"}`, "success");
    showToast(`AI 连接成功 · ${result.model || "当前模型"}`);
    await refreshAI();
  } catch (error) { setStatus(error.message, "error"); }
  finally { elements.testAI.disabled = false; }
});

elements.clearAIHistory.addEventListener("click", async () => {
  if (!confirm("确定清空 AI 分析历史吗？当前帖子和评论上的最新分析结果会保留。")) return;
  const result = await sendRuntime({ type: "clearAIHistory" });
  if (!result?.ok) return setStatus(result?.error || "清空失败", "error");
  setStatus(`已清空 ${result.deleted || 0} 条 AI 历史记录`, "success");
});

document.addEventListener("visibilitychange", () => {
  if (ballMode) return;
  if (document.visibilityState === "visible" && !scanning && !deepScanning) refreshAll({ quiet: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "localNoteStateChanged") {
    if (message.noteId && currentDetailNote?.noteId === message.noteId) {
      currentDetailNote = message.deleted
        ? { ...currentDetailNote, inExcel: false, pullStatus: "not_started", status: "new" }
        : { ...currentDetailNote, inExcel: true, pullStatus: message.pullStatus || "synced", status: "known" };
      if (!ballMode) renderCurrentDetail(currentDetailNote, false);
    }
    if (!ballMode) Promise.all([refreshStats(), refreshPending(), loadPageInfo()]).catch(() => {});
    return false;
  }
  if (ballMode) {
    if (message.type === "batchCommentSyncProgress") updateCompactFloatingState(message);
    return false;
  }
  if (message.type === "batchCommentSyncProgress") {
    renderBatchSync(message, Boolean(message.done));
    if (message.phase === "failed-note") refreshUnreachableNotes().catch(() => {});
    if (message.done) Promise.all([
      refreshStats(), refreshPending(), loadPageInfo(), refreshUnreachableNotes(),
      refreshChanges(), refreshWatchlist(), refreshWeeklyReport()
    ]).catch(() => {});
    return false;
  }
  if (message.type === "currentDetailChanged") {
    enrichCurrentDetail(message.currentDetail || null, Boolean(message.currentDetailLoading)).catch(() => {});
    return false;
  }
  if (message.type === "pullProgress") {
    const phaseText = {
      open: "正在点击帖子并打开详情",
      body: "正在读取正文与帖子字段",
      media: "正在提取素材图片",
      resolve: "准备打开帖子",
      detail: "正在读取完整正文",
      comments: "正在读取可见评论",
      excel: "正在写入本地 CSV",
      done: "拉取完成",
      failed: "拉取失败"
    }[message.phase] || "正在拉取";
    if (message.noteId && message.noteId === currentDetailNote?.noteId) {
      if (!message.done) {
        currentDetailPullingId = message.noteId;
        renderCurrentDetail(currentDetailNote, false);
        elements.currentDetailHint.textContent = `${phaseText}… Process 窗口正在详情右侧同步显示字段。`;
      } else {
        currentDetailPullingId = "";
        if (message.ok && message.mode === "relevance") {
          currentDetailNote = { ...currentDetailNote, relevanceStatus: message.relevanceStatus || "unknown",
            isRelevant: message.relevanceStatus === "relevant" };
        } else if (message.ok) currentDetailNote = { ...currentDetailNote, inExcel: true, pullStatus: "synced" };
        renderCurrentDetail(currentDetailNote, false);
      }
    }
    if (!message.done) setStatus(`${phaseText}…`, "idle");
    return false;
  }
  if (message.type === "commentCollectionProgress") {
    elements.commentJobCount.textContent = `评论任务 ${message.done ? 0 : 1}`;
    if (message.done) refreshAll({ quiet: true }).catch(() => {});
    return false;
  }
  if (message.type !== "deepScanProgress") return false;
  const wasPassive = !deepScanning;
  if (wasPassive && !message.done) setDeepScanning(true);
  const current = Number(message.current) || 0;
  const total = Number(message.total) || 0;
  const found = Number(message.found) || 0;
  setStatus(
    message.done ? "帖子核对完成" : `正在核对帖子 ${current}/${total}…`,
    message.cancelled ? "warning" : (message.done ? "success" : "idle")
  );
  if (message.done) {
    setDeepScanning(false);
    Promise.all([loadPageInfo(), refreshStats(), refreshPending()]).catch(() => {});
  }
  return false;
});

async function initSidePanel() {
  setPanelView("overview", { scroll: false });
  setDefaultReportDates();
  await loadConfig();
  const pageInfo = await loadPageInfo();
  const bridge = await startBridgeOnPanelOpen();
  const [, , batchState, unreachableState] = await Promise.all([
    refreshStats(),
    refreshPending(),
    sendRuntime({ type: "getBatchCommentSyncState" }).catch(() => null),
    sendRuntime({ type: "getUnreachableNotes" }).catch(() => null),
    refreshChanges().catch(() => null),
    refreshWatchlist().catch(() => null),
    refreshWeeklyReport().catch(() => null)
  ]);
  if (batchState) renderBatchSync(batchState);
  if (unreachableState) renderUnreachableNotes(unreachableState);
  // Search pages and recommendation/detail surfaces both expose note cards.
  // The latter used to stay unmarked because the old guard only looked at
  // isSearchPage, even though the current tab already had scannable cards.
  const pageBaseUrl = globalThis.location?.href || "https://www.xiaohongshu.com/";
  const isXhsPage = Boolean(pageInfo?.url)
    && /(^|\.)xiaohongshu\.com$/i.test(new URL(pageInfo.url, pageBaseUrl).hostname);
  if (bridge?.ok && (isXhsPage || pageInfo?.isSearchPage || Number(pageInfo?.noteCount) > 0)) {
    await scanCurrentPage();
  }
  const detailRefreshTimer = setInterval(() => {
    if (document.visibilityState === "visible" && !scanning && !deepScanning) {
      loadPageInfo().catch(() => {});
    }
  }, 12000);
  detailRefreshTimer?.unref?.();
}

let compactFloatingElements = null;

function updateCompactFloatingState(state = {}) {
  if (!compactFloatingElements) return;
  const running = Boolean(state.running);
  const failed = Math.max(0, Number(state.failedPosts) || 0);
  const current = Math.max(0, Number(state.current) || 0);
  const total = Math.max(0, Number(state.total) || 0);
  compactFloatingElements.widget.dataset.state = running ? "running" : (failed ? "warning" : "idle");
  compactFloatingElements.title.textContent = running
    ? `正在同步 ${current}/${total || "?"}`
    : (state.done ? "同步已完成" : "舆情雷达");
  compactFloatingElements.detail.textContent = running
    ? (state.currentTitle || "正在准备下一篇帖子")
    : (failed ? `${failed} 篇失败 · 点击查看详情` : "点击展开完整面板");
  compactFloatingElements.badge.hidden = !failed;
  compactFloatingElements.badge.textContent = String(failed);
}

async function initBallWidget() {
  const widget = document.createElement("div");
  widget.className = "ball-widget";
  const ball = document.createElement("button");
  ball.type = "button";
  ball.className = "ball-widget__ball";
  ball.title = "点击展开完整悬浮窗；按住上下拖动调整位置";
  ball.innerHTML = `
    <span class="ball-widget__mark" aria-hidden="true">O</span>
    <span class="ball-widget__copy">
      <strong>舆情雷达</strong>
      <small>点击展开完整面板</small>
    </span>
    <span class="ball-widget__badge" hidden>0</span>
    <span class="ball-widget__arrow" aria-hidden="true">›</span>`;
  widget.append(ball);
  document.body.append(widget);
  compactFloatingElements = {
    widget,
    title: ball.querySelector("strong"),
    detail: ball.querySelector("small"),
    badge: ball.querySelector(".ball-widget__badge")
  };
  const initialState = await sendRuntime({ type: "getBatchCommentSyncState" }).catch(() => null);
  if (initialState) updateCompactFloatingState(initialState);

  let dragging = false;
  let moved = false;
  let startScreenY = 0;
  let startTop = 0;
  let lastSent = 0;
  ball.addEventListener("pointerdown", async (event) => {
    dragging = true;
    moved = false;
    startScreenY = event.screenY;
    try {
      const win = await chrome.windows.getCurrent();
      startTop = Number(win?.top) || 0;
    } catch (_error) { startTop = 0; }
    ball.setPointerCapture?.(event.pointerId);
  });
  ball.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const dy = event.screenY - startScreenY;
    if (!moved && Math.abs(dy) < 6) return;
    moved = true;
    const now = Date.now();
    if (now - lastSent < 80) return;
    lastSent = now;
    sendRuntime({ type: "updateBallPosition", top: startTop + dy }).catch(() => {});
  });
  ball.addEventListener("pointercancel", () => { dragging = false; });
  ball.addEventListener("pointerup", async () => {
    dragging = false;
    if (moved) return; // 拖动结束，不展开
    const result = await sendRuntime({ type: "expandBall" }).catch(() => null);
    if (result?.ok) window.close();
  });

  ball.dataset.active = "false";
}

if (ballMode) {
  initBallWidget().catch(() => {});
} else {
  initSidePanel().catch((error) => {
    renderBridgeState({ status: "error" });
    setStatus(error.message, "error");
  });
}
