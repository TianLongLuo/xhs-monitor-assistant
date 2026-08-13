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
  scanTrack: document.getElementById("scanTrack"),
  pageKeyword: document.getElementById("pageKeyword"),
  pageCount: document.getElementById("pageCount"),
  currentDetailCard: document.getElementById("currentDetailCard"),
  currentDetailTitle: document.getElementById("currentDetailTitle"),
  currentDetailState: document.getElementById("currentDetailState"),
  currentDetailMeta: document.getElementById("currentDetailMeta"),
  currentDetailPullStatus: document.getElementById("currentDetailPullStatus"),
  currentDetailRelevance: document.getElementById("currentDetailRelevance"),
  currentDetailAnalyze: document.getElementById("currentDetailAnalyze"),
  currentDetailPull: document.getElementById("currentDetailPull"),
  currentDetailRefresh: document.getElementById("currentDetailRefresh"),
  currentDetailDelete: document.getElementById("currentDetailDelete"),
  currentDetailHint: document.getElementById("currentDetailHint"),
  scanCurrent: document.getElementById("scanCurrent"),
  scanButtonLabel: document.getElementById("scanButtonLabel"),
  deepScanCurrent: document.getElementById("deepScanCurrent"),
  deepScanButtonLabel: document.getElementById("deepScanButtonLabel"),
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
  aiStateDot: document.getElementById("aiStateDot"),
  aiStateText: document.getElementById("aiStateText"),
  aiProgressBlock: document.getElementById("aiProgressBlock"),
  aiProgressLabel: document.getElementById("aiProgressLabel"),
  aiProgressPercent: document.getElementById("aiProgressPercent"),
  aiProgressBar: document.getElementById("aiProgressBar"),
  aiQueueCount: document.getElementById("aiQueueCount"),
  commentJobCount: document.getElementById("commentJobCount"),
  aiActivity: document.getElementById("aiActivity"),
  aiActivitySummary: document.getElementById("aiActivitySummary"),
  aiJobList: document.getElementById("aiJobList"),
  aiJobEmpty: document.getElementById("aiJobEmpty"),
  closeAIActivity: document.getElementById("closeAIActivity"),
  queueSection: document.getElementById("queueSection"),
  queueBack: document.getElementById("queueBack"),
  queueKicker: document.getElementById("queueKicker"),
  queueTitle: document.getElementById("queueTitle"),
  queueHint: document.getElementById("queueHint"),
  queueMore: document.getElementById("queueMore"),
  pendingCount: document.getElementById("pendingCount"),
  pendingList: document.getElementById("pendingList"),
  pendingEmpty: document.getElementById("pendingEmpty"),
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
  autoAnalyzePosts: document.getElementById("autoAnalyzePosts"),
  autoAnalyzeComments: document.getElementById("autoAnalyzeComments"),
  testAI: document.getElementById("testAI"),
  saveAI: document.getElementById("saveAI"),
  clearAIHistory: document.getElementById("clearAIHistory"),
  lastScan: document.getElementById("lastScan")
};

let scanning = false;
let deepScanning = false;
let pendingNotes = [];
let visiblePendingCount = null;
let queueView = { type: "pending", status: "new" };
const activePulls = new Set();
// 拉取成功后自动入队 AI 分析，这里记录等待 AI 完成弹窗的帖子
const aiWatchTargets = new Map(); // noteId -> { title, since }
let currentDetailNote = null;
let currentDetailPullingId = "";

if (floatingMode) {
  document.title = "XHS-Monitor 帖子核对 · 悬浮窗";
  elements.toggleFloating?.setAttribute("title", "恢复到侧边栏");
  elements.toggleFloating?.setAttribute("aria-label", "恢复到侧边栏");
} else if (ballMode) {
  document.title = "XHS-Monitor 悬浮球";
} else {
  elements.toggleFloating?.setAttribute("title", "缩小为悬浮窗");
  elements.toggleFloating?.setAttribute("aria-label", "缩小为悬浮窗");
}

