(function (root) {
  "use strict";

  const ATTRIBUTE = "data-xhs-monitor-reserved";
  const VARIABLES = ["width", "height", "shift-x", "shift-y", "native-x", "native-y", "native-z"]
    .map(key => `--xhs-monitor-note-${key}`);
  const clamp = (value, low, high) => Math.max(low, Math.min(Math.max(low, high), value));
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

  // Geometry only. No state from collection, storage or the platform is used.
  function planDock({ viewportWidth, viewportHeight, rect, collapsed = false }) {
    const vw = Math.max(1, finite(viewportWidth, 1));
    const vh = Math.max(1, finite(viewportHeight, 1));
    const edge = Math.min(12, vw / 20, vh / 20);
    const gap = Math.min(12, vw / 30, vh / 30);
    const availableWidth = Math.max(1, vw - edge * 2);
    const availableHeight = Math.max(1, vh - edge * 2);
    const naturalWidth = Math.max(1, finite(rect?.width, availableWidth));
    const naturalHeight = Math.max(1, finite(rect?.height, availableHeight));
    const naturalLeft = finite(rect?.left, edge);
    const naturalTop = finite(rect?.top, edge);
    const preferredPanel = collapsed ? 236 : 292;
    const minPanel = collapsed ? 216 : 240;
    const minNote = 640;

    if (availableWidth >= minNote + minPanel + gap) {
      const panelWidth = Math.min(preferredPanel, availableWidth - minNote - gap);
      const noteWidth = Math.min(naturalWidth, availableWidth - panelWidth - gap);
      const noteHeight = Math.min(naturalHeight, availableHeight);
      const groupWidth = noteWidth + panelWidth + gap;
      const left = clamp(naturalLeft, edge, vw - edge - groupWidth);
      const top = clamp(naturalTop, edge, vh - edge - noteHeight);
      const note = box(left, top, noteWidth, noteHeight);
      const unchanged = Math.abs(left - naturalLeft) < 0.5 && Math.abs(top - naturalTop) < 0.5
        && Math.abs(noteWidth - naturalWidth) < 0.5 && Math.abs(noteHeight - naturalHeight) < 0.5;
      return { mode: unchanged ? "outside" : "reserved", reserved: !unchanged, gap, note,
        panel: box(note.right + gap, top, panelWidth, noteHeight) };
    }

    // Side-by-side would crush the text column. Reserve a separate bottom row
    // instead: both panes remain visible and independently scrollable.
    const panelHeight = collapsed
      ? Math.min(112, availableHeight * 0.3)
      : Math.min(260, availableHeight * 0.34);
    const noteHeight = Math.min(naturalHeight, Math.max(1, availableHeight - panelHeight - gap));
    const noteWidth = Math.min(naturalWidth, availableWidth);
    const top = clamp(naturalTop, edge, vh - edge - noteHeight - gap - panelHeight);
    const left = clamp(naturalLeft, edge, vw - edge - noteWidth);
    const note = box(left, top, noteWidth, noteHeight);
    return { mode: "stacked", reserved: true, gap, note,
      panel: box(left, note.bottom + gap, noteWidth, panelHeight) };
  }

  function translateParts(value) {
    if (!value || value === "none") return ["0px", "0px", "0px"];
    const tokens = String(value).match(/(?:calc\([^)]*\)|[^\s])+/g) || [];
    return [tokens[0] || "0px", tokens[1] || "0px", tokens[2] || "0px"];
  }

  function createReservation({ onResize = () => {} } = {}) {
    let current = null;
    let observer = null;
    const signature = node => [node.className, ...[
      "width", "height", "min-width", "max-width", "min-height", "max-height",
      "left", "right", "top", "bottom", "transform", "translate", "position", "display"
    ].map(key => `${node.style.getPropertyValue(key)}!${node.style.getPropertyPriority(key)}`)].join("|");
    const parentSize = node => {
      const rect = node.parentElement?.getBoundingClientRect?.();
      return rect ? `${rect.width}:${rect.height}` : "";
    };

    function writeVariable(node, name, value) {
      const key = `--xhs-monitor-note-${name}`;
      if (node.style.getPropertyValue(key) !== value) node.style.setProperty(key, value);
    }

    function restorePresentation(record) {
      if (!record) return;
      const { node } = record;
      if (node.getAttribute(ATTRIBUTE) === record.appliedMode) {
        if (record.originalAttribute === null) node.removeAttribute(ATTRIBUTE);
        else node.setAttribute(ATTRIBUTE, record.originalAttribute);
      }
      for (const [key, saved] of record.savedVariables) {
        if (saved.value) node.style.setProperty(key, saved.value, saved.priority);
        else node.style.removeProperty(key);
      }
      record.appliedMode = null;
      record.shiftX = record.shiftY = 0;
    }

    function release() {
      observer?.disconnect();
      observer = null;
      restorePresentation(current);
      current = null;
    }

    function owns(node, noteId) {
      return Boolean(current && current.node === node && current.noteId === noteId && node.isConnected);
    }

    function update(node, noteId, viewport, collapsed) {
      if (!node?.isConnected) { release(); return null; }
      if (!owns(node, noteId)) {
        release();
        current = { node, noteId, natural: null, viewport: "", nativeSignature: "", appliedMode: null,
          originalAttribute: node.getAttribute(ATTRIBUTE), shiftX: 0, shiftY: 0,
          savedVariables: VARIABLES.map(key => [key, { value: node.style.getPropertyValue(key), priority: node.style.getPropertyPriority(key) }]) };
        if (typeof ResizeObserver === "function") {
          observer = new ResizeObserver(entries => {
            if (!current || current.node !== node) return;
            const size = parentSize(node);
            const parentChanged = entries.some(entry => entry.target === node.parentElement)
              && (!size || size !== current.parentSize);
            const nativeChanged = !current.appliedMode && entries.some(entry => entry.target === node);
            if (parentChanged || nativeChanged) current.natural = null;
            onResize();
          });
          observer.observe(node);
          if (node.parentElement) observer.observe(node.parentElement);
        }
      }
      const record = current;
      const viewKey = `${viewport.width}:${viewport.height}`;
      const nativeSignature = signature(node);
      if (!record.natural || record.viewport !== viewKey || record.nativeSignature !== nativeSignature) {
        // Re-measure native layout only on an external geometry change. Reading
        // our shrunken width as the new baseline causes cumulative shrink/jitter.
        restorePresentation(record);
        const rect = node.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) { release(); return null; }
        record.natural = box(rect.left, rect.top, rect.width, rect.height);
        record.nativeTranslate = translateParts(getComputedStyle(node).translate);
        record.nativeSignature = signature(node);
        record.viewport = viewKey;
      }
      const plan = planDock({ viewportWidth: viewport.width, viewportHeight: viewport.height,
        rect: record.natural, collapsed });
      if (!plan.reserved) {
        if (record.appliedMode) restorePresentation(record);
        record.parentSize = parentSize(node);
        return plan;
      }

      const [x, y, z] = record.nativeTranslate;
      writeVariable(node, "native-x", x);
      writeVariable(node, "native-y", y);
      writeVariable(node, "native-z", z);
      writeVariable(node, "width", `${plan.note.width}px`);
      writeVariable(node, "height", `${plan.note.height}px`);
      writeVariable(node, "shift-x", `${record.shiftX}px`);
      writeVariable(node, "shift-y", `${record.shiftY}px`);
      if (node.getAttribute(ATTRIBUTE) !== plan.mode) node.setAttribute(ATTRIBUTE, plan.mode);
      record.appliedMode = plan.mode;

      // Individual translate composes with the site's own transform, leaving
      // its centering/style attributes, carousel and DOM event handlers intact.
      const constrained = node.getBoundingClientRect();
      record.shiftX = Math.round((record.shiftX + plan.note.left - constrained.left) * 100) / 100;
      record.shiftY = Math.round((record.shiftY + plan.note.top - constrained.top) * 100) / 100;
      writeVariable(node, "shift-x", `${record.shiftX}px`);
      writeVariable(node, "shift-y", `${record.shiftY}px`);
      const final = node.getBoundingClientRect();
      record.parentSize = parentSize(node);
      // Anchor to the measured outer border, not an estimated or inner text box.
      if (plan.mode === "stacked") {
        plan.panel.left = final.left;
        plan.panel.top = final.bottom + plan.gap;
        plan.panel.width = final.width;
      } else {
        plan.panel.left = final.right + plan.gap;
        plan.panel.top = final.top;
        plan.panel.height = Math.min(final.height, viewport.height - final.top - 12);
      }
      plan.panel.right = plan.panel.left + plan.panel.width;
      plan.panel.bottom = plan.panel.top + plan.panel.height;
      return plan;
    }

    return { update, release, owns };
  }

  const api = Object.freeze({ planDock, createReservation, translateParts });
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.XhsMonitorProcessLayout = api;
})(globalThis);
