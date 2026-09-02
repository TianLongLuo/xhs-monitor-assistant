"use strict";

const byId = (id) => document.getElementById(id);
const elements = {
  notesCount: byId("notesCount"), commentsCount: byId("commentsCount"),
  railHealthDot: byId("railHealthDot"), railHealthText: byId("railHealthText"), railHealthMeta: byId("railHealthMeta"),
  datasetTitle: byId("datasetTitle"), datasetSubtitle: byId("datasetSubtitle"),
  refreshSchema: byId("refreshSchema"), exportCurrent: byId("exportCurrent"),
  lineageRibbon: byId("lineageRibbon"), consistencyTitle: byId("consistencyTitle"),
  consistencyMeta: byId("consistencyMeta"), snapshotCode: byId("snapshotCode"),
  globalSearch: byId("globalSearch"), toggleFilters: byId("toggleFilters"), filterCount: byId("filterCount"),
  toggleFields: byId("toggleFields"), fieldCount: byId("fieldCount"),
  toggleSort: byId("toggleSort"), sortCount: byId("sortCount"), resultCount: byId("resultCount"),
  filterPanel: byId("filterPanel"), filterLogic: byId("filterLogic"), filterRows: byId("filterRows"),
  addFilter: byId("addFilter"), clearFilters: byId("clearFilters"),
  fieldPanel: byId("fieldPanel"), fieldSearch: byId("fieldSearch"), fieldOptions: byId("fieldOptions"),
  selectDefaultFields: byId("selectDefaultFields"), selectAllFields: byId("selectAllFields"),
  sortPanel: byId("sortPanel"), sortRows: byId("sortRows"), addSort: byId("addSort"), clearSorts: byId("clearSorts"),
  queryBlocked: byId("queryBlocked"), blockedReason: byId("blockedReason"), retryHealth: byId("retryHealth"),
  dataSurface: byId("dataSurface"), tableViewport: byId("tableViewport"),
  tableHead: byId("tableHead"), tableBody: byId("tableBody"),
  tableEmpty: byId("tableEmpty"), tableLoading: byId("tableLoading"), pageMeta: byId("pageMeta"),
  infiniteSentinel: byId("infiniteSentinel"), loadMoreText: byId("loadMoreText"),
  recordDrawer: byId("recordDrawer"), drawerType: byId("drawerType"), drawerTitle: byId("drawerTitle"),
  drawerFields: byId("drawerFields"), closeDrawer: byId("closeDrawer"), copyRecord: byId("copyRecord"),
  openRecordLink: byId("openRecordLink"), toast: byId("toast")
};

const TITLES = {
  notes: ["帖子数据库", "本地全部帖子、业务状态、素材与评论计数。"],
  comments: ["评论数据库", "全部一级评论与回复，并联原帖的每一个字段。"]
};
const STATUS_FIELDS = new Set(["status", "pull_status", "post_status", "comment_status", "access_status", "review_status", "analysis_is_negative"]);
const LONG_FIELD_HINTS = ["content", "summary", "reason", "json", "error", "categories", "note"];
const MONO_FIELD_HINTS = ["_id", "url", "path", "dir", "hash", "json"];
const NO_VALUE_OPERATORS = new Set(["is_empty", "not_empty", "is_true", "is_false"]);
const STORAGE_KEY = "xhsMonitorDataOverviewStateV1";
const INFINITE_BATCH_SIZE = 100;

const state = {
  schema: null,
  dataset: "notes",
  snapshotToken: "",
  visibleFields: { notes: [], comments: [] },
  search: "",
  filterLogic: "and",
  filters: [],
  sorts: [],
  page: 0,
  pageSize: INFINITE_BATCH_SIZE,
  total: 0,
  rows: [],
  hasMore: true,
  loading: false,
  queryReady: false,
  currentRecord: null,
  querySerial: 0,
  queryPending: false,
  resetScheduled: false
};

let queryTimer = 0;
let toastTimer = 0;

