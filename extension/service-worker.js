importScripts("relevance.js");

const DEFAULT_CONFIG = {
  bridgeUrl: "http://127.0.0.1:17881",
  targetKeywords: ["品牌词"],
  enabled: true
};
const NATIVE_HOST_NAME = "com.xhsmonitor.bridge";
const REQUEST_TIMEOUT_MS = 6500;
const HEALTH_TIMEOUT_MS = 1800;
const DEEP_SCAN_LIMIT = 60;
const DETAIL_LOAD_TIMEOUT_MS = 12000;
const CONTENT_SCRIPT_FILES = ["relevance.js", "page-context.js", "note-utils.js", "detail-store.js", "comment-utils.js", "content.js"];
const CONTENT_SCRIPT_VERSION = "0.20.3";
const CONTENT_STYLE_FILES = ["content.css"];
const contentInjectionTasks = new Map();

let nativeStartPromise = null;
let bridgeEnsurePromise = null;
let deepScanPromise = null;
let pageTaskPromise = null;
let deepScanCancelled = false;
let relevanceGroupsCache = null;
let relevanceGroupsFetchedAt = 0;
let readerTabId = null;
let readerCloseTimer = null;
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
const FLOATING_BALL_SIZE = 92;

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

// 缩小为右侧吸附的圆形悬浮球（类 iPhone 辅助触控）
async function openBallWindow() {
  if (!chrome.windows?.create) {
    return { ok: false, error: "当前 Chrome 不支持悬浮球模式" };
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
    width: FLOATING_BALL_SIZE,
    height: FLOATING_BALL_SIZE,
    left: Math.max(0, Math.round(baseLeft + baseWidth - FLOATING_BALL_SIZE - 6)),
    top,
    focused: true,
    type: "popup",
    url: chrome.runtime.getURL("sidepanel.html?mode=ball")
  });
  if (!popup?.id) return { ok: false, error: "悬浮球创建失败" };
  await chrome.storage.local.set({
    floatingWindowId: popup.id,
    floatingWindowKind: "ball",
    floatingOriginWindowId: origin?.id || null
  });
  await closeSidePanel(origin?.id);
  return { ok: true, windowId: popup.id, originWindowId: origin?.id || null };
}

// 点击悬浮球：展开为完整悬浮窗
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

chrome.runtime.onInstalled.addListener(async () => {
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
    const result = await bridgeApi("/api/scan", {
      method: "POST",
      // Bridge must see every card. It checks Excel identity before applying
      // the relevance gate, otherwise an Excel row with an unloaded caption
      // can disappear before comparison.
      body: JSON.stringify({ ...payload, notes: allNotes })
    });
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
  throw new Error("当前版本只允许在已打开的小红书页面内读取，不创建后台标签页");
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
  if (!noteId) return { ok: true, found: false, inExcel: false, pullStatus: "not_started", relevanceStatus: "unknown" };
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
    const result = await sendTabMessage(activeTab.id, {
      type: "readNoteInPage", note: { ...note, showProcess: false, process: false, allComments: true }
    });
    if (!result?.ok) throw new Error(result?.error || "评论区读取失败");
    return result;
  });
}

async function auditCurrentNoteComments(note, preferredTabId = null) {
  const extracted = await readCurrentNoteComments(note, preferredTabId);
  const snapshot = {
    note: extracted.note || note,
    comments: Array.isArray(extracted.comments) ? extracted.comments : [],
    expectedCount: Number(extracted.expectedCount) || 0,
    status: extracted.status || "partial"
  };
  const comparison = await bridgeApi("/api/comments/compare", {
    method: "POST", body: JSON.stringify({ noteId: note.noteId, ...snapshot }), timeoutMs: 60000
  });
  return { ...comparison, snapshot };
}

async function syncCurrentNoteComments(payload) {
  const snapshot = payload?.snapshot || {};
  return bridgeApi("/api/comments/sync", {
    method: "POST",
    body: JSON.stringify({
      noteId: payload?.noteId || snapshot.note?.noteId || "",
      note: snapshot.note || payload?.note || {},
      comments: Array.isArray(snapshot.comments) ? snapshot.comments : [],
      expectedCount: Number(snapshot.expectedCount) || 0,
      status: snapshot.status || "partial"
    }),
    timeoutMs: 120000
  });
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
          commentStatus,
          commentError,
          collectedAt: new Date().toISOString()
        }),
        timeoutMs: 10 * 60 * 1000
      });
      broadcastPullProgress({
        noteId, phase: "excel", process: showProcess,
        title: "素材与 Excel / SQLite 已写入，正在核对结果",
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
      const finalResult = {
        ...result,
        noteId,
        detailRead: true,
        commentStatus,
        commentError,
        commentCount: comments.length,
        note: showProcess ? {
          ...detail.note,
          mediaDir: result.mediaDir || "",
          mediaFiles: Array.isArray(result.mediaFiles) ? result.mediaFiles : []
        } : undefined,
        commentRows: showProcess ? comments.slice(0, 12) : undefined,
        process: showProcess
      };
      broadcastPullProgress({ noteId, phase: "done", done: true, ...finalResult }, progressTabId);
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

async function bridgeApi(path, options = {}) {
  const config = await getConfig();
  const { timeoutMs = REQUEST_TIMEOUT_MS, noRecovery = false, ...fetchOptions } = options || {};
  const endpoint = bridgeEndpoint(config.bridgeUrl, path);
  try {
    return await fetchJson(endpoint, fetchOptions, timeoutMs);
  } catch (firstError) {
    if (noRecovery || !isBridgeConnectivityError(firstError)) throw firstError;
    const recovered = await ensureBridge();
    if (!recovered?.ok) {
      throw new Error(`Bridge 连接失败：${recovered?.error || firstError.message || "启动失败"}`);
    }
    return fetchJson(endpoint, fetchOptions, timeoutMs);
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
    setBridgeState("online", { bridgeUrl: config.bridgeUrl, error: "" });
    return result;
  } catch (error) {
    setBridgeState("offline", { bridgeUrl: config.bridgeUrl, error: error.message });
    return { ok: false, offline: true, error: `未更新本地数据库：${error.message}` };
  }
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
    const result = await fetchJson(
      bridgeEndpoint(config.bridgeUrl, `/api/notes?status=${encodeURIComponent(safeStatus)}&limit=${safeLimit}`)
    );
    const notes = (result.notes || []).map((note) => ({
      noteId: note.note_id || "",
      title: note.title || "未命名帖子",
      author: note.author || "",
      url: note.url || "",
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
      mediaError: note.media_error || ""
    }));
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
      return bridgeApi("/api/note/delete", {
        method: "POST",
        body: JSON.stringify({ noteId: message.noteId || message.note?.noteId || "" }),
        timeoutMs: 60000
      });
    }
    if (message.type === "getNoteStatus") return getNoteStatus(message.noteId || message.note?.noteId || "");
    if (message.type === "analyzeNoteRelevance") return analyzeNoteRelevance(message.note || {}, sender.tab?.id || null);
    if (message.type === "summarizeCurrentNote") return summarizeCurrentNote(message.note || {}, sender.tab?.id || null);
    if (message.type === "getCurrentNoteComments") return readCurrentNoteComments(message.note || {}, sender.tab?.id || null);
    if (message.type === "auditCurrentNoteComments") return auditCurrentNoteComments(message.note || {}, sender.tab?.id || null);
    if (message.type === "syncCurrentNoteComments") return syncCurrentNoteComments(message);
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
    if (message.type === "restoreNote") return bridgeApi("/api/restore", { method: "POST", body: JSON.stringify(message.note || {}) });
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