const STATUS_VIEWS = {
  new: { title: "新相关未拉取", kicker: "NEW & RELEVANT", hint: "与 XHS-Monitor 品牌相关，但本地 Excel 中还没有" },
  known: { title: "Excel 已有", kicker: "IN LOCAL EXCEL", hint: "这些帖子已经存在于本地 Excel" },
  confirmed: { title: "待加入 Excel", kicker: "MARKED", hint: "已人工标记，但当前仍未写入 Excel" },
  ignored: { title: "已忽略帖子", kicker: "IGNORED", hint: "不再显示在 Excel 未找到列表中，可随时恢复" }
};

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
    return new Error("插件尚未注入当前页面，请刷新小红书页面后重试");
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
    setStatus("已缩小为悬浮球，点击屏幕右侧的小球可展开悬浮窗", "success");
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

// AI 任务进度估算（与 service-worker 保持一致：按状态+耗时估算）
function estimateJobPercent(job, now = Date.now()) {
  const status = job?.status || "queued";
  if (status === "completed" || status === "failed") return 100;
  const updated = Date.parse(job?.updated_at || "") || now;
  const elapsed = Math.max(0, now - updated);
  if (status === "queued") return Math.min(12, 3 + Math.floor(elapsed / 3000));
  return Math.min(95, Math.round(15 + (elapsed / 40000) * 80));
}

// 顶部流式进度条：优先展示拉取后追踪的帖子任务，其次展示任意活动任务
function updateAiProgress(jobs) {
  const block = elements.aiProgressBlock;
  if (!block) return;
  let job = null;
  if (aiWatchTargets.size) {
    const noteId = [...aiWatchTargets.keys()][0];
    job = jobs.find((item) => item.target_type === "note" && String(item.target_id) === noteId) || null;
  }
  if (!job) {
    job = jobs.find((item) => item.status === "analyzing")
      || jobs.find((item) => item.status === "queued")
      || null;
  }
  if (!job) {
    block.hidden = true;
    return;
  }
  const percent = estimateJobPercent(job);
  block.hidden = false;
  const label = {
    queued: "AI 排队中…",
    analyzing: "AI 分析中…",
    completed: "AI 分析写入完成",
    failed: "AI 分析失败"
  }[job.status] || "AI 处理中…";
  elements.aiProgressLabel.textContent = label;
  elements.aiProgressPercent.textContent = `${percent}%`;
  elements.aiProgressBar.style.width = `${percent}%`;
  elements.aiProgressBar.dataset.state = job.status === "failed" ? "error" : job.status === "completed" ? "done" : "active";
}

// 轮询检查拉取后自动入队的 AI 任务；完成/失败时弹窗提示
async function checkAIWatchTargets(ai = null) {
  const queueActive = (Number(ai?.queue?.queued) || 0) + (Number(ai?.queue?.analyzing) || 0) > 0;
  if (!aiWatchTargets.size && !queueActive) {
    updateAiProgress([]);
    return;
  }
  let jobs = [];
  try {
    const result = await sendRuntime({ type: "getAIJobs", limit: 100 }).catch(() => null);
    jobs = result?.ok ? (result.jobs || []) : [];
    for (const [noteId, watch] of [...aiWatchTargets]) {
      const job = jobs.find((item) => item.target_type === "note" && String(item.target_id) === noteId);
      if (job?.status === "completed") {
        aiWatchTargets.delete(noteId);
        showToast("AI 已经分析写入完成");
      } else if (job?.status === "failed") {
        aiWatchTargets.delete(noteId);
        showToast(`AI 分析失败：${job.last_error || "未知错误"}`, "error");
      } else if (Date.now() - watch.since > 5 * 60 * 1000) {
        aiWatchTargets.delete(noteId); // 超过 5 分钟仍未出结果，静默放弃轮询
      }
    }
  } catch { /* 轮询失败不影响主流程 */ }
  updateAiProgress(jobs);
}

