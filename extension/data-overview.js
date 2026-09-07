"use strict";

const byId = (id) => document.getElementById(id);
const elements = {
  notesCount: byId("notesCount"), commentsCount: byId("commentsCount"),
  railHealthDot: byId("railHealthDot"), railHealthText: byId("railHealthText"), railHealthMeta: byId("railHealthMeta"),
  datasetTitle: byId("datasetTitle"), datasetSubtitle: byId("datasetSubtitle"),
  refreshSchema: byId("refreshSchema"), exportCurrent: byId("exportCurrent"), exportLabel: byId("exportLabel"),
  deleteSelected: byId("deleteSelected"), selectedCount: byId("selectedCount"),
  lineageRibbon: byId("lineageRibbon"), consistencyTitle: byId("consistencyTitle"),
  consistencyMeta: byId("consistencyMeta"), snapshotCode: byId("snapshotCode"),
  globalSearch: byId("globalSearch"), toggleFilters: byId("toggleFilters"), filterCount: byId("filterCount"),
  toggleFields: byId("toggleFields"), fieldCount: byId("fieldCount"),
  toggleSort: byId("toggleSort"), sortCount: byId("sortCount"), resetView: byId("resetView"),
  semanticSearch: byId("semanticSearch"), searchSubmit: byId("searchSubmit"),
  semanticStatus: byId("semanticStatus"),
  resultCount: byId("resultCount"),
  resultLabel: byId("resultLabel"),
  filterPanel: byId("filterPanel"), filterLogic: byId("filterLogic"), filterRows: byId("filterRows"),
  addFilter: byId("addFilter"), clearFilters: byId("clearFilters"),
  fieldPanel: byId("fieldPanel"), fieldSearch: byId("fieldSearch"), fieldOptions: byId("fieldOptions"),
  selectDefaultFields: byId("selectDefaultFields"), selectAllFields: byId("selectAllFields"),
  restoreColumnOrder: byId("restoreColumnOrder"), columnOrderHint: byId("columnOrderHint"),
  restoreColumnWidths: byId("restoreColumnWidths"),
  sortPanel: byId("sortPanel"), sortRows: byId("sortRows"), addSort: byId("addSort"), clearSorts: byId("clearSorts"),
  threadGroupingRow: byId("threadGroupingRow"), groupThreads: byId("groupThreads"),
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
const STATUS_FIELDS = new Set(["status", "pull_status", "post_status", "comment_status", "access_status", "post__access_status", "review_status", "analysis_is_negative", "ignore_status", "post__ignore_status"]);
const ACCESS_STATUS_LABELS = Object.freeze({
  ok: "可打开",
  check_failed: "待复核",
  unreachable: "打不开"
});
const LONG_FIELD_HINTS = ["content", "summary", "reason", "json", "error", "categories", "note"];
const MONO_FIELD_HINTS = ["_id", "url", "path", "dir", "hash", "json"];
const NO_VALUE_OPERATORS = new Set(["is_empty", "not_empty", "is_true", "is_false"]);
const REQUIRED_NOTE_FIELDS = new Set(["note_id", "open_material", "ignore_status"]);
const REQUIRED_COMMENT_FIELDS = new Set(["comment_id", "note_id", "post_locator", "thread_root_content"]);
const mediaGallery = globalThis.XhsMonitorOverviewMedia?.create({
  request: (payload) => sendRuntime({ type: "getDataOverviewMedia", payload }),
  onError: (message) => showToast(message)
});
// Detail and table media have separate lifetimes. A table repaint must not
// cancel images in an open record, or attach a previous record's images to it.
const drawerGallery = globalThis.XhsMonitorOverviewMedia?.create({
  request: (payload) => sendRuntime({ type: "getDataOverviewMedia", payload }),
  onError: (message) => showToast(message)
});
const STORAGE_KEY = "xhsMonitorDataOverviewStateV1";
const DATA_OVERVIEW_VERSION = "0.34.0";
const INFINITE_BATCH_SIZE = 100;
const TIME_COLUMNS = {
  published_at: ["published_at_raw", "published_at_precision", "published_at_status"],
  source_published_at: ["source_published_at_raw", "source_published_at_precision", "source_published_at_status"],
  source_updated_at: ["source_updated_at_raw", "source_updated_at_precision", "source_updated_at_status"],
  post__source_published_at: ["post__source_published_at_raw", "post__source_published_at_precision", "post__source_published_at_status"],
  post__source_updated_at: ["post__source_updated_at_raw", "post__source_updated_at_precision", "post__source_updated_at_status"]
};

const state = {
  schema: null,
  dataset: "notes",
  snapshotToken: "",
  visibleFields: { notes: [], comments: [] },
  columnOrder: { notes: [], comments: [] },
  columnWidths: { notes: {}, comments: {} },
  savedViews: {
    notes: { search: "", filterLogic: "and", filters: [], sorts: [] },
    comments: { search: "", filterLogic: "and", filters: [], sorts: [] }
  },
  search: "",
  semanticSearch: false,
  semanticAwaitingSubmit: false,
  filterLogic: "and",
  filters: [],
  sorts: [],
  groupThreads: true,
  exporting: false,
  page: 0,
  pageSize: INFINITE_BATCH_SIZE,
  total: 0,
  rows: [],
  hasMore: true,
  loading: false,
  queryReady: false,
  currentRecord: null,
  currentRecordDataset: "",
  drawerLoading: false,
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
let columnDrag = null;
let columnDragFrame = 0;
let columnLayoutFrame = 0;
let suppressColumnClickUntil = 0;
let drawerSerial = 0;
let drawerOpener = null;
let columnResizeActive = false;
const valueOptionsCache = new Map();
const columnSizer = globalThis.XhsMonitorColumnWidths?.create({
  table: byId("dataTable"), head: elements.tableHead, viewport: elements.tableViewport,
  getFields: () => currentVisibleFields().map(key => fieldMap().get(key)).filter(Boolean),
  getWidths: () => state.columnWidths[state.dataset],
  onCommit: (widths) => {
    state.columnWidths[state.dataset] = widths;
    const saved = savePreferences();
    if (elements.columnOrderHint) elements.columnOrderHint.textContent = saved
      ? "列宽已保存 · 双击列边缘恢复默认" : "列宽已调整；浏览器存储未写入";
  },
  onActiveChange: (active) => {
    columnResizeActive = active;
    elements.tableViewport.classList.toggle("is-column-resizing", active);
    suppressColumnClickUntil = Date.now() + 400;
    if (active) {
      finishColumnDrag();
      if (!elements.columnFilterPopover.hidden) closeColumnFilterPopover();
    }
  },
  onHint: (message) => { if (elements.columnOrderHint) elements.columnOrderHint.textContent = message; }
});

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

function normalizeViewPreferences(value = {}) {
  value = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const filters = Array.isArray(value.filters) ? value.filters.slice(0, 64).map((item) => ({
    id: String(item?.id || crypto.randomUUID()),
    field: String(item?.field || "").slice(0, 160),
    operator: String(item?.operator || "eq").slice(0, 40),
    value: String(item?.value ?? "").slice(0, 5000),
    value2: String(item?.value2 ?? "").slice(0, 5000)
  })).filter((item) => item.field) : [];
  const sorts = Array.isArray(value.sorts) ? value.sorts.slice(0, 16).map((item) => ({
    id: String(item?.id || crypto.randomUUID()),
    field: String(item?.field || "").slice(0, 160),
    direction: item?.direction === "asc" ? "asc" : "desc"
  })).filter((item) => item.field) : [];
  return {
    search: String(value.search || "").slice(0, 1000),
    semanticSearch: value.semanticSearch === true,
    filterLogic: value.filterLogic === "or" ? "or" : "and",
    filters,
    sorts,
    groupThreads: value.groupThreads !== false
  };
}

function captureCurrentView() {
  state.savedViews[state.dataset] = normalizeViewPreferences({
    search: state.search,
    semanticSearch: state.semanticSearch,
    filterLogic: state.filterLogic,
    filters: state.filters,
    sorts: state.sorts,
    groupThreads: state.groupThreads
  });
}

function restoreDatasetView(dataset = state.dataset) {
  const view = normalizeViewPreferences(state.savedViews[dataset]);
  state.savedViews[dataset] = view;
  state.search = view.search;
  state.semanticSearch = view.semanticSearch;
  state.semanticAwaitingSubmit = view.semanticSearch;
  renderSemanticControls();
  state.filterLogic = view.filterLogic;
  state.filters = view.filters;
  state.sorts = view.sorts;
  state.groupThreads = view.groupThreads;
  if (elements.globalSearch) elements.globalSearch.value = state.search;
}

function validateCurrentView() {
  const fields = fieldMap();
  if (!fields.size) return;
  state.filters = state.filters.flatMap((filter) => {
    const field = fields.get(filter.field);
    if (!field?.filterable) return [];
    const operators = operatorsFor(field);
    if (!operators.length) return [];
    const operator = operators.some((item) => item.id === filter.operator)
      ? filter.operator : operators[0].id;
    return [{ ...filter, operator }];
  });
  state.sorts = state.sorts.filter((sort) => fields.get(sort.field)?.sortable)
    .map((sort) => ({ ...sort, direction: sort.direction === "asc" ? "asc" : "desc" }));
  state.filterLogic = state.filterLogic === "or" ? "or" : "and";
  captureCurrentView();
}

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (saved.dataset === "notes" || saved.dataset === "comments") state.dataset = saved.dataset;
    if (saved.visibleFields && typeof saved.visibleFields === "object") {
      state.visibleFields.notes = Array.isArray(saved.visibleFields.notes) ? saved.visibleFields.notes : [];
      state.visibleFields.comments = Array.isArray(saved.visibleFields.comments) ? saved.visibleFields.comments : [];
    }
    if (saved.columnOrder && typeof saved.columnOrder === "object") {
      for (const dataset of ["notes", "comments"]) {
        state.columnOrder[dataset] = XhsMonitorColumnOrder.sanitize(saved.columnOrder[dataset]);
      }
    }
    if (saved.columnWidths && typeof saved.columnWidths === "object") {
      for (const dataset of ["notes", "comments"]) {
        state.columnWidths[dataset] = globalThis.XhsMonitorColumnWidths?.sanitize(saved.columnWidths[dataset]) || {};
      }
    }
    if (saved.savedViews && typeof saved.savedViews === "object") {
      state.savedViews.notes = normalizeViewPreferences(saved.savedViews.notes);
      state.savedViews.comments = normalizeViewPreferences(saved.savedViews.comments);
    }
  } catch (_error) {}
  restoreDatasetView(state.dataset);
}