function sendRuntime(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "本地数据请求失败"));
        return;
      }
      resolve(response);
    });
  });
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 2600);
}

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (saved.dataset === "notes" || saved.dataset === "comments") state.dataset = saved.dataset;
    if (saved.visibleFields && typeof saved.visibleFields === "object") {
      state.visibleFields.notes = Array.isArray(saved.visibleFields.notes) ? saved.visibleFields.notes : [];
      state.visibleFields.comments = Array.isArray(saved.visibleFields.comments) ? saved.visibleFields.comments : [];
    }
  } catch (_error) {}
}

function savePreferences() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    dataset: state.dataset,
    visibleFields: state.visibleFields
  }));
}

function datasetSchema() {
  return state.schema?.datasets?.[state.dataset] || { fields: [], total: 0 };
}

function fieldMap() {
  return new Map(datasetSchema().fields.map((field) => [field.key, field]));
}

function currentVisibleFields() {
  const available = fieldMap();
  const selected = state.visibleFields[state.dataset].filter((key) => available.has(key));
  if (selected.length) return selected;
  return datasetSchema().fields.filter((field) => field.defaultVisible).map((field) => field.key).slice(0, 18);
}

function operatorsFor(field) {
  return (state.schema?.operators || []).filter((operator) => operator.types.includes(field?.dataType || "text"));
}

function healthIssueText(health) {
  const critical = (health?.issues || []).filter((issue) => issue.severity === "critical");
  if (!critical.length) return health?.error || "本地数据尚未完成一致性校验";
  return critical.slice(0, 3).map((issue) => `${issue.title}（${issue.count || 0}）`).join("；");
}

function renderSchemaState() {
  const health = state.schema?.health || {};
  const summary = health.summary || {};
  elements.notesCount.textContent = Number(state.schema?.datasets?.notes?.total || 0).toLocaleString("zh-CN");
  elements.commentsCount.textContent = Number(state.schema?.datasets?.comments?.total || 0).toLocaleString("zh-CN");
  state.queryReady = state.schema?.queryReady === true;
  elements.lineageRibbon.dataset.state = state.queryReady ? "ready" : "blocked";
  elements.railHealthDot.dataset.state = state.queryReady ? "ready" : "blocked";
  elements.railHealthText.textContent = state.queryReady ? "数据一致，可查询" : "查询已锁定";
  elements.railHealthMeta.textContent = state.queryReady
    ? `${summary.csvNotes || 0} 篇 · ${summary.csvComments || 0} 条评论`
    : healthIssueText(health);
  elements.consistencyTitle.textContent = state.queryReady ? "全存储一致性校验已通过" : "一致性门禁已阻止查询";
  elements.consistencyMeta.textContent = state.queryReady
    ? `Bridge ${state.schema?.version || ""} · relationshipsConsistent=true · 只读快照`
    : healthIssueText(health);
  elements.snapshotCode.textContent = state.snapshotToken ? state.snapshotToken.slice(0, 14).toUpperCase() : "NO SNAPSHOT";
  elements.queryBlocked.hidden = state.queryReady;
  elements.blockedReason.textContent = healthIssueText(health);
  elements.dataSurface.hidden = !state.queryReady;
  document.querySelectorAll(".dataset-button").forEach((button) => button.classList.toggle("is-active", button.dataset.dataset === state.dataset));
  elements.datasetTitle.textContent = TITLES[state.dataset][0];
  elements.datasetSubtitle.textContent = TITLES[state.dataset][1];
}

function renderFieldOptions() {
  const query = elements.fieldSearch.value.trim().toLowerCase();
  const selected = new Set(currentVisibleFields());
  const groups = new Map();
  for (const field of datasetSchema().fields) {
    if (query && !`${field.label} ${field.key}`.toLowerCase().includes(query)) continue;
    if (!groups.has(field.source)) groups.set(field.source, []);
    groups.get(field.source).push(field);
  }
  elements.fieldOptions.replaceChildren();
  for (const [source, fields] of groups) {
    const group = document.createElement("section");
    group.className = "field-group";
    const title = document.createElement("strong");
    title.textContent = source;
    group.append(title);
    for (const field of fields) {
      const label = document.createElement("label");
      label.className = "field-option";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = selected.has(field.key);
      input.dataset.field = field.key;
      const name = document.createElement("span");
      name.textContent = field.label;
      const type = document.createElement("small");
      type.textContent = field.dataType;
      label.append(input, name, type);
      group.append(label);
    }
    elements.fieldOptions.append(group);
  }
  elements.fieldCount.textContent = String(selected.size);
}

