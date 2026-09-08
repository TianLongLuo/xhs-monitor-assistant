importScripts("relevance.js", "sync-alerts.js");

const DEFAULT_CONFIG = {
  bridgeUrl: "http://127.0.0.1:17881",
  targetKeywords: ["品牌词"],
  enabled: true
};
const NATIVE_HOST_NAME = "com.xhsmonitor.bridge";
const REQUEST_TIMEOUT_MS = 6500;
const HEALTH_TIMEOUT_MS = 1800;
const DEEP_SCAN_LIMIT = 60;
const DETAIL_LOAD_TIMEOUT_MS = 18000;
const CONTENT_SCRIPT_FILES = ["relevance.js", "page-context.js", "note-utils.js", "detail-store.js", "location-utils.js", "comment-utils.js", "comment-collector.js", "process-layout.js", "comment-locator.js", "content.js"];
const CONTENT_SCRIPT_VERSION = "0.34.19";
const BATCH_COMMENT_SYNC_KEY = "batchCommentSyncState";
const SYNC_ALERT_PREFERENCES_KEY = "syncAlertPreferencesV1";
const syncAlerts = globalThis.XhsMonitorSyncAlerts;
const CONTENT_STYLE_FILES = ["content.css"];
const contentInjectionTasks = new Map();
// Share only in-flight reads. A write starts a new generation immediately and
// again when it settles, so a post-write refresh never joins a stale read.
const bridgeReadTasks = new Map();
let bridgeReadGeneration = 0;
let bridgeWritesInFlight = 0;

let nativeStartPromise = null;
let bridgeEnsurePromise = null;
let deepScanPromise = null;
let pageTaskPromise = null;
let deepScanCancelled = false;
let relevanceGroupsCache = null;
let relevanceGroupsFetchedAt = 0;
let readerTabId = null;
let readerCloseTimer = null;
let batchCommentSyncPromise = null;
let batchCommentSyncCancelled = false;
let syncAlertPreferences = null;
let syncAlertPreferencesLoad = null;
let syncAlertMutationTail = Promise.resolve();
let batchStatePersistTail = Promise.resolve();
let batchCommentSyncState = {
  ok: true, running: false, done: false, cancelled: false,
  total: 0, current: 0, currentNoteId: "", currentTitle: "",
  changedPosts: 0, unchangedPosts: 0, failedPosts: 0,
  accessiblePosts: 0, reviewPosts: 0, unreachablePosts: 0, processingFailedPosts: 0,
  statusSyncFailures: 0, ignoredReconciled: 0,
  newComments: 0, removedComments: 0, changedComments: 0,
  failures: [], mode: "all", phase: "idle", error: "", startedAt: "",
  updatedAt: "", finishedAt: ""
};
let bridgeState = {
  status: "idle",
  bridgeUrl: DEFAULT_CONFIG.bridgeUrl,
  error: "",
  lastCheckedAt: ""
};

const FLOATING_WINDOW_DEFAULTS = {
  floatingWindowId: null,
  floatingOriginWindowId: null,
  floatingWindowKind: "panel",
  floatingBallTop: 0,
  floatingBounds: { width: 400, height: 760 }
};
const FLOATING_DOCK_WIDTH = 292;
const FLOATING_DOCK_HEIGHT = 126;

// AI 任务进度估算（Bridge 无实时进度事件，按状态+耗时估算，用于流式进度条）
function estimateJobPercent(job, now = Date.now()) {
  const status = job?.status || "queued";
  if (status === "completed" || status === "failed") return 100;
  const updated = Date.parse(job?.updated_at || "") || now;
  const elapsed = Math.max(0, now - updated);
  if (status === "queued") return Math.min(12, 3 + Math.floor(elapsed / 3000));
  return Math.min(95, Math.round(15 + (elapsed / 40000) * 80));
}

function normalizeBridgeUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || DEFAULT_CONFIG.bridgeUrl));
  } catch (_error) {
    throw new Error("Bridge 地址格式不正确");
  }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("Bridge 只能使用本机 http://127.0.0.1 或 http://localhost 地址");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Bridge 地址只填写主机和端口，例如 http://127.0.0.1:17881");
  }
  return parsed.origin;
}

function normalizeKeywords(values) {
  const source = Array.isArray(values) ? values : [];
  return [...new Set(source
    .map((value) => String(value).trim().toLocaleLowerCase())
    .filter((value) => value && value.length <= 80))]
    .slice(0, 32);
}

function setBridgeState(status, values = {}) {
  bridgeState = {
    ...bridgeState,
    ...values,
    status,
    lastCheckedAt: new Date().toISOString()
  };
  return { ...bridgeState };
}

async function configureSidePanel() {
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
}

function numericWindowValue(value, minimum = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? Math.round(number) : null;
}

function normalizeFloatingBounds(value) {
  const source = value && typeof value === "object" ? value : {};
  const bounds = {};
  for (const key of ["left", "top", "width", "height"]) {
    const minimum = key === "width" ? 340 : (key === "height" ? 420 : -100000);
    const number = numericWindowValue(source[key], minimum);
    if (number !== null) bounds[key] = number;
  }
  if (!bounds.width) bounds.width = FLOATING_WINDOW_DEFAULTS.floatingBounds.width;
  if (!bounds.height) bounds.height = FLOATING_WINDOW_DEFAULTS.floatingBounds.height;
  return bounds;
}

async function currentWindow() {
  if (!chrome.windows?.getCurrent) return null;
  try {
    return await chrome.windows.getCurrent();
  } catch (_error) {
    return null;
  }
}

async function closeSidePanel(windowId) {
  if (!windowId || !chrome.sidePanel?.close) return false;
  try {
    await chrome.sidePanel.close({ windowId });
    return true;
  } catch (_error) {
    return false;
  }
}

async function openFloatingWindow() {
  if (!chrome.windows?.create) {
    return { ok: false, error: "当前 Chrome 不支持悬浮窗模式" };
  }
  const saved = await chrome.storage.local.get(FLOATING_WINDOW_DEFAULTS);
  const existingId = Number(saved.floatingWindowId) || 0;
  if (existingId && chrome.windows.update) {
    try {
      await chrome.windows.update(existingId, { focused: true, drawAttention: false });
      return { ok: true, reused: true, windowId: existingId };
    } catch (_error) {
      await chrome.storage.local.remove(["floatingWindowId", "floatingOriginWindowId"]);
    }
  }
  const origin = await currentWindow();
  const bounds = normalizeFloatingBounds(saved.floatingBounds);
  const popup = await chrome.windows.create({
    ...bounds,
    focused: true,
    type: "popup",
    url: chrome.runtime.getURL("sidepanel.html?mode=floating")
  });
  if (!popup?.id) return { ok: false, error: "悬浮窗创建失败" };
  await chrome.storage.local.set({
    floatingWindowId: popup.id,
    floatingWindowKind: "panel",
    floatingOriginWindowId: origin?.id || null
  });
  // Closing the panel is best-effort because sidePanel.close is not present
  // in older Chrome builds; the popup remains usable in either case.
  await closeSidePanel(origin?.id);
  return { ok: true, windowId: popup.id, originWindowId: origin?.id || null };
}

async function closeFloatingWindow() {
  const saved = await chrome.storage.local.get(FLOATING_WINDOW_DEFAULTS);
  const current = await currentWindow();
  const windowId = Number(saved.floatingWindowId) || current?.id || 0;
  await chrome.storage.local.remove(["floatingWindowId", "floatingWindowKind", "floatingOriginWindowId"]);
  if (windowId && chrome.windows?.remove) {
    try { await chrome.windows.remove(windowId); } catch (_error) {}
  }
  return { ok: true, closed: Boolean(windowId) };
}

async function restoreSidePanel() {
  const saved = await chrome.storage.local.get(FLOATING_WINDOW_DEFAULTS);
  const current = await currentWindow();
  const originWindowId = Number(saved.floatingOriginWindowId) || current?.id || 0;
  if (originWindowId && chrome.sidePanel?.open) {
    try {
      await chrome.sidePanel.open({ windowId: originWindowId });
    } catch (error) {
      return { ok: false, error: `恢复侧边栏失败：${error.message || "Chrome 未允许打开侧边栏"}` };
    }
  } else if (!originWindowId) {
    return { ok: false, error: "找不到原来的浏览器窗口，请从扩展工具栏重新打开侧边栏" };
  }
  return closeFloatingWindow();
}

// 缩小为右侧吸附的紧凑状态卡片
async function openBallWindow() {
  if (!chrome.windows?.create) {
    return { ok: false, error: "当前 Chrome 不支持快捷悬浮窗模式" };
  }
  const saved = await chrome.storage.local.get(FLOATING_WINDOW_DEFAULTS);
  const existingId = Number(saved.floatingWindowId) || 0;
  if (existingId && chrome.windows.remove) {
    try { await chrome.windows.remove(existingId); } catch (_error) {}
  }
  const origin = await currentWindow();
  const baseLeft = Number(origin?.left) || 0;
  const baseTop = Number(origin?.top) || 0;
  const baseWidth = Number(origin?.width) || 1280;
  const baseHeight = Number(origin?.height) || 800;
  const top = Number(saved.floatingBallTop) > 0
    ? Number(saved.floatingBallTop)
    : Math.round(baseTop + baseHeight * 0.3);
  const popup = await chrome.windows.create({
    width: FLOATING_DOCK_WIDTH,
    height: FLOATING_DOCK_HEIGHT,
    left: Math.max(0, Math.round(baseLeft + baseWidth - FLOATING_DOCK_WIDTH - 10)),
    top,
    focused: true,
    type: "popup",
    url: chrome.runtime.getURL("sidepanel.html?mode=ball")
  });
  if (!popup?.id) return { ok: false, error: "快捷悬浮窗创建失败" };
  await chrome.storage.local.set({
    floatingWindowId: popup.id,
    floatingWindowKind: "ball",
    floatingOriginWindowId: origin?.id || null
  });
  await closeSidePanel(origin?.id);
  return { ok: true, windowId: popup.id, originWindowId: origin?.id || null };
}

// 点击紧凑状态卡片：展开为完整悬浮窗
async function expandBallWindow() {
  const saved = await chrome.storage.local.get(FLOATING_WINDOW_DEFAULTS);
  const ballId = Number(saved.floatingWindowId) || 0;
  const originWindowId = Number(saved.floatingOriginWindowId) || 0;
  await chrome.storage.local.remove(["floatingWindowId", "floatingWindowKind"]);
  if (originWindowId) {
    await chrome.storage.local.set({ floatingOriginWindowId: originWindowId });
  }
  if (ballId && chrome.windows?.remove) {
    try { await chrome.windows.remove(ballId); } catch (_error) {}
  }
  return openFloatingWindow();
}

async function updateBallPosition(top) {
  const saved = await chrome.storage.local.get(FLOATING_WINDOW_DEFAULTS);
  const windowId = Number(saved.floatingWindowId) || 0;
  const safeTop = Math.max(0, Math.round(Number(top) || 0));
  if (windowId && chrome.windows?.update) {
    try { await chrome.windows.update(windowId, { top: safeTop }); } catch (_error) {}
  }
  await chrome.storage.local.set({ floatingBallTop: safeTop });
  return { ok: true, top: safeTop };
}

if (chrome.windows?.onRemoved?.addListener) {
  chrome.windows.onRemoved.addListener(async (windowId) => {
    const saved = await chrome.storage.local.get(FLOATING_WINDOW_DEFAULTS);
    if (Number(saved.floatingWindowId) === Number(windowId)) {
      await chrome.storage.local.remove(["floatingWindowId", "floatingWindowKind", "floatingOriginWindowId"]);
    }
  });
}

if (chrome.windows?.onBoundsChanged?.addListener) {
  chrome.windows.onBoundsChanged.addListener(async (window) => {
    const saved = await chrome.storage.local.get(FLOATING_WINDOW_DEFAULTS);
    if (Number(saved.floatingWindowId) !== Number(window?.id) || window?.state !== "normal") return;
    if (saved.floatingWindowKind === "ball") {
      await chrome.storage.local.set({ floatingBallTop: Math.max(0, Math.round(Number(window.top) || 0)) });
      return;
    }
    const bounds = normalizeFloatingBounds(window);
    await chrome.storage.local.set({ floatingBounds: bounds });
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const current = await chrome.storage.local.get(DEFAULT_CONFIG);
  const targetKeywords = normalizeKeywords([
    ...(Array.isArray(current.targetKeywords) ? current.targetKeywords : []),
    ...DEFAULT_CONFIG.targetKeywords
  ]);
  let bridgeUrl = DEFAULT_CONFIG.bridgeUrl;
  try {
    bridgeUrl = normalizeBridgeUrl(current.bridgeUrl);
  } catch (_error) {
    bridgeUrl = DEFAULT_CONFIG.bridgeUrl;
  }
  await chrome.storage.local.set({
    bridgeUrl,
    targetKeywords: targetKeywords.length ? targetKeywords : DEFAULT_CONFIG.targetKeywords,
    enabled: current.enabled !== false
  });
  await configureSidePanel();
  // Existing tabs retain the old isolated content-script world after an
  // unpacked extension update. Reload XHS tabs once so stale card badges and
  // listeners cannot survive the version change.
  if (details?.reason === "update") {
    const tabs = await chrome.tabs.query({}).catch(() => []);
    await Promise.all(tabs
      .filter((tab) => tab?.id && isXhsPageUrl(tab.url))
      .map((tab) => chrome.tabs.reload(tab.id).catch(() => null)));
  }
});
chrome.runtime.onStartup.addListener(() => configureSidePanel().catch(() => {}));
configureSidePanel().catch(() => {});

async function getConfig() {
  const stored = await chrome.storage.local.get(DEFAULT_CONFIG);
  let bridgeUrl;
  try {
    bridgeUrl = normalizeBridgeUrl(stored.bridgeUrl);
  } catch (_error) {
    bridgeUrl = DEFAULT_CONFIG.bridgeUrl;
  }
  const targetKeywords = normalizeKeywords(stored.targetKeywords);
  return {
    bridgeUrl,
    targetKeywords: targetKeywords.length ? targetKeywords : DEFAULT_CONFIG.targetKeywords,
    enabled: stored.enabled !== false
  };
}

function bridgeEndpoint(base, path) {
  return `${normalizeBridgeUrl(base)}${path}`;
}

async function fetchJson(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const raw = await response.text();
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch (_error) {
      throw new Error(`Bridge 返回了无效数据（HTTP ${response.status}）`);
    }
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `Bridge HTTP ${response.status}`);
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Bridge 响应超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function checkBridgeHealth(config = null) {
  const effectiveConfig = config || await getConfig();
  try {
    const result = await fetchJson(
      bridgeEndpoint(effectiveConfig.bridgeUrl, "/api/health"),
      {},
      HEALTH_TIMEOUT_MS
    );
    if (result.service !== "xhs-monitor-bridge") throw new Error("端口被其他程序占用");
    setBridgeState("online", { bridgeUrl: effectiveConfig.bridgeUrl, error: "", version: result.version || "" });
    return { ok: true, ...bridgeState };
  } catch (error) {
    setBridgeState("offline", { bridgeUrl: effectiveConfig.bridgeUrl, error: error.message });
    return { ok: false, ...bridgeState };
  }
}

function requestNativeBridge() {
  if (nativeStartPromise) return nativeStartPromise;
  nativeStartPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, nativeHost: false, error: "Native Host 启动超时" }), 35000);
    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { type: "ensure_bridge" }, (response) => {
      if (chrome.runtime.lastError) {
        finish({ ok: false, nativeHost: false, error: chrome.runtime.lastError.message });
        return;
      }
      finish({ ...(response || {}), nativeHost: true });
    });
  }).finally(() => {
    nativeStartPromise = null;
  });
  return nativeStartPromise;
}