function renderCurrentDetail(note = null, loading = false) {
  const card = elements.currentDetailCard;
  if (!card) return;
  const noteId = String(note?.noteId || note?.note_id || "").trim();
  currentDetailNote = noteId ? { ...note, noteId } : null;
  card.hidden = !currentDetailNote;
  if (!currentDetailNote) return;

  const active = currentDetailPullingId === noteId || activePulls.has(noteId);
  const contentLength = String(currentDetailNote.content || "").trim().length;
  const imageCount = Number(currentDetailNote.imageCount) || currentDetailNote.imageUrls?.length || 0;
  const state = active
    ? { label: "处理中", value: "processing" }
    : currentDetailNote.inExcel
      ? { label: "Excel 已有", value: "synced" }
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
    ? "Process 正在详情右侧运行：正文、素材图片、评论及 ID、Excel / SQLite。"
    : currentDetailNote.inExcel
      ? "本次已写入本地 Excel 与 SQLite；再次点击可补采正文、图片或评论。"
      : contentLength
        ? `已读正文 ${contentLength} 字 · ${imageCount} 张图片；点击“拉取到 Excel”开始完整采集。`
        : "详情已打开，点击后会等待正文加载，再读取正文、素材图片、评论及 ID。";

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
    : currentDetailNote.inExcel ? "再次拉取 / 补全" : "拉取到 Excel";
  elements.currentDetailRefresh.disabled = active;
  elements.currentDetailDelete.hidden = !pulled;
  elements.currentDetailDelete.disabled = active;
}

async function deleteLocalNote(note, button = null) {
  const noteId = note?.noteId || note?.note_id;
  if (!noteId) throw new Error("缺少帖子 ID，无法删除");
  const title = note.title || "该帖子";
  if (!confirm(`确定彻底删除“${title}”吗？\n\n将同时删除：\n• Excel 帖子整行及其全部评论行\n• SQLite 帖子、评论和分析记录\n• 对应素材目录\n\n此操作不可撤销。`)) return null;
  if (button) {
    button.disabled = true;
    button.textContent = "删除中…";
  }
  setStatus(`正在删除“${title}”的 Excel 行、数据库记录和素材目录…`, "warning");
  try {
    const result = await sendRuntime({ type: "deletePulledNote", noteId });
    if (!result?.ok) throw new Error(result?.error || "删除失败");
    if (currentDetailNote?.noteId === noteId) {
      currentDetailNote = { ...currentDetailNote, inExcel: false, pullStatus: "not_started" };
      renderCurrentDetail(currentDetailNote, false);
    }
    setStatus(
      `删除完成：Excel 删除 ${result.deletedNoteRows || 0} 条帖子、${result.deletedCommentRows || 0} 条评论${result.mediaDeleted ? "，素材目录已删除" : ""}`,
      "success"
    );
    await Promise.all([refreshStats(), refreshPending(), loadPageInfo()]);
    if (queueView.type === "status") await showStatusView(queueView.status || "known");
    return result;
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = "删除本地帖子";
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
    showToast(result.relevanceStatus === "irrelevant" ? "已判定不相关，并写入 Excel 不相关 Sheet" : result.relevanceStatus === "relevant" ? "已判定与品牌相关" : "证据不足，保持相关性未知");
    await refreshAll({ quiet: true });
  } catch (error) { showToast(error.message || "AI 判断失败", "error"); }
  finally { elements.currentDetailAnalyze.textContent = "AI 判断相关性"; elements.currentDetailAnalyze.disabled = false; }
}

