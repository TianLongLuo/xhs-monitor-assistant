(function (root) {
  "use strict";

  const MIN_WIDTH = 72;
  const MAX_WIDTH = 1200;
  const UTILITY_WIDTH = 42;
  const MAX_FIELDS = 1000;
  const UNSAFE_KEYS = new Set(["__proto__", "prototype", ...Object.getOwnPropertyNames(Object.prototype)]);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const clamp = (width) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(width)));

  function safeKey(key) {
    return typeof key === "string" && key.trim().length > 0 && key.length <= 160
      && !/[\u0000-\u001f\u007f]/.test(key) && !UNSAFE_KEYS.has(key);
  }

  function numericWidth(value) {
    if (typeof value === "string") {
      const text = value.trim();
      // Decimal strings only: never coerce booleans, objects, units, or hex.
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
      value = Number(text);
    }
    return typeof value === "number" && Number.isFinite(value) ? clamp(value) : null;
  }

  function sanitize(saved) {
    const result = {};
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return result;
    for (const key of Object.keys(saved)) {
      if (!safeKey(key)) continue;
      // Saved preferences are data, not executable accessors.
      const descriptor = Object.getOwnPropertyDescriptor(saved, key);
      if (!descriptor || !own(descriptor, "value")) continue;
      const width = numericWidth(descriptor.value);
      if (width === null) continue;
      result[key] = width;
    }
    return result;
  }

  function defaultWidth(field) {
    const item = typeof field === "string" ? { key: field } : field || {};
    const key = typeof item.key === "string" ? item.key.toLowerCase() : "";
    const type = String(item.dataType || item.type || "text").toLowerCase();
    const label = typeof item.label === "string" ? item.label : "";
    // Identifiers win over broad long-text hints such as "note".
    if (/(^|_)(id|uuid|guid|hash)$/.test(key) || ["id", "uuid"].includes(type)) return 260;
    if (["number", "integer", "float", "decimal"].includes(type)) return 120;
    if (["boolean", "bool"].includes(type)) return 100;
    if (item.action === "preview_media" || ["image", "images", "media"].includes(type)
        || /(^|_)(media_preview|images?|image_urls|cover|thumbnail)$/.test(key)
        || /图片|封面/.test(label)) return 240;
    if (["json", "longtext", "textarea"].includes(type)
        || /content|body|description|summary|reason|error|json|categories|notes?/.test(key)
        || /正文|内容|摘要|描述/.test(label)) return 420;
    if (/title/.test(key) || /标题/.test(label)) return 320;
    if (/(^|_)(url|path|dir)$/.test(key) || ["url", "link"].includes(type)) return 300;
    if (item.action) return 160;
    return 180; // Text, dates, and datetimes.
  }

  function sameWidths(left, right) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
      && keys.every((key) => own(right, key) && left[key] === right[key]);
  }

  /**
   * No storage, queries, or tbody access. create() performs the first sync.
   * getWidths must return the current dataset's stable preference object (not
   * a freshly allocated clone). Identity + values guard even same-schema switches.
   * Call sync after render/reorder and cancel when filters/datasets change.
   * sync/cancel never commit; reset cancels and displays defaults only. The host
   * clears its saved map before reset/sync when it wants a persistent full reset.
   * Single-column Home/double-click remove that override from onCommit's map.
   */
  function create({ table, head, viewport, getFields, getWidths,
    onCommit = () => {}, onActiveChange = () => {}, onHint = () => {} } = {}) {
    if (!table?.ownerDocument || !head?.querySelectorAll
        || typeof getFields !== "function" || typeof getWidths !== "function") {
      throw new TypeError("Column widths require table, head, getFields, and getWidths");
    }
    const document = table.ownerDocument;
    const view = document.defaultView || root;
    viewport = viewport || table.parentElement || table;
    const requestFrame = view.requestAnimationFrame
      ? (callback) => view.requestAnimationFrame(callback) : (callback) => view.setTimeout(callback, 16);
    const cancelFrame = view.cancelAnimationFrame
      ? (id) => view.cancelAnimationFrame(id) : (id) => view.clearTimeout(id);
    const styleNames = ["width", "min-width", "max-width", "table-layout"];
    const originalStyles = styleNames.map((name) =>
      [name, table.style.getPropertyValue(name), table.style.getPropertyPriority(name)]);
    const originalMarker = table.getAttribute("data-column-widths");
    const originalGroups = Array.from(table.children).filter((node) => node.tagName === "COLGROUP")
      .map((node) => ({ node, next: node.nextSibling }));
    const group = originalGroups[0]?.node || document.createElement("colgroup");
    const originalCols = Array.from(group.childNodes);
    const originalSpan = group.getAttribute("span");
    for (const { node } of originalGroups.slice(1)) node.remove();
    group.removeAttribute("span");
    const fixedCols = [document.createElement("col"), document.createElement("col")];
    for (const col of fixedCols) col.style.setProperty("width", UTILITY_WIDTH + "px");

    let destroyed = false;
    let generation = 0;
    let active = null;
    let frame = null;
    let totalWidth = 0;
    let context = null;
    let suppressClickUntil = 0;
    let columns = new Map();
    const handles = new Map();
    const permanentListeners = [];

    function listen(target, type, listener, bucket, capture = false) {
      target.addEventListener(type, listener, capture);
      bucket.push(() => target.removeEventListener(type, listener, capture));
    }

    function stop(event) {
      event.preventDefault();
      event.stopPropagation();
    }

    function restoreAttribute(node, name, value) {
      if (value === null) node.removeAttribute(name);
      else node.setAttribute(name, value);
    }

    function readContext() {
      const source = getWidths();
      const seen = new Set();
      const fields = [];
      const input = getFields();
      for (const field of Array.isArray(input) ? input : []) {
        if (!field || !safeKey(field.key) || seen.has(field.key)) continue;
        seen.add(field.key);
        fields.push({ key: field.key, label: String(field.label || field.key), width: defaultWidth(field) });
        if (fields.length === MAX_FIELDS) break;
      }
      return { source, saved: sanitize(source), fields,
        signature: JSON.stringify(fields.map((field) => [field.key, field.label, field.width])) };
    }

    function isCurrent(expected, entry) {
      if (destroyed || context !== expected || !entry || columns.get(entry.field.key) !== entry
          || !head.contains(entry.th) || entry.handle.parentNode !== entry.th) return false;
      const current = readContext();
      return current.source === expected.source && current.signature === expected.signature
        && sameWidths(current.saved, expected.saved);
    }

    function setAria(entry) {
      entry.handle.setAttribute("aria-valuenow", String(entry.width));
      entry.handle.setAttribute("aria-valuetext", entry.width + " 像素");
    }

    function paint(entry, width) {
      if (entry.width === width) return;
      totalWidth += width - entry.width;
      entry.width = width;
      entry.col.style.setProperty("width", width + "px");
      table.style.setProperty("width", totalWidth + "px");
      setAria(entry);
    }

    function detachDrag() {
      const drag = active;
      active = null; // Release may synchronously emit lostpointercapture.
      if (frame !== null) cancelFrame(frame);
      frame = null;
      if (!drag) return null;
      suppressClickUntil = Date.now() + 400;
      for (const remove of drag.listeners) remove();
      try { drag.entry.handle.releasePointerCapture?.(drag.pointerId); } catch (_) { /* Already lost. */ }
      for (const [node, value] of drag.draggables) restoreAttribute(node, "draggable", value);
      drag.entry.th.classList.remove("is-column-resizing");
      viewport.classList.remove("is-column-resizing");
      return drag;
    }

    function removeHandle(record) {
      for (const remove of record.listeners) remove();
      record.handle.remove();
    }

    function bindHandle(th) {
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "column-resize-handle";
      handle.tabIndex = 0;
      handle.draggable = false;
      handle.style.setProperty("touch-action", "none");
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-orientation", "vertical");
      handle.setAttribute("aria-valuemin", String(MIN_WIDTH));
      handle.setAttribute("aria-valuemax", String(MAX_WIDTH));
      handle.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home");
      handle.title = "拖动调整列宽；左右键 ±10，Shift ±50，Home 或双击恢复默认";
      const record = { th, handle, listeners: [], entry: null };
      for (const type of ["mousedown", "click", "dragstart"]) listen(handle, type, stop, record.listeners);
      listen(handle, "pointerdown", (event) => beginDrag(event, record.entry), record.listeners);
      listen(handle, "dblclick", (event) => {
        stop(event);
        changeByKey(record.entry, null);
      }, record.listeners);
      listen(handle, "keydown", (event) => {
        // Never let handle keys reach the header's filter or Alt+arrow reorder.
        event.stopPropagation();
        if (event.key === "Tab") return;
        if (["Enter", " ", "Escape", "ArrowLeft", "ArrowRight", "Home"].includes(event.key)) event.preventDefault();
        if (event.key === "Escape") { cancel(); return; }
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === "Home") changeByKey(record.entry, null);
        if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
          const step = (event.shiftKey ? 50 : 10) * (event.key === "ArrowLeft" ? -1 : 1);
          changeByKey(record.entry, step);
        }
      }, record.listeners);
      listen(handle, "blur", () => { if (active?.entry.handle === handle) cancel(); }, record.listeners);
      listen(handle, "lostpointercapture", (event) => {
        if (active?.entry.handle === handle && active.pointerId === event.pointerId) cancel();
      }, record.listeners);
      th.append(handle);
      return record;
    }

    function rebuild(defaults = false) {
      if (destroyed) return;
      const version = ++generation;
      const drag = detachDrag();
      if (drag) onActiveChange(false);
      if (destroyed || generation !== version) return;
      const next = readContext();
      const headers = new Map();
      for (const th of head.querySelectorAll("th[data-field]")) {
        if (!headers.has(th.dataset.field)) headers.set(th.dataset.field, th);
      }
      const wanted = new Set(next.fields.map((field) => headers.get(field.key)).filter(Boolean));
      for (const [th, record] of handles) {
        if (!wanted.has(th) || record.handle.parentNode !== th) {
          removeHandle(record);
          handles.delete(th);
        }
      }
      const updated = new Map();
      totalWidth = UTILITY_WIDTH * 2;
      for (const field of next.fields) {
        const col = columns.get(field.key)?.col || document.createElement("col");
        col.dataset.field = field.key;
        const width = !defaults && own(next.saved, field.key) ? next.saved[field.key] : field.width;
        col.style.setProperty("width", width + "px");
        const th = headers.get(field.key);
        const entry = { field, col, th, width, handle: null };
        if (th) {
          let record = handles.get(th);
          if (!record) { record = bindHandle(th); handles.set(th, record); }
          record.entry = entry;
          entry.handle = record.handle;
          entry.handle.setAttribute("aria-label", "调整" + field.label + "列宽");
          setAria(entry);
        }
        updated.set(field.key, entry);
        totalWidth += width;
      }
      columns = updated;
      context = next;
      if (group.parentNode !== table) {
        const anchor = Array.from(table.children).find((node) => node.tagName !== "CAPTION");
        table.insertBefore(group, anchor || null);
      }
      group.replaceChildren(...fixedCols, ...Array.from(columns.values(), (entry) => entry.col));
      table.dataset.columnWidths = "true";
      table.style.setProperty("table-layout", "fixed");
      table.style.setProperty("min-width", "0px");
      table.style.setProperty("max-width", "none");
      table.style.setProperty("width", totalWidth + "px");
    }

    function sync() { rebuild(); }
    function cancel() { rebuild(); }
    function reset() { rebuild(true); }

    function commit(expected, entry, width, useDefault, version) {
      if (!isCurrent(expected, entry)) { sync(); return; }
      const next = sanitize(expected.saved); // Includes hidden fields, never another dataset's map.
      if (useDefault) delete next[entry.field.key];
      else next[entry.field.key] = width;
      onCommit(next);
      // Hosts normally replace their saved object synchronously; keep keyboard
      // repeats working without requiring a re-render. Respect reentrant sync.
      if (!destroyed && generation === version) {
        const current = readContext();
        if (current.signature === expected.signature) context = current;
        else sync();
      }
      onHint(entry.field.label + (useDefault ? " · 已恢复默认列宽 " : " · 列宽 ") + width + " px");
    }

    function changeByKey(entry, delta) {
      if (destroyed || active) return;
      const expected = context;
      if (!isCurrent(expected, entry)) { sync(); return; }
      const width = delta === null ? entry.field.width : clamp(entry.width + delta);
      if (delta !== null && width === entry.width) return;
      const version = generation;
      try {
        onActiveChange(true);
        if (generation !== version || !isCurrent(expected, entry)) { sync(); return; }
        paint(entry, width);
        commit(expected, entry, width, delta === null, version);
      } finally {
        onActiveChange(false);
      }
    }

    function scrollLeft() {
      return Number.isFinite(viewport.scrollLeft) ? viewport.scrollLeft : 0;
    }

    function pendingWidth(drag) {
      return clamp(drag.startWidth + drag.x - drag.startX + scrollLeft() - drag.startScroll);
    }

    function queuePaint(drag) {
      if (frame !== null) return;
      frame = requestFrame(() => {
        if (active !== drag) return;
        frame = null;
        if (!isCurrent(drag.context, drag.entry)) { cancel(); return; }
        paint(drag.entry, pendingWidth(drag));
      });
    }

    function beginDrag(event, entry) {
      stop(event); // Must precede focus, pointer capture, and native dragging.
      if (destroyed || active || event.button !== 0 || event.isPrimary === false
          || !Number.isFinite(event.clientX)) return;
      if (!isCurrent(context, entry)) { sync(); return; }
      suppressClickUntil = 0;
      entry.handle.focus({ preventScroll: true });
      if (!isCurrent(context, entry)) { sync(); return; }
      const drag = { entry, context, pointerId: event.pointerId, startWidth: entry.width,
        startX: event.clientX, x: event.clientX, startScroll: scrollLeft(),
        listeners: [], draggables: [], version: generation };
      active = drag;
      for (const node of [entry.th, ...entry.th.querySelectorAll("[draggable]")]) {
        drag.draggables.push([node, node.getAttribute("draggable")]);
        node.setAttribute("draggable", "false");
      }
      entry.th.classList.add("is-column-resizing");
      viewport.classList.add("is-column-resizing");
      listen(view, "pointermove", (move) => {
        if (move.pointerId !== drag.pointerId) return;
        stop(move);
        if (!Number.isFinite(move.clientX)) return;
        drag.x = move.clientX;
        queuePaint(drag);
      }, drag.listeners, true);
      listen(view, "pointerup", (up) => {
        if (up.pointerId !== drag.pointerId) return;
        stop(up);
        if (!isCurrent(drag.context, entry)) { cancel(); return; }
        if (Number.isFinite(up.clientX)) drag.x = up.clientX;
        const width = pendingWidth(drag);
        paint(entry, width); // Flush the final position, even before the next RAF.
        detachDrag();
        try {
          if (width !== drag.startWidth) commit(drag.context, entry, width, false, drag.version);
        } finally {
          onActiveChange(false);
        }
      }, drag.listeners, true);
      listen(view, "pointercancel", (cancelEvent) => {
        if (cancelEvent.pointerId !== drag.pointerId) return;
        stop(cancelEvent);
        cancel();
      }, drag.listeners, true);
      listen(view, "keydown", (key) => {
        if (key.key === "Escape") { stop(key); cancel(); }
      }, drag.listeners, true);
      listen(view, "blur", cancel, drag.listeners);
      listen(viewport, "scroll", () => queuePaint(drag), drag.listeners);
      // Window listeners remain a fallback if capture races a detached target
      // or is unavailable in an embedded view.
      try { entry.handle.setPointerCapture?.(drag.pointerId); } catch (_) { /* Use window events. */ }
      try {
        onActiveChange(true);
        if (active !== drag) return;
        if (!isCurrent(drag.context, entry)) { cancel(); return; }
        onHint(entry.field.label + " · 调整列宽；Esc 取消");
      } catch (error) {
        cancel();
        throw error;
      }
    }

    // Capture guards precede existing bubbling header/grip handlers. A captured
    // pointerup can generate a click on the header after capture is released.
    listen(head, "dragstart", (event) => {
      if (active || event.target.closest?.(".column-resize-handle")) {
        stop(event);
        event.stopImmediatePropagation();
      }
    }, permanentListeners, true);
    listen(head, "click", (event) => {
      if (active || (event.detail !== 0 && Date.now() < suppressClickUntil)) {
        suppressClickUntil = 0;
        stop(event);
        event.stopImmediatePropagation();
      }
    }, permanentListeners, true);
    listen(head, "pointerdown", (event) => {
      if (active) {
        stop(event);
        event.stopImmediatePropagation();
      } else suppressClickUntil = 0; // A new intentional header click is allowed.
    }, permanentListeners, true);

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      ++generation;
      const drag = detachDrag();
      for (const remove of permanentListeners) remove();
      for (const record of handles.values()) removeHandle(record);
      handles.clear();
      columns.clear();
      if (originalGroups.length) {
        group.replaceChildren(...originalCols);
        restoreAttribute(group, "span", originalSpan);
        for (const { node, next } of [...originalGroups].reverse()) {
          table.insertBefore(node, next?.parentNode === table ? next : null);
        }
      } else group.remove();
      restoreAttribute(table, "data-column-widths", originalMarker);
      for (const [name, value, priority] of originalStyles) {
        if (value) table.style.setProperty(name, value, priority);
        else table.style.removeProperty(name);
      }
      context = null;
      if (drag) onActiveChange(false);
    }

    sync();
    return Object.freeze({ sync, cancel, reset, destroy });
  }

  const api = Object.freeze({ sanitize, defaultWidth, create });
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.XhsMonitorColumnWidths = api;
})(globalThis);
