"use strict";

const byId = (id) => document.getElementById(id);
const elements = {
  notesCount: byId("notesCount"), commentsCount: byId("commentsCount"),
  railHealthDot: byId("railHealthDot"), railHealthText: byId("railHealthText"), railHealthMeta: byId("railHealthMeta"),
  datasetTitle: byId("datasetTitle"), datasetSubtitle: byId("datasetSubtitle"),
  refreshSchema: byId("refreshSchema"), exportCurrent: byId("exportCurrent"),
  deleteSelected: byId("deleteSelected"), selectedCount: byId("selectedCount"),
  lineageRibbon: byId("lineageRibbon"), consistencyTitle: byId("consistencyTitle"),
  consistencyMeta: byId("consistencyMeta"), snapshotCode: byId("snapshotCode"),
  globalSearch: byId("globalSearch"), toggleFilters: byId("toggleFilters"), filterCount: byId("filterCount"),
  toggleFields: byId("toggleFields"), fieldCount: byId("fieldCount"),
  toggleSort: byId("toggleSort"), sortCount: byId("sortCount"), resultCount: byId("resultCount"),
  resultLabel: byId("resultLabel"),
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
  pageFind: byId("pageFind"), pageFindInput: byId("pageFindInput"), pageFindCount: byId("pageFindCount"),
  pageFindPrevious: byId("pageFindPrevious"), pageFindNext: byId("pageFindNext"), closePageFind: byId("closePageFind"),
  columnFilterPopover: byId("columnFilterPopover"), columnFilterTitle: byId("columnFilterTitle"),
  columnFilterOperator: byId("columnFilterOperator"), columnFilterValueWrap: byId("columnFilterValueWrap"),
  columnFilterExisting: byId("columnFilterExisting"), closeColumnFilter: byId("closeColumnFilter"),
  clearColumnFilter: byId("clearColumnFilter"), applyColumnFilter: byId("applyColumnFilter"),
  recordDrawer: byId("recordDrawer"), drawerType: byId("drawerType"), drawerTitle: byId("drawerTitle"),
  drawerFields: byId("drawerFields"), closeDrawer: byId("closeDrawer"), copyRecord: byId("copyRecord"),
  openRecordLink: byId("openRecordLink"), deleteDrawerRecord: byId("deleteDrawerRecord"),
  deleteDialog: byId("deleteDialog"), deleteDialogTitle: byId("deleteDialogTitle"),
  deleteDialogSummary: byId("deleteDialogSummary"), deleteDialogDetails: byId("deleteDialogDetails"),
  deleteAcknowledgement: byId("deleteAcknowledgement"), cancelDelete: byId("cancelDelete"),
  confirmDelete: byId("confirmDelete"), toast: byId("toast")
};

const TITLES = {
  notes: ["帖子数据库", "本地全部帖子、业务状态、素材与评论计数。"],
  comments: ["评论数据库", "全部一级评论与回复，并联原帖的每一个字段。"]
};
const STATUS_FIELDS = new Set(["status", "pull_status", "post_status", "comment_status", "access_status", "review_status", "analysis_is_negative", "ignore_status", "post__ignore_status"]);
const LONG_FIELD_HINTS = ["content", "summary", "reason", "json", "error", "categories", "note"];
const MONO_FIELD_HINTS = ["_id", "url", "path", "dir", "hash", "json"];
const NO_VALUE_OPERATORS = new Set(["is_empty", "not_empty", "is_true", "is_false"]);
const REQUIRED_NOTE_FIELDS = new Set(["note_id", "ignore_status"]);
const REQUIRED_COMMENT_FIELDS = new Set(["comment_id", "note_id", "thread_root_content"]);
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
  resetScheduled: false,
  findQuery: "",
  findMatches: [],
  findIndex: -1,
  findLoading: false,
  selectedIds: new Set(),
  pendingDeleteIds: [],
  deletePending: false
};

let queryTimer = 0;
let toastTimer = 0;
let findTimer = 0;
let threadMergeCell = null;
let columnFilterDraft = null;
const valueOptionsCache = new Map();

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

function orderedDatasetFields() {
  const order = (field) => Number.isFinite(Number(field.displayOrder)) ? Number(field.displayOrder) : 10000;
  return [...datasetSchema().fields].sort((left, right) =>
    order(left) - order(right)
    || String(left.label).localeCompare(String(right.label), "zh-CN")
    || String(left.key).localeCompare(String(right.key))
  );
}