function fieldOptionsHtml(selectedKey = "") {
  const groups = new Map();
  for (const field of datasetSchema().fields) {
    if (!groups.has(field.source)) groups.set(field.source, []);
    groups.get(field.source).push(field);
  }
  return [...groups].map(([source, fields]) => {
    const options = fields.map((field) => `<option value="${escapeHtml(field.key)}"${field.key === selectedKey ? " selected" : ""}>${escapeHtml(field.label)}</option>`).join("");
    return `<optgroup label="${escapeHtml(source)}">${options}</optgroup>`;
  }).join("");
}

function renderFilters() {
  const map = fieldMap();
  elements.filterRows.replaceChildren();
  for (const filter of state.filters) {
    const field = map.get(filter.field) || datasetSchema().fields[0];
    if (!field) continue;
    filter.field = field.key;
    const row = document.createElement("div");
    row.className = "builder-row";
    row.dataset.filterId = filter.id;
    const fieldSelect = document.createElement("select");
    fieldSelect.dataset.role = "field";
    fieldSelect.innerHTML = fieldOptionsHtml(filter.field);
    const operatorSelect = document.createElement("select");
    operatorSelect.dataset.role = "operator";
    operatorSelect.innerHTML = operatorsFor(field).map((operator) => `<option value="${operator.id}"${operator.id === filter.operator ? " selected" : ""}>${escapeHtml(operator.label)}</option>`).join("");
    if (![...operatorSelect.options].some((option) => option.value === filter.operator)) {
      filter.operator = operatorSelect.options[0]?.value || "eq";
    }
    const valueWrap = document.createElement("div");
    valueWrap.className = filter.operator === "between" ? "range-values" : "";
    if (!NO_VALUE_OPERATORS.has(filter.operator)) {
      valueWrap.append(makeValueInput(field, filter.value, "value"));
      if (filter.operator === "between") valueWrap.append(makeValueInput(field, filter.value2, "value2"));
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.role = "remove";
    remove.setAttribute("aria-label", "删除条件");
    remove.textContent = "×";
    row.append(fieldSelect, operatorSelect, valueWrap, remove);
    elements.filterRows.append(row);
  }
  elements.filterLogic.value = state.filterLogic;
  elements.filterCount.textContent = String(state.filters.length);
  elements.filterCount.hidden = state.filters.length === 0;
}

function makeValueInput(field, value, role) {
  const input = document.createElement("input");
  input.dataset.role = role;
  input.type = field.dataType === "number" ? "number" : field.dataType === "datetime" ? "text" : "text";
  input.value = value ?? "";
  input.placeholder = field.dataType === "datetime" ? "如 2026-09-01" : field.dataType === "boolean" ? "是 / 否" : "输入值";
  if (field.dataType === "number") input.step = "any";
  return input;
}

function renderSorts() {
  elements.sortRows.replaceChildren();
  for (const sort of state.sorts) {
    const row = document.createElement("div");
    row.className = "builder-row";
    row.dataset.sortId = sort.id;
    const field = document.createElement("select");
    field.dataset.role = "field";
    field.innerHTML = fieldOptionsHtml(sort.field);
    const direction = document.createElement("select");
    direction.dataset.role = "direction";
    direction.innerHTML = `<option value="desc"${sort.direction !== "asc" ? " selected" : ""}>降序</option><option value="asc"${sort.direction === "asc" ? " selected" : ""}>升序</option>`;
    const remove = document.createElement("button");
    remove.type = "button"; remove.dataset.role = "remove"; remove.textContent = "×"; remove.setAttribute("aria-label", "删除排序");
    row.append(field, direction, remove);
    elements.sortRows.append(row);
  }
  elements.sortCount.textContent = String(state.sorts.length);
  elements.sortCount.hidden = state.sorts.length === 0;
}

function setPanel(name, open = null) {
  const panels = { filters: elements.filterPanel, fields: elements.fieldPanel, sort: elements.sortPanel };
  const buttons = { filters: elements.toggleFilters, fields: elements.toggleFields, sort: elements.toggleSort };
  for (const [key, panel] of Object.entries(panels)) {
    const shouldOpen = key === name ? (open ?? panel.hidden) : false;
    panel.hidden = !shouldOpen;
    buttons[key].setAttribute("aria-expanded", String(shouldOpen));
  }
}

function scheduleQuery(delay = 220) {
  clearTimeout(queryTimer);
  state.resetScheduled = true;
  queryTimer = setTimeout(() => {
    state.resetScheduled = false;
    runQuery({ append: false });
  }, delay);
}

function queryPayload(page = 1) {
  return {
    dataset: state.dataset,
    snapshotToken: state.snapshotToken,
    fields: currentVisibleFields(),
    search: state.search,
    filter: { logic: state.filterLogic, children: state.filters.map(({ id, ...filter }) => filter) },
    sort: state.sorts.map(({ id, ...sort }) => sort),
    page,
    pageSize: state.pageSize
  };
}

async function loadSchema({ preserveQuery = false } = {}) {
  elements.refreshSchema.disabled = true;
  elements.lineageRibbon.dataset.state = "checking";
  elements.consistencyTitle.textContent = "正在建立一致性快照";
  elements.consistencyMeta.textContent = "逐项核对 CSV、SQLite 与素材快照";
  elements.railHealthDot.dataset.state = "checking";
  try {
    const result = await sendRuntime({ type: "getDataOverviewSchema" });
    state.schema = result;
    state.snapshotToken = result.snapshotToken || "";
    for (const dataset of ["notes", "comments"]) {
      const valid = new Set((result.datasets?.[dataset]?.fields || []).map((field) => field.key));
      state.visibleFields[dataset] = state.visibleFields[dataset].filter((key) => valid.has(key));
      if (!state.visibleFields[dataset].length) {
        state.visibleFields[dataset] = (result.datasets?.[dataset]?.fields || []).filter((field) => field.defaultVisible).map((field) => field.key);
      }
    }
    if (!preserveQuery) {
      state.filters = [];
      state.sorts = [];
      state.search = "";
      elements.globalSearch.value = "";
    }
    renderSchemaState();
    renderFieldOptions();
    renderFilters();
    renderSorts();
    savePreferences();
    if (state.queryReady) await runQuery({ retrySnapshot: false, append: false });
  } catch (error) {
    state.queryReady = false;
    state.schema = { datasets: { notes: { fields: [], total: 0 }, comments: { fields: [], total: 0 } }, health: { error: error.message } };
    renderSchemaState();
    elements.blockedReason.textContent = error.message;
  } finally {
    elements.refreshSchema.disabled = false;
  }
}

function resetLoadedRows() {
  state.page = 0;
  state.total = 0;
  state.rows = [];
  state.hasMore = true;
  elements.tableHead.replaceChildren();
  elements.tableBody.replaceChildren();
  elements.tableViewport.scrollTop = 0;
  elements.resultCount.textContent = "—";
  elements.pageMeta.textContent = "正在加载首批数据…";
  elements.exportCurrent.disabled = true;
  elements.infiniteSentinel.hidden = true;
}

function renderInfiniteState(forcedState = "") {
  elements.pageMeta.textContent = `已加载 ${state.rows.length.toLocaleString("zh-CN")} / ${state.total.toLocaleString("zh-CN")} 条`;
  if (!state.rows.length) {
    elements.infiniteSentinel.hidden = true;
    return;
  }
  elements.infiniteSentinel.hidden = false;
  if (forcedState === "error") {
    elements.infiniteSentinel.dataset.state = "error";
    elements.loadMoreText.textContent = "加载失败，点击重试";
  } else if (state.loading && state.page > 0) {
    elements.infiniteSentinel.dataset.state = "loading";
    elements.loadMoreText.textContent = "正在加载下一批…";
  } else if (state.hasMore) {
    elements.infiniteSentinel.dataset.state = "idle";
    elements.loadMoreText.textContent = "继续向下滚动加载";
  } else {
    elements.infiniteSentinel.dataset.state = "done";
    elements.loadMoreText.textContent = `已加载全部 ${state.total.toLocaleString("zh-CN")} 条`;
  }
}

async function runQuery({ retrySnapshot = true, append = false } = {}) {
  if (!state.queryReady) return;
  if (append && (state.resetScheduled || !state.hasMore || !state.rows.length)) return;
  if (state.loading) {
    // Keep the latest UI intent instead of dropping filter/search/page changes
    // while a previous snapshot query is still in flight.
    if (!append) state.queryPending = true;
    return;
  }
  const requestedPage = append ? state.page + 1 : 1;
  const serial = ++state.querySerial;
  state.queryPending = false;
  state.loading = true;
  if (!append) resetLoadedRows();
  elements.dataSurface.setAttribute("aria-busy", "true");
  elements.tableLoading.hidden = append;
  elements.tableEmpty.hidden = true;
  renderInfiniteState();
  let failed = false;
  try {
    const result = await sendRuntime({ type: "queryDataOverview", payload: queryPayload(requestedPage) });
    if (serial !== state.querySerial) return;
    if (state.resetScheduled) {
      clearTimeout(queryTimer);
      state.resetScheduled = false;
      state.queryPending = true;
    }
    if (state.queryPending) return;
    const incomingRows = result.rows || [];
    state.rows = append ? [...state.rows, ...incomingRows] : incomingRows;
    state.total = Number(result.total) || 0;
    state.page = Number(result.page) || 1;
    state.pageSize = Number(result.pageSize) || state.pageSize;
    state.snapshotToken = result.snapshotToken || state.snapshotToken;
    const pageCount = Math.max(1, Number(result.pageCount) || Math.ceil(state.total / state.pageSize) || 1);
    state.hasMore = incomingRows.length > 0 && state.rows.length < state.total && state.page < pageCount;
    renderTable(result, { append, incomingRows });
  } catch (error) {
    failed = true;
    if (retrySnapshot && /快照|数据已变化|重新校验/.test(error.message)) {
      state.loading = false;
      await loadSchema({ preserveQuery: true });
      return;
    }
    if (append) {
      state.hasMore = true;
      renderInfiniteState("error");
      showToast(error.message);
    } else {
      state.hasMore = false;
      elements.tableBody.replaceChildren();
      elements.tableEmpty.hidden = false;
      elements.tableEmpty.querySelector("strong").textContent = "查询没有完成";
      elements.tableEmpty.querySelector("p").textContent = error.message;
    }
  } finally {
    if (serial === state.querySerial) {
      const rerun = state.queryPending;
      state.loading = false;
      state.queryPending = false;
      if (rerun && state.queryReady) {
        queueMicrotask(() => runQuery({ append: false }));
      } else {
        elements.dataSurface.setAttribute("aria-busy", "false");
        elements.tableLoading.hidden = true;
        if (!failed) renderInfiniteState();
      }
    }
  }
}

function renderTable(result, { append = false, incomingRows = result.rows || [] } = {}) {
  const fields = currentVisibleFields();
  const map = fieldMap();
  if (!append) {
    elements.tableHead.replaceChildren();
    const rowNumber = document.createElement("th"); rowNumber.textContent = "#"; elements.tableHead.append(rowNumber);
    for (const key of fields) {
      const field = map.get(key);
      const th = document.createElement("th");
      th.textContent = field?.label || key;
      th.title = key;
      th.dataset.type = field?.dataType || "text";
      elements.tableHead.append(th);
    }
    elements.tableBody.replaceChildren();
  }
  const rowOffset = append ? state.rows.length - incomingRows.length : 0;
  for (let index = 0; index < incomingRows.length; index += 1) {
    const record = incomingRows[index];
    const absoluteIndex = rowOffset + index;
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    tr.dataset.index = String(absoluteIndex);
    const number = document.createElement("td");
    number.textContent = String(absoluteIndex + 1);
    tr.append(number);
    for (const key of fields) {
      const field = map.get(key) || { dataType: "text" };
      const td = document.createElement("td");
      td.dataset.type = field.dataType;
      td.dataset.long = String(LONG_FIELD_HINTS.some((hint) => key.includes(hint)));
      td.dataset.mono = String(MONO_FIELD_HINTS.some((hint) => key.includes(hint)));
      renderCell(td, record[key], key, field.dataType);
      tr.append(td);
    }
    elements.tableBody.append(tr);
  }
  elements.resultCount.textContent = state.total.toLocaleString("zh-CN");
  elements.tableEmpty.hidden = state.rows.length > 0;
  if (!state.rows.length) {
    elements.tableEmpty.querySelector("strong").textContent = "没有符合当前条件的数据";
    elements.tableEmpty.querySelector("p").textContent = "调整筛选条件或切换快捷视图。";
  }
  elements.exportCurrent.disabled = state.rows.length === 0;
  elements.snapshotCode.textContent = state.snapshotToken.slice(0, 14).toUpperCase();
  renderInfiniteState();
}

function renderCell(td, value, key, dataType) {
  if (value === null || value === undefined || value === "") {
    td.textContent = "—";
    td.style.color = "#a2a6ae";
    return;
  }
  if (dataType === "boolean") {
    const bool = value === true || value === 1 || value === "1";
    const span = document.createElement("span");
    span.className = "cell-boolean"; span.dataset.value = String(bool); span.textContent = bool ? "✓" : "–";
    td.append(span); return;
  }
  if (STATUS_FIELDS.has(key) || key.endsWith("__post_status")) {
    const span = document.createElement("span");
    span.className = "cell-pill";
    span.textContent = String(value);
    span.dataset.state = /已删除|unreachable|failed|差评/.test(String(value)) ? "deleted"
      : /存在|known|synced|ok|是/.test(String(value)) ? "active" : "pending";
    td.append(span); return;
  }
  if (/url$/i.test(key) && /^https?:\/\//i.test(String(value))) {
    const link = document.createElement("a");
    link.className = "cell-link"; link.href = String(value); link.target = "_blank"; link.rel = "noreferrer";
    link.textContent = compactValue(value, 72); link.title = String(value); td.append(link); return;
  }
  td.textContent = compactValue(value, LONG_FIELD_HINTS.some((hint) => key.includes(hint)) ? 180 : 90);
  td.title = String(value);
}

function compactValue(value, limit) {
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function openDrawer(record) {
  state.currentRecord = record;
  const map = fieldMap();
  const primary = state.dataset === "notes" ? record.note_id : record.comment_id;
  const title = state.dataset === "notes" ? record.title : record.author || record.comment_id;
  elements.drawerType.textContent = state.dataset === "notes" ? "POST RECORD" : "COMMENT RECORD";
  elements.drawerTitle.textContent = title || primary || "记录详情";
  elements.drawerFields.replaceChildren();
  for (const key of currentVisibleFields()) {
    const dl = document.createElement("dl");
    dl.className = "drawer-field";
    const dt = document.createElement("dt"); dt.textContent = map.get(key)?.label || key; dt.title = key;
    const dd = document.createElement("dd"); dd.textContent = formatFullValue(record[key]);
    dl.append(dt, dd); elements.drawerFields.append(dl);
  }
  const url = record.url || record.post__url || "";
  elements.openRecordLink.hidden = !/^https?:\/\//i.test(url);
  elements.openRecordLink.dataset.url = url;
  elements.recordDrawer.hidden = false;
}

function formatFullValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  const text = String(value);
  if ((text.startsWith("{") || text.startsWith("[")) && text.length > 2) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (_error) {}
  }
  return text;
}