async function enrichCurrentDetail(note, loading = false) {
  renderCurrentDetail(note, loading);
  if (!note?.noteId) return;
  const result = await sendRuntime({ type: "getNoteStatus", noteId: note.noteId }).catch(() => null);
  if (!result?.ok || currentDetailNote?.noteId !== note.noteId) return;
  renderCurrentDetail({ ...currentDetailNote, ...result }, loading);
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
  if (status === "online") elements.bridgeStateText.textContent = "本地 Excel 已就绪";
  else if (status === "connecting") elements.bridgeStateText.textContent = "正在连接本地 Excel";
  else if (status === "idle") elements.bridgeStateText.textContent = "等待连接本地 Excel";
  else elements.bridgeStateText.textContent = "本地 Excel 暂不可用";
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

function renderAIStatus(ai, negative) {
  const configured = Boolean(ai?.configured);
  elements.aiStateDot.dataset.state = configured ? "online" : "idle";
  elements.aiStateText.textContent = configured ? `DeepSeek · ${ai.model || "已配置"}` : "DeepSeek 未配置";
  const queue = (ai?.queue?.queued || 0) + (ai?.queue?.analyzing || 0);
  elements.aiQueueCount.textContent = `AI 队列 ${queue}`;
  elements.commentJobCount.textContent = `评论任务 ${Number(ai?.commentJobs) || 0}`;
  elements.negativeCount.textContent = negative?.ok ? String(negative.unresolved || 0) : "—";
}

function aiStatusLabel(status) {
  return { queued: "等待中", analyzing: "分析中", completed: "已完成", failed: "失败" }[status] || status || "未知";
}

function renderAIJobs(result) {
  const jobs = result?.ok ? (result.jobs || []) : [];
  elements.aiJobList.replaceChildren();
  elements.aiJobEmpty.hidden = jobs.length > 0;
  const active = jobs.filter((job) => ["queued", "analyzing"].includes(job.status)).length;
  const failed = jobs.filter((job) => job.status === "failed").length;
  elements.aiActivitySummary.textContent = active
    ? `${active} 个任务正在处理；完成后结果自动保存到本地数据库`
    : `当前无运行任务${failed ? `；${failed} 个任务失败，可展开查看原因` : "；下方为最近记录"}`;
  jobs.forEach((job) => {
    const detail = document.createElement("details");
    detail.className = "ai-job";
    const summary = document.createElement("summary");
    const line = document.createElement("span");
    line.className = "ai-job-line";
    const status = document.createElement("span");
    status.className = `ai-job-status ai-job-status--${job.status || "queued"}`;
    status.textContent = aiStatusLabel(job.status);
    const title = document.createElement("span");
    title.className = "ai-job-title";
    title.textContent = `${job.target_type === "comment" ? "评论" : "帖子"} · ${job.title || "未命名内容"}`;
    const time = document.createElement("span");
    time.className = "ai-job-time";
    time.textContent = `${formatTime(job.updated_at || job.created_at)} · ${estimateJobPercent(job)}%`;
    line.append(status, title, time);
    summary.append(line);
    const bar = document.createElement("div");
    bar.className = "ai-job-progress";
    const fill = document.createElement("i");
    fill.style.width = `${estimateJobPercent(job)}%`;
    fill.dataset.state = job.status || "queued";
    bar.append(fill);
    summary.append(bar);
    const body = document.createElement("div");
    body.className = "ai-job-detail";
    const stage = job.status === "queued" ? "步骤 1/3：已进入队列，等待本地 Worker 调用模型"
      : job.status === "analyzing" ? "步骤 2/3：正在调用模型并校验返回结果"
      : job.status === "completed" ? "步骤 3/3：分析结果已保存到本地数据库"
      : `处理失败：${job.last_error || "未知错误"}`;
    const stageLine = document.createElement("strong");
    stageLine.textContent = stage;
    body.append(stageLine);
    if (job.ai_summary) body.append(document.createElement("br"), document.createTextNode(`摘要：${job.ai_summary}`));
    if (job.ai_reason) body.append(document.createElement("br"), document.createTextNode(`依据：${job.ai_reason}`));
    if (job.sentiment) body.append(document.createElement("br"), document.createTextNode(`结论：${sentimentLabel(job.sentiment)} · ${job.risk_level || "P3"} · ${Math.round((Number(job.ai_confidence) || 0) * 100)}%`));
    if (job.url) {
      const link = document.createElement("a");
      link.href = job.url; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = "打开原内容 ↗";
      body.append(document.createElement("br"), link);
    }
    detail.append(summary, body);
    elements.aiJobList.append(detail);
  });
}

async function refreshAIJobs() {
  const result = await sendRuntime({ type: "getAIJobs", limit: 60 }).catch((error) => ({ ok: false, error: error.message, jobs: [] }));
  renderAIJobs(result);
  return result;
}

async function toggleAIActivity(show = elements.aiActivity.hidden) {
  elements.aiActivity.hidden = !show;
  elements.aiQueueCount.setAttribute("aria-expanded", String(show));
  if (show) await refreshAIJobs();
}

function sourceLabel(source, fallback = "本地数据库") {
  return {
    existing_xlsx: "Excel 初始总表",
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
  if (options.more) elements.queueMore.textContent = `查看全部 ${options.total || notes.length} 篇 Excel 未找到帖子`;
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
      pullActions.append(actionButton("拉取到 Excel", async (button) => pullNoteToExcel(note, button)));
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
        }),
        actionButton((note.aiAnalysisStatus || note.ai_analysis_status) === "completed" ? "重新分析" : "AI 分析", async () => {
          const result = await sendRuntime({ type: "analyzeTarget", targetType: "note", targetId: noteId, force: (note.aiAnalysisStatus || note.ai_analysis_status) === "completed" });
          if (!result?.ok) throw new Error(result?.error || "加入 AI 队列失败");
          setStatus("已加入帖子 AI 分析队列", "success");
          await refreshAI();
        })
      );
      if ((note.status || options.status || "") === "new") actions.append(
        actionButton("拉取到 Excel", async (button) => pullNoteToExcel(note, button)),
        actionButton("忽略", async () => {
          const result = await sendRuntime({ type: "ignoreNote", note: { ...note, noteId, url: noteUrl(note) } });
          if (!result?.ok) throw new Error(result?.error || "忽略失败");
          setStatus("已忽略；该帖子已移出“Excel 未找到”列表", "success");
          await Promise.all([refreshStats(), refreshPending()]);
        })
      );
      if ((note.status || "") === "ignored") actions.append(actionButton("恢复", async () => {
        const result = await sendRuntime({ type: "restoreNote", note: { noteId } });
        if (!result?.ok) throw new Error(result?.error || "恢复失败");
        await showStatusView("ignored");
      }));
    } else {
      actions.append(actionButton("重新分析", async () => {
        const result = await sendRuntime({ type: "analyzeTarget", targetType: "comment", targetId: note.target_id || note.comment_id, force: true });
        if (!result?.ok) throw new Error(result?.error || "加入 AI 队列失败");
        setStatus("已加入评论 AI 分析队列", "success");
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
  const originalLabel = button?.textContent || "拉取到 Excel";
  if (button) button.textContent = "读取正文…";
  setStatus(`正在拉取“${note.title || "该帖子"}”：读取完整正文…`);
  try {
    const result = await sendRuntime({
      type: "pullNote",
      note: { ...note, noteId, url: noteUrl(note), showProcess: true, process: true }
    });
    if (!result?.ok) throw new Error(result?.error || "拉取失败");
    // 每次拉取成功后自动调用 AI 分析并写回（完成后底部弹窗提示）
    sendRuntime({ type: "analyzeTarget", targetType: "note", targetId: noteId, force: true })
      .then((aiResult) => {
        if (aiResult?.ok) {
          aiWatchTargets.set(noteId, { title: note.title || "该帖子", since: Date.now() });
        } else if (aiResult?.error) {
          showToast(`AI 分析未入队：${aiResult.error}`, "error");
        }
      })
      .catch(() => {});
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
        ? `已写入 Excel：正文完成，${partialReasons}读取不完整，可稍后重试`
        : `已写入 Excel：正文 + ${result.commentCount || 0} 条评论；该帖子现在归入“Excel 已有”`,
      partial ? "warning" : "success"
    );
    await Promise.all([refreshStats(), refreshPending(), loadPageInfo()]);
    if (queueView.type === "status" && queueView.status === "known") {
      await showStatusView("known");
      setStatus(
        partial ? `已写入 Excel，但${partialReasons}仍未完整采集` : "评论补采完成，已更新 Excel",
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

function showPendingQueue(showAll = false) {
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
  elements.queueSection.scrollIntoView?.({ block: "start" });
}

async function showStatusView(status) {
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
  elements.negativeTabs.hidden = true;
  elements.negativeFilters.hidden = true;
  const result = await sendRuntime({ type: "getNotes", status: "", limit: 1000 });
  if (!result?.ok) throw new Error(result?.error || "帖子列表读取失败");
  queueView = { type: "all", status: "" };
  renderNoteList(result.notes || [], {
    title: "全部本地去重记录", kicker: "LOCAL RECORDS", hint: "包含 Excel 已有、新相关、待加入 Excel 与已忽略；以 Excel 基准表数字判断是否真正入表",
    total: (result.notes || []).length, back: true
  });
  elements.queueSection.scrollIntoView?.({ block: "start" });
}

function showScanResultView(notes) {
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
  pendingNotes = (notes || []).filter((note) => note.source !== "existing_xlsx");
  visiblePendingCount = pendingNotes.length;
  elements.newCount.textContent = String(visiblePendingCount);
  if (queueView.type === "pending") showPendingQueue(Boolean(queueView.showAll));
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
    elements.autoAnalyzePosts.checked = Boolean(ai.auto_analyze_posts);
    elements.autoAnalyzeComments.checked = Boolean(ai.auto_analyze_comments);
    elements.aiKey.placeholder = ai.configured ? "已安全配置；留空不覆盖" : "sk-…";
  }
}

async function loadPageInfo() {
  try {
    const info = await sendToActiveTab({ type: "getPageInfo" });
    const label = info.keyword ? `“${info.keyword}”` : "小红书当前页";
    elements.pageKeyword.textContent = label;
    elements.pageKeyword.title = label;
    elements.pageCount.textContent = `当前页面已加载 ${info.noteCount || 0} 篇帖子`;
    await enrichCurrentDetail(info.currentDetail || null, Boolean(info.currentDetailLoading));
    return info;
  } catch (error) {
    elements.pageKeyword.textContent = "等待小红书页面";
    elements.pageKeyword.title = "";
    elements.pageCount.textContent = error.message;
    renderCurrentDetail(null, false);
    return null;
  }
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
  const [pageInfo, stats, pending] = await Promise.all([
    loadPageInfo(), refreshStats(), refreshPending(), refreshAI()
  ]);
  if (!options.quiet && stats?.ok) setStatus("Excel 对比结果已刷新", "success");
  if (!stats?.ok) {
    renderBridgeState({ status: "offline", error: stats?.error });
    if (!options.quiet) setStatus(`本地 Excel 暂不可用：${stats?.error || "请重新打开侧边栏"}`, "error");
  }
  return { pageInfo, stats, pending };
}

async function refreshAI() {
  const [ai, negative] = await Promise.all([
    sendRuntime({ type: "getAIStatus" }).catch(() => null),
    sendRuntime({ type: "getNegativeSummary" }).catch(() => null)
  ]);
  renderAIStatus(ai, negative);
  if (!elements.aiActivity.hidden) await refreshAIJobs();
  await checkAIWatchTargets(ai);
  return { ai, negative };
}

async function showNegativeView(type = "note") {
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
  setStatus("正在准备本地 Excel…");
  const result = await sendRuntime({ type: "startBridge" });
  renderBridgeState(result);
  if (result?.ok) {
    const excel = await sendRuntime({ type: "reloadExcel" }).catch(() => null);
    setStatus(
      excel?.ok
        ? "本地 Excel 已准备好"
        : "本地 Excel 已连接",
      "success"
    );
  } else {
    setStatus(`本地 Excel 连接失败：${result?.error || "请重新打开侧边栏"}`, "error");
  }
  return result;
}

async function scanCurrentPage() {
  if (scanning || deepScanning) return null;
  let fastResult = null;
  setScanning(true);
  setScanStage("cards");
  setStatus("正在读取当前页面并与 Excel 核对…");
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
  setStatus("正在核对正文与本地 Excel…");
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
elements.currentDetailPull?.addEventListener("click", () => {
  pullCurrentDetail().catch((error) => setStatus(error.message || "当前帖子拉取失败", "error"));
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
elements.toggleFloating?.addEventListener("click", () => toggleFloatingWindow());
elements.openSettings.addEventListener("click", () => {
  const shouldOpen = elements.settingsPanel.hidden;
  elements.settingsPanel.hidden = !shouldOpen;
  elements.settingsPanel.open = shouldOpen;
  elements.openSettings.setAttribute("aria-expanded", String(shouldOpen));
  if (shouldOpen) elements.settingsPanel.scrollIntoView?.({ block: "start", behavior: "smooth" });
});
elements.aiQueueCount.addEventListener("click", () => toggleAIActivity().catch((error) => setStatus(error.message, "error")));
elements.closeAIActivity.addEventListener("click", () => toggleAIActivity(false));
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
    auto_analyze_posts: elements.autoAnalyzePosts.checked,
    auto_analyze_comments: elements.autoAnalyzeComments.checked
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
  if (ballMode) return false;
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
      excel: "正在写入本地 Excel",
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
  await loadConfig();
  const pageInfo = await loadPageInfo();
  const bridge = await startBridgeOnPanelOpen();
  await Promise.all([refreshStats(), refreshPending()]);
  // Search pages and recommendation/detail surfaces both expose note cards.
  // The latter used to stay unmarked because the old guard only looked at
  // isSearchPage, even though the current tab already had scannable cards.
  const pageBaseUrl = globalThis.location?.href || "https://www.xiaohongshu.com/";
  const isXhsPage = Boolean(pageInfo?.url)
    && /(^|\.)xiaohongshu\.com$/i.test(new URL(pageInfo.url, pageBaseUrl).hostname);
  if (bridge?.ok && (isXhsPage || pageInfo?.isSearchPage || Number(pageInfo?.noteCount) > 0)) {
    await scanCurrentPage();
  }
  const aiRefreshTimer = setInterval(() => {
    if (document.visibilityState === "visible") refreshAI().catch(() => {});
  }, 2500);
  aiRefreshTimer?.unref?.();
  const detailRefreshTimer = setInterval(() => {
    if (document.visibilityState === "visible" && !scanning && !deepScanning) {
      loadPageInfo().catch(() => {});
    }
  }, 5000);
  detailRefreshTimer?.unref?.();
}

async function initBallWidget() {
  const widget = document.createElement("div");
  widget.className = "ball-widget";
  const ball = document.createElement("button");
  ball.type = "button";
  ball.className = "ball-widget__ball";
  ball.title = "点击展开悬浮窗；按住上下拖动调整位置";
  ball.textContent = "O";
  widget.append(ball);
  document.body.append(widget);

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

  // AI 任务运行中小球呼吸闪烁
  const pollActivity = () => {
    sendRuntime({ type: "getAIStatus" }).then((ai) => {
      const active = (Number(ai?.queue?.queued) || 0) + (Number(ai?.queue?.analyzing) || 0) > 0;
      ball.dataset.active = active ? "true" : "false";
    }).catch(() => {});
  };
  pollActivity();
  setInterval(pollActivity, 4000);
}

if (ballMode) {
  initBallWidget().catch(() => {});
} else {
  initSidePanel().catch((error) => {
    renderBridgeState({ status: "error" });
    setStatus(error.message, "error");
  });
}