function currentVisibleFields() {
  const available = fieldMap();
  const selected = new Set(state.visibleFields[state.dataset].filter((key) => available.has(key)));
  if (!selected.size) {
    for (const field of orderedDatasetFields()) if (field.defaultVisible) selected.add(field.key);
  }
  if (state.dataset === "notes") {
    for (const key of REQUIRED_NOTE_FIELDS) if (available.has(key)) selected.add(key);
  }
  if (state.dataset === "comments") {
    for (const key of REQUIRED_COMMENT_FIELDS) if (available.has(key)) selected.add(key);
  }
  return orderedDatasetFields().filter((field) => selected.has(field.key)).map((field) => field.key).slice(0, 180);
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
  const noteDataset = state.schema?.datasets?.notes || {};
  elements.notesCount.textContent = Number(noteDataset.total || 0).toLocaleString("zh-CN");
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
  elements.datasetSubtitle.textContent = state.dataset === "notes"
    ? `同步记录 ${Number(noteDataset.synchronizedTotal || 0).toLocaleString("zh-CN")} · 已忽略 ${Number(noteDataset.ignoredTotal || 0).toLocaleString("zh-CN")} · 已排除仅发现未入库 ${Number(noteDataset.excludedDiscoveryTotal || 0).toLocaleString("zh-CN")}`
    : TITLES[state.dataset][1];
}

function renderFieldOptions() {
  const query = elements.fieldSearch.value.trim().toLowerCase();
  const selected = new Set(currentVisibleFields());
  const groups = new Map();
  for (const field of orderedDatasetFields()) {
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
      input.disabled = (state.dataset === "notes" && REQUIRED_NOTE_FIELDS.has(field.key))
        || (state.dataset === "comments" && REQUIRED_COMMENT_FIELDS.has(field.key));
      const name = document.createElement("span");
      name.textContent = field.label;
      const type = document.createElement("small");
      type.textContent = input.disabled ? "固定" : field.dataType;
      label.append(input, name, type);
      group.append(label);
    }
    elements.fieldOptions.append(group);
  }
  elements.fieldCount.textContent = String(selected.size);
}

function fieldOptionsHtml(selectedKey = "") {
  const groups = new Map();
  for (const field of orderedDatasetFields()) {
    if (!groups.has(field.source)) groups.set(field.source, []);
    groups.get(field.source).push(field);
  }
  return [...groups].map(([source, fields]) => {
    const options = fields.map((field) => `<option value="${escapeHtml(field.key)}"${field.key === selectedKey ? " selected" : ""}>${escapeHtml(field.label)}</option>`).join("");
    return `<optgroup label="${escapeHtml(source)}">${options}</optgroup>`;
  }).join("");
}

async function getFieldValueOptions(field) {
  const cacheKey = `${state.snapshotToken}:${state.dataset}:${field.key}`;
  if (!valueOptionsCache.has(cacheKey)) {
    const request = sendRuntime({
      type: "getDataOverviewValues",
      payload: { dataset: state.dataset, snapshotToken: state.snapshotToken, field: field.key, limit: 160 }
    }).catch((error) => {
      valueOptionsCache.delete(cacheKey);
      throw error;
    });
    valueOptionsCache.set(cacheKey, request);
  }
  return valueOptionsCache.get(cacheKey);
}

function attachValueOptions(container, input, field, operator, filterId, role) {
  if (!field.suggestValues || !["eq", "neq", "in", "contains", "not_contains"].includes(operator)) return;
  const list = document.createElement("datalist");
  list.id = `field-values-${filterId}-${role}`;
  input.setAttribute("list", list.id);
  input.placeholder = operator === "in" ? "选择已有值；多项用逗号" : "选择或输入已有值";
  container.append(list);
  getFieldValueOptions(field).then((result) => {
    if (!list.isConnected || field.key !== input.closest("[data-filter-id]")?.querySelector('[data-role="field"]')?.value) return;
    const fragment = document.createDocumentFragment();
    for (const item of result.values || []) {
      const option = document.createElement("option");
      option.value = field.dataType === "boolean" ? String(item.label) : String(item.value ?? "");
      option.label = `${item.label ?? item.value} · ${Number(item.count || 0).toLocaleString("zh-CN")} 条`;
      fragment.append(option);
    }
    list.replaceChildren(fragment);
  }).catch(() => {});
}