function addFilter(fieldKey = "") {
  const field = fieldMap().get(fieldKey) || datasetSchema().fields.find((item) => item.key === (state.dataset === "notes" ? "title" : "content")) || datasetSchema().fields[0];
  if (!field) return;
  const operator = operatorsFor(field)[0]?.id || "eq";
  state.filters.push({ id: crypto.randomUUID(), field: field.key, operator, value: "", value2: "" });
  renderFilters();
  setPanel("filters", true);
}

function applyQuickView(name) {
  const deletionField = "is_deleted";
  const analysisField = "analysis_is_negative";
  const countField = "semantic_analysis_count";
  state.filters = [];
  if (name === "active") state.filters.push({ id: crypto.randomUUID(), field: deletionField, operator: "is_false", value: "", value2: "" });
  if (name === "deleted") state.filters.push({ id: crypto.randomUUID(), field: deletionField, operator: "is_true", value: "", value2: "" });
  if (name === "negative") state.filters.push({ id: crypto.randomUUID(), field: analysisField, operator: "eq", value: "是", value2: "" });
  if (name === "unanalyzed") state.filters.push({ id: crypto.randomUUID(), field: countField, operator: "eq", value: "0", value2: "" });
  document.querySelectorAll("[data-quick-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.quickView === name));
  renderFilters();
  scheduleQuery(0);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function exportCurrentPage() {
  const fields = currentVisibleFields();
  const map = fieldMap();
  const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = [fields.map((key) => quote(map.get(key)?.label || key)).join(",")];
  for (const row of state.rows) lines.push(fields.map((key) => quote(typeof row[key] === "object" ? JSON.stringify(row[key]) : row[key])).join(","));
  const blob = new Blob(["\ufeff", lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = `XHS-Monitor_${state.dataset}_${new Date().toISOString().slice(0,10)}_loaded-${state.rows.length}.csv`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`已导出当前已加载的 ${state.rows.length} 条记录`);
}

function loadNextBatch() {
  if (!state.queryReady || state.loading || state.resetScheduled || !state.hasMore || !state.rows.length) return;
  runQuery({ append: true });
}

function initializeInfiniteScroll() {
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadNextBatch();
    }, { root: elements.tableViewport, rootMargin: "0px 0px 240px 0px", threshold: 0.01 });
    observer.observe(elements.infiniteSentinel);
  }
  elements.tableViewport.addEventListener("scroll", () => {
    const remaining = elements.tableViewport.scrollHeight - elements.tableViewport.scrollTop - elements.tableViewport.clientHeight;
    if (remaining < 240) loadNextBatch();
  }, { passive: true });
  elements.infiniteSentinel.addEventListener("click", loadNextBatch);
}