function savePreferences() {
  captureCurrentView();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 4,
      dataset: state.dataset,
      visibleFields: state.visibleFields,
      columnOrder: state.columnOrder,
      columnWidths: state.columnWidths,
      savedViews: state.savedViews
    }));
    return true;
  } catch (_error) {
    // A failed preference write must never block database queries.
    return false;
  }
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
  return XhsMonitorColumnOrder.orderedKeys(
    orderedDatasetFields().map((field) => field.key), state.columnOrder[state.dataset]
  ).filter((key) => selected.has(key)).slice(0, 180);
}

function reorderRenderedColumns() {
  columnSizer?.cancel();
  const fields = currentVisibleFields();
  const scrollTop = elements.tableViewport.scrollTop;
  const scrollLeft = elements.tableViewport.scrollLeft;
  if (columnLayoutFrame) window.cancelAnimationFrame(columnLayoutFrame);
  // Ignore transient sentinel intersections while rowspan cells change slots.
  columnLayoutFrame = window.requestAnimationFrame(() => {
    columnLayoutFrame = 0;
    const remaining = elements.tableViewport.scrollHeight - elements.tableViewport.scrollTop
      - elements.tableViewport.clientHeight;
    if (remaining < 240) loadNextBatch();
  });
  // Move existing nodes only. This retains selection, rowspans, scroll position
  // and any in-flight infinite-page query; no database request is necessary.
  for (const row of [elements.tableHead, ...elements.tableBody.children]) {
    const cells = new Map(Array.from(row.children)
      .filter((cell) => cell.dataset.field).map((cell) => [cell.dataset.field, cell]));
    let position = Array.from(row.children).filter((cell) => !cell.dataset.field).length;
    fields.forEach((key, index) => {
      const cell = cells.get(key);
      if (!cell) return; // A second-level row shares its parent's rowspan cell.
      if (row.children[position] !== cell) row.insertBefore(cell, row.children[position] || null);
      cell.setAttribute("aria-colindex", String(index + 3));
      position += 1;
    });
  }
  columnSizer?.sync();
  elements.tableViewport.scrollTop = scrollTop;
  elements.tableViewport.scrollLeft = scrollLeft;
  refreshFindMatches(false);
}

function reorderColumn(sourceKey, targetKey, side = "before") {
  const visible = currentVisibleFields();
  if (!visible.includes(sourceKey) || !visible.includes(targetKey)) return false;
  const available = orderedDatasetFields().map((field) => field.key);
  const previous = XhsMonitorColumnOrder.orderedKeys(available, state.columnOrder[state.dataset]);
  const next = XhsMonitorColumnOrder.move(available, previous, sourceKey, targetKey, side);
  if (next.every((key, index) => key === previous[index])) return false;
  state.columnOrder[state.dataset] = next;
  const saved = savePreferences();
  if (!elements.columnFilterPopover.hidden) closeColumnFilterPopover();
  reorderRenderedColumns();
  const label = fieldMap().get(sourceKey)?.label || sourceKey;
  if (elements.columnOrderHint) elements.columnOrderHint.textContent = saved
    ? `${label} · 列顺序已保存` : "顺序已调整；浏览器存储未写入，请检查可用空间";
  return true;
}

function resetColumnOrder() {
  finishColumnDrag();
  state.columnOrder[state.dataset] = [];
  const saved = savePreferences();
  if (!elements.columnFilterPopover.hidden) closeColumnFilterPopover();
  reorderRenderedColumns();
  if (elements.columnOrderHint) elements.columnOrderHint.textContent = saved
    ? "已恢复默认列顺序 · 拖动表头可调整" : "默认顺序已恢复；浏览器存储未写入";
}