function closeColumnFilterPopover() {
  elements.columnFilterPopover.hidden = true;
  columnFilterDraft = null;
}

function positionColumnFilterPopover(anchor) {
  requestAnimationFrame(() => {
    if (elements.columnFilterPopover.hidden || !anchor?.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    const popup = elements.columnFilterPopover.getBoundingClientRect();
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - popup.width - 12));
    const below = rect.bottom + 7;
    const top = below + popup.height <= window.innerHeight - 12
      ? below : Math.max(12, rect.top - popup.height - 7);
    elements.columnFilterPopover.style.left = `${left}px`;
    elements.columnFilterPopover.style.top = `${top}px`;
  });
}

function populateColumnValueOptions(input, field) {
  if (!field.suggestValues || !columnFilterDraft) return;
  const list = document.createElement("datalist");
  list.id = `column-values-${field.key.replace(/[^a-z0-9_-]/gi, "-")}`;
  input.setAttribute("list", list.id);
  input.placeholder = columnFilterDraft.operator === "in" ? "选择已有值；多项用逗号" : "选择或输入已有值";
  elements.columnFilterValueWrap.append(list);
  getFieldValueOptions(field).then((result) => {
    if (!list.isConnected || columnFilterDraft?.field !== field.key) return;
    const fragment = document.createDocumentFragment();
    for (const item of result.values || []) {
      const option = document.createElement("option");
      option.value = field.dataType === "boolean" ? String(item.label) : String(item.value ?? "");
      option.label = `${item.label ?? item.value} · ${Number(item.count || 0).toLocaleString("zh-CN")} 条`;
      fragment.append(option);
    }
    list.replaceChildren(fragment);
  }).catch(() => {});
}

function renderColumnFilterValue() {
  elements.columnFilterValueWrap.replaceChildren();
  elements.columnFilterValueWrap.className = "column-filter-value";
  if (!columnFilterDraft) return;
  const field = fieldMap().get(columnFilterDraft.field);
  if (!field || NO_VALUE_OPERATORS.has(columnFilterDraft.operator)) {
    const hint = document.createElement("span");
    hint.className = "column-filter-no-value";
    hint.textContent = "该条件无需输入值";
    elements.columnFilterValueWrap.append(hint);
    return;
  }
  elements.columnFilterValueWrap.className = columnFilterDraft.operator === "between"
    ? "column-filter-value range-values" : "column-filter-value";
  const first = makeValueInput(field, columnFilterDraft.value, "value");
  first.id = "columnFilterValue";
  elements.columnFilterValueWrap.append(first);
  populateColumnValueOptions(first, field);
  if (columnFilterDraft.operator === "between") {
    const second = makeValueInput(field, columnFilterDraft.value2, "value2");
    second.id = "columnFilterValue2";
    elements.columnFilterValueWrap.append(second);
  }
}

function openColumnFilter(fieldKey, anchor) {
  const field = fieldMap().get(fieldKey);
  if (!field?.filterable) return;
  const operators = operatorsFor(field);
  const preferred = field.suggestValues ? "eq" : field.dataType === "text" ? "contains" : "eq";
  const operator = operators.some((item) => item.id === preferred) ? preferred : operators[0]?.id || "eq";
  columnFilterDraft = { field: field.key, operator, value: "", value2: "", anchor };
  elements.columnFilterTitle.textContent = field.label;
  elements.columnFilterOperator.innerHTML = operators.map((item) =>
    `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`
  ).join("");
  elements.columnFilterOperator.value = operator;
  const existingCount = state.filters.filter((item) => item.field === field.key).length;
  elements.columnFilterExisting.textContent = existingCount
    ? `该字段已有 ${existingCount} 条筛选规则；确认后继续追加。`
    : "确认后自动加入正式筛选规则。";
  elements.clearColumnFilter.disabled = existingCount === 0;
  setPanel("none", false);
  elements.columnFilterPopover.hidden = false;
  renderColumnFilterValue();
  positionColumnFilterPopover(anchor);
  setTimeout(() => elements.columnFilterValueWrap.querySelector("input")?.focus(), 0);
}