function bindEvents() {
  document.querySelectorAll(".dataset-button").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.dataset === state.dataset) return;
    state.dataset = button.dataset.dataset;
    state.page = 0; state.filters = []; state.sorts = []; state.search = ""; elements.globalSearch.value = "";
    document.querySelectorAll("[data-quick-view]").forEach((item) => item.classList.remove("is-active"));
    renderSchemaState(); renderFieldOptions(); renderFilters(); renderSorts(); savePreferences(); runQuery({ append: false });
  }));
  document.querySelectorAll("[data-quick-view]").forEach((button) => button.addEventListener("click", () => applyQuickView(button.dataset.quickView)));
  elements.refreshSchema.addEventListener("click", () => loadSchema({ preserveQuery: true }));
  elements.retryHealth.addEventListener("click", () => loadSchema({ preserveQuery: true }));
  elements.globalSearch.addEventListener("input", () => { state.search = elements.globalSearch.value.trim(); scheduleQuery(320); });
  elements.globalSearch.addEventListener("keydown", (event) => { if (event.key === "Enter") { clearTimeout(queryTimer); scheduleQuery(0); } });
  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); elements.globalSearch.focus(); }
    if (event.key === "Escape") { setPanel("none", false); elements.recordDrawer.hidden = true; }
  });
  elements.toggleFilters.addEventListener("click", () => setPanel("filters"));
  elements.toggleFields.addEventListener("click", () => { renderFieldOptions(); setPanel("fields"); });
  elements.toggleSort.addEventListener("click", () => setPanel("sort"));
  elements.addFilter.addEventListener("click", () => addFilter());
  elements.clearFilters.addEventListener("click", () => { state.filters = []; renderFilters(); scheduleQuery(0); });
  elements.filterLogic.addEventListener("change", () => { state.filterLogic = elements.filterLogic.value; scheduleQuery(0); });
  elements.filterRows.addEventListener("change", handleFilterChange);
  elements.filterRows.addEventListener("input", handleFilterInput);
  elements.filterRows.addEventListener("click", handleFilterClick);
  elements.fieldSearch.addEventListener("input", renderFieldOptions);
  elements.fieldOptions.addEventListener("change", (event) => {
    const input = event.target.closest("input[data-field]"); if (!input) return;
    const selected = new Set(currentVisibleFields());
    if (input.checked) selected.add(input.dataset.field); else selected.delete(input.dataset.field);
    if (!selected.size) { input.checked = true; showToast("至少保留一个可见字段"); return; }
    state.visibleFields[state.dataset] = [...selected]; savePreferences(); renderFieldOptions(); scheduleQuery(0);
  });
  elements.selectDefaultFields.addEventListener("click", () => {
    state.visibleFields[state.dataset] = datasetSchema().fields.filter((field) => field.defaultVisible).map((field) => field.key);
    savePreferences(); renderFieldOptions(); scheduleQuery(0);
  });
  elements.selectAllFields.addEventListener("click", () => {
    state.visibleFields[state.dataset] = datasetSchema().fields.map((field) => field.key);
    savePreferences(); renderFieldOptions(); scheduleQuery(0);
  });
  elements.addSort.addEventListener("click", () => {
    const field = datasetSchema().fields.find((item) => item.key.endsWith("last_seen_at")) || datasetSchema().fields[0];
    if (!field) return; state.sorts.push({ id: crypto.randomUUID(), field: field.key, direction: "desc" }); renderSorts();
  });
  elements.clearSorts.addEventListener("click", () => { state.sorts = []; renderSorts(); scheduleQuery(0); });
  elements.sortRows.addEventListener("change", (event) => {
    const row = event.target.closest("[data-sort-id]"); if (!row) return;
    const sort = state.sorts.find((item) => item.id === row.dataset.sortId); if (!sort) return;
    sort[event.target.dataset.role] = event.target.value; scheduleQuery(0);
  });
  elements.sortRows.addEventListener("click", (event) => {
    if (event.target.dataset.role !== "remove") return;
    const row = event.target.closest("[data-sort-id]"); state.sorts = state.sorts.filter((item) => item.id !== row.dataset.sortId); renderSorts(); scheduleQuery(0);
  });
  elements.tableBody.addEventListener("dblclick", (event) => {
    const row = event.target.closest("tr[data-index]"); if (row) openDrawer(state.rows[Number(row.dataset.index)]);
  });
  elements.tableBody.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return; const row = event.target.closest("tr[data-index]"); if (row) openDrawer(state.rows[Number(row.dataset.index)]);
  });
  elements.exportCurrent.addEventListener("click", exportCurrentPage);
  elements.closeDrawer.addEventListener("click", () => { elements.recordDrawer.hidden = true; });
  elements.copyRecord.addEventListener("click", async () => {
    if (!state.currentRecord) return; await navigator.clipboard.writeText(JSON.stringify(state.currentRecord, null, 2)); showToast("当前记录 JSON 已复制");
  });
  elements.openRecordLink.addEventListener("click", () => sendRuntime({ type: "openDataOverviewRecord", url: elements.openRecordLink.dataset.url }).catch((error) => showToast(error.message)));
  document.addEventListener("click", (event) => {
    if (!elements.fieldPanel.hidden && !elements.fieldPanel.contains(event.target) && !elements.toggleFields.contains(event.target)) setPanel("none", false);
  });
}