async function waitForBridgeHealth(config, timeoutMs = 18000) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 18000);
  let latest = null;
  while (Date.now() < deadline) {
    latest = await checkBridgeHealth(config);
    if (latest.ok) return latest;
    await delay(420);
  }
  return latest || { ok: false, error: "Bridge 健康检查超时" };
}

async function ensureBridgeInternal() {
  const config = await getConfig();
  setBridgeState("connecting", { bridgeUrl: config.bridgeUrl, error: "" });
  const existing = await checkBridgeHealth(config);
  if (existing.ok) return { ok: true, started: false, alreadyRunning: true, ...existing };

  let lastResult = existing;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    setBridgeState("connecting", {
      bridgeUrl: config.bridgeUrl, error: "",
      attempt, statusText: `正在启动本地 Bridge（${attempt}/3）`
    });
    const nativeResult = await requestNativeBridge();
    lastResult = nativeResult;
    if (nativeResult?.ok) {
      const health = await waitForBridgeHealth(config, 18000);
      if (health?.ok) return { ...nativeResult, ...health, ok: true, attempt };
      lastResult = { ...nativeResult, ...health, ok: false };
    }
    const fatalNativeError = /host.*not found|未找到.*host|not registered|权限|forbidden/i.test(
      String(nativeResult?.error || "")
    );
    if (fatalNativeError) break;
    await delay(500 * attempt);
  }
  const nativeError = lastResult?.error || "Native Host 启动失败";
  const error = `${nativeError}（当前插件 ID：${chrome.runtime.id}）`;
  setBridgeState("error", { bridgeUrl: config.bridgeUrl, error, extensionId: chrome.runtime.id });
  return { ...(lastResult || {}), ...bridgeState, error, extensionId: chrome.runtime.id, ok: false };
}

function ensureBridge() {
  if (bridgeEnsurePromise) return bridgeEnsurePromise;
  bridgeEnsurePromise = ensureBridgeInternal().finally(() => {
    bridgeEnsurePromise = null;
  });
  return bridgeEnsurePromise;
}

async function getRelevanceGroups(force = false) {
  const now = Date.now();
  if (!force && relevanceGroupsCache && now - relevanceGroupsFetchedAt < 60_000) {
    return relevanceGroupsCache;
  }
  try {
    const result = await bridgeApi("/api/relevance");
    const source = result?.groups && typeof result.groups === "object" ? result.groups : {};
    const normalized = {};
    for (const key of ["brand", "products", "accounts"]) {
      normalized[key] = Array.isArray(source[key])
        ? source[key].map((value) => String(value || "").trim()).filter(Boolean)
        : [];
    }
    relevanceGroupsCache = normalized;
    relevanceGroupsFetchedAt = now;
  } catch (_error) {
    relevanceGroupsCache = relevanceGroupsCache || globalThis.XhsMonitorRelevance.groups;
  }
  return relevanceGroupsCache;
}

function enforceExactNoteIdentity(result) {
  const statuses = Array.isArray(result?.statuses) ? result.statuses.map((status) => {
    const noteId = String(status?.noteId || "").trim();
    const matchedNoteId = String(status?.matchedNoteId || noteId).trim();
    if (!noteId || !matchedNoteId || matchedNoteId === noteId) return status;
    return {
      ...status,
      matchedNoteId: noteId,
      matchedBy: "none",
      matchLabel: "",
      status: "new",
      isNew: true,
      inExcel: false,
      excelStatus: "missing",
      pullStatus: "not_started",
      pullError: "",
      mediaStatus: "not_started",
      mediaDir: "",
      mediaFileCount: 0,
      identityConflictBlocked: true
    };
  }) : [];
  return {
    ...result,
    statuses,
    excelMatchedCount: statuses.filter((status) => status?.inExcel).length,
    excelMissingCount: statuses.filter((status) => !status?.inExcel).length
  };
}

async function scanPage(payload) {
  const config = await getConfig();
  const allNotes = Array.isArray(payload?.notes) ? payload.notes : [];
  const relevanceGroups = await getRelevanceGroups();
  const directlyRelevantNotes = allNotes.filter((note) => globalThis.XhsMonitorRelevance.match(note, relevanceGroups).relevant);
  const scanCounts = {
    scannedCount: allNotes.length,
    directRelevantCount: directlyRelevantNotes.length
  };
  try {
    const rawResult = await bridgeApi("/api/scan", {
      method: "POST",
      // Bridge must see every card. Canonical XHS note ID remains the only
      // identity allowed to mark a card as already pulled.
      body: JSON.stringify({ ...payload, notes: allNotes })
    });
    const result = enforceExactNoteIdentity(rawResult);
    setBridgeState("online", { bridgeUrl: config.bridgeUrl, error: "", version: result.version || bridgeState.version || "" });
    return {
      ...result,
      ...scanCounts,
      filteredCount: result.filteredCount || 0
    };
  } catch (error) {
    setBridgeState("offline", { bridgeUrl: config.bridgeUrl, error: error.message });
    return {
      ok: false,
      source: "offline",
      offline: true,
      ...scanCounts,
      statuses: [],
      inserted: [],
      error: `未连接本地数据库：${error.message}`
    };
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireReaderTab() {
  if (readerCloseTimer) {
    clearTimeout(readerCloseTimer);
    readerCloseTimer = null;
  }
  if (readerTabId) {
    const existing = await chrome.tabs.get(readerTabId).catch(() => null);
    if (existing?.id) return existing;
    readerTabId = null;
  }
  const tab = await chrome.tabs.create({ url: "https://www.xiaohongshu.com/", active: false });
  if (!tab?.id) throw new Error("后台同步标签页创建失败");
  readerTabId = tab.id;
  return tab;
}

function releaseReaderTabSoon(delayMilliseconds = 8000) {
  if (readerCloseTimer) clearTimeout(readerCloseTimer);
  readerCloseTimer = setTimeout(async () => {
    const tabId = readerTabId;
    readerTabId = null;
    readerCloseTimer = null;
    if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
  }, Math.max(250, Number(delayMilliseconds) || 8000));
  readerCloseTimer?.unref?.();
}

async function extractCommentsFromTab(tabId, note) {
  let totalClicked = 0;
  for (let round = 0; round < 3; round += 1) {
    const expanded = await chrome.tabs.sendMessage(tabId, { type: "expandVisibleComments", limit: 12 }).catch(() => null);
    const clicked = Number(expanded?.clicked) || 0;
    totalClicked += clicked;
    if (!clicked) break;
    await delay(650);
  }
  let extracted = null;
  const deadline = Date.now() + DETAIL_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    extracted = await chrome.tabs.sendMessage(tabId, { type: "extractCurrentComments", note }).catch(() => null);
    if (extracted?.ok && extracted.matchesTarget !== false && (extracted.comments?.length || extracted.expectedCount === 0)) break;
    if (extracted?.matchesTarget === false) break;
    await delay(400);
  }
  return { extracted, totalClicked };
}

function noteIdFromXhsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const match = url.pathname.match(/\/(?:search_result|explore|discovery\/item)\/([A-Za-z0-9_-]{6,128})/);
    return match?.[1] || "";
  } catch (_error) {
    return "";
  }
}

function validXhsNoteUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:"
      && (url.hostname === "xiaohongshu.com" || url.hostname.endsWith(".xiaohongshu.com"))
      && /\/(?:search_result|explore|discovery\/item)\//.test(url.pathname);
  } catch (_error) {
    return false;
  }
}

function isXhsPageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:"
      && (url.hostname === "xiaohongshu.com" || url.hostname.endsWith(".xiaohongshu.com"));
  } catch (_error) {
    return false;
  }
}

function isSearchSurfaceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:"
      && (url.hostname === "xiaohongshu.com" || url.hostname.endsWith(".xiaohongshu.com"))
      && (url.pathname.toLocaleLowerCase().includes("search_result")
        || url.searchParams.has("keyword")
        || url.searchParams.has("q")
        || url.searchParams.has("search"));
  } catch (_error) {
    return false;
  }
}

async function deepScanSurfaceLost(tabId) {
  const page = await chrome.tabs.sendMessage(tabId, { type: "getPageInfo" }).catch(() => null);
  if (page) return page.isSearchPage === false && Number(page.noteCount || 0) === 0;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return Boolean(tab?.url && /\/(?:explore|discovery\/item)\//.test(String(tab.url)));
}

async function restoreDeepScanSurface(tabId, pageUrl) {
  if (!isSearchSurfaceUrl(pageUrl)) return false;
  await chrome.tabs.update(tabId, { url: pageUrl, active: true }).catch(() => {});
  return true;
}

function isInjectableXhsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && (url.hostname === "xiaohongshu.com" || url.hostname.endsWith(".xiaohongshu.com"));
  } catch (_error) { return false; }
}

function reloadTabAndWait(tabId, timeoutMs = 18000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const timer = setTimeout(() => finish(new Error("小红书页面自动刷新超时")), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId).catch(finish);
  });
}

async function ensureContentInjected(tabId) {
  const safeTabId = Number(tabId) || 0;
  if (!safeTabId) throw new Error("没有找到当前小红书标签页");
  const tab = await chrome.tabs.get(safeTabId).catch(() => null);
  if (!tab || !isInjectableXhsUrl(tab.url)) throw new Error("当前标签页不是小红书页面");
  const ping = await chrome.tabs.sendMessage(safeTabId, { type: "getPageInfo" }).catch(() => null);
  if (ping?.contentVersion === CONTENT_SCRIPT_VERSION) {
    return { ok: true, injected: false, tabId: safeTabId, contentVersion: ping.contentVersion };
  }
  if (contentInjectionTasks.has(safeTabId)) return contentInjectionTasks.get(safeTabId);
  const task = (async () => {
    // An older content script cannot be safely overlaid: it owns observers and
    // wheel/click handlers. Reload once so Chrome removes the old world and
    // automatically injects this extension version—no manual refresh needed.
    if (ping) {
      await reloadTabAndWait(safeTabId);
      await delay(180);
      const reloaded = await chrome.tabs.sendMessage(safeTabId, { type: "getPageInfo" }).catch(() => null);
      if (reloaded?.contentVersion === CONTENT_SCRIPT_VERSION) {
        return { ok: true, injected: true, reloaded: true, tabId: safeTabId, contentVersion: reloaded.contentVersion };
      }
    }
    await chrome.scripting.insertCSS({ target: { tabId: safeTabId }, files: CONTENT_STYLE_FILES }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId: safeTabId }, files: CONTENT_SCRIPT_FILES });
    await delay(120);
    const ready = await chrome.tabs.sendMessage(safeTabId, { type: "getPageInfo" }).catch(() => null);
    if (!ready || ready.contentVersion !== CONTENT_SCRIPT_VERSION) {
      throw new Error("插件自动注入后版本未就绪，请稍后重试");
    }
    return { ok: true, injected: true, tabId: safeTabId, contentVersion: ready.contentVersion };
  })();
  contentInjectionTasks.set(safeTabId, task);
  try { return await task; }
  finally { contentInjectionTasks.delete(safeTabId); }
}

async function sendTabMessage(tabId, message) {
  try { return await chrome.tabs.sendMessage(tabId, message); }
  catch (_error) {
    await ensureContentInjected(tabId);
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function broadcastLocalNoteState(noteId, state = {}) {
  const safeNoteId = String(noteId || "").trim();
  if (!safeNoteId) return;
  if (state.inExcel === true && state.consistencyVerified !== true) return;
  const message = { type: "localNoteStateChanged", noteId: safeNoteId, ...state };
  chrome.runtime.sendMessage(message).catch(() => {});
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.all(tabs
    .filter((tab) => tab?.id && isXhsPageUrl(tab.url))
    // A passive state notification must not reload a tab the user is editing.
    // Explicit read/pull actions still perform the version/injection handshake.
    .map((tab) => chrome.tabs.sendMessage(tab.id, message).catch(() => null)));
}

async function deletePulledNoteAndBroadcast(noteId) {
  const safeNoteId = String(noteId || "").trim();
  const result = await bridgeApi("/api/note/delete", {
    method: "POST",
    body: JSON.stringify({ noteId: safeNoteId, hardDeleteConfirmed: true, confirmation: safeNoteId }),
    timeoutMs: 300000
  });
  if (result?.ok) {
    await broadcastLocalNoteState(safeNoteId, {
      deleted: true, found: false, inExcel: false, status: "new",
      pullStatus: "not_started", relevanceStatus: "unknown"
    });
  }
  return result;
}

async function activeXhsTab(preferredTabId = null) {
  if (preferredTabId) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (tab?.id) return tab;
    } catch (_error) {}
  }
  const queries = [{ active: true, currentWindow: true }];
  try {
    const saved = await chrome.storage.local.get({ floatingOriginWindowId: null });
    const originWindowId = Number(saved.floatingOriginWindowId) || 0;
    if (originWindowId) queries.push({ active: true, windowId: originWindowId });
  } catch (_error) {}
  for (const query of queries) {
    const tabs = await chrome.tabs.query(query).catch(() => []);
    const tab = tabs.find((item) => item?.id && isXhsPageUrl(item.url)) || tabs.find((item) => item?.id);
    if (tab?.id) return tab;
  }
  return null;
}