function clearColumnDropMarker() {
  for (const header of elements.tableHead.children) delete header.dataset.dropSide;
}

function finishColumnDrag() {
  if (!columnDrag) return;
  suppressColumnClickUntil = Date.now() + 400;
  columnDrag = null;
  if (columnDragFrame) window.cancelAnimationFrame(columnDragFrame);
  columnDragFrame = 0;
  elements.tableViewport.classList.remove("is-column-dragging");
  for (const header of elements.tableHead.children) header.classList.remove("is-drag-source");
  clearColumnDropMarker();
}

function updateColumnDropMarker() {
  if (!columnDrag || columnDrag.dataset !== state.dataset) return false;
  clearColumnDropMarker();
  columnDrag.targetKey = "";
  const viewport = elements.tableViewport.getBoundingClientRect();
  const { x, y } = columnDrag;
  // Utility selection/row-number columns stay frozen and are not drop targets.
  const utilityRight = Array.from(elements.tableHead.children)
    .filter((header) => !header.dataset.field)
    .reduce((right, header) => Math.max(right, header.getBoundingClientRect().right), viewport.left);
  if (x < utilityRight || x > viewport.right || y < viewport.top || y > viewport.bottom) return false;
  const headers = Array.from(elements.tableHead.children).filter((header) => header.dataset.field);
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const rect = header.getBoundingClientRect();
    if (rect.right <= utilityRight || rect.left >= viewport.right) continue;
    if (x <= rect.right || index === headers.length - 1) {
      if (header.dataset.field === columnDrag.sourceKey) return true;
      const side = x < rect.left + rect.width / 2 ? "before" : "after";
      columnDrag.targetKey = header.dataset.field;
      columnDrag.side = side;
      header.dataset.dropSide = side;
      return true;
    }
  }
  return true;
}

function scrollDuringColumnDrag() {
  columnDragFrame = 0;
  if (!columnDrag) return;
  if (columnDrag.dataset !== state.dataset) { finishColumnDrag(); return; }
  const rect = elements.tableViewport.getBoundingClientRect();
  const { x, y } = columnDrag;
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
  const left = rect.left + 84; // Two frozen 42px utility columns.
  const edge = 48;
  const speed = x < left + edge ? -Math.ceil(Math.min(1, (left + edge - x) / edge) * 18)
    : x > rect.right - edge ? Math.ceil(Math.min(1, (x - rect.right + edge) / edge) * 18) : 0;
  if (!speed) return;
  const before = elements.tableViewport.scrollLeft;
  elements.tableViewport.scrollLeft += speed;
  updateColumnDropMarker();
  if (elements.tableViewport.scrollLeft !== before) {
    columnDragFrame = window.requestAnimationFrame(scrollDuringColumnDrag);
  }
}

function trackColumnDrag(event) {
  if (!columnDrag) return;
  if (columnDrag.dataset !== state.dataset) { finishColumnDrag(); return; }
  columnDrag.x = event.clientX;
  columnDrag.y = event.clientY;
  updateColumnDropMarker();
  if (!columnDragFrame) columnDragFrame = window.requestAnimationFrame(scrollDuringColumnDrag);
}