function applyColumnFilter() {
  if (!columnFilterDraft) return;
  const first = elements.columnFilterValueWrap.querySelector('[data-role="value"]');
  const second = elements.columnFilterValueWrap.querySelector('[data-role="value2"]');
  columnFilterDraft.value = first?.value ?? "";
  columnFilterDraft.value2 = second?.value ?? "";
  if (!NO_VALUE_OPERATORS.has(columnFilterDraft.operator)) {
    if (!String(columnFilterDraft.value).trim()
        || (columnFilterDraft.operator === "between" && !String(columnFilterDraft.value2).trim())) {
      showToast("请先填写筛选值");
      first?.focus();
      return;
    }
  }
  const fieldKey = columnFilterDraft.field;
  state.filters.push({
    id: crypto.randomUUID(), field: fieldKey, operator: columnFilterDraft.operator,
    value: columnFilterDraft.value, value2: columnFilterDraft.value2,
  });
  closeColumnFilterPopover();
  renderFilters();
  setPanel("filters", true);
  scheduleQuery(0);
  showToast("已加入筛选规则");
}

function clearColumnFilters() {
  if (!columnFilterDraft) return;
  const fieldKey = columnFilterDraft.field;
  state.filters = state.filters.filter((item) => item.field !== fieldKey);
  closeColumnFilterPopover();
  renderFilters();
  scheduleQuery(0);
}

function updateHeaderFilterState() {
  for (const header of elements.tableHead.querySelectorAll("th[data-field]")) {
    const count = state.filters.filter((item) => item.field === header.dataset.field).length;
    header.dataset.filtered = String(count > 0);
    const badge = header.querySelector("i");
    if (badge) badge.textContent = count ? String(count) : "⌄";
  }
}