function navigateBackgroundTab(tabId, url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const timer = setTimeout(
      () => finish(new Error("详情页加载超时")),
      DETAIL_LOAD_TIMEOUT_MS
    );
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url, active: false }).catch((error) => finish(error));
  });
}

async function extractDetailFromTab(tabId, baseNote) {
  const deadline = Date.now() + DETAIL_LOAD_TIMEOUT_MS;
  let lastError = "正文尚未加载";
  while (Date.now() < deadline) {
    if (deepScanCancelled) return { ok: false, cancelled: true, error: "用户已停止" };
    try {
      const result = await chrome.tabs.sendMessage(tabId, {
        type: "extractCurrentDetail",
        baseNote
      });
      if (result?.ok) return result;
      if (result?.error) lastError = result.error;
      if (result?.loading === false) break;
    } catch (error) {
      lastError = error.message;
    }
    await delay(350);
  }
  return { ok: false, error: lastError };
}

async function runExclusivePageTask(factory) {
  while (pageTaskPromise) await pageTaskPromise.catch(() => {});
  const task = Promise.resolve().then(factory);
  pageTaskPromise = task;
  try {
    return await task;
  } finally {
    if (pageTaskPromise === task) pageTaskPromise = null;
  }
}

async function collectComments(note) {
  if (!note?.noteId) throw new Error("缺少帖子 ID，无法读取评论");
  return runExclusivePageTask(async () => {
    const config = await getConfig();
    chrome.runtime.sendMessage({ type: "commentCollectionProgress", noteId: note.noteId, status: "collecting", current: 0 }).catch(() => {});
    try {
      await bridgeApi("/api/comments/collection/start", {
        method: "POST", body: JSON.stringify({ noteId: note.noteId })
      });
      const activeTab = await activeXhsTab();
      if (!activeTab?.id) throw new Error("找不到当前小红书页面");
      await ensureContentInjected(activeTab.id);
      const extracted = await chrome.tabs.sendMessage(activeTab.id, {
        type: "readNoteInPage", note: { ...note, allComments: true }
      }).catch((error) => ({ ok: false, error: error?.message || "当前页面未连接插件" }));
      if (!extracted?.ok) throw new Error(extracted?.error || "评论区尚未加载完成");
      const result = await bridgeApi("/api/comments/upsert", {
        method: "POST",
        body: JSON.stringify({
          noteId: note.noteId,
          comments: extracted.comments || [],
          expectedCount: extracted.expectedCount || 0,
          explicitEmptyVerified: extracted.explicitEmptyVerified === true,
          collectionEvidence: extracted.collectionEvidence || {},
          status: extracted.status || "partial",
          collectedAt: new Date().toISOString()
        }),
        timeoutMs: 20000
      });
      const finalResult = { ...result, expandedCount: extracted.expandedCount || 0, expectedCount: extracted.expectedCount || 0 };
      chrome.runtime.sendMessage({ type: "commentCollectionProgress", noteId: note.noteId, done: true, ...finalResult }).catch(() => {});
      return finalResult;
    } catch (error) {
      const config = await getConfig();
      await bridgeApi("/api/comments/upsert", {
        method: "POST",
        body: JSON.stringify({ noteId: note.noteId, comments: [], status: "failed", error: error.message, collectedAt: new Date().toISOString() })
      }).catch(() => {});
      chrome.runtime.sendMessage({ type: "commentCollectionProgress", noteId: note.noteId, done: true, status: "failed", error: error.message }).catch(() => {});
      throw error;
    }
  });
}