function handleFilterChange(event) {
  const row = event.target.closest("[data-filter-id]"); if (!row) return;
  const filter = state.filters.find((item) => item.id === row.dataset.filterId); if (!filter) return;
  const role = event.target.dataset.role;
  if (role === "field") { filter.field = event.target.value; filter.operator = operatorsFor(fieldMap().get(filter.field))[0]?.id || "eq"; filter.value = ""; filter.value2 = ""; renderFilters(); }
  if (role === "operator") { filter.operator = event.target.value; filter.value2 = ""; renderFilters(); }
  if (role === "value" || role === "value2") filter[role] = event.target.value;
  scheduleQuery(180);
}

function handleFilterInput(event) {
  const row = event.target.closest("[data-filter-id]"); if (!row) return;
  const filter = state.filters.find((item) => item.id === row.dataset.filterId); if (!filter) return;
  const role = event.target.dataset.role; if (role === "value" || role === "value2") { filter[role] = event.target.value; scheduleQuery(360); }
}

function handleFilterClick(event) {
  if (event.target.dataset.role !== "remove") return;
  const row = event.target.closest("[data-filter-id]");
  state.filters = state.filters.filter((item) => item.id !== row.dataset.filterId); renderFilters(); scheduleQuery(0);
}

loadPreferences();
bindEvents();
initializeInfiniteScroll();
loadSchema();