function initializeColumnDragging() {
  elements.tableHead.addEventListener("dragstart", (event) => {
    if (columnResizeActive || event.target.closest(".column-resize-handle")) { event.preventDefault(); return; }
    const header = event.target.closest("th[data-field]");
    if (!header || !currentVisibleFields().includes(header.dataset.field) || !event.dataTransfer) {
      event.preventDefault(); return;
    }
    finishColumnDrag();
    if (!elements.columnFilterPopover.hidden) closeColumnFilterPopover();
    columnDrag = { sourceKey: header.dataset.field, dataset: state.dataset,
      targetKey: "", side: "before", x: event.clientX, y: event.clientY };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-xhs-column", header.dataset.field);
    event.dataTransfer.setData("text/plain", fieldMap().get(header.dataset.field)?.label || header.dataset.field);
    header.classList.add("is-drag-source");
    elements.tableViewport.classList.add("is-column-dragging");
  });
  for (const type of ["dragenter", "dragover"]) {
    elements.tableViewport.addEventListener(type, (event) => {
      if (!columnDrag) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
  }
  // Updating the pointer outside the table stops edge scrolling immediately.
  window.addEventListener("dragover", trackColumnDrag);
  window.addEventListener("dragenter", trackColumnDrag);
  elements.tableViewport.addEventListener("drop", (event) => {
    if (!columnDrag) return;
    event.preventDefault(); event.stopPropagation();
    trackColumnDrag(event);
    const drag = { ...columnDrag };
    finishColumnDrag();
    if (drag.dataset === state.dataset && drag.targetKey) {
      reorderColumn(drag.sourceKey, drag.targetKey, drag.side);
    }
  });
  window.addEventListener("dragend", finishColumnDrag);
  window.addEventListener("drop", (event) => {
    if (!columnDrag) return;
    // A cancelled column drag must not insert its label into the search box.
    event.preventDefault();
    finishColumnDrag();
  });
  window.addEventListener("blur", finishColumnDrag);
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
    ? `Bridge ${state.schema?.version || ""} · 界面 ${DATA_OVERVIEW_VERSION} · relationshipsConsistent=true · 只读快照`
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

function fieldOptionsHtml(selectedKey = "", mode = "all") {
  const groups = new Map();
  for (const field of orderedDatasetFields()) {
    if (mode === "filter" && !field.filterable) continue;
    if (mode === "sort" && !field.sortable) continue;
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
    const field = fieldMap().get(header.dataset.field);
    const badge = header.querySelector("i");
    if (field?.filterable === false) {
      header.dataset.filtered = "false";
      if (badge) badge.textContent = "↗";
      continue;
    }
    const count = state.filters.filter((item) => item.field === header.dataset.field).length;
    header.dataset.filtered = String(count > 0);
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
    fieldSelect.innerHTML = fieldOptionsHtml(filter.field, "filter");
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

function renderSemanticControls(result = null) {
  elements.semanticSearch.checked = state.semanticSearch;
  elements.semanticStatus.textContent = !state.semanticSearch ? "普通搜索 · 关键词匹配"
    : state.semanticAwaitingSubmit ? "语义检索待提交 · 点击搜索或按 Enter；表内仍为上次结果，已暂停选择与删除"
    : result?.semantic?.mode === "embedding" ? `语义检索 · ${String(result.semantic.model || "")} · 最多${Number.isFinite(result.semantic.limit) ? result.semantic.limit : "未返回"}条 · 阈值${Number.isFinite(result.semantic.minimumScore) ? result.semantic.minimumScore.toFixed(2) : "0.50"} · 相关度降序（非置信度）`
    : "语义检索 · 按相关度排序，暂不合并楼层";
}

function markSemanticDraft() {
  clearTimeout(queryTimer);
  state.resetScheduled = false;
  state.semanticAwaitingSubmit = true;
  clearSelection();
  closeDeleteDialog();
  elements.deleteDrawerRecord.disabled = true;
  elements.exportCurrent.disabled = true;
  savePreferences();
  renderSemanticControls();
}

function submitSearch() {
  state.search = elements.globalSearch.value;
  if (state.semanticSearch && !state.search.trim()) {
    markSemanticDraft();
    showToast("请输入语义查询，再点击搜索");
    return;
  }
  state.semanticAwaitingSubmit = false;
  renderSemanticControls();
  scheduleQuery(0, true);
}

function renderSorts() {
  elements.threadGroupingRow.hidden = state.dataset !== "comments";
  elements.groupThreads.checked = state.groupThreads && !state.semanticSearch;
  elements.groupThreads.disabled = state.semanticSearch;
  elements.sortRows.hidden = state.semanticSearch;
  elements.addSort.disabled = state.semanticSearch;
  elements.clearSorts.disabled = state.semanticSearch;
  renderSemanticControls();
  elements.sortRows.replaceChildren();
  for (const sort of state.sorts) {
    const row = document.createElement("div");
    row.className = "builder-row";
    row.dataset.sortId = sort.id;
    const field = document.createElement("select");
    field.dataset.role = "field";
    field.innerHTML = fieldOptionsHtml(sort.field, "sort");
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

function scheduleQuery(delay = 220, explicitSearch = false) {
  if (state.semanticSearch && !explicitSearch) { markSemanticDraft(); return; }
  clearTimeout(queryTimer);
  elements.exportCurrent.disabled = true;
  savePreferences();
  state.resetScheduled = true;
  queryTimer = setTimeout(() => {
    state.resetScheduled = false;
    runQuery({ append: false });
  }, delay);
}

function queryPayload(page = 1) {
  const fields = currentVisibleFields();
  const available = fieldMap();
  for (const key of [...fields]) {
    for (const metadataKey of TIME_COLUMNS[key] || []) {
      if (available.has(metadataKey) && !fields.includes(metadataKey)) fields.push(metadataKey);
    }
  }
  if (fields.some((key) => TIME_COLUMNS[key]) && available.has("time_observed_at") && !fields.includes("time_observed_at")) {
    fields.push("time_observed_at");
  }
  if (fields.some((key) => key.startsWith("post__") && TIME_COLUMNS[key])
      && available.has("post__time_observed_at") && !fields.includes("post__time_observed_at")) {
    fields.push("post__time_observed_at");
  }
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
    semanticSearch: state.semanticSearch,
    filter: { logic: state.filterLogic, children: state.filters.map(({ id, ...filter }) => filter) },
    sort: state.semanticSearch ? [] : state.sorts.map(({ id, ...sort }) => sort),
    groupThreads: state.dataset === "comments" && state.groupThreads && !state.semanticSearch,
    page,
    pageSize: state.pageSize
  };
}

async function loadSchema({ preserveQuery = true } = {}) {
  closeDrawer();
  columnSizer?.cancel();
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
    // Add the requested region columns once, without losing saved filters/order.
    try {
      if (!localStorage.getItem("dataOverviewIpRegionIntroducedV1")) {
        let introduced = false;
        for (const dataset of ["notes", "comments"]) {
          const key = dataset === "notes" ? "source_ip_location" : "ip_location";
          const after = dataset === "notes" ? "source_published_at" : "published_at";
          if (result.datasets?.[dataset]?.fields?.some(field => field.key === key)) {
            const keys = state.visibleFields[dataset];
            if (!keys.includes(key)) keys.splice(Math.max(0, keys.indexOf(after) + 1), 0, key);
            const order = state.columnOrder[dataset];
            if (order.length && !order.includes(key)) order.splice(Math.max(0, order.indexOf(after) + 1), 0, key);
            introduced = true;
          }
        }
        if (introduced && savePreferences()) localStorage.setItem("dataOverviewIpRegionIntroducedV1", "1");
      }
    } catch (_error) {}
    // One-time additive migration; failures to save preferences never block data queries.
    try {
      if (!localStorage.getItem("dataOverviewMediaIntroducedV1")) {
        let introduced = false;
        for (const dataset of ["notes", "comments"]) {
          if (result.datasets?.[dataset]?.fields?.some(field => field.key === "media_preview")) {
            const keys = state.visibleFields[dataset];
            if (!keys.includes("media_preview")) keys.splice(Math.max(0, keys.indexOf(dataset === "notes" ? "title" : "content") + 1), 0, "media_preview");
            const order = state.columnOrder[dataset];
            if (order.length && !order.includes("media_preview")) order.splice(Math.max(0, order.indexOf(dataset === "notes" ? "title" : "content") + 1), 0, "media_preview");
            introduced = true;
          }
        }
        if (introduced && savePreferences()) localStorage.setItem("dataOverviewMediaIntroducedV1", "1");
      }
    } catch (_error) {}
    if (!preserveQuery) {
      state.filters = [];
      state.sorts = [];
      state.search = "";
      state.filterLogic = "and";
    }
    validateCurrentView();
    elements.globalSearch.value = state.search;
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
  elements.deleteSelected.disabled = state.semanticAwaitingSubmit || count === 0 || state.deletePending || state.exporting;
  elements.confirmDelete.disabled = state.semanticAwaitingSubmit || !elements.deleteAcknowledgement.checked || state.deletePending || state.exporting;
  elements.deleteSelected.title = count
    ? `永久删除选中的 ${count} 条本地记录`
    : "先勾选要删除的数据";
  const loadedIds = state.rows.map((record) => recordIdentity(record)).filter(Boolean);
  const selectedLoaded = loadedIds.filter((id) => state.selectedIds.has(id)).length;
  const selectAll = elements.tableHead.querySelector('[data-role="select-loaded"]');
  if (selectAll) {
    selectAll.checked = loadedIds.length > 0 && selectedLoaded === loadedIds.length;
    selectAll.indeterminate = selectedLoaded > 0 && selectedLoaded < loadedIds.length;
    selectAll.disabled = state.semanticAwaitingSubmit || loadedIds.length === 0 || state.deletePending;
  }
  for (const row of elements.tableBody.querySelectorAll("tr[data-record-id]")) {
    const selected = state.selectedIds.has(row.dataset.recordId);
    row.dataset.selected = String(selected);
    const input = row.querySelector('[data-role="select-row"]');
    if (input) { input.checked = selected; input.disabled = state.semanticAwaitingSubmit || state.deletePending; }
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
  if (state.semanticAwaitingSubmit) { showToast("请先提交搜索，再选择要删除的结果"); return; }
  if (state.deletePending || state.exporting) { showToast("请等待当前删除或导出完成"); return; }
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
  if (state.semanticAwaitingSubmit) return;
  if (state.deletePending || !elements.deleteAcknowledgement.checked) return;
  if (state.exporting) { showToast("请等待导出完成后再删除"); return; }
  const ids = [...state.pendingDeleteIds];
  if (!ids.length) return;
  state.deletePending = true;
  elements.exportCurrent.disabled = true;
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
    closeDrawer();
    if (elements.deleteDialog.open) elements.deleteDialog.close();
    clearSelection();
    await loadSchema({ preserveQuery: true });
    const cascaded = Number(result.cascadeDeletedCount || result.deletedCommentCount || 0);
    const failureText = Number(result.failureCount || 0) ? `，${result.failureCount} 条失败` : "";
    showToast(`已永久删除 ${Number(result.deletedCount || 0)} 条${cascaded ? `，级联清理 ${cascaded} 条评论` : ""}${failureText}`);
  } catch (error) {
    if (elements.deleteDialog.open) elements.deleteDialog.close();
    await loadSchema({ preserveQuery: true }).catch(() => {});
    showToast(error.message || "删除没有完成");
  } finally {
    state.deletePending = false;
    state.pendingDeleteIds = [];
    elements.confirmDelete.textContent = "永久删除";
    elements.deleteAcknowledgement.checked = false;
    elements.confirmDelete.disabled = true;
    updateSelectionUi();
    elements.exportCurrent.disabled = state.exporting || !state.queryReady || state.loading
      || state.resetScheduled || state.queryPending || state.total === 0;
  }
}

function resetLoadedRows() {
  columnSizer?.cancel();
  finishColumnDrag();
  mediaGallery?.reset();
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
  if (!state.queryReady || state.semanticAwaitingSubmit) return;
  if (!append) {
    // A direct reset (dataset switch/schema refresh) supersedes any older debounce.
    clearTimeout(queryTimer);
    state.resetScheduled = false;
  }
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
    const payload = queryPayload(requestedPage);
    const result = await sendRuntime({ type: "queryDataOverview", payload });
    // A response must not render old criteria or shorten a newer edit's debounce.
    if (serial !== state.querySerial || state.resetScheduled || state.queryPending || state.semanticAwaitingSubmit) return;
    if (payload.semanticSearch === true && result.semantic?.mode !== "embedding") {
      throw new Error("后端未返回语义检索结果，请升级并重启后端 0.34.0 后重试。");
    }
    const incomingRows = result.rows || [];
    state.rows = append ? [...state.rows, ...incomingRows] : incomingRows;
    state.total = Number(result.total) || 0;
    state.page = Number(result.page) || 1;
    state.pageSize = Number(result.pageSize) || state.pageSize;
    state.snapshotToken = result.snapshotToken || state.snapshotToken;
    const pageCount = Math.max(1, Number(result.pageCount) || Math.ceil(state.total / state.pageSize) || 1);
    state.hasMore = incomingRows.length > 0 && state.rows.length < state.total && state.page < pageCount;
    renderSemanticControls(result);
    if (state.semanticSearch) {
      // The backend ranks the complete result before pagination; keep loaded rows
      // descending too without changing the original records used by details/export.
      state.rows.sort((a, b) => semanticScore(b) - semanticScore(a));
      renderTable(result, { append: false, incomingRows: state.rows });
    } else renderTable(result, { append, incomingRows });
  } catch (error) {
    if (serial !== state.querySerial || state.resetScheduled || state.queryPending || state.semanticAwaitingSubmit) return;
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
      const rerun = state.queryPending && !state.resetScheduled;
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

async function locatePostInDatabase(noteId) {
  const targetId = String(noteId || "").trim();
  if (!targetId) { showToast("该评论缺少关联笔记 ID"); return; }
  closeDrawer();
  columnSizer?.cancel();
  captureCurrentView();
  state.dataset = "notes";
  state.page = 0;
  state.search = "";
  state.filterLogic = "and";
  state.semanticSearch = false;
  state.semanticAwaitingSubmit = false;
  state.filters = [{ id: crypto.randomUUID(), field: "note_id", operator: "eq", value: targetId, value2: "" }];
  state.sorts = [];
  elements.globalSearch.value = "";
  document.querySelectorAll("[data-quick-view]").forEach((item) => item.classList.remove("is-active"));
  renderSchemaState();
  renderFieldOptions();
  renderFilters();
  renderSorts();
  savePreferences();
  await runQuery({ append: false });
  const row = elements.tableBody.querySelector("tr[data-record-id]");
  row?.scrollIntoView({ block: "center", inline: "nearest" });
  showToast(state.total === 1 ? "已定位到帖子数据库" : "未找到对应的帖子记录");
}

async function runTableAction(button) {
  const action = button?.dataset.action || "";
  const value = button?.dataset.value || "";
  if (!action || !value || button.disabled) return;
  button.disabled = true;
  const original = button.textContent;
  try {
    if (action === "locate_comment") {
      button.textContent = "定位中…";
      const result = await sendRuntime({ type: "locateDataOverviewComment", commentId: value });
      showToast(result?.ok ? "已在新标签页定位原评论" : (result?.error || "原帖已打开，当前未找到对应评论"));
      return;
    }
    if (action === "locate_post") {
      button.textContent = "定位中…";
      await locatePostInDatabase(value);
      return;
    }
    if (action === "open_material") {
      button.textContent = "打开中…";
      await sendRuntime({ type: "openLocalArtifact", payload: { kind: "folder", noteId: value } });
      showToast("已打开本地素材目录");
    }
  } catch (error) {
    showToast(error.message || "操作没有完成");
  } finally {
    if (button.isConnected) { button.disabled = false; button.textContent = original; }
  }
}

function semanticScore(record) {
  const value = record._semantic_score;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : -1;
}

function appendSemanticEvidence(cell, record) {
  const box = document.createElement("div");
  box.className = "semantic-evidence";
  const score = document.createElement("strong");
  const value = semanticScore(record);
  score.textContent = value < 0 ? "相关度：未返回" : `相关度 ${(value * 100).toFixed(1)} · 综合排序分`;
  if (typeof record._semantic_cosine === "number" && Number.isFinite(record._semantic_cosine)) {
    score.title = `原始 cosine：${record._semantic_cosine}`;
  }
  const evidence = document.createElement("p");
  evidence.textContent = typeof record._semantic_evidence === "string" && record._semantic_evidence
    ? record._semantic_evidence : "未返回匹配证据";
  box.append(score, evidence);
  const evidenceStatus = typeof record._semantic_evidence_status === "string" ? record._semantic_evidence_status : "";
  const commentId = typeof record._semantic_comment_id === "string" ? record._semantic_comment_id : "";
  if (commentId || evidenceStatus) {
    const id = document.createElement("small");
    id.textContent = `${evidenceStatus || "来源状态未返回"}${commentId ? ` · 证据评论 ID：${commentId}` : ""}`;
    box.append(id);
  }
  cell.append(box);
}

function renderTable(result, { append = false, incomingRows = result.rows || [] } = {}) {
  const fields = currentVisibleFields();
  const map = fieldMap();
  if (!append) {
    columnSizer?.cancel();
    finishColumnDrag();
    mediaGallery?.reset();
    threadMergeCell = null;
    elements.tableHead.replaceChildren();
    const selectColumn = document.createElement("th");
    selectColumn.scope = "col";
    selectColumn.className = "select-column";
    const selectLoaded = document.createElement("input");
    selectLoaded.type = "checkbox"; selectLoaded.dataset.role = "select-loaded";
    selectLoaded.setAttribute("aria-label", "选择当前已加载的全部记录");
    selectColumn.append(selectLoaded); elements.tableHead.append(selectColumn);
    const rowNumber = document.createElement("th");
    rowNumber.scope = "col";
    rowNumber.className = "row-number-column"; rowNumber.textContent = "#"; elements.tableHead.append(rowNumber);
    for (const key of fields) {
      const field = map.get(key);
      const th = document.createElement("th");
      th.className = field?.filterable ? "filterable-header" : "action-header";
      th.tabIndex = 0;
      th.scope = "col";
      th.draggable = true;
      th.dataset.field = key;
      th.setAttribute("aria-colindex", String(fields.indexOf(key) + 3));
      th.setAttribute("aria-keyshortcuts", "Alt+ArrowLeft Alt+ArrowRight");
      th.title = `${field?.label || key} · 拖动表头调顺序 · 拖动右边缘调宽度${field?.filterable ? " · 点击筛选" : ""}`;
      th.dataset.type = field?.dataType || "text";
      const wrap = document.createElement("span");
      const grip = document.createElement("button");
      grip.type = "button"; grip.className = "column-grip"; grip.draggable = true;
      grip.setAttribute("aria-label", `移动${field?.label || key}列`);
      grip.title = "拖动调整顺序；也可按 Alt + 左右方向键";
      grip.textContent = "⠿";
      const name = document.createElement("b"); name.textContent = field?.label || key;
      const filterIcon = document.createElement("i");
      filterIcon.textContent = field?.filterable ? "⌄" : "↗"; filterIcon.setAttribute("aria-hidden", "true");
      wrap.append(grip, name, filterIcon); th.append(wrap);
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
      if (state.dataset === "comments" && state.groupThreads && !state.semanticSearch && key === "thread_root_content") {
        if (threadMergeCell?.key === threadKey) {
          threadMergeCell.span += 1;
          threadMergeCell.cell.rowSpan = threadMergeCell.span;
          continue;
        }
        const rootCell = document.createElement("td");
        rootCell.dataset.field = key;
        rootCell.setAttribute("aria-colindex", String(fields.indexOf(key) + 3));
        rootCell.dataset.type = "text";
        rootCell.dataset.long = "true";
        rootCell.className = "thread-root-cell";
        renderThreadRootCell(rootCell, record);
        tr.append(rootCell);
        threadMergeCell = { key: threadKey, cell: rootCell, span: 1 };
        continue;
      }
      const td = document.createElement("td");
      td.dataset.field = key;
      td.setAttribute("aria-colindex", String(fields.indexOf(key) + 3));
      td.dataset.type = field.dataType;
      td.dataset.long = String(LONG_FIELD_HINTS.some((hint) => key.includes(hint)));
      td.dataset.mono = String(MONO_FIELD_HINTS.some((hint) => key.includes(hint)));
      renderCell(td, record[key], key, field.dataType, field, record);
      // Attach to an existing cell: no synthetic field/column or colgroup changes.
      const evidenceField = fields.includes("content") ? "content"
        : fields.includes("title") ? "title" : fields[0];
      if (state.semanticSearch && key === evidenceField) appendSemanticEvidence(td, record);
      tr.append(td);
    }
    elements.tableBody.append(tr);
  }
  if (!append) columnSizer?.sync();
  elements.resultCount.textContent = state.total.toLocaleString("zh-CN");
  elements.resultLabel.textContent = state.filters.length || state.search ? "条筛选结果" : "条结果";
  elements.tableEmpty.hidden = state.rows.length > 0;
  if (!state.rows.length) {
    elements.tableEmpty.querySelector("strong").textContent = "没有符合当前条件的数据";
    elements.tableEmpty.querySelector("p").textContent = "调整筛选条件或切换快捷视图。";
  }
  elements.exportCurrent.disabled = state.exporting || state.deletePending || state.total === 0;
  elements.exportCurrent.title = `按当前筛选、搜索和排序导出全部 ${state.total.toLocaleString("zh-CN")} 条结果（不限已加载行）`;
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

function renderCell(td, value, key, dataType, field = {}, record = {}) {
  if (field.action === "preview_media") {
    td.dataset.media = "true";
    mediaGallery?.mount(td, { dataset: state.dataset, recordId: recordIdentity(record), title: record.title || record.content || "素材图片" });
    return;
  }
  if (state.dataset === "comments" && key === "content") {
    const prose = document.createElement("div");
    prose.className = "comment-original"; prose.textContent = compactValue(value, 180) || "—"; prose.title = String(value || "");
    const button = document.createElement("button");
    button.type = "button"; button.className = "cell-action comment-locate";
    button.dataset.action = "locate_comment"; button.dataset.value = String(record.comment_id || "");
    button.disabled = !record.comment_id; button.textContent = "定位原评论 ↗";
    button.title = "新标签页打开原帖，展开回复并高亮这条评论；不修改同步状态";
    td.append(prose, button); return;
  }
  if (field.action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cell-action";
    button.dataset.action = field.action;
    button.dataset.value = String(value || "");
    button.disabled = !value;
    button.textContent = field.action === "open_material"
      ? (value ? "打开素材" : "暂无素材")
      : (value ? "定位原帖" : "无法定位");
    td.append(button);
    return;
  }
  if (["source_ip_location", "ip_location", "post__source_ip_location"].includes(key)) {
    td.textContent = value || "未显示";
    td.title = value ? `平台显示的 IP 属地：${value}（非网络 IP 地址）` : "页面没有可确认的 IP 属地，未推断地区";
    return;
  }
  if (TIME_COLUMNS[key]) {
    const [rawKey, precisionKey, statusKey] = TIME_COLUMNS[key];
    const precision = record[precisionKey] || "";
    const status = record[statusKey] || "";
    const fromEdit = status === "estimated_from_edit";
    td.textContent = value || (status === "edited_only" ? "待按编辑时间换算" : "待补充");
    td.title = [`原文：${record[rawKey] || "未显示"}`, `北京时间：${value || "待核验"}`,
      `采集基准：${record[key.startsWith("post__") ? "post__time_observed_at" : "time_observed_at"] || "未记录"}`,
      `精度：${({ second: "秒", minute: "分钟", hour: "小时（约）", day: "日" })[precision] || "未确定"}`,
      fromEdit ? "根据本次采集的编辑时间推算，供筛选和排序使用；不代表首次发布时间"
        : status === "estimated" ? "相对时间或年份推算，原文已保留" : ""].filter(Boolean).join("\n");
    if (value && (status === "estimated" || fromEdit)) {
      const badge = document.createElement("small"); badge.className = "date-estimate";
      badge.textContent = fromEdit ? "编辑推算" : "推算"; td.append(badge);
    }
    return;
  }
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
    const rawValue = String(value);
    const isAccessStatus = key === "access_status" || key === "post__access_status";
    span.textContent = isAccessStatus ? (ACCESS_STATUS_LABELS[rawValue] || rawValue) : rawValue;
    if (rawValue === "check_failed") {
      span.title = "本次访问核验未完成，不代表帖子打不开；已有可打开结论不会再被此状态覆盖。";
    }
    span.dataset.state = /已删除|unreachable|failed|差评/.test(rawValue) ? "deleted"
      : /已忽略|ignored/.test(rawValue) ? "ignored"
      : /存在|known|synced|ok|未忽略|是/.test(rawValue) ? "active" : "pending";
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

function closeDrawer({ restoreFocus = false } = {}) {
  drawerSerial++;
  state.currentRecord = null;
  state.currentRecordDataset = "";
  state.drawerLoading = false;
  drawerGallery?.reset();
  elements.recordDrawer.hidden = true;
  elements.recordDrawer.setAttribute("aria-busy", "false");
  elements.drawerFields.replaceChildren();
  if (restoreFocus && drawerOpener?.isConnected) drawerOpener.focus({ preventScroll: true });
  drawerOpener = null;
}

async function openDrawer(record) {
  if (!record || !state.queryReady || state.deletePending) return;
  const dataset = state.dataset, recordId = recordIdentity(record, dataset), snapshotToken = state.snapshotToken;
  if (!recordId) return;
  const serial = ++drawerSerial;
  const fields = [...datasetSchema().fields].sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
  drawerOpener = document.activeElement;
  drawerGallery?.reset();
  state.currentRecord = record;
  state.currentRecordDataset = dataset;
  state.drawerLoading = true;
  elements.copyRecord.disabled = true;
  elements.deleteDrawerRecord.disabled = true;
  elements.openRecordLink.hidden = true;
  elements.drawerType.textContent = dataset === "notes" ? "帖子详情 · POST RECORD" : "评论详情 · COMMENT RECORD";
  elements.drawerTitle.textContent = (dataset === "notes" ? record.title : record.author) || recordId;
  elements.drawerFields.replaceChildren();
  const loading = document.createElement("p"); loading.className = "detail-loading";
  loading.setAttribute("role", "status"); loading.textContent = "正在读取完整记录与图片…";
  elements.drawerFields.append(loading);
  elements.drawerFields.scrollTop = 0;
  elements.recordDrawer.hidden = false;
  elements.recordDrawer.setAttribute("aria-busy", "true");
  const current = () => serial === drawerSerial && state.dataset === dataset && !elements.recordDrawer.hidden && state.snapshotToken === snapshotToken;
  try {
    const full = await XhsMonitorRecordDetails.fetchRecord({
      dataset, recordId, expectedNoteId: record.note_id || "", fields, snapshotToken, isCurrent: current,
      request: payload => sendRuntime({ type: "queryDataOverview", payload })
    });
    if (!full || !current()) return;
    state.currentRecord = full;
    elements.drawerTitle.textContent = (dataset === "notes" ? full.title : full.author) || recordId;
    XhsMonitorRecordDetails.render(elements.drawerFields, {
      dataset, record: full, fields, snapshotToken, gallery: drawerGallery,
      onAction: button => { if (current()) runTableAction(button); }
    });
    const url = XhsMonitorRecordDetails.safeLink(full.url || full.post__url);
    elements.openRecordLink.hidden = !url;
    elements.openRecordLink.dataset.url = url;
    elements.copyRecord.disabled = false;
    elements.deleteDrawerRecord.disabled = state.semanticAwaitingSubmit;
  } catch (error) {
    if (!current()) return;
    state.currentRecord = null;
    const message = document.createElement("p"); message.className = "detail-load-error";
    message.setAttribute("role", "alert"); message.textContent = error.message || "详情读取失败";
    const retry = document.createElement("button"); retry.className = "detail-action"; retry.type = "button";
    retry.textContent = "刷新校验后重试";
    retry.addEventListener("click", async () => {
      if (!current()) return;
      const refresh = loadSchema({ preserveQuery: true });
      const refreshSerial = drawerSerial;
      await refresh;
      if (drawerSerial === refreshSerial && state.dataset === dataset && state.queryReady && elements.recordDrawer.hidden) openDrawer(record);
    });
    elements.drawerFields.replaceChildren(message, retry);
  } finally {
    if (current()) {
      state.drawerLoading = false;
      elements.recordDrawer.setAttribute("aria-busy", "false");
    }
  }
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
  const requested = fieldMap().get(fieldKey);
  const field = (requested?.filterable ? requested : null)
    || orderedDatasetFields().find((item) => item.filterable && item.key === (state.dataset === "notes" ? "title" : "content"))
    || orderedDatasetFields().find((item) => item.filterable);
  if (!field) return;
  const operator = operatorsFor(field)[0]?.id || "eq";
  state.filters.push({ id: crypto.randomUUID(), field: field.key, operator, value: "", value2: "" });
  renderFilters();
  setPanel("filters", true);
  savePreferences();
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

function resetCurrentView() {
  columnSizer?.cancel();
  finishColumnDrag();
  clearTimeout(queryTimer);
  state.search = "";
  state.semanticSearch = false;
  state.semanticAwaitingSubmit = false;
  state.filterLogic = "and";
  state.filters = [];
  state.sorts = [];
  state.groupThreads = true;
  state.columnOrder[state.dataset] = [];
  state.columnWidths[state.dataset] = {};
  if (elements.columnOrderHint) elements.columnOrderHint.textContent = "拖动表头调整列顺序 · 自动保存";
  state.visibleFields[state.dataset] = orderedDatasetFields()
    .filter((field) => field.defaultVisible)
    .map((field) => field.key);
  state.savedViews[state.dataset] = normalizeViewPreferences({});
  elements.globalSearch.value = "";
  elements.fieldSearch.value = "";
  elements.pageFindInput.value = "";
  if (!elements.pageFind.hidden) closePageFind();
  if (!elements.columnFilterPopover.hidden) closeColumnFilterPopover();
  setPanel("none", false);
  clearSelection();
  document.querySelectorAll("[data-quick-view]").forEach((item) => item.classList.remove("is-active"));
  renderFieldOptions();
  renderFilters();
  renderSorts();
  savePreferences();
  scheduleQuery(0);
  showToast("当前视图已重置为默认设置");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

async function exportCurrentPage() {
  if (state.semanticAwaitingSubmit) { showToast("请先提交搜索，再导出结果"); return; }
  if (state.exporting) return;
  if (state.deletePending) { showToast("请等待删除及数据校验完成后再导出"); return; }
  if (!state.queryReady || state.loading || state.resetScheduled || state.queryPending) {
    showToast("请等待当前筛选查询完成后再导出"); return;
  }
  const map = fieldMap();
  const fields = currentVisibleFields().filter((key) => !map.get(key)?.action);
  const payload = { ...queryPayload(1), fields };
  const expectedTotal = state.total;
  const columns = fields.map((key) => ({ key, label: map.get(key)?.label || key, dataType: map.get(key)?.dataType }));
  state.exporting = true;
  // Export and deletion are mutually exclusive until their async work settles.
  updateSelectionUi();
  elements.exportCurrent.disabled = true;
  elements.exportLabel.textContent = "正在导出…";
  try {
    const result = await XhsMonitorDataExport.collectFilteredRows(
      (request) => sendRuntime({ type: "queryDataOverview", payload: request }), payload,
      { expectedTotal, onProgress: (loaded, total) => { elements.exportLabel.textContent = `导出 ${loaded} / ${total}`; } }
    );
    const blob = new Blob([XhsMonitorDataExport.toCsv(result.rows, columns)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `XHS-Monitor_${payload.dataset}_${new Date().toISOString().slice(0,10)}_filtered-${result.total}.csv`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`已按导出开始时的筛选条件导出全部 ${result.total} 条结果`);
  } catch (error) {
    showToast(error?.message || "筛选结果导出失败，未生成文件");
  } finally {
    state.exporting = false;
    elements.exportLabel.textContent = "导出筛选结果";
    elements.exportCurrent.disabled = state.deletePending || !state.queryReady || state.loading
      || state.resetScheduled || state.queryPending || state.total === 0;
    updateSelectionUi();
  }
}

function loadNextBatch() {
  if (columnDrag || columnLayoutFrame) return;
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
    closeDrawer();
    columnSizer?.cancel();
    finishColumnDrag();
    savePreferences();
    state.dataset = button.dataset.dataset;
    restoreDatasetView(state.dataset);
    validateCurrentView();
    clearSelection();
    state.page = 0;
    document.querySelectorAll("[data-quick-view]").forEach((item) => item.classList.remove("is-active"));
    renderSchemaState(); renderFieldOptions(); renderFilters(); renderSorts(); savePreferences(); runQuery({ append: false });
  }));
  document.querySelectorAll("[data-quick-view]").forEach((button) => button.addEventListener("click", () => applyQuickView(button.dataset.quickView)));
  elements.refreshSchema.addEventListener("click", () => loadSchema({ preserveQuery: true }));
  elements.retryHealth.addEventListener("click", () => loadSchema({ preserveQuery: true }));
  elements.globalSearch.addEventListener("input", () => {
    state.search = elements.globalSearch.value;
    if (state.semanticSearch) markSemanticDraft(); else scheduleQuery(320);
  });
  elements.globalSearch.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); submitSearch(); }
  });
  elements.searchSubmit.addEventListener("click", submitSearch);
  elements.semanticSearch.addEventListener("change", () => {
    state.semanticSearch = elements.semanticSearch.checked;
    state.semanticAwaitingSubmit = state.semanticSearch;
    renderSorts();
    if (state.semanticSearch) markSemanticDraft(); else submitSearch();
  });
  document.querySelectorAll("[data-semantic-query]").forEach((button) => button.addEventListener("click", () => {
    state.semanticSearch = true;
    state.search = button.dataset.semanticQuery;
    elements.globalSearch.value = state.search;
    markSemanticDraft();
    renderSorts();
    elements.globalSearch.focus();
  }));
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openPageFind();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); elements.globalSearch.focus(); }
    if (event.key === "Escape") {
      if (document.querySelector?.(".media-viewer[open]")) return;
      if (columnResizeActive) { columnSizer?.cancel(); return; }
      if (columnDrag) { finishColumnDrag(); return; }
      if (elements.deleteDialog.open) return;
      if (!elements.columnFilterPopover.hidden) { closeColumnFilterPopover(); return; }
      if (!elements.pageFind.hidden) { closePageFind(); return; }
      setPanel("none", false); closeDrawer({ restoreFocus: true });
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
    if (columnResizeActive || Date.now() < suppressColumnClickUntil || event.target.closest(".column-grip, .column-resize-handle")) {
      event.preventDefault(); return;
    }
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
    if (event.target.closest(".column-resize-handle")) return;
    const header = event.target.closest("th[data-field]");
    if (!header) return;
    if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const visible = currentVisibleFields();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const target = visible[visible.indexOf(header.dataset.field) + direction];
      if (target) reorderColumn(header.dataset.field, target, direction < 0 ? "before" : "after");
      header.focus({ preventScroll: true });
      header.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (event.target.closest(".column-grip")) {
      showToast("拖动表头，或按 Alt + 左右方向键调整列顺序"); return;
    }
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
  elements.groupThreads.addEventListener("change", () => { state.groupThreads = elements.groupThreads.checked; scheduleQuery(0); });
  elements.resetView.addEventListener("click", resetCurrentView);
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
  elements.restoreColumnOrder?.addEventListener("click", resetColumnOrder);
  elements.restoreColumnWidths?.addEventListener("click", () => {
    columnSizer?.cancel();
    state.columnWidths[state.dataset] = {};
    const saved = savePreferences();
    columnSizer?.reset();
    if (elements.columnOrderHint) elements.columnOrderHint.textContent = saved
      ? "已恢复当前数据库的默认列宽 · 筛选与列顺序保持不变" : "默认列宽已恢复；浏览器存储未写入";
  });
  elements.addSort.addEventListener("click", () => {
    const field = orderedDatasetFields().find((item) => item.sortable && item.key.endsWith("last_seen_at"))
      || orderedDatasetFields().find((item) => item.sortable);
    if (!field) return;
    state.sorts.push({ id: crypto.randomUUID(), field: field.key, direction: "desc" });
    renderSorts();
    scheduleQuery(0);
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
    if (event.target.closest('input, button, a')) return;
    const row = event.target.closest("tr[data-index]"); if (row) openDrawer(state.rows[Number(row.dataset.index)]);
  });
  elements.tableBody.addEventListener("click", (event) => {
    const action = event.target.closest("button.cell-action");
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    runTableAction(action);
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
    if (event.key !== "Enter" || event.target.closest("button, input, a")) return;
    const row = event.target.closest("tr[data-index]"); if (row) openDrawer(state.rows[Number(row.dataset.index)]);
  });
  elements.exportCurrent.addEventListener("click", exportCurrentPage);
  initializeColumnDragging();
  elements.deleteSelected.addEventListener("click", () => openDeleteDialog());
  elements.closeDrawer.addEventListener("click", () => closeDrawer({ restoreFocus: true }));
  elements.deleteDrawerRecord.addEventListener("click", () => {
    if (state.drawerLoading || state.currentRecordDataset !== state.dataset) return;
    const id = recordIdentity(state.currentRecord);
    if (id) openDeleteDialog([id]);
  });
  elements.copyRecord.addEventListener("click", async () => {
    if (!state.currentRecord || state.drawerLoading || state.currentRecordDataset !== state.dataset) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(state.currentRecord, null, 2));
      showToast("完整记录 JSON 已复制（含隐藏字段）");
    } catch (_error) { showToast("剪贴板写入失败，请检查浏览器权限后重试"); }
  });
  elements.openRecordLink.addEventListener("click", () => sendRuntime({ type: "openDataOverviewRecord", url: elements.openRecordLink.dataset.url }).catch((error) => showToast(error.message)));
  elements.deleteAcknowledgement.addEventListener("change", () => {
    elements.confirmDelete.disabled = state.semanticAwaitingSubmit || !elements.deleteAcknowledgement.checked || state.deletePending || state.exporting;
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
loadSchema({ preserveQuery: true });