function broadcastPullProgress(progress, tabId = null) {
  const message = { type: "pullProgress", ...progress };
  chrome.runtime.sendMessage(message).catch(() => {});
  if (tabId) chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

function desktopAccessibleUrl(value) {
  if (!validXhsNoteUrl(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.searchParams.get("xsec_token"))
      || url.hostname === "xhslink.com"
      || url.hostname.endsWith(".xhslink.com");
  } catch (_error) {
    return false;
  }
}

async function resolvePullUrl(note) {
  const activeTab = await activeXhsTab();
  if (activeTab?.id) {
    const resolved = await chrome.tabs.sendMessage(activeTab.id, {
      type: "resolveNoteUrl", noteId: note.noteId
    }).catch(() => null);
    if (desktopAccessibleUrl(resolved?.url)) return resolved.url;
  }
  if (desktopAccessibleUrl(note.url)) return note.url;
  throw new Error("当前页面没有可用的帖子访问链接，请先刷新小红书搜索结果页后重试");
}

async function getNoteStatus(noteId) {
  if (!noteId) return { ok: true, found: false, inExcel: false, pullStatus: "not_started",
    relevanceStatus: "unknown", postStatus: "存在", isDeleted: false };
  return bridgeApi(`/api/note/status?noteId=${encodeURIComponent(noteId)}`);
}

async function analyzeNoteRelevance(note, preferredTabId = null) {
  if (!note?.noteId) return { ok: false, error: "缺少帖子 ID，无法判断相关性" };
  return runExclusivePageTask(async () => {
    const noteId = note.noteId;
    const activeTab = await activeXhsTab(preferredTabId);
    if (!activeTab?.id) throw new Error("找不到当前小红书页面");
    try {
      broadcastPullProgress({ noteId, phase: "body", process: true, mode: "relevance",
      title: "正在读取正文，准备判断品牌相关性", note }, activeTab.id);
    const extracted = await chrome.tabs.sendMessage(activeTab.id, {
      type: "readNoteInPage", note: { ...note, showProcess: true, process: true, relevanceAnalysis: true }
    }).catch((error) => ({ ok: false, error: error?.message || "当前页面未连接插件" }));
    if (!extracted?.ok || !extracted.note?.content) {
      throw new Error(extracted?.error || "尚未读到完整正文，稍后重试");
    }
    const comments = Array.isArray(extracted.comments) ? extracted.comments : [];
    broadcastPullProgress({ noteId, phase: "excel", process: true, mode: "relevance",
      title: `正文与 ${comments.length} 条评论已读取，DeepSeek 正在判断相关性`,
      note: extracted.note, commentCount: comments.length }, activeTab.id);
    const config = await getConfig();
    const result = await bridgeApi("/api/relevance/analyze", {
      method: "POST", body: JSON.stringify({ note: extracted.note, comments,
        expectedCount: extracted.expectedCount || comments.length,
        commentStatus: extracted.status || "partial" }),
      timeoutMs: 120000
    });
    broadcastPullProgress({ noteId, phase: "done", process: true, mode: "relevance", done: true, ok: true,
      title: result.relevanceStatus === "relevant" ? "AI 判断：相关" : result.relevanceStatus === "irrelevant" ? "AI 判断：不相关，已写入不相关 Sheet" : "AI 证据不足：保持未知",
      relevanceStatus: result.relevanceStatus, note: extracted.note }, activeTab.id);
      return result;
    } catch (error) {
      broadcastPullProgress({ noteId, phase: "failed", process: true, mode: "relevance", done: true,
        ok: false, error: error?.message || "AI 判断失败", title: error?.message || "AI 判断失败", note }, activeTab.id);
      throw error;
    }
  });
}

async function summarizeCurrentNote(note, preferredTabId = null) {
  if (!note?.noteId) return { ok: false, error: "缺少帖子 ID，无法总结" };
  return runExclusivePageTask(async () => {
    const activeTab = await activeXhsTab(preferredTabId);
    if (!activeTab?.id) throw new Error("找不到当前小红书页面");
    const extracted = await sendTabMessage(activeTab.id, {
      type: "readNoteInPage", note: { ...note, showProcess: false, process: false, allComments: true }
    }).catch((error) => ({ ok: false, error: error?.message || "当前页面未连接插件" }));
    if (!extracted?.ok || !extracted.note?.content) {
      throw new Error(extracted?.error || "正文尚未读取成功");
    }
    const config = await getConfig();
    return bridgeApi("/api/ai/summary", {
      method: "POST",
      body: JSON.stringify({
        note: extracted.note,
        comments: Array.isArray(extracted.comments) ? extracted.comments : [],
        expectedCount: extracted.expectedCount || 0
      }),
      timeoutMs: 180000
    });
  });
}

async function readCurrentNoteComments(note, preferredTabId = null) {
  if (!note?.noteId) return { ok: false, error: "缺少帖子 ID" };
  return runExclusivePageTask(async () => {
    const activeTab = await activeXhsTab(preferredTabId);
    if (!activeTab?.id) throw new Error("找不到当前小红书页面");
    await ensureContentInjected(activeTab.id);
    const result = await sendTabMessage(activeTab.id, {
      type: "readNoteInPage", note: { ...note, showProcess: false, process: false, allComments: true }
    });
    if (!result?.ok) {
      const error = new Error(result?.error || "评论区读取失败");
      const evidence = result?.access || {};
      error.opened = evidence.state === "ok" || evidence.state === "accessible_surface";
      error.accessStatus = error.opened ? "ok" : "check_failed";
      error.accessEvidence = evidence;
      throw error;
    }
    return result;
  });
}

function requireConsistencyVerified(result, label = "本地同步") {
  if (!result?.ok || result.consistencyVerified !== true) {
    throw new Error(result?.error || `${label}未通过全存储一致性校验`);
  }
  return result;
}

async function setNoteAccessStatus(noteId, status, error = "") {
  if (!noteId) return { ok: false, error: "缺少帖子 ID" };
  const result = await bridgeApi("/api/note/access-status", {
    method: "POST",
    body: JSON.stringify({ noteId, status, error }),
    timeoutMs: 60000
  });
  return requireConsistencyVerified(result, "访问状态同步");
}

async function setNoteAccessStatuses(items = [], runId = 0, expectedBridgeUrl = "") {
  const updates = Array.isArray(items) ? items.filter((item) => item?.noteId) : [];
  if (!updates.length) return { ok: true, updated: 0, items: [], consistencyVerified: true, verified: [] };
  const result = await bridgeApi("/api/notes/access-status/batch", {
    method: "POST",
    body: JSON.stringify({ items: updates, runId: Number(runId) || 0 }),
    expectedBridgeUrl, timeoutMs: 120000
  });
  return requireConsistencyVerified(result, "批量访问状态同步");
}

async function getUnreachableNotes() {
  return bridgeApi("/api/notes/unreachable", { timeoutMs: 30000 });
}

async function deleteUnreachableNotes() {
  // Legacy action name retained for loaded v0.25.2 panels. The Bridge now
  // marks post presence as deleted and keeps CSV, SQLite, comments and media.
  await bridgeApi("/api/excel/reload", { method: "POST", body: "{}", timeoutMs: 30000 });
  const result = requireConsistencyVerified(await bridgeApi("/api/notes/unreachable/mark-deleted", {
    method: "POST", body: "{}", timeoutMs: 300000
  }), "帖子存续状态同步");
  for (const item of result?.marked || []) {
    await broadcastLocalNoteState(item.noteId, {
      deleted: false, found: true, inExcel: true, status: "known",
      postStatus: "已删除", isDeleted: true, accessStatus: "unreachable",
      locallyReconciled: true, consistencyVerified: true
    });
  }
  return result;
}

async function deleteReviewedFailures(noteIds = []) {
  let requested = [...new Set((Array.isArray(noteIds) ? noteIds : []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!requested.length) return { ok: false, error: "没有可标记的待复核帖子" };
  await getBatchCommentSyncState();
  const reviewableIds = new Set((batchCommentSyncState.failures || [])
    .filter(isManualDeleteCandidate).map((item) => String(item.noteId).trim()));
  requested = requested.filter((noteId) => reviewableIds.has(noteId));
  if (!requested.length) return { ok: false, error: "没有可标记的待复核帖子；已排除可访问或仅评论待核验的记录" };
  const result = await setNoteAccessStatuses(requested.map((noteId) => ({
    noteId, status: "unreachable", result: "manual_confirmed_deleted",
    error: "用户人工确认帖子已删除或下架"
  })));
  if (!result?.ok) return { ok: false, marked: [], failures: requested.map((noteId) => ({ noteId, error: result?.error || "标记失败" })),
    markedDeletedCount: 0, error: result?.error || "标记失败" };
  const marked = result.items || [];
  for (const item of marked) {
    await broadcastLocalNoteState(item.noteId, {
      deleted: false, found: true, inExcel: true, status: "known",
      postStatus: item.postStatus || "已删除", isDeleted: true,
      accessStatus: "unreachable", locallyReconciled: true, consistencyVerified: true
    });
  }
  const markedIds = new Set(marked.map((item) => item.noteId));
  const remaining = (batchCommentSyncState.failures || []).filter((item) => !markedIds.has(String(item?.noteId || "")));
  const state = await publishBatchCommentSync({
    failures: remaining,
    failedPosts: remaining.length,
    reviewPosts: remaining.filter(isManualDeleteCandidate).length,
    unreachablePosts: remaining.filter((item) => item?.markedUnreachable).length
  });
  return { ok: true, marked, deleted: marked, failures: [], markedDeletedCount: marked.length,
    deletedCount: marked.length, nonDestructive: true, state, error: "" };
}

async function ignoreBatchFailures(noteIds = []) {
  const requested = [...new Set((Array.isArray(noteIds) ? noteIds : []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!requested.length) return { ok: false, error: "没有可忽略的未完成帖子" };
  await getBatchCommentSyncState();
  const ignored = [];
  const failures = [];
  for (const noteId of requested) {
    try {
      const result = await bridgeApi("/api/ignore", {
        method: "POST", body: JSON.stringify({ noteId }), timeoutMs: 30000
      });
      if (!result?.ok || (result.pulled && !result.consistencyVerified)) {
        throw new Error(result?.error || "忽略状态未通过 CSV、SQLite 与素材一致性校验");
      }
      ignored.push(noteId);
    } catch (error) {
      failures.push({ noteId, error: error?.message || "忽略失败" });
    }
  }
  const ignoredIds = new Set(ignored);
  const remaining = (batchCommentSyncState.failures || []).filter((item) => !ignoredIds.has(String(item?.noteId || "")));
  const state = await publishBatchCommentSync({
    failures: remaining, failedPosts: remaining.length,
    reviewPosts: remaining.filter((item) => !item?.markedUnreachable).length,
    unreachablePosts: remaining.filter((item) => item?.markedUnreachable).length
  });
  return { ok: failures.length === 0, ignoredCount: ignored.length, ignored, failures, state,
    error: failures.length ? `${failures.length} 篇忽略失败` : "" };
}

async function auditCurrentNoteComments(note, preferredTabId = null) {
  let extracted;
  try {
    extracted = await readCurrentNoteComments(note, preferredTabId);
  } catch (error) {
    const accessStatus = error?.opened || error?.accessStatus === "ok" ? "ok" : "check_failed";
    await setNoteAccessStatus(
      note.noteId,
      accessStatus,
      accessStatus === "ok" ? "" : (error?.message || "本次访问核验未完成")
    ).catch(() => {});
    throw error;
  }
  await setNoteAccessStatus(note.noteId, "ok").catch(() => {});
  const snapshot = {
    note: extracted.note || note,
    comments: Array.isArray(extracted.comments) ? extracted.comments : [],
    expectedCount: Number(extracted.expectedCount) || 0,
    expectedCountKnown: extracted.expectedCountKnown,
    commentError: extracted.commentError || "",
    explicitEmptyVerified: extracted.explicitEmptyVerified === true,
    collectionEvidence: extracted.collectionEvidence || {},
    status: extracted.status || "partial"
  };
  const comparison = await bridgeApi("/api/comments/compare", {
    method: "POST", body: JSON.stringify({ noteId: note.noteId, ...snapshot }), timeoutMs: 60000
  });
  return { ...comparison, snapshot };
}

async function syncCurrentNoteComments(payload, expectedBridgeUrl = "", shouldCancel = null) {
  const snapshot = payload?.snapshot || {};
  const noteId = payload?.noteId || snapshot.note?.noteId || "";
  const result = await bridgeApi("/api/comments/sync", {
    method: "POST",
    body: JSON.stringify({
      noteId,
      note: snapshot.note || payload?.note || {},
      comments: Array.isArray(snapshot.comments) ? snapshot.comments : [],
      expectedCount: Number(snapshot.expectedCount) || 0,
      explicitEmptyVerified: snapshot.explicitEmptyVerified === true,
      collectionEvidence: snapshot.collectionEvidence || {},
      status: snapshot.status || "partial",
      runId: Number(payload?.runId) || 0
    }),
    expectedBridgeUrl, shouldCancel, timeoutMs: 120000
  });
  requireConsistencyVerified(result, "评论同步");
  if (result?.ok) {
    await broadcastLocalNoteState(noteId, {
      deleted: false, found: true, inExcel: true, status: "known",
      postStatus: result.postStatus || "存在", isDeleted: false,
      pullStatus: result.pullStatus || "not_started", locallyReconciled: true,
      consistencyVerified: Boolean(result.consistencyVerified)
    });
  }
  return withSyncAlert(noteId, snapshot, result);
}

async function getSyncAlertPreferences() {
  if (syncAlertPreferences) return syncAlertPreferences;
  if (!syncAlertPreferencesLoad) {
    syncAlertPreferencesLoad = chrome.storage.local.get({ [SYNC_ALERT_PREFERENCES_KEY]: null })
      .then(stored => (syncAlertPreferences = syncAlerts.normalizePreferences(stored?.[SYNC_ALERT_PREFERENCES_KEY])))
      .finally(() => { syncAlertPreferencesLoad = null; });
  }
  return syncAlertPreferencesLoad;
}

async function withSyncAlert(noteId, snapshot, response) {
  if (!response?.ok || !response.consistencyVerified
    || (response.commentStatus === "likely_complete" && response.canPrune !== false)) return response;
  const failure = syncAlerts.commentFailure(noteId, snapshot, response);
  // A notification-store failure must not interrupt a verified business write
  // or hide an unverified read. Fall back to showing all alerts.
  const preferences = await getSyncAlertPreferences().catch(() => null);
  return { ...response, syncAlert: syncAlerts.annotateFailure(failure, preferences).alert };
}

async function getSyncAlertSettings() {
  const preferences = await getSyncAlertPreferences();
  const state = await getBatchCommentSyncState();
  return { ok: true, rules: state.alertRules || preferences.rules, state };
}

function setSyncAlertDisposition(message = {}) {
  const change = syncAlertMutationTail.catch(() => {}).then(async () => {
    const { noteId, issueType, scope } = message;
    if (!syncAlerts.validId(noteId) || !syncAlerts.validIssue(issueType)
      || !["once", "issue", "restore"].includes(scope)) throw new Error("告警设置参数不正确");
    const state = await getBatchCommentSyncState();
    const preferences = await getSyncAlertPreferences();
    const target = (state.failures || []).find(item => item.noteId === noteId
      && syncAlerts.describeIssue(item)?.issueType === issueType);
    const rule = preferences.rules.find(item => item.noteId === noteId && item.issueType === issueType);
    if (scope !== "restore") {
      if (!target || !message.runStartedAt || message.runStartedAt !== state.startedAt) {
        throw new Error("该告警所属批次已变化，请刷新后重新选择");
      }
    } else if (!target && !rule) throw new Error("该告警提醒已恢复");
    const selection = { noteId, issueType, title: target?.title || rule?.title || "" };
    const next = scope === "once" ? syncAlerts.setOnce(preferences, selection, state.startedAt)
      : syncAlerts.setOnce(syncAlerts.setRule(preferences, selection, scope === "issue"), selection, "", false);
    // Both once-per-run acknowledgements and persistent rules are an atomic,
    // separate preference write. A failed save never mutates the batch, note,
    // comments or in-memory preferences. One-time keys carry their run ID, so
    // an in-flight new batch cannot inherit a previous acknowledgement.
    await chrome.storage.local.set({ [SYNC_ALERT_PREFERENCES_KEY]: next });
    syncAlertPreferences = next;
    const updated = await publishBatchCommentSync({}, false);
    return { ok: true, state: updated, rules: updated.alertRules, continuesSync: true, scope };
  });
  syncAlertMutationTail = change.catch(() => {});
  return change;
}

function batchSyncState(overrides = {}) {
  batchCommentSyncState = {
    ...batchCommentSyncState,
    ...overrides,
    updatedAt: new Date().toISOString()
  };
  // These values are projections of preferences, not business run counters.
  delete batchCommentSyncState.activeFailureCount;
  delete batchCommentSyncState.mutedFailureCount;
  delete batchCommentSyncState.alertRules;
  return { ...batchCommentSyncState };
}

async function publishBatchCommentSync(overrides = {}, notifyCompletion = true) {
  const state = batchSyncState(overrides);
  // Serialize preference changes and progress persistence so an older async
  // write cannot resurrect an acknowledged alert or erase newer progress.
  const published = batchStatePersistTail.catch(() => {}).then(async () => {
    const preferences = await getSyncAlertPreferences().catch(() => null);
    const view = syncAlerts.projectState(state, preferences);
    await chrome.storage.local.set({ [BATCH_COMMENT_SYNC_KEY]: view }).catch(() => {});
    chrome.runtime.sendMessage({ type: "batchCommentSyncProgress", ...view, notifyCompletion }).catch(() => {});
    return view;
  });
  batchStatePersistTail = published.catch(() => {});
  return published;
}

async function getBatchCommentSyncState() {
  const preferences = await getSyncAlertPreferences().catch(() => null);
  if (batchCommentSyncState.running) return syncAlerts.projectState(batchCommentSyncState, preferences);
  await batchStatePersistTail;
  const stored = await chrome.storage.local.get({ [BATCH_COMMENT_SYNC_KEY]: null }).catch(() => ({}));
  const state = stored?.[BATCH_COMMENT_SYNC_KEY];
  if (state && typeof state === "object") {
    const interrupted = Boolean(state.running);
    batchCommentSyncState = {
      ...batchCommentSyncState,
      ...state,
      running: false,
      done: interrupted ? true : Boolean(state.done),
      phase: interrupted ? "interrupted" : state.phase,
      error: interrupted ? "浏览器后台曾中断批量同步，可点击按钮从头重新核对" : (state.error || ""),
      finishedAt: interrupted ? new Date().toISOString() : (state.finishedAt || "")
    };
    if (interrupted) {
      await chrome.storage.local.set({ [BATCH_COMMENT_SYNC_KEY]: batchCommentSyncState }).catch(() => {});
    }
  }
  return syncAlerts.projectState(batchCommentSyncState, preferences);
}

function batchReaderUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!isXhsPageUrl(url.href)) return "";
    url.searchParams.set("xhs_monitor_batch", "1");
    return url.href;
  } catch (_error) {
    return "";
  }
}

async function liveNoteUrlsFromOpenTabs(noteId, excludedTabId = 0) {
  if (!noteId) return [];
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const eligible = tabs.filter((tab) => tab?.id && tab.id !== excludedTabId && isXhsPageUrl(tab.url || ""));
  const resolvedUrls = await Promise.all(eligible.map((tab) =>
    sendTabMessage(tab.id, { type: "resolveNoteUrl", noteId }).catch(() => null)
  ));
  const values = resolvedUrls.map((resolved) => resolved?.url).filter(desktopAccessibleUrl);
  return [...new Set(values)];
}

function batchReaderCandidates(note = {}, liveUrls = []) {
  const candidates = [];
  for (const url of liveUrls) {
    candidates.push({ url: batchReaderUrl(url), waitForCard: false, source: "live-tab-url" });
  }
  const storedUrlId = noteIdFromXhsUrl(note.url);
  if (validXhsNoteUrl(note.url) && (!storedUrlId || storedUrlId === note.noteId)) {
    candidates.push({ url: batchReaderUrl(note.url), waitForCard: false, source: "stored-url" });
  }
  if (note.noteId) {
    candidates.push({
      url: batchReaderUrl(`https://www.xiaohongshu.com/explore/${encodeURIComponent(note.noteId)}`),
      waitForCard: false,
      source: "canonical-explore"
    });
    candidates.push({
      url: batchReaderUrl(`https://www.xiaohongshu.com/discovery/item/${encodeURIComponent(note.noteId)}`),
      waitForCard: false,
      source: "canonical-discovery"
    });
  }
  if (isXhsPageUrl(note.authorUrl || "")) {
    candidates.push({ url: batchReaderUrl(note.authorUrl), waitForCard: true, source: "author-profile" });
  }
  const title = String(note.title || "").trim();
  if (title) {
    const searchUrl = new URL("https://www.xiaohongshu.com/search_result");
    searchUrl.searchParams.set("keyword", title.slice(0, 80));
    searchUrl.searchParams.set("source", "web_search_result_notes");
    searchUrl.searchParams.set("xhs_monitor_batch", "1");
    candidates.push({ url: searchUrl.href, waitForCard: true, source: "title-search" });
  }
  const seen = new Set();
  return candidates.filter((item) => item.url && !seen.has(item.url) && seen.add(item.url));
}

function isBatchInfrastructureError(message) {
  return /自动注入|内容脚本|插件.*连接|权限|登录|验证码|验证|风控|网络|ERR_|后台同步标签页|用户已停止/i
    .test(String(message || ""));
}

function accessFailureDiagnosis(error = {}, local = {}) {
  const evidence = Array.isArray(error.accessEvidence) ? error.accessEvidence : [error.accessEvidence];
  const states = new Set(evidence.map((item) => item?.state).filter(Boolean));
  const syncStage = error.syncStage || error.stage || "unknown";
  const mediaCount = Array.isArray(local.mediaFiles) ? local.mediaFiles.length : 0;
  const commentCount = Math.max(0, Number(local.commentCount) || 0);
  const hasLocalCopy = Boolean(local.found && (local.inExcel || local.note?.content || mediaCount || commentCount));
  const linkMismatchSummary = states.has("link_id_mismatch") ? " · 保存链接指向其他帖子" : "";
  const localSummary = hasLocalCopy
    ? `本地已拉取${mediaCount ? ` · 素材 ${mediaCount} 个` : ""}${commentCount ? ` · 评论 ${commentCount} 条` : ""}${linkMismatchSummary}`
    : `本地尚无完整副本${linkMismatchSummary}`;
  let code = "link_needs_review";
  let label = "链接待复核";
  let summary = "桌面链接未能完成核验，禁止自动删除";
  if (error.unreachable || error.markedUnreachable || error.accessStatus === "unreachable"
      || error.diagnosis?.code === "confirmed_unreachable") {
    code = "confirmed_unreachable";
    label = "已确认失效";
    summary = "至少两个独立详情入口明确显示已删除、下架或不存在";
  } else if (syncStage === "comments") {
    code = "comments_unverified";
    label = "可打开，评论待核验";
    summary = "正文已读取，帖子可访问；评论计数或完整性尚未核验，不属于失效帖子";
  } else if (syncStage === "compare" || syncStage === "sync") {
    code = "accessible_sync_failed";
    label = "可打开，本地同步未完成";
    summary = "正文已读取，帖子可访问；本地比对或同步未完成，不属于失效帖子";
  } else if (states.has("accessible_surface") || states.has("ok") || error.opened || error.accessStatus === "ok") {
    code = "accessible_extraction_failed";
    label = "可打开，读取未完成";
    summary = "帖子页面可访问，仅详情层提取失败，不属于失效帖子";
  } else if (states.has("definitive_unreachable")) {
    code = "suspected_unreachable";
    label = "疑似删除/链接失效";
    summary = "至少一个详情入口明确显示“页面不见了”，但证据尚未达到安全删除标准";
  } else if (states.has("mobile_only")) {
    code = "mobile_only";
    label = "仅手机/扫码可看";
    summary = "桌面端要求扫码，不能据此认定帖子已删除";
  } else if (states.has("authentication_required")) {
    code = "authentication_required";
    label = "登录验证受限";
    summary = "登录、验证码或风控阻止读取，不属于失效帖子";
  } else if (states.has("temporary_blocked")) {
    code = "temporary_blocked";
    label = "桌面暂时受限";
    summary = "页面暂时无法浏览，稍后应重新核验";
  } else if (states.has("link_id_mismatch")) {
    code = "stored_link_id_mismatch";
    label = "本地链接串帖";
    summary = "保存的链接指向另一篇帖子，已停止误读并尝试按原帖子 ID、作者页和标题重新找回";
  } else if (hasLocalCopy) {
    code = "stored_link_needs_refresh";
    label = "本地有副本，链接待修复";
    summary = "已找到本地正文、评论或素材，保留数据并重新解析有效链接";
  }
  return { code, label, summary, localSummary, hasLocalCopy, mediaCount, commentCount };
}

function isManualDeleteCandidate(failure = {}) {
  if (!failure?.noteId) return false;
  const evidence = Array.isArray(failure.accessEvidence) ? failure.accessEvidence : [failure.accessEvidence];
  // Older stored failures may have only stage, accessStatus or a diagnosis code.
  return !failure.markedUnreachable && !failure.unreachable && !failure.opened
    && failure.accessStatus !== "unreachable" && failure.accessStatus !== "ok"
    && !["comments", "compare", "sync"].includes(failure.syncStage || failure.stage)
    && !["confirmed_unreachable", "comments_unverified", "accessible_sync_failed", "accessible_extraction_failed"]
      .includes(failure.diagnosis?.code)
    && !evidence.some((item) => item?.state === "ok" || item?.state === "accessible_surface");
}

async function readPulledNoteInReader(tabId, note) {
  const liveUrls = await liveNoteUrlsFromOpenTabs(note.noteId, tabId);
  const candidates = batchReaderCandidates(note, liveUrls);
  if (!candidates.length) {
    const error = new Error("没有可用的帖子链接或标题");
    error.unreachable = false;
    error.accessStatus = "check_failed";
    throw error;
  }
  let lastError = "帖子详情读取失败";
  let infrastructureFailure = false;
  const storedUrlId = noteIdFromXhsUrl(note.url);
  const accessEvidence = storedUrlId && storedUrlId !== note.noteId
    ? [{
        source: "stored-url",
        state: "link_id_mismatch",
        marker: storedUrlId,
        reason: `本地链接指向另一篇帖子 ${storedUrlId}`,
        targetRoute: false
      }]
    : [];
  for (const candidate of candidates) {
    if (batchCommentSyncCancelled) throw new Error("用户已停止批量同步");
    try {
      await navigateBackgroundTab(tabId, candidate.url);
      await ensureContentInjected(tabId);
      await delay(candidate.waitForCard ? 650 : 220);
      const accessProbe = await sendTabMessage(tabId, {
        type: "probeNoteAccess",
        note: { ...note, noteId: note.noteId }
      }).catch(() => null);
      const probeEvidence = accessProbe?.access || {};
      if (probeEvidence.state) {
        accessEvidence.push({
          source: candidate.source,
          state: probeEvidence.state,
          marker: probeEvidence.marker || "",
          reason: probeEvidence.reason || "",
          targetRoute: Boolean(probeEvidence.targetRoute)
        });
        if (["temporary_blocked", "mobile_only", "authentication_required"].includes(probeEvidence.state)) {
          infrastructureFailure = true;
        }
      }
      let prepared = await sendTabMessage(tabId, {
        type: "prepareBatchProcess",
        note: { ...note, noteId: note.noteId, batchSync: true }
      }).catch(() => null);
      if (!prepared?.ok || !prepared.expanded) {
        await delay(140);
        prepared = await sendTabMessage(tabId, {
          type: "prepareBatchProcess",
          note: { ...note, noteId: note.noteId, batchSync: true }
        }).catch(() => null);
      }
      if (!prepared?.ok || !prepared.expanded) {
        throw new Error("同步进度窗口尚未展开，已暂停本帖读取");
      }
      const extracted = await sendTabMessage(tabId, {
        type: "readNoteInPage",
        note: {
          ...note,
          noteId: note.noteId,
          allComments: true,
          batchSync: true,
          waitForCard: candidate.waitForCard,
          showProcess: true,
          process: true
        }
      });
      if (extracted?.ok) return { ...extracted, accessCandidate: candidate.source };
      lastError = extracted?.error || lastError;
      const evidence = extracted?.access || {};
      accessEvidence.push({
        source: candidate.source,
        state: evidence.state || "unknown",
        marker: evidence.marker || "",
        reason: evidence.reason || "",
        targetRoute: Boolean(evidence.targetRoute)
      });
      if (["temporary_blocked", "mobile_only", "authentication_required"].includes(evidence.state)) infrastructureFailure = true;
    } catch (error) {
      lastError = error?.message || lastError;
      infrastructureFailure = infrastructureFailure || isBatchInfrastructureError(lastError);
      accessEvidence.push({ source: candidate.source, state: "request_failed", marker: lastError });
    }
  }
  const error = new Error(lastError);
  const explicitSources = new Set(
    accessEvidence.filter((item) => item.state === "definitive_unreachable").map((item) => item.source)
  );
  const accessible = accessEvidence.some((item) => item.state === "accessible_surface" || item.state === "ok");
  error.unreachable = !accessible && !infrastructureFailure && explicitSources.size >= 2;
  error.opened = accessible;
  error.accessStatus = error.unreachable ? "unreachable" : (accessible ? "ok" : "check_failed");
  error.accessEvidence = accessEvidence;
  throw error;
}

async function syncPulledNoteInReader(tabId, note, runId = 0, pipeline = null) {
  let extracted;
  try {
    extracted = pipeline ? pipeline.extracted : await readPulledNoteInReader(tabId, note);
    if (extracted?.note?.noteId && extracted.note.noteId !== note.noteId) {
      throw new Error("读取结果与目标帖子 ID 不一致，已停止写入");
    }
  } catch (error) {
    error.syncStage = "open";
    throw error;
  }
  const progress = (message) => {
    if (pipeline && !pipeline.isCurrent()) return Promise.resolve();
    return sendTabMessage(tabId, { ...message, onlyIfCurrent: Boolean(pipeline) }).catch(() => {});
  };
  const assertNotCancelled = () => {
    if (pipeline?.isCancelled()) throw new Error("同步已取消，未提交的读取结果已丢弃");
  };
  assertNotCancelled();
  const snapshot = {
    note: extracted.note || note,
    comments: Array.isArray(extracted.comments) ? extracted.comments : [],
    expectedCount: Number(extracted.expectedCount) || 0,
    expectedCountKnown: extracted.expectedCountKnown,
    commentError: extracted.commentError || "",
    explicitEmptyVerified: extracted.explicitEmptyVerified === true,
    collectionEvidence: extracted.collectionEvidence || {},
    status: extracted.status || "partial"
  };
  await progress({
    type: "batchSyncNoteProgress",
    noteId: note.noteId,
    note: snapshot.note,
    phase: "excel",
    title: `已读取 ${snapshot.comments.length} 条评论，正在与本地数据对比`,
    commentCount: snapshot.comments.length,
    commentRows: snapshot.comments.slice(0, 12)
  }).catch(() => {});
  let comparison;
  try {
    comparison = await bridgeApi("/api/comments/compare", {
      method: "POST",
      body: JSON.stringify({ noteId: note.noteId, ...snapshot }),
      expectedBridgeUrl: pipeline?.bridgeUrl || "", timeoutMs: 60000
    });
  } catch (error) {
    error.syncStage = "compare";
    throw error;
  }
  if (!comparison?.ok) {
    const error = new Error(comparison?.error || "评论对比失败");
    error.syncStage = "compare";
    throw error;
  }
  const hasCommentChanges = Boolean(comparison.commentHasChanges);
  // Every successful read is written through all local stores even when the
  // business-facing result remains “无变化”. This repairs drift without
  // counting volatile post metadata as a comment change.
  await progress({
    type: "batchSyncNoteProgress",
    noteId: note.noteId,
    note: snapshot.note,
    phase: "excel",
    title: hasCommentChanges
      ? `发现 ${Number(comparison.newCount || 0) + Number(comparison.removedCount || 0) + Number(comparison.changedCount || 0)} 项变化，正在同步全部本地数据`
      : "帖子与评论无变化，正在校准存续状态、CSV、SQLite 与素材快照",
    commentCount: snapshot.comments.length,
    commentRows: snapshot.comments.slice(0, 12)
  }).catch(() => {});
  let synced;
  try {
    assertNotCancelled();
    synced = await syncCurrentNoteComments({ noteId: note.noteId, snapshot, runId }, pipeline?.bridgeUrl || "", pipeline?.isCancelled || null);
  } catch (error) {
    error.syncStage = "sync";
    throw error;
  }
  if (!synced?.ok || !synced.consistencyVerified) {
    const error = new Error(synced?.error || "本地数据一致性校验失败");
    error.syncStage = "sync";
    throw error;
  }
  if (synced.commentStatus !== "likely_complete" || synced.canPrune !== true) {
    const error = new Error(extracted.commentError || `已保存 ${synced.currentCount ?? snapshot.comments.length}/${snapshot.expectedCount || "?"} 条评论；自动补读后仍未完整，历史评论已保留`);
    error.syncStage = "comments";
    error.opened = true;
    error.savedComparison = comparison;
    error.syncCommitted = true;
    error.commentRead = syncAlerts.commentFailure(note.noteId, snapshot, synced, error.message).commentRead;
    throw error;
  }
  await progress({
    type: "batchSyncNoteProgress",
    noteId: note.noteId,
    note: snapshot.note,
    phase: "excel",
    done: true,
    title: hasCommentChanges ? "帖子、评论及存续状态已通过全存储校验" : "帖子与评论无变化，全存储状态已校准",
    pullStatus: synced.pullStatus || "synced",
    commentCount: snapshot.comments.length,
    commentRows: snapshot.comments.slice(0, 12)
  }).catch(() => {});
  return {
    ok: true, changed: hasCommentChanges, comparison, synced,
    collectedCount: synced.collectedCount || snapshot.comments.length
  };
}

async function runPulledCommentSync(selectedNoteIds = null, mode = "all") {
  const batchBridgeUrl = (await getConfig()).bridgeUrl;
  const source = await getNotes("", 1000);
  if (!source?.ok) throw new Error(source?.error || "已拉取帖子列表读取失败");
  const selection = Array.isArray(selectedNoteIds) && selectedNoteIds.length
    ? new Set(selectedNoteIds.map((item) => String(item || "")).filter(Boolean))
    : null;
  const pulledCandidates = (source.notes || []).filter((note) => {
    const pulled = note.source === "existing_xlsx" || ["synced", "partial"].includes(note.pullStatus);
    return pulled && note.noteId && (!selection || selection.has(note.noteId));
  });
  const ignoredNotes = pulledCandidates.filter((note) => note.status === "ignored");
  for (const note of ignoredNotes) {
    const reconciled = await bridgeApi("/api/ignore", {
      method: "POST", body: JSON.stringify({ noteId: note.noteId }), expectedBridgeUrl: batchBridgeUrl, timeoutMs: 60000
    });
    if (!reconciled?.ok || !reconciled.consistencyVerified) {
      throw new Error("已忽略帖子状态同步失败：" + (note.title || note.noteId));
    }
  }
  const seen = new Set();
  const notes = pulledCandidates.filter((note) => {
    const selectedDeleted = Boolean(selection && selection.has(note.noteId));
    return note.status !== "ignored" && (!note.isDeleted || selectedDeleted)
      && !seen.has(note.noteId) && seen.add(note.noteId);
  });
  const startedAt = new Date().toISOString();
  await publishBatchCommentSync({
    ok: true, running: true, done: false, cancelled: false,
    total: notes.length, current: 0, currentNoteId: "", currentTitle: "",
    changedPosts: 0, unchangedPosts: 0, failedPosts: 0,
    accessiblePosts: 0, reviewPosts: 0, unreachablePosts: 0, processingFailedPosts: 0,
    statusSyncFailures: 0, ignoredReconciled: ignoredNotes.length,
    newComments: 0, removedComments: 0, changedComments: 0,
    failures: [], mode, phase: notes.length ? "preparing" : "done", error: "",
    startedAt, finishedAt: notes.length ? "" : startedAt
  });
  if (!notes.length) return publishBatchCommentSync({ running: false, done: true, phase: "done" });

  const reader = await acquireReaderTab();
  const runStarted = await bridgeApi("/api/sync-runs/start", {
    method: "POST",
    body: JSON.stringify({ runType: "batch", totalNotes: notes.length, detail: { mode } }),
    expectedBridgeUrl: batchBridgeUrl, timeoutMs: 30000
  }).catch(() => ({ ok: false, runId: 0 }));
  const syncRunId = Number(runStarted?.runId) || 0;
  const accessUpdates = [];
  let pendingRead = null;
  let readerNoteId = "";
  // One reader, one in-flight commit, at most one fully detached next snapshot.
  // Attach a rejection handler immediately: a prefetched read can fail while
  // the preceding write is still pending and must not become unhandled.
  const queueRead = (note, wait = false) => (async () => {
    if (wait) await delay(420);
    if (batchCommentSyncCancelled) return { cancelled: true };
    if ((await getConfig()).bridgeUrl !== batchBridgeUrl) {
      throw new Error("本地连接配置已变更，本批次停止读取");
    }
    if (batchCommentSyncCancelled) return { cancelled: true };
    readerNoteId = note.noteId;
    const extracted = await readPulledNoteInReader(reader.id, note);
    return { extracted: JSON.parse(JSON.stringify(extracted)) };
  })().catch(error => {
    error.syncStage = "open";
    return { error };
  });
  try {
    pendingRead = queueRead(notes[0]);
    for (let index = 0; index < notes.length; index += 1) {
      if (batchCommentSyncCancelled) break;
      const note = notes[index];
      await publishBatchCommentSync({
        phase: "reading", current: index, currentNoteId: note.noteId,
        currentTitle: note.title || "未命名帖子"
      });
      try {
        const captured = await pendingRead;
        pendingRead = null;
        if (batchCommentSyncCancelled || captured.cancelled) break;
        // Navigation starts only AFTER all extraction, identity and evidence
        // capture for the current page have completed. Commits stay serial.
        if (index + 1 < notes.length) pendingRead = queueRead(notes[index + 1], true);
        if (captured.error) throw captured.error;
        const result = await syncPulledNoteInReader(reader.id, note, syncRunId, {
          extracted: captured.extracted, bridgeUrl: batchBridgeUrl,
          isCurrent: () => readerNoteId === note.noteId,
          isCancelled: () => batchCommentSyncCancelled
        });
        const comparison = result.comparison || {};
        accessUpdates.push({ noteId: note.noteId, status: "ok", result: "opened" });
        await publishBatchCommentSync({
          phase: result.changed ? "synced" : "unchanged",
          current: index + 1,
          changedPosts: batchCommentSyncState.changedPosts + (result.changed ? 1 : 0),
          unchangedPosts: batchCommentSyncState.unchangedPosts + (result.changed ? 0 : 1),
          accessiblePosts: batchCommentSyncState.accessiblePosts + 1,
          newComments: batchCommentSyncState.newComments + Number(comparison.newCount || 0),
          removedComments: batchCommentSyncState.removedComments + Number(comparison.removedCount || 0),
          changedComments: batchCommentSyncState.changedComments + Number(comparison.changedCount || 0)
        });
      } catch (error) {
        // A confirmed partial commit (or lost write acknowledgement) must be
        // accounted for even if the user cancelled while that write settled.
        if (batchCommentSyncCancelled && !error?.syncCommitted && !error?.outcomeUnknown) break;
        const opened = Boolean(error?.opened || (error?.syncStage && error.syncStage !== "open"));
        const accessStatus = opened ? "ok" : (error?.accessStatus === "unreachable" ? "unreachable" : "check_failed");
        const markedUnreachable = accessStatus === "unreachable";
        const localStatus = await getNoteStatus(note.noteId).catch(() => ({ ok: false, found: false }));
        const diagnosis = accessFailureDiagnosis({ ...error, opened, unreachable: markedUnreachable }, localStatus || {});
        accessUpdates.push({
          noteId: note.noteId,
          status: accessStatus,
          result: opened ? "opened_extract_failed" : (markedUnreachable ? "confirmed_v2" : diagnosis.code),
          error: opened ? "" : `${diagnosis.label}：${diagnosis.summary}`
        });
        const failure = {
          noteId: note.noteId,
          url: noteIdFromXhsUrl(note.url) === note.noteId
            ? note.url
            : `https://www.xiaohongshu.com/explore/${encodeURIComponent(note.noteId)}`,
          storedUrl: note.url || "",
          title: note.title || "未命名帖子",
          error: error?.message || "同步未完成",
          stage: error?.syncStage || "unknown",
          syncStage: error?.syncStage || "unknown",
          commentRead: error?.commentRead,
          markedUnreachable,
          accessStatus,
          diagnosis,
          localEvidence: {
            found: Boolean(localStatus?.found),
            inExcel: Boolean(localStatus?.inExcel),
            pullStatus: localStatus?.pullStatus || "",
            mediaDir: localStatus?.mediaDir || "",
            mediaCount: diagnosis.mediaCount,
            commentCount: diagnosis.commentCount
          },
          accessEvidence: error?.accessEvidence || []
        };
        const alert = syncAlerts.annotateFailure(failure, await getSyncAlertPreferences().catch(() => null)).alert;
        if (readerNoteId === note.noteId) await sendTabMessage(reader.id, {
          type: "batchSyncNoteProgress", noteId: note.noteId, note, onlyIfCurrent: true,
          phase: error?.syncStage === "open" ? "open" : "excel", done: true,
          error: alert.suppressed ? "" : (error?.message || "本帖同步失败"),
          title: alert.suppressed ? `可见评论已同步；${alert.label}已忽略，帖子仍继续同步` : "本帖同步暂停，已记录失败原因",
          syncAlert: alert, pullStatus: error?.syncStage === "comments" ? "partial" : (note.pullStatus || "partial")
        }).catch(() => {});
        await publishBatchCommentSync({
          phase: "failed-note", current: index + 1,
          failedPosts: batchCommentSyncState.failedPosts + 1,
          accessiblePosts: batchCommentSyncState.accessiblePosts + (opened ? 1 : 0),
          reviewPosts: batchCommentSyncState.reviewPosts + (accessStatus === "check_failed" ? 1 : 0),
          unreachablePosts: batchCommentSyncState.unreachablePosts + (markedUnreachable ? 1 : 0),
          processingFailedPosts: batchCommentSyncState.processingFailedPosts + (markedUnreachable ? 0 : 1),
          newComments: batchCommentSyncState.newComments + Number(error?.savedComparison?.newCount || 0),
          changedComments: batchCommentSyncState.changedComments + Number(error?.savedComparison?.changedCount || 0),
          failures: [...batchCommentSyncState.failures, failure].slice(-1000)
        });
      }
    }
  } finally {
    // Drain/cancel the reader before closing the tab or final status writes.
    // A prefetched result is never implicitly committed during cleanup.
    if (pendingRead) await pendingRead;
    if (accessUpdates.length) {
      const accessResult = await setNoteAccessStatuses(accessUpdates, syncRunId, batchBridgeUrl).catch((error) => ({
        ok: false,
        error: error?.message || "访问状态写入失败"
      }));
      if (!accessResult?.ok) {
        await publishBatchCommentSync({
          statusSyncFailures: accessUpdates.length,
          error: `评论已核对，但访问状态写入失败：${accessResult?.error || "请关闭 CSV 表格后重试"}`
        });
      } else {
        for (const item of accessResult.items || []) {
          await broadcastLocalNoteState(item.noteId, {
            deleted: false, found: true, inExcel: true, status: "known",
            postStatus: item.postStatus || "存在", isDeleted: Boolean(item.isDeleted),
            accessStatus: item.status || "", locallyReconciled: true,
            consistencyVerified: true
          });
        }
      }
    }
    releaseReaderTabSoon(350);
  }
  const cancelled = Boolean(batchCommentSyncCancelled);
  const statusWriteFailed = Boolean(batchCommentSyncState.statusSyncFailures);
  if (syncRunId) {
    const runStatus = cancelled ? "cancelled"
      : (batchCommentSyncState.failedPosts || statusWriteFailed) ? "partial" : "completed";
    await bridgeApi("/api/sync-runs/finish", {
      method: "POST",
      body: JSON.stringify({
        runId: syncRunId,
        status: runStatus,
        processedNotes: batchCommentSyncState.current,
        changedNotes: batchCommentSyncState.changedPosts,
        unchangedNotes: batchCommentSyncState.unchangedPosts,
        failedNotes: batchCommentSyncState.failedPosts,
        newComments: batchCommentSyncState.newComments,
        removedComments: batchCommentSyncState.removedComments,
        changedComments: batchCommentSyncState.changedComments,
        detail: { mode, failures: batchCommentSyncState.failures || [] }
      }),
      expectedBridgeUrl: batchBridgeUrl, timeoutMs: 30000
    }).catch(() => null);
  }
  let weeklyReport = null;
  if (mode === "all" && !cancelled) {
    weeklyReport = await bridgeApi("/api/reports/weekly", {
      method: "POST", body: JSON.stringify({ auto: true }), expectedBridgeUrl: batchBridgeUrl, timeoutMs: 120000
    }).catch(() => null);
  }
  return publishBatchCommentSync({
    ok: !statusWriteFailed, running: false, done: true, cancelled,
    phase: cancelled ? "cancelled" : (statusWriteFailed ? "status-write-failed" : "done"),
    currentNoteId: "", currentTitle: "",
    weeklyReport: weeklyReport?.ok ? weeklyReport : null,
    finishedAt: new Date().toISOString()
  });
}

async function startPulledCommentSync(selectedNoteIds = null, mode = "all") {
  if (batchCommentSyncPromise) return { ok: true, joinedExisting: true, ...syncAlerts.projectState(batchCommentSyncState, syncAlertPreferences) };
  batchCommentSyncCancelled = false;
  const startedAt = new Date().toISOString();
  const startingState = batchSyncState({
    ok: true, running: true, done: false, cancelled: false,
    total: 0, current: 0, currentNoteId: "", currentTitle: "",
    changedPosts: 0, unchangedPosts: 0, failedPosts: 0,
    accessiblePosts: 0, reviewPosts: 0, unreachablePosts: 0, processingFailedPosts: 0,
    statusSyncFailures: 0, ignoredReconciled: 0,
    newComments: 0, removedComments: 0, changedComments: 0,
    failures: [], mode, phase: "preparing", error: "", startedAt, finishedAt: ""
  });
  publishBatchCommentSync(startingState).catch(() => {});
  const task = runPulledCommentSync(selectedNoteIds, mode).catch(async (error) => publishBatchCommentSync({
    ok: false, running: false, done: true, phase: "failed",
    error: error?.message || "批量同步失败", finishedAt: new Date().toISOString()
  }));
  batchCommentSyncPromise = task;
  task.finally(() => {
    if (batchCommentSyncPromise === task) batchCommentSyncPromise = null;
  });
  return { ok: true, started: true, ...syncAlerts.projectState(batchCommentSyncState, syncAlertPreferences) };
}

async function startAllPulledCommentSync() {
  return startPulledCommentSync(null, "all");
}

async function startFailedPulledCommentSync() {
  const state = await getBatchCommentSyncState();
  const failedTotal = Math.max(0, Number(state.activeFailureCount ?? state.failedPosts) || 0);
  const failedIds = [...new Set((state.failures || []).filter(item => !item?.alert?.suppressed).map((item) => item?.noteId).filter(Boolean))];
  if (!failedTotal && !failedIds.length) return { ok: false, error: "当前没有需要重新核验的失败帖子" };
  // v0.21.0 only retained the last 30 failure records. When the aggregate is
  // larger than the retained IDs, rerun the full pulled set so none are lost.
  const legacyIncomplete = Number(state.failedPosts) > (state.failures || []).length;
  return startPulledCommentSync(legacyIncomplete ? null : failedIds, legacyIncomplete ? "reconcile-all" : "failed");
}

async function cancelAllPulledCommentSync() {
  batchCommentSyncCancelled = true;
  if (readerTabId) await chrome.tabs.sendMessage(readerTabId, { type: "cancelCommentRead" }).catch(() => {});
  return publishBatchCommentSync({ cancelled: true, phase: "stopping" });
}

async function suggestCommentReply(payload, preferredTabId = null) {
  const note = payload?.note || {};
  let comments = Array.isArray(payload?.comments) ? payload.comments : [];
  let freshNote = note;
  if (!comments.length || !freshNote.content) {
    const extracted = await readCurrentNoteComments(note, preferredTabId);
    comments = extracted.comments || [];
    freshNote = extracted.note || note;
  }
  const config = await getConfig();
  return bridgeApi("/api/ai/reply-suggestion", {
    method: "POST",
    body: JSON.stringify({ note: freshNote, comments, targetComment: payload.targetComment, persona: payload.persona }),
    timeoutMs: 180000
  });
}

async function applyCommentReply(payload, preferredTabId = null) {
  const activeTab = await activeXhsTab(preferredTabId);
  if (!activeTab?.id) throw new Error("找不到当前小红书页面");
  return sendTabMessage(activeTab.id, {
    type: "fillCommentReply", note: payload.note, comment: payload.comment, reply: payload.reply
  });
}

async function pullNote(note, preferredTabId = null) {
  if (!note?.noteId) return { ok: false, error: "缺少帖子 ID，无法拉取" };
  return runExclusivePageTask(async () => {
    deepScanCancelled = false;
    const noteId = note.noteId;
    const showProcess = Boolean(note.showProcess || note.process);
    let progressTabId = preferredTabId || null;
    broadcastPullProgress({
      noteId, phase: "open", process: showProcess, title: note.title || "准备点击帖子并打开详情",
      note: showProcess ? note : undefined
    }, progressTabId);
    try {
      const config = await getConfig();
      const activeTab = await activeXhsTab(preferredTabId);
      if (!activeTab?.id) throw new Error("找不到当前小红书页面");
      progressTabId = activeTab.id;
      await ensureContentInjected(activeTab.id);
      broadcastPullProgress({
        noteId, phase: "body", process: showProcess,
        title: "已定位当前小红书标签页，正在打开详情并读取正文"
      }, progressTabId);
      const inline = await chrome.tabs.sendMessage(activeTab.id, {
        type: "readNoteInPage",
        note: { ...note, noteId, showProcess, allComments: true }
      }).catch((error) => ({ ok: false, error: error?.message || "当前页面未连接插件" }));
      if (!inline?.ok || !inline.note?.content) {
        throw new Error(inline?.error || "当前页面尚未读到完整正文，请先让帖子卡片和详情层加载完成");
      }

      const detail = inline;
      const extracted = inline;
      const comments = Array.isArray(extracted.comments) ? extracted.comments : [];
      const commentStatus = extracted.status || "partial";
      const commentError = extracted.commentError || "";

      broadcastPullProgress({
        noteId, phase: "media", process: showProcess,
        title: `正文与评论已读取，正在保存 ${detail.note.imageUrls?.length || 0} 张图片、${detail.note.videoUrls?.length || 0} 个视频`,
        note: showProcess ? detail.note : undefined,
        imageCount: detail.note.imageUrls?.length || 0,
        videoCount: detail.note.videoUrls?.length || 0,
        commentCount: comments.length,
        commentRows: showProcess ? comments.slice(0, 12) : undefined
      }, progressTabId);
      // Let the content-side panel paint the media stage before the bridge
      // request begins the combined media/Excel/SQLite write.
      await delay(120);
      const result = await bridgeApi("/api/pull", {
        method: "POST",
        body: JSON.stringify({
          note: detail.note,
          comments,
          expectedCount: extracted?.expectedCount || 0,
          explicitEmptyVerified: extracted?.explicitEmptyVerified === true,
          collectionEvidence: extracted?.collectionEvidence || {},
          commentStatus,
          commentError,
          collectedAt: new Date().toISOString()
        }),
        timeoutMs: 10 * 60 * 1000
      });
      requireConsistencyVerified(result, "帖子拉取");
      broadcastPullProgress({
        noteId, phase: "excel", process: showProcess,
        title: "素材与 CSV / SQLite 已写入，正在核对结果",
        note: showProcess ? {
          ...detail.note,
          mediaDir: result.mediaDir || "",
          mediaFiles: Array.isArray(result.mediaFiles) ? result.mediaFiles : []
        } : undefined,
        imageCount: result.imageCount ?? result.mediaCount ?? detail.note.imageUrls?.length ?? 0,
        videoCount: result.videoCount ?? detail.note.videoUrls?.length ?? 0,
        mediaFileCount: result.mediaFileCount || 0,
        mediaDir: result.mediaDir || "",
        mediaFiles: result.mediaFiles || [],
        excelPath: result.excelPath || "",
        excelRow: result.excelRow || 0,
        commentCount: comments.length,
        commentRows: showProcess ? comments.slice(0, 12) : undefined
      }, progressTabId);
      await delay(120);
      const finalResult = await withSyncAlert(noteId, { ...extracted, note: detail.note, comments }, {
        ...result,
        noteId,
        detailRead: true,
        commentStatus: result.commentStatus || commentStatus,
        commentError: result.commentError || commentError,
        commentCount: result.currentCount ?? comments.length,
        note: showProcess ? {
          ...detail.note,
          mediaDir: result.mediaDir || "",
          mediaFiles: Array.isArray(result.mediaFiles) ? result.mediaFiles : []
        } : undefined,
        commentRows: showProcess ? comments.slice(0, 12) : undefined,
        process: showProcess
      });
      broadcastPullProgress({ noteId, phase: "done", done: true, ...finalResult }, progressTabId);
      await broadcastLocalNoteState(noteId, {
        deleted: false, found: true, inExcel: true, status: "known",
        pullStatus: finalResult.pullStatus || "synced", relevanceStatus: "relevant",
        consistencyVerified: Boolean(finalResult.consistencyVerified)
      });
      return finalResult;
    } catch (error) {
      const result = { ok: false, noteId, process: showProcess, phase: "excel", error: error.message || "拉取失败" };
      broadcastPullProgress({ noteId, phase: "failed", done: true, ...result }, progressTabId);
      return result;
    }
  });
}

function isBridgeConnectivityError(error) {
  const message = String(error?.message || error || "");
  return /failed to fetch|networkerror|network error|err_connection|connection refused|load failed|响应超时|fetch.*failed/i.test(message);
}

function isReadOnlyBridgeRequest(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return true;
  return method === "POST" && [
    "/api/comments/compare", "/api/data-overview/query", "/api/data-overview/values", "/api/data-overview/export"
  ].includes(String(path).split("?")[0]);
}

async function bridgeApi(path, options = {}) {
  const readOnly = isReadOnlyBridgeRequest(path, options);
  if (!readOnly) {
    bridgeWritesInFlight += 1;
    bridgeReadGeneration += 1;
    bridgeReadTasks.clear();
  }
  try {
    const config = await getConfig();
    const { timeoutMs = REQUEST_TIMEOUT_MS, noRecovery = false, expectedBridgeUrl = "", shouldCancel = null, ...fetchOptions } = options || {};
    if (expectedBridgeUrl && config.bridgeUrl !== expectedBridgeUrl) {
      throw new Error("本地连接配置已变更，本批次停止提交，请重新同步");
    }
    const endpoint = bridgeEndpoint(config.bridgeUrl, path);
    // Warm up a known-offline bridge BEFORE sending a write, never by replaying
    // an ambiguous request whose response may have been lost after commit.
    if (!readOnly && !noRecovery && ["idle", "offline", "error"].includes(bridgeState.status)) {
      const ready = await ensureBridge();
      if (!ready?.ok) throw new Error(`Bridge 连接失败：${ready?.error || "启动失败"}`);
      const latest = await getConfig();
      if (latest.bridgeUrl !== config.bridgeUrl) throw new Error("本地连接配置已变更，本次写入尚未提交，请重新操作");
    }
    const shareable = readOnly && !bridgeWritesInFlight && !fetchOptions.signal && !shouldCancel;
    const key = shareable ? JSON.stringify([
      bridgeReadGeneration, endpoint, String(fetchOptions.method || "GET").toUpperCase(),
      fetchOptions.body || "", fetchOptions.headers || {}, timeoutMs, noRecovery
    ]) : null;
    let task = key === null ? null : bridgeReadTasks.get(key);
    if (!task) {
      task = (async () => {
        try {
          // Check at the actual send boundary, after config/startup awaits.
          // Already-sent writes are never aborted/replayed; they drain normally.
          if (typeof shouldCancel === "function" && shouldCancel()) {
            const error = new Error("同步已取消，本次写入尚未提交");
            error.code = "BATCH_SYNC_CANCELLED";
            throw error;
          }
          return await fetchJson(endpoint, fetchOptions, timeoutMs);
        } catch (firstError) {
          if (noRecovery || !isBridgeConnectivityError(firstError)) throw firstError;
          const recovered = await ensureBridge().catch(error => ({ ok: false, error: error?.message }));
          if (!readOnly) {
            const error = new Error(`本次写入结果尚未确认（${firstError.message}）；${recovered?.ok ? "本地连接已恢复" : "本地连接待恢复"}，请刷新核对数据后再决定是否重试，未自动重复提交`);
            error.code = "BRIDGE_WRITE_OUTCOME_UNKNOWN";
            error.outcomeUnknown = true;
            throw error;
          }
          if (!recovered?.ok) throw new Error(`Bridge 连接失败：${recovered?.error || firstError.message || "启动失败"}`);
          const latest = await getConfig();
          if (latest.bridgeUrl !== config.bridgeUrl) throw new Error("本地连接配置已变更，请重新查询");
          return fetchJson(endpoint, fetchOptions, timeoutMs);
        }
      })();
      if (key !== null) bridgeReadTasks.set(key, task);
    }
    try {
      // Each UI consumer receives its own JSON value, not a shared mutable object.
      return JSON.parse(JSON.stringify(await task));
    } finally {
      if (key !== null && bridgeReadTasks.get(key) === task) bridgeReadTasks.delete(key);
    }
  } finally {
    if (!readOnly) {
      bridgeWritesInFlight -= 1;
      bridgeReadGeneration += 1;
      bridgeReadTasks.clear();
    }
  }
}

function broadcastDeepScanProgress(progress) {
  chrome.runtime.sendMessage({ type: "deepScanProgress", ...progress }).catch(() => {});
}

async function runDeepScan(payload, originTabId) {
  const rawNotes = Array.isArray(payload?.notes) ? payload.notes : [];
  const byId = new Map();
  for (const note of rawNotes) {
    if (!note?.noteId || !validXhsNoteUrl(note.url) || byId.has(note.noteId)) continue;
    byId.set(note.noteId, note);
  }
  const allNotes = [...byId.values()];
  const notes = allNotes.slice(0, DEEP_SCAN_LIMIT);
  const batch = Math.max(1, Number(payload?.batch) || 1);
  if (!originTabId) return { ok: false, error: "找不到发起扫描的小红书页面" };
  if (!notes.length) {
    return {
      ok: true, deepScannedCount: 0, relevantCount: 0, notes: [], details: [],
      statuses: [], inserted: [], failedCount: 0, failedNoteIds: [], limited: false
    };
  }

  deepScanCancelled = false;
  const relevanceGroups = await getRelevanceGroups();
  const relevantNotes = [];
  const details = [];
  const failedNoteIds = [];
  let completed = 0;
  let failed = 0;
  let surfaceRestored = false;
  broadcastDeepScanProgress({ batch, current: 0, total: notes.length, found: 0, title: "准备后台补全文案" });
  for (const note of notes) {
      if (deepScanCancelled) break;
      broadcastDeepScanProgress({
        batch,
        current: completed,
        total: notes.length,
        found: relevantNotes.length,
        title: note.title || "正在打开帖子"
      });
      try {
        let detail = await chrome.tabs.sendMessage(originTabId, {
          type: "readNoteInPage", note
        }).catch(() => null);
        // Keep manual deep scan compatible with an already-open detail layer,
        // but never fall back to creating or navigating another tab.
        if (!detail?.ok) {
          detail = await chrome.tabs.sendMessage(originTabId, {
            type: "extractCurrentDetail", baseNote: note
          }).catch(() => null);
        }
        if (detail?.ok && detail.note) {
          details.push(detail.note);
          if (globalThis.XhsMonitorRelevance.match(detail.note, relevanceGroups).relevant) relevantNotes.push(detail.note);
        } else if (!detail?.cancelled) {
          failed += 1;
          failedNoteIds.push(note.noteId);
        }
      } catch (_error) {
        failed += 1;
        failedNoteIds.push(note.noteId);
      }
      completed += 1;
      if (await deepScanSurfaceLost(originTabId)) {
        surfaceRestored = await restoreDeepScanSurface(originTabId, payload.pageUrl);
        break;
      }
      broadcastDeepScanProgress({
        batch,
        current: completed,
        total: notes.length,
        found: relevantNotes.length,
        title: note.title || "帖子正文读取完成"
      });
      await delay(220);
  }

  let scanResult = { ok: true, statuses: [], inserted: [], filteredCount: 0 };
  if (details.length) {
    scanResult = await scanPage({
      ...payload,
      reason: "manual-deep",
      notes: details
    });
  }
  const selectedIds = new Set((scanResult.statuses || []).map((status) => status.noteId));
  const selectedNotes = details.filter((note) => selectedIds.has(note.noteId));
  const result = {
    ...scanResult,
    notes: selectedNotes,
    details,
    deepScannedCount: completed,
    requestedCount: allNotes.length,
    resolvedCount: details.length,
    relevantCount: selectedNotes.length,
    failedCount: failed,
    failedNoteIds,
    surfaceRestored,
    warning: surfaceRestored ? "深度核对过程中页面被小红书跳转，已自动恢复原搜索结果页；本批次已停止，可再次点击核对" : "",
    cancelled: deepScanCancelled,
    limited: allNotes.length > notes.length
  };
  if (result.ok) {
    await chrome.tabs.sendMessage(originTabId, {
      type: "applyDeepScanResult",
      notes: selectedNotes,
      details,
      statuses: result.statuses || []
    }).catch(() => {});
  }
  broadcastDeepScanProgress({
    batch,
    current: completed,
    total: notes.length,
    found: relevantNotes.length,
    done: true,
    cancelled: deepScanCancelled,
    title: deepScanCancelled ? "已停止补全" : "文案补全完成"
  });
  return result;
}

async function confirmNote(note) {
  if (!note?.noteId) return { ok: false, error: "缺少帖子 ID，无法收录" };
  const config = await getConfig();
  try {
    const result = await bridgeApi("/api/confirm", {
      method: "POST",
      body: JSON.stringify(note)
    });
    setBridgeState("online", { bridgeUrl: config.bridgeUrl, error: "" });
    return result;
  } catch (error) {
    setBridgeState("offline", { bridgeUrl: config.bridgeUrl, error: error.message });
    return { ok: false, offline: true, error: `未写入本地数据库：${error.message}` };
  }
}

async function ignoreNote(note) {
  if (!note?.noteId) return { ok: false, error: "缺少帖子 ID，无法忽略" };
  const config = await getConfig();
  try {
    const result = await bridgeApi("/api/ignore", {
      method: "POST",
      body: JSON.stringify(note)
    });
    if (!result?.ok || (result.pulled && !result.consistencyVerified)) {
      throw new Error(result?.error || "忽略状态未通过全存储一致性校验");
    }
    await broadcastLocalNoteState(note.noteId, {
      found: true, inExcel: Boolean(result.pulled), status: "ignored",
      postStatus: result.postStatus || (result.pulled ? "已删除" : "存在"),
      isDeleted: Boolean(result.pulled),
      locallyReconciled: true, consistencyVerified: true
    });
    setBridgeState("online", { bridgeUrl: config.bridgeUrl, error: "" });
    return result;
  } catch (error) {
    setBridgeState("offline", { bridgeUrl: config.bridgeUrl, error: error.message });
    return { ok: false, offline: true, error: `未更新本地数据库：${error.message}` };
  }
}


async function restoreNote(note) {
  if (!note?.noteId) return { ok: false, error: "缺少帖子 ID，无法恢复" };
  const result = await bridgeApi("/api/restore", {
    method: "POST", body: JSON.stringify(note), timeoutMs: 60000
  });
  if (!result?.ok || (result.pulled && !result.consistencyVerified)) {
    throw new Error(result?.error || "恢复状态未通过全存储一致性校验");
  }
  await broadcastLocalNoteState(note.noteId, {
    found: true, inExcel: Boolean(result.pulled), status: result.status || "known",
    postStatus: result.postStatus || "存在", isDeleted: false,
    locallyReconciled: true, consistencyVerified: true
  });
  return result;
}

function commentLocatorUrl(note = {}) {
  const noteId = String(note.noteId || "").trim();
  if (!/^[a-f0-9]{24}$/i.test(noteId)) throw new Error("原帖 ID 无效");
  let url;
  try {
    const candidate = new URL(note.url);
    if (candidate.protocol === "https:" && ["www.xiaohongshu.com", "xiaohongshu.com"].includes(candidate.hostname)
      && !candidate.username && !candidate.password && !candidate.port
      && new RegExp(`^/(?:explore|search_result|discovery/item)/${noteId}/?$`, "i").test(candidate.pathname)) url = candidate;
  } catch (_error) {}
  if (!url) url = new URL(`https://www.xiaohongshu.com/explore/${noteId}`);
  url.hash = "";
  url.searchParams.delete("xhs_monitor_batch");
  url.searchParams.set("xhs_monitor_locate", "1");
  return url.href;
}

const commentNavigationTasks = new Map();
async function openCommentInPage(commentId) {
  const id = String(commentId || "").trim();
  if (!id || id.length > 256) throw new Error("缺少有效评论 ID");
  if (commentNavigationTasks.has(id)) return commentNavigationTasks.get(id);
  const task = (async () => {
    const target = await bridgeApi(`/api/data-overview/comment-target?commentId=${encodeURIComponent(id)}`);
    if (!target?.ok || !target.note?.noteId || target.comment?.commentId !== id
      || target.comment?.noteId !== target.note.noteId) throw new Error("评论与原帖关联校验未通过");
    // Never reuse a sync reader or the user's existing tab. The marker suppresses
    // automatic background auditing for this read-only navigation surface.
    const url = commentLocatorUrl(target.note);
    const tab = await chrome.tabs.create({ url, active: true });
    if (!tab?.id) throw new Error("帖子标签页创建失败");
    const started = Date.now();
    while (Date.now() - started < DETAIL_LOAD_TIMEOUT_MS) {
      const current = await chrome.tabs.get(tab.id);
      const currentUrl = current.url || current.pendingUrl || "";
      if (currentUrl && currentUrl !== "about:blank") {
        const parsed = new URL(currentUrl);
        if (!["www.xiaohongshu.com", "xiaohongshu.com"].includes(parsed.hostname)
          || !parsed.pathname.includes(target.note.noteId)) throw new Error("页面已跳转，评论定位已停止");
      }
      const ready = await chrome.tabs.sendMessage(tab.id, { type: "getPageInfo" }).catch(() => null);
      if (ready?.contentVersion === CONTENT_SCRIPT_VERSION) {
        const result = await chrome.tabs.sendMessage(tab.id, { type: "locateCommentInPage", ...target });
        return { ...result, tabId: tab.id };
      }
      await delay(150);
    }
    throw new Error("帖子打开等待超时；请查看新标签页的登录或加载状态后重试");
  })();
  commentNavigationTasks.set(id, task);
  try { return await task; } finally { if (commentNavigationTasks.get(id) === task) commentNavigationTasks.delete(id); }
}

async function openDataOverviewPage() {
  const url = chrome.runtime.getURL("data-overview.html");
  const tab = await chrome.tabs.create({ url, active: true });
  return { ok: true, tabId: tab?.id || null, url };
}

async function getStats() {
  const config = await getConfig();
  try {
    const result = await bridgeApi("/api/stats");
    setBridgeState("online", { bridgeUrl: config.bridgeUrl, error: "", version: result.version || "" });
    return result;
  } catch (error) {
    setBridgeState("offline", { bridgeUrl: config.bridgeUrl, error: error.message });
    return { ok: false, offline: true, total: null, byStatus: {}, error: error.message };
  }
}

async function getNotes(status = "", limit = 100) {
  const config = await getConfig();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
  const safeStatus = ["new", "known", "confirmed", "ignored"].includes(status) ? status : "";
  try {
    const result = await bridgeApi(`/api/notes?status=${encodeURIComponent(safeStatus)}&limit=${safeLimit}`);
    const notes = (result.notes || []).map((note) => {
      let payload = {};
      try { payload = JSON.parse(note.payload_json || "{}"); } catch (_error) { payload = {}; }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};
      return {
      noteId: note.note_id || "",
      title: note.title || "未命名帖子",
      author: note.author || "",
      authorUrl: payload.authorUrl || payload.userUrl || "",
      url: note.url || payload.url || "",
      firstSeenAt: note.first_seen_at || "",
      lastSeenAt: note.last_seen_at || "",
      status: note.status || safeStatus,
      source: note.source || "",
      content: note.content || "",
      tags: note.tags || "",
      aiAnalysisStatus: note.ai_analysis_status || "not_analyzed",
      postSentiment: note.post_sentiment || "",
      isNegative: Boolean(note.is_negative),
      riskLevel: note.risk_level || "",
      issueCategories: note.issue_categories || "[]",
      aiSummary: note.ai_summary || "",
      aiConfidence: Number(note.ai_confidence) || 0,
      reviewStatus: note.review_status || "pending_review",
      commentCollectionStatus: note.comment_collection_status || "not_started",
      commentCountCollected: Number(note.comment_count_collected) || 0,
      negativeCommentCount: Number(note.negative_comment_count) || 0,
      pullStatus: note.pull_status || "not_started",
      pullError: note.pull_error || "",
      mediaStatus: note.media_status || "not_started",
      mediaDir: note.media_dir || "",
      mediaFileCount: Number(note.media_file_count) || 0,
      mediaError: note.media_error || "",
      accessStatus: note.access_status || "",
      accessError: note.access_error || "",
      lastAccessCheckedAt: note.last_access_checked_at || "",
      postStatus: note.post_status || "存在",
      isDeleted: Boolean(note.is_deleted),
      deletedAt: note.deleted_at || "",
      lastPresenceCheckedAt: note.last_presence_checked_at || ""
    };
    });
    return { ok: true, notes };
  } catch (error) {
    return { ok: false, offline: true, notes: [], error: error.message };
  }
}

async function getPendingNotes(limit = 1000) {
  const result = await getNotes("new", limit);
  if (!result.ok) return result;
  return {
    ...result,
    notes: result.notes.filter((note) => note.source !== "existing_xlsx")
  };
}

async function setConfig(nextConfig) {
  const bridgeUrl = normalizeBridgeUrl(nextConfig?.bridgeUrl || DEFAULT_CONFIG.bridgeUrl);
  const targetKeywords = normalizeKeywords(nextConfig?.targetKeywords);
  if (!targetKeywords.length) throw new Error("至少保留一个自动扫描关键词");
  const next = {
    bridgeUrl,
    targetKeywords,
    enabled: nextConfig?.enabled !== false
  };
  await chrome.storage.local.set(next);
  setBridgeState("idle", { bridgeUrl, error: "" });
  return { ok: true, config: next };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "commentReadHeartbeat") return { ok: true };
    if (message.type === "ensureContentInjected") {
      const tab = await activeXhsTab(message.tabId || sender.tab?.id || null);
      if (!tab?.id) throw new Error("没有找到当前小红书标签页");
      return ensureContentInjected(tab.id);
    }
    if (message.type === "sendToActiveXhsTab") {
      const tab = await activeXhsTab(message.tabId || sender.tab?.id || null);
      if (!tab?.id) throw new Error("没有找到当前小红书标签页");
      return sendTabMessage(tab.id, message.payload || {});
    }
    if (message.type === "scanPage") return scanPage(message.payload || {});
    if (message.type === "confirmNote") return confirmNote(message.note || {});
    if (message.type === "pullNote") return pullNote(message.note || {}, sender.tab?.id || null);
    if (message.type === "deletePulledNote") {
      return deletePulledNoteAndBroadcast(message.noteId || message.note?.noteId || "");
    }
    if (message.type === "getNoteStatus") return getNoteStatus(message.noteId || message.note?.noteId || "");
    if (message.type === "analyzeNoteRelevance") return analyzeNoteRelevance(message.note || {}, sender.tab?.id || null);
    if (message.type === "summarizeCurrentNote") return summarizeCurrentNote(message.note || {}, sender.tab?.id || null);
    if (message.type === "getCurrentNoteComments") return readCurrentNoteComments(message.note || {}, sender.tab?.id || null);
    if (message.type === "auditCurrentNoteComments") return auditCurrentNoteComments(message.note || {}, sender.tab?.id || null);
    if (message.type === "syncCurrentNoteComments") return syncCurrentNoteComments(message);
    if (message.type === "syncAllPulledComments") return startAllPulledCommentSync();
    if (message.type === "syncFailedPulledComments") return startFailedPulledCommentSync();
    if (message.type === "cancelAllPulledComments") return cancelAllPulledCommentSync();
    if (message.type === "getBatchCommentSyncState") return getBatchCommentSyncState();
    if (message.type === "getSyncAlertSettings") return getSyncAlertSettings();
    if (message.type === "setSyncAlertDisposition") return setSyncAlertDisposition(message);
    if (message.type === "getUnreachableNotes") return getUnreachableNotes();
    if (message.type === "deleteUnreachableNotes") return deleteUnreachableNotes();
    if (message.type === "deleteReviewedFailures") return deleteReviewedFailures(message.noteIds || []);
    if (message.type === "ignoreBatchFailures") return ignoreBatchFailures(message.noteIds || []);
    if (message.type === "suggestCommentReply") return suggestCommentReply(message, sender.tab?.id || null);
    if (message.type === "applyCommentReply") return applyCommentReply(message, sender.tab?.id || null);
    if (message.type === "getNoteSummary") {
      return bridgeApi(`/api/ai/summary?noteId=${encodeURIComponent(message.noteId || "")}`);
    }
    if (message.type === "openLocalArtifact") {
      return bridgeApi("/api/open", {
        method: "POST",
        body: JSON.stringify(message.payload || {}),
        timeoutMs: 15000
      });
    }
    if (message.type === "ignoreNote") return ignoreNote(message.note || {});
    if (message.type === "startBridge") return ensureBridge();
    if (message.type === "openFloatingWindow") return openFloatingWindow();
    if (message.type === "openBallWindow") return openBallWindow();
    if (message.type === "expandBall") return expandBallWindow();
    if (message.type === "updateBallPosition") return updateBallPosition(message.top);
    if (message.type === "closeFloatingWindow") return closeFloatingWindow();
    if (message.type === "restoreSidePanel") return restoreSidePanel();
    if (message.type === "getBridgeState") return checkBridgeHealth();
    if (message.type === "getStats") return getStats();
    if (message.type === "getDataHealth") return bridgeApi("/api/data-health", { timeoutMs: 60000 });
    if (message.type === "openDataOverview") return openDataOverviewPage();
    if (message.type === "getDataOverviewSchema") return bridgeApi("/api/data-overview/schema", { timeoutMs: 120000 });
    if (message.type === "queryDataOverview") {
      return bridgeApi("/api/data-overview/query", {
        method: "POST", body: JSON.stringify(message.payload || {}), timeoutMs: message.payload?.semanticSearch ? 300000 : 60000
      });
    }
    if (message.type === "exportDataOverview") {
      return bridgeApi("/api/data-overview/export", {
        method: "POST", body: JSON.stringify(message.payload || {}), timeoutMs: 300000
      });
    }
    if (message.type === "getDataOverviewValues") {
      return bridgeApi("/api/data-overview/values", {
        method: "POST", body: JSON.stringify(message.payload || {}), timeoutMs: 60000
      });
    }
    if (message.type === "deleteDataOverviewRecords") {
      const result = await bridgeApi("/api/data-overview/delete", {
        method: "POST", body: JSON.stringify(message.payload || {}), timeoutMs: 300000
      });
      for (const noteId of result.deletedNoteIds || []) {
        await broadcastLocalNoteState(noteId, {
          deleted: true, found: false, inExcel: false, status: "new",
          pullStatus: "not_started", relevanceStatus: "unknown"
        });
      }
      return result;
    }
    if (message.type === "getDataOverviewMedia") {
      const payload = message.payload || {};
      if (!["notes", "comments"].includes(payload.dataset)) throw new Error("图片数据表无效");
      const query = new URLSearchParams({ dataset: payload.dataset, recordId: String(payload.recordId || "") });
      if (payload.index !== undefined) {
        if (!Number.isInteger(payload.index) || payload.index < 0) throw new Error("图片序号无效");
        query.set("index", String(payload.index)); query.set("revision", String(payload.revision || ""));
      }
      return bridgeApi(`/api/data-overview/media?${query}`, { timeoutMs: 15000 });
    }
    if (message.type === "locateDataOverviewComment") return openCommentInPage(message.commentId);
    if (message.type === "openDataOverviewRecord") {
      const url = String(message.url || "");
      if (!/^https:\/\//i.test(url)) throw new Error("记录中没有可打开的链接");
      const tab = await chrome.tabs.create({ url, active: true });
      return { ok: true, tabId: tab?.id || null };
    }
    if (message.type === "repairDataHealth") {
      return bridgeApi("/api/data-health/repair", { method: "POST", body: "{}", timeoutMs: 180000 });
    }
    if (message.type === "getChangeEvents") {
      const query = new URLSearchParams({
        limit: String(message.limit || 100),
        unreadOnly: message.unreadOnly ? "true" : "false"
      });
      return bridgeApi(`/api/changes?${query}`, { timeoutMs: 30000 });
    }
    if (message.type === "acknowledgeChangeEvents") {
      return bridgeApi("/api/changes/ack", {
        method: "POST", body: JSON.stringify({ ids: message.ids || [], all: Boolean(message.all) }), timeoutMs: 30000
      });
    }
    if (message.type === "getWatchlist") {
      return bridgeApi(`/api/watchlist?limit=${encodeURIComponent(message.limit || 200)}`, { timeoutMs: 30000 });
    }
    if (message.type === "setWatchlist") {
      return bridgeApi("/api/watchlist", { method: "POST", body: JSON.stringify(message.payload || {}), timeoutMs: 30000 });
    }
    if (message.type === "generateWeeklyReport") {
      return bridgeApi("/api/reports/weekly", { method: "POST", body: JSON.stringify(message.payload || {}), timeoutMs: 120000 });
    }
    if (message.type === "getLatestWeeklyReport") return bridgeApi("/api/reports/weekly/latest", { timeoutMs: 30000 });
    if (message.type === "openWeeklyReport") {
      return bridgeApi("/api/reports/weekly/open", {
        method: "POST", body: JSON.stringify({ target: message.target || "html" }), timeoutMs: 30000
      });
    }
    if (message.type === "reloadExcel") return bridgeApi("/api/excel/reload", { method: "POST", body: "{}", timeoutMs: 30000 });
    if (message.type === "getPendingNotes") return getPendingNotes(message.limit);
    if (message.type === "getNotes") return getNotes(message.status, message.limit);
    if (message.type === "getConfig") return getConfig();
    if (message.type === "getRelevanceGroups") {
      return { ok: true, groups: await getRelevanceGroups(Boolean(message.force)) };
    }
    if (message.type === "setConfig") return setConfig(message.config || {});
    if (message.type === "collectComments") return collectComments(message.note || {});
    if (message.type === "getAIStatus") return bridgeApi("/api/ai/status");
    if (message.type === "getNoteAnalysis") {
      return bridgeApi(`/api/ai/note?noteId=${encodeURIComponent(message.noteId || "")}`);
    }
    if (message.type === "getAIJobs") {
      const query = new URLSearchParams({ status: message.status || "", limit: String(message.limit || 100) });
      return bridgeApi(`/api/ai/jobs?${query}`);
    }
    if (message.type === "getNoteAIProgress") {
      const query = new URLSearchParams({ limit: "100" });
      const jobsResult = await bridgeApi(`/api/ai/jobs?${query}`);
      const jobs = jobsResult?.ok ? (jobsResult.jobs || []) : [];
      const job = jobs.find((item) => item.target_type === "note" && String(item.target_id) === String(message.noteId || ""));
      if (!job) return { ok: true, status: "", percent: 0, lastError: "" };
      return { ok: true, status: job.status, percent: estimateJobPercent(job), lastError: job.last_error || "" };
    }
    if (message.type === "getAIHistory") {
      const query = new URLSearchParams({ targetType: message.targetType || "", targetId: message.targetId || "", limit: String(message.limit || 100) });
      return bridgeApi(`/api/ai/history?${query}`);
    }
    if (message.type === "getAISettings") return bridgeApi("/api/ai/settings");
    if (message.type === "saveAISettings") return bridgeApi("/api/ai/settings", { method: "POST", body: JSON.stringify(message.settings || {}) });
    if (message.type === "testAIConnection") return bridgeApi("/api/ai/test", { method: "POST", body: JSON.stringify(message.settings || {}), timeoutMs: 60000 });
    if (message.type === "clearAIHistory") return bridgeApi("/api/ai/history/clear", { method: "POST", body: "{}" });
    if (message.type === "analyzeTarget") return bridgeApi(message.force ? "/api/ai/retry" : "/api/ai/analyze", { method: "POST", body: JSON.stringify({ targetType: message.targetType, targetId: message.targetId, force: Boolean(message.force) }) });
    if (message.type === "getNegativeSummary") return bridgeApi("/api/negative/summary");
    if (message.type === "getNegativeItems") {
      const query = new URLSearchParams({ targetType: message.targetType || "", confidence: message.confidence || "high", limit: String(message.limit || 200) });
      return bridgeApi(`/api/negative/items?${query}`);
    }
    if (message.type === "updateReview") return bridgeApi("/api/review", { method: "POST", body: JSON.stringify(message.payload || {}) });
    if (message.type === "restoreNote") return restoreNote(message.note || {});
    if (message.type === "cancelDeepScan") {
      deepScanCancelled = true;
      return { ok: true, cancelled: true };
    }
    if (message.type === "deepScanNotes") {
      if (deepScanPromise) {
        await deepScanPromise.catch(() => {});
        return {
          ok: true,
          joinedExisting: true,
          deepScannedCount: 0,
          relevantCount: 0,
          notes: [],
          details: [],
          statuses: [],
          inserted: [],
          failedCount: 0,
          failedNoteIds: [],
          limited: true,
          cancelled: false
        };
      }
      deepScanPromise = runExclusivePageTask(() => runDeepScan(message.payload || {}, sender.tab?.id || null));
      try {
        return await deepScanPromise;
      } finally {
        deepScanPromise = null;
      }
    }
    return { ok: false, error: `未知消息类型：${message.type}` };
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