function renderFilters() {
  const map = fieldMap();
  elements.filterRows.replaceChildren();
  for (const filter of state.filters) {
    const field = map.get(filter.field) || orderedDatasetFields()[0];
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
      const firstInput = makeValueInput(field, filter.value, "value");
      valueWrap.append(firstInput);
      attachValueOptions(valueWrap, firstInput, field, filter.operator, filter.id, "value");
      if (filter.operator === "between") {
        const secondInput = makeValueInput(field, filter.value2, "value2");
        valueWrap.append(secondInput);
        attachValueOptions(valueWrap, secondInput, field, filter.operator, filter.id, "value2");
      }
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
  updateHeaderFilterState();
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
  const fields = currentVisibleFields();
  if (state.dataset === "comments") {
    for (const key of ["thread_root_id", "thread_root_author"]) {
      if (fieldMap().has(key) && !fields.includes(key)) fields.push(key);
    }
  }
  return {
    dataset: state.dataset,
    snapshotToken: state.snapshotToken,
    fields,
    search: state.search,
    filter: { logic: state.filterLogic, children: state.filters.map(({ id, ...filter }) => filter) },
    sort: state.sorts.map(({ id, ...sort }) => sort),
    groupThreads: state.dataset === "comments",
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
    valueOptionsCache.clear();
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

function recordIdentity(record, dataset = state.dataset) {
  return String(dataset === "notes" ? record?.note_id || "" : record?.comment_id || "").trim();
}

function updateSelectionUi() {
  const count = state.selectedIds.size;
  elements.selectedCount.textContent = String(count);
  elements.deleteSelected.disabled = count === 0 || state.deletePending;
  elements.deleteSelected.title = count
    ? `永久删除选中的 ${count} 条本地记录`
    : "先勾选要删除的数据";
  const loadedIds = state.rows.map((record) => recordIdentity(record)).filter(Boolean);
  const selectedLoaded = loadedIds.filter((id) => state.selectedIds.has(id)).length;
  const selectAll = elements.tableHead.querySelector('[data-role="select-loaded"]');
  if (selectAll) {
    selectAll.checked = loadedIds.length > 0 && selectedLoaded === loadedIds.length;
    selectAll.indeterminate = selectedLoaded > 0 && selectedLoaded < loadedIds.length;
    selectAll.disabled = loadedIds.length === 0 || state.deletePending;
  }
  for (const row of elements.tableBody.querySelectorAll("tr[data-record-id]")) {
    const selected = state.selectedIds.has(row.dataset.recordId);
    row.dataset.selected = String(selected);
    const input = row.querySelector('[data-role="select-row"]');
    if (input) { input.checked = selected; input.disabled = state.deletePending; }
  }
}

function clearSelection() {
  state.selectedIds.clear();
  state.pendingDeleteIds = [];
  updateSelectionUi();
}

function closeDeleteDialog() {
  if (state.deletePending) return;
  state.pendingDeleteIds = [];
  elements.deleteAcknowledgement.checked = false;
  elements.confirmDelete.disabled = true;
  if (elements.deleteDialog.open) elements.deleteDialog.close();
}

function openDeleteDialog(ids = [...state.selectedIds]) {
  const uniqueIds = [...new Set(ids.map((item) => String(item || "").trim()).filter(Boolean))];
  if (!uniqueIds.length) { showToast("请先勾选要删除的数据"); return; }
  state.pendingDeleteIds = uniqueIds;
  elements.deleteAcknowledgement.checked = false;
  elements.confirmDelete.disabled = true;
  elements.deleteDialogTitle.textContent = state.dataset === "notes"
    ? `彻底删除 ${uniqueIds.length} 篇帖子`
    : `彻底删除 ${uniqueIds.length} 条评论`;
  elements.deleteDialogSummary.textContent = state.dataset === "notes"
    ? "所选帖子会从本地业务 CSV、SQLite 和素材目录中永久移除。"
    : "所选评论会从评论 CSV、SQLite 与素材 comments.json 中永久移除。";
  const details = state.dataset === "notes" ? [
    "级联删除帖子下的全部一级评论与回复",
    "删除图片、视频、正文和 JSON 素材目录",
    "清理关联的 AI 记录、回复历史、观察与变更记录",
  ] : [
    "选中一级评论时，其下所有回复会一并删除",
    "同步清理 AI 记录、回复建议历史与变更记录",
    "保留原帖及其图片、视频；仅更新该帖 comments.json",
  ];
  elements.deleteDialogDetails.replaceChildren(...details.map((value) => {
    const item = document.createElement("li"); item.textContent = value; return item;
  }));
  if (!elements.deleteDialog.open) elements.deleteDialog.showModal();
}

async function performPermanentDelete() {
  if (state.deletePending || !elements.deleteAcknowledgement.checked) return;
  const ids = [...state.pendingDeleteIds];
  if (!ids.length) return;
  state.deletePending = true;
  elements.confirmDelete.disabled = true;
  elements.confirmDelete.textContent = "正在校验并删除…";
  updateSelectionUi();
  let result = null;
  try {
    result = await sendRuntime({
      type: "deleteDataOverviewRecords",
      payload: {
        dataset: state.dataset, ids, snapshotToken: state.snapshotToken,
        hardDeleteConfirmed: true, confirmation: `DELETE:${state.dataset}:${ids.length}`,
      },
    });
    elements.recordDrawer.hidden = true;
    if (elements.deleteDialog.open) elements.deleteDialog.close();
    clearSelection();
    await loadSchema({ preserveQuery: false });
    const cascaded = Number(result.cascadeDeletedCount || result.deletedCommentCount || 0);
    const failureText = Number(result.failureCount || 0) ? `，${result.failureCount} 条失败` : "";
    showToast(`已永久删除 ${Number(result.deletedCount || 0)} 条${cascaded ? `，级联清理 ${cascaded} 条评论` : ""}${failureText}`);
  } catch (error) {
    if (elements.deleteDialog.open) elements.deleteDialog.close();
    await loadSchema({ preserveQuery: false }).catch(() => {});
    showToast(error.message || "删除没有完成");
  } finally {
    state.deletePending = false;
    state.pendingDeleteIds = [];
    elements.confirmDelete.textContent = "永久删除";
    elements.deleteAcknowledgement.checked = false;
    elements.confirmDelete.disabled = true;
    updateSelectionUi();
  }
}

function resetLoadedRows() {
  clearSelection();
  threadMergeCell = null;
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
    threadMergeCell = null;
    elements.tableHead.replaceChildren();
    const selectColumn = document.createElement("th");
    selectColumn.className = "select-column";
    const selectLoaded = document.createElement("input");
    selectLoaded.type = "checkbox"; selectLoaded.dataset.role = "select-loaded";
    selectLoaded.setAttribute("aria-label", "选择当前已加载的全部记录");
    selectColumn.append(selectLoaded); elements.tableHead.append(selectColumn);
    const rowNumber = document.createElement("th");
    rowNumber.className = "row-number-column"; rowNumber.textContent = "#"; elements.tableHead.append(rowNumber);
    for (const key of fields) {
      const field = map.get(key);
      const th = document.createElement("th");
      th.className = "filterable-header";
      th.tabIndex = 0;
      th.dataset.field = key;
      th.title = `${field?.label || key} · 点击筛选`;
      th.dataset.type = field?.dataType || "text";
      const wrap = document.createElement("span");
      const name = document.createElement("b"); name.textContent = field?.label || key;
      const filterIcon = document.createElement("i"); filterIcon.textContent = "⌄"; filterIcon.setAttribute("aria-hidden", "true");
      wrap.append(name, filterIcon); th.append(wrap);
      elements.tableHead.append(th);
    }
    elements.tableBody.replaceChildren();
  }
  const rowOffset = append ? state.rows.length - incomingRows.length : 0;
  for (let index = 0; index < incomingRows.length; index += 1) {
    const record = incomingRows[index];
    const absoluteIndex = rowOffset + index;
    const threadKey = state.dataset === "comments" ? `${record.note_id || ""}::${record.thread_root_id || record.comment_id || absoluteIndex}` : "";
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    tr.dataset.index = String(absoluteIndex);
    tr.dataset.recordId = recordIdentity(record);
    const selectCell = document.createElement("td");
    selectCell.className = "select-column";
    const selectRow = document.createElement("input");
    selectRow.type = "checkbox"; selectRow.dataset.role = "select-row";
    selectRow.setAttribute("aria-label", `选择第 ${absoluteIndex + 1} 条记录`);
    selectCell.append(selectRow); tr.append(selectCell);
    const number = document.createElement("td");
    number.className = "row-number-column";
    number.textContent = String(absoluteIndex + 1);
    tr.append(number);
    for (const key of fields) {
      const field = map.get(key) || { dataType: "text" };
      if (state.dataset === "comments" && key === "thread_root_content") {
        if (threadMergeCell?.key === threadKey) {
          threadMergeCell.span += 1;
          threadMergeCell.cell.rowSpan = threadMergeCell.span;
          continue;
        }
        const rootCell = document.createElement("td");
        rootCell.dataset.type = "text";
        rootCell.dataset.long = "true";
        rootCell.className = "thread-root-cell";
        renderThreadRootCell(rootCell, record);
        tr.append(rootCell);
        threadMergeCell = { key: threadKey, cell: rootCell, span: 1 };
        continue;
      }
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
  elements.resultLabel.textContent = state.filters.length || state.search ? "条筛选结果" : "条结果";
  elements.tableEmpty.hidden = state.rows.length > 0;
  if (!state.rows.length) {
    elements.tableEmpty.querySelector("strong").textContent = "没有符合当前条件的数据";
    elements.tableEmpty.querySelector("p").textContent = "调整筛选条件或切换快捷视图。";
  }
  elements.exportCurrent.disabled = state.rows.length === 0;
  elements.snapshotCode.textContent = state.snapshotToken.slice(0, 14).toUpperCase();
  updateHeaderFilterState();
  updateSelectionUi();
  renderInfiniteState();
  refreshFindMatches(false);
}

function renderThreadRootCell(cell, record) {
  const author = document.createElement("strong");
  author.textContent = record.thread_root_author || "一级评论";
  const content = document.createElement("p");
  content.textContent = record.thread_root_content || "（一级评论未采集）";
  const id = document.createElement("code");
  id.textContent = record.thread_root_id || record.comment_id || "";
  cell.append(author, content, id);
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
      : /已忽略|ignored/.test(String(value)) ? "ignored"
      : /存在|known|synced|ok|未忽略|是/.test(String(value)) ? "active" : "pending";
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
  const field = fieldMap().get(fieldKey) || orderedDatasetFields().find((item) => item.key === (state.dataset === "notes" ? "title" : "content")) || orderedDatasetFields()[0];
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
  if (name === "ignored") state.filters.push({
    id: crypto.randomUUID(), field: state.dataset === "notes" ? "ignore_status" : "post__ignore_status",
    operator: "eq", value: "已忽略", value2: ""
  });
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
    if (!elements.columnFilterPopover.hidden) closeColumnFilterPopover();
    const remaining = elements.tableViewport.scrollHeight - elements.tableViewport.scrollTop - elements.tableViewport.clientHeight;
    if (remaining < 240) loadNextBatch();
  }, { passive: true });
  elements.infiniteSentinel.addEventListener("click", loadNextBatch);
}

function clearFindMarks() {
  elements.tableBody.querySelectorAll(".find-match,.find-current").forEach((cell) => cell.classList.remove("find-match", "find-current"));
  elements.tableBody.querySelectorAll(".find-row").forEach((row) => row.classList.remove("find-row"));
}

function updateFindCount() {
  const total = state.findMatches.length;
  const current = total && state.findIndex >= 0 ? state.findIndex + 1 : 0;
  elements.pageFindCount.textContent = `${current} / ${total}${state.hasMore ? "+" : ""}`;
}

function refreshFindMatches(focusCurrent = false) {
  clearFindMarks();
  const query = state.findQuery.trim().toLocaleLowerCase("zh-CN");
  state.findMatches = [];
  if (!query) {
    state.findIndex = -1;
    updateFindCount();
    return;
  }
  for (const row of elements.tableBody.querySelectorAll("tr[data-index]")) {
    let rowMatched = false;
    for (const cell of row.querySelectorAll("td")) {
      if (!cell.textContent.toLocaleLowerCase("zh-CN").includes(query)) continue;
      cell.classList.add("find-match");
      state.findMatches.push(cell);
      rowMatched = true;
    }
    if (rowMatched) row.classList.add("find-row");
  }
  if (!state.findMatches.length) state.findIndex = -1;
  else if (state.findIndex < 0 || state.findIndex >= state.findMatches.length) state.findIndex = 0;
  updateFindCount();
  if (focusCurrent && state.findIndex >= 0) focusFindMatch(state.findIndex);
}

function focusFindMatch(index) {
  if (!state.findMatches.length) return;
  state.findMatches.forEach((cell) => cell.classList.remove("find-current"));
  state.findIndex = (index + state.findMatches.length) % state.findMatches.length;
  const cell = state.findMatches[state.findIndex];
  cell.classList.add("find-current");
  cell.scrollIntoView({ behavior: "auto", block: "center", inline: "center" });
  updateFindCount();
}

function openPageFind() {
  elements.pageFind.hidden = false;
  elements.pageFindInput.focus();
  elements.pageFindInput.select();
  state.findQuery = elements.pageFindInput.value;
  refreshFindMatches(false);
}

function closePageFind() {
  elements.pageFind.hidden = true;
  clearTimeout(findTimer);
  state.findQuery = "";
  state.findMatches = [];
  state.findIndex = -1;
  clearFindMarks();
}

async function findFromInput() {
  const requestedQuery = elements.pageFindInput.value.trim();
  state.findQuery = requestedQuery;
  state.findIndex = -1;
  refreshFindMatches(false);
  if (!requestedQuery || state.findLoading) return;
  state.findLoading = true;
  try {
    while (!state.findMatches.length && state.hasMore && state.findQuery === requestedQuery) {
      const before = state.rows.length;
      await runQuery({ append: true });
      refreshFindMatches(false);
      if (state.rows.length <= before) break;
    }
    if (state.findQuery === requestedQuery && state.findMatches.length) focusFindMatch(0);
  } finally {
    state.findLoading = false;
    if (elements.pageFindInput.value.trim() !== requestedQuery) queueMicrotask(findFromInput);
  }
}

async function navigateFind(direction) {
  state.findQuery = elements.pageFindInput.value.trim();
  refreshFindMatches(false);
  if (!state.findMatches.length) {
    await findFromInput();
    return;
  }
  let nextIndex = state.findIndex + direction;
  if (direction > 0 && nextIndex >= state.findMatches.length && state.hasMore) {
    const previousCount = state.findMatches.length;
    const before = state.rows.length;
    await runQuery({ append: true });
    refreshFindMatches(false);
    if (state.rows.length > before && state.findMatches.length > previousCount) nextIndex = previousCount;
  }
  focusFindMatch(nextIndex);
}

function bindEvents() {
  document.querySelectorAll(".dataset-button").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.dataset === state.dataset) return;
    state.dataset = button.dataset.dataset;
    clearSelection();
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
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openPageFind();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); elements.globalSearch.focus(); }
    if (event.key === "Escape") {
      if (elements.deleteDialog.open) return;
      if (!elements.columnFilterPopover.hidden) { closeColumnFilterPopover(); return; }
      if (!elements.pageFind.hidden) { closePageFind(); return; }
      setPanel("none", false); elements.recordDrawer.hidden = true;
    }
  });
  elements.pageFindInput.addEventListener("input", () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(findFromInput, 220);
  });
  elements.pageFindInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    navigateFind(event.shiftKey ? -1 : 1);
  });
  elements.pageFindPrevious.addEventListener("click", () => navigateFind(-1));
  elements.pageFindNext.addEventListener("click", () => navigateFind(1));
  elements.closePageFind.addEventListener("click", closePageFind);
  elements.tableHead.addEventListener("click", (event) => {
    const header = event.target.closest("th[data-field]");
    if (header) openColumnFilter(header.dataset.field, header);
  });
  elements.tableHead.addEventListener("change", (event) => {
    if (event.target.dataset.role !== "select-loaded") return;
    for (const record of state.rows) {
      const id = recordIdentity(record);
      if (!id) continue;
      if (event.target.checked) state.selectedIds.add(id); else state.selectedIds.delete(id);
    }
    updateSelectionUi();
  });
  elements.tableHead.addEventListener("keydown", (event) => {
    if (!['Enter', ' '].includes(event.key)) return;
    const header = event.target.closest("th[data-field]");
    if (!header) return;
    event.preventDefault();
    openColumnFilter(header.dataset.field, header);
  });
  elements.columnFilterOperator.addEventListener("change", () => {
    if (!columnFilterDraft) return;
    columnFilterDraft.operator = elements.columnFilterOperator.value;
    columnFilterDraft.value = "";
    columnFilterDraft.value2 = "";
    renderColumnFilterValue();
    positionColumnFilterPopover(columnFilterDraft.anchor);
  });
  elements.columnFilterValueWrap.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); applyColumnFilter(); }
  });
  elements.applyColumnFilter.addEventListener("click", applyColumnFilter);
  elements.clearColumnFilter.addEventListener("click", clearColumnFilters);
  elements.closeColumnFilter.addEventListener("click", closeColumnFilterPopover);
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
    state.visibleFields[state.dataset] = orderedDatasetFields().filter((field) => field.defaultVisible).map((field) => field.key);
    savePreferences(); renderFieldOptions(); scheduleQuery(0);
  });
  elements.selectAllFields.addEventListener("click", () => {
    state.visibleFields[state.dataset] = orderedDatasetFields().map((field) => field.key);
    savePreferences(); renderFieldOptions(); scheduleQuery(0);
  });
  elements.addSort.addEventListener("click", () => {
    const field = orderedDatasetFields().find((item) => item.key.endsWith("last_seen_at")) || orderedDatasetFields()[0];
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
    if (event.target.closest('[data-role="select-row"]')) return;
    const row = event.target.closest("tr[data-index]"); if (row) openDrawer(state.rows[Number(row.dataset.index)]);
  });
  elements.tableBody.addEventListener("change", (event) => {
    if (event.target.dataset.role !== "select-row") return;
    const row = event.target.closest("tr[data-record-id]");
    if (!row?.dataset.recordId) return;
    if (event.target.checked) state.selectedIds.add(row.dataset.recordId);
    else state.selectedIds.delete(row.dataset.recordId);
    updateSelectionUi();
  });
  elements.tableBody.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return; const row = event.target.closest("tr[data-index]"); if (row) openDrawer(state.rows[Number(row.dataset.index)]);
  });
  elements.exportCurrent.addEventListener("click", exportCurrentPage);
  elements.deleteSelected.addEventListener("click", () => openDeleteDialog());
  elements.closeDrawer.addEventListener("click", () => { elements.recordDrawer.hidden = true; });
  elements.deleteDrawerRecord.addEventListener("click", () => {
    const id = recordIdentity(state.currentRecord);
    if (id) openDeleteDialog([id]);
  });
  elements.copyRecord.addEventListener("click", async () => {
    if (!state.currentRecord) return; await navigator.clipboard.writeText(JSON.stringify(state.currentRecord, null, 2)); showToast("当前记录 JSON 已复制");
  });
  elements.openRecordLink.addEventListener("click", () => sendRuntime({ type: "openDataOverviewRecord", url: elements.openRecordLink.dataset.url }).catch((error) => showToast(error.message)));
  elements.deleteAcknowledgement.addEventListener("change", () => {
    elements.confirmDelete.disabled = !elements.deleteAcknowledgement.checked || state.deletePending;
  });
  elements.cancelDelete.addEventListener("click", closeDeleteDialog);
  elements.confirmDelete.addEventListener("click", performPermanentDelete);
  elements.deleteDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDeleteDialog(); });
  document.addEventListener("click", (event) => {
    if (!elements.fieldPanel.hidden && !elements.fieldPanel.contains(event.target) && !elements.toggleFields.contains(event.target)) setPanel("none", false);
    if (!elements.columnFilterPopover.hidden
        && !elements.columnFilterPopover.contains(event.target)
        && !event.target.closest("th[data-field]")) closeColumnFilterPopover();
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
